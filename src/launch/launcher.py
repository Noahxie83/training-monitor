#!/usr/bin/python3
"""Fail-closed launcher and opt-in job controller for registered ML training tasks."""
import ast
import base64
import csv
import datetime
import hashlib
import io
import json
import math
import os
import posixpath
import re
import shlex
import shutil
import signal as _signal
import stat
import subprocess
import sys
import time
import types
import uuid

try:
    import fcntl as _fcntl
except ImportError:
    _fcntl = None


VERSION = 1
FRAME_MAGIC = b"TMF1"
MAX_RESPONSE_BYTES = 2 * 1024 * 1024
MAX_ARGUMENTS_CHARS = 8192
MAX_ARGUMENTS = 256
MAX_ITEMS = 256
MAX_STRING_BYTES = 8192
MAX_ENV_VARS = 64
STATE_DIRECTORY = ".training-monitor-autostart"
REQUEST_B64 = "__MONITOR_REQUEST_B64__"
PROBE_SOURCE_B64 = "__READONLY_PROBE_SOURCE_B64__"

_PROBE = None
_HEX64 = re.compile(r"[a-fA-F0-9]{64}\Z")
_PYTHON_BASENAME = re.compile(r"python(?:3(?:\.\d+)?)?\Z")
_MODULE_NAME_RE = re.compile(r"[A-Za-z_][A-Za-z0-9_.]*\Z")
_ENV_KEY_RE = re.compile(r"[A-Za-z_][A-Za-z0-9_]{0,127}\Z")
_MISSING_GPU_VALUE_RE = re.compile(r"^(?:\[?\s*(?:N/A|NA|Not Supported|Unknown)\s*\]?|-)$", re.IGNORECASE)
_GPU_OR_MIG_UUID_RE = re.compile(r"(?:GPU|MIG)-[A-Za-z0-9._:/-]+\Z")
_DEVICE_ID_RE = re.compile(r"GPU (0|[1-9][0-9]{0,3})\Z")


class _LaunchError(Exception):
    def __init__(self, error_code):
        super().__init__(error_code)
        self.error_code = error_code


class _GpuLockBusy(Exception):
    pass


def _payload(status, pid=None, process_key=None, started_at=None, error_code=None):
    return {
        "status": status,
        "pid": pid,
        "processKey": process_key,
        "startedAt": started_at,
        "errorCode": error_code,
    }


def _failed(error_code):
    return _payload("failed", error_code=error_code)


def _busy():
    return _payload("busy")


def _already_running():
    return _payload("already_running")


def _probe():
    global _PROBE
    if _PROBE is not None:
        return _PROBE
    if PROBE_SOURCE_B64 == "__READONLY_PROBE_SOURCE_B64__":
        raise _LaunchError("PROBE_SOURCE_MISSING")
    try:
        source = base64.b64decode(PROBE_SOURCE_B64, validate=True)
        if len(source) > MAX_RESPONSE_BYTES:
            raise ValueError("probe source limit")
        namespace = {"__name__": "training_monitor_readonly"}
        exec(compile(source, "<readonly_probe>", "exec"), namespace)
        required = (
            "_canonical_task_roots",
            "_path_in_scope",
            "_query_linux_gpu",
            "open_readonly",
            "scan_registered_processes",
        )
        if any(name not in namespace for name in required):
            raise ValueError("probe interface")
        _PROBE = types.SimpleNamespace(**namespace)
        return _PROBE
    except _LaunchError:
        raise
    except Exception as exc:
        raise _LaunchError("PROBE_SOURCE_INVALID") from exc


def _current_uid():
    getter = getattr(os, "geteuid", None) or getattr(os, "getuid", None)
    if not callable(getter):
        raise _LaunchError("UNSUPPORTED_PLATFORM")
    return getter()


def _require_fcntl():
    if _fcntl is None:
        raise _LaunchError("UNSUPPORTED_PLATFORM")
    return _fcntl


def _ensure_private_dir(target_path, *, create=True):
    """Ensure a 0700 non-symlink directory owned by current UID."""
    uid = _current_uid()
    try:
        before = os.lstat(target_path)
    except FileNotFoundError:
        if not create:
            return None
        try:
            os.makedirs(target_path, mode=0o700, exist_ok=True)
            os.chmod(target_path, 0o700)
        except OSError as exc:
            raise _LaunchError("STATE_DIRECTORY_INVALID") from exc
        before = os.lstat(target_path)
    except OSError as exc:
        raise _LaunchError("STATE_DIRECTORY_INVALID") from exc
    if stat.S_ISLNK(before.st_mode) or not stat.S_ISDIR(before.st_mode):
        raise _LaunchError("STATE_DIRECTORY_INVALID")
    if before.st_uid != uid or (os.name != "nt" and stat.S_IMODE(before.st_mode) != 0o700):
        raise _LaunchError("STATE_DIRECTORY_INVALID")
    after = os.lstat(target_path)
    if (before.st_dev, before.st_ino) != (after.st_dev, after.st_ino):
        raise _LaunchError("STATE_DIRECTORY_INVALID")
    return target_path


def _runtime_lock_dir(uid=None):
    """Return a short local-tmpfs directory for Unix sockets and flock locks (never NFS)."""
    resolved_uid = _current_uid() if uid is None else uid
    xdg_runtime = os.environ.get("XDG_RUNTIME_DIR")
    candidates = []
    if xdg_runtime and os.path.isabs(xdg_runtime) and len(xdg_runtime) < 70:
        candidates.append(os.path.join(xdg_runtime, "training-monitor"))
    candidates.append(f"/tmp/training-monitor-{resolved_uid}")
    for candidate in candidates:
        try:
            return _ensure_private_dir(candidate, create=True)
        except _LaunchError:
            continue
    raise _LaunchError("RUNTIME_DIRECTORY_INVALID")


def _string(value, *, allow_empty=False, max_length=MAX_STRING_BYTES):
    if not isinstance(value, str) or "\0" in value:
        raise _LaunchError("INVALID_REQUEST")
    if (not allow_empty and not value) or len(value) > max_length:
        raise _LaunchError("INVALID_REQUEST")
    return value


def _string_list(value, *, nonempty=False):
    if not isinstance(value, list) or (nonempty and not value) or len(value) > MAX_ITEMS:
        raise _LaunchError("INVALID_REQUEST")
    return [_string(item) for item in value]


def _number(value, *, low, high):
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise _LaunchError("INVALID_REQUEST")
    numeric = float(value)
    if not math.isfinite(numeric) or numeric < low or (high is not None and numeric > high):
        raise _LaunchError("INVALID_REQUEST")
    return numeric


def _validate_env(value):
    if value is None:
        return {}
    if not isinstance(value, dict) or len(value) > MAX_ENV_VARS:
        raise _LaunchError("INVALID_REQUEST")
    cleaned = {}
    for k, v in value.items():
        if not isinstance(k, str) or not _ENV_KEY_RE.fullmatch(k):
            raise _LaunchError("INVALID_REQUEST")
        if k == "CUDA_VISIBLE_DEVICES":
            continue
        cleaned[k] = _string(v, allow_empty=True, max_length=4096)
    return cleaned


