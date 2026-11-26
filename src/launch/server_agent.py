#!/usr/bin/python3
"""Remote-only tmux waiter for monitoring all GPUs before one-card launch."""

import base64
import csv
import copy
import datetime
import errno
import hashlib
import io
import json
import math
import os
import re
import shutil
import stat
import subprocess
import sys
import time
import types
import uuid


VERSION = 1
MAX_REQUEST_BYTES = 2 * 1024 * 1024
MAX_SOURCE_BYTES = 4 * 1024 * 1024
MAX_GPU_CSV_BYTES = 16 * 1024
MAX_JOB_FILES = 256
IDLE_GAP_SECONDS = 15
POLL_SECONDS = 5
STATE_DIRECTORY = ".training-monitor-autostart"
REQUEST_B64 = "__MONITOR_REQUEST_B64__"
LAUNCHER_SOURCE_B64 = "__LAUNCHER_SOURCE_B64__"
AGENT_SOURCE_B64 = "__SERVER_AGENT_SOURCE_B64__"

_HEX64 = re.compile(r"[a-f0-9]{64}\Z")
_GPU_UUID = re.compile(r"GPU-[A-Za-z0-9._:-]+\Z")
_ERROR_CODE = re.compile(r"[A-Z0-9_]{1,128}\Z")
_DEVICE_ID = re.compile(r"GPU (?:0|[1-9][0-9]{0,3})\Z")
_ACTIVE_STATES = {"waiting", "countdown", "blocked", "starting"}
_TERMINAL_STATES = {"started", "failed", "cancelled"}
_ALL_STATES = _ACTIVE_STATES | _TERMINAL_STATES | {"missing"}


class _AgentError(Exception):
    def __init__(self, error_code, message=None):
        super().__init__(error_code)
        self.error_code = error_code
        self.message = message


def _monotonic():
    return time.monotonic()


def _wall_now():
    return datetime.datetime.now(datetime.timezone.utc)


def _iso_now():
    return _wall_now().isoformat(timespec="seconds").replace("+00:00", "Z")


def _sleep(seconds):
    time.sleep(seconds)


def _valid_iso(value):
    if not isinstance(value, str):
        return False
    try:
        datetime.datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return False
    return True


def _mode_matches(info, expected):
    # Windows does not expose POSIX mode bits through stat; the remote target is Linux.
    return os.name == "nt" or stat.S_IMODE(info.st_mode) == expected


def _job_key(task_id, arm_id):
    return hashlib.sha256((task_id + "\0" + arm_id).encode("utf-8")).hexdigest()


def _session_name(job_key):
    return "tm-wait-" + job_key[:40]


def _task_digest(task_id):
    return hashlib.sha256(task_id.encode("utf-8")).hexdigest()


def _job_path(state_root, job_key):
    return os.path.join(state_root, ".server-wait-" + job_key + ".json")


def _control_lock_path(state_root, task_id):
    return os.path.join(state_root, ".server-control-" + _task_digest(task_id) + ".lock")


def _lifetime_lock_path(state_root, job_key):
    return os.path.join(state_root, ".server-lifetime-" + job_key + ".lock")


def _worker_source_name(source):
    digest = hashlib.sha256(source).hexdigest()
    return ".server-worker-v1-" + digest + ".py"


def _strict_string(value, *, nonempty=True, maximum=8192):
    if not isinstance(value, str) or "\0" in value or len(value) > maximum:
        raise _AgentError("INVALID_REQUEST")
    if nonempty and not value:
        raise _AgentError("INVALID_REQUEST")
    return value


def _strict_string_list(value, *, nonempty=False, maximum_items=256):
    if not isinstance(value, list) or len(value) > maximum_items or (nonempty and not value):
        raise _AgentError("INVALID_REQUEST")
    return [_strict_string(item) for item in value]


def _normalize_common(request):
    if not isinstance(request, dict):
        raise _AgentError("INVALID_REQUEST")
    if type(request.get("version")) is not int or request["version"] != VERSION:
        raise _AgentError("INVALID_REQUEST")
    _strict_string(request.get("requestId"))
    if request.get("sourceId") is not None:
        raise _AgentError("INVALID_REQUEST")
    arm_id = _strict_string(request.get("armId"), maximum=128)
    try:
        arm_id = str(__import__("uuid").UUID(arm_id))
    except (ValueError, AttributeError) as exc:
        raise _AgentError("INVALID_REQUEST") from exc
    task_id = _strict_string(request.get("taskId"), maximum=1024)
    config_hash = _strict_string(request.get("configHash"), maximum=64).lower()
    if not _HEX64.fullmatch(config_hash):
        raise _AgentError("INVALID_REQUEST")
    host_roots = _strict_string_list(request.get("hostAllowedRoots"), nonempty=True)
    task_directories = _strict_string_list(request.get("taskAllowedDirectories"), nonempty=True)
    if any(not os.path.isabs(path) for path in host_roots + task_directories):
        raise _AgentError("INVALID_REQUEST")
    return {
        "armId": arm_id,
        "taskId": task_id,
        "configHash": config_hash,
        "hostAllowedRoots": host_roots,
        "taskAllowedDirectories": task_directories,
    }


def _validate_manager_request(request):
    common = _normalize_common(request)
    operation = request.get("op")
    if operation == "ensure_server_wait":
        idle_seconds = request.get("idleSeconds")
        if type(idle_seconds) is not int or not 1 <= idle_seconds <= 86400:
            raise _AgentError("INVALID_REQUEST")
        launch_request = request.get("launchRequest")
        if not isinstance(launch_request, dict):
            raise _AgentError("INVALID_REQUEST")
        common["idleSeconds"] = idle_seconds
        common["launchRequest"] = launch_request
        retry_on_exit = request.get("retryOnExit", False)
        if type(retry_on_exit) is not bool:
            raise _AgentError("INVALID_REQUEST")
        if retry_on_exit and not any(source.get("kind") == "status_json" for source in launch_request.get("sources", [])):
            raise _AgentError("INVALID_REQUEST")
        common["retryOnExit"] = retry_on_exit
    elif operation in {"get_server_wait", "cancel_server_wait"}:
        if "launchRequest" in request or "idleSeconds" in request:
            raise _AgentError("INVALID_REQUEST")
    else:
        raise _AgentError("REQUEST_OP_UNSUPPORTED")
    common["op"] = operation
    common["requestId"] = request["requestId"]
    return common


def _load_launcher(source_b64):
    if source_b64 == "__LAUNCHER_SOURCE_B64__":
        raise _AgentError("LAUNCHER_SOURCE_MISSING")
    try:
        source = base64.b64decode(source_b64, validate=True)
        if not source or len(source) > MAX_SOURCE_BYTES:
            raise ValueError("launcher source size")
        namespace = {
            "__name__": "training_monitor_server_launcher",
            "__file__": "<server-launcher>",
        }
        exec(compile(source, "<server-launcher>", "exec"), namespace)
        required = (
            "_LaunchError",
            "_already_running",
            "_attempt_paths",
            "_canonical_scope",
            "_current_uid",
            "_fsync_directory",
            "_inspect_existing_attempt",
            "_require_fcntl",
            "_scan_for_registered_process",
            "_state_directory",
            "_validate_request",
            "launch_task",
        )
        if any(name not in namespace for name in required):
            raise ValueError("launcher interface")
        return types.SimpleNamespace(**namespace)
    except _AgentError:
        raise
    except Exception as exc:
        raise _AgentError("LAUNCHER_SOURCE_INVALID") from exc


