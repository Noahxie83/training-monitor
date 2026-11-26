#!/usr/bin/python3
"""Fail-closed launcher for a single registered Python training task."""
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
MAX_RESPONSE_BYTES = 2 * 1024 * 1024
MAX_ARGUMENTS_CHARS = 8192
MAX_ARGUMENTS = 256
MAX_ITEMS = 256
MAX_STRING_BYTES = 8192
STATE_DIRECTORY = ".training-monitor-autostart"
REQUEST_B64 = "__MONITOR_REQUEST_B64__"
PROBE_SOURCE_B64 = "__READONLY_PROBE_SOURCE_B64__"

_PROBE = None
_HEX64 = re.compile(r"[a-fA-F0-9]{64}\Z")
_PYTHON_BASENAME = re.compile(r"python(?:3(?:\.\d+)?)?\Z")


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
        kind = _string(source.get("kind"), max_length=64)
        if source_id in source_ids or not os.path.isabs(path):
            raise _LaunchError("INVALID_REQUEST")
        source_ids.add(source_id)

    launch = request.get("launch")
    if not isinstance(launch, dict):
        raise _LaunchError("INVALID_REQUEST")
    python_path = _string(launch.get("pythonPath"))
    if not posixpath.isabs(python_path) or not _PYTHON_BASENAME.fullmatch(posixpath.basename(python_path)):
        raise _LaunchError("INVALID_REQUEST")
    entry_path = _string(launch.get("entryPath"))
    if entry_path not in entry_paths:
        raise _LaunchError("INVALID_REQUEST")
    cwd = _string(launch.get("cwd"))
    arguments = _string(launch.get("arguments"), allow_empty=True, max_length=MAX_ARGUMENTS_CHARS)
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

    gpu_devices = request.get("gpuDevices")
    if not isinstance(gpu_devices, list) or not gpu_devices or len(gpu_devices) > 64:
        raise _LaunchError("INVALID_REQUEST")
    uuids = []
    seen_uuids = set()
    for device in gpu_devices:
        if not isinstance(device, dict):
            raise _LaunchError("INVALID_REQUEST")
        _string(device.get("deviceId"), max_length=256)
        gpu_uuid = _string(device.get("uuid"), max_length=256)
        if (not re.fullmatch(r"GPU-[A-Za-z0-9._:-]+\Z", gpu_uuid)
                or gpu_uuid in seen_uuids or any(character.isspace() for character in gpu_uuid)):
            raise _LaunchError("INVALID_REQUEST")
        seen_uuids.add(gpu_uuid)
        uuids.append(gpu_uuid)

    max_utilization = _number(request.get("maxUtilizationPercent"), low=0.0, high=100.0)
    max_memory_mib = _number(request.get("maxMemoryMiB"), low=0.0, high=None)
    if "minFreeMemoryMiB" in request:
        _number(request["minFreeMemoryMiB"], low=1, high=1048576)
    if "minFreeDiskMiB" in request:
        _number(request["minFreeDiskMiB"], low=0, high=1073741824)
    sharing = request.get("gpuSharing")
    if sharing is not None:
        if (not isinstance(sharing, dict) or set(sharing) != {"groupId", "maxDevices", "maxWorkersPerDevice"}
                or not isinstance(sharing["groupId"], str) or not re.fullmatch(r"[A-Za-z0-9_-]{1,128}", sharing["groupId"])
                or type(sharing["maxDevices"]) is not int or not 1 <= sharing["maxDevices"] <= 64
                or type(sharing["maxWorkersPerDevice"]) is not int or not 1 <= sharing["maxWorkersPerDevice"] <= 16
                or not request.get("minFreeMemoryMiB") or len(uuids) != 1):
            raise _LaunchError("INVALID_REQUEST")
    normalized = dict(request)
    normalized.update({
        "armId": arm_id,
        "taskId": task_id,
        "configHash": config_hash,
        "hostAllowedRoots": host_roots,
        "taskAllowedDirectories": task_directories,
        "entryPaths": entry_paths,
        "sources": sources,
        "launch": dict(launch, pythonPath=python_path, entryPath=entry_path, cwd=cwd,
                       arguments=arguments, logSourceId=log_source_id),
        "gpuDevices": gpu_devices,
        "maxUtilizationPercent": max_utilization,
        "maxMemoryMiB": max_memory_mib,
        "_arguments": arguments_parsed,
        "_logPath": matching_logs[0]["path"],
        "_gpuUuids": uuids,
    })
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

    canonical_entries = []
    raw_entry = request["launch"]["entryPath"]
    for entry in request["entryPaths"]:
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
    for path in (cwd, script, log_parent):
        if not probe._path_in_scope(os.path.realpath(path), hosts, tasks):
            raise _LaunchError("PATH_OUTSIDE_ALLOWED_ROOT")
    return hosts, tasks, cwd, script, log_path