def _validate_request(request):
    if not isinstance(request, dict):
        raise _LaunchError("INVALID_REQUEST")
    if type(request.get("version")) is not int or request["version"] != VERSION:
        raise _LaunchError("INVALID_REQUEST")
    _string(request.get("requestId"))
    if request.get("sourceId") is not None or request.get("op") != "launch_task":
        raise _LaunchError("INVALID_REQUEST")

    arm_id = _string(request.get("armId"), max_length=128)
    try:
        arm_id = str(uuid.UUID(arm_id))
    except (ValueError, AttributeError) as exc:
        raise _LaunchError("INVALID_REQUEST") from exc
    task_id = _string(request.get("taskId"), max_length=1024)
    config_hash = _string(request.get("configHash"), max_length=64).lower()
    if not _HEX64.fullmatch(config_hash):
        raise _LaunchError("INVALID_REQUEST")

    host_roots = _string_list(request.get("hostAllowedRoots"), nonempty=True)
    task_directories = _string_list(request.get("taskAllowedDirectories"), nonempty=True)
    entry_paths = _string_list(request.get("entryPaths"), nonempty=True)
    if any(not os.path.isabs(path) for path in host_roots + task_directories):
        raise _LaunchError("INVALID_REQUEST")

    sources = request.get("sources")
    if not isinstance(sources, list) or len(sources) > MAX_ITEMS:
        raise _LaunchError("INVALID_REQUEST")
    source_ids = set()
    for source in sources:
        if not isinstance(source, dict):
            raise _LaunchError("INVALID_REQUEST")
        source_id = _string(source.get("sourceId"), max_length=512)
        path = _string(source.get("path"))
        _string(source.get("kind"), max_length=64)
        if source_id in source_ids or not os.path.isabs(path):
            raise _LaunchError("INVALID_REQUEST")
        source_ids.add(source_id)

    launch = request.get("launch")
    if not isinstance(launch, dict):
        raise _LaunchError("INVALID_REQUEST")

    mode = launch.get("mode") or "python_script"
    if mode not in ("python_script", "python_module", "command"):
        raise _LaunchError("INVALID_REQUEST")

    python_path = None
    entry_path = None
    module_name = None
    command_argv = None

    if mode == "python_script":
        python_path = _string(launch.get("pythonPath"))
        if not posixpath.isabs(python_path) or not _PYTHON_BASENAME.fullmatch(posixpath.basename(python_path)):
            raise _LaunchError("INVALID_REQUEST")
        entry_path = _string(launch.get("entryPath"))
        if entry_path not in entry_paths:
            raise _LaunchError("INVALID_REQUEST")
    elif mode == "python_module":
        python_path = _string(launch.get("pythonPath"))
        if not posixpath.isabs(python_path) or not _PYTHON_BASENAME.fullmatch(posixpath.basename(python_path)):
            raise _LaunchError("INVALID_REQUEST")
        module_name = _string(launch.get("moduleName"), max_length=256)
        if not _MODULE_NAME_RE.fullmatch(module_name):
            raise _LaunchError("INVALID_REQUEST")
    else:  # mode == "command"
        command_argv = _string_list(launch.get("command"), nonempty=True)
        if len(command_argv) > MAX_ARGUMENTS:
            raise _LaunchError("INVALID_ARGUMENTS")
        if ".." in command_argv[0].split("/"):
            raise _LaunchError("INVALID_REQUEST")

    cwd = _string(launch.get("cwd"))
    arguments = _string(launch.get("arguments", ""), allow_empty=True, max_length=MAX_ARGUMENTS_CHARS)
    log_source_id = _string(launch.get("logSourceId"), max_length=512)
    if not os.path.isabs(cwd):
        raise _LaunchError("INVALID_REQUEST")
    try:
        arguments_parsed = shlex.split(arguments, posix=True)
    except ValueError as exc:
        raise _LaunchError("INVALID_ARGUMENTS") from exc
    if len(arguments_parsed) > MAX_ARGUMENTS or any("\0" in argument for argument in arguments_parsed):
        raise _LaunchError("INVALID_ARGUMENTS")
    matching_logs = [source for source in sources if source["sourceId"] == log_source_id and source["kind"] == "log"]
    if len(matching_logs) != 1:
        raise _LaunchError("INVALID_REQUEST")

    venv_path = launch.get("venvPath")
    if venv_path is not None:
        venv_path = _string(venv_path)
        if not os.path.isabs(venv_path) or ".." in venv_path.split("/"):
            raise _LaunchError("INVALID_REQUEST")
    conda_env = launch.get("condaEnv")
    if conda_env is not None:
        conda_env = _string(conda_env, max_length=512)
        if ".." in conda_env.split("/"):
            raise _LaunchError("INVALID_REQUEST")
    modules = launch.get("modules")
    if modules is not None:
        modules = _string_list(modules, nonempty=False)
        if any(not re.fullmatch(r"[A-Za-z0-9_][A-Za-z0-9_.+/-]{0,255}", mod)
               or any(part in {"", ".", ".."} for part in mod.split("/")) for mod in modules):
            raise _LaunchError("INVALID_MODULE")
    user_env = _validate_env(launch.get("env"))

    gpu_devices = request.get("gpuDevices")
    if not isinstance(gpu_devices, list) or not gpu_devices or len(gpu_devices) > 64:
        raise _LaunchError("INVALID_REQUEST")
    uuids = []
    gpu_indices = []
    seen_uuids = set()
    for device in gpu_devices:
        if not isinstance(device, dict):
            raise _LaunchError("INVALID_REQUEST")
        dev_id = _string(device.get("deviceId"), max_length=256)
        gpu_uuid = _string(device.get("uuid"), max_length=256)
        if (not _GPU_OR_MIG_UUID_RE.fullmatch(gpu_uuid)
                or ".." in gpu_uuid
                or gpu_uuid in seen_uuids or any(character.isspace() for character in gpu_uuid)):
            raise _LaunchError("INVALID_REQUEST")
        seen_uuids.add(gpu_uuid)
        uuids.append(gpu_uuid)
        m = _DEVICE_ID_RE.fullmatch(dev_id)
        gpu_indices.append(m.group(1) if m else gpu_uuid)

    cuda_mode = request.get("cudaVisibleDevicesMode") or "index"
    if cuda_mode not in ("index", "uuid"):
        raise _LaunchError("INVALID_REQUEST")

    max_utilization = _number(request.get("maxUtilizationPercent"), low=0.0, high=100.0)
    max_memory_mib = _number(request.get("maxMemoryMiB"), low=0.0, high=None)
    if "minFreeMemoryMiB" in request:
        _number(request["minFreeMemoryMiB"], low=1, high=1048576)
    if "minFreeDiskMiB" in request:
        _number(request["minFreeDiskMiB"], low=0, high=1073741824)
    sharing = request.get("gpuSharing")
    if sharing is not None:
        allowed_sharing_keys = {"groupId", "maxDevices", "maxWorkersPerDevice", "readyAfterSeconds"}
        if (not isinstance(sharing, dict)
                or not {"groupId", "maxDevices", "maxWorkersPerDevice"}.issubset(set(sharing))
                or not set(sharing).issubset(allowed_sharing_keys)
                or not isinstance(sharing["groupId"], str) or not re.fullmatch(r"[A-Za-z0-9_-]{1,128}", sharing["groupId"])
                or type(sharing["maxDevices"]) is not int or not 1 <= sharing["maxDevices"] <= 64
                or type(sharing["maxWorkersPerDevice"]) is not int or not 1 <= sharing["maxWorkersPerDevice"] <= 16
                or not request.get("minFreeMemoryMiB") or len(uuids) != 1):
            raise _LaunchError("INVALID_REQUEST")

    state_dir = request.get("stateDir")
    if state_dir is not None:
        state_dir = _string(state_dir)
        if not os.path.isabs(state_dir) or ".." in state_dir.split("/"):
            raise _LaunchError("INVALID_REQUEST")

    normalized_launch = dict(launch)
    normalized_launch.update({
        "mode": mode,
        "cwd": cwd,
        "arguments": arguments,
        "logSourceId": log_source_id,
        "env": user_env,
    })
    if python_path is not None:
        normalized_launch["pythonPath"] = python_path
    if entry_path is not None:
        normalized_launch["entryPath"] = entry_path
    if module_name is not None:
        normalized_launch["moduleName"] = module_name
    if command_argv is not None:
        normalized_launch["command"] = command_argv
    if venv_path is not None:
        normalized_launch["venvPath"] = venv_path
    if conda_env is not None:
        normalized_launch["condaEnv"] = conda_env
    if modules is not None:
        normalized_launch["modules"] = modules

    normalized = dict(request)
    normalized.update({
        "armId": arm_id,
        "taskId": task_id,
        "configHash": config_hash,
        "hostAllowedRoots": host_roots,
        "taskAllowedDirectories": task_directories,
        "entryPaths": entry_paths,
        "sources": sources,
        "launch": normalized_launch,
        "gpuDevices": gpu_devices,
        "cudaVisibleDevicesMode": cuda_mode,
        "maxUtilizationPercent": max_utilization,
        "maxMemoryMiB": max_memory_mib,
        "_arguments": arguments_parsed,
        "_logPath": matching_logs[0]["path"],
        "_gpuUuids": uuids,
        "_gpuIndices": gpu_indices,
    })
    if state_dir is not None:
        normalized["stateDir"] = state_dir
    return normalized