def _load_worker_source(source_b64):
    if source_b64 == "__SERVER_AGENT_SOURCE_B64__":
        raise _AgentError("SERVER_AGENT_SOURCE_MISSING")
    try:
        source = base64.b64decode(source_b64, validate=True)
        if not source or len(source) > MAX_SOURCE_BYTES:
            raise ValueError("worker source size")
        return source
    except (ValueError, TypeError) as exc:
        raise _AgentError("SERVER_AGENT_SOURCE_INVALID") from exc


def _canonical_roots(launcher, host_roots, task_directories):
    try:
        probe = launcher._probe()
        hosts, tasks = probe._canonical_task_roots(host_roots, task_directories)
    except launcher._LaunchError as exc:
        raise _AgentError(exc.error_code) from exc
    except _AgentError:
        raise
    except Exception as exc:
        raise _AgentError("PROBE_SOURCE_INVALID") from exc
    if not hosts or not tasks:
        raise _AgentError("PATH_OUTSIDE_ALLOWED_ROOT")
    return hosts, tasks


def _validate_launch_request(launcher, common):
    launch_request = common["launchRequest"]
    if launch_request.get("version") != VERSION or launch_request.get("sourceId") is not None:
        raise _AgentError("INVALID_REQUEST")
    if launch_request.get("op") != "launch_task":
        raise _AgentError("INVALID_REQUEST")
    if launch_request.get("gpuDevices") != []:
        raise _AgentError("INVALID_REQUEST")
    for field in (
        "armId",
        "taskId",
        "configHash",
        "hostAllowedRoots",
        "taskAllowedDirectories",
    ):
        expected = common[field]
        actual = launch_request.get(field)
        if field == "configHash" and isinstance(actual, str):
            actual = actual.lower()
        if actual != expected:
            raise _AgentError("INVALID_REQUEST")

    candidate = copy.deepcopy(launch_request)
    candidate["gpuDevices"] = [{"deviceId": "GPU 0", "uuid": "GPU-server-waiter"}]
    try:
        normalized = launcher._validate_request(candidate)
        launcher._canonical_scope(normalized, launcher._probe())
    except launcher._LaunchError as exc:
        raise _AgentError(exc.error_code) from exc
    except _AgentError:
        raise
    except Exception as exc:
        raise _AgentError("LAUNCH_REQUEST_INVALID") from exc
    normalized_request = copy.deepcopy(launch_request)
    normalized_request.update({
        "armId": common["armId"],
        "taskId": common["taskId"],
        "configHash": common["configHash"],
        "hostAllowedRoots": common["hostAllowedRoots"],
        "taskAllowedDirectories": common["taskAllowedDirectories"],
    })
    return normalized_request


def _check_tmux():
    executable = shutil.which("tmux") or "/usr/bin/tmux"
    try:
        result = subprocess.run(
            [executable, "-V"],
            shell=False,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            timeout=2,
            check=False,
        )
    except (OSError, subprocess.TimeoutExpired) as exc:
        raise _AgentError("TMUX_UNAVAILABLE") from exc
    if result.returncode != 0:
        raise _AgentError("TMUX_UNAVAILABLE")
    output = result.stdout.decode("utf-8", "replace").strip()
    match = re.fullmatch(r"tmux ([0-9]+)\.([0-9]+)[A-Za-z]?", output)
    if not match or (int(match.group(1)), int(match.group(2))) < (2, 1):
        raise _AgentError("TMUX_UNAVAILABLE")
    return executable


def _tmux_base(executable, uid, state_root=None):
    if state_root is not None:
        # Keep the socket on the same writable filesystem as the waiter state.
        return [executable, "-S", os.path.join(state_root, "tmux.sock"), "-f", "/dev/null"]
    return [executable, "-L", "training-monitor-" + str(uid), "-f", "/dev/null"]


def _session_exists(executable, uid, session_name, state_root=None):
    command = _tmux_base(executable, uid, state_root) + ["has-session", "-t", "=" + session_name]
    try:
        result = subprocess.run(
            command,
            shell=False,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            timeout=2,
            check=False,
        )
    except (OSError, subprocess.TimeoutExpired) as exc:
        raise _AgentError("TMUX_UNAVAILABLE") from exc
    if result.returncode == 0:
        return True
    if result.returncode == 1:
        return False
    raise _AgentError("TMUX_UNAVAILABLE")


def _new_session(executable, uid, session_name, worker_script, job_key, state_root):
    command = _tmux_base(executable, uid, state_root) + [
        "new-session",
        "-d",
        "-s",
        session_name,
        "--",
        "/usr/bin/python3",
        "-I",
        "-S",
        "-B",
        worker_script,
        "--worker",
        job_key,
        state_root,
    ]
    try:
        result = subprocess.run(
            command,
            shell=False,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            timeout=5,
            check=False,
        )
    except (OSError, subprocess.TimeoutExpired) as exc:
        raise _AgentError("SERVER_WAITER_START_FAILED") from exc
    if result.returncode != 0:
        raise _AgentError("SERVER_WAITER_START_FAILED")


def _secure_regular(path, launcher, *, exact_mode=None):
    try:
        info = os.stat(path, follow_symlinks=False)
    except FileNotFoundError:
        return None
    except OSError as exc:
        raise _AgentError("STATE_FILE_INVALID") from exc
    if (stat.S_ISLNK(info.st_mode) or not stat.S_ISREG(info.st_mode)
            or info.st_uid != launcher._current_uid()):
        raise _AgentError("STATE_FILE_INVALID")
    if exact_mode is not None and not _mode_matches(info, exact_mode):
        raise _AgentError("STATE_FILE_INVALID")
    return info


def _read_secure_bytes(path, launcher, maximum):
    if _secure_regular(path, launcher, exact_mode=0o600) is None:
        return None
    flags = os.O_RDONLY | getattr(os, "O_CLOEXEC", 0)
    if hasattr(os, "O_NOFOLLOW"):
        flags |= os.O_NOFOLLOW
    try:
        fd = os.open(path, flags)
    except OSError as exc:
        raise _AgentError("STATE_FILE_INVALID") from exc
    try:
        info = os.fstat(fd)
        if (not stat.S_ISREG(info.st_mode)
                or info.st_uid != launcher._current_uid()
                or not _mode_matches(info, 0o600)):
            raise _AgentError("STATE_FILE_INVALID")
        data = os.read(fd, maximum + 1)
        if len(data) > maximum or os.read(fd, 1):
            raise _AgentError("STATE_FILE_INVALID")
        return data
    except OSError as exc:
        raise _AgentError("STATE_FILE_INVALID") from exc
    finally:
        os.close(fd)


def _read_json(path, launcher):
    raw = _read_secure_bytes(path, launcher, MAX_REQUEST_BYTES)
    if raw is None:
        return None
    try:
        value = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, ValueError, RecursionError) as exc:
        raise _AgentError("STATE_FILE_INVALID") from exc
    if not isinstance(value, dict):
        raise _AgentError("STATE_FILE_INVALID")
    return value


def _write_all(fd, data):
    offset = 0
    while offset < len(data):
        count = os.write(fd, data[offset:])
        if count <= 0:
            raise OSError("short write")
        offset += count