def _state_directory(host_root):
    state_path = os.path.join(host_root, STATE_DIRECTORY)
    try:
        before = os.lstat(state_path)
    except FileNotFoundError:
        try:
            os.mkdir(state_path, 0o700)
            os.chmod(state_path, 0o700)
        except OSError as exc:
            raise _LaunchError("STATE_DIRECTORY_INVALID") from exc
        before = os.lstat(state_path)
    except OSError as exc:
        raise _LaunchError("STATE_DIRECTORY_INVALID") from exc
    if stat.S_ISLNK(before.st_mode) or not stat.S_ISDIR(before.st_mode):
        raise _LaunchError("STATE_DIRECTORY_INVALID")
    if before.st_uid != _current_uid() or stat.S_IMODE(before.st_mode) != 0o700:
        raise _LaunchError("STATE_DIRECTORY_INVALID")
    resolved = os.path.realpath(state_path)
    if os.path.dirname(resolved) != os.path.realpath(host_root):
        raise _LaunchError("STATE_DIRECTORY_INVALID")
    after = os.lstat(state_path)
    if (before.st_dev, before.st_ino) != (after.st_dev, after.st_ino):
        raise _LaunchError("STATE_DIRECTORY_INVALID")
    return state_path


def _attempt_key(task_id, arm_id):
    digest_input = (task_id + "\0" + arm_id).encode("utf-8")
    return hashlib.sha256(digest_input).hexdigest()


def _attempt_paths(state_directory, task_id, arm_id):
    key = _attempt_key(task_id, arm_id)
    return (os.path.join(state_directory, ".claim-" + key),
            os.path.join(state_directory, ".receipt-" + key))


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
    body = json.dumps({
        "version": VERSION,
        "configHash": config_hash,
        "result": safe_result,
    }, separators=(",", ":"), ensure_ascii=True).encode("ascii")
    key = os.path.basename(receipt_path)
    temporary = os.path.join(state_directory, key + ".tmp-" + str(os.getpid()) + "-" + str(time.time_ns()))
    flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_CLOEXEC", 0)
    if hasattr(os, "O_NOFOLLOW"):
        flags |= os.O_NOFOLLOW
    fd = None
    try:
        fd = os.open(temporary, flags, 0o600)
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or info.st_uid != _current_uid():
            raise OSError("receipt identity")
        _write_all(fd, body)
        os.fsync(fd)
        os.close(fd)
        fd = None
        os.replace(temporary, receipt_path)
        _fsync_directory(state_directory)
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
        except FileNotFoundError:
            pass
        except OSError:
            pass


def _lock_filename(gpu_uuid):
    digest = hashlib.sha256(gpu_uuid.encode("utf-8")).hexdigest()
    return ".gpu-" + digest + ".lock"


def _acquire_gpu_locks(state_directory, gpu_uuids, *, shared=False):
    lock_module = _require_fcntl()
    handles = []
    try:
        for gpu_uuid in sorted(gpu_uuids, key=lambda item: hashlib.sha256(item.encode("utf-8")).hexdigest()):
            path = os.path.join(state_directory, _lock_filename(gpu_uuid))
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


def _close_gpu_locks(handles):
    for fd, lock_module in reversed(handles or []):
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