def _canonical_scope(request, probe):
    hosts, tasks = probe._canonical_task_roots(
        request["hostAllowedRoots"], request["taskAllowedDirectories"])
    if hosts is None or tasks is None:
        raise _LaunchError("PATH_OUTSIDE_ALLOWED_ROOT")
    for host in hosts:
        try:
            if not stat.S_ISDIR(os.stat(host, follow_symlinks=False).st_mode):
                raise _LaunchError("PATH_OUTSIDE_ALLOWED_ROOT")
        except OSError as exc:
            raise _LaunchError("PATH_OUTSIDE_ALLOWED_ROOT") from exc
    for task in tasks:
        try:
            if not stat.S_ISDIR(os.stat(task, follow_symlinks=False).st_mode):
                raise _LaunchError("PATH_OUTSIDE_ALLOWED_ROOT")
            if not probe._path_in_scope(task, hosts, tasks):
                raise _LaunchError("PATH_OUTSIDE_ALLOWED_ROOT")
        except OSError as exc:
            raise _LaunchError("PATH_OUTSIDE_ALLOWED_ROOT") from exc

    cwd = os.path.realpath(request["launch"]["cwd"])
    try:
        cwd_info = os.stat(cwd, follow_symlinks=False)
    except OSError as exc:
        raise _LaunchError("CWD_PATH_INVALID") from exc
    if not stat.S_ISDIR(cwd_info.st_mode) or not probe._path_in_scope(cwd, hosts, tasks):
        raise _LaunchError("CWD_PATH_INVALID")

    mode = request["launch"].get("mode") or "python_script"
    script = None
    if mode == "python_script":
        canonical_entries = []
        raw_entry = request["launch"]["entryPath"]
        for entry in request["entryPaths"]:
            if entry.startswith("module:") or entry.startswith("-m "):
                continue
            candidate = entry if os.path.isabs(entry) else os.path.join(tasks[0], entry)
            resolved = os.path.realpath(candidate)
            if not probe._path_in_scope(resolved, hosts, tasks):
                raise _LaunchError("ENTRY_PATH_INVALID")
            canonical_entries.append(resolved)
        raw_candidate = raw_entry if os.path.isabs(raw_entry) else os.path.join(tasks[0], raw_entry)
        script = os.path.realpath(raw_candidate)
        if script not in canonical_entries:
            raise _LaunchError("ENTRY_PATH_NOT_REGISTERED")
        opened = probe.open_readonly(script, hosts, tasks, limit_bytes=0)
        if opened.get("status") != "ok":
            raise _LaunchError("SCRIPT_PATH_INVALID")

    log_path = request["_logPath"]
    log_parent = os.path.realpath(os.path.dirname(log_path))
    if not probe._path_in_scope(log_parent, hosts, tasks):
        raise _LaunchError("LOG_PATH_INVALID")
    check_paths = [cwd, log_parent] + ([script] if script is not None else [])
    for path in check_paths:
        if not probe._path_in_scope(os.path.realpath(path), hosts, tasks):
            raise _LaunchError("PATH_OUTSIDE_ALLOWED_ROOT")
    return hosts, tasks, cwd, script, log_path


def _default_persistent_state_dir():
    xdg_state = os.environ.get("XDG_STATE_HOME")
    if xdg_state and os.path.isabs(xdg_state):
        return os.path.join(xdg_state, "training-monitor")
    home = os.path.expanduser("~")
    if home and home != "~" and os.path.isabs(home):
        return os.path.join(home, ".local", "state", "training-monitor")
    return None


def _state_directory(host_root, state_dir=None):
    """Resolve private 0700 persistent wait state directory."""
    if state_dir:
        return _ensure_private_dir(state_dir, create=True)
    legacy_path = os.path.join(host_root, STATE_DIRECTORY)
    if os.path.exists(legacy_path):
        resolved_dir = _ensure_private_dir(legacy_path, create=False)
        if os.path.dirname(os.path.realpath(resolved_dir)) != os.path.realpath(host_root):
            raise _LaunchError("STATE_DIRECTORY_INVALID")
        return resolved_dir
    preferred = _default_persistent_state_dir()
    if preferred:
        try:
            return _ensure_private_dir(preferred, create=True)
        except _LaunchError:
            pass
    resolved_dir = _ensure_private_dir(legacy_path, create=True)
    if os.path.dirname(os.path.realpath(resolved_dir)) != os.path.realpath(host_root):
        raise _LaunchError("STATE_DIRECTORY_INVALID")
    return resolved_dir


def _attempt_key(task_id, arm_id):
    digest_input = (task_id + "\0" + arm_id).encode("utf-8")
    return hashlib.sha256(digest_input).hexdigest()


def _attempt_paths(state_directory, task_id, arm_id):
    key = _attempt_key(task_id, arm_id)
    return (os.path.join(state_directory, ".claim-" + key),
            os.path.join(state_directory, ".receipt-" + key))


def _exit_receipt_path(state_directory, task_id, arm_id):
    key = _attempt_key(task_id, arm_id)
    return os.path.join(state_directory, ".exit-" + key + ".json")


def _open_state_readonly(path):
    flags = os.O_RDONLY | getattr(os, "O_CLOEXEC", 0)
    if hasattr(os, "O_NOFOLLOW"):
        flags |= os.O_NOFOLLOW
    fd = os.open(path, flags)
    try:
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or info.st_uid != _current_uid():
            raise _LaunchError("UNKNOWN_LAUNCH_RESULT")
        data = os.read(fd, 4097)
        if len(data) > 4096 or os.read(fd, 1):
            raise _LaunchError("UNKNOWN_LAUNCH_RESULT")
        return data
    finally:
        os.close(fd)


def _read_state_json(path):
    try:
        raw = _open_state_readonly(path)
    except FileNotFoundError:
        return None
    except _LaunchError:
        raise
    except OSError as exc:
        raise _LaunchError("UNKNOWN_LAUNCH_RESULT") from exc
    try:
        value = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, ValueError, RecursionError) as exc:
        raise _LaunchError("UNKNOWN_LAUNCH_RESULT") from exc
    if not isinstance(value, dict):
        raise _LaunchError("UNKNOWN_LAUNCH_RESULT")
    return value