def _atomic_write(path, state_root, data, launcher, *, exclusive=False):
    mode = os.O_WRONLY | os.O_CREAT | getattr(os, "O_CLOEXEC", 0)
    flags = mode | (os.O_EXCL if exclusive else 0)
    if hasattr(os, "O_NOFOLLOW"):
        flags |= os.O_NOFOLLOW
    name = os.path.basename(path)
    temporary = os.path.join(
        state_root,
        name + ".tmp-" + str(os.getpid()) + "-" + str(time.time_ns()),
    )
    temporary_fd = None
    try:
        if not exclusive and _secure_regular(path, launcher, exact_mode=0o600) is None:
            exclusive = True
        temporary_fd = os.open(temporary, mode | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0), 0o600)
        info = os.fstat(temporary_fd)
        if (not stat.S_ISREG(info.st_mode)
                or info.st_uid != launcher._current_uid()
                or not _mode_matches(info, 0o600)):
            raise _AgentError("STATE_WRITE_FAILED")
        _write_all(temporary_fd, data)
        os.fsync(temporary_fd)
        os.close(temporary_fd)
        temporary_fd = None
        if exclusive:
            try:
                os.link(temporary, path)
            except FileExistsError:
                raise
            except OSError:
                # link is unavailable on some filesystems; the locked caller still owns creation.
                os.replace(temporary, path)
            else:
                os.unlink(temporary)
        else:
            os.replace(temporary, path)
        launcher._fsync_directory(state_root)
        return True
    except FileExistsError:
        return False
    except _AgentError:
        raise
    except OSError as exc:
        raise _AgentError("STATE_WRITE_FAILED") from exc
    finally:
        if temporary_fd is not None:
            try:
                os.close(temporary_fd)
            except OSError:
                pass
        try:
            os.unlink(temporary)
        except OSError:
            pass


def _write_json(path, state_root, value, launcher, *, exclusive=False):
    try:
        data = json.dumps(
            value,
            sort_keys=True,
            separators=(",", ":"),
            ensure_ascii=True,
            allow_nan=False,
        ).encode("utf-8")
    except (TypeError, ValueError) as exc:
        raise _AgentError("STATE_WRITE_FAILED") from exc
    return _atomic_write(path, state_root, data, launcher, exclusive=exclusive)


def _write_worker_script(source, state_root, launcher):
    path = os.path.join(state_root, _worker_source_name(source))
    existing = _secure_regular(path, launcher, exact_mode=0o600)
    if existing is not None:
        current = _read_secure_bytes(path, launcher, MAX_SOURCE_BYTES)
        if current != source:
            raise _AgentError("SERVER_AGENT_SOURCE_INVALID")
        return path
    if not _atomic_write(path, state_root, source, launcher, exclusive=True):
        current = _read_secure_bytes(path, launcher, MAX_SOURCE_BYTES)
        if current != source:
            raise _AgentError("SERVER_AGENT_SOURCE_INVALID")
    return path


def _acquire_file_lock(path, launcher, *, nonblocking=False):
    lock_module = launcher._require_fcntl()
    flags = os.O_RDWR | os.O_CREAT | getattr(os, "O_CLOEXEC", 0)
    if hasattr(os, "O_NOFOLLOW"):
        flags |= os.O_NOFOLLOW
    try:
        fd = os.open(path, flags, 0o600)
    except OSError as exc:
        raise _AgentError("CONTROL_LOCK_FAILED") from exc
    try:
        info = os.fstat(fd)
        if (not stat.S_ISREG(info.st_mode)
                or info.st_uid != launcher._current_uid()
                or not _mode_matches(info, 0o600)):
            raise _AgentError("CONTROL_LOCK_FAILED")
        operation = lock_module.LOCK_EX
        if nonblocking:
            operation |= lock_module.LOCK_NB
        try:
            lock_module.flock(fd, operation)
        except (BlockingIOError, PermissionError):
            if nonblocking:
                os.close(fd)
                return None
            raise
        return fd
    except Exception:
        try:
            os.close(fd)
        except OSError:
            pass
        raise


def _release_file_lock(fd):
    if fd is not None:
        try:
            os.close(fd)
        except OSError:
            pass


def _status(
    *,
    state,
    arm_id,
    config_hash,
    idle_elapsed=0,
    required_idle=1,
    last_checked=None,
    started_at=None,
    pid=None,
    error_code=None,
    message=None,
    session_name=None,
    selected_device_id=None,
):
    if state not in _ALL_STATES:
        state = "failed"
        error_code = "STATE_INVALID"
    idle_elapsed = min(86400, max(0, idle_elapsed)) if type(idle_elapsed) is int else 0
    required_idle = min(86400, max(1, required_idle)) if type(required_idle) is int else 1
    message_safe = (
        message
        if isinstance(message, str)
        and len(message) <= 240
        and not any(ord(character) < 32 or ord(character) == 127 for character in message)
        else None
    )
    session_safe = (
        session_name
        if isinstance(session_name, str)
        and re.fullmatch(r"tm-wait-[a-f0-9]{40}", session_name)
        else None
    )
    return {
        "state": state,
        "armId": arm_id,
        "configHash": config_hash,
        "idleElapsedSeconds": idle_elapsed,
        "requiredIdleSeconds": required_idle,
        "lastCheckedAt": last_checked if _valid_iso(last_checked) else None,
        "startedAt": started_at if _valid_iso(started_at) else None,
        "pid": pid if type(pid) is int and pid > 0 else None,
        "errorCode": error_code if isinstance(error_code, str) and _ERROR_CODE.fullmatch(error_code) else None,
        "message": message_safe,
        "sessionName": session_safe,
        "selectedDeviceId": (
            selected_device_id
            if isinstance(selected_device_id, str) and _DEVICE_ID.fullmatch(selected_device_id)
            else None
        ),
    }


def _missing_status(arm_id, config_hash, required_idle=1):
    return _status(
        state="missing",
        arm_id=arm_id,
        config_hash=config_hash,
        required_idle=required_idle,
        message="No server waiter exists for this arm.",
    )


def _record_status(record):
    return _status(
        state=record.get("state"),
        arm_id=record.get("armId"),
        config_hash=record.get("configHash"),
        idle_elapsed=record.get("idleElapsedSeconds"),
        required_idle=record.get("requiredIdleSeconds"),
        last_checked=record.get("lastCheckedAt"),
        started_at=record.get("startedAt"),
        pid=record.get("pid"),
        error_code=record.get("errorCode"),
        message=record.get("message"),
        session_name=record.get("sessionName"),
        selected_device_id=record.get("selectedDeviceId"),
    )


def _base_record(common, launch_request):
    job_key = _job_key(common["taskId"], common["armId"])
    return {
        "version": VERSION,
        "jobKey": job_key,
        "taskId": common["taskId"],
        "armId": common["armId"],
        "configHash": common["configHash"],
        "hostAllowedRoots": common["hostAllowedRoots"],
        "taskAllowedDirectories": common["taskAllowedDirectories"],
        "idleSeconds": common["idleSeconds"],
        "requiredIdleSeconds": common["idleSeconds"],
        "launchRequest": launch_request,
        "retryOnExit": common.get("retryOnExit", False),
        "attemptArmId": common["armId"],
        "processKey": None,
        "retryFinished": False,
        "state": "waiting",
        "idleElapsedSeconds": 0,
        "lastCheckedAt": None,
        "startedAt": None,
        "pid": None,
        "errorCode": None,
        "message": None,
        "sessionName": _session_name(job_key),
        "selectedDeviceId": None,
    }


