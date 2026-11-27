#!/usr/bin/python3
"""Bounded, read-only probe body. Requests are embedded as base64 data or streamed via TMF1."""
import base64
import binascii
import ctypes
import datetime
import glob
import hashlib
import json
import os
import re
import selectors
import shutil
import stat
import subprocess
import sys
import time

try:
    import pwd as _pwd
except ImportError:
    _pwd = None

VERSION = 1
FRAME_MAGIC = b"TMF1"
MAX_RESPONSE_BYTES = 2 * 1024 * 1024
MAX_STDERR_BYTES = 64 * 1024
MAX_STATUS_BYTES = 256 * 1024
MAX_READ_BYTES = 1024 * 1024
MAX_PREAMBLE_JUNK_BYTES = 64 * 1024
MAX_PROCESSES = 4096
DEFAULT_MAX_FDS_PER_PROCESS = 4096
MAX_FDS_PER_PROCESS = DEFAULT_MAX_FDS_PER_PROCESS
MAX_PROCESS_GPU_DEVICES = 64
MAX_PROCESS_GPU_ROWS = 4096
MAX_PROCESS_GPU_OUTPUT_BYTES = 256 * 1024
MAX_DEVICE_GPU_OUTPUT_BYTES = 64 * 1024
MAX_CHECKPOINT_ENTRIES = 512
MAX_CHECKPOINT_FILES = 256
SCAN_BUDGET_SECONDS = 2.0
MAX_SCAN_BUDGET_SECONDS = 5.0
CLOCK_SKEW_TOLERANCE_US = 2_000_000
LAUNCHER_OPEN_FLAG = getattr(os, "O_SYNC", 0) | getattr(os, "O_DSYNC", 0)
REQUEST_B64 = "__MONITOR_REQUEST_B64__"

_MISSING_GPU_VALUE_RE = re.compile(r"^(?:\[?\s*(?:N/A|NA|Not Supported|Unknown)\s*\]?|-)$", re.IGNORECASE)
_GPU_OR_MIG_UUID_RE = re.compile(r"^(?:GPU|MIG)-[A-Za-z0-9._:/-]+$")
_TRUSTED_LINUX_NVIDIA_SMI = (
    "/usr/bin/nvidia-smi",
    "/usr/local/nvidia/bin/nvidia-smi",
)
_PYTHON_SINGLE_FLAGS = frozenset("ISBEsuOqbdvxP")
_PYTHON_ARG_FLAGS = frozenset("WX")
_ML_LAUNCHERS = frozenset({
    "torchrun", "accelerate", "deepspeed", "yolo", "uv", "conda", "mamba",
    "micromamba", "bash", "sh", "zsh", "srun", "ray", "mpirun", "mpiexec",
    "env", "stdbuf", "timeout", "setsid", "nohup", "lightning", "fabric",
    "llamafactory-cli", "vllm", "swift", "axolotl", "trl",
})
_CHECKPOINT_FILE_EXTS = frozenset({
    ".pt", ".pth", ".ckpt", ".safetensors", ".bin", ".onnx", ".h5", ".npz", ".weights",
})
_CHECKPOINT_DIR_RE = re.compile(
    r"^(?:checkpoint[-_.]?\d*|global_step[-_.]?\d+|iter[-_.]?\d+|step[-_.]?\d+|epoch[-_.]?\d+|ckpt[-_.]?\d*|best|last|latest)$",
    re.IGNORECASE,
)
_CHECKPOINT_DIR_MARKERS = frozenset({
    "trainer_state.json", "config.json", "model.safetensors", "model.safetensors.index.json",
    "pytorch_model.bin", "pytorch_model.bin.index.json", "optimizer.pt", "scheduler.pt",
    "latest", "latest_checkpointed_iteration.txt", ".metadata", "_metadata",
})

# Session-scoped caches for delta CPU utilization (persistent --serve mode).
_PREV_HOST_CPU = None
_PREV_PROC_CPU = {}


def _is_missing_gpu_value(text):
    if not isinstance(text, str):
        return True
    stripped = text.strip()
    return not stripped or bool(_MISSING_GPU_VALUE_RE.fullmatch(stripped))


def _is_valid_gpu_uuid(uuid):
    return (
        isinstance(uuid, str)
        and 0 < len(uuid) <= 256
        and ".." not in uuid
        and bool(_GPU_OR_MIG_UUID_RE.fullmatch(uuid))
    )


def _find_nvidia_smi():
    """Prefer trusted system paths before falling back to PATH."""
    if os.name == "nt":
        system_root = os.environ.get("SystemRoot") or r"C:\Windows"
        program_files = os.environ.get("ProgramFiles") or r"C:\Program Files"
        candidates = (
            os.path.join(system_root, "System32", "nvidia-smi.exe"),
            os.path.join(program_files, "NVIDIA Corporation", "NVSMI", "nvidia-smi.exe"),
        )
        for candidate in candidates:
            if os.path.isfile(candidate):
                return candidate
        return shutil.which("nvidia-smi.exe") or shutil.which("nvidia-smi")
    for candidate in _TRUSTED_LINUX_NVIDIA_SMI:
        if os.path.isfile(candidate) and os.access(candidate, os.X_OK):
            return candidate
    return shutil.which("nvidia-smi")


def path_is_within(root, candidate):
    """Use normalized component boundaries; never use a string-prefix test."""
    try:
        root = os.path.normcase(os.path.abspath(root))
        candidate = os.path.normcase(os.path.abspath(candidate))
        return os.path.commonpath((root, candidate)) == root
    except (OSError, ValueError):
        return False


def _identity(info):
    return {"dev": str(info.st_dev), "inode": str(info.st_ino)}


def _same_identity(left, right):
    return left.st_dev == right.st_dev and left.st_ino == right.st_ino


def _canonical_task_roots(host_roots, task_directories):
    if not isinstance(host_roots, list) or not host_roots or not isinstance(task_directories, list) or not task_directories:
        return None, None
    if any(not isinstance(root, str) or not root for root in host_roots + task_directories):
        return None, None
    hosts = [os.path.realpath(root) for root in host_roots]
    tasks = []
    for root in task_directories:
        candidate = os.path.realpath(root)
        if candidate not in tasks:
            tasks.append(candidate)
    if not hosts or not tasks or any(not any(path_is_within(host, task) for host in hosts) for task in tasks):
        return None, None
    return hosts, tasks


def _entry_roots(host_roots, task_directories):
    """Registration-only roots: the symlink target of a registered entry is ours too."""
    if not isinstance(host_roots, list) or not host_roots or not isinstance(task_directories, list) or not task_directories:
        return None, None
    hosts, _ = _canonical_task_roots(host_roots, task_directories)
    if hosts is None or not task_directories or os.sep != "/" or any(not isinstance(root, str) or not root for root in task_directories):
        return hosts, None
    hosts = hosts + [root for root in (os.path.realpath(item) for item in task_directories) if root not in hosts]
    return hosts, [os.path.realpath(root) for root in task_directories]


def _path_in_scope(path, hosts, tasks, host_only=False):
    return any(path_is_within(host, path) for host in hosts) and (host_only or any(path_is_within(task, path) for task in tasks))


def _resolve_dynamic_source_path(source, host_roots, task_directories):
    """Resolve exact, glob_latest, or dir_latest source paths strictly inside allowed roots."""
    raw_path = source.get("path") if isinstance(source, dict) else None
    if not isinstance(raw_path, str) or not raw_path:
        return None, "INVALID_PATH_REQUEST"
    mode = source.get("pathMode") or "exact"
    if mode == "exact":
        return raw_path, None
    hosts, tasks = _canonical_task_roots(host_roots, task_directories)
    if hosts is None:
        return None, "TASK_ROOT_OUTSIDE_HOST_ROOT"
    if mode == "glob_latest":
        # Verify the static directory prefix of the glob is inside scope.
        static_prefix = re.split(r"[*?\[\]]", raw_path, maxsplit=1)[0]
        base_dir = os.path.dirname(static_prefix) if static_prefix else ""
        if not base_dir or not _path_in_scope(os.path.realpath(base_dir), hosts, tasks):
            return None, "PATH_OUTSIDE_TASK_ROOT"
        matches = []
        try:
            for item in glob.iglob(raw_path, recursive="**" in raw_path):
                if len(matches) >= 512:
                    break
                try:
                    resolved = os.path.realpath(item)
                    if not _path_in_scope(resolved, hosts, tasks):
                        continue
                    info = os.stat(resolved, follow_symlinks=False)
                    if stat.S_ISREG(info.st_mode):
                        matches.append((info.st_mtime_ns, resolved))
                except OSError:
                    continue
        except OSError:
            return None, "SOURCE_OPEN_FAILED"
        if not matches:
            return None, "SOURCE_MISSING"
        matches.sort(key=lambda pair: (pair[0], pair[1]), reverse=True)
        return matches[0][1], None
    if mode == "dir_latest":
        resolved_dir = os.path.realpath(raw_path)
        if not _path_in_scope(resolved_dir, hosts, tasks):
            return None, "PATH_OUTSIDE_TASK_ROOT"
        if not os.path.isdir(resolved_dir):
            return None, "SOURCE_MISSING"
        preferred = []
        fallback = []
        scanned = 0
        stack = [(resolved_dir, 0)]
        while stack and scanned < 512:
            current_dir, depth = stack.pop()
            try:
                with os.scandir(current_dir) as it:
                    for entry in it:
                        scanned += 1
                        if scanned > 512:
                            break
                        try:
                            resolved = os.path.realpath(entry.path)
                            if not _path_in_scope(resolved, hosts, tasks):
                                continue
                            info = os.stat(resolved, follow_symlinks=False)
                            if stat.S_ISDIR(info.st_mode) and depth < 3:
                                stack.append((resolved, depth + 1))
                            elif stat.S_ISREG(info.st_mode):
                                ext = os.path.splitext(entry.name)[1].lower()
                                bucket = preferred if ext in (".log", ".out", ".txt") else fallback
                                bucket.append((info.st_mtime_ns, resolved))
                        except OSError:
                            continue
            except OSError:
                continue
        chosen = preferred or fallback
        if not chosen:
            return None, "SOURCE_MISSING"
        chosen.sort(key=lambda pair: (pair[0], pair[1]), reverse=True)
        return chosen[0][1], None
    return None, "INVALID_PATH_REQUEST"


def open_readonly(candidate, host_roots, task_directories=None, limit_bytes=MAX_READ_BYTES, after_resolve=None):
    """Open regular files (including symlinks resolving inside allowed roots) safely without TOCTOU."""
    fd = None
    try:
        if not isinstance(candidate, str):
            return {"status": "permission_error", "errorCode": "INVALID_PATH_REQUEST"}
        if type(limit_bytes) is not int or limit_bytes < 0 or limit_bytes > MAX_READ_BYTES:
            return {"status": "permission_error", "errorCode": "READ_LIMIT_INVALID"}
        roots = task_directories if task_directories is not None else host_roots
        hosts, tasks = _canonical_task_roots(host_roots, roots)
        if hosts is None:
            return {"status": "permission_error", "errorCode": "TASK_ROOT_OUTSIDE_HOST_ROOT"}
        resolved = os.path.realpath(candidate)
        if not _path_in_scope(resolved, hosts, tasks):
            return {"status": "permission_error", "errorCode": "PATH_OUTSIDE_TASK_ROOT"}
        before = os.stat(resolved, follow_symlinks=False)
        if not stat.S_ISREG(before.st_mode):
            return {"status": "permission_error", "errorCode": "NOT_A_REGULAR_FILE"}
        if after_resolve is not None:
            after_resolve(resolved)
        flags = os.O_RDONLY | getattr(os, "O_BINARY", 0) | getattr(os, "O_CLOEXEC", 0)
        if hasattr(os, "O_NOFOLLOW"):
            flags |= os.O_NOFOLLOW
        # Open the resolved canonical target path (supporting symlinks like latest.log -> run.log
        # whose final target was strictly verified inside both host and task roots).
        fd = os.open(resolved, flags)
        opened = os.fstat(fd)
        resolved_after = os.path.realpath(candidate)
        after_resolved_stat = os.stat(resolved_after, follow_symlinks=False)
        hosts_after, tasks_after = _canonical_task_roots(host_roots, roots)
        if (
            not _same_identity(before, opened)
            or not _same_identity(opened, after_resolved_stat)
            or resolved_after != resolved
            or hosts_after != hosts
            or tasks_after != tasks
            or not _path_in_scope(resolved_after, hosts_after, tasks_after)
        ):
            return {"status": "permission_error", "errorCode": "PATH_IDENTITY_CHANGED"}
        if limit_bytes == 0:
            data = b""
        else:
            data = os.read(fd, limit_bytes)
        final = os.fstat(fd)
        if not _same_identity(opened, final):
            return {"status": "permission_error", "errorCode": "PATH_IDENTITY_CHANGED"}
        return {
            "status": "ok",
            "data": data,
            "identity": _identity(final),
            "sizeBytes": str(final.st_size),
            "resolvedPath": resolved,
        }
    except FileNotFoundError:
        return {"status": "missing", "errorCode": "SOURCE_MISSING"}
    except PermissionError:
        return {"status": "permission_error", "errorCode": "SOURCE_PERMISSION"}
    except OSError as exc:
        return {"status": "permission_error", "errorCode": "SOURCE_OPEN_FAILED", "errno": exc.errno}
    finally:
        if fd is not None:
            try:
                os.close(fd)
            except OSError:
                pass


def parse_proc_stat_fields(stat_line):
    """Extract key fields from /proc/<pid>/stat after the final comm closing parenthesis."""
    if not isinstance(stat_line, str):
        return None
    open_paren = stat_line.find("(")
    close = stat_line.rfind(")")
    if close < 0:
        return None
    comm = stat_line[open_paren + 1:close] if 0 <= open_paren < close else ""
    fields = stat_line[close + 1:].strip().split()
    if len(fields) <= 19:
        return None
    start_ticks = fields[19]
    if not start_ticks.isdecimal():
        return None
    state = fields[0]
    ppid = int(fields[1]) if len(fields) > 1 and fields[1].lstrip("-").isdecimal() else None
    pgid = int(fields[2]) if len(fields) > 2 and fields[2].lstrip("-").isdecimal() else None
    utime = int(fields[11]) if len(fields) > 11 and fields[11].isdecimal() else 0
    stime = int(fields[12]) if len(fields) > 12 and fields[12].isdecimal() else 0
    rss_pages = int(fields[21]) if len(fields) > 21 and fields[21].lstrip("-").isdecimal() else None
    return {
        "comm": comm,
        "state": state,
        "ppid": ppid,
        "pgid": pgid,
        "utime": utime,
        "stime": stime,
        "startTicks": start_ticks,
        "rssPages": rss_pages,
    }


def parse_proc_start_ticks(stat_line):
    """Extract /proc/<pid>/stat field 22 after the final comm closing parenthesis."""
    parsed = parse_proc_stat_fields(stat_line)
    return parsed["startTicks"] if parsed else None


def _read_nspid(proc_dir):
    """Read container PID namespace mapping from /proc/<pid>/status NSpid line."""
    try:
        with open(os.path.join(proc_dir, "status"), "r", encoding="utf-8", errors="replace") as stream:
            data = stream.read(4096)
    except OSError:
        return None
    for line in data.splitlines():
        if line.startswith("NSpid:"):
            parts = line.split(":", 1)[1].strip().split()
            if len(parts) >= 2 and parts[-1].isdecimal():
                return int(parts[-1])
            return None
    return None


def _read_full_argv(path, max_bytes=16384):
    """Read bounded NUL-delimited /proc/<pid>/cmdline argv."""
    with open(path, "rb") as stream:
        raw = stream.read(max_bytes + 1)
    truncated = len(raw) > max_bytes
    if truncated:
        raw = raw[:max_bytes]
    if not raw:
        return {"argv": [], "parseComplete": False}
    parts = [part.decode("utf-8", "replace") for part in raw.rstrip(b"\0").split(b"\0") if part]
    return {"argv": parts, "parseComplete": bool(parts)}