def _sanitize_result(value, *, receipt=False):
    if not isinstance(value, dict):
        return None
    if set(value) != {"status", "pid", "processKey", "startedAt", "errorCode"}:
        return None
    status_value = value["status"]
    if status_value not in {"started", "busy", "already_running", "failed"}:
        return None
    if receipt and status_value not in {"started", "failed"}:
        return None
    pid = value["pid"]
    process_key = value["processKey"]
    started_at = value["startedAt"]
    error_code = value["errorCode"]
    if pid is not None and (isinstance(pid, bool) or not isinstance(pid, int) or pid <= 0):
        return None
    if started_at is not None:
        if not isinstance(started_at, str):
            return None
        try:
            datetime.datetime.fromisoformat(started_at.replace("Z", "+00:00"))
        except ValueError:
            return None
    if error_code is not None and (
            not isinstance(error_code, str)
            or not re.fullmatch(r"[A-Z0-9_]{1,128}", error_code)):
        return None
    if status_value == "started":
        if pid is None or started_at is None or error_code is not None:
            return None
    elif status_value == "failed":
        if pid is not None or process_key is not None or started_at is not None or error_code is None:
            return None
    elif pid is not None or process_key is not None or started_at is not None or error_code is not None:
        return None
    if process_key is not None:
        if not isinstance(process_key, dict) or set(process_key) != {"hostBootId", "pid", "startTicks"}:
            return None
        key_pid = process_key["pid"]
        if (not isinstance(process_key["hostBootId"], str)
                or not process_key["hostBootId"]
                or isinstance(key_pid, bool)
                or not isinstance(key_pid, int)
                or key_pid <= 0
                or pid != key_pid
                or not isinstance(process_key["startTicks"], str)
                or not re.fullmatch(r"\d+", process_key["startTicks"])):
            return None
    return _payload(status_value, pid, process_key, started_at, error_code)


def _inspect_existing_attempt(state_directory, task_id, arm_id, config_hash):
    claim_path, receipt_path = _attempt_paths(state_directory, task_id, arm_id)
    receipt = _read_state_json(receipt_path)
    if receipt is not None:
        if receipt.get("version") != VERSION or receipt.get("configHash") != config_hash:
            raise _LaunchError("CONFIG_CHANGED")
        result = _sanitize_result(receipt.get("result"), receipt=True)
        if result is None:
            raise _LaunchError("UNKNOWN_LAUNCH_RESULT")
        return result
    claim = _read_state_json(claim_path)
    if claim is None:
        return None
    if claim.get("version") != VERSION or claim.get("configHash") != config_hash:
        raise _LaunchError("CONFIG_CHANGED")
    raise _LaunchError("UNKNOWN_LAUNCH_RESULT")


def _write_all(fd, data):
    offset = 0
    while offset < len(data):
        written = os.write(fd, data[offset:])
        if written <= 0:
            raise OSError("short write")
        offset += written


def _fsync_directory(path):
    flags = os.O_RDONLY | getattr(os, "O_CLOEXEC", 0)
    if hasattr(os, "O_DIRECTORY"):
        flags |= os.O_DIRECTORY
    fd = os.open(path, flags)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def _atomic_write_json(target_path, directory, payload_obj):
    body = json.dumps(payload_obj, separators=(",", ":"), ensure_ascii=True).encode("ascii")
    key = os.path.basename(target_path)
    temporary = os.path.join(directory, key + ".tmp-" + str(os.getpid()) + "-" + str(time.time_ns()))
    flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_CLOEXEC", 0)
    if hasattr(os, "O_NOFOLLOW"):
        flags |= os.O_NOFOLLOW
    fd = None
    try:
        fd = os.open(temporary, flags, 0o600)
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or info.st_uid != _current_uid():
            raise OSError("atomic write identity")
        _write_all(fd, body)
        os.fsync(fd)
        os.close(fd)
        fd = None
        os.replace(temporary, target_path)
        try:
            _fsync_directory(directory)
        except OSError:
            pass
        return True
    except OSError:
        return False
    finally:
        if fd is not None:
            try:
                os.close(fd)
            except OSError:
                pass
        try:
            os.unlink(temporary)
        except OSError:
            pass


def _create_claim(claim_path, state_directory, config_hash):
    flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_CLOEXEC", 0)
    if hasattr(os, "O_NOFOLLOW"):
        flags |= os.O_NOFOLLOW
    try:
        fd = os.open(claim_path, flags, 0o600)
    except FileExistsError:
        return False
    except OSError as exc:
        raise _LaunchError("CLAIM_CREATE_FAILED") from exc
    try:
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or info.st_uid != _current_uid():
            raise _LaunchError("CLAIM_CREATE_FAILED")
        body = json.dumps({"version": VERSION, "configHash": config_hash},
                          separators=(",", ":"), ensure_ascii=True).encode("ascii")
        _write_all(fd, body)
        os.fsync(fd)
    except _LaunchError:
        raise
    except OSError as exc:
        raise _LaunchError("CLAIM_CREATE_FAILED") from exc
    finally:
        os.close(fd)
    try:
        _fsync_directory(state_directory)
    except OSError as exc:
        raise _LaunchError("CLAIM_CREATE_FAILED") from exc
    return True


def _write_receipt(receipt_path, state_directory, config_hash, result):
    safe_result = _sanitize_result(result, receipt=True)
    if safe_result is None:
        return False
    return _atomic_write_json(receipt_path, state_directory, {
        "version": VERSION,
        "configHash": config_hash,
        "result": safe_result,
    })


def _lock_filename(gpu_uuid):
    digest = hashlib.sha256(gpu_uuid.encode("utf-8")).hexdigest()
    return ".gpu-" + digest + ".lock"


def _acquire_gpu_locks(lock_directory, gpu_uuids, *, shared=False):
    lock_module = _require_fcntl()
    handles = []
    try:
        for gpu_uuid in sorted(gpu_uuids, key=lambda item: hashlib.sha256(item.encode("utf-8")).hexdigest()):
            path = os.path.join(lock_directory, _lock_filename(gpu_uuid))
            flags = os.O_RDWR | os.O_CREAT | getattr(os, "O_CLOEXEC", 0)
            if hasattr(os, "O_NOFOLLOW"):
                flags |= os.O_NOFOLLOW
            fd = os.open(path, flags, 0o600)
            try:
                info = os.fstat(fd)
                if not stat.S_ISREG(info.st_mode) or info.st_uid != _current_uid():
                    raise _LaunchError("GPU_LOCK_INVALID")
                try:
                    lock_module.flock(fd, (lock_module.LOCK_SH if shared else lock_module.LOCK_EX) | lock_module.LOCK_NB)
                except (BlockingIOError, PermissionError) as exc:
                    raise _GpuLockBusy() from exc
                except OSError as exc:
                    if exc.errno in {11, 13, 35}:
                        raise _GpuLockBusy() from exc
                    raise _LaunchError("GPU_LOCK_FAILED") from exc
                handles.append((fd, lock_module))
            except Exception:
                try:
                    os.close(fd)
                except OSError:
                    pass
                raise
        return handles
    except Exception:
        _close_gpu_locks(handles)
        raise


def _is_gpu_locked(lock_directory, gpu_uuid):
    """Non-blocking probe to check whether an exclusive GPU lock is currently held."""
    if _fcntl is None or not os.path.isdir(lock_directory):
        return False
    path = os.path.join(lock_directory, _lock_filename(gpu_uuid))
    if not os.path.exists(path):
        return False
    flags = os.O_RDWR | getattr(os, "O_CLOEXEC", 0) | getattr(os, "O_NOFOLLOW", 0)
    fd = None
    try:
        fd = os.open(path, flags)
        try:
            _fcntl.flock(fd, _fcntl.LOCK_EX | _fcntl.LOCK_NB)
            return False
        except (BlockingIOError, PermissionError):
            return True
        except OSError as exc:
            return exc.errno in {11, 13, 35}
    except OSError:
        return False
    finally:
        if fd is not None:
            try:
                os.close(fd)
            except OSError:
                pass