def _validate_record(record, *, job_key=None):
    if not isinstance(record, dict) or record.get("version") != VERSION:
        raise _AgentError("STATE_FILE_INVALID")
    if record.get("state") not in _ALL_STATES - {"missing"}:
        raise _AgentError("STATE_FILE_INVALID")
    if record.get("jobKey") != _job_key(record.get("taskId"), record.get("armId")):
        raise _AgentError("STATE_FILE_INVALID")
    if job_key is not None and record.get("jobKey") != job_key:
        raise _AgentError("STATE_FILE_INVALID")
    if record.get("sessionName") != _session_name(record["jobKey"]):
        raise _AgentError("STATE_FILE_INVALID")
    if not _HEX64.fullmatch(str(record.get("configHash", ""))):
        raise _AgentError("STATE_FILE_INVALID")
    if type(record.get("requiredIdleSeconds")) is not int or not 1 <= record["requiredIdleSeconds"] <= 86400:
        raise _AgentError("STATE_FILE_INVALID")
    if not isinstance(record.get("launchRequest"), dict):
        raise _AgentError("STATE_FILE_INVALID")
    return record


def _matching_records(state_root, launcher, task_id):
    try:
        names = os.listdir(state_root)
    except OSError as exc:
        raise _AgentError("STATE_DIRECTORY_INVALID") from exc
    candidates = sorted(name for name in names if re.fullmatch(r"\.server-wait-[a-f0-9]{64}\.json", name))
    if len(candidates) > MAX_JOB_FILES:
        raise _AgentError("STATE_FILE_LIMIT")
    records = []
    for name in candidates:
        record = _read_json(os.path.join(state_root, name), launcher)
        if record is not None:
            _validate_record(record)
            if record.get("taskId") == task_id:
                records.append(record)
    return records


def _set_terminal(record, state, *, error_code, message):
    record["state"] = state
    record["errorCode"] = error_code
    record["message"] = message
    record["idleElapsedSeconds"] = 0
    record["selectedDeviceId"] = None


def _active_record_for_task(state_root, launcher, task_id):
    active = []
    for record in _matching_records(state_root, launcher, task_id):
        if record["state"] in _ACTIVE_STATES or _watching_process(record):
            active.append(record)
    if len(active) > 1:
        raise _AgentError("STATE_FILE_INVALID")
    return active[0] if active else None


def _refresh_lost_session(
    record,
    path,
    state_root,
    launcher,
    *,
    tmux_executable=None,
):
    if record["state"] not in _ACTIVE_STATES and not _watching_process(record):
        return False
    if tmux_executable is None:
        tmux_executable = _check_tmux()
    uid = launcher._current_uid()
    if _session_exists(tmux_executable, uid, record["sessionName"], state_root):
        return False
    _set_terminal(
        record,
        "failed",
        error_code="SERVER_WAITER_LOST",
        message="The dedicated tmux waiter session is missing.",
    )
    _write_json(path, state_root, record, launcher)
    return True


def _existing_server_wait_status(
    common,
    state_root,
    launcher,
    *,
    tmux_executable=None,
):
    job_key = _job_key(common["taskId"], common["armId"])
    path = _job_path(state_root, job_key)
    record = _read_json(path, launcher)
    if record is None:
        return None
    _validate_record(record, job_key=job_key)
    if record["configHash"] != common["configHash"]:
        return _status(
            state="failed",
            arm_id=common["armId"],
            config_hash=common["configHash"],
            required_idle=record["requiredIdleSeconds"],
            error_code="CONFIG_CHANGED",
            message="The arm is registered with a different configuration.",
        )
    if record["state"] not in _TERMINAL_STATES or _watching_process(record):
        _refresh_lost_session(
            record,
            path,
            state_root,
            launcher,
            tmux_executable=tmux_executable,
        )
    return _record_status(record)


def _state_directory(host_root, launcher, *, create):
    state_root = os.path.join(host_root, STATE_DIRECTORY)
    if not create:
        try:
            info = os.lstat(state_root)
        except FileNotFoundError:
            return None
        except OSError as exc:
            raise _AgentError("STATE_DIRECTORY_INVALID") from exc
        if (stat.S_ISLNK(info.st_mode) or not stat.S_ISDIR(info.st_mode)
                or info.st_uid != launcher._current_uid()
                or not _mode_matches(info, 0o700)):
            raise _AgentError("STATE_DIRECTORY_INVALID")
        if os.path.dirname(os.path.realpath(state_root)) != os.path.realpath(host_root):
            raise _AgentError("STATE_DIRECTORY_INVALID")
        return state_root
    try:
        return launcher._state_directory(host_root)
    except launcher._LaunchError as exc:
        raise _AgentError(exc.error_code) from exc


def ensure_server_wait(request, launcher, *, tmux_executable=None, worker_source=None):
    common = _validate_manager_request(request)
    hosts, _tasks = _canonical_roots(
        launcher, common["hostAllowedRoots"], common["taskAllowedDirectories"])

    # Durable terminal and active arm status must remain readable after registered
    # paths disappear. Reconcile an existing state root before launcher validation.
    state_root = _state_directory(hosts[0], launcher, create=False)
    if state_root is not None:
        control_fd = _acquire_file_lock(
            _control_lock_path(state_root, common["taskId"]), launcher)
        try:
            existing_status = _existing_server_wait_status(
                common,
                state_root,
                launcher,
                tmux_executable=tmux_executable,
            )
            if existing_status is not None and not _can_restore_waiter(common, existing_status):
                return existing_status
        finally:
            _release_file_lock(control_fd)

    launch_request = _validate_launch_request(launcher, common)
    executable = tmux_executable or _check_tmux()
    state_root = _state_directory(hosts[0], launcher, create=True)
    if worker_source is None:
        worker_source = _load_worker_source(AGENT_SOURCE_B64)
    control_fd = _acquire_file_lock(_control_lock_path(state_root, common["taskId"]), launcher)
    try:
        job_key = _job_key(common["taskId"], common["armId"])
        path = _job_path(state_root, job_key)
        existing_status = _existing_server_wait_status(
            common,
            state_root,
            launcher,
            tmux_executable=executable,
        )
        if existing_status is not None and not _can_restore_waiter(common, existing_status):
            return existing_status

        active = _active_record_for_task(state_root, launcher, common["taskId"])
        if active is not None:
            return _status(
                state="blocked",
                arm_id=common["armId"],
                config_hash=common["configHash"],
                required_idle=common["idleSeconds"],
                error_code="ACTIVE_SERVER_WAIT_EXISTS",
                message="Another server waiter arm is active for this task.",
            )

        worker_script = _write_worker_script(worker_source, state_root, launcher)
        record = _base_record(common, launch_request)
        restoring = existing_status is not None
        if restoring:
            previous = _read_json(path, launcher)
            record["retryCount"] = previous.get("retryCount", 0)
            # The original launch attempt may already have a receipt.
            record["attemptArmId"] = str(uuid.uuid4())
        if not _write_json(path, state_root, record, launcher, exclusive=not restoring):
            raise _AgentError("STATE_FILE_EXISTS")
        try:
            _new_session(
                executable,
                launcher._current_uid(),
                record["sessionName"],
                worker_script,
                job_key,
                state_root,
            )
        except _AgentError as exc:
            _set_terminal(
                record,
                "failed",
                error_code=exc.error_code,
                message="The dedicated tmux waiter could not be started.",
            )
            _write_json(path, state_root, record, launcher)
            return _record_status(record)
        record["lastCheckedAt"] = _iso_now()
        record["message"] = "Waiting for one GPU to remain continuously idle."
        _write_json(path, state_root, record, launcher)
        return _record_status(record)
    except launcher._LaunchError as exc:
        raise _AgentError(exc.error_code) from exc
    finally:
        _release_file_lock(control_fd)