def _is_python_basename(name):
    lower = os.path.basename(name or "").lower()
    return bool(re.fullmatch(r"python(?:\d+(?:\.\d+)*)?(?:\.exe)?", lower))


_PYTHON_LAUNCHER_MODULES = frozenset({
    "torch.distributed.run",
    "torch.distributed.launch",
    "accelerate.commands.launch",
    "deepspeed.launcher.launch",
    "deepspeed.launcher.runner",
    "lightning.pytorch.cli",
    "runpy",
})


def _extract_module_nested_script(module_name, rest):
    if module_name in _PYTHON_LAUNCHER_MODULES:
        return _extract_nested_script(rest)
    return None


def _parse_python_argv(argv_strings, start_index=1):
    """Parse Python interpreter options including combined short flags (-uB, -P), -m, -c, -W, -X."""
    script = None
    module_name = None
    inline_code = None
    interpreter_flags = []
    index = start_index
    options_ended = False
    parse_complete = True
    while index < len(argv_strings):
        item = argv_strings[index]
        if options_ended:
            script = item
            break
        if item == "--":
            options_ended = True
            index += 1
            continue
        if item == "-":
            parse_complete = False
            break
        if item == "-m":
            if index + 1 < len(argv_strings):
                module_name = argv_strings[index + 1]
                interpreter_flags.append("-m")
                index += 2
                # For module launchers like `python -m torch.distributed.run ... train.py`
                # also inspect remaining args for nested script entry.
                rest = argv_strings[index:]
                script = _extract_module_nested_script(module_name, rest)
            else:
                parse_complete = False
            break
        if item.startswith("-m") and len(item) > 2:
            module_name = item[2:]
            interpreter_flags.append("-m")
            rest = argv_strings[index + 1:]
            script = _extract_module_nested_script(module_name, rest)
            break
        if item == "-c":
            if index + 1 < len(argv_strings):
                inline_code = argv_strings[index + 1]
                interpreter_flags.append("-c")
            else:
                parse_complete = False
            break
        if item.startswith("-c") and len(item) > 2:
            inline_code = item[2:]
            interpreter_flags.append("-c")
            break
        if item in ("-W", "-X"):
            if index + 1 >= len(argv_strings):
                parse_complete = False
                break
            interpreter_flags.append(item)
            index += 2
            continue
        if len(item) > 2 and item[0] == "-" and item[1] in _PYTHON_ARG_FLAGS:
            interpreter_flags.append(item[:32])
            index += 1
            continue
        if item.startswith("-") and not item.startswith("--") and len(item) >= 2:
            # Handle combined short flags such as -uB, -uI, -OO, -uP, or -um <mod>
            cluster = item[1:]
            matched_cluster = True
            pos = 0
            while pos < len(cluster):
                ch = cluster[pos]
                if ch in _PYTHON_SINGLE_FLAGS:
                    pos += 1
                    continue
                if ch == "m":
                    tail = cluster[pos + 1:]
                    if tail:
                        module_name = tail
                        rest = argv_strings[index + 1:]
                    elif index + 1 < len(argv_strings):
                        module_name = argv_strings[index + 1]
                        rest = argv_strings[index + 2:]
                    else:
                        parse_complete = False
                        rest = []
                    interpreter_flags.append("-m")
                    if module_name:
                        script = _extract_module_nested_script(module_name, rest)
                    return {
                        "script": script,
                        "module": module_name,
                        "inlineCode": inline_code,
                        "interpreterFlags": interpreter_flags[:16],
                        "parseComplete": parse_complete,
                    }
                if ch == "c":
                    tail = cluster[pos + 1:]
                    inline_code = tail if tail else (argv_strings[index + 1] if index + 1 < len(argv_strings) else None)
                    interpreter_flags.append("-c")
                    return {
                        "script": None,
                        "module": None,
                        "inlineCode": inline_code,
                        "interpreterFlags": interpreter_flags[:16],
                        "parseComplete": inline_code is not None,
                    }
                matched_cluster = False
                break
            if matched_cluster:
                interpreter_flags.append(item[:32])
                index += 1
                continue
            parse_complete = False
            break
        if item.startswith("--"):
            # Skip known long options like --check-hash-based-pycs
            parse_complete = False
            break
        # Handle shebang-expanded Python ML launchers such as `/usr/bin/python3 /opt/conda/bin/torchrun ... train.py`
        script_base = os.path.basename(item).lower()
        if script_base in _ML_LAUNCHERS and script_base not in ("bash", "sh", "zsh", "env"):
            nested = _extract_nested_script(argv_strings[index + 1:])
            script = nested or item
        else:
            script = item
        break
    return {
        "script": script,
        "module": module_name,
        "inlineCode": inline_code,
        "interpreterFlags": interpreter_flags[:16],
        "parseComplete": parse_complete,
    }


def _extract_nested_script(tokens):
    """Extract a launched script operand after flags for torchrun/accelerate/deepspeed/uv/conda."""
    skip_next = False
    i = 0
    while i < len(tokens):
        tok = tokens[i]
        if skip_next:
            skip_next = False
            i += 1
            continue
        if tok == "--":
            return tokens[i + 1] if i + 1 < len(tokens) else None
        if tok in ("-m", "--module"):
            return tokens[i + 1] if i + 1 < len(tokens) else None
        if tok.startswith("-"):
            # Option with separate value if it doesn't contain '=' and isn't a known boolean flag.
            if "=" not in tok and tok in (
                "-n", "--name", "-p", "--prefix", "--nproc_per_node", "--nproc-per-node",
                "--nnodes", "--node_rank", "--node-rank", "--master_addr", "--master-addr",
                "--master_port", "--master-port", "--rdzv_id", "--rdzv_backend", "--rdzv_endpoint",
                "--num_processes", "--config_file", "--include", "--hostfile", "--gpus",
                "-c", "--chdir", "-C", "--directory",
            ):
                skip_next = True
            i += 1
            continue
        # Skip subcommands of wrappers like `accelerate launch`, `conda run`, `uv run`, `yolo train`.
        if tok in ("launch", "run", "exec", "train", "fit", "sft"):
            i += 1
            continue
        if _is_python_basename(tok):
            nested = _parse_python_argv(tokens[i:], 1)
            return nested["script"] or nested["module"]
        return tok
    return None


def _read_script_argv_prefix(path, max_bytes=16384):
    """Read bounded argv from /proc/<pid>/cmdline."""
    return _read_full_argv(path, max_bytes=max_bytes)


def verify_process_identity(read_identity, expected):
    """Require boot id, PID and kernel start time to remain stable across the probe."""
    try:
        first = read_identity()
        second = read_identity()
    except (OSError, ValueError):
        return {"verified": False, "errorCode": "PROCESS_IDENTITY_UNAVAILABLE"}
    required = ("bootId", "pid", "startTicks")
    if not isinstance(expected, dict) or any(expected.get(key) in (None, "") for key in required):
        return {"verified": False, "errorCode": "PROCESS_IDENTITY_WEAK"}
    if first != expected or second != expected:
        return {"verified": False, "errorCode": "PROCESS_IDENTITY_CHANGED"}
    return {"verified": True, "key": {"hostBootId": expected["bootId"], "pid": expected["pid"], "startTicks": expected["startTicks"]}}


def project_status_json(raw, allowed_keys):
    if not isinstance(raw, (bytes, bytearray)) or len(raw) > MAX_STATUS_BYTES:
        return {"status": "error", "errorCode": "STATUS_JSON_LIMIT"}
    try:
        parsed = json.loads(bytes(raw).decode("utf-8"))
    except (UnicodeDecodeError, ValueError, RecursionError):
        return {"status": "error", "errorCode": "STATUS_JSON_INVALID"}
    if not isinstance(parsed, dict):
        return {"status": "error", "errorCode": "STATUS_JSON_SCHEMA"}
    values = {}
    for key in allowed_keys:
        value = parsed.get(key)
        if isinstance(value, (str, int, float, bool)) or value is None:
            values[key] = value
    return {"status": "ok", "values": values}


def _registered_entry_name_matches(script, entries):
    if not isinstance(script, str) or not script:
        return False
    name = os.path.normpath(script)
    if name in (".", "..") or os.sep in name or (os.altsep and os.altsep in name):
        return False
    return any(isinstance(entry, str) and entry and os.path.basename(os.path.normpath(entry)) == name for entry in entries)


def _script_operand(argv):
    """Return the primary script/module operand from Python or ML launcher argv."""
    items = [item for item in argv if isinstance(item, str)] if isinstance(argv, list) else []
    if not items:
        return None
    exe_base = os.path.basename(items[0]).lower()
    if _is_python_basename(exe_base):
        parsed = _parse_python_argv(items, 1)
        return parsed["script"] or parsed["module"]
    if exe_base in _ML_LAUNCHERS:
        if exe_base in ("bash", "sh", "zsh") and len(items) >= 3 and items[1] in ("-c", "-lc"):
            return items[2]
        return _extract_nested_script(items[1:]) or items[0]
    return items[0]


def _argv_coarse_matches_registration(argv, entries):
    """Fast check against argv BEFORE touching realpath(cwd) to avoid NFS stalls on unrelated procs."""
    if not argv or not isinstance(entries, list) or not entries:
        return False
    entry_tokens = set()
    for entry in entries:
        if not isinstance(entry, str) or not entry:
            continue
        cleaned = entry.strip()
        entry_tokens.add(cleaned)
        entry_tokens.add(os.path.basename(os.path.normpath(cleaned)))
        if cleaned.startswith("-m "):
            entry_tokens.add(cleaned[3:].strip())
        elif cleaned.startswith("module:"):
            entry_tokens.add(cleaned[7:].strip())
    entry_tokens.discard("")
    if not entry_tokens:
        return False
    exe_base = os.path.basename(argv[0])
    if exe_base in entry_tokens or argv[0] in entry_tokens:
        return True
    if _is_python_basename(exe_base):
        parsed = _parse_python_argv(argv, 1)
        for cand in (parsed["script"], parsed["module"]):
            if isinstance(cand, str) and (cand in entry_tokens or os.path.basename(os.path.normpath(cand)) in entry_tokens):
                return True
        return False
    # For launchers (torchrun/accelerate/deepspeed/uv/conda/bash/srun/yolo/ray/etc.)
    if exe_base.lower() in _ML_LAUNCHERS:
        if exe_base.lower() in ("bash", "sh", "zsh") and len(argv) >= 3 and argv[1] in ("-c", "-lc"):
            cmd_text = argv[2]
            for tok in entry_tokens:
                if len(tok) >= 3 and re.search(r"(?:^|[\s/'\"=])" + re.escape(tok) + r"(?:$|[\s'\"|;&])", cmd_text):
                    return True
            return False
        nested = _extract_nested_script(argv[1:])
        if isinstance(nested, str) and (nested in entry_tokens or os.path.basename(os.path.normpath(nested)) in entry_tokens):
            return True
    for tok in argv[1:]:
        if tok in entry_tokens or (("/" in tok or tok.endswith(".py") or tok.endswith(".sh")) and os.path.basename(os.path.normpath(tok)) in entry_tokens):
            # Only treat positional tokens as coarse candidates; project_task_process verifies exact operand semantics.
            if not tok.startswith("-"):
                return True
    return False


def launcher_entry_candidate(script, entries, host_roots, task_directories, verify_content=False):
    """Return the registered entry path whose bare filename matches script inside task scope."""
    if not isinstance(entries, list) or not entries or not isinstance(script, str):
        return None
    name = os.path.basename(script)
    if not _registered_entry_name_matches(name, entries):
        return None
    root = task_directories[0] if isinstance(task_directories, list) and task_directories else None
    if not isinstance(root, str):
        return None
    hosts, tasks = _canonical_task_roots(host_roots, task_directories)
    for entry in entries:
        if not isinstance(entry, str) or os.path.basename(os.path.normpath(entry)) != name:
            continue
        path = os.path.normpath(entry if os.path.isabs(entry) else os.path.join(root, entry))
        if hosts is None or not verify_content:
            return path
        if _path_in_scope(os.path.realpath(path), hosts, tasks):
            return path
    return None


def target_writer_fds(proc_dir, source_identities, max_fds=None):
    """Stream-scan process FDs for target log writers up to max_fds (default 4096) without stalling."""
    limit = MAX_FDS_PER_PROCESS if max_fds is None else max(1, int(max_fds))
    handles, seen, complete, fds_seen, truncated = [], set(), True, 0, False
    if not source_identities:
        return handles, True, False
    # Build fast lookup maps by both canonical path and (dev, inode).
    by_inode = {}
    for src_path, obs in source_identities.items():
        ident = obs.get("fileIdentity") if isinstance(obs, dict) else None
        if isinstance(ident, dict) and ident.get("dev") and ident.get("inode"):
            by_inode[(str(ident["dev"]), str(ident["inode"]))] = src_path
    fd_dir = os.path.join(proc_dir, "fd")
    try:
        iterator = os.scandir(fd_dir)
    except PermissionError:
        return handles, False, False
    except OSError:
        return handles, False, False
    try:
        for entry in iterator:
            fds_seen += 1
            if fds_seen > limit:
                truncated = True
                break
            if not entry.name.isdecimal():
                continue
            name = entry.name
            fd_path = os.path.join(fd_dir, name)
            matched_target = None
            try:
                st = os.stat(fd_path)
                matched_target = by_inode.get((str(st.st_dev), str(st.st_ino)))
            except OSError:
                matched_target = None
            if matched_target is None:
                try:
                    real = os.path.realpath(fd_path)
                    if real in source_identities:
                        matched_target = real
                except OSError:
                    continue
            if matched_target is None:
                continue
            try:
                with open(os.path.join(proc_dir, "fdinfo", name), "r", encoding="ascii", errors="strict") as stream:
                    flags = parse_fdinfo_flags(stream.read(4097))
            except (OSError, ValueError, UnicodeError):
                complete = False
                continue
            if not flags.get("complete"):
                complete = False
                continue
            access = int(flags["flagsLine"].split(":", 1)[1].strip(), 8) & getattr(os, "O_ACCMODE", 3)
            if access not in (os.O_WRONLY, os.O_RDWR):
                continue
            if matched_target not in seen:
                seen.add(matched_target)
                handles.append({"fd": name, "path": matched_target, "flagsLine": flags["flagsLine"]})
    finally:
        iterator.close()
    return handles, complete, truncated