def _close_gpu_locks(handles):
    for fd, _lock_module in reversed(handles or []):
        try:
            os.close(fd)
        except OSError:
            pass


def _sharing_prefix(sharing):
    return ".share-" + hashlib.sha256(sharing["groupId"].encode()).hexdigest()


def _sharing_lock(state_directory, name):
    fd = os.open(os.path.join(state_directory, name), os.O_RDWR | os.O_CREAT | getattr(os, "O_NOFOLLOW", 0), 0o600)
    info = os.fstat(fd)
    if not stat.S_ISREG(info.st_mode) or info.st_uid != _current_uid():
        os.close(fd)
        raise _LaunchError("GPU_LOCK_INVALID")
    return fd


def _pid_is_alive(pid):
    if not isinstance(pid, int) or isinstance(pid, bool) or pid <= 0:
        return False
    try:
        os.kill(pid, 0)
        return True
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    except OSError:
        return False


def _sharing_meta_path(slot_path):
    return slot_path + ".meta"


def _read_sharing_slot_data(slot_path, fd):
    meta_path = _sharing_meta_path(slot_path)
    slot_data = None
    try:
        os.lseek(fd, 0, os.SEEK_SET)
        raw = os.read(fd, 32768).decode("utf-8", errors="replace")
        if raw.strip():
            slot_data = json.loads(raw)
    except (OSError, ValueError):
        slot_data = None
    if isinstance(slot_data, dict):
        return slot_data
    try:
        with open(meta_path, "r", encoding="utf-8") as stream:
            meta = json.load(stream)
            if isinstance(meta, dict):
                return meta
    except (OSError, ValueError):
        pass
    return {}


def _sharing_occupancy(state_directory, sharing):
    """Live flocks are authoritative; stale files consume no slots. Supports both status_json and grace-window readiness."""
    locks = _require_fcntl()
    prefix = _sharing_prefix(sharing) + "-"
    grace_seconds = float(sharing.get("readyAfterSeconds", 15))
    occupied = {}
    for name in os.listdir(state_directory):
        if not name.startswith(prefix) or not name.endswith(".slot"):
            continue
        slot_path = os.path.join(state_directory, name)
        fd = _sharing_lock(state_directory, name)
        try:
            try:
                locks.flock(fd, locks.LOCK_EX | locks.LOCK_NB)
            except BlockingIOError:
                data = _read_sharing_slot_data(slot_path, fd)
                ready = False
                status_path = data.get("statusPath")
                if isinstance(status_path, str) and status_path:
                    try:
                        with open(status_path, encoding="utf-8") as stream:
                            status_data = json.load(stream)
                        ready = (
                            status_data.get("pid") == data.get("pid")
                            and status_data.get("status") in {"running", "completed"}
                        )
                    except (OSError, ValueError, KeyError):
                        pass
                else:
                    # Without private status_json, consider the worker ready once it is alive
                    # and has passed the memory-stabilization grace window.
                    pid = data.get("pid")
                    started_epoch = data.get("startedAtEpoch")
                    if _pid_is_alive(pid) and isinstance(started_epoch, (int, float)):
                        ready = (time.time() - float(started_epoch)) >= grace_seconds
                gpu_hash = name[len(prefix):].rsplit("-", 1)[0]
                occupied.setdefault(gpu_hash, []).append({"name": name, "ready": ready})
        finally:
            os.close(fd)
    return occupied


def _sharing_candidate_allowed(state_directory, request, gpu_uuid):
    sharing = request.get("gpuSharing")
    if not sharing:
        return True
    occupied = _sharing_occupancy(state_directory, sharing)
    here = occupied.get(hashlib.sha256(gpu_uuid.encode()).hexdigest(), [])
    return (len(here) < sharing["maxWorkersPerDevice"] and all(slot["ready"] for slot in here)
            and (bool(here) or len(occupied) < sharing["maxDevices"]))


def _acquire_shared_gpu_locks(state_directory, request):
    locks = _require_fcntl()
    sharing = request["gpuSharing"]
    gpu_uuid = request["_gpuUuids"][0]
    control = _sharing_lock(state_directory, _sharing_prefix(sharing) + ".control")
    handles = []
    try:
        locks.flock(control, locks.LOCK_EX)
        if not _sharing_candidate_allowed(state_directory, request, gpu_uuid):
            raise _GpuLockBusy()
        handles = _acquire_gpu_locks(state_directory, [gpu_uuid], shared=True)
        occupied = _sharing_occupancy(state_directory, sharing)
        gpu_hash = hashlib.sha256(gpu_uuid.encode()).hexdigest()
        used = {slot["name"] for slot in occupied.get(gpu_hash, [])}
        status_path = next(
            (s["path"] for s in request.get("sources", []) if isinstance(s, dict) and s.get("kind") == "status_json"),
            None,
        )
        for slot in range(sharing["maxWorkersPerDevice"]):
            name = _sharing_prefix(sharing) + "-" + gpu_hash + "-" + str(slot) + ".slot"
            if name in used:
                continue
            slot_path = os.path.join(state_directory, name)
            fd = _sharing_lock(state_directory, name)
            try:
                locks.flock(fd, locks.LOCK_EX | locks.LOCK_NB)
                data = {
                    "gpuUuid": gpu_uuid,
                    "pid": None,
                    "statusPath": status_path,
                    "startedAtEpoch": time.time(),
                }
                encoded = json.dumps(data, separators=(",", ":")).encode("utf-8")
                os.lseek(fd, 0, os.SEEK_SET)
                os.ftruncate(fd, 0)
                _write_all(fd, encoded)
                os.fsync(fd)
                _atomic_write_json(_sharing_meta_path(slot_path), os.path.dirname(slot_path), data)
                request["_sharingSlotPath"] = slot_path
                handles.append((fd, locks))
                return handles
            except Exception:
                os.close(fd)
                raise
        raise _GpuLockBusy()
    except Exception:
        _close_gpu_locks(handles)
        raise
    finally:
        os.close(control)


def _output_disk_ready(request):
    floor = request.get("minFreeDiskMiB", 0)
    return not floor or shutil.disk_usage(os.path.dirname(request["_logPath"])).free >= floor * 1024**2


def _gpus_idle(probe, request):
    try:
        query = probe._query_linux_gpu(include_free=True) if request.get("minFreeMemoryMiB") else probe._query_linux_gpu()
    except Exception:
        return False
    if not isinstance(query, dict) or query.get("status") != "ok":
        return False
    csv_text = query.get("csv")
    if not isinstance(csv_text, str) or len(csv_text) > 16 * 1024:
        return False
    rows = {}
    try:
        for row in csv.reader(io.StringIO(csv_text, newline="")):
            if not row or all(not value.strip() for value in row):
                continue
            if len(row) != (6 if request.get("minFreeMemoryMiB") else 5):
                return False
            index_text, gpu_uuid, utilization_text, used_text, total_text = [value.strip() for value in row[:5]]
            if not index_text.isdecimal():
                return False
            gpu_uuid = gpu_uuid.strip()
            if gpu_uuid in rows:
                rows[gpu_uuid] = None
            else:
                rows[gpu_uuid] = (utilization_text, used_text, total_text, row[5].strip() if len(row) == 6 else None)
    except (csv.Error, UnicodeError):
        return False

    for expected_uuid in request["_gpuUuids"]:
        metrics = rows.get(expected_uuid)
        if not isinstance(metrics, tuple):
            return False
        utilization_text, used_text, total_text, free_text = metrics
        if any(value is not None and _MISSING_GPU_VALUE_RE.fullmatch(value.strip()) for value in metrics):
            return False
        try:
            utilization = float(utilization_text)
            used = float(used_text)
            total = float(total_text)
            free = float(free_text) if free_text is not None else 0
        except ValueError:
            return False
        if (not all(math.isfinite(value) and value >= 0 for value in (utilization, used, total))
                or utilization > request["maxUtilizationPercent"]
                or (request.get("minFreeMemoryMiB") and (not math.isfinite(free) or free < request["minFreeMemoryMiB"]))
                or (not request.get("minFreeMemoryMiB") and used > request["maxMemoryMiB"])):
            return False
    return True


