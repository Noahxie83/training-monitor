#!/usr/bin/python3
"""Bounded, read-only probe body. Requests are embedded as base64 data by the desktop."""
import base64
import binascii
import ctypes
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

VERSION = 1
MAX_RESPONSE_BYTES = 2 * 1024 * 1024
MAX_STDERR_BYTES = 64 * 1024
MAX_STATUS_BYTES = 256 * 1024
MAX_READ_BYTES = 1024 * 1024
MAX_PROCESSES = 4096
MAX_FDS_PER_PROCESS = 128
MAX_PROCESS_GPU_DEVICES = 64
MAX_PROCESS_GPU_ROWS = 4096
MAX_PROCESS_GPU_OUTPUT_BYTES = 256 * 1024
SCAN_BUDGET_SECONDS = 0.75
LAUNCHER_OPEN_FLAG = getattr(os, "O_SYNC", 0) | getattr(os, "O_DSYNC", 0)
SKIPPED_INTERPRETER_TOKENS = 8
REQUEST_B64 = "__MONITOR_REQUEST_B64__"


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


def open_readonly(candidate, host_roots, task_directories=None, limit_bytes=MAX_READ_BYTES, after_resolve=None):
    """Open only beneath both canonical host and task roots, then verify the opened inode."""
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
        flags = os.O_RDONLY | getattr(os, "O_CLOEXEC", 0)
        if hasattr(os, "O_NOFOLLOW"):
            flags |= os.O_NOFOLLOW
        fd = os.open(candidate, flags)
        opened = os.fstat(fd)
        after_path = os.stat(candidate, follow_symlinks=False)
        resolved_after = os.path.realpath(candidate)
        hosts_after, tasks_after = _canonical_task_roots(host_roots, roots)
        if (not _same_identity(before, opened) or not _same_identity(opened, after_path)
                or hosts_after != hosts or tasks_after != tasks
                or not _path_in_scope(resolved_after, hosts_after, tasks_after)):
            return {"status": "permission_error", "errorCode": "PATH_IDENTITY_CHANGED"}
        if limit_bytes == 0:
            data = b""
        else:
            data = os.read(fd, limit_bytes)
        final = os.fstat(fd)
        if not _same_identity(opened, final):
            return {"status": "permission_error", "errorCode": "PATH_IDENTITY_CHANGED"}
        return {"status": "ok", "data": data, "identity": _identity(final), "sizeBytes": str(final.st_size)}
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


def parse_proc_start_ticks(stat_line):
    """Extract /proc/<pid>/stat field 22 after the final comm closing parenthesis."""
    if not isinstance(stat_line, str):
        return None
    close = stat_line.rfind(")")
    if close < 0:
        return None
    fields = stat_line[close + 1:].strip().split()
    if len(fields) <= 19:
        return None
    value = fields[19]
    return value if value.isdecimal() else None


def _read_script_argv_prefix(path, max_bytes=8192):
    """Read argv only through Python's script operand; do not collect process arguments."""
    argv = []
    consumed = 0
    options_ended = False

    def read_argument(stream):
        nonlocal consumed
        value = bytearray()
        while consumed < max_bytes:
            byte = stream.read(1)
            if not byte:
                return None
            consumed += 1
            if byte == b"\0":
                return value.decode("utf-8", "replace")
            value.extend(byte)
        return None

    try:
        with open(path, "rb") as stream:
            executable = read_argument(stream)
            if executable is None:
                return {"argv": argv, "parseComplete": False}
            argv.append(executable)
            while True:
                item = read_argument(stream)
                if item is None:
                    return {"argv": argv, "parseComplete": False}
                argv.append(item)
                if options_ended:
                    return {"argv": argv, "parseComplete": True}
                if item == "--":
                    options_ended = True
                    continue
                if item in ("-c", "-m", "-") or item.startswith("-c") or item.startswith("-m"):
                    return {"argv": argv, "parseComplete": False}
                if item in ("-W", "-X"):
                    argument = read_argument(stream)
                    if argument is None:
                        return {"argv": argv, "parseComplete": False}
                    argv.append(argument)
                    continue
                if item in ("-I", "-S", "-B", "-E", "-s", "-u", "-O", "-OO", "-q", "-b", "-d", "-v", "-x"):
                    continue
                if item.startswith("-"):
                    return {"argv": argv, "parseComplete": False}
                return {"argv": argv, "parseComplete": True}
    except (OSError, ValueError, UnicodeError):
        raise


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
    """Return the first non-option argv item after the interpreter."""
    items = [item for item in argv if isinstance(item, str)] if isinstance(argv, list) else []
    skip = 0
    for item in items[1:]:
        if skip:
            skip -= 1
            continue
        if item == "--":
            continue
        if item.startswith("-"):
            if item in ("-W", "-X"):
                skip = 1
            continue
        return item
    return None


def registered_entry_content_verified(entry_path, entry_name, host_roots, task_directories):
    """The registered launcher must still contain the worker call its name promises."""
    match = re.fullmatch(r"start_parallel_worker(\d+)\.py", entry_name or "")
    if not match or len(entry_path) > 4096:
        return False
    opened = open_readonly(entry_path, host_roots, task_directories, limit_bytes=4096)
    if opened.get("status") != "ok":
        return False
    text = opened.get("data", b"").decode("utf-8", "replace")
    rank = match.group(1)
    return bool(re.search(r"^\s*from\s+parallel_runner\s+import\s+run\s*$", text, re.MULTILINE)
                and re.search(r"^\s*run\(%s\)\s*$" % rank, text, re.MULTILINE))