def _can_restore_waiter(common, status):
    return common.get("retryOnExit") is True and status.get("errorCode") == "SERVER_WAITER_LOST"


def get_server_wait(request, launcher, *, tmux_executable=None):
    common = _validate_manager_request(request)
    task_id = common["taskId"]
    hosts, _tasks = _canonical_roots(
        launcher, common["hostAllowedRoots"], common["taskAllowedDirectories"])
    state_root = _state_directory(hosts[0], launcher, create=False)
    if state_root is None:
        return _missing_status(common["armId"], common["configHash"])
    control_fd = _acquire_file_lock(_control_lock_path(state_root, task_id), launcher)
    try:
        job_key = _job_key(task_id, common["armId"])
        path = _job_path(state_root, job_key)
        record = _read_json(path, launcher)
        if record is None:
            return _missing_status(common["armId"], common["configHash"])
        _validate_record(record, job_key=job_key)
        if record["taskId"] != task_id:
            raise _AgentError("STATE_FILE_INVALID")
        if record["configHash"] != common["configHash"]:
            return _status(
                state="failed",
                arm_id=common["armId"],
                config_hash=common["configHash"],
                required_idle=record["requiredIdleSeconds"],
                error_code="CONFIG_CHANGED",
                message="The arm is registered with a different configuration.",
            )
        _refresh_lost_session(
            record, path, state_root, launcher, tmux_executable=tmux_executable)
        return _record_status(record)
    finally:
        _release_file_lock(control_fd)


def _reconcile_starting(record, state_root, launcher):
    try:
        receipt = launcher._inspect_existing_attempt(
            state_root,
            record["taskId"],
            record.get("attemptArmId", record["armId"]),
            record["configHash"],
        )
    except launcher._LaunchError as exc:
        if exc.error_code == "UNKNOWN_LAUNCH_RESULT":
            _set_terminal(
                record,
                "failed",
                error_code="UNKNOWN_LAUNCH_RESULT",
                message="The launch receipt is incomplete.",
            )
            return True
        return False
    if receipt is None:
        return False
    if receipt.get("status") == "started":
        record["state"] = "started"
        record["pid"] = receipt.get("pid")
        record["startedAt"] = receipt.get("startedAt")
        record["processKey"] = receipt.get("processKey")
        record["errorCode"] = None
        record["message"] = "The registered task was started."
        return True
    if receipt.get("status") == "failed":
        _set_terminal(
            record,
            "failed",
            error_code=receipt.get("errorCode") or "UNKNOWN_LAUNCH_RESULT",
            message="The registered task launch failed.",
        )
        return True
    return False


def cancel_server_wait(request, launcher):
    common = _validate_manager_request(request)
    hosts, _tasks = _canonical_roots(
        launcher, common["hostAllowedRoots"], common["taskAllowedDirectories"])
    state_root = _state_directory(hosts[0], launcher, create=False)
    if state_root is None:
        return _missing_status(common["armId"], common["configHash"])
    control_fd = _acquire_file_lock(_control_lock_path(state_root, common["taskId"]), launcher)
    try:
        job_key = _job_key(common["taskId"], common["armId"])
        path = _job_path(state_root, job_key)
        record = _read_json(path, launcher)
        if record is None:
            return _missing_status(common["armId"], common["configHash"])
        _validate_record(record, job_key=job_key)
        if record["configHash"] != common["configHash"]:
            return _status(
                state="failed",
                arm_id=common["armId"],
                config_hash=common["configHash"],
                required_idle=record["requiredIdleSeconds"],
                error_code="CONFIG_CHANGED",
                message="The arm is registered with a different configuration.",
            )
        if record["state"] == "started" and not record.get("retryOnExit"):
            return _record_status(record)
        if record["state"] == "cancelled":
            return _record_status(record)
        if record["state"] == "starting":
            if _reconcile_starting(record, state_root, launcher):
                _write_json(path, state_root, record, launcher)
                if record["state"] == "started" and not record.get("retryOnExit"):
                    return _record_status(record)
        _set_terminal(
            record,
            "cancelled",
            error_code=None,
            message="Automatic waiting was cancelled; running task processes were left unchanged.",
        )
        record["lastCheckedAt"] = _iso_now()
        _write_json(path, state_root, record, launcher)
        return _record_status(record)
    finally:
        _release_file_lock(control_fd)


def _gpu_number(text):
    if not isinstance(text, str) or not text.isdecimal():
        return None
    value = int(text)
    return value if 0 <= value <= 4095 else None


def _gpu_metric(text):
    if not isinstance(text, str):
        return None
    normalized = text.strip()
    if not normalized or normalized.upper() in {
        "N/A",
        "[N/A]",
        "NA",
        "UNKNOWN",
        "NOT SUPPORTED",
    }:
        return None
    try:
        value = float(normalized)
    except ValueError:
        return None
    if not math.isfinite(value) or value < 0:
        return None
    return value


def _parse_gpu_csv(csv_text, max_utilization, max_memory_mib, min_free_memory_mib=None):
    if not isinstance(csv_text, str) or len(csv_text) > MAX_GPU_CSV_BYTES:
        return None
    devices = {}
    seen_indexes = set()
    try:
        rows = csv.reader(io.StringIO(csv_text, newline=""))
        for row in rows:
            if not row or all(not value.strip() for value in row):
                continue
            if len(row) != (6 if min_free_memory_mib else 5):
                return None
            index = _gpu_number(row[0].strip())
            gpu_uuid = row[1].strip()
            utilization = _gpu_metric(row[2])
            used = _gpu_metric(row[3])
            total = _gpu_metric(row[4])
            free = _gpu_metric(row[5]) if min_free_memory_mib else None
            if (index is None or not _GPU_UUID.fullmatch(gpu_uuid)
                    or gpu_uuid in devices or index in seen_indexes):
                return None
            seen_indexes.add(index)
            unavailable = (
                utilization is None
                or used is None
                or total is None
                or utilization > 100
                or total <= 0
                or used > total
                or (min_free_memory_mib is not None and free is None)
            )
            devices[gpu_uuid] = {
                "uuid": gpu_uuid,
                "index": index,
                "deviceId": "GPU " + str(index),
                "unavailable": unavailable,
                "idle": (
                    not unavailable
                    and utilization <= max_utilization
                    and (free >= min_free_memory_mib if min_free_memory_mib else used <= max_memory_mib)
                ),
            }
    except (csv.Error, UnicodeError, ValueError):
        return None
    return devices if devices else None


def _new_idle_state():
    return {"idleSince": {}, "indexes": {}, "lastSample": None, "lastCheckedAt": None}


def _reset_idle_state(idle_state, now):
    idle_state["idleSince"] = {}
    idle_state["indexes"] = {}
    idle_state["lastSample"] = now