def project_task_process(registration, cwd, argv, process_key, writer_targets, launcher_entry=None):
    """Project Python scripts, Python -m modules, ML launchers (torchrun/accelerate/deepspeed/etc.), and binaries."""
    directories = registration.get("allowedDirectories", []) if isinstance(registration, dict) else []
    entries = registration.get("entryPaths", []) if isinstance(registration, dict) else []
    host_roots = registration.get("hostAllowedRoots", []) if isinstance(registration, dict) else []
    sources = registration.get("sourcePaths", []) if isinstance(registration, dict) else []
    argv_strings = [item for item in argv if isinstance(item, str)] if isinstance(argv, list) else []

    exe_raw = argv_strings[0] if argv_strings else ""
    exe_base = os.path.basename(exe_raw).lower()
    script = None
    module_name = None
    interpreter_flags = []
    parse_complete = True
    launcher_command = False

    if _is_python_basename(exe_base):
        parsed = _parse_python_argv(argv_strings, 1)
        script = parsed["script"]
        module_name = parsed["module"]
        interpreter_flags = parsed["interpreterFlags"]
        parse_complete = parsed["parseComplete"]
    elif exe_base in _ML_LAUNCHERS:
        launcher_command = True
        if exe_base in ("bash", "sh", "zsh") and len(argv_strings) >= 3 and argv_strings[1] in ("-c", "-lc"):
            script = _match_shell_command_entry(argv_strings[2], entries)
        else:
            script = _extract_nested_script(argv_strings[1:])
            if script and not ("/" in script or script.endswith(".py") or script.endswith(".sh")):
                # Might be a python module passed to `accelerate launch -m pkg.train` or `torchrun -m pkg.train`.
                if "-m" in argv_strings[1:] or "--module" in argv_strings[1:]:
                    module_name = script
                    script = None
    elif argv_strings:
        # Direct executable binary (e.g. ./train_bin or /opt/bin/trainer)
        script = argv_strings[0]

    def _resolve_entry(value):
        if not isinstance(value, str) or not value:
            return None, None
        raw = os.path.normpath(value) if os.path.isabs(value) else (
            os.path.normpath(os.path.join(cwd, value)) if isinstance(cwd, str) else None
        )
        return raw, (os.path.realpath(raw) if raw else None)

    raw_entry, actual_entry = _resolve_entry(script)
    canonical_entries = []
    registered_modules = set()
    registered_commands = set()
    hosts, tasks = _entry_roots(host_roots, directories)
    for entry in entries:
        if not isinstance(entry, str) or not entry:
            continue
        cleaned = entry.strip()
        if cleaned.startswith("-m "):
            registered_modules.add(cleaned[3:].strip())
            continue
        if cleaned.startswith("module:"):
            registered_modules.add(cleaned[7:].strip())
            continue
        if "/" not in cleaned and not cleaned.endswith(".py") and not cleaned.endswith(".sh"):
            registered_modules.add(cleaned)
            registered_commands.add(cleaned)
        if hosts is not None and tasks is not None:
            candidate = os.path.realpath(cleaned if os.path.isabs(cleaned) else os.path.join(directories[0], cleaned))
            if _path_in_scope(candidate, hosts, tasks, host_only=True):
                canonical_entries.append(candidate)

    exact_script = bool(
        parse_complete
        and actual_entry
        and any(entry in (actual_entry, raw_entry) for entry in canonical_entries)
    )
    exact_module = bool(
        parse_complete
        and module_name
        and (module_name in registered_modules or ("-m " + module_name) in entries)
    )
    exact_command = bool(
        exe_base
        and exe_base in registered_commands
        and isinstance(cwd, str)
        and hosts is not None
        and tasks is not None
        and _path_in_scope(os.path.realpath(cwd), hosts, tasks)
    )
    # Launcher running a registered bare script from within task allowedDirectories
    launcher_script_match = bool(
        launcher_command
        and script
        and not exact_script
        and isinstance(cwd, str)
        and hosts is not None
        and tasks is not None
        and _path_in_scope(os.path.realpath(cwd), hosts, tasks)
        and _registered_entry_name_matches(os.path.basename(script), entries)
    )

    exact_entry = exact_script or exact_module or exact_command or launcher_script_match
    if launcher_entry is True:
        first = entries[0] if entries else None
        launcher_entry = (
            os.path.realpath(first if os.path.isabs(first) else os.path.join(directories[0], first))
            if isinstance(first, str) and isinstance(directories[0], str)
            else None
        )
    launcher_entry = (
        launcher_entry
        if (
            not exact_entry
            and parse_complete
            and isinstance(launcher_entry, str)
            and _registered_entry_name_matches(script, entries)
            and any(target in sources for target in writer_targets)
        )
        else None
    )
    writer_matches = [target for target in writer_targets if target in sources]
    key_ok = (
        isinstance(process_key, dict)
        and bool(process_key.get("hostBootId"))
        and isinstance(process_key.get("pid"), int)
        and bool(process_key.get("startTicks"))
    )
    verified = exact_entry or bool(launcher_entry)
    resolved_script_entry = (
        actual_entry if exact_script
        else (os.path.realpath(os.path.join(directories[0], os.path.basename(script))) if launcher_script_match and directories else None)
        or (("module:" + module_name) if exact_module else None)
        or (exe_raw if exact_command else None)
    )
    return {
        "confirmed": bool(verified and writer_matches and key_ok),
        "role": "unknown",
        "processKey": process_key if key_ok else None,
        "writerSources": writer_matches if verified and key_ok else [],
        "cwd": cwd if verified and key_ok else None,
        "scriptEntry": resolved_script_entry if exact_entry else None,
        "launcherEntry": launcher_entry,
        "moduleName": module_name,
        "entryVerified": verified,
        "interpreterFlags": interpreter_flags[:16],
        "parseComplete": parse_complete,
        "evidenceComplete": bool(key_ok and verified),
    }


def _match_shell_command_entry(cmd_text, entries):
    """Extract a registered script path/name mentioned inside a `bash -c '...'` command."""
    if not isinstance(cmd_text, str) or not isinstance(entries, list):
        return None
    for entry in entries:
        if not isinstance(entry, str) or not entry:
            continue
        base = os.path.basename(os.path.normpath(entry))
        for token in (entry, base):
            if token and re.search(r"(?:^|[\s'\"=])" + re.escape(token) + r"(?:$|[\s'\"|;&])", cmd_text):
                return entry
    return None


def parse_fdinfo_flags(contents):
    """Return only the bounded flags field; reject partial or ambiguous fdinfo."""
    if not isinstance(contents, str) or len(contents) > 4096:
        return {"flagsLine": None, "complete": False}
    lines = contents.splitlines()
    matches = [line for line in lines if line.startswith("flags:")]
    if len(matches) != 1 or (contents and not contents.endswith("\n")):
        return {"flagsLine": None, "complete": False}
    line = matches[0]
    if not re.fullmatch(r"flags:\s*[0-7]+\s*", line):
        return {"flagsLine": None, "complete": False}
    return {"flagsLine": line, "complete": True}


def fd_writable_evidence(flags_line, fd_identity, source_identity, expected_process, before_process, after_process):
    """Check a bounded fdinfo flags field and stable process/source identities."""
    if not isinstance(flags_line, str) or not isinstance(fd_identity, dict) or fd_identity != source_identity:
        return {"verified": False, "complete": False, "errorCode": "WRITER_IDENTITY_UNKNOWN"}
    match = re.fullmatch(r"flags:\s*([0-7]+)\s*", flags_line.strip())
    if not match or expected_process != before_process or expected_process != after_process:
        return {"verified": False, "complete": False, "errorCode": "WRITER_RELATION_UNSTABLE"}
    flags = int(match.group(1), 8)
    if flags & getattr(os, "O_ACCMODE", 3) not in (os.O_WRONLY, os.O_RDWR):
        return {"verified": False, "complete": True, "errorCode": "FD_NOT_WRITABLE"}
    return {"verified": True, "complete": True, "errorCode": None}


def bound_candidate_result(candidates, limit=64):
    if len(candidates) > limit:
        return {"scanComplete": False, "errorCode": "PROCESS_CANDIDATE_LIMIT", "candidates": candidates[:limit]}
    return {"scanComplete": True, "errorCode": None, "candidates": candidates}


def _proc_identity_and_stat(proc_root, pid, boot_id):
    stat_path = os.path.join(proc_root, str(pid), "stat")
    with open(stat_path, "r", encoding="ascii", errors="strict") as stream:
        parsed = parse_proc_stat_fields(stream.read(4096))
    if not parsed or not boot_id:
        return None, None
    return {"bootId": boot_id, "pid": pid, "startTicks": parsed["startTicks"]}, parsed


def _proc_identity(proc_root, pid, boot_id):
    ident, _ = _proc_identity_and_stat(proc_root, pid, boot_id)
    return ident


def _compute_proc_cpu_pct(pid, start_ticks, cpu_ticks, now_mono):
    """Compute per-process CPU percentage (% of one CPU) from delta ticks across polls."""
    global _PREV_PROC_CPU
    try:
        hz = os.sysconf("SC_CLK_TCK")
        if not isinstance(hz, int) or hz <= 0:
            return None
    except (AttributeError, OSError, ValueError):
        hz = 100
    cache_key = (pid, start_ticks)
    prev = _PREV_PROC_CPU.get(cache_key)
    _PREV_PROC_CPU[cache_key] = (now_mono, cpu_ticks)
    if len(_PREV_PROC_CPU) > 1024:
        # Evict oldest entries to remain bounded.
        for k in list(_PREV_PROC_CPU)[:512]:
            if k != cache_key:
                _PREV_PROC_CPU.pop(k, None)
    if prev is None:
        return None
    dt = now_mono - prev[0]
    if dt <= 0:
        return None
    d_ticks = cpu_ticks - prev[1]
    if d_ticks < 0:
        return None
    return round((d_ticks / hz) / dt * 100.0, 2)


def _page_size():
    try:
        return os.sysconf("SC_PAGE_SIZE")
    except (AttributeError, OSError, ValueError):
        return 4096