def launcher_entry_candidate(script, entries, host_roots, task_directories, verify_content=True):
    """Return the registered entry whose bare name and content explain the script operand."""
    if not isinstance(entries, list) or not entries or not isinstance(script, str):
        return None
    name = os.path.basename(script)
    if not _registered_entry_name_matches(name, entries):
        return None
    root = task_directories[0] if isinstance(task_directories, list) and task_directories else None
    if not isinstance(root, str):
        return None
    for entry in entries:
        if not isinstance(entry, str) or os.path.basename(os.path.normpath(entry)) != name:
            continue
        path = os.path.normpath(entry if os.path.isabs(entry) else os.path.join(root, entry))
        if not verify_content or registered_entry_content_verified(path, name, host_roots, task_directories):
            return path
    return None


def target_writer_fds(proc_dir, source_identities):
    """Read fdinfo only for numeric fds pointing at a registered log; never open those logs."""
    handles, seen, complete, fds_seen = [], set(), True, 0
    fd_dir = os.path.join(proc_dir, "fd")
    try:
        iterator = os.scandir(fd_dir)
    except OSError:
        return handles, False
    try:
        for entry in iterator:
            fds_seen += 1
            if fds_seen > MAX_FDS_PER_PROCESS:
                return handles, False
            if not entry.name.isdecimal():
                continue
            name = entry.name
            try:
                with open(os.path.join(proc_dir, "fdinfo", name), "r", encoding="ascii", errors="strict") as stream:
                    flags = parse_fdinfo_flags(stream.read(4097))
                target = os.path.realpath(os.path.join(fd_dir, name))
            except (OSError, ValueError, UnicodeError):
                complete = False
                continue
            if not flags.get("complete"):
                complete = False
                continue
            access = int(flags["flagsLine"].split(":", 1)[1].strip(), 8) & getattr(os, "O_ACCMODE", 3)
            if access not in (os.O_WRONLY, os.O_RDWR):
                continue
            if target in source_identities and target not in seen:
                seen.add(target)
                handles.append({"fd": name, "path": target, "flagsLine": flags["flagsLine"]})
    finally:
        iterator.close()
    return handles, complete


def launcher_handle_verified(proc_dir, source_identity, entry_identity=None):
    """Confirm the launcher handle on fd 255, falling back to the executable's own opened entry."""
    if not isinstance(proc_dir, str) or not isinstance(source_identity, dict):
        return False
    handle = os.path.join(proc_dir, "fd", "255")
    try:
        actual = os.stat(handle)
        with open(os.path.join(proc_dir, "fdinfo", "255"), "r", encoding="ascii", errors="strict") as stream:
            flags = parse_fdinfo_flags(stream.read(4097))
    except (OSError, ValueError, UnicodeError):
        return False
    return bool(flags.get("complete") and _identity(actual) == source_identity)


def executable_opened_entry(proc_dir, source_identity):
    """This Python keeps the executed script open read-only after startup.

    The script is not necessarily under the entry name, so the open text face
    (not the write target) carries the content marker instead of a path.
    """
    fd_dir = os.path.join(proc_dir, "fd")
    try:
        fds = [(entry.path, entry.name) for entry in os.scandir(fd_dir) if entry.name.isdecimal() and int(entry.name) >= 3]
    except OSError:
        return False
    for path, name in sorted(fds, key=lambda item: int(item[1]))[:MAX_FDS_PER_PROCESS]:
        try:
            with open(os.path.join(proc_dir, "fdinfo", name), "r", encoding="ascii", errors="strict") as stream:
                flags = parse_fdinfo_flags(stream.read(4097))
            if not flags.get("complete"):
                return False
            access = int(flags["flagsLine"].split(":", 1)[1].strip(), 8) & getattr(os, "O_ACCMODE", 3)
            if access in (os.O_WRONLY, os.O_RDWR):
                continue
            with open(path, "rb") as stream:
                head = stream.read(64)
        except (OSError, ValueError, UnicodeError):
            continue
        if b"parallel_runner" in head:
            return True
    return False