def _update_idle_timers(csv_text, max_utilization, max_memory_mib, now, idle_state, min_free_memory_mib=None):
    devices = _parse_gpu_csv(csv_text, max_utilization, max_memory_mib, min_free_memory_mib)
    prior_sample = idle_state.get("lastSample")
    if devices is None or (
        prior_sample is not None
        and (now - prior_sample <= 0 or now - prior_sample > IDLE_GAP_SECONDS)
    ):
        _reset_idle_state(idle_state, now if devices is not None else None)
        if devices is None:
            idle_state["lastCheckedAt"] = _iso_now()
            return []

    current_uuids = set(devices)
    idle_state["idleSince"] = {
        gpu_uuid: since
        for gpu_uuid, since in idle_state.get("idleSince", {}).items()
        if gpu_uuid in current_uuids
    }
    idle_state["indexes"] = {
        gpu_uuid: index
        for gpu_uuid, index in idle_state.get("indexes", {}).items()
        if gpu_uuid in current_uuids
    }
    candidates = []
    for gpu_uuid, device in devices.items():
        previous_index = idle_state["indexes"].get(gpu_uuid)
        if previous_index is not None and previous_index != device["index"]:
            idle_state["idleSince"].pop(gpu_uuid, None)
        idle_state["indexes"][gpu_uuid] = device["index"]
        if device["unavailable"] or not device["idle"]:
            idle_state["idleSince"].pop(gpu_uuid, None)
            continue
        since = idle_state["idleSince"].setdefault(gpu_uuid, now)
        elapsed = max(0, int(now - since))
        candidates.append({
            "uuid": gpu_uuid,
            "index": device["index"],
            "deviceId": device["deviceId"],
            "elapsedSeconds": elapsed,
        })
    idle_state["lastSample"] = now
    idle_state["lastCheckedAt"] = _iso_now()
    return sorted(candidates, key=lambda item: (-item["elapsedSeconds"], item["index"]))


def _best_candidate(candidates):
    return candidates[0] if candidates else None


def _reset_candidate_idle_state(idle_state, candidate):
    gpu_uuid = candidate["uuid"]
    idle_state.get("idleSince", {}).pop(gpu_uuid, None)
    idle_state.get("indexes", {}).pop(gpu_uuid, None)


def _set_progress(record, best, state=None, message=None):
    record["lastCheckedAt"] = _iso_now()
    if best is None:
        record["idleElapsedSeconds"] = 0
        record["selectedDeviceId"] = None
        record["state"] = state or "waiting"
        record["errorCode"] = None
        record["message"] = message or "No GPU is currently idle."
    else:
        record["idleElapsedSeconds"] = best["elapsedSeconds"]
        record["selectedDeviceId"] = best["deviceId"]
        record["state"] = state or ("countdown" if best["elapsedSeconds"] > 0 else "waiting")
        record["errorCode"] = None
        record["message"] = message or "Timing continuous GPU idle state."


def _restrict_gpu_candidates(candidates, launch_resources):
    allowed = launch_resources.get("gpuDeviceIds")
    if not isinstance(allowed, list) or not allowed:
        return candidates
    permitted = set(allowed)
    return [candidate for candidate in candidates if candidate["deviceId"] in permitted]


def _chosen_launch_request(record, candidate):
    launch_request = copy.deepcopy(record["launchRequest"])
    launch_request["armId"] = record.get("attemptArmId", launch_request["armId"])
    launch_request["gpuDevices"] = [{
        "deviceId": candidate["deviceId"],
        "uuid": candidate["uuid"],
    }]
    return launch_request


def _launch_candidate(record, path, state_root, launcher, candidate):
    record["state"] = "starting"
    record["selectedDeviceId"] = candidate["deviceId"]
    record["idleElapsedSeconds"] = candidate["elapsedSeconds"]
    record["lastCheckedAt"] = _iso_now()
    record["errorCode"] = None
    record["message"] = "The selected GPU is ready; starting the registered task."
    _write_json(path, state_root, record, launcher)
    try:
        result = launcher.launch_task(_chosen_launch_request(record, candidate))
    except launcher._LaunchError as exc:
        result = {"status": "failed", "errorCode": exc.error_code}
    except Exception:
        result = {"status": "failed", "errorCode": "UNKNOWN_LAUNCH_RESULT"}
    status_value = result.get("status") if isinstance(result, dict) else None
    if status_value == "started":
        pid = result.get("pid")
        started_at = result.get("startedAt")
        if type(pid) is not int or pid <= 0 or not _valid_iso(started_at):
            status_value = "failed"
            result = {"status": "failed", "errorCode": "UNKNOWN_LAUNCH_RESULT"}
        else:
            record["state"] = "started"
            record["pid"] = pid
            record["startedAt"] = started_at
            record["processKey"] = result.get("processKey")
            record["lastCheckedAt"] = _iso_now()
            record["errorCode"] = None
            record["message"] = "The registered task was started."
            _write_json(path, state_root, record, launcher)
            return not record.get("retryOnExit", False)
    if status_value in {"busy", "already_running"}:
        record["state"] = "blocked" if status_value == "already_running" else "waiting"
        record["idleElapsedSeconds"] = 0
        record["selectedDeviceId"] = None
        record["errorCode"] = None if status_value == "busy" else "TASK_ALREADY_RUNNING"
        record["message"] = (
            "The launch was busy; idle timers will recount."
            if status_value == "busy"
            else "A registered task process is already running."
        )
        _write_json(path, state_root, record, launcher)
        return False
    _set_terminal(
        record,
        "failed",
        error_code=(
            result.get("errorCode")
            if isinstance(result, dict) and isinstance(result.get("errorCode"), str)
            else "UNKNOWN_LAUNCH_RESULT"
        ),
        message="The registered task launch failed.",
    )
    _write_json(path, state_root, record, launcher)
    if record.get("retryOnExit"):
        _prepare_retry(record, idle_state=None)
        _write_json(path, state_root, record, launcher)
        return False
    return True


def _watching_process(record):
    return record.get("state") == "started" and record.get("retryOnExit") is True and not record.get("retryFinished")


def _process_is_running(key, proc_root="/proc"):
    if not isinstance(key, dict):
        return False
    try:
        with open(os.path.join(proc_root, "sys/kernel/random/boot_id"), encoding="ascii") as stream:
            if stream.read().strip() != key.get("hostBootId"):
                return False
        with open(os.path.join(proc_root, str(key["pid"]), "stat"), encoding="ascii") as stream:
            stat_line = stream.read(4096)
        fields = stat_line[stat_line.rfind(")") + 2:].split()
        return fields[0] not in {"Z", "X"} and fields[19] == key.get("startTicks")
    except (FileNotFoundError, ProcessLookupError, KeyError, IndexError):
        return False
    except OSError:
        # An incomplete identity check must not cause a second copy to launch.
        return True


def _completion_reported(record, launcher):
    for source in record["launchRequest"].get("sources", []):
        if source.get("kind") != "status_json":
            continue
        opened = launcher._probe().open_readonly(
            source["path"], record["hostAllowedRoots"], record["taskAllowedDirectories"], limit_bytes=256 * 1024)
        if opened.get("status") != "ok":
            continue
        try:
            status = json.loads(opened["data"])
        except (ValueError, TypeError, KeyError):
            continue
        if not isinstance(status, dict) or status.get("status") not in {"completed", "finished", "succeeded", "success"}:
            continue
        if record.get("pid") and status.get("pid") != record["pid"]:
            continue
        total, done = status.get("total_samples"), status.get("completed_samples")
        if isinstance(total, (int, float)) and (not isinstance(done, (int, float)) or done < total):
            continue
        return True
    return False