def scan_registered_processes(
    proc_root="/proc",
    boot_id=None,
    task=None,
    max_processes=MAX_PROCESSES,
    time_budget=SCAN_BUDGET_SECONDS,
    max_fds=None,
):
    started = time.monotonic()
    budget = max(0.0, min(float(time_budget), MAX_SCAN_BUDGET_SECONDS))
    if not boot_id:
        return {"scanComplete": False, "errorCode": "PROC_UNAVAILABLE", "candidates": []}
    try:
        iterator = os.scandir(proc_root)
    except OSError:
        return {"scanComplete": False, "errorCode": "PROC_UNAVAILABLE", "candidates": []}
    cap = max(0, min(int(max_processes), MAX_PROCESSES))
    scan_complete = True
    inspected = 0
    getuid = getattr(os, "getuid", None)
    current_uid = getuid() if callable(getuid) else None
    if current_uid is None:
        scan_complete = False
    registration = task if isinstance(task, dict) else {}
    allow_cross_uid = bool(registration.get("allowCrossUidScan") is True)
    raw_sources = registration.get("sources", [])
    sources = raw_sources[:64] if isinstance(raw_sources, list) else []
    if isinstance(raw_sources, list) and len(raw_sources) > 64:
        scan_complete = False
    source_paths = [
        item.get("resolvedPath") or item.get("path")
        for item in sources
        if isinstance(item, dict) and item.get("kind") == "log" and isinstance(item.get("resolvedPath") or item.get("path"), str)
    ]
    source_identities = {}
    source_witness_complete = True
    source_observations = registration.get("sourceObservations", {})
    host_roots = registration.get("hostAllowedRoots", [])
    task_dirs = registration.get("allowedDirectories", [])
    entries = registration.get("entryPaths", [])
    process_hosts, process_tasks = _canonical_task_roots(host_roots, task_dirs)

    for source in sources:
        if time.monotonic() - started > budget:
            scan_complete = False
            source_witness_complete = False
            break
        if isinstance(source, dict) and source.get("kind") == "log":
            src_path = source.get("resolvedPath") or source.get("path")
            if not isinstance(src_path, str):
                continue
            if source.get("observationErrorCode") == "SOURCE_MISSING":
                continue
            expected = source_observations.get(src_path) if isinstance(source_observations, dict) else None
            if (
                not isinstance(expected, dict)
                or not isinstance(expected.get("fileIdentity"), dict)
                or not isinstance(expected.get("eofBytes"), str)
                or not expected["eofBytes"].isdecimal()
            ):
                scan_complete = False
                source_witness_complete = False
                continue
            opened = open_readonly(src_path, host_roots, task_dirs, limit_bytes=0)
            # Fix eofBytes race: active logs grow while scanning. Only require same inode and non-shrinking size.
            if (
                opened.get("status") == "ok"
                and opened.get("identity") == expected["fileIdentity"]
                and isinstance(opened.get("sizeBytes"), str)
                and opened["sizeBytes"].isdecimal()
                and int(opened["sizeBytes"]) >= int(expected["eofBytes"])
            ):
                source_identities[src_path] = {
                    "fileIdentity": expected["fileIdentity"],
                    "eofBytes": expected["eofBytes"],
                    "observedSizeBytes": opened["sizeBytes"],
                }
            else:
                scan_complete = False
                source_witness_complete = False

    # Pass 1: fast lightweight cmdline scan without touching cwd/realpath on unrelated processes.
    matched_raw = []
    tree_index = {}  # pid -> {ppid, pgid, startTicks, argv, proc_dir, uid}
    all_pids_meta = []  # for tree expansion only when we have matches
    try:
        for entry in iterator:
            if not entry.name.isdecimal():
                continue
            if time.monotonic() - started > budget:
                scan_complete = False
                break
            try:
                owner_uid = entry.stat(follow_symlinks=False).st_uid
            except FileNotFoundError:
                continue
            except PermissionError:
                # Tolerate hidepid/EACCES on foreign processes.
                continue
            except OSError:
                scan_complete = False
                continue
            if not allow_cross_uid and current_uid is not None and owner_uid != current_uid:
                continue
            inspected += 1
            if inspected > cap:
                scan_complete = False
                break
            pid = int(entry.name)
            proc_dir = os.path.join(proc_root, str(pid))
            cmdline_path = os.path.join(proc_dir, "cmdline")
            try:
                prefix = _read_script_argv_prefix(cmdline_path)
            except FileNotFoundError:
                continue
            except PermissionError:
                continue
            except OSError:
                continue
            argv = prefix.get("argv", [])
            if not argv:
                continue
            all_pids_meta.append((pid, proc_dir, argv, owner_uid))
            if _argv_coarse_matches_registration(argv, entries):
                matched_raw.append((pid, proc_dir, argv, owner_uid))
    finally:
        iterator.close()

    # Build parent/child & PGID index only for processes if we found any matched root/worker!
    matched_pids = {pid for pid, _, _, _ in matched_raw}
    matched_pgids = set()
    stat_by_pid = {}

    def _get_stat(pid, proc_dir):
        if pid in stat_by_pid:
            return stat_by_pid[pid]
        try:
            ident, fields = _proc_identity_and_stat(proc_root, pid, boot_id)
        except (OSError, ValueError, UnicodeError):
            return None
        if not ident or not fields:
            return None
        stat_by_pid[pid] = (ident, fields)
        return ident, fields

    for pid, proc_dir, _argv, _uid in matched_raw:
        res = _get_stat(pid, proc_dir)
        if res:
            _, fields = res
            if fields.get("pgid") and fields["pgid"] > 0:
                matched_pgids.add(fields["pgid"])

    # Discover descendant workers (DataLoader / DDP rank children) and same-PGID tee pipes.
    tree_children = []
    pipe_writer_sources = {}  # pgid -> {source_path: evidence}
    if matched_pids and len(all_pids_meta) <= cap:
        # Collect stat info for other same-user processes only when we have a match and budget allows.
        children_by_ppid = {}
        proc_meta_by_pid = {}
        for pid, proc_dir, argv, owner_uid in all_pids_meta:
            proc_meta_by_pid[pid] = (proc_dir, argv, owner_uid)
            if pid in matched_pids:
                continue
            if time.monotonic() - started > budget:
                break
            res = _get_stat(pid, proc_dir)
            if not res:
                continue
            _, fields = res
            ppid = fields.get("ppid")
            pgid = fields.get("pgid")
            if ppid is not None:
                children_by_ppid.setdefault(ppid, []).append(pid)
            # Check same-PGID pipeline writer (e.g. `| tee train.log`).
            exe_base = os.path.basename(argv[0]).lower()
            if pgid in matched_pgids and exe_base in ("tee", "cat", "logger", "rotatelogs", "multilog") and source_identities:
                fd_handles, _, _ = target_writer_fds(proc_dir, source_identities, max_fds=max_fds)
                for h in fd_handles:
                    target = h["path"]
                    if target in source_identities:
                        pipe_writer_sources.setdefault(pgid, {})[target] = {
                            "fileIdentity": source_identities[target]["fileIdentity"],
                            "eofBytes": source_identities[target]["eofBytes"],
                        }

        # BFS from matched_pids down ppid links to capture DDP rank / DataLoader children.
        queue = list(matched_pids)
        visited = set(matched_pids)
        while queue and len(visited) < 64:
            parent_pid = queue.pop(0)
            for child_pid in children_by_ppid.get(parent_pid, []):
                if child_pid in visited:
                    continue
                visited.add(child_pid)
                queue.append(child_pid)
                c_dir, c_argv, c_uid = proc_meta_by_pid[child_pid]
                tree_children.append((child_pid, c_dir, c_argv, c_uid, parent_pid))

    candidates = []
    now_mono = time.monotonic()
    page_sz = _page_size()
    projection_registration = {
        "hostAllowedRoots": host_roots,
        "allowedDirectories": task_dirs,
        "entryPaths": entries,
        "sourcePaths": source_paths,
    }

    def _inspect_candidate(pid, proc_dir, argv, is_tree_child=False, parent_pid=None):
        nonlocal scan_complete
        if len(candidates) >= 64:
            scan_complete = False
            return
        try:
            cwd = os.path.realpath(os.path.join(proc_dir, "cwd"))
        except (PermissionError, FileNotFoundError):
            cwd = None
        except OSError:
            cwd = None

        projected_pre = project_task_process(projection_registration, cwd, argv, None, [])
        entry_name_candidate = (
            not is_tree_child
            and launcher_entry_candidate(_script_operand(argv), entries, host_roots, task_dirs, verify_content=False) is not None
        )
        if not is_tree_child and not projected_pre["entryVerified"] and not entry_name_candidate:
            return

        stat_res = _get_stat(pid, proc_dir)
        if not stat_res:
            if not is_tree_child:
                scan_complete = False
            return
        first, stat_fields = stat_res
        try:
            exe_real = os.path.realpath(os.path.join(proc_dir, "exe"))
        except OSError:
            exe_real = argv[0] if argv else None

        process_key = {"hostBootId": boot_id, "pid": pid, "startTicks": first["startTicks"]}
        launcher_entry = (
            None if (is_tree_child or projected_pre["entryVerified"])
            else launcher_entry_candidate(_script_operand(argv), entries, host_roots, task_dirs, verify_content=True)
        )
        writer_targets = []
        writer_evidence = {}
        writer_evidence_complete = True
        fd_scan_truncated = False

        if source_identities:
            fd_handles, fd_scan_complete, fd_scan_truncated = target_writer_fds(proc_dir, source_identities, max_fds=max_fds)
            if not fd_scan_complete:
                if not is_tree_child:
                    scan_complete = False
                writer_evidence_complete = False
            for handle in fd_handles:
                target = handle["path"]
                if target is None or target not in source_identities:
                    if not is_tree_child:
                        scan_complete = False
                    writer_evidence_complete = False
                    continue
                try:
                    first_fd = os.stat(os.path.join(proc_dir, "fd", handle["fd"]))
                    second_fd = os.stat(os.path.join(proc_dir, "fd", handle["fd"]))
                    after_process = _proc_identity(proc_root, pid, boot_id)
                    relation = fd_writable_evidence(
                        handle["flagsLine"],
                        _identity(first_fd),
                        source_identities[target]["fileIdentity"],
                        first,
                        {"bootId": boot_id, "pid": pid, "startTicks": first["startTicks"]},
                        after_process,
                    )
                    current_source = open_readonly(target, host_roots, task_dirs, limit_bytes=0)
                    # Active log growth is normal: verify same inode and size >= initial observation.
                    source_stable = (
                        current_source.get("status") == "ok"
                        and current_source.get("identity") == source_identities[target]["fileIdentity"]
                        and isinstance(current_source.get("sizeBytes"), str)
                        and current_source["sizeBytes"].isdecimal()
                        and int(current_source["sizeBytes"]) >= int(source_identities[target]["eofBytes"])
                    )
                    fd_stable = _same_identity(first_fd, second_fd)
                except (OSError, ValueError, UnicodeError):
                    if not is_tree_child:
                        scan_complete = False
                    writer_evidence_complete = False
                    continue
                if relation["verified"] and fd_stable and source_stable:
                    writer_targets.append(target)
                    writer_evidence[target] = {
                        "fileIdentity": source_identities[target]["fileIdentity"],
                        "eofBytes": source_identities[target]["eofBytes"],
                    }
                else:
                    if not is_tree_child:
                        scan_complete = False
                    writer_evidence_complete = False

        # Inherit same-PGID pipeline writer evidence (e.g. `python train.py | tee train.log`).
        pgid = stat_fields.get("pgid")
        if pgid in pipe_writer_sources:
            for target, ev in pipe_writer_sources[pgid].items():
                if target not in writer_targets:
                    writer_targets.append(target)
                    writer_evidence[target] = ev

        second = _proc_identity(proc_root, pid, boot_id)
        if second != first:
            if not is_tree_child:
                scan_complete = False
            return

        projected = project_task_process(projection_registration, cwd, argv, process_key, writer_targets, launcher_entry)
        ns_pid = _read_nspid(proc_dir)
        rss_pages = stat_fields.get("rssPages")
        rss_bytes = (rss_pages * page_sz) if isinstance(rss_pages, int) and rss_pages >= 0 else None
        cpu_pct = _compute_proc_cpu_pct(pid, first["startTicks"], stat_fields["utime"] + stat_fields["stime"], now_mono)

        if is_tree_child:
            candidates.append({
                "processKey": process_key,
                "role": "worker",
                "ppid": stat_fields.get("ppid"),
                "pgid": pgid,
                "nsPid": ns_pid,
                "parentPid": parent_pid,
                "writerSources": [t for t in writer_targets if t in source_paths],
                "writerSourceEvidence": writer_evidence,
                "cwd": cwd,
                "scriptEntry": projected.get("scriptEntry"),
                "launcherEntry": projected.get("launcherEntry"),
                "exe": exe_real,
                "command": " ".join(argv)[:512],
                "interpreterFlags": projected.get("interpreterFlags", []),
                "evidenceComplete": True,
                "writerEvidenceComplete": writer_evidence_complete and source_witness_complete,
                "fdScanTruncated": fd_scan_truncated,
                "rssBytes": rss_bytes,
                "cpuPercent": cpu_pct,
                "treeMember": True,
            })
        elif projected["entryVerified"]:
            candidates.append({
                "processKey": projected["processKey"],
                "role": "unknown",
                "ppid": stat_fields.get("ppid"),
                "pgid": pgid,
                "nsPid": ns_pid,
                "parentPid": stat_fields.get("ppid"),
                "writerSources": projected["writerSources"],
                "writerSourceEvidence": writer_evidence,
                "cwd": projected["cwd"],
                "scriptEntry": projected["scriptEntry"],
                "launcherEntry": projected.get("launcherEntry"),
                "exe": exe_real,
                "command": " ".join(argv)[:512],
                "interpreterFlags": projected["interpreterFlags"],
                "evidenceComplete": projected["evidenceComplete"],
                "writerEvidenceComplete": writer_evidence_complete and source_witness_complete,
                "fdScanTruncated": fd_scan_truncated,
                "rssBytes": rss_bytes,
                "cpuPercent": cpu_pct,
                "treeMember": False,
            })

    for pid, proc_dir, argv, _uid in matched_raw:
        if time.monotonic() - started > budget:
            scan_complete = False
            break
        try:
            _inspect_candidate(pid, proc_dir, argv, is_tree_child=False)
        except (OSError, ValueError, UnicodeError):
            scan_complete = False

    # Build parentKey map for tree children and promote root vs child roles cleanly.
    key_by_pid = {c["processKey"]["pid"]: c["processKey"] for c in candidates if isinstance(c.get("processKey"), dict)}
    for child_pid, child_dir, child_argv, _uid, parent_pid in tree_children:
        if time.monotonic() - started > budget or len(candidates) >= 64:
            break
        try:
            _inspect_candidate(child_pid, child_dir, child_argv, is_tree_child=True, parent_pid=parent_pid)
        except (OSError, ValueError, UnicodeError):
            continue

    # Propagate writer evidence from child ranks up to parent launcher if parent shares same tree/pgid
    # (e.g. torchrun spawns rank workers that directly open/write the log file).
    if len(candidates) > 1:
        tree_writers = {}
        for c in candidates:
            for src in c.get("writerSources", []):
                if src in c.get("writerSourceEvidence", {}):
                    tree_writers[src] = c["writerSourceEvidence"][src]
        for c in candidates:
            pid = c["processKey"]["pid"] if isinstance(c.get("processKey"), dict) else None
            ppid = c.get("ppid")
            if ppid in key_by_pid:
                c["parentKey"] = key_by_pid[ppid]
            else:
                c["parentKey"] = None
            if not c.get("treeMember") and not c.get("writerSources") and tree_writers:
                # Only propagate within the same process tree (descendant or same PGID).
                c_pgid = c.get("pgid")
                has_tree_writer = any(
                    other is not c and other.get("writerSources") and (
                        other.get("parentPid") == pid or other.get("ppid") == pid or (c_pgid and other.get("pgid") == c_pgid)
                    )
                    for other in candidates
                )
                if has_tree_writer:
                    c["writerSources"] = list(tree_writers.keys())
                    c["writerSourceEvidence"] = dict(tree_writers)

    if time.monotonic() - started > budget:
        scan_complete = False
    bounded = bound_candidate_result(candidates, min(64, cap))
    scan_complete = scan_complete and bounded["scanComplete"]
    return {
        "scanComplete": scan_complete,
        "errorCode": None if scan_complete else (bounded["errorCode"] or "PROC_SCAN_INCOMPLETE"),
        "candidates": bounded["candidates"],
    }


def _extract_step_from_name(name):
    if not isinstance(name, str) or not name:
        return None
    # Match Lightning `epoch=3-step=1500.ckpt`, HF `checkpoint-1500`, DeepSpeed `global_step1500`, `iter_500`, `step_1000.pt`
    for pattern in (
        r"(?:^|[._=-])(?:global_step|step|iter|checkpoint|ckpt)[=_-]?(\d+)(?:[._-]|$)",
        r"(?:^|[._=-])epoch[=_-]?(\d+)(?:[._-]|$)",
    ):
        match = re.search(pattern, name, re.IGNORECASE)
        if match:
            try:
                return int(match.group(1))
            except ValueError:
                return None
    return None


def _read_checkpoint_metadata(directory, host_roots, task_dirs):
    """Read optional framework pointer/metadata files (HF trainer_state.json, Megatron/DeepSpeed latest)."""
    meta = {}
    step = None
    pointer_target = None

    trainer_state_path = os.path.join(directory, "trainer_state.json")
    if os.path.isfile(trainer_state_path):
        opened = open_readonly(trainer_state_path, host_roots, task_dirs, limit_bytes=MAX_STATUS_BYTES)
        if opened.get("status") == "ok":
            try:
                parsed = json.loads(opened["data"].decode("utf-8"))
                if isinstance(parsed, dict):
                    if isinstance(parsed.get("global_step"), int):
                        step = parsed["global_step"]
                        meta["global_step"] = step
                    if isinstance(parsed.get("epoch"), (int, float)):
                        meta["epoch"] = float(parsed["epoch"])
                    if isinstance(parsed.get("max_steps"), int):
                        meta["max_steps"] = parsed["max_steps"]
                    if isinstance(parsed.get("best_metric"), (int, float)):
                        meta["best_metric"] = float(parsed["best_metric"])
                    if isinstance(parsed.get("best_model_checkpoint"), str):
                        meta["best_model_checkpoint"] = parsed["best_model_checkpoint"]
            except (UnicodeDecodeError, ValueError):
                pass

    for ptr_name in ("latest_checkpointed_iteration.txt", "latest"):
        ptr_path = os.path.join(directory, ptr_name)
        if os.path.isfile(ptr_path):
            opened = open_readonly(ptr_path, host_roots, task_dirs, limit_bytes=4096)
            if opened.get("status") == "ok":
                content = opened["data"].decode("utf-8", "replace").strip()
                if content:
                    meta[ptr_name] = content[:128]
                    if content.isdecimal():
                        if step is None:
                            step = int(content)
                        pointer_target = "iter_" + content.zfill(7)
                    else:
                        pointer_target = content
                        extracted = _extract_step_from_name(content)
                        if step is None and extracted is not None:
                            step = extracted
    return step, meta or None, pointer_target


def _directory_checkpoint_stats(dir_path, host_roots, task_dirs):
    """Compute bounded aggregate size, file count, and latest mtime for a directory checkpoint."""
    total_bytes = 0
    file_count = 0
    max_mtime_ns = 0
    has_marker = False
    truncated = False
    try:
        dir_stat = os.stat(dir_path, follow_symlinks=False)
        max_mtime_ns = dir_stat.st_mtime_ns
    except OSError:
        return None

    stack = [(dir_path, 0)]
    while stack:
        current, depth = stack.pop()
        try:
            with os.scandir(current) as it:
                for entry in it:
                    if file_count >= MAX_CHECKPOINT_FILES:
                        truncated = True
                        break
                    try:
                        info = entry.stat(follow_symlinks=False)
                    except OSError:
                        continue
                    if stat.S_ISDIR(info.st_mode) and depth < 2:
                        stack.append((entry.path, depth + 1))
                    elif stat.S_ISREG(info.st_mode):
                        file_count += 1
                        total_bytes += info.st_size
                        if info.st_mtime_ns > max_mtime_ns:
                            max_mtime_ns = info.st_mtime_ns
                        ext = os.path.splitext(entry.name)[1].lower()
                        if entry.name in _CHECKPOINT_DIR_MARKERS or ext in _CHECKPOINT_FILE_EXTS or entry.name.startswith(("mp_rank_", "zero_pp_rank_")):
                            has_marker = True
        except OSError:
            continue
        if truncated:
            break

    step_meta, meta, _ = _read_checkpoint_metadata(dir_path, host_roots, task_dirs)
    return {
        "totalBytes": total_bytes,
        "fileCount": file_count,
        "mtimeNs": max_mtime_ns,
        "identity": _identity(dir_stat),
        "hasMarker": has_marker,
        "stepMeta": step_meta,
        "metadata": meta,
        "truncated": truncated,
    }