def project_task_process(registration, cwd, argv, process_key, writer_targets, launcher_entry=None):
    """Project an actual Python script operand; later FD checks add writer evidence."""
    directories = registration.get("allowedDirectories", []) if isinstance(registration, dict) else []
    entries = registration.get("entryPaths", []) if isinstance(registration, dict) else []
    host_roots = registration.get("hostAllowedRoots", []) if isinstance(registration, dict) else []
    sources = registration.get("sourcePaths", []) if isinstance(registration, dict) else []
    argv_strings = [item for item in argv if isinstance(item, str)] if isinstance(argv, list) else []
    script = None
    interpreter_flags = []
    index = 1
    parse_complete = True
    options_ended = False
    while index < len(argv_strings):
        item = argv_strings[index]
        if options_ended:
            script = item
            break
        if item == "--":
            options_ended = True
            index += 1
            continue
        if item in ("-c", "-m", "-") or item.startswith("-c") or item.startswith("-m"):
            parse_complete = False
            break
        if item in ("-W", "-X"):
            if index + 1 >= len(argv_strings):
                parse_complete = False
                break
            interpreter_flags.append(item)
            index += 2
            continue
        if item in ("-I", "-S", "-B", "-E", "-s", "-u", "-O", "-OO", "-q", "-b", "-d", "-v", "-x"):
            interpreter_flags.append(item[:32])
            index += 1
            continue
        if item.startswith("-"):
            parse_complete = False
            break
        script = item
        break
    if script and os.path.isabs(script):
        actual_entry = os.path.normpath(script)
    elif script and isinstance(cwd, str):
        actual_entry = os.path.normpath(os.path.join(cwd, script))
    else:
        actual_entry = None
    raw_entry = actual_entry
    actual_entry = os.path.realpath(actual_entry) if actual_entry else None
    canonical_entries = []
    hosts, tasks = _entry_roots(host_roots, directories)
    if hosts is not None and tasks is not None:
        for entry in entries:
            if isinstance(entry, str):
                candidate = os.path.realpath(entry if os.path.isabs(entry) else os.path.join(directories[0], entry))
                if _path_in_scope(candidate, hosts, tasks, host_only=True):
                    canonical_entries.append(candidate)
    exact_entry = bool(parse_complete and actual_entry and any(entry in (actual_entry, raw_entry) for entry in canonical_entries))
    if launcher_entry is True:
        first = entries[0] if entries else None
        launcher_entry = (os.path.realpath(first if os.path.isabs(first) else os.path.join(directories[0], first))
                          if isinstance(first, str) and isinstance(directories[0], str) else None)
    launcher_entry = launcher_entry if (not exact_entry and parse_complete and isinstance(launcher_entry, str)
                                        and _registered_entry_name_matches(script, entries)
                                        and any(target in sources for target in writer_targets)) else None
    writer_matches = [target for target in writer_targets if target in sources]
    key_ok = isinstance(process_key, dict) and bool(process_key.get("hostBootId")) and isinstance(process_key.get("pid"), int) and bool(process_key.get("startTicks"))
    verified = exact_entry or bool(launcher_entry)
    return {"confirmed": bool(verified and writer_matches and key_ok), "role": "unknown", "processKey": process_key if key_ok else None,
            "writerSources": writer_matches if verified and key_ok else [], "cwd": cwd if verified and key_ok else None,
            "scriptEntry": actual_entry if exact_entry else None, "launcherEntry": launcher_entry,
            "entryVerified": verified, "interpreterFlags": interpreter_flags[:16],
            "parseComplete": parse_complete, "evidenceComplete": bool(key_ok and verified)}


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


def _proc_identity(proc_root, pid, boot_id):
    stat_path = os.path.join(proc_root, str(pid), "stat")
    with open(stat_path, "r", encoding="ascii", errors="strict") as stream:
        start_ticks = parse_proc_start_ticks(stream.read(4096))
    if not start_ticks or not boot_id:
        return None
    return {"bootId": boot_id, "pid": pid, "startTicks": start_ticks}