def _prepare_retry(record, idle_state):
    record["previousPid"] = record.get("pid")
    record["attemptArmId"] = str(uuid.uuid4())
    record["retryCount"] = record.get("retryCount", 0) + 1
    record["pid"] = None
    record["processKey"] = None
    record["startedAt"] = None
    _set_progress(record, None, message="Task exited before completion; waiting for any idle GPU.")
    if idle_state is not None:
        idle_state.clear()
        idle_state.update(_new_idle_state())


def _retry_iteration(job_key, state_root, launcher, idle_state):
    path = _job_path(state_root, job_key)
    control_fd = _acquire_file_lock(_control_lock_path(state_root, _read_json(path, launcher)["taskId"]), launcher)
    try:
        record = _read_json(path, launcher)
        if record["state"] in {"cancelled", "failed"} or record.get("retryFinished"):
            return False
        if _watching_process(record) and _process_is_running(record.get("processKey")):
            record["lastCheckedAt"] = _iso_now()
            _write_json(path, state_root, record, launcher)
            return True
        if _completion_reported(record, launcher):
            record["retryFinished"] = True
            record["state"] = "started"
            record["message"] = "Task completed; automatic retry has finished."
            record["lastCheckedAt"] = _iso_now()
            _write_json(path, state_root, record, launcher)
            return False
        if record["state"] == "started":
            _prepare_retry(record, idle_state)
            _write_json(path, state_root, record, launcher)
            return True
        return None
    finally:
        _release_file_lock(control_fd)


def _worker_iteration(
    job_key,
    state_root,
    launcher,
    idle_state,
    *,
    tmux_executable,
):
    path = _job_path(state_root, job_key)
    record = _read_json(path, launcher)
    if record is None:
        return False
    _validate_record(record, job_key=job_key)
    if record.get("retryOnExit"):
        retry_result = _retry_iteration(job_key, state_root, launcher, idle_state)
        if retry_result is not None:
            return retry_result
    if record["state"] in _TERMINAL_STATES:
        return False
    if not _session_exists(tmux_executable, launcher._current_uid(), record["sessionName"], state_root):
        control_fd = _acquire_file_lock(
            _control_lock_path(state_root, record["taskId"]), launcher)
        try:
            record = _read_json(path, launcher)
            _validate_record(record, job_key=job_key)
            if record["state"] not in _TERMINAL_STATES:
                _set_terminal(
                    record,
                    "failed",
                    error_code="SERVER_WAITER_LOST",
                    message="The dedicated tmux waiter session is missing.",
                )
                _write_json(path, state_root, record, launcher)
        finally:
            _release_file_lock(control_fd)
        return False

    launch_resources = record["launchRequest"]
    disk_floor = launch_resources.get("minFreeDiskMiB", 0)
    if disk_floor:
        log_path = next(s["path"] for s in launch_resources["sources"] if s["sourceId"] == launch_resources["launch"]["logSourceId"])
        if shutil.disk_usage(os.path.dirname(log_path)).free < disk_floor * 1024**2:
            control = _acquire_file_lock(_control_lock_path(state_root, record["taskId"]), launcher)
            try:
                record = _read_json(path, launcher)
                if record["state"] in _TERMINAL_STATES:
                    return False
                _reset_idle_state(idle_state, _monotonic())
                _set_progress(record, None, message=f"输出磁盘可用空间不足 {disk_floor} MiB，等待恢复后启动。")
                _write_json(path, state_root, record, launcher)
                return True
            finally:
                _release_file_lock(control)
    query_started = _monotonic()
    try:
        query = (launcher._probe()._query_linux_gpu(include_free=True) if launch_resources.get("minFreeMemoryMiB")
                 else launcher._probe()._query_linux_gpu())
    except Exception:
        query = {"status": "unavailable", "errorCode": "NVIDIA_SMI_UNAVAILABLE"}
    query_finished = _monotonic()
    if (isinstance(query, dict) and query.get("status") == "ok"
            and isinstance(query.get("csv"), str)):
        candidates = _update_idle_timers(
            query["csv"],
            launch_request_value(record, "maxUtilizationPercent"),
            launch_request_value(record, "maxMemoryMiB"),
            query_finished,
            idle_state,
            launch_resources.get("minFreeMemoryMiB"),
        )
        query_message = None
    else:
        _update_idle_timers("", 0, 0, query_finished, idle_state)
        candidates = []
        query_message = "GPU state is unavailable; idle timers were reset."
    del query_started
    if launch_resources.get("gpuSharing"):
        candidates = [c for c in candidates if launcher._sharing_candidate_allowed(state_root, launch_resources, c["uuid"])]
        if not candidates and query_message is None:
            query_message = "等待可用显存和共享 GPU 名额；同卡启动阶段依次进行。"
    elif launch_resources.get("minFreeMemoryMiB") and not candidates:
        query_message = "等待 GPU 可用显存达到设定门槛。"
    best = _best_candidate(_restrict_gpu_candidates(candidates, launch_resources))

    control_fd = _acquire_file_lock(_control_lock_path(state_root, record["taskId"]), launcher)
    try:
        record = _read_json(path, launcher)
        if record is None:
            return False
        _validate_record(record, job_key=job_key)
        if record["state"] in _TERMINAL_STATES:
            return False
        if record["configHash"] != record["launchRequest"].get("configHash"):
            _set_terminal(
                record,
                "failed",
                error_code="CONFIG_CHANGED",
                message="The job configuration changed before launch.",
            )
            _write_json(path, state_root, record, launcher)
            return False

        try:
            launch_request = launcher._validate_request(_chosen_launch_request(
                record,
                best or {"deviceId": "GPU 0", "uuid": "GPU-server-waiter"},
            ))
            hosts, tasks = launcher._probe()._canonical_task_roots(
                record["hostAllowedRoots"], record["taskAllowedDirectories"])
            scan = launcher._scan_for_registered_process(
                launcher._probe(), launch_request, hosts, tasks)
        except launcher._LaunchError as exc:
            scan = exc
        except Exception:
            scan = launcher._LaunchError("PROCESS_SCAN_INCOMPLETE")
        if isinstance(scan, launcher._LaunchError):
            _set_progress(record, None, state="blocked", message="Process scan is incomplete.")
            record["errorCode"] = scan.error_code
            record["lastCheckedAt"] = _iso_now()
            _reset_idle_state(idle_state, _monotonic())
            _write_json(path, state_root, record, launcher)
            return True
        if scan is not None:
            _set_progress(record, None, state="blocked", message="A registered task process is running.")
            record["errorCode"] = "TASK_ALREADY_RUNNING"
            _reset_idle_state(idle_state, _monotonic())
            _write_json(path, state_root, record, launcher)
            return True

        if best is not None and best["elapsedSeconds"] >= record["requiredIdleSeconds"]:
            terminal = _launch_candidate(record, path, state_root, launcher, best)
            if not terminal:
                if record["state"] == "blocked":
                    _reset_idle_state(idle_state, _monotonic())
                else:
                    _reset_candidate_idle_state(idle_state, best)
            return not terminal

        _set_progress(record, best, message=query_message)
        _write_json(path, state_root, record, launcher)
        return True
    finally:
        _release_file_lock(control_fd)