def _boot_id():
    try:
        with open("/proc/sys/kernel/random/boot_id", "r", encoding="ascii") as stream:
            value = stream.read(128).strip()
    except (OSError, UnicodeError) as exc:
        raise _LaunchError("PROCESS_SCAN_INCOMPLETE") from exc
    if not value or len(value) > 128:
        raise _LaunchError("PROCESS_SCAN_INCOMPLETE")
    return value


def _scan_for_registered_process(probe, request, hosts, tasks):
    boot = _boot_id()
    normalized_entries = []
    for entry in request["entryPaths"]:
        if entry.startswith("module:") or entry.startswith("-m "):
            normalized_entries.append(entry)
        else:
            normalized_entries.append(os.path.realpath(entry if os.path.isabs(entry) else os.path.join(tasks[0], entry)))
    scan = probe.scan_registered_processes("/proc", boot, {
        "hostAllowedRoots": hosts,
        "allowedDirectories": tasks,
        "entryPaths": normalized_entries,
        "sources": [],
    })
    if not isinstance(scan, dict) or scan.get("scanComplete") is not True:
        raise _LaunchError("PROCESS_SCAN_INCOMPLETE")
    candidates = scan.get("candidates")
    if not isinstance(candidates, list):
        raise _LaunchError("PROCESS_SCAN_INCOMPLETE")
    if candidates:
        return _already_running()
    return None


def _validate_log_parent(probe, log_path, hosts, tasks):
    if not os.path.isabs(log_path):
        raise _LaunchError("LOG_PATH_INVALID")
    parent = os.path.dirname(log_path)
    try:
        parent_info = os.stat(parent, follow_symlinks=False)
    except OSError as exc:
        raise _LaunchError("LOG_PARENT_MISSING") from exc
    resolved_parent = os.path.realpath(parent)
    if (not stat.S_ISDIR(parent_info.st_mode)
            or not probe._path_in_scope(resolved_parent, hosts, tasks)):
        raise _LaunchError("LOG_PATH_INVALID")
    if os.path.dirname(resolved_parent) == resolved_parent:
        raise _LaunchError("LOG_PATH_INVALID")
    return parent, resolved_parent


def _open_append_log(probe, log_path, hosts, tasks):
    parent, resolved_parent = _validate_log_parent(probe, log_path, hosts, tasks)
    try:
        parent_before = os.stat(parent, follow_symlinks=False)
    except OSError as exc:
        raise _LaunchError("LOG_PATH_INVALID") from exc
    flags = os.O_WRONLY | os.O_APPEND | os.O_CREAT | getattr(os, "O_CLOEXEC", 0)
    if hasattr(os, "O_NOFOLLOW"):
        flags |= os.O_NOFOLLOW
    try:
        fd = os.open(log_path, flags, 0o600)
    except OSError as exc:
        raise _LaunchError("LOG_OPEN_FAILED") from exc
    try:
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or info.st_uid != _current_uid():
            raise _LaunchError("LOG_PATH_INVALID")
        os.fchmod(fd, 0o600)
        parent_after = os.stat(parent, follow_symlinks=False)
        resolved_after = os.path.realpath(parent)
        if ((parent_before.st_dev, parent_before.st_ino) != (parent_after.st_dev, parent_after.st_ino)
                or resolved_after != resolved_parent
                or not probe._path_in_scope(resolved_after, hosts, tasks)):
            raise _LaunchError("LOG_PATH_CHANGED")
        return fd
    except Exception:
        os.close(fd)
        raise


def _started_at():
    return datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds")


def _process_key(probe, pid, boot):
    try:
        first = probe._proc_identity("/proc", pid, boot)
        second = probe._proc_identity("/proc", pid, boot)
    except Exception:
        return None
    if not isinstance(first, dict) or first != second:
        return None
    start_ticks = first.get("startTicks")
    if (first.get("bootId") != boot or first.get("pid") != pid
            or not isinstance(start_ticks, str) or not start_ticks):
        return None
    return {"hostBootId": boot, "pid": pid, "startTicks": start_ticks}


def _load_module_environment(modules, process_env):
    executable = shutil.which("modulecmd", path=process_env.get("PATH"))
    if executable is None:
        raise _LaunchError("MODULECMD_UNAVAILABLE")
    for module in modules:
        try:
            result = subprocess.run(
                [executable, "python", "load", module], env=process_env, check=True,
                stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, timeout=10,
            )
            if len(result.stdout) > 1024 * 1024:
                raise ValueError("Module output is too large")
            statements = ast.parse(result.stdout).body
            for statement in statements:
                if isinstance(statement, ast.Import) and all(alias.name == "os" and alias.asname is None for alias in statement.names):
                    continue
                if isinstance(statement, ast.Assign) and len(statement.targets) == 1:
                    target = statement.targets[0]
                    if isinstance(target, ast.Name) and target.id == "_mlstatus":
                        if ast.literal_eval(statement.value) is not True:
                            raise ValueError("Module load failed")
                        continue
                    value = ast.literal_eval(statement.value)
                    if not isinstance(value, str) or "\0" in value:
                        raise ValueError("Invalid environment value")
                elif isinstance(statement, ast.Delete) and len(statement.targets) == 1:
                    target = statement.targets[0]
                    value = None
                else:
                    raise ValueError("Unsupported module output")
                if (not isinstance(target, ast.Subscript) or not isinstance(target.value, ast.Attribute)
                        or not isinstance(target.value.value, ast.Name) or target.value.value.id != "os"
                        or target.value.attr != "environ"):
                    raise ValueError("Unsupported environment statement")
                # Python 3.7 and 3.8 wrap a subscript literal in ast.Index.
                key = ast.literal_eval(target.slice.value if isinstance(target.slice, ast.Index) else target.slice)
                if not isinstance(key, str) or not _ENV_KEY_RE.fullmatch(key):
                    raise ValueError("Invalid environment key")
                if value is None:
                    process_env.pop(key, None)
                else:
                    process_env[key] = value
        except (OSError, subprocess.SubprocessError, SyntaxError, ValueError) as exc:
            raise _LaunchError("MODULE_LOAD_FAILED") from exc


def _build_launch_argv_and_env(request, script):
    launch = request["launch"]
    mode = launch.get("mode") or "python_script"
    if mode == "python_script":
        argv = [launch["pythonPath"], "-u", script, *request["_arguments"]]
    elif mode == "python_module":
        argv = [launch["pythonPath"], "-u", "-m", launch["moduleName"], *request["_arguments"]]
    else:
        argv = [*launch["command"], *request["_arguments"]]

    process_env = dict(os.environ)
    process_env.pop("TMUX", None)
    process_env.pop("TMUX_PANE", None)

    # Environment activation without shell interpolation
    extra_path_entries = []
    venv_path = launch.get("venvPath")
    if venv_path:
        extra_path_entries.append(os.path.join(venv_path, "bin"))
        process_env["VIRTUAL_ENV"] = venv_path
    conda_env = launch.get("condaEnv")
    if conda_env:
        if os.path.isabs(conda_env):
            extra_path_entries.append(os.path.join(conda_env, "bin"))
            process_env["CONDA_PREFIX"] = conda_env
        else:
            process_env["CONDA_DEFAULT_ENV"] = conda_env
            home = os.path.expanduser("~")
            for base in (os.environ.get("CONDA_PREFIX"), os.path.join(home, "miniconda3"), os.path.join(home, "anaconda3"), os.path.join(home, "mambaforge"), "/opt/conda"):
                if not base:
                    continue
                cand = os.path.join(base, "envs", conda_env, "bin")
                if os.path.isdir(cand):
                    extra_path_entries.append(cand)
                    process_env["CONDA_PREFIX"] = os.path.dirname(cand)
                    break
    if extra_path_entries:
        existing_path = process_env.get("PATH", "")
        process_env["PATH"] = ":".join(extra_path_entries + ([existing_path] if existing_path else []))

    if launch.get("modules"):
        _load_module_environment(launch["modules"], process_env)

    for k, v in (launch.get("env") or {}).items():
        if k != "CUDA_VISIBLE_DEVICES":
            process_env[k] = v

    cuda_mode = request.get("cudaVisibleDevicesMode") or "index"
    if cuda_mode == "uuid":
        process_env["CUDA_VISIBLE_DEVICES"] = ",".join(request["_gpuUuids"])
    else:
        process_env["CUDA_VISIBLE_DEVICES"] = ",".join(request["_gpuIndices"])

    return argv, process_env