def scan_registered_processes(proc_root="/proc", boot_id=None, task=None, max_processes=MAX_PROCESSES, time_budget=SCAN_BUDGET_SECONDS):
    started = time.monotonic()
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
    candidates = []
    registration = task if isinstance(task, dict) else {}
    raw_sources = registration.get("sources", [])
    sources = raw_sources[:64] if isinstance(raw_sources, list) else []
    if isinstance(raw_sources, list) and len(raw_sources) > 64:
        scan_complete = False
    source_paths = [item.get("path") for item in sources if isinstance(item, dict) and item.get("kind") == "log"]
    source_identities = {}
    source_witness_complete = True
    source_observations = registration.get("sourceObservations", {})
    host_roots = registration.get("hostAllowedRoots", [])
    task_dirs = registration.get("allowedDirectories", [])
    process_hosts, process_tasks = _canonical_task_roots(host_roots, task_dirs)
    for source in sources:
        if time.monotonic() - started > max(0.0, min(float(time_budget), SCAN_BUDGET_SECONDS)):
            scan_complete = False
            source_witness_complete = False
            break
        if isinstance(source, dict) and source.get("kind") == "log" and isinstance(source.get("path"), str):
            expected = source_observations.get(source["path"]) if isinstance(source_observations, dict) else None
            if (not isinstance(expected, dict) or not isinstance(expected.get("fileIdentity"), dict)
                    or not isinstance(expected.get("eofBytes"), str) or not expected["eofBytes"].isdecimal()):
                scan_complete = False
                source_witness_complete = False
                continue
            opened = open_readonly(source["path"], host_roots, task_dirs, limit_bytes=0)
            if (opened.get("status") == "ok" and opened.get("identity") == expected["fileIdentity"]
                    and opened.get("sizeBytes") == expected["eofBytes"]):
                source_identities[source["path"]] = expected
            else:
                scan_complete = False
                source_witness_complete = False
    try:
      for entry in iterator:
        if not entry.name.isdecimal():
            continue
        try:
            owner_uid = entry.stat(follow_symlinks=False).st_uid
        except FileNotFoundError:
            continue
        except OSError:
            scan_complete = False
            continue
        if current_uid is not None and owner_uid != current_uid:
            continue
        inspected += 1
        if inspected > cap:
            scan_complete = False
            break
        pid = int(entry.name)
        try:
            proc_dir = os.path.join(proc_root, str(pid))
            try:
                cwd = os.path.realpath(os.path.join(proc_dir, "cwd"))
            except (PermissionError, FileNotFoundError):
                # The process may still name a registered absolute script entry.
                # Unknown cwd cannot establish ownership of a relative entry.
                cwd = None
            cwd_in_scope = isinstance(cwd, str) and process_hosts is not None and _path_in_scope(cwd, process_hosts, process_tasks)
            cmdline_path = os.path.join(proc_dir, "cmdline")
            try:
                prefix = _read_script_argv_prefix(cmdline_path)
            except FileNotFoundError:
                # The process exited before an entry could be identified.
                continue
            except OSError:
                if cwd_in_scope:
                    scan_complete = False
                continue
            if not prefix.get("parseComplete", False):
                continue
            argv = prefix["argv"]
            projection_registration = {"hostAllowedRoots": host_roots, "allowedDirectories": task_dirs,
                                      "entryPaths": registration.get("entryPaths", []), "sourcePaths": source_paths}
            projected = project_task_process(projection_registration, cwd, argv, None, [])
            entry_name_candidate = launcher_entry_candidate(_script_operand(argv), registration.get("entryPaths", []),
                                                            host_roots, task_dirs, verify_content=False) is not None
            if not projected["entryVerified"] and not entry_name_candidate:
                continue
            if len(candidates) >= 64:
                scan_complete = False
                break
            first = _proc_identity(proc_root, pid, boot_id)
            if not first:
                scan_complete = False
                continue
            executable = os.path.basename(os.path.realpath(os.path.join(proc_dir, "exe"))).lower()
            if not (executable == "python" or executable.startswith("python3") or executable.startswith("python2")):
                continue
            process_key = {"hostBootId": boot_id, "pid": pid, "startTicks": first["startTicks"]}
            launcher_entry = None if projected["entryVerified"] else launcher_entry_candidate(
                _script_operand(argv), registration.get("entryPaths", []), host_roots, task_dirs)
            writer_targets = []
            writer_evidence = {}
            writer_evidence_complete = True
            fd_handles, fd_scan_complete = target_writer_fds(proc_dir, source_identities)
            if not fd_scan_complete:
                scan_complete = False
                writer_evidence_complete = False
            for handle in fd_handles:
                target = handle["path"]
                if target is None:
                    scan_complete = False
                    writer_evidence_complete = False
                    continue
                try:
                    first_fd = os.stat(os.path.join(proc_dir, "fd", handle["fd"]))
                    second_fd = os.stat(os.path.join(proc_dir, "fd", handle["fd"]))
                    after_process = _proc_identity(proc_root, pid, boot_id)
                    relation = fd_writable_evidence(handle["flagsLine"], _identity(first_fd), source_identities[target]["fileIdentity"], first,
                                                    {"bootId": boot_id, "pid": pid, "startTicks": first["startTicks"]}, after_process)
                    current_source = open_readonly(target, host_roots, task_dirs, limit_bytes=0)
                    source_stable = (current_source.get("status") == "ok"
                                     and current_source.get("identity") == source_identities[target]["fileIdentity"]
                                     and current_source.get("sizeBytes") == source_identities[target]["eofBytes"])
                    fd_stable = _same_identity(first_fd, second_fd)
                except (OSError, ValueError, UnicodeError):
                    scan_complete = False
                    writer_evidence_complete = False
                    continue
                if relation["verified"] and fd_stable and source_stable:
                    writer_targets.append(target)
                    writer_evidence[target] = {"fileIdentity": source_identities[target]["fileIdentity"], "eofBytes": source_identities[target]["eofBytes"]}
                else:
                    scan_complete = False
                    writer_evidence_complete = False
            second = _proc_identity(proc_root, pid, boot_id)
            if second != first:
                scan_complete = False
                continue
            projected = project_task_process(projection_registration, cwd, argv, process_key, writer_targets, launcher_entry)
            if projected["entryVerified"]:
                candidates.append({"processKey": projected["processKey"], "role": "unknown", "writerSources": projected["writerSources"],
                                   "writerSourceEvidence": writer_evidence,
                                   "cwd": projected["cwd"], "scriptEntry": projected["scriptEntry"],
                                   "launcherEntry": projected.get("launcherEntry"),
                                   "interpreterFlags": projected["interpreterFlags"], "evidenceComplete": projected["evidenceComplete"],
                                   "writerEvidenceComplete": writer_evidence_complete and source_witness_complete})
        except (OSError, ValueError, UnicodeError):
            scan_complete = False
      # A limit/deadline is incomplete even when the retained prefix is valid.
    finally:
      iterator.close()
    if time.monotonic() - started > max(0.0, min(float(time_budget), SCAN_BUDGET_SECONDS)):
        scan_complete = False
    bounded = bound_candidate_result(candidates, min(64, cap))
    scan_complete = scan_complete and bounded["scanComplete"]
    return {"scanComplete": scan_complete, "errorCode": None if scan_complete else (bounded["errorCode"] or "PROC_SCAN_INCOMPLETE"), "candidates": bounded["candidates"]}