def launch_request_value(record, field):
    value = record["launchRequest"].get(field)
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise _AgentError("STATE_FILE_INVALID")
    return value


def _worker_progress_line(record):
    state = record.get("state")
    if state not in _ALL_STATES - {"missing"}:
        state = "unknown"
    candidate = record.get("selectedDeviceId")
    if not isinstance(candidate, str) or not _DEVICE_ID.fullmatch(candidate):
        candidate = "none"
    continuous = record.get("idleElapsedSeconds")
    if type(continuous) is not int or not 0 <= continuous <= 86400:
        continuous = 0
    required = record.get("requiredIdleSeconds")
    if type(required) is not int or not 1 <= required <= 86400:
        required = 1
    return (
        _iso_now()
        + " state="
        + state
        + " candidate="
        + candidate
        + " continuous="
        + str(continuous)
        + "s required="
        + str(required)
        + "s"
    )


def _emit_worker_progress(job_key, state_root, launcher):
    try:
        record = _read_json(_job_path(state_root, job_key), launcher)
        if record is None:
            return
        _validate_record(record, job_key=job_key)
        sys.stdout.write(_worker_progress_line(record) + "\n")
        sys.stdout.flush()
    except Exception:
        # Attached tmux output is advisory and must never affect waiting or launch.
        return


def _run_worker(job_key, state_root, launcher, *, max_iterations=None):
    if not _HEX64.fullmatch(job_key):
        return 2
    if not isinstance(state_root, str) or not os.path.isabs(state_root):
        return 2
    host_root = os.path.dirname(state_root)
    if _state_directory(host_root, launcher, create=False) != state_root:
        return 2
    lifetime_fd = _acquire_file_lock(
        _lifetime_lock_path(state_root, job_key), launcher, nonblocking=True)
    if lifetime_fd is None:
        return 3
    try:
        executable = _check_tmux()
        idle_state = _new_idle_state()
        iterations = 0
        while max_iterations is None or iterations < max_iterations:
            iterations += 1
            try:
                keep_waiting = _worker_iteration(
                    job_key, state_root, launcher, idle_state, tmux_executable=executable)
            except (_AgentError, OSError) as exc:
                if not _storage_exhausted(exc):
                    raise
                # An atomic state write can fail even while launch is gated on disk space.
                # Keep the tmux worker alive and restart the countdown after storage recovers.
                _reset_idle_state(idle_state, None)
                keep_waiting = True
            if not keep_waiting:
                _emit_worker_progress(job_key, state_root, launcher)
                return 0
            _emit_worker_progress(job_key, state_root, launcher)
            if max_iterations is None or iterations < max_iterations:
                _sleep(POLL_SECONDS)
        return 0
    except _AgentError as exc:
        try:
            control_fd = _acquire_file_lock(
                _control_lock_path(state_root, _read_json(
                    _job_path(state_root, job_key), launcher)["taskId"]),
                launcher,
            )
        except Exception:
            return 1
        try:
            record = _read_json(_job_path(state_root, job_key), launcher)
            if record is not None and record.get("state") not in _TERMINAL_STATES:
                _set_terminal(
                    record,
                    "failed",
                    error_code=exc.error_code,
                    message=exc.message or "The server waiter failed.",
                )
                _write_json(_job_path(state_root, job_key), state_root, record, launcher)
        except Exception:
            return 1
        finally:
            _release_file_lock(control_fd)
        return 1
    finally:
        _release_file_lock(lifetime_fd)


def _storage_exhausted(error):
    while error is not None:
        if isinstance(error, OSError) and error.errno in {errno.ENOSPC, errno.EDQUOT}:
            return True
        error = error.__cause__
    return False


def _dispatch(request, launcher):
    operation = request.get("op") if isinstance(request, dict) else None
    if operation == "ensure_server_wait":
        return ensure_server_wait(request, launcher)
    if operation == "get_server_wait":
        return get_server_wait(request, launcher)
    if operation == "cancel_server_wait":
        return cancel_server_wait(request, launcher)
    raise _AgentError("REQUEST_OP_UNSUPPORTED")


def _decode_request(source_b64):
    if source_b64 == "__MONITOR_REQUEST_B64__":
        raise _AgentError("REQUEST_MISSING")
    try:
        raw = base64.b64decode(source_b64, validate=True)
        if not raw or len(raw) > MAX_REQUEST_BYTES:
            raise ValueError("request size")
        request = json.loads(raw.decode("utf-8"))
        if not isinstance(request, dict):
            raise ValueError("request schema")
        return request
    except (ValueError, TypeError, UnicodeDecodeError) as exc:
        raise _AgentError("INVALID_REQUEST") from exc


def _failure_payload(request, error):
    arm_id = request.get("armId") if isinstance(request, dict) else ""
    config_hash = request.get("configHash") if isinstance(request, dict) else ""
    if not isinstance(arm_id, str):
        arm_id = ""
    if not isinstance(config_hash, str) or not _HEX64.fullmatch(config_hash.lower()):
        config_hash = ""
    required_idle = request.get("idleSeconds") if isinstance(request, dict) else 1
    if type(required_idle) is not int or not 1 <= required_idle <= 86400:
        required_idle = 1
    return _status(
        state="failed",
        arm_id=arm_id,
        config_hash=config_hash,
        required_idle=required_idle,
        error_code=error.error_code,
        message=error.message or "The server waiter request failed.",
    )


def _emit_frame(envelope):
    payload = json.dumps(envelope, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
    sys.stdout.buffer.write(len(payload).to_bytes(4, "big"))
    sys.stdout.buffer.write(payload)
    sys.stdout.buffer.flush()


def _manager_main():
    request = None
    try:
        request = _decode_request(REQUEST_B64)
        launcher = _load_launcher(LAUNCHER_SOURCE_B64)
        payload = _dispatch(request, launcher)
        return 0, {
            "version": VERSION,
            "requestId": request.get("requestId") if isinstance(request.get("requestId"), str) else None,
            "sourceId": None,
            "payload": payload,
        }
    except _AgentError as exc:
        return 2, {
            "version": VERSION,
            "requestId": request.get("requestId") if isinstance(request, dict) and isinstance(request.get("requestId"), str) else None,
            "sourceId": None,
            "payload": _failure_payload(request, exc),
        }
    except Exception:
        exc = _AgentError("AGENT_INTERNAL_ERROR")
        return 2, {
            "version": VERSION,
            "requestId": request.get("requestId") if isinstance(request, dict) and isinstance(request.get("requestId"), str) else None,
            "sourceId": None,
            "payload": _failure_payload(request, exc),
        }


def main():
    code, frame = _manager_main()
    _emit_frame(frame)
    return code


def _worker_main():
    if len(sys.argv) != 4 or sys.argv[1] != "--worker":
        return 2
    try:
        launcher = _load_launcher(LAUNCHER_SOURCE_B64)
        return _run_worker(sys.argv[2], sys.argv[3], launcher)
    except Exception:
        return 2


if __name__ == "__main__":
    if len(sys.argv) > 1 and sys.argv[1] == "--worker":
        raise SystemExit(_worker_main())
    raise SystemExit(main())