def _write_supervisor_script(state_directory):
    """Write a minimal detached supervisor script that owns GPU locks and records real exit codes."""
    code = (
        "import datetime, json, os, subprocess, sys, time\n"
        "def main():\n"
        "    meta_path = sys.argv[1]\n"
        "    with open(meta_path, 'r', encoding='utf-8') as s:\n"
        "        meta = json.load(s)\n"
        "    try:\n"
        "        os.unlink(meta_path)\n"
        "    except OSError:\n"
        "        pass\n"
        "    log_fd = int(meta['logFd'])\n"
        "    ready_fd = int(meta['readyFd'])\n"
        "    exit_path = meta['exitPath']\n"
        "    log_stream = os.fdopen(log_fd, 'ab', buffering=0, closefd=True)\n"
        "    try:\n"
        "        child = subprocess.Popen(\n"
        "            meta['argv'], shell=False, cwd=meta['cwd'],\n"
        "            stdin=subprocess.DEVNULL, stdout=log_stream, stderr=subprocess.STDOUT,\n"
        "            start_new_session=True, close_fds=True, env=meta['env'],\n"
        "        )\n"
        "    except Exception as exc:\n"
        "        try:\n"
        "            os.write(ready_fd, json.dumps({'ok': False, 'error': str(exc)}).encode('utf-8'))\n"
        "        finally:\n"
        "            os.close(ready_fd)\n"
        "            log_stream.close()\n"
        "        return 1\n"
        "    log_stream.close()\n"
        "    try:\n"
        "        os.write(ready_fd, json.dumps({'ok': True, 'pid': child.pid}).encode('utf-8'))\n"
        "    finally:\n"
        "        os.close(ready_fd)\n"
        "    rc = child.wait()\n"
        "    tmp = exit_path + '.tmp-' + str(os.getpid())\n"
        "    body = json.dumps({'version': 1, 'pid': child.pid, 'exitCode': rc, 'exitedAt': datetime.datetime.now(datetime.timezone.utc).isoformat(timespec='seconds').replace('+00:00', 'Z')}).encode('ascii')\n"
        "    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)\n"
        "    try:\n"
        "        os.write(fd, body)\n"
        "        os.fsync(fd)\n"
        "    finally:\n"
        "        os.close(fd)\n"
        "    os.replace(tmp, exit_path)\n"
        "    return 0\n"
        "if __name__ == '__main__':\n"
        "    raise SystemExit(main())\n"
    ).encode("utf-8")
    digest = hashlib.sha256(code).hexdigest()[:16]
    script_path = os.path.join(state_directory, ".tm-supervisor-" + digest + ".py")
    if not os.path.exists(script_path):
        tmp = script_path + ".tmp-" + str(os.getpid()) + "-" + str(time.time_ns())
        fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        try:
            _write_all(fd, code)
            os.fsync(fd)
        finally:
            os.close(fd)
        os.replace(tmp, script_path)
    return script_path


def _update_sharing_slot_pid(slot_path, pid):
    try:
        with open(slot_path, "r+", encoding="utf-8") as stream:
            data = json.load(stream)
            data["pid"] = pid
            data["startedAtEpoch"] = time.time()
            stream.seek(0)
            json.dump(data, stream, separators=(",", ":"))
            stream.truncate()
            stream.flush()
            os.fsync(stream.fileno())
        _atomic_write_json(_sharing_meta_path(slot_path), os.path.dirname(slot_path), data)
    except OSError:
        pass


def _spawn_process(request, script, cwd, log_fd, boot, gpu_lock_fds, state_directory=None):
    argv, process_env = _build_launch_argv_and_env(request, script)

    if request.get("useSupervisor") and state_directory:
        # Thin supervisor wrapper owns the GPU lock FDs and records real exit code without
        # leaking flock FDs into the user's training process or its descendants.
        sup_script = _write_supervisor_script(state_directory)
        exit_path = _exit_receipt_path(state_directory, request["taskId"], request["armId"])
        ready_r, ready_w = os.pipe()
        meta_path = os.path.join(state_directory, f".sup-meta-{os.getpid()}-{time.time_ns()}.json")
        _atomic_write_json(meta_path, state_directory, {
            "argv": argv,
            "cwd": cwd,
            "env": process_env,
            "logFd": log_fd,
            "readyFd": ready_w,
            "exitPath": exit_path,
        })
        pass_fds = tuple(list(gpu_lock_fds) + [log_fd, ready_w])
        try:
            subprocess.Popen(
                [sys.executable or "/usr/bin/python3", "-I", "-S", "-B", sup_script, meta_path],
                shell=False,
                cwd=cwd,
                stdin=subprocess.DEVNULL,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                start_new_session=True,
                close_fds=True,
                pass_fds=pass_fds,
            )
        except Exception:
            os.close(ready_r)
            os.close(ready_w)
            os.close(log_fd)
            try:
                os.unlink(meta_path)
            except OSError:
                pass
            raise
        os.close(ready_w)
        os.close(log_fd)
        try:
            raw = os.read(ready_r, 4096)
        finally:
            os.close(ready_r)
        try:
            reply = json.loads(raw.decode("utf-8"))
        except (ValueError, UnicodeDecodeError) as exc:
            raise _LaunchError("PROCESS_SPAWN_FAILED") from exc
        if not isinstance(reply, dict) or not reply.get("ok"):
            raise _LaunchError("PROCESS_SPAWN_FAILED")
        pid = reply.get("pid")
    else:
        log_stream = os.fdopen(log_fd, "ab", buffering=0, closefd=True)
        try:
            child = subprocess.Popen(
                argv,
                shell=False,
                cwd=cwd,
                stdin=subprocess.DEVNULL,
                stdout=log_stream,
                stderr=subprocess.STDOUT,
                start_new_session=True,
                close_fds=True,
                pass_fds=tuple(gpu_lock_fds),
                env=process_env,
            )
        finally:
            log_stream.close()
        pid = child.pid

    if isinstance(pid, bool) or not isinstance(pid, int) or pid <= 0:
        raise _LaunchError("PROCESS_SPAWN_FAILED")
    process_key = _process_key(_probe(), pid, boot)
    if request.get("_sharingSlotPath") and state_directory:
        _update_sharing_slot_pid(request["_sharingSlotPath"], pid)
    return _payload("started", pid=pid, process_key=process_key, started_at=_started_at())