def _run_bounded_process_command(command, args, timeout_seconds=2.0):
    """Capture a small stdout stream without retaining stderr or unbounded output."""
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
        selector = selectors.DefaultSelector()
        selector.register(child.stdout, selectors.EVENT_READ)
        while True:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                return None, "NVIDIA_SMI_TIMEOUT"
            ready = selector.select(min(remaining, 0.05))
            if not ready:
                if child.poll() is not None:
                    # Drain the pipe through EOF before waiting for process exit.
                    continue
                continue
            chunk = os.read(child.stdout.fileno(), min(8192, MAX_PROCESS_GPU_OUTPUT_BYTES + 1 - len(output)))
            if not chunk:
                break
            output.extend(chunk)
            if len(output) > MAX_PROCESS_GPU_OUTPUT_BYTES:
                return None, "NVIDIA_SMI_RESPONSE_LIMIT"
            row_count += chunk.count(b"\n")
            if row_count > MAX_PROCESS_GPU_ROWS:
                return None, "NVIDIA_SMI_RESPONSE_LIMIT"
        if output and not output.endswith(b"\n"):
            row_count += 1
        if row_count > MAX_PROCESS_GPU_ROWS:
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


def _query_process_gpu_csv():
    executable = shutil.which("nvidia-smi") or "/usr/bin/nvidia-smi"
    args = ["--query-compute-apps=pid,gpu_uuid,used_gpu_memory", "--format=csv,noheader,nounits"]
    return _run_bounded_process_command(executable, args, timeout_seconds=2.0)


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
        if (not isinstance(uuid, str) or len(uuid) > 128 or
                not re.fullmatch(r"GPU-[A-Za-z0-9-]+", uuid) or
                type(index) is not int or index < 0 or index > 4095 or
                uuid in by_uuid or index in seen_indexes):
            return None
        by_uuid[uuid] = "GPU " + str(index)
        seen_indexes.add(index)
    return by_uuid


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
        if row.get("roleEvidence") not in ("exact_script_entry", "exact_entry_and_direct_writer_fd"):
            continue
        entry = row.get("scriptEntry") if isinstance(row.get("scriptEntry"), str) else row.get("launcherEntry")
        if not isinstance(entry, str) or not entry:
            continue
        key = row.get("processKey")
        if not isinstance(key, dict):
            continue
        pid = key.get("pid")
        start_ticks = key.get("startTicks")
        if (key.get("hostBootId") != boot_id or type(pid) is not int or pid <= 0 or
                not isinstance(start_ticks, str) or not start_ticks.isdecimal()):
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
        _fields_ = [("pid", ctypes.c_uint), ("timestamp", ctypes.c_ulonglong),
                    ("sm", ctypes.c_uint), ("memory", ctypes.c_uint),
                    ("encoder", ctypes.c_uint), ("decoder", ctypes.c_uint)]

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
        deadline = time.monotonic() + 0.3
        for uuid, device_id in device_map.items():
            if time.monotonic() > deadline:
                break
            handle = ctypes.c_void_p()
            if handle_for_uuid(uuid.encode("ascii"), ctypes.byref(handle)) != 0:
                continue
            count = ctypes.c_uint(0)
            code = query(handle, None, ctypes.byref(count), since_us)
            if code not in (0, 7) or not 0 < count.value <= 1024:
                continue
            buffer = (UtilizationSample * count.value)()
            capacity = count.value
            if query(handle, buffer, ctypes.byref(count), since_us) != 0 or count.value > capacity:
                continue
            for row in buffer[:count.value]:
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
        for pid, device_id, timestamp, utilization in samples:
            if pid not in candidates or (pid, device_id) not in pairs:
                continue
            birth_us = boot_us + int(candidates[pid]["startTicks"]) * 1_000_000 // hz
            if (type(utilization) is not int or not 0 <= utilization <= 100 or
                    not max(now_us - 5_000_000, birth_us + 50_000) <= timestamp <= now_us):
                continue
            old = latest.get((pid, device_id))
            if old is None or timestamp > old[0]:
                latest[(pid, device_id)] = (timestamp, utilization)
        return {pair: value[1] for pair, value in latest.items()}
    except (OSError, AttributeError, ValueError, TypeError, OverflowError):
        return {}