def _sharing_occupancy(state_directory, sharing):
    """Live inherited flocks are authoritative; stale files consume no slots."""
    locks = _require_fcntl()
    prefix = _sharing_prefix(sharing) + "-"
    occupied = {}
    for name in os.listdir(state_directory):
        if not name.startswith(prefix) or not name.endswith(".slot"):
            continue
        fd = _sharing_lock(state_directory, name)
        try:
            try:
                locks.flock(fd, locks.LOCK_EX | locks.LOCK_NB)
            except BlockingIOError:
                try:
                    data = json.loads(os.read(fd, 32768).decode())
                except ValueError:
                    data = {}
                ready = False
                try:
                    with open(data["statusPath"], encoding="utf-8") as stream:
                        status_data = json.load(stream)
                    ready = status_data.get("pid") == data.get("pid") and status_data.get("status") in {"running", "worker_finished", "completed"}
                except (OSError, ValueError, KeyError):
                    pass
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
        for slot in range(sharing["maxWorkersPerDevice"]):
            name = _sharing_prefix(sharing) + "-" + gpu_hash + "-" + str(slot) + ".slot"
            if name in used:
                continue
            fd = _sharing_lock(state_directory, name)
            try:
                locks.flock(fd, locks.LOCK_EX | locks.LOCK_NB)
                data = {"gpuUuid": gpu_uuid, "pid": None, "statusPath": next(s["path"] for s in request["sources"] if s["kind"] == "status_json")}
                os.ftruncate(fd, 0)
                os.write(fd, json.dumps(data).encode())
                request["_sharingSlotPath"] = os.path.join(state_directory, name)
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
        if any(value is not None and value.upper() in {"N/A", "[N/A]", "UNKNOWN", "NOT SUPPORTED"} for value in metrics):
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
    scan = probe.scan_registered_processes("/proc", boot, {
        "hostAllowedRoots": hosts,
        "allowedDirectories": tasks,
        "entryPaths": [
            os.path.realpath(entry if os.path.isabs(entry) else os.path.join(tasks[0], entry))
            for entry in request["entryPaths"]
        ],
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


def _spawn_process(request, script, cwd, log_fd, boot, gpu_lock_fds):
    process_env = dict(os.environ)
    # The training process outlives the waiter's tmux pane and must not inherit
    # that pane as the default target for its own later tmux commands.
    process_env.pop("TMUX", None)
    process_env.pop("TMUX_PANE", None)
    process_env["CUDA_VISIBLE_DEVICES"] = ",".join(request["_gpuUuids"])
    log_stream = os.fdopen(log_fd, "ab", buffering=0, closefd=True)
    try:
        child = subprocess.Popen(
            [request["launch"]["pythonPath"], "-u", script, *request["_arguments"]],
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
    if request.get("_sharingSlotPath"):
        with open(request["_sharingSlotPath"], "r+", encoding="utf-8") as stream:
            data = json.load(stream)
            data["pid"] = pid
            stream.seek(0)
            json.dump(data, stream)
            stream.truncate()
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
        state_directory = _state_directory(canonical_hosts[0])

        existing = _inspect_existing_attempt(
            state_directory, normalized["taskId"], normalized["armId"], normalized["configHash"])
        if existing is not None:
            return existing

        hosts, tasks, cwd, script, log_path = _canonical_scope(normalized, probe)
        if not _output_disk_ready(normalized) or not _gpus_idle(probe, normalized):
            return _busy()

        try:
            locks = (_acquire_shared_gpu_locks(state_directory, normalized) if normalized.get("gpuSharing")
                     else _acquire_gpu_locks(state_directory, normalized["_gpuUuids"]))
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
                    [fd for fd, _lock_module in locks])
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


def _emit_frame(envelope):
    payload = json.dumps(envelope, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
    if len(payload) > MAX_RESPONSE_BYTES:
        payload = json.dumps({
            "version": VERSION,
            "requestId": envelope.get("requestId"),
            "sourceId": None,
            "payload": _failed("RESPONSE_LIMIT"),
        }, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
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