def scan_checkpoints(checkpoint_dirs, host_roots, task_dirs, time_budget=0.5):
    """Scan single-file and sharded directory checkpoints bounded by time and entry limits."""
    started = time.monotonic()
    if not isinstance(checkpoint_dirs, list) or not checkpoint_dirs:
        return {"scanComplete": True, "checkpoint": None, "errorCode": None}
    hosts, tasks = _canonical_task_roots(host_roots, task_dirs)
    if hosts is None:
        return {"scanComplete": False, "checkpoint": None, "errorCode": "TASK_ROOT_OUTSIDE_HOST_ROOT"}

    best = None
    scan_complete = True
    seen_entries = 0

    for raw_dir in checkpoint_dirs[:16]:
        if time.monotonic() - started > time_budget:
            scan_complete = False
            break
        if not isinstance(raw_dir, str) or not raw_dir:
            continue
        resolved_dir = os.path.realpath(raw_dir)
        if not _path_in_scope(resolved_dir, hosts, tasks):
            scan_complete = False
            continue
        if not os.path.isdir(resolved_dir):
            continue

        dir_step, dir_meta, pointer_target = _read_checkpoint_metadata(resolved_dir, host_roots, task_dirs)
        try:
            with os.scandir(resolved_dir) as it:
                for entry in it:
                    if time.monotonic() - started > time_budget:
                        scan_complete = False
                        break
                    seen_entries += 1
                    if seen_entries > MAX_CHECKPOINT_ENTRIES:
                        scan_complete = False
                        break
                    try:
                        resolved_item = os.path.realpath(entry.path)
                        if not _path_in_scope(resolved_item, hosts, tasks):
                            continue
                        info = os.stat(resolved_item, follow_symlinks=False)
                    except OSError:
                        continue

                    candidate = None
                    if stat.S_ISREG(info.st_mode):
                        ext = os.path.splitext(entry.name)[1].lower()
                        if ext not in _CHECKPOINT_FILE_EXTS:
                            continue
                        step = _extract_step_from_name(entry.name)
                        candidate = {
                            "path": resolved_item,
                            "name": entry.name,
                            "isDirectory": False,
                            "fileCount": 1,
                            "sizeBytes": str(info.st_size),
                            "mtimeNs": info.st_mtime_ns,
                            "fileIdentity": _identity(info),
                            "fileStepIndex": step,
                            "stepSource": "filename" if step is not None else None,
                            "metadata": None,
                            "isPointerTarget": bool(pointer_target and entry.name == pointer_target),
                        }
                    elif stat.S_ISDIR(info.st_mode):
                        name_matches = bool(_CHECKPOINT_DIR_RE.fullmatch(entry.name)) or (pointer_target == entry.name)
                        stats = _directory_checkpoint_stats(resolved_item, host_roots, task_dirs)
                        if not stats:
                            continue
                        if not name_matches and not stats["hasMarker"]:
                            continue
                        if stats["truncated"]:
                            scan_complete = False
                        step = stats["stepMeta"] if stats["stepMeta"] is not None else _extract_step_from_name(entry.name)
                        step_source = "metadata" if stats["stepMeta"] is not None else ("filename" if step is not None else None)
                        candidate = {
                            "path": resolved_item,
                            "name": entry.name,
                            "isDirectory": True,
                            "fileCount": stats["fileCount"],
                            "sizeBytes": str(stats["totalBytes"]),
                            "mtimeNs": stats["mtimeNs"],
                            "fileIdentity": stats["identity"],
                            "fileStepIndex": step,
                            "stepSource": step_source,
                            "metadata": stats["metadata"],
                            "isPointerTarget": bool(pointer_target and entry.name == pointer_target),
                        }
                    if candidate is not None:
                        cand_rank = (
                            1 if candidate["isPointerTarget"] else 0,
                            candidate["mtimeNs"],
                            candidate["fileStepIndex"] if candidate["fileStepIndex"] is not None else -1,
                            candidate["path"],
                        )
                        if best is None or cand_rank > best[0]:
                            best = (cand_rank, candidate)
        except OSError:
            scan_complete = False
            continue

        # If no subdir/file matched, check if the directory itself is a single checkpoint dir (e.g. trainer_state.json).
        if best is None and (dir_step is not None or dir_meta):
            stats = _directory_checkpoint_stats(resolved_dir, host_roots, task_dirs)
            if stats and stats["hasMarker"]:
                candidate = {
                    "path": resolved_dir,
                    "name": os.path.basename(resolved_dir),
                    "isDirectory": True,
                    "fileCount": stats["fileCount"],
                    "sizeBytes": str(stats["totalBytes"]),
                    "mtimeNs": stats["mtimeNs"],
                    "fileIdentity": stats["identity"],
                    "fileStepIndex": dir_step,
                    "stepSource": "metadata" if dir_step is not None else None,
                    "metadata": dir_meta,
                    "isPointerTarget": False,
                }
                best = ((0, stats["mtimeNs"], dir_step if dir_step is not None else -1, resolved_dir), candidate)

    if best is None:
        return {"scanComplete": scan_complete, "checkpoint": None, "errorCode": None}

    chosen = best[1]
    mtime_iso = datetime.datetime.fromtimestamp(chosen["mtimeNs"] / 1_000_000_000, tz=datetime.timezone.utc).isoformat().replace("+00:00", "Z")
    return {
        "scanComplete": scan_complete,
        "errorCode": None,
        "checkpoint": {
            "path": chosen["path"],
            "name": chosen["name"],
            "isDirectory": chosen["isDirectory"],
            "fileCount": chosen["fileCount"],
            "sizeBytes": chosen["sizeBytes"],
            "mtime": mtime_iso,
            "fileIdentity": chosen["fileIdentity"],
            "fileStepIndex": chosen["fileStepIndex"],
            "stepSource": chosen["stepSource"],
            "metadata": chosen["metadata"],
            "scanComplete": scan_complete,
        },
    }