def _sample_process_gpu(proc_root, boot_id, process_rows, gpu_devices):
    """Attribute aggregate compute-app rows only to stable, verified task PIDs."""
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

    before = {}
    for pid, expected in candidates.items():
        try:
            owner = os.stat(os.path.join(proc_root, str(pid)), follow_symlinks=False).st_uid
            identity = _proc_identity(proc_root, pid, boot_id)
        except (OSError, ValueError, UnicodeError):
            continue
        if owner == current_uid and identity == {"bootId": boot_id, "pid": pid, "startTicks": expected["startTicks"]}:
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
        if owner == current_uid and identity == {"bootId": boot_id, "pid": pid, "startTicks": expected["startTicks"]}:
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
        pid = int(columns[0])
        # Drop all non-target process lines before parsing or retaining other fields.
        if pid not in after:
            continue
        if len(columns) != 3:
            return _process_gpu_payload("unavailable", error_code="NVIDIA_SMI_RESPONSE_INVALID", process_keys=process_keys)
        uuid = columns[1]
        device_id = device_map.get(uuid)
        if device_id is None:
            return _process_gpu_payload("unavailable", error_code="GPU_DEVICE_UNMAPPED", process_keys=process_keys)
        memory_text = columns[2]
        if re.fullmatch(r"(?:N/A|NA|Not Supported|Unknown|-)", memory_text, re.IGNORECASE):
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
            if existing is None or memory_bytes is not None and memory_bytes > existing:
                aggregates[row_key] = memory_bytes
        else:
            seen_rows.add(row_key)
            aggregates[row_key] = memory_bytes

    utilization = _process_gpu_utilization(after, device_map, aggregates) if aggregates else {}
    if utilization:
        # NVML reads must be covered by the same identity check as memory sampling.
        for pid in list(after):
            try:
                owner = os.stat(os.path.join(proc_root, str(pid)), follow_symlinks=False).st_uid
                identity = _proc_identity(proc_root, pid, boot_id)
                stable = owner == current_uid and identity == {"bootId": boot_id, "pid": pid, "startTicks": after[pid]["startTicks"]}
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
        if hosts is None or not _path_in_scope(os.path.realpath(path), hosts, tasks):
            return False
        fd = os.open(path, os.O_RDONLY | getattr(os, "O_CLOEXEC", 0) | getattr(os, "O_NOFOLLOW", 0))
        opened = os.fstat(fd)
        if _identity(opened) != expected_identity:
            return False
        os.lseek(fd, start, os.SEEK_SET)
        data = os.read(fd, length)
        final = os.fstat(fd)
        current = os.stat(path, follow_symlinks=False)
        resolved_after = os.path.realpath(path)
        hosts_after, tasks_after = _canonical_task_roots(host_roots, task_directories)
        return (hosts_after == hosts and tasks_after == tasks and len(data) == length and hashlib.sha256(data).hexdigest() == expected_sha256
                and _same_identity(opened, final) and _same_identity(final, current)
                and _path_in_scope(resolved_after, hosts_after, tasks_after))
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
    return {"status": "ok", "fileIdentity": result["identity"], "sizeBytes": result["sizeBytes"], "observedAt": time.time_ns() // 1_000_000}


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
        try:
            same_path = os.path.realpath(current_path) == os.path.realpath(path)
            same_file = current["identity"] == before["fileIdentity"]
        finally:
            pass
        if same_path or same_file:
            return {"ok": False, "errorCode": "CURRENT_FILE_NOT_ARCHIVE"}
    try:
        fd = os.open(path, os.O_RDONLY | getattr(os, "O_CLOEXEC", 0) | getattr(os, "O_NOFOLLOW", 0))
        try:
            opened = os.fstat(fd)
            if _identity(opened) != before["fileIdentity"]:
                return {"ok": False, "errorCode": "PATH_IDENTITY_CHANGED"}
            os.lseek(fd, offset, os.SEEK_SET)
            data = os.read(fd, limit)
            after_info = os.fstat(fd)
        finally:
            os.close(fd)
    except FileNotFoundError:
        return {"ok": False, "errorCode": "SOURCE_MISSING"}
    except PermissionError:
        return {"ok": False, "errorCode": "SOURCE_PERMISSION"}
    after = _observe_source(path, host_roots, task_dirs, anchors)
    if after.get("status") != "ok" or after.get("fileIdentity") != before.get("fileIdentity") or not _same_identity(opened, after_info):
        return {"ok": False, "errorCode": after.get("errorCode", "PATH_IDENTITY_CHANGED")}
    return {"ok": True, "expected": request.get("expected"), "before": before, "after": after, "startOffset": str(offset), "bytesBase64": base64.b64encode(data).decode("ascii"), "bytesLength": len(data)}


def scan_rotation_candidates(current_path, candidates, host_roots, task_directories, anchors, max_candidates=64, time_budget=SCAN_BUDGET_SECONDS):
    started = time.monotonic()
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
        if time.monotonic() - started > min(max(float(time_budget), 0.0), SCAN_BUDGET_SECONDS):
            return {"scanComplete": False, "checkedCount": index, "errorCode": "ROTATION_SCAN_INCOMPLETE", "candidates": matches}
        if not isinstance(candidate, str):
            return {"scanComplete": False, "checkedCount": index, "errorCode": "ROTATION_SCAN_INVALID", "candidates": matches}
        if time.monotonic() - started > min(max(float(time_budget), 0.0), SCAN_BUDGET_SECONDS):
            return {"scanComplete": False, "checkedCount": index, "errorCode": "ROTATION_SCAN_INCOMPLETE", "candidates": matches}
        result = open_readonly(candidate, host_roots, task_directories, limit_bytes=0)
        if result.get("status") != "ok":
            return {"scanComplete": False, "checkedCount": index, "errorCode": result.get("errorCode", "ROTATION_CANDIDATE_UNAVAILABLE"), "candidates": matches}
        if os.path.realpath(candidate) == os.path.realpath(current_path) or result["identity"] == current["identity"]:
            continue
        if not all(_sample(candidate, host_roots, task_directories, result["identity"], int(item.get("startOffset", -1)), item.get("length"), item.get("sha256")) for item in anchors):
            continue
        matches.append({"candidateIndex": index, "sizeBytes": result["sizeBytes"]})
    return {"scanComplete": True, "checkedCount": len(candidates), "errorCode": None, "candidates": matches}


def _dispatch(request):
    op = request.get("op")
    if op == "probe_launch_readiness":
        # First launches have no log yet. Readiness depends on process identity,
        # not log existence or writer evidence.
        probe_request = dict(request, op="probe_task", includeProcessGpu=False)
        probe_request["task"] = dict(request.get("task", {}), sources=[])
        result = _dispatch(probe_request)
        return {"scanComplete": result.get("scanComplete") is True,
                "running": bool(result.get("processes")), "errorCode": result.get("errorCode")}
    if op == "read_log":
        payload = _read_log(request)
        if isinstance(payload, dict) and payload.get("errorCode"):
            payload.setdefault("errorScope", "source")
            payload.setdefault("phase", "source_read")
        return payload
    if op == "probe_task":
        proc = request.get("proc", {})
        boot_id = None
        try:
            with open(os.path.join(proc.get("root", "/proc"), "sys", "kernel", "random", "boot_id"), "r", encoding="ascii") as stream:
                boot_id = stream.read(128).strip()
        except OSError:
            pass
        task = request.get("task", {})
        host_roots = task.get("hostAllowedRoots", [])
        task_dirs = task.get("allowedDirectories", [])
        sources = []
        for source in task.get("sources", [])[:64]:
            if not isinstance(source, dict) or not isinstance(source.get("path"), str):
                continue
            is_status = source.get("kind") == "status_json"
            try:
                result = open_readonly(source["path"], host_roots, task_dirs, limit_bytes=MAX_STATUS_BYTES + 1 if is_status else 0)
            except Exception:
                result = {"status": "error", "errorCode": "SOURCE_READ_FAILED"}
            status = result.get("status")
            row = {"sourceId": source.get("sourceId"), "kind": source.get("kind"), "status": status, "errorCode": result.get("errorCode"), "errorScope": "source" if result.get("errorCode") else None, "phase": "source_read" if result.get("errorCode") else None, "fileIdentity": result.get("identity"), "eofBytes": result.get("sizeBytes"), "observedAt": time.time_ns() // 1_000_000}
            if is_status and status == "ok":
                try:
                    projection = project_status_json(result.get("data", b""), {
                        "step", "target", "status", "updated_at", "checkpoint",
                        "taskId", "hostId", "hostBootId", "pid", "startTicks", "sequence",
                        "resume_checkpoint_index", "target_meaning",
                    })
                except Exception:
                    projection = {"status": "error", "errorCode": "STATUS_JSON_INVALID"}
                row["statusValues"] = projection.get("values") if projection.get("status") == "ok" else None
                if projection.get("status") == "ok":
                    row["statusRawContent"] = result.get("data", b"").decode("utf-8")
                if projection.get("status") != "ok":
                    row["errorCode"] = projection.get("errorCode")
            sources.append(row)
        source_observations = {}
        source_rows_by_id = {row.get("sourceId"): row for row in sources if isinstance(row, dict)}
        for source in task.get("sources", [])[:64]:
            row = source_rows_by_id.get(source.get("sourceId")) if isinstance(source, dict) else None
            if (isinstance(source, dict) and source.get("kind") == "log" and isinstance(row, dict)
                    and row.get("status") == "ok" and isinstance(row.get("fileIdentity"), dict)
                    and isinstance(row.get("eofBytes"), str)):
                source_observations[source["path"]] = {"fileIdentity": row["fileIdentity"], "eofBytes": row["eofBytes"]}
        scan_task = dict(task)
        scan_task["sourceObservations"] = source_observations
        scan = scan_registered_processes(proc.get("root", "/proc"), boot_id, scan_task)
        process_rows = []
        source_ids = {item.get("path"): item.get("sourceId") for item in task.get("sources", []) if isinstance(item, dict) and item.get("kind") == "log"}
        for item in scan.get("candidates", []):
            writer_ids = [source_ids[path] for path in item.get("writerSources", []) if path in source_ids]
            writer_source_evidence = {source_ids[path]: evidence for path, evidence in item.get("writerSourceEvidence", {}).items() if path in source_ids}
            entry = (isinstance(item.get("scriptEntry"), str) or isinstance(item.get("launcherEntry"), str)) and item.get("evidenceComplete") is True
            role_evidence = ("exact_entry_and_direct_writer_fd" if writer_ids else "exact_script_entry") if entry else "none"
            process_rows.append({"processKey": item.get("processKey"), "role": "unknown", "roleEvidence": role_evidence, "writerSourceIds": writer_ids, "writerSourceEvidence": writer_source_evidence, "writerEvidenceComplete": item.get("writerEvidenceComplete") is True and scan["scanComplete"], "cwd": item.get("cwd"), "scriptEntry": item.get("scriptEntry"), "launcherEntry": item.get("launcherEntry"), "interpreterFlags": item.get("interpreterFlags", []), "evidenceComplete": item.get("evidenceComplete") is True and scan["scanComplete"], "observedAt": time.time_ns() // 1_000_000})
        complete = scan["scanComplete"] and len(task.get("sources", [])) <= 64
        error_code = scan["errorCode"] or ("SOURCE_CANDIDATE_LIMIT" if len(task.get("sources", [])) > 64 else None)
        payload = {"scanComplete": complete, "errorCode": error_code, "errorScope": "task" if error_code else None, "phase": "process_scan" if error_code else None, "processes": process_rows, "sources": sources}
        if request.get("includeProcessGpu") is True:
            try:
                payload["processGpu"] = _sample_process_gpu(proc.get("root", "/proc"), boot_id, process_rows, request.get("gpuDevices"))
            except Exception:
                # GPU attribution is optional and must never alter process or log scan results.
                payload["processGpu"] = _process_gpu_payload("unavailable", error_code="PROCESS_GPU_SAMPLE_FAILED")
        return payload
    if op == "probe_host":
        try:
            with open("/proc/sys/kernel/random/boot_id", "r", encoding="ascii") as stream:
                boot_id = stream.read(128).strip()
            gpu = {"status": "skipped", "observedAt": None, "csv": None, "errorCode": None}
            if request.get("includeGpu") is not False:
                gpu = _query_linux_gpu()
            return {"hostBootId": boot_id, "scanComplete": True, "errorCode": None, "errorScope": None, "phase": None, "gpu": gpu}
        except OSError:
            return {"hostBootId": None, "scanComplete": False, "errorCode": "HOST_IDENTITY_UNAVAILABLE", "errorScope": "host", "phase": "probe"}
    if op == "scan_rotation":
        payload = scan_rotation_candidates(request.get("currentPath"), request.get("candidates", []), request.get("hostAllowedRoots", []), request.get("taskAllowedDirectories", []), request.get("anchors", []))
        if isinstance(payload, dict) and payload.get("errorCode"):
            payload.setdefault("errorScope", "source")
            payload.setdefault("phase", "archive_scan")
        return payload
    return {"errorCode": "REQUEST_OP_UNSUPPORTED", "errorScope": "request", "phase": "dispatch"}


def _query_linux_gpu(include_free=False):
    """Read aggregate device counters only; never request process attribution."""
    executable = shutil.which("nvidia-smi") or "/usr/bin/nvidia-smi"
    fields = "index,uuid,utilization.gpu,memory.used,memory.total" + (",memory.free" if include_free else "")
    args = [executable, "--query-gpu=" + fields, "--format=csv,noheader,nounits"]
    try:
        result = subprocess.run(args, capture_output=True, timeout=2, check=False)
    except subprocess.TimeoutExpired:
        return {"status": "unavailable", "observedAt": None, "csv": None, "errorCode": "NVIDIA_SMI_TIMEOUT"}
    except OSError:
        return {"status": "unavailable", "observedAt": None, "csv": None, "errorCode": "NVIDIA_SMI_UNAVAILABLE"}
    if result.returncode != 0:
        return {"status": "unavailable", "observedAt": None, "csv": None, "errorCode": "NVIDIA_SMI_FAILED"}
    if len(result.stdout) > 16 * 1024:
        return {"status": "unavailable", "observedAt": None, "csv": None, "errorCode": "NVIDIA_SMI_RESPONSE_LIMIT"}
    return {"status": "ok", "observedAt": time.time_ns() // 1_000_000,
            "csv": result.stdout.decode("utf-8", "replace"), "errorCode": None}


def _emit_frame(envelope):
    payload = json.dumps(envelope, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
    if len(payload) > MAX_RESPONSE_BYTES:
        payload = json.dumps({"version": VERSION, "requestId": envelope.get("requestId"), "sourceId": envelope.get("sourceId"), "payload": {"errorCode": "RESPONSE_LIMIT", "errorScope": "request", "phase": "frame"}}).encode("ascii")
    sys.stdout.buffer.write(len(payload).to_bytes(4, "big"))
    sys.stdout.buffer.write(payload)
    sys.stdout.buffer.flush()


def main():
    if REQUEST_B64 == "__MONITOR_REQUEST_B64__":
        _emit_frame({"version": VERSION, "requestId": None, "sourceId": None, "payload": {"errorCode": "REQUEST_MISSING", "errorScope": "request", "phase": "decode"}})
        return 2
    request = None
    try:
        request = json.loads(base64.b64decode(REQUEST_B64, validate=True).decode("utf-8"))
        if not isinstance(request, dict) or request.get("version") != VERSION:
            raise ValueError("invalid request schema")
        payload = _dispatch(request)
        if isinstance(payload, dict) and payload.get("errorCode"):
            if not isinstance(payload.get("errorScope"), str):
                payload["errorScope"] = "request"
            if not isinstance(payload.get("phase"), str):
                payload["phase"] = "dispatch"
        envelope = {"version": VERSION, "requestId": request.get("requestId"), "sourceId": request.get("sourceId"), "payload": payload}
        _emit_frame(envelope)
        return 0
    except Exception:
        _emit_frame({"version": VERSION, "requestId": request.get("requestId") if isinstance(request, dict) else None,
                     "sourceId": request.get("sourceId") if isinstance(request, dict) else None,
                     "payload": {"errorCode": "PROBE_REQUEST_INVALID", "errorScope": "request", "phase": "dispatch"}})
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