def launch_task(request):
    """Validate, inspect, claim, and launch exactly one registered task."""
    try:
        normalized = _validate_request(request)
        _require_fcntl()
        probe = _probe()
        canonical_hosts, canonical_tasks = probe._canonical_task_roots(
            normalized["hostAllowedRoots"], normalized["taskAllowedDirectories"])
        if canonical_hosts is None or canonical_tasks is None:
            raise _LaunchError("PATH_OUTSIDE_ALLOWED_ROOT")
        state_directory = (
            _state_directory(canonical_hosts[0], normalized["stateDir"])
            if normalized.get("stateDir")
            else _state_directory(canonical_hosts[0])
        )
        lock_directory = _runtime_lock_dir() if normalized.get("useLocalLocks") else state_directory

        existing = _inspect_existing_attempt(
            state_directory, normalized["taskId"], normalized["armId"], normalized["configHash"])
        if existing is not None:
            return existing

        hosts, tasks, cwd, script, log_path = _canonical_scope(normalized, probe)
        if not _output_disk_ready(normalized) or not _gpus_idle(probe, normalized):
            return _busy()

        try:
            locks = (_acquire_shared_gpu_locks(lock_directory, normalized) if normalized.get("gpuSharing")
                     else _acquire_gpu_locks(lock_directory, normalized["_gpuUuids"]))
        except _GpuLockBusy:
            return _busy()
        boot = None
        log_fd = None
        claim_created = False
        try:
            existing = _inspect_existing_attempt(
                state_directory, normalized["taskId"], normalized["armId"], normalized["configHash"])
            if existing is not None:
                return existing
            scan_result = _scan_for_registered_process(probe, normalized, hosts, tasks)
            if scan_result is not None:
                return scan_result
            if not _output_disk_ready(normalized) or not _gpus_idle(probe, normalized):
                return _busy()

            hosts, tasks, cwd, script, log_path = _canonical_scope(normalized, probe)
            log_fd = _open_append_log(probe, log_path, hosts, tasks)
            claim_path, receipt_path = _attempt_paths(
                state_directory, normalized["taskId"], normalized["armId"])
            if not _create_claim(claim_path, state_directory, normalized["configHash"]):
                existing = _inspect_existing_attempt(
                    state_directory, normalized["taskId"], normalized["armId"], normalized["configHash"])
                return existing if existing is not None else _failed("UNKNOWN_LAUNCH_RESULT")
            claim_created = True
            boot = _boot_id()

            try:
                result = _spawn_process(
                    normalized, script, cwd, log_fd, boot,
                    [fd for fd, _lock_module in locks],
                    state_directory=state_directory)
                log_fd = None
            except _LaunchError:
                raise
            except Exception as exc:
                raise _LaunchError("PROCESS_SPAWN_FAILED") from exc

            if not _write_receipt(
                    receipt_path, state_directory, normalized["configHash"], result):
                return _failed("UNKNOWN_LAUNCH_RESULT")
            return result
        except _LaunchError as exc:
            if not claim_created:
                raise
            failure = _failed(exc.error_code)
            claim_path, receipt_path = _attempt_paths(
                state_directory, normalized["taskId"], normalized["armId"])
            if not _write_receipt(
                    receipt_path, state_directory, normalized["configHash"], failure):
                return _failed("UNKNOWN_LAUNCH_RESULT")
            return failure
        finally:
            if log_fd is not None:
                try:
                    os.close(log_fd)
                except OSError:
                    pass
            _close_gpu_locks(locks)
    except _LaunchError as exc:
        return _failed(exc.error_code)
    except Exception:
        return _failed("LAUNCH_INTERNAL_ERROR")


def signal_task(request):
    """Opt-in remote job control (stop/kill): strictly verifies bootId, pid, startTicks, and UID before signaling."""
    if not isinstance(request, dict) or request.get("op") != "signal_task":
        return {"ok": False, "action": "stop", "pidsSignaled": [], "errorCode": "INVALID_REQUEST"}
    action = request.get("action")
    if action not in ("stop", "kill"):
        return {"ok": False, "action": "stop", "pidsSignaled": [], "errorCode": "INVALID_ACTION"}
    keys = request.get("processKeys")
    if not isinstance(keys, list) or not keys or len(keys) > 64:
        return {"ok": False, "action": action, "pidsSignaled": [], "errorCode": "INVALID_PROCESS_KEYS"}
    try:
        boot = _boot_id()
        uid = _current_uid()
    except _LaunchError as exc:
        return {"ok": False, "action": action, "pidsSignaled": [], "errorCode": exc.error_code}

    sig = _signal.SIGKILL if action == "kill" else _signal.SIGTERM
    own_pid = os.getpid()
    own_pgid = os.getpgrp() if hasattr(os, "getpgrp") else None
    signaled = []
    signaled_pgids = set()

    for key in keys:
        if not isinstance(key, dict):
            continue
        pid = key.get("pid")
        host_boot = key.get("hostBootId")
        start_ticks = key.get("startTicks")
        if (host_boot != boot
                or isinstance(pid, bool) or not isinstance(pid, int) or pid <= 1 or pid == own_pid
                or not isinstance(start_ticks, str) or not start_ticks.isdecimal()):
            continue
        proc_dir = f"/proc/{pid}"
        try:
            proc_stat_info = os.stat(proc_dir)
            if proc_stat_info.st_uid != uid:
                continue
            with open(os.path.join(proc_dir, "stat"), "r", encoding="ascii") as stream:
                stat_line = stream.read(4096)
            close_paren = stat_line.rfind(")")
            if close_paren < 0:
                continue
            fields = stat_line[close_paren + 2:].split()
            if len(fields) <= 19 or fields[19] != start_ticks:
                continue
            pgid = int(fields[2]) if len(fields) > 2 and fields[2].lstrip("-").isdecimal() else None
            if pgid and pgid > 1 and pgid != own_pgid and pgid not in signaled_pgids:
                try:
                    os.killpg(pgid, sig)
                    signaled_pgids.add(pgid)
                    signaled.append(pid)
                    continue
                except OSError:
                    pass
            os.kill(pid, sig)
            signaled.append(pid)
        except (FileNotFoundError, ProcessLookupError, PermissionError, OSError):
            continue

    if not signaled:
        return {"ok": False, "action": action, "pidsSignaled": [], "errorCode": "NO_MATCHING_LIVE_PROCESS"}
    return {"ok": True, "action": action, "pidsSignaled": signaled, "errorCode": None}


def _emit_frame(envelope):
    payload = json.dumps(envelope, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
    if len(payload) > MAX_RESPONSE_BYTES:
        payload = json.dumps({
            "version": VERSION,
            "requestId": envelope.get("requestId"),
            "sourceId": None,
            "payload": _failed("RESPONSE_LIMIT"),
        }, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
    sys.stdout.buffer.write(FRAME_MAGIC)
    sys.stdout.buffer.write(len(payload).to_bytes(4, "big"))
    sys.stdout.buffer.write(payload)
    sys.stdout.buffer.flush()


def main():
    request = None
    try:
        if REQUEST_B64 == "__MONITOR_REQUEST_B64__":
            raise ValueError("request missing")
        request = json.loads(base64.b64decode(REQUEST_B64, validate=True).decode("utf-8"))
        if not isinstance(request, dict):
            raise ValueError("request schema")
        op = request.get("op")
        if op == "signal_task":
            payload = signal_task(request)
        else:
            payload = launch_task(request)
        request_id = request.get("requestId") if isinstance(request.get("requestId"), str) else None
        _emit_frame({
            "version": VERSION,
            "requestId": request_id,
            "sourceId": None,
            "payload": payload,
        })
        return 0
    except Exception:
        request_id = request.get("requestId") if isinstance(request, dict) and isinstance(request.get("requestId"), str) else None
        _emit_frame({
            "version": VERSION,
            "requestId": request_id,
            "sourceId": None,
            "payload": _failed("INVALID_REQUEST"),
        })
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