def _run_bounded_command(command, args, timeout_seconds=2.0, max_bytes=MAX_PROCESS_GPU_OUTPUT_BYTES, max_rows=None):
    """Capture a bounded stdout stream without retaining stderr or unbounded output."""
    timeout_seconds = min(max(float(timeout_seconds), 0.0), 2.0)
    deadline = time.monotonic() + timeout_seconds
    child = None
    selector = None
    output = bytearray()
    row_count = 0
    try:
        child = subprocess.Popen([command] + list(args), stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
        if child.stdout is None:
            return None, "NVIDIA_SMI_UNAVAILABLE"
        if os.name == "nt":
            import threading
            state = {"error": None, "done": False}

            def _reader():
                nonlocal row_count
                try:
                    while True:
                        chunk = child.stdout.read(min(8192, max_bytes + 1 - len(output)))
                        if not chunk:
                            break
                        output.extend(chunk)
                        if len(output) > max_bytes:
                            state["error"] = "NVIDIA_SMI_RESPONSE_LIMIT"
                            break
                        if max_rows is not None:
                            row_count += chunk.count(b"\n")
                            if row_count > max_rows:
                                state["error"] = "NVIDIA_SMI_RESPONSE_LIMIT"
                                break
                except OSError:
                    state["error"] = "NVIDIA_SMI_FAILED"
                finally:
                    state["done"] = True

            worker = threading.Thread(target=_reader, daemon=True)
            worker.start()
            worker.join(timeout=max(0.0, deadline - time.monotonic()))
            if not state["done"]:
                return None, "NVIDIA_SMI_TIMEOUT"
            if state["error"]:
                return None, state["error"]
        else:
            selector = selectors.DefaultSelector()
            selector.register(child.stdout, selectors.EVENT_READ)
            while True:
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    return None, "NVIDIA_SMI_TIMEOUT"
                ready = selector.select(min(remaining, 0.05))
                if not ready:
                    if child.poll() is not None:
                        continue
                    continue
                chunk = os.read(child.stdout.fileno(), min(8192, max_bytes + 1 - len(output)))
                if not chunk:
                    break
                output.extend(chunk)
                if len(output) > max_bytes:
                    return None, "NVIDIA_SMI_RESPONSE_LIMIT"
                if max_rows is not None:
                    row_count += chunk.count(b"\n")
                    if row_count > max_rows:
                        return None, "NVIDIA_SMI_RESPONSE_LIMIT"
        if max_rows is not None:
            if output and not output.endswith(b"\n"):
                row_count += 1
            if row_count > max_rows:
                return None, "NVIDIA_SMI_RESPONSE_LIMIT"
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            return None, "NVIDIA_SMI_TIMEOUT"
        try:
            return_code = child.wait(timeout=remaining)
        except subprocess.TimeoutExpired:
            return None, "NVIDIA_SMI_TIMEOUT"
        if return_code != 0:
            return None, "NVIDIA_SMI_FAILED"
        return bytes(output), None
    except OSError:
        return None, "NVIDIA_SMI_UNAVAILABLE"
    finally:
        if selector is not None:
            try:
                selector.close()
            except Exception:
                pass
        if child is not None:
            if child.poll() is None:
                try:
                    child.kill()
                except OSError:
                    pass
                try:
                    child.wait(timeout=0.2)
                except Exception:
                    pass
            if child.stdout is not None:
                try:
                    child.stdout.close()
                except OSError:
                    pass


def _run_bounded_process_command(command, args, timeout_seconds=2.0):
    return _run_bounded_command(
        command,
        args,
        timeout_seconds=timeout_seconds,
        max_bytes=MAX_PROCESS_GPU_OUTPUT_BYTES,
        max_rows=MAX_PROCESS_GPU_ROWS,
    )


def _query_process_gpu_csv():
    executable = _find_nvidia_smi()
    if not executable:
        return None, "NVIDIA_SMI_UNAVAILABLE"
    args = ["--query-compute-apps=pid,gpu_uuid,used_gpu_memory", "--format=csv,noheader,nounits"]
    return _run_bounded_process_command(executable, args, timeout_seconds=2.0)


def _query_gpu_active_processes(proc_root="/proc"):
    """Query active compute apps per GPU UUID for shared-server GPU occupancy visibility."""
    executable = _find_nvidia_smi()
    if not executable:
        return {}
    args = ["--query-compute-apps=pid,gpu_uuid,used_gpu_memory,process_name", "--format=csv,noheader,nounits"]
    output, err = _run_bounded_process_command(executable, args, timeout_seconds=1.5)
    if err or not isinstance(output, bytes):
        return {}
    by_uuid = {}
    for line in output.decode("utf-8", "replace").splitlines()[:MAX_PROCESS_GPU_ROWS]:
        cols = [part.strip() for part in line.split(",")]
        if len(cols) < 3 or not cols[0].isdecimal():
            continue
        pid = int(cols[0])
        uuid = cols[1]
        if not _is_valid_gpu_uuid(uuid):
            continue
        mem_mib = None
        if not _is_missing_gpu_value(cols[2]):
            try:
                val = float(cols[2])
                if val >= 0:
                    mem_mib = round(val, 2)
            except ValueError:
                mem_mib = None
        cmd = cols[3] if len(cols) >= 4 and cols[3] else ""
        user = None
        try:
            st = os.stat(os.path.join(proc_root, str(pid)), follow_symlinks=False)
            if _pwd is not None:
                try:
                    user = _pwd.getpwuid(st.st_uid).pw_name
                except KeyError:
                    user = str(st.st_uid)
            else:
                user = str(st.st_uid)
        except OSError:
            pass
        if not cmd:
            try:
                with open(os.path.join(proc_root, str(pid), "comm"), "r", encoding="utf-8", errors="replace") as s:
                    cmd = s.read(128).strip()
            except OSError:
                cmd = f"pid:{pid}"
        entries = by_uuid.setdefault(uuid, [])
        if len(entries) < 64:
            entries.append({
                "pid": pid,
                "command": cmd[:256],
                "user": user,
                "memoryMiB": mem_mib,
                "smUtilPct": None,
            })
    return by_uuid


def _gpu_device_map(value):
    if not isinstance(value, list) or len(value) > MAX_PROCESS_GPU_DEVICES:
        return None
    by_uuid = {}
    seen_indexes = set()
    for device in value:
        if not isinstance(device, dict) or set(device) != {"uuid", "index"}:
            return None
        uuid = device.get("uuid")
        index = device.get("index")
        if (
            not _is_valid_gpu_uuid(uuid)
            or type(index) is not int or index < 0 or index > 4095
            or uuid in by_uuid or index in seen_indexes
        ):
            return None
        by_uuid[uuid] = "GPU " + str(index)
        seen_indexes.add(index)
    return by_uuid


def _gpu_devices_from_csv(csv_text):
    if not isinstance(csv_text, str) or len(csv_text) > MAX_DEVICE_GPU_OUTPUT_BYTES:
        return []
    devices = []
    seen_indexes = set()
    seen_uuids = set()
    for line in csv_text.splitlines()[:MAX_PROCESS_GPU_DEVICES]:
        parts = [part.strip() for part in line.split(",")]
        if len(parts) < 2 or not parts[0].isdecimal():
            continue
        index = int(parts[0])
        uuid = parts[1]
        if index < 0 or index > 4095 or not _is_valid_gpu_uuid(uuid):
            continue
        if index in seen_indexes or uuid in seen_uuids:
            continue
        seen_indexes.add(index)
        seen_uuids.add(uuid)
        devices.append({"index": index, "uuid": uuid})
    return devices


def _parse_float_or_none(text, *, low=0.0, high=None):
    if _is_missing_gpu_value(text):
        return None
    try:
        value = float(text.strip())
    except ValueError:
        return None
    if value < low or (high is not None and value > high):
        return None
    return value


def _parse_gpu_details_csv(csv_text, active_procs_by_uuid=None):
    """Parse rich GPU telemetry CSV into structured device details + backward-compatible 5-col CSV."""
    active_procs_by_uuid = active_procs_by_uuid or {}
    details = []
    basic_lines = []
    seen_indexes = set()
    seen_uuids = set()
    for line in csv_text.splitlines()[:MAX_PROCESS_GPU_DEVICES]:
        if not line.strip():
            continue
        parts = [part.strip() for part in line.split(",")]
        if len(parts) < 5 or not parts[0].isdecimal():
            continue
        index = int(parts[0])
        uuid = parts[1]
        if index < 0 or index > 4095 or not _is_valid_gpu_uuid(uuid) or index in seen_indexes or uuid in seen_uuids:
            continue
        seen_indexes.add(index)
        seen_uuids.add(uuid)
        util_text, used_text, total_text = parts[2], parts[3], parts[4]
        basic_lines.append(f"{index}, {uuid}, {util_text}, {used_text}, {total_text}")
        detail = {
            "deviceId": f"GPU {index}",
            "index": index,
            "uuid": uuid,
            "utilizationPct": _parse_float_or_none(util_text, low=0.0, high=100.0),
            "memoryUsedMiB": _parse_float_or_none(used_text, low=0.0),
            "memoryTotalMiB": _parse_float_or_none(total_text, low=0.0),
            "memoryFreeMiB": _parse_float_or_none(parts[5], low=0.0) if len(parts) > 5 else None,
            "name": parts[6] if len(parts) > 6 and not _is_missing_gpu_value(parts[6]) else None,
            "temperatureC": _parse_float_or_none(parts[7], low=0.0, high=200.0) if len(parts) > 7 else None,
            "powerDrawW": _parse_float_or_none(parts[8], low=0.0, high=5000.0) if len(parts) > 8 else None,
            "powerLimitW": _parse_float_or_none(parts[9], low=0.0, high=5000.0) if len(parts) > 9 else None,
            "fanSpeedPct": _parse_float_or_none(parts[10], low=0.0, high=100.0) if len(parts) > 10 else None,
            "pciBusId": parts[11] if len(parts) > 11 and not _is_missing_gpu_value(parts[11]) else None,
            "computeMode": parts[12] if len(parts) > 12 and not _is_missing_gpu_value(parts[12]) else None,
            "eccErrors": _parse_float_or_none(parts[13], low=0.0) if len(parts) > 13 else None,
            "activeProcesses": active_procs_by_uuid.get(uuid, []),
        }
        details.append(detail)
    return details, ("\n".join(basic_lines) + ("\n" if basic_lines else ""))


def _process_gpu_candidates(process_rows, boot_id):
    if not isinstance(process_rows, list):
        return None
    if len(process_rows) > 64:
        return None
    candidates = {}
    invalid_pids = set()
    for row in process_rows:
        if not isinstance(row, dict) or row.get("evidenceComplete") is not True:
            continue
        is_tree_worker = row.get("role") == "worker" and row.get("treeMember") is True
        if not is_tree_worker:
            if row.get("roleEvidence") not in ("exact_script_entry", "exact_entry_and_direct_writer_fd", "inferred_tree"):
                continue
            entry = row.get("scriptEntry") if isinstance(row.get("scriptEntry"), str) else row.get("launcherEntry")
            if not isinstance(entry, str) or not entry:
                continue
        key = row.get("processKey")
        if not isinstance(key, dict):
            continue
        pid = key.get("pid")
        start_ticks = key.get("startTicks")
        if (
            key.get("hostBootId") != boot_id
            or type(pid) is not int or pid <= 0
            or not isinstance(start_ticks, str) or not start_ticks.isdecimal()
        ):
            continue
        candidate = {"hostBootId": boot_id, "pid": pid, "startTicks": start_ticks}
        previous = candidates.get(pid)
        if previous is not None and previous != candidate:
            invalid_pids.add(pid)
        else:
            candidates[pid] = candidate
    for pid in invalid_pids:
        candidates.pop(pid, None)
    return candidates


def _process_gpu_payload(status, observed_at=None, error_code=None, samples=None, process_keys=None):
    return {
        "status": status,
        "observedAt": observed_at,
        "errorCode": error_code,
        "samples": samples or [],
        "processKeys": process_keys or [],
    }


def _nvml_process_samples(device_map, allowed_pids, since_us):
    """Optional recent SM counters; return no other process identifiers or details."""
    class UtilizationSample(ctypes.Structure):
        _fields_ = [
            ("pid", ctypes.c_uint), ("timestamp", ctypes.c_ulonglong),
            ("sm", ctypes.c_uint), ("memory", ctypes.c_uint),
            ("encoder", ctypes.c_uint), ("decoder", ctypes.c_uint),
        ]

    library = None
    initialized = False
    result = []
    try:
        library = ctypes.CDLL("libnvidia-ml.so.1")
        initialize = library.nvmlInit_v2
        initialize.restype = ctypes.c_int
        initialize.argtypes = []
        if initialize() != 0:
            return []
        initialized = True
        handle_for_uuid = library.nvmlDeviceGetHandleByUUID
        handle_for_uuid.restype = ctypes.c_int
        handle_for_uuid.argtypes = [ctypes.c_char_p, ctypes.POINTER(ctypes.c_void_p)]
        query = library.nvmlDeviceGetProcessUtilization
        query.restype = ctypes.c_int
        query.argtypes = [ctypes.c_void_p, ctypes.POINTER(UtilizationSample), ctypes.POINTER(ctypes.c_uint), ctypes.c_ulonglong]
        per_gpu_budget = 0.15
        total_budget = max(0.3, min(1.5, per_gpu_budget * max(1, len(device_map))))
        total_deadline = time.monotonic() + total_budget
        for uuid, device_id in device_map.items():
            now_mono = time.monotonic()
            if now_mono > total_deadline:
                break
            device_deadline = min(total_deadline, now_mono + per_gpu_budget)
            handle = ctypes.c_void_p()
            if handle_for_uuid(uuid.encode("ascii"), ctypes.byref(handle)) != 0:
                continue
            count = ctypes.c_uint(0)
            code = query(handle, None, ctypes.byref(count), since_us)
            if code not in (0, 7) or not 0 < count.value <= 2048:
                continue
            capacity = min(2048, max(count.value + 32, count.value * 2))
            buffer = (UtilizationSample * capacity)()
            out_count = ctypes.c_uint(capacity)
            fetch_code = query(handle, buffer, ctypes.byref(out_count), since_us)
            if fetch_code == 7 and time.monotonic() < device_deadline:
                capacity = min(4096, max(out_count.value + 64, capacity * 2))
                buffer = (UtilizationSample * capacity)()
                out_count = ctypes.c_uint(capacity)
                fetch_code = query(handle, buffer, ctypes.byref(out_count), since_us)
            if fetch_code != 0 or out_count.value > capacity:
                continue
            for row in buffer[:out_count.value]:
                if row.pid in allowed_pids:
                    result.append((row.pid, device_id, row.timestamp, row.sm))
        return result
    except (OSError, AttributeError, ValueError, TypeError):
        return []
    finally:
        if initialized and library is not None:
            try:
                library.nvmlShutdown()
            except (OSError, AttributeError, ValueError):
                pass


def _process_gpu_utilization(candidates, device_map, pairs):
    """Exclude buffered samples predating this PID instance or the last 5 seconds."""
    try:
        now_us = time.time_ns() // 1000
        uptime_us = time.clock_gettime_ns(time.CLOCK_BOOTTIME) // 1000
        hz = os.sysconf("SC_CLK_TCK")
        if not isinstance(hz, int) or hz <= 0:
            return {}
        boot_us = now_us - uptime_us
        relevant = {uuid: device for uuid, device in device_map.items() if any(pair[1] == device for pair in pairs)}
        samples = _nvml_process_samples(relevant, set(candidates), max(0, now_us - 5_000_000))
        latest = {}
        upper_bound_us = now_us + CLOCK_SKEW_TOLERANCE_US
        for pid, device_id, timestamp, utilization in samples:
            if pid not in candidates or (pid, device_id) not in pairs:
                continue
            birth_us = boot_us + int(candidates[pid]["startTicks"]) * 1_000_000 // hz
            if (
                type(utilization) is not int or not 0 <= utilization <= 100
                or not max(now_us - 5_000_000, birth_us + 50_000) <= timestamp <= upper_bound_us
            ):
                continue
            old = latest.get((pid, device_id))
            if old is None or timestamp > old[0]:
                latest[(pid, device_id)] = (timestamp, utilization)
        return {pair: value[1] for pair, value in latest.items()}
    except (OSError, AttributeError, ValueError, TypeError, OverflowError):
        return {}


def _sample_process_gpu(proc_root, boot_id, process_rows, gpu_devices, *, allow_cross_uid=False):
    """Attribute aggregate compute-app rows only to stable, verified task PIDs (and container NSpids)."""
    candidates = _process_gpu_candidates(process_rows, boot_id)
    if candidates is None:
        return _process_gpu_payload("unavailable", error_code="PROCESS_GPU_CANDIDATES_INVALID")
    if not candidates:
        if not process_rows:
            return _process_gpu_payload("ok", observed_at=time.time_ns() // 1_000_000)
        return _process_gpu_payload("unavailable", error_code="NO_VERIFIED_PROCESS_CANDIDATES")
    device_map = _gpu_device_map(gpu_devices)
    if device_map is None:
        return _process_gpu_payload("unavailable", error_code="GPU_DEVICE_LIST_INVALID")
    if not device_map:
        return _process_gpu_payload("unavailable", error_code="GPU_DEVICE_LIST_EMPTY")
    getuid = getattr(os, "getuid", None)
    current_uid = getuid() if callable(getuid) else None
    if current_uid is None:
        return _process_gpu_payload("unavailable", error_code="PROCESS_GPU_UID_UNAVAILABLE")

    nspid_to_host = {}
    for row in process_rows:
        if isinstance(row, dict) and isinstance(row.get("processKey"), dict):
            host_pid = row["processKey"].get("pid")
            ns_pid = row.get("nsPid")
            if isinstance(host_pid, int) and isinstance(ns_pid, int) and ns_pid > 0:
                nspid_to_host[ns_pid] = host_pid

    before = {}
    for pid, expected in candidates.items():
        try:
            owner = os.stat(os.path.join(proc_root, str(pid)), follow_symlinks=False).st_uid
            identity = _proc_identity(proc_root, pid, boot_id)
        except (OSError, ValueError, UnicodeError):
            continue
        if (allow_cross_uid or owner == current_uid) and identity == {"bootId": boot_id, "pid": pid, "startTicks": expected["startTicks"]}:
            before[pid] = expected
    if not before:
        return _process_gpu_payload("unavailable", error_code="NO_STABLE_PROCESS_CANDIDATES")

    output, query_error = _query_process_gpu_csv()
    after = {}
    for pid, expected in before.items():
        try:
            owner = os.stat(os.path.join(proc_root, str(pid)), follow_symlinks=False).st_uid
            identity = _proc_identity(proc_root, pid, boot_id)
        except (OSError, ValueError, UnicodeError):
            continue
        if (allow_cross_uid or owner == current_uid) and identity == {"bootId": boot_id, "pid": pid, "startTicks": expected["startTicks"]}:
            after[pid] = expected
    process_keys = [after[pid] for pid in sorted(after)]
    if query_error:
        return _process_gpu_payload("unavailable", error_code=query_error, process_keys=process_keys)
    if not isinstance(output, bytes) or len(output) > MAX_PROCESS_GPU_OUTPUT_BYTES:
        return _process_gpu_payload("unavailable", error_code="NVIDIA_SMI_RESPONSE_LIMIT", process_keys=process_keys)
    try:
        text = output.decode("utf-8", "strict")
    except UnicodeDecodeError:
        return _process_gpu_payload("unavailable", error_code="NVIDIA_SMI_RESPONSE_INVALID", process_keys=process_keys)
    lines = text.splitlines()
    if len(lines) > MAX_PROCESS_GPU_ROWS:
        return _process_gpu_payload("unavailable", error_code="NVIDIA_SMI_RESPONSE_LIMIT", process_keys=process_keys)

    aggregates = {}
    seen_rows = set()
    for line in lines:
        columns = [part.strip() for part in line.split(",")]
        if not columns or not columns[0].isdecimal():
            continue
        raw_pid = int(columns[0])
        pid = raw_pid if raw_pid in after else nspid_to_host.get(raw_pid)
        if pid is None or pid not in after:
            continue
        if len(columns) != 3:
            return _process_gpu_payload("unavailable", error_code="NVIDIA_SMI_RESPONSE_INVALID", process_keys=process_keys)
        uuid = columns[1]
        device_id = device_map.get(uuid)
        if device_id is None:
            return _process_gpu_payload("unavailable", error_code="GPU_DEVICE_UNMAPPED", process_keys=process_keys)
        memory_text = columns[2]
        if _is_missing_gpu_value(memory_text):
            memory_bytes = None
        elif re.fullmatch(r"[0-9]+", memory_text):
            memory_mib = int(memory_text)
            memory_bytes = memory_mib * 1024 * 1024
            if memory_bytes > 9007199254740991:
                return _process_gpu_payload("unavailable", error_code="NVIDIA_SMI_RESPONSE_INVALID", process_keys=process_keys)
        else:
            return _process_gpu_payload("unavailable", error_code="NVIDIA_SMI_RESPONSE_INVALID", process_keys=process_keys)
        row_key = (pid, device_id)
        if row_key in seen_rows:
            existing = aggregates[row_key]
            if existing is None or (memory_bytes is not None and memory_bytes > existing):
                aggregates[row_key] = memory_bytes
        else:
            seen_rows.add(row_key)
            aggregates[row_key] = memory_bytes

    utilization = _process_gpu_utilization(after, device_map, aggregates) if aggregates else {}
    if utilization:
        for pid in list(after):
            try:
                owner = os.stat(os.path.join(proc_root, str(pid)), follow_symlinks=False).st_uid
                identity = _proc_identity(proc_root, pid, boot_id)
                stable = (allow_cross_uid or owner == current_uid) and identity == {"bootId": boot_id, "pid": pid, "startTicks": after[pid]["startTicks"]}
            except (OSError, ValueError, UnicodeError):
                stable = False
            if not stable:
                del after[pid]
        process_keys = [after[pid] for pid in sorted(after)]
    samples = []
    for (pid, device_id), memory_bytes in sorted(aggregates.items()):
        if pid not in after:
            continue
        key = after[pid]
        samples.append({
            "processKey": key,
            "keyBeforeSample": key,
            "keyAfterSample": key,
            "deviceId": device_id,
            "memoryBytes": memory_bytes,
            "utilizationPercent": utilization.get((pid, device_id)),
        })
    return _process_gpu_payload("ok", observed_at=time.time_ns() // 1_000_000, samples=samples, process_keys=process_keys)


def _sample(path, host_roots, task_directories, expected_identity, start, length, expected_sha256):
    if not isinstance(start, int) or start < 0 or not isinstance(length, int) or length < 0 or length > 4096:
        return False
    fd = None
    try:
        hosts, tasks = _canonical_task_roots(host_roots, task_directories)
        resolved = os.path.realpath(path)
        if hosts is None or not _path_in_scope(resolved, hosts, tasks):
            return False
        fd = os.open(resolved, os.O_RDONLY | getattr(os, "O_BINARY", 0) | getattr(os, "O_CLOEXEC", 0) | getattr(os, "O_NOFOLLOW", 0))
        opened = os.fstat(fd)
        if _identity(opened) != expected_identity:
            return False
        os.lseek(fd, start, os.SEEK_SET)
        data = os.read(fd, length)
        final = os.fstat(fd)
        resolved_after = os.path.realpath(path)
        current = os.stat(resolved_after, follow_symlinks=False)
        hosts_after, tasks_after = _canonical_task_roots(host_roots, task_directories)
        return (
            hosts_after == hosts
            and tasks_after == tasks
            and resolved_after == resolved
            and len(data) == length
            and hashlib.sha256(data).hexdigest() == expected_sha256
            and _same_identity(opened, final)
            and _same_identity(final, current)
            and _path_in_scope(resolved_after, hosts_after, tasks_after)
        )
    except OSError:
        return False
    finally:
        if fd is not None:
            try:
                os.close(fd)
            except OSError:
                pass


def _observe_source(path, host_roots, task_directories, anchors):
    result = open_readonly(path, host_roots, task_directories, limit_bytes=0)
    if result["status"] != "ok":
        return result
    for anchor in anchors:
        if not _sample(path, host_roots, task_directories, result["identity"], int(anchor.get("startOffset", -1)), anchor.get("length"), anchor.get("sha256")):
            return {"status": "error", "errorCode": "ANCHOR_MISMATCH"}
    return {
        "status": "ok",
        "fileIdentity": result["identity"],
        "sizeBytes": result["sizeBytes"],
        "resolvedPath": result.get("resolvedPath"),
        "observedAt": time.time_ns() // 1_000_000,
    }


def _read_log(request):
    path = request.get("path")
    host_roots = request.get("hostAllowedRoots", request.get("allowedRoots"))
    task_dirs = request.get("taskAllowedDirectories", request.get("allowedRoots"))
    offset = request.get("offset")
    limit = request.get("limitBytes")
    if not isinstance(path, str) or not isinstance(host_roots, list) or not isinstance(task_dirs, list) or not isinstance(offset, (int, str)) or not str(offset).isdecimal():
        return {"ok": False, "errorCode": "INVALID_READ_REQUEST"}
    offset = int(offset)
    if type(limit) is not int or limit < 0 or limit > MAX_READ_BYTES:
        return {"ok": False, "errorCode": "READ_LIMIT_INVALID"}
    anchors = request.get("anchors", [])
    if not isinstance(anchors, list) or len(anchors) > 2 or any(item.get("length", MAX_READ_BYTES) > 4096 for item in anchors if isinstance(item, dict)):
        return {"ok": False, "errorCode": "ANCHOR_REQUEST_INVALID"}
    if request.get("kind") == "registered_rotation" and not anchors:
        return {"ok": False, "errorCode": "OLD_ANCHORS_UNAVAILABLE"}
    path_mode = request.get("pathMode") or "exact"
    if path_mode != "exact" and request.get("kind") != "registered_rotation":
        resolved_dyn, dyn_err = _resolve_dynamic_source_path({"path": path, "pathMode": path_mode}, host_roots, task_dirs)
        if dyn_err or not resolved_dyn:
            return {"ok": False, "errorCode": dyn_err or "SOURCE_MISSING"}
        path = resolved_dyn
    before = _observe_source(path, host_roots, task_dirs, anchors)
    if before.get("status") != "ok":
        return {"ok": False, "errorCode": before.get("errorCode", "SOURCE_OBSERVATION_FAILED")}
    if request.get("kind") == "registered_rotation":
        current_path = request.get("currentPath")
        if not isinstance(current_path, str):
            return {"ok": False, "errorCode": "CURRENT_SOURCE_REQUIRED"}
        current = open_readonly(current_path, host_roots, task_dirs, limit_bytes=0)
        if current.get("status") != "ok":
            return {"ok": False, "errorCode": current.get("errorCode", "CURRENT_SOURCE_UNAVAILABLE")}
        same_path = os.path.realpath(current_path) == os.path.realpath(path)
        same_file = current["identity"] == before["fileIdentity"]
        if same_path or same_file:
            return {"ok": False, "errorCode": "CURRENT_FILE_NOT_ARCHIVE"}
    resolved_target = before.get("resolvedPath") or os.path.realpath(path)
    fd = None
    try:
        fd = os.open(resolved_target, os.O_RDONLY | getattr(os, "O_BINARY", 0) | getattr(os, "O_CLOEXEC", 0) | getattr(os, "O_NOFOLLOW", 0))
        opened = os.fstat(fd)
        if _identity(opened) != before["fileIdentity"]:
            return {"ok": False, "errorCode": "PATH_IDENTITY_CHANGED"}
        os.lseek(fd, offset, os.SEEK_SET)
        data = os.read(fd, limit)
        after_info = os.fstat(fd)
    except FileNotFoundError:
        return {"ok": False, "errorCode": "SOURCE_MISSING"}
    except PermissionError:
        return {"ok": False, "errorCode": "SOURCE_PERMISSION"}
    except OSError as exc:
        return {"ok": False, "errorCode": "SOURCE_READ_FAILED", "errno": exc.errno}
    finally:
        if fd is not None:
            try:
                os.close(fd)
            except OSError:
                pass
    after = _observe_source(path, host_roots, task_dirs, anchors)
    if after.get("status") != "ok" or after.get("fileIdentity") != before.get("fileIdentity") or not _same_identity(opened, after_info):
        return {"ok": False, "errorCode": after.get("errorCode", "PATH_IDENTITY_CHANGED")}
    return {
        "ok": True,
        "expected": request.get("expected"),
        "before": before,
        "after": after,
        "startOffset": str(offset),
        "bytesBase64": base64.b64encode(data).decode("ascii"),
        "bytesLength": len(data),
    }


def scan_rotation_candidates(current_path, candidates, host_roots, task_directories, anchors, max_candidates=64, time_budget=SCAN_BUDGET_SECONDS):
    started = time.monotonic()
    budget = min(max(float(time_budget), 0.0), MAX_SCAN_BUDGET_SECONDS)
    if not isinstance(current_path, str) or not isinstance(candidates, list) or not isinstance(host_roots, list) or not isinstance(task_directories, list) or not isinstance(anchors, list):
        return {"scanComplete": False, "errorCode": "ROTATION_SCAN_INVALID", "candidates": []}
    if len(candidates) > max_candidates or max_candidates > 128:
        return {"scanComplete": False, "errorCode": "ROTATION_SCAN_LIMIT", "candidates": []}
    if not anchors or len(anchors) > 2 or any(not isinstance(item, dict) or not isinstance(item.get("startOffset"), (int, str)) or not str(item.get("startOffset")).isdecimal() or type(item.get("length")) is not int or item["length"] < 0 or item["length"] > 4096 or not isinstance(item.get("sha256"), str) or not re.fullmatch(r"[a-fA-F0-9]{64}", item["sha256"]) for item in anchors):
        return {"scanComplete": False, "errorCode": "OLD_ANCHORS_UNAVAILABLE", "checkedCount": 0, "candidates": []}
    current = open_readonly(current_path, host_roots, task_directories, limit_bytes=0)
    if current.get("status") != "ok":
        return {"scanComplete": False, "errorCode": current.get("errorCode", "CURRENT_SOURCE_UNAVAILABLE"), "candidates": []}
    matches = []
    for index, candidate in enumerate(candidates):
        if time.monotonic() - started > budget:
            return {"scanComplete": False, "checkedCount": index, "errorCode": "ROTATION_SCAN_INCOMPLETE", "candidates": matches}
        if not isinstance(candidate, str):
            return {"scanComplete": False, "checkedCount": index, "errorCode": "ROTATION_SCAN_INVALID", "candidates": matches}
        result = open_readonly(candidate, host_roots, task_directories, limit_bytes=0)
        if result.get("status") != "ok":
            return {"scanComplete": False, "checkedCount": index, "errorCode": result.get("errorCode", "ROTATION_CANDIDATE_UNAVAILABLE"), "candidates": matches}
        if os.path.realpath(candidate) == os.path.realpath(current_path) or result["identity"] == current["identity"]:
            continue
        if not all(_sample(candidate, host_roots, task_directories, result["identity"], int(item.get("startOffset", -1)), item.get("length"), item.get("sha256")) for item in anchors):
            continue
        matches.append({"candidateIndex": index, "sizeBytes": result["sizeBytes"]})
    return {"scanComplete": True, "checkedCount": len(candidates), "errorCode": None, "candidates": matches}


def collect_host_system_health(proc_root="/proc", disk_paths=None):
    """Collect host CPU utilization, RAM used/total, and disk usage for registered roots."""
    global _PREV_HOST_CPU
    cpu_pct = None
    mem_used = None
    mem_total = None
    disks = []

    try:
        with open(os.path.join(proc_root, "stat"), "r", encoding="ascii", errors="replace") as stream:
            first_line = stream.readline()
        if first_line.startswith("cpu "):
            vals = [int(v) for v in first_line.split()[1:9] if v.isdecimal()]
            if len(vals) >= 4:
                idle = vals[3] + (vals[4] if len(vals) > 4 else 0)
                total = sum(vals)
                if _PREV_HOST_CPU is not None:
                    d_total = total - _PREV_HOST_CPU[0]
                    d_idle = idle - _PREV_HOST_CPU[1]
                    if d_total > 0 and d_idle >= 0:
                        cpu_pct = round(max(0.0, min(100.0, (1.0 - d_idle / d_total) * 100.0)), 2)
                _PREV_HOST_CPU = (total, idle)
    except OSError:
        pass

    if cpu_pct is None and hasattr(os, "getloadavg"):
        try:
            load1 = os.getloadavg()[0]
            cpus = os.cpu_count() or 1
            cpu_pct = round(max(0.0, min(100.0, (load1 / cpus) * 100.0)), 2)
        except OSError:
            pass

    try:
        meminfo = {}
        with open(os.path.join(proc_root, "meminfo"), "r", encoding="ascii", errors="replace") as stream:
            for line in stream.read(8192).splitlines():
                if ":" in line:
                    k, v = line.split(":", 1)
                    parts = v.strip().split()
                    if parts and parts[0].isdecimal():
                        meminfo[k.strip()] = int(parts[0]) * 1024
        if "MemTotal" in meminfo:
            mem_total = str(meminfo["MemTotal"])
            avail = meminfo.get("MemAvailable")
            if avail is None:
                avail = meminfo.get("MemFree", 0) + meminfo.get("Buffers", 0) + meminfo.get("Cached", 0)
            mem_used = str(max(0, meminfo["MemTotal"] - avail))
    except OSError:
        pass

    seen_real = set()
    for path_item in (disk_paths or [])[:16]:
        if not isinstance(path_item, str) or not path_item:
            continue
        try:
            real = os.path.realpath(path_item)
            if real in seen_real or not os.path.exists(real):
                continue
            seen_real.add(real)
            usage = shutil.disk_usage(real)
            disks.append({
                "path": path_item,
                "usedBytes": str(usage.used),
                "availableBytes": str(usage.free),
                "totalBytes": str(usage.total),
            })
        except OSError:
            continue

    return {
        "observedAt": time.time_ns() // 1_000_000,
        "cpuUtilizationPct": cpu_pct,
        "memoryUsedBytes": mem_used,
        "memoryTotalBytes": mem_total,
        "disks": disks,
    }


def discover_processes(proc_root="/proc", max_processes=MAX_PROCESSES):
    """Read-only process discovery joining nvidia-smi compute apps with /proc ML training processes."""
    gpu_by_pid = {}  # pid -> {"gpuIndices": set, "gpuMemoryMiB": float}
    gpu_query = _query_linux_gpu()
    uuid_to_idx = {}
    if isinstance(gpu_query, dict) and gpu_query.get("status") == "ok" and isinstance(gpu_query.get("csv"), str):
        for dev in _gpu_devices_from_csv(gpu_query["csv"]):
            uuid_to_idx[dev["uuid"]] = dev["index"]

    raw_apps, app_err = _query_process_gpu_csv()
    if not app_err and isinstance(raw_apps, bytes):
        for line in raw_apps.decode("utf-8", "replace").splitlines()[:MAX_PROCESS_GPU_ROWS]:
            cols = [p.strip() for p in line.split(",")]
            if len(cols) < 3 or not cols[0].isdecimal():
                continue
            pid = int(cols[0])
            idx = uuid_to_idx.get(cols[1])
            mem = _parse_float_or_none(cols[2], low=0.0)
            entry = gpu_by_pid.setdefault(pid, {"gpuIndices": set(), "gpuMemoryMiB": 0.0, "hasMem": False})
            if idx is not None:
                entry["gpuIndices"].add(idx)
            if mem is not None:
                entry["gpuMemoryMiB"] += mem
                entry["hasMem"] = True

    discovered = []
    try:
        iterator = os.scandir(proc_root)
    except OSError:
        return {"processes": [], "errorCode": "PROC_UNAVAILABLE"}

    inspected = 0
    my_pid = os.getpid()
    try:
        for entry in iterator:
            if not entry.name.isdecimal():
                continue
            pid = int(entry.name)
            if pid == my_pid:
                continue
            inspected += 1
            if inspected > max_processes or len(discovered) >= 128:
                break
            proc_dir = os.path.join(proc_root, str(pid))
            try:
                argv = _read_full_argv(os.path.join(proc_dir, "cmdline"), max_bytes=4096)["argv"]
            except OSError:
                continue
            if not argv:
                continue
            exe_base = os.path.basename(argv[0]).lower()
            has_gpu = pid in gpu_by_pid
            looks_ml = False
            suggested_entry = None

            if _is_python_basename(exe_base):
                parsed = _parse_python_argv(argv, 1)
                if parsed["script"]:
                    suggested_entry = parsed["script"]
                    looks_ml = True
                elif parsed["module"]:
                    suggested_entry = "-m " + parsed["module"]
                    looks_ml = True
            elif exe_base in _ML_LAUNCHERS and exe_base not in ("bash", "sh", "zsh", "env"):
                suggested_entry = _extract_nested_script(argv[1:]) or exe_base
                looks_ml = True

            if not has_gpu and not looks_ml:
                continue
            # Exclude our own monitor probe/waiter processes.
            cmd_joined = " ".join(argv)
            if "--serve" in argv and "probe" in argv:
                continue
            if ".server-worker-v1-" in cmd_joined:
                continue

            try:
                cwd = os.path.realpath(os.path.join(proc_dir, "cwd"))
            except OSError:
                cwd = None

            pgid = None
            try:
                with open(os.path.join(proc_dir, "stat"), "r", encoding="ascii", errors="replace") as st_stream:
                    sf = parse_proc_stat_fields(st_stream.read(4096))
                    if sf:
                        pgid = sf.get("pgid")
            except OSError:
                pass

            open_logs = []
            fd_dir = os.path.join(proc_dir, "fd")
            try:
                with os.scandir(fd_dir) as fds:
                    count = 0
                    for fd_entry in fds:
                        count += 1
                        if count > 256 or len(open_logs) >= 8:
                            break
                        if not fd_entry.name.isdecimal():
                            continue
                        try:
                            target = os.readlink(fd_entry.path)
                        except OSError:
                            continue
                        if not target.startswith("/") or target.startswith(("/dev/", "/proc/", "/sys/")):
                            continue
                        if fd_entry.name in ("1", "2") or target.endswith((".log", ".out", ".txt")):
                            if target not in open_logs:
                                open_logs.append(target)
            except OSError:
                pass

            gpu_info = gpu_by_pid.get(pid)
            gpu_indices = sorted(gpu_info["gpuIndices"]) if gpu_info else []
            gpu_mem = round(gpu_info["gpuMemoryMiB"], 2) if (gpu_info and gpu_info["hasMem"]) else None

            if suggested_entry:
                name_base = os.path.basename(suggested_entry.replace("-m ", ""))
                suggested_name = os.path.splitext(name_base)[0] or f"job-{pid}"
            else:
                suggested_name = os.path.basename(argv[0]) or f"job-{pid}"

            discovered.append({
                "pid": pid,
                "pgid": pgid,
                "command": cmd_joined[:512],
                "cwd": cwd,
                "gpuIndices": gpu_indices,
                "gpuMemoryMiB": gpu_mem,
                "openLogPaths": open_logs,
                "suggestedName": suggested_name[:80],
                "suggestedEntry": suggested_entry,
            })
    finally:
        iterator.close()
    # Sort GPU-using processes first, then by PID.
    discovered.sort(key=lambda item: (0 if item["gpuIndices"] else 1, -(item["gpuMemoryMiB"] or 0), item["pid"]))
    return {"processes": discovered, "errorCode": None}


class AcceleratorCollector:
    """Abstract accelerator collector supporting heterogeneous GPUs and CPU-only hosts."""

    vendor = "unknown"

    def is_available(self):
        return False

    def collect_devices(self, include_free=False, include_details=False, proc_root="/proc"):
        raise NotImplementedError

    def collect_process_usage(self, proc_root, boot_id, process_rows, gpu_devices, *, allow_cross_uid=False):
        return _process_gpu_payload("none", error_code=None)


class NvidiaCollector(AcceleratorCollector):
    vendor = "nvidia"

    def __init__(self, executable=None):
        self._executable = executable

    def is_available(self):
        return bool(self._executable or _find_nvidia_smi())

    def collect_devices(self, include_free=False, include_details=False, proc_root="/proc"):
        return _query_linux_gpu(include_free=include_free, include_details=include_details,
                                proc_root=proc_root, executable=self._executable)

    def collect_process_usage(self, proc_root, boot_id, process_rows, gpu_devices, *, allow_cross_uid=False):
        return _sample_process_gpu(proc_root, boot_id, process_rows, gpu_devices, allow_cross_uid=allow_cross_uid)


class RocmCollector(AcceleratorCollector):
    vendor = "rocm"

    def is_available(self):
        return False

    def collect_devices(self, include_free=False, include_details=False, proc_root="/proc"):
        return {"status": "none", "acceleratorAvailability": "none", "observedAt": None, "csv": None, "errorCode": None}


class AppleMpsCollector(AcceleratorCollector):
    vendor = "apple_mps"

    def is_available(self):
        return False

    def collect_devices(self, include_free=False, include_details=False, proc_root="/proc"):
        return {"status": "none", "acceleratorAvailability": "none", "observedAt": None, "csv": None, "errorCode": None}


class NoGpuFallbackCollector(AcceleratorCollector):
    vendor = "none"

    def is_available(self):
        return True

    def collect_devices(self, include_free=False, include_details=False, proc_root="/proc"):
        return {"status": "none", "acceleratorAvailability": "none", "observedAt": None, "csv": None, "errorCode": None}


def select_accelerator_collector():
    executable = _find_nvidia_smi()
    if executable:
        return NvidiaCollector(executable)
    for collector_cls in (RocmCollector, AppleMpsCollector):
        collector = collector_cls()
        if collector.is_available():
            return collector
    return NoGpuFallbackCollector()


_WINDOWS_BOOT_ID = None


def _read_host_boot_id(proc_root="/proc"):
    global _WINDOWS_BOOT_ID
    if sys.platform.startswith("linux") or proc_root != "/proc":
        with open(os.path.join(proc_root, "sys", "kernel", "random", "boot_id"), "r", encoding="ascii") as stream:
            boot_id = stream.read(128).strip()
        if not boot_id:
            raise OSError("empty boot_id")
        return boot_id
    if sys.platform == "darwin":
        try:
            out = subprocess.check_output(["sysctl", "-n", "kern.boottime"], stderr=subprocess.DEVNULL, timeout=1)
            match = re.search(r"sec\s*=\s*(\d+)", out.decode("ascii", "replace"))
            if match:
                return "darwin-boot-" + match.group(1)
        except Exception:
            pass
    if os.name == "nt":
        try:
            if _WINDOWS_BOOT_ID is None:
                tick_count = ctypes.windll.kernel32.GetTickCount64
                tick_count.restype = ctypes.c_ulonglong
                boot_sec = int(time.time() - tick_count() / 1000.0)
                _WINDOWS_BOOT_ID = "win32-boot-" + str(boot_sec // 60)
            return _WINDOWS_BOOT_ID
        except Exception:
            pass
    import socket
    return "local-host-" + hashlib.sha256(socket.gethostname().encode("utf-8", "replace")).hexdigest()[:16]


def _probe_task_impl(request, boot_id_override=None, gpu_devices_override=None):
    proc = request.get("proc", {})
    proc_root = proc.get("root", "/proc")
    boot_id = boot_id_override
    if boot_id is None:
        try:
            boot_id = _read_host_boot_id(proc_root)
        except OSError:
            boot_id = None
    task = request.get("task", {})
    host_roots = task.get("hostAllowedRoots", [])
    task_dirs = task.get("allowedDirectories", [])
    sources = []
    resolved_paths_by_id = {}
    for source in task.get("sources", [])[:64]:
        if not isinstance(source, dict) or not isinstance(source.get("path"), str):
            continue
        is_status = source.get("kind") == "status_json"
        resolved_src, resolve_err = _resolve_dynamic_source_path(source, host_roots, task_dirs)
        if resolve_err or not resolved_src:
            result = {
                "status": "missing" if resolve_err == "SOURCE_MISSING" else "permission_error",
                "errorCode": resolve_err or "SOURCE_MISSING",
            }
        else:
            resolved_paths_by_id[source.get("sourceId")] = resolved_src
            try:
                result = open_readonly(resolved_src, host_roots, task_dirs, limit_bytes=MAX_STATUS_BYTES + 1 if is_status else 0)
            except Exception:
                result = {"status": "error", "errorCode": "SOURCE_READ_FAILED"}
        status = result.get("status")
        row = {
            "sourceId": source.get("sourceId"),
            "kind": source.get("kind"),
            "status": status,
            "errorCode": result.get("errorCode"),
            "errorScope": "source" if result.get("errorCode") else None,
            "phase": "source_read" if result.get("errorCode") else None,
            "fileIdentity": result.get("identity"),
            "eofBytes": result.get("sizeBytes"),
            "resolvedPath": result.get("resolvedPath") or resolved_src,
            "observedAt": time.time_ns() // 1_000_000,
        }
        if is_status and status == "ok":
            try:
                projection = project_status_json(result.get("data", b""), {
                    "step", "target", "status", "updated_at", "checkpoint",
                    "taskId", "hostId", "hostBootId", "pid", "startTicks", "sequence",
                    "resume_checkpoint_index", "target_meaning", "global_step", "epoch",
                    "max_steps", "exitCode", "exit_code", "error", "waiting", "state",
                })
            except Exception:
                projection = {"status": "error", "errorCode": "STATUS_JSON_INVALID"}
            row["statusValues"] = projection.get("values") if projection.get("status") == "ok" else None
            if projection.get("status") == "ok":
                row["statusRawContent"] = result.get("data", b"").decode("utf-8", "replace")
            if projection.get("status") != "ok":
                row["errorCode"] = projection.get("errorCode")
        sources.append(row)

    source_observations = {}
    source_rows_by_id = {row.get("sourceId"): row for row in sources if isinstance(row, dict)}
    scan_sources = []
    for source in task.get("sources", [])[:64]:
        if not isinstance(source, dict):
            continue
        row = source_rows_by_id.get(source.get("sourceId"))
        resolved_path = resolved_paths_by_id.get(source.get("sourceId")) or source.get("path")
        scan_sources.append(dict(source, resolvedPath=resolved_path,
                                 observationErrorCode=row.get("errorCode") if row else None))
        if (
            source.get("kind") == "log"
            and isinstance(row, dict)
            and row.get("status") == "ok"
            and isinstance(row.get("fileIdentity"), dict)
            and isinstance(row.get("eofBytes"), str)
            and isinstance(resolved_path, str)
        ):
            source_observations[resolved_path] = {"fileIdentity": row["fileIdentity"], "eofBytes": row["eofBytes"]}

    scan_task = dict(task)
    scan_task["sources"] = scan_sources
    scan_task["sourceObservations"] = source_observations
    scan = scan_registered_processes(proc_root, boot_id, scan_task)

    process_rows = []
    source_ids = {}
    for item in scan_sources:
        if isinstance(item, dict) and item.get("kind") == "log":
            for p in (item.get("path"), item.get("resolvedPath")):
                if isinstance(p, str):
                    source_ids[p] = item.get("sourceId")
                    source_ids[os.path.realpath(p)] = item.get("sourceId")

    for item in scan.get("candidates", []):
        writer_ids = []
        writer_source_evidence = {}
        for path in item.get("writerSources", []):
            sid = source_ids.get(path) or source_ids.get(os.path.realpath(path))
            if sid and sid not in writer_ids:
                writer_ids.append(sid)
                ev = item.get("writerSourceEvidence", {}).get(path)
                if ev is not None:
                    writer_source_evidence[sid] = ev
        is_tree_worker = item.get("treeMember") is True
        entry = (isinstance(item.get("scriptEntry"), str) or isinstance(item.get("launcherEntry"), str)) and item.get("evidenceComplete") is True
        if is_tree_worker:
            role_evidence = "inferred_tree"
        elif entry:
            role_evidence = "exact_entry_and_direct_writer_fd" if writer_ids else "exact_script_entry"
        else:
            role_evidence = "none"
        process_rows.append({
            "processKey": item.get("processKey"),
            "parentKey": item.get("parentKey"),
            "ppid": item.get("ppid"),
            "pgid": item.get("pgid"),
            "nsPid": item.get("nsPid"),
            "role": item.get("role", "unknown"),
            "roleEvidence": role_evidence,
            "writerSourceIds": writer_ids,
            "writerSourceEvidence": writer_source_evidence,
            "writerEvidenceComplete": item.get("writerEvidenceComplete") is True and scan["scanComplete"],
            "cwd": item.get("cwd"),
            "scriptEntry": item.get("scriptEntry"),
            "launcherEntry": item.get("launcherEntry"),
            "exe": item.get("exe"),
            "command": item.get("command"),
            "interpreterFlags": item.get("interpreterFlags", []),
            "evidenceComplete": item.get("evidenceComplete") is True and scan["scanComplete"],
            "fdScanTruncated": bool(item.get("fdScanTruncated")),
            "treeMember": is_tree_worker,
            "rssBytes": item.get("rssBytes"),
            "cpuPercent": item.get("cpuPercent"),
            "observedAt": time.time_ns() // 1_000_000,
        })

    complete = scan["scanComplete"] and len(task.get("sources", [])) <= 64
    error_code = scan["errorCode"] or ("SOURCE_CANDIDATE_LIMIT" if len(task.get("sources", [])) > 64 else None)
    payload = {
        "scanComplete": complete,
        "errorCode": error_code,
        "errorScope": "task" if error_code else None,
        "phase": "process_scan" if error_code else None,
        "processes": process_rows,
        "sources": sources,
    }
    ckpt_dirs = task.get("checkpointDirectories")
    if isinstance(ckpt_dirs, list) and ckpt_dirs:
        try:
            payload["checkpointScan"] = scan_checkpoints(ckpt_dirs, host_roots, task_dirs)
        except Exception:
            payload["checkpointScan"] = {"scanComplete": False, "checkpoint": None, "errorCode": "CHECKPOINT_SCAN_FAILED"}

    if request.get("includeProcessGpu") is True:
        try:
            gpu_devices = gpu_devices_override if gpu_devices_override is not None else request.get("gpuDevices")
            payload["processGpu"] = select_accelerator_collector().collect_process_usage(
                proc_root,
                boot_id,
                process_rows,
                gpu_devices,
                allow_cross_uid=bool(task.get("allowCrossUidScan") is True),
            )
        except Exception:
            payload["processGpu"] = _process_gpu_payload("unavailable", error_code="PROCESS_GPU_SAMPLE_FAILED")
    return payload


def _probe_host_impl(request):
    proc = request.get("proc", {})
    proc_root = proc.get("root", "/proc") if isinstance(proc, dict) else "/proc"
    try:
        boot_id = _read_host_boot_id(proc_root)
        gpu = {"status": "skipped", "observedAt": None, "csv": None, "errorCode": None}
        availability = None
        include_details = request.get("includeGpuDetails", True) is not False
        if request.get("includeGpu") is not False:
            gpu = select_accelerator_collector().collect_devices(
                include_details=include_details, proc_root=proc_root)
            if isinstance(gpu, dict):
                if gpu.get("status") == "ok":
                    availability = "available"
                elif gpu.get("status") == "none" or gpu.get("acceleratorAvailability") == "none":
                    availability = "none"
                else:
                    availability = "unavailable"
        result = {
            "hostBootId": boot_id,
            "scanComplete": True,
            "errorCode": None,
            "errorScope": None,
            "phase": None,
            "gpu": gpu,
        }
        if availability is not None:
            result["acceleratorAvailability"] = availability
        if request.get("includeSystemHealth") is not False:
            try:
                disk_paths = request.get("diskPaths") or request.get("allowedRoots") or []
                result["system"] = collect_host_system_health(proc_root=proc_root, disk_paths=disk_paths)
            except Exception:
                pass
        return result
    except OSError:
        return {
            "hostBootId": None,
            "scanComplete": False,
            "errorCode": "HOST_IDENTITY_UNAVAILABLE",
            "errorScope": "host",
            "phase": "probe",
        }


def _dispatch(request):
    op = request.get("op")
    if op == "shutdown":
        return {"shutdown": True}
    if op == "discover_processes":
        proc = request.get("proc", {})
        proc_root = proc.get("root", "/proc") if isinstance(proc, dict) else "/proc"
        return discover_processes(proc_root=proc_root)
    if op == "probe_launch_readiness":
        probe_request = dict(request, op="probe_task", includeProcessGpu=False)
        probe_request["task"] = dict(request.get("task", {}), sources=[])
        result = _dispatch(probe_request)
        return {
            "scanComplete": result.get("scanComplete") is True,
            "running": bool(result.get("processes")),
            "errorCode": result.get("errorCode"),
        }
    if op == "read_log":
        payload = _read_log(request)
        if isinstance(payload, dict) and payload.get("errorCode"):
            payload.setdefault("errorScope", "source")
            payload.setdefault("phase", "source_read")
        return payload
    if op == "probe_task":
        return _probe_task_impl(request)
    if op == "probe_host":
        return _probe_host_impl(request)
    if op == "probe_host_and_tasks":
        host_payload = _probe_host_impl(request)
        task_results = {}
        if host_payload.get("scanComplete") is True and host_payload.get("hostBootId"):
            gpu = host_payload.get("gpu")
            gpu_devices = _gpu_devices_from_csv(gpu.get("csv")) if isinstance(gpu, dict) and gpu.get("status") == "ok" else []
            include_process_gpu = bool(request.get("includeProcessGpu") is True and host_payload.get("acceleratorAvailability") != "none")
            raw_tasks = request.get("tasks", [])
            if isinstance(raw_tasks, list):
                for task_item in raw_tasks[:64]:
                    if not isinstance(task_item, dict) or not isinstance(task_item.get("taskId"), str):
                        continue
                    sub_request = {
                        "op": "probe_task",
                        "proc": request.get("proc", {}),
                        "includeProcessGpu": include_process_gpu,
                        "gpuDevices": gpu_devices,
                        "task": task_item,
                    }
                    task_results[task_item["taskId"]] = _probe_task_impl(
                        sub_request,
                        boot_id_override=host_payload["hostBootId"],
                        gpu_devices_override=gpu_devices,
                    )
        return {"host": host_payload, "tasks": task_results}
    if op == "scan_rotation":
        payload = scan_rotation_candidates(
            request.get("currentPath"),
            request.get("candidates", []),
            request.get("hostAllowedRoots", []),
            request.get("taskAllowedDirectories", []),
            request.get("anchors", []),
        )
        if isinstance(payload, dict) and payload.get("errorCode"):
            payload.setdefault("errorScope", "source")
            payload.setdefault("phase", "archive_scan")
        return payload
    return {"errorCode": "REQUEST_OP_UNSUPPORTED", "errorScope": "request", "phase": "dispatch"}


def _query_linux_gpu(include_free=False, include_details=False, proc_root="/proc", executable=None):
    """Read GPU metrics in a single bounded nvidia-smi query with graceful CPU fallback."""
    executable = executable or _find_nvidia_smi()
    if not executable:
        return NoGpuFallbackCollector().collect_devices(include_free=include_free, include_details=include_details)
    if include_details:
        fields = (
            "index,uuid,utilization.gpu,memory.used,memory.total,memory.free,"
            "name,temperature.gpu,power.draw,power.limit,fan.speed,pci.bus_id,"
            "compute_mode,ecc.errors.uncorrected.aggregate.total"
        )
        max_bytes = MAX_DEVICE_GPU_OUTPUT_BYTES
    else:
        fields = "index,uuid,utilization.gpu,memory.used,memory.total" + (",memory.free" if include_free else "")
        max_bytes = 16 * 1024
    args = ["--query-gpu=" + fields, "--format=csv,noheader,nounits"]
    output, error_code = _run_bounded_command(
        executable,
        args,
        timeout_seconds=2.0,
        max_bytes=max_bytes,
    )
    if error_code is not None:
        return {
            "status": "unavailable",
            "acceleratorAvailability": "unavailable",
            "observedAt": None,
            "csv": None,
            "errorCode": error_code,
        }
    decoded = output.decode("utf-8", "replace")
    observed_at = time.time_ns() // 1_000_000
    if include_details:
        active_procs = _query_gpu_active_processes(proc_root=proc_root)
        details, basic_csv = _parse_gpu_details_csv(decoded, active_procs)
        return {
            "status": "ok",
            "acceleratorAvailability": "available",
            "observedAt": observed_at,
            "csv": basic_csv if details else decoded,
            "devices": details,
            "errorCode": None,
        }
    return {
        "status": "ok",
        "acceleratorAvailability": "available",
        "observedAt": observed_at,
        "csv": decoded,
        "errorCode": None,
    }


def _emit_frame(envelope):
    payload = json.dumps(envelope, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
    if len(payload) > MAX_RESPONSE_BYTES:
        payload = json.dumps({
            "version": VERSION,
            "requestId": envelope.get("requestId"),
            "sourceId": envelope.get("sourceId"),
            "payload": {"errorCode": "RESPONSE_LIMIT", "errorScope": "request", "phase": "frame"},
        }).encode("ascii")
    sys.stdout.buffer.write(FRAME_MAGIC)
    sys.stdout.buffer.write(len(payload).to_bytes(4, "big"))
    sys.stdout.buffer.write(payload)
    sys.stdout.buffer.flush()


def _read_exact(stream, count):
    buf = bytearray()
    while len(buf) < count:
        chunk = stream.read(count - len(buf))
        if not chunk:
            return None
        buf.extend(chunk)
    return bytes(buf)


def _read_frame(stream):
    """Read next TMF1-framed JSON request from stdin; returns None on clean EOF."""
    window = bytearray()
    skipped = 0
    while True:
        byte = stream.read(1)
        if not byte:
            return None
        window.extend(byte)
        if len(window) > len(FRAME_MAGIC):
            del window[0]
            skipped += 1
            if skipped > MAX_PREAMBLE_JUNK_BYTES:
                raise ValueError("preamble limit exceeded")
        if bytes(window) == FRAME_MAGIC:
            break
    header = _read_exact(stream, 4)
    if header is None:
        return None
    length = int.from_bytes(header, "big")
    if length <= 0 or length > MAX_RESPONSE_BYTES:
        raise ValueError("invalid frame length")
    body = _read_exact(stream, length)
    if body is None:
        return None
    return json.loads(body.decode("utf-8"))


def _handle_request(request):
    if not isinstance(request, dict) or request.get("version") != VERSION:
        raise ValueError("invalid request schema")
    payload = _dispatch(request)
    if isinstance(payload, dict) and payload.get("errorCode"):
        if not isinstance(payload.get("errorScope"), str):
            payload["errorScope"] = "request"
        if not isinstance(payload.get("phase"), str):
            payload["phase"] = "dispatch"
    return {
        "version": VERSION,
        "requestId": request.get("requestId"),
        "sourceId": request.get("sourceId"),
        "payload": payload,
    }


def _serve_loop():
    stream = sys.stdin.buffer
    while True:
        request = None
        try:
            request = _read_frame(stream)
            if request is None:
                return 0
            envelope = _handle_request(request)
            _emit_frame(envelope)
            if isinstance(request, dict) and request.get("op") == "shutdown":
                return 0
        except Exception:
            _emit_frame({
                "version": VERSION,
                "requestId": request.get("requestId") if isinstance(request, dict) else None,
                "sourceId": request.get("sourceId") if isinstance(request, dict) else None,
                "payload": {"errorCode": "PROBE_REQUEST_INVALID", "errorScope": "request", "phase": "dispatch"},
            })
            if request is None:
                return 2


def main():
    if "--serve" in getattr(sys, "argv", [])[1:]:
        return _serve_loop()
    if REQUEST_B64 == "__MONITOR_REQUEST_B64__":
        _emit_frame({"version": VERSION, "requestId": None, "sourceId": None, "payload": {"errorCode": "REQUEST_MISSING", "errorScope": "request", "phase": "decode"}})
        return 2
    request = None
    try:
        request = json.loads(base64.b64decode(REQUEST_B64, validate=True).decode("utf-8"))
        envelope = _handle_request(request)
        _emit_frame(envelope)
        return 0
    except Exception:
        _emit_frame({
            "version": VERSION,
            "requestId": request.get("requestId") if isinstance(request, dict) else None,
            "sourceId": request.get("sourceId") if isinstance(request, dict) else None,
            "payload": {"errorCode": "PROBE_REQUEST_INVALID", "errorScope": "request", "phase": "dispatch"},
        })
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
