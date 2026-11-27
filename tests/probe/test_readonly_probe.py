import importlib.util
import hashlib
import os
import stat
from pathlib import Path
import tempfile
import unittest
import base64
import io
import json
import types
from unittest import mock


MODULE_PATH = Path(__file__).parents[2] / "src" / "probe" / "readonly_probe.py"
SPEC = importlib.util.spec_from_file_location("readonly_probe", MODULE_PATH)
probe = importlib.util.module_from_spec(SPEC)
assert SPEC and SPEC.loader
SPEC.loader.exec_module(probe)


class ReadOnlyProbeTests(unittest.TestCase):
    def test_status_probe_preserves_run_identity_for_verified_progress(self):
        with tempfile.TemporaryDirectory() as directory:
            status = Path(directory) / "status.json"
            values = {"taskId": "task", "hostId": "host", "hostBootId": "boot",
                      "pid": 123, "startTicks": "456", "sequence": 7,
                      "resume_checkpoint_index": 0, "target": 101,
                      "target_meaning": "exclusive_index", "password": "private"}
            status.write_text(json.dumps(values), encoding="utf-8")
            payload = probe._dispatch({"op": "probe_task", "proc": {"root": str(Path(directory)/"missing-proc")},
                "task": {"hostAllowedRoots": [directory], "allowedDirectories": [directory],
                         "sources": [{"sourceId": "status", "kind": "status_json", "path": str(status)}]}})
            projected = payload["sources"][0]["statusValues"]
            self.assertNotIn("password", projected)
            for name in ("taskId", "hostId", "hostBootId", "pid", "startTicks", "sequence",
                         "resume_checkpoint_index", "target", "target_meaning"):
                self.assertEqual(projected[name], values[name])

    def test_linux_gpu_probe_uses_only_aggregate_nvidia_smi_query(self):
        with mock.patch.object(probe, "_find_nvidia_smi", return_value="/usr/bin/nvidia-smi"), \
             mock.patch.object(probe, "_run_bounded_command", return_value=(b"0, GPU-a, 0, 512, 8192\n", None)) as run:
            result = probe._query_linux_gpu()
        self.assertEqual(result["status"], "ok")
        self.assertEqual(result["acceleratorAvailability"], "available")
        self.assertEqual(result["csv"], "0, GPU-a, 0, 512, 8192\n")
        self.assertEqual(run.call_args.args[0], "/usr/bin/nvidia-smi")
        self.assertEqual(run.call_args.args[1], ["--query-gpu=index,uuid,utilization.gpu,memory.used,memory.total", "--format=csv,noheader,nounits"])
        self.assertEqual(run.call_args.kwargs["timeout_seconds"], 2.0)
        self.assertEqual(run.call_args.kwargs["max_bytes"], 16 * 1024)
        self.assertNotIn("compute-apps", " ".join(run.call_args.args[1]))

    def test_gpu_query_failure_is_independent_of_host_identity(self):
        with mock.patch.object(probe, "_find_nvidia_smi", return_value="/usr/bin/nvidia-smi"), \
             mock.patch.object(probe, "_run_bounded_command", return_value=(None, "NVIDIA_SMI_TIMEOUT")):
            result = probe._query_linux_gpu()
        self.assertEqual(result, {
            "status": "unavailable",
            "acceleratorAvailability": "unavailable",
            "observedAt": None,
            "csv": None,
            "errorCode": "NVIDIA_SMI_TIMEOUT",
        })

    def test_scanner_ignores_foreign_uid_and_pid_disappearing_before_identity(self):
        class Entry:
            def __init__(self, name, uid): self.name, self.uid = name, uid
            def stat(self, follow_symlinks=False): return types.SimpleNamespace(st_uid=self.uid)
        class Scan:
            def __init__(self, entries): self.entries = iter(entries)
            def __iter__(self): return self
            def __next__(self): return next(self.entries)
            def close(self): pass

        proc_root = "/fake-proc"
        entries = [Entry("7", 2000), Entry("8", 1000)]
        def fake_scandir(path):
            if path == proc_root: return Scan(entries)
            raise FileNotFoundError(path)
        def fake_open(path, *args, **kwargs):
            if path == os.path.join(proc_root, "7", "stat"):
                raise PermissionError(path)
            if path == os.path.join(proc_root, "8", "cmdline"):
                raise FileNotFoundError(path)
            raise AssertionError(path)

        with mock.patch.object(probe.os, "getuid", return_value=1000, create=True), \
             mock.patch.object(probe.os, "scandir", side_effect=fake_scandir), \
             mock.patch("builtins.open", side_effect=fake_open):
            result = probe.scan_registered_processes(proc_root, "boot", {})

        self.assertTrue(result["scanComplete"], result)
        self.assertEqual(result["candidates"], [])

    def _scan_fake_proc(self, argv, fdinfo, *, replace_fd=False, source_identity=None, source_eof=None, fd_target=None, dispatch=False, replace_source=False, proc_accesses=None, cwd_error=False, cwd_missing=False):
        class Entry:
            def __init__(self, name): self.name = name
            def stat(self, follow_symlinks=False): return types.SimpleNamespace(st_uid=1000)
        class Scan:
            def __init__(self, names): self.names = iter(names)
            def __iter__(self): return self
            def __next__(self): return Entry(next(self.names))
            def close(self): pass

        with tempfile.TemporaryDirectory() as directory:
            host = Path(directory) / "host"
            task_dir = host / "run"
            task_dir.mkdir(parents=True)
            source = task_dir / "train.log"
            source.write_bytes(b"old-eof")
            registered_entry = str(task_dir / "train.py")
            actual = os.stat(source)
            identity = source_identity or {"dev": str(actual.st_dev), "inode": str(actual.st_ino)}
            registration = {"hostAllowedRoots": [str(host)], "allowedDirectories": [str(task_dir)],
                            "entryPaths": [str(task_dir / "train.py")], "sources": [
                                {"sourceId": "log", "kind": "log", "path": str(source)}],
                            "sourceObservations": {str(source): {"fileIdentity": identity, "eofBytes": source_eof if source_eof is not None else str(actual.st_size)}}}
            proc_root = "/fake-proc"
            pid_dir = os.path.join(proc_root, "42")
            fd_path = os.path.join(pid_dir, "fd", "3")
            target = fd_target or str(source)
            real_stat = os.stat
            real_open = open
            stat_line = "42 (python3) R " + " ".join(["0"] * 18 + ["100"])
            fdstat_count = 0
            def fake_scandir(path):
                if proc_accesses is not None and path.startswith(proc_root): proc_accesses.append(("scandir", os.path.basename(path)))
                if path == proc_root: return Scan(["42"])
                if path == os.path.join(pid_dir, "fd"): return Scan(["3"])
                raise FileNotFoundError(path)
            def fake_open(path, *args, **kwargs):
                if proc_accesses is not None and path.startswith(proc_root): proc_accesses.append(("open", os.path.basename(path)))
                if path == os.path.join(pid_dir, "stat"):
                    return io.StringIO(stat_line)
                if path == os.path.join(proc_root, "sys", "kernel", "random", "boot_id"):
                    return io.StringIO("boot")
                if path == os.path.join(pid_dir, "cmdline"):
                    values = [registered_entry if item == "$ENTRY" else item for item in argv]
                    return io.BytesIO(b"python3\0" + b"\0".join(item.encode() for item in values) + b"\0")
                if path == os.path.join(pid_dir, "fdinfo", "3"):
                    if fdinfo is None: raise PermissionError(path)
                    return io.StringIO(fdinfo)
                return real_open(path, *args, **kwargs)
            replacement_stat = os.stat_result((stat.S_IFREG | 0o600, 999, actual.st_dev, 1, 1, 1, 7, 0, 0, 0))
            def fake_stat(path, *args, **kwargs):
                nonlocal fdstat_count
                if path == fd_path:
                    fdstat_count += 1
                    return replacement_stat if replace_fd and fdstat_count > 1 else actual
                return real_stat(path, *args, **kwargs)
            real_realpath = os.path.realpath
            def fake_realpath(path, *args, **kwargs):
                if proc_accesses is not None and path.startswith(proc_root): proc_accesses.append(("realpath", os.path.basename(path)))
                if path == os.path.join(pid_dir, "cwd"):
                    if cwd_missing: raise FileNotFoundError(path)
                    if cwd_error: raise PermissionError(path)
                    return "/home/cy"
                if path == os.path.join(pid_dir, "exe"): return "/usr/bin/python3"
                if path == fd_path: return target
                return real_realpath(path, *args, **kwargs)
            real_scanner = probe.scan_registered_processes
            def scan_after_dispatch(*args, **kwargs):
                if dispatch and replace_source:
                    source.rename(task_dir / "old-generation.log")
                    source.write_bytes(b"replacement-generation")
                return real_scanner(*args, **kwargs)
            with mock.patch.object(probe.os, "scandir", side_effect=fake_scandir), \
                 mock.patch.object(probe.os, "getuid", return_value=1000, create=True), \
                 mock.patch("builtins.open", side_effect=fake_open), \
                 mock.patch.object(probe.os, "stat", side_effect=fake_stat), \
                 mock.patch.object(probe.os.path, "realpath", side_effect=fake_realpath), \
                 mock.patch.object(probe, "scan_registered_processes", side_effect=scan_after_dispatch):
                if dispatch:
                    request = {"op": "probe_task", "proc": {"root": proc_root}, "task": registration}
                    return probe._dispatch(request)
                return probe.scan_registered_processes(proc_root, "boot", registration)

    @unittest.skipUnless(os.name == "posix", "requires POSIX /proc or path semantics")
    def test_actual_scanner_extracts_flags_after_pos_and_emits_writer(self):
        result = self._scan_fake_proc(["$ENTRY"], "pos:\t0\nflags:\t0100001\nmnt_id:\t2\n")
        self.assertTrue(result["scanComplete"], result)
        self.assertEqual(len(result["candidates"]), 1, result)
        self.assertEqual(result["candidates"][0]["writerSources"], [result["candidates"][0]["scriptEntry"].replace("train.py", "train.log")])

    @unittest.skipUnless(os.name == "posix", "requires POSIX /proc or path semantics")
    def test_actual_scanner_marks_fd_replacement_incomplete(self):
        result = self._scan_fake_proc(["$ENTRY"], "flags:\t0100001\npos:\t0\n", replace_fd=True)
        self.assertFalse(result["scanComplete"])
        self.assertEqual(len(result["candidates"]), 1, result)
        self.assertFalse(result["candidates"][0]["writerEvidenceComplete"])

    @unittest.skipUnless(os.name == "posix", "requires POSIX /proc or path semantics")
    def test_actual_scanner_keeps_read_only_fd_as_complete_negative(self):
        result = self._scan_fake_proc(["$ENTRY"], "pos:\t0\nflags:\t0100000\nmnt_id:\t2\n")
        self.assertTrue(result["scanComplete"], result)
        self.assertEqual(result["candidates"][0]["writerSources"], [])
        self.assertTrue(result["candidates"][0]["writerEvidenceComplete"])

    @unittest.skipUnless(os.name == "posix", "requires POSIX /proc or path semantics")
    def test_actual_scanner_rejects_stale_source_eof(self):
        result = self._scan_fake_proc(["$ENTRY"], "flags:\t0100001\npos:\t0\n", source_eof="999")
        self.assertFalse(result["scanComplete"])
        self.assertEqual(result["candidates"][0]["writerSources"], [])
        self.assertFalse(result["candidates"][0]["writerEvidenceComplete"])

    @unittest.skipUnless(os.name == "posix", "requires POSIX /proc or path semantics")
    def test_actual_scanner_marks_unreadable_fdinfo_incomplete(self):
        result = self._scan_fake_proc(["$ENTRY"], None)
        self.assertFalse(result["scanComplete"])
        self.assertFalse(result["candidates"][0]["writerEvidenceComplete"])

    @unittest.skipUnless(os.name == "posix", "requires POSIX /proc or path semantics")
    def test_actual_scanner_ignores_unreadable_cwd_for_unmatched_entry(self):
        result = self._scan_fake_proc(["unrelated.py"], "pos:\t0\nflags:\t0100001\n", cwd_error=True)
        self.assertTrue(result["scanComplete"], result)
        self.assertEqual(result["candidates"], [])

    @unittest.skipUnless(os.name == "posix", "requires POSIX /proc or path semantics")
    def test_missing_cwd_on_unmatched_process_does_not_invalidate_the_scan(self):
        result = self._scan_fake_proc(["unrelated.py"], "flags:\t0100001\n", cwd_missing=True)
        self.assertTrue(result["scanComplete"], result)
        self.assertEqual(result["candidates"], [])

    @unittest.skipUnless(os.name == "posix", "requires POSIX /proc or path semantics")
    def test_absolute_registered_entry_is_checked_when_cwd_disappears(self):
        result = self._scan_fake_proc(["$ENTRY"], "flags:\t0100001\n", cwd_missing=True)
        self.assertTrue(result["scanComplete"], result)
        self.assertEqual(len(result["candidates"]), 1)
        self.assertTrue(result["candidates"][0]["writerEvidenceComplete"])

    @unittest.skipUnless(os.name == "posix", "requires POSIX /proc or path semantics")
    def test_actual_scanner_checks_absolute_registered_entry_when_cwd_is_unreadable(self):
        result = self._scan_fake_proc(["$ENTRY"], None, cwd_error=True)
        self.assertFalse(result["scanComplete"])
        self.assertEqual(len(result["candidates"]), 1, result)
        self.assertIsNone(result["candidates"][0]["cwd"])
        self.assertFalse(result["candidates"][0]["writerEvidenceComplete"])

    @unittest.skipUnless(os.name == "posix", "requires POSIX /proc or path semantics")
    def test_actual_scanner_does_not_attach_new_inode_writer_to_old_source_observation(self):
        result = self._scan_fake_proc(["$ENTRY"], "flags:\t0100001\npos:\t0\n", source_identity={"dev": "old", "inode": "old"})
        self.assertFalse(result["scanComplete"])
        self.assertEqual(len(result["candidates"]), 1, result)
        self.assertEqual(result["candidates"][0]["writerSources"], [])
        self.assertFalse(result["candidates"][0]["writerEvidenceComplete"])

    @unittest.skipUnless(os.name == "posix", "requires POSIX /proc or path semantics")
    def test_dispatch_with_source_replacement_between_sampling_and_scan_withholds_writer(self):
        result = self._scan_fake_proc(["$ENTRY"], "pos:\t0\nflags:\t0100001\n", dispatch=True, replace_source=True)
        self.assertFalse(result["scanComplete"])
        self.assertEqual(result["processes"][0]["writerSourceIds"], [])
        self.assertFalse(result["processes"][0]["writerEvidenceComplete"])

    def test_dispatch_passes_exact_source_identity_and_eof_to_scanner(self):
        source = {"sourceId": "log", "kind": "log", "path": "/allowed/run/train.log"}
        task = {"hostAllowedRoots": ["/allowed"], "allowedDirectories": ["/allowed/run"], "entryPaths": [], "sources": [source]}
        sample = {"status": "ok", "identity": {"dev": "3", "inode": "4"}, "sizeBytes": "29", "data": b""}
        with mock.patch.object(probe, "open_readonly", return_value=sample), \
             mock.patch.object(probe, "scan_registered_processes", return_value={"scanComplete": True, "errorCode": None, "candidates": []}) as scanner:
            probe._dispatch({"op": "probe_task", "proc": {"root": "/fake-proc"}, "task": task})
        self.assertEqual(scanner.call_args.args[2].get("sourceObservations"), {
            "/allowed/run/train.log": {"fileIdentity": {"dev": "3", "inode": "4"}, "eofBytes": "29"}})

    def test_dispatch_keys_source_witness_by_source_id_not_filtered_position(self):
        invalid = {"sourceId": "skipped", "kind": "log", "path": None}
        valid = {"sourceId": "actual", "kind": "log", "path": "/allowed/run/actual.log"}
        task = {"hostAllowedRoots": ["/allowed"], "allowedDirectories": ["/allowed/run"],
                "entryPaths": [], "sources": [invalid, valid]}
        sample = {"status": "ok", "identity": {"dev": "3", "inode": "4"}, "sizeBytes": "29", "data": b""}
        with mock.patch.object(probe, "open_readonly", return_value=sample), \
             mock.patch.object(probe, "scan_registered_processes", return_value={"scanComplete": True, "errorCode": None, "candidates": []}) as scanner:
            probe._dispatch({"op": "probe_task", "proc": {"root": "/fake-proc"}, "task": task})
        self.assertEqual(scanner.call_args.args[2].get("sourceObservations"), {
            "/allowed/run/actual.log": {"fileIdentity": {"dev": "3", "inode": "4"}, "eofBytes": "29"}})

    def test_actual_main_error_frame_has_matching_scope_and_phase_fields(self):
        source = MODULE_PATH.read_text(encoding="utf-8")
        request = {"version": 1, "requestId": "req-error", "sourceId": "source-error", "op": "probe_task", "proc": None, "task": {}}
        encoded = base64.b64encode(json.dumps(request).encode()).decode()
        namespace = {"__name__": "readonly_probe_test"}
        exec(compile(source.replace("__MONITOR_REQUEST_B64__", encoded, 1), str(MODULE_PATH), "exec"), namespace)
        output = io.BytesIO()
        namespace["sys"] = types.SimpleNamespace(stdout=type("Stdout", (), {"buffer": output})())
        self.assertEqual(namespace["main"](), 2)
        frame = output.getvalue()
        self.assertEqual(frame[:4], b"TMF1")
        envelope = json.loads(frame[8:8 + int.from_bytes(frame[4:8], "big")])
        self.assertEqual((envelope["requestId"], envelope["sourceId"]), ("req-error", "source-error"))
        self.assertEqual(envelope["payload"], {"errorCode": "PROBE_REQUEST_INVALID", "errorScope": "request", "phase": "dispatch"})

    def test_actual_main_scan_rotation_limit_emits_archive_scan_phase(self):
        source = MODULE_PATH.read_text(encoding="utf-8")
        request = {
            "version": 1,
            "requestId": "req-rot-limit",
            "sourceId": "source-rot-limit",
            "op": "scan_rotation",
            "currentPath": "/allowed/run/train.log",
            "candidates": [f"/allowed/run/train.log.{i}" for i in range(65)],
            "hostAllowedRoots": ["/allowed"],
            "taskAllowedDirectories": ["/allowed/run"],
            "anchors": [{"startOffset": "0", "length": 1, "sha256": "0" * 64}],
        }
        encoded = base64.b64encode(json.dumps(request).encode()).decode()
        namespace = {"__name__": "readonly_probe_test"}
        exec(compile(source.replace("__MONITOR_REQUEST_B64__", encoded, 1), str(MODULE_PATH), "exec"), namespace)
        output = io.BytesIO()
        namespace["sys"] = types.SimpleNamespace(stdout=type("Stdout", (), {"buffer": output})())
        self.assertEqual(namespace["main"](), 0)
        frame = output.getvalue()
        self.assertEqual(frame[:4], b"TMF1")
        envelope = json.loads(frame[8:8 + int.from_bytes(frame[4:8], "big")])
        self.assertEqual((envelope["requestId"], envelope["sourceId"]), ("req-rot-limit", "source-rot-limit"))
        self.assertEqual(envelope["payload"], {
            "scanComplete": False,
            "errorCode": "ROTATION_SCAN_LIMIT",
            "candidates": [],
            "errorScope": "source",
            "phase": "archive_scan",
        })

    @unittest.skipUnless(os.name == "posix", "requires POSIX /proc or path semantics")
    def test_actual_scanner_ignores_unmatched_python_processes_with_unknown_options(self):
        for argv in (["-cprint(1)", "$ENTRY"], ["-mfoo", "$ENTRY"],
                     ["-I", "-S", "-B", "-"], ["--future-option", "$ENTRY"]):
            with self.subTest(argv=argv):
                proc_accesses = []
                result = self._scan_fake_proc(argv, "pos:\t0\nflags:\t0100001\n", proc_accesses=proc_accesses)
                self.assertEqual(result["candidates"], [])
                self.assertIsNone(result["errorCode"])
                self.assertTrue(result["scanComplete"])
                self.assertNotIn(("open", "stat"), proc_accesses)
                self.assertNotIn(("realpath", "exe"), proc_accesses)
                self.assertNotIn(("scandir", "fd"), proc_accesses)

    def test_encoded_fixed_source_runs_main_and_emits_matching_success_and_error_frames(self):
        source = MODULE_PATH.read_text(encoding="utf-8")
        for payload in ({"ok": True}, {"errorCode": "SOURCE_PERMISSION", "scope": "source"}):
            request = {"version": 1, "requestId": "req-fixed", "sourceId": None, "op": "test"}
            encoded = base64.b64encode(json.dumps(request).encode()).decode()
            fixed = source.replace("__MONITOR_REQUEST_B64__", encoded, 1)
            namespace = {"__name__": "readonly_probe_test"}
            exec(compile(fixed, str(MODULE_PATH), "exec"), namespace)
            namespace["_dispatch"] = lambda _request, p=payload: p
            output = io.BytesIO()
            namespace["sys"] = types.SimpleNamespace(stdout=type("Stdout", (), {"buffer": output})())
            result = namespace["main"]()
            frame = output.getvalue()
            self.assertEqual(frame[:4], b"TMF1")
            length = int.from_bytes(frame[4:8], "big")
            envelope = json.loads(frame[8:8 + length])
            self.assertEqual(result, 0)
            self.assertEqual(envelope["requestId"], "req-fixed")
            self.assertIsNone(envelope["sourceId"])
            self.assertEqual(envelope["payload"], payload)

    def test_host_and_task_authority_are_both_required_for_open(self):
        with tempfile.TemporaryDirectory() as directory:
            host = Path(directory) / "host"
            task = host / "run"
            other = host / "other"
            host.mkdir(); other.mkdir()
            (other / "secret.log").write_bytes(b"private")
            result = probe.open_readonly(str(other / "secret.log"), [str(host)], [str(task)])
            self.assertEqual(result['errorCode'], "PATH_OUTSIDE_TASK_ROOT")

    @unittest.skipUnless(os.name == "posix", "requires POSIX /proc or path semantics")
    def test_argv_argument_containing_registered_path_is_not_script_entry_and_external_cwd_is_allowed(self):
        registration = {"allowedDirectories": ["/registered/run"], "hostAllowedRoots": ["/registered"], "entryPaths": ["/registered/run/train.py"], "sourcePaths": ["/registered/run/train.log"]}
        impostor = probe.project_task_process(registration, "/home/cy", ["python3", "unrelated.py", "--reference", "/registered/run/train.py"], {"hostBootId": "b", "pid": 1, "startTicks": "2"}, ["/registered/run/train.log"])
        self.assertFalse(impostor["entryVerified"])
        valid = probe.project_task_process(registration, "/home/cy", ["python3", "../../registered/run/train.py"], {"hostBootId": "b", "pid": 1, "startTicks": "2"}, [])
        self.assertTrue(valid["entryVerified"])
        self.assertEqual(valid["cwd"], "/home/cy")

    def test_fd_witness_requires_write_flags_matching_inode_and_stable_process_key(self):
        identity = {"dev": "8", "inode": "9"}
        key = {"bootId": "b", "pid": 42, "startTicks": "10"}
        read_only = probe.fd_writable_evidence("flags:\t0100000", identity, identity, key, key, key)
        self.assertFalse(read_only["verified"])
        self.assertEqual(read_only["errorCode"], "FD_NOT_WRITABLE")
        writer = probe.fd_writable_evidence("flags:\t0100001", identity, identity, key, key, key)
        self.assertTrue(writer["verified"])
        stale = probe.fd_writable_evidence("flags:\t0100001", {"dev": "8", "inode": "10"}, identity, key, key, key)
        self.assertFalse(stale["complete"])

    def test_status_recursion_error_isolated_from_sibling_source(self):
        with tempfile.TemporaryDirectory() as directory:
            status = Path(directory) / "status.json"
            log = Path(directory) / "train.log"
            status.write_text('{"nested":' * 1800 + "0" + "}" * 1800, encoding="ascii")
            log.write_bytes(b"safe")
            with mock.patch.object(probe, "project_status_json", side_effect=RecursionError):
                payload = probe._dispatch({"op": "probe_task", "proc": {"root": str(Path(directory) / "missing-proc")}, "task": {
                    "hostAllowedRoots": [directory], "allowedDirectories": [directory], "entryPaths": [],
                    "sources": [{"sourceId": "status", "kind": "status_json", "path": str(status)}, {"sourceId": "log", "kind": "log", "path": str(log)}]}})
            self.assertEqual(payload["sources"][0]["errorCode"], "STATUS_JSON_INVALID")
            self.assertEqual(payload["sources"][1]["status"], "ok")

    def test_candidate_limit_is_explicitly_incomplete(self):
        result = probe.bound_candidate_result([{"pid": n} for n in range(65)])
        self.assertFalse(result["scanComplete"])
        self.assertEqual(result["errorCode"], "PROCESS_CANDIDATE_LIMIT")

    @unittest.skipUnless(os.name == "posix", "requires POSIX /proc or path semantics")
    def test_component_boundary_rejects_similar_prefix(self):
        self.assertTrue(probe.path_is_within("/data2/cy/xzn", "/data2/cy/xzn/run.py"))
        self.assertFalse(probe.path_is_within("/data2/cy/xzn", "/data2/cy/xzn-other/run.py"))

    def test_open_checks_resolved_path_and_open_file_identity(self):
        if os.name == "nt":
            self.skipTest("symlink behavior requires a Linux filesystem integration run")
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory) / "root"
            outside = Path(directory) / "outside"
            root.mkdir(); outside.mkdir()
            secret = outside / "secret.log"
            secret.write_bytes(b"outside")
            alias = root / "log"
            alias.symlink_to(secret)
            result = probe.open_readonly(str(alias), [str(directory)], [str(root)])
            self.assertEqual(result["status"], "permission_error")
            self.assertEqual(result["errorCode"], "PATH_OUTSIDE_TASK_ROOT")

    def test_open_rechecks_identity_after_resolution_race(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory) / "root"
            outside = Path(directory) / "outside"
            root.mkdir(); outside.mkdir()
            source = root / "source.log"
            other = root / "other.log"
            escaped = outside / "source.log"
            source.write_bytes(b"registered")
            other.write_bytes(b"decoy")
            escaped.write_bytes(b"outside")

            def swap(_resolved):
                source.rename(Path(directory) / "old.log")
                os.replace(other, source)

            result = probe.open_readonly(str(source), [str(directory)], [str(root)], after_resolve=swap)
            self.assertEqual(result["status"], "permission_error")
            self.assertEqual(result["errorCode"], "PATH_IDENTITY_CHANGED")

    def test_task_root_symlink_must_remain_inside_host_root(self):
        if os.name == "nt":
            self.skipTest("directory symlink behavior requires Linux filesystem integration")
        with tempfile.TemporaryDirectory() as directory:
            host = Path(directory) / "host"
            outsider = Path(directory) / "other-person"
            host.mkdir(); outsider.mkdir()
            secret = outsider / "secret.log"; secret.write_bytes(b"private")
            task_root = host / "run"; task_root.symlink_to(outsider, target_is_directory=True)
            result = probe.open_readonly(str(task_root / "secret.log"), [str(host)], [str(task_root)])
            self.assertEqual(result["errorCode"], "TASK_ROOT_OUTSIDE_HOST_ROOT")

    def test_intermediate_link_replacement_cannot_escape_both_roots(self):
        if os.name == "nt":
            self.skipTest("directory symlink behavior requires Linux filesystem integration")
        with tempfile.TemporaryDirectory() as directory:
            host = Path(directory) / "host"
            task = host / "run"
            inside = task / "logs"
            outside = Path(directory) / "outside"
            inside.mkdir(parents=True); outside.mkdir()
            (inside / "train.log").write_bytes(b"registered")
            (outside / "train.log").write_bytes(b"private")

            def replace_intermediate(_resolved):
                inside.rename(task / "logs-old")
                (task / "logs").symlink_to(outside, target_is_directory=True)

            result = probe.open_readonly(str(inside / "train.log"), [str(host)], [str(task)], after_resolve=replace_intermediate)
            self.assertEqual(result["status"], "permission_error")
            self.assertEqual(result["errorCode"], "PATH_IDENTITY_CHANGED")

    def test_proc_stat_parser_extracts_start_ticks_after_parenthesized_command(self):
        # comm may contain spaces and right parentheses; fields after the final ')' are stable.
        fields = ["S"] + [str(value) for value in range(4, 22)] + ["987654", "21"]
        stat = "42 (worker name ) with paren) " + " ".join(fields)
        self.assertEqual(probe.parse_proc_start_ticks(stat), "987654")

    def test_process_identity_is_rechecked_before_and_after_projection(self):
        samples = iter([
            {"bootId": "boot-a", "pid": 42, "startTicks": "100"},
            {"bootId": "boot-a", "pid": 42, "startTicks": "101"},
        ])
        result = probe.verify_process_identity(lambda: next(samples), {"bootId": "boot-a", "pid": 42, "startTicks": "100"})
        self.assertFalse(result["verified"])
        self.assertEqual(result["errorCode"], "PROCESS_IDENTITY_CHANGED")

    def test_status_json_projects_only_allowed_keys_and_limits_input(self):
        projected = probe.project_status_json(b'{"step": 7, "target": 12, "password": "secret"}', {"step", "target"})
        self.assertEqual(projected, {"status": "ok", "values": {"step": 7, "target": 12}})
        too_large = probe.project_status_json(b" " * (256 * 1024 + 1), {"step"})
        self.assertEqual(too_large["errorCode"], "STATUS_JSON_LIMIT")

    def test_relative_entry_resolved_through_symlink_matches_registered_real_path(self):
        if os.name == "nt":
            self.skipTest("symlink behavior requires a Linux filesystem")
        with tempfile.TemporaryDirectory() as directory:
            run = Path(directory) / "run"
            source = Path(directory) / "source"
            run.mkdir(); source.mkdir()
            entry = source / "start_worker.py"
            entry.write_text("print('worker')\n", encoding="utf8")
            (run / "start_worker.py").symlink_to(entry)
            registration = {"hostAllowedRoots": [directory], "allowedDirectories": [str(run)], "entryPaths": [str(entry)], "sourcePaths": []}
            result = probe.project_task_process(registration, str(run), ["python", "start_worker.py"], None, [])
            self.assertTrue(result["entryVerified"])
            self.assertEqual(result["scriptEntry"], os.path.realpath(str(entry)))
            escaped = probe.project_task_process(
                {"hostAllowedRoots": [directory], "allowedDirectories": [str(run)], "entryPaths": [str(source / "other.py")], "sourcePaths": []},
                str(run), ["python", "start_worker.py"], None, [])
            self.assertFalse(escaped["entryVerified"])

    @unittest.skipUnless(os.name == "posix", "requires POSIX /proc or path semantics")
    def test_cwd_or_command_line_path_alone_does_not_confirm_task_role(self):
        registration = {
            "allowedDirectories": ["/data2/cy/xzn/run"],
            "entryPaths": ["train.py"],
            "sourcePaths": ["/data2/cy/xzn/run/training.log"],
        }
        result = probe.project_task_process(
            registration,
            cwd="/data2/cy/xzn/run",
            argv=["python", "train.py", "/data2/cy/xzn/run"],
            process_key={"hostBootId": "boot-a", "pid": 42, "startTicks": "100"},
            writer_targets=[],
        )
        self.assertFalse(result["confirmed"])

    @unittest.skipUnless(os.name == "posix", "requires POSIX /proc or path semantics")
    def test_bare_entry_from_another_cwd_needs_launcher_handle_and_direct_writer(self):
        registration = {"hostAllowedRoots": ["/"], "allowedDirectories": ["/data/run"], "entryPaths": ["start_worker6.py"],
                        "sourcePaths": ["/data/run/worker6.log"]}
        key = {"hostBootId": "b", "pid": 1400, "startTicks": "10"}
        result = probe.project_task_process(registration, "/data/src", ["python", "-u", "start_worker6.py"], key, ["/data/run/worker6.log"])
        self.assertFalse(result["entryVerified"], result)
        self.assertIsNone(result["launcherEntry"])
        result = probe.project_task_process(registration, "/data/src", ["python", "-u", "start_worker6.py"], key,
                                            ["/data/run/worker6.log"], launcher_entry="/data/run/start_worker6.py")
        self.assertTrue(result["entryVerified"], result)
        self.assertIsNone(result["scriptEntry"], result)
        self.assertEqual(result["launcherEntry"], "/data/run/start_worker6.py")
        self.assertEqual(result["writerSources"], ["/data/run/worker6.log"])
        self.assertTrue(result["evidenceComplete"])
        rejected = probe.project_task_process(registration, "/data/src", ["python", "-u", "start_worker6.py"], key,
                                              ["/data/other/worker6.log"], launcher_entry="/data/run/start_worker6.py")
        self.assertFalse(rejected["entryVerified"], rejected)
        self.assertEqual(result["role"], "unknown")

    def test_missing_boot_id_or_permission_failure_degrades_scan_completeness(self):
        result = probe.scan_registered_processes(proc_root="missing-proc", boot_id=None, task={}, max_processes=2)
        self.assertFalse(result["scanComplete"])
        self.assertEqual(result["errorCode"], "PROC_UNAVAILABLE")
        self.assertEqual(result["candidates"], [])

    def test_rotation_scan_rejects_hardlink_to_current_replacement(self):
        with tempfile.TemporaryDirectory() as directory:
            current = Path(directory) / "current.log"
            archive = Path(directory) / "archive.log"
            current.write_bytes(b"replacement")
            os.link(current, archive)
            old = b"old generation\n"
            anchor = {"startOffset": 0, "length": len(old), "sha256": hashlib.sha256(old).hexdigest()}
            result = probe.scan_rotation_candidates(str(current), [str(archive)], [str(directory)], [directory], [anchor])
            self.assertTrue(result["scanComplete"])
            self.assertEqual(result["candidates"], [])

    def test_rotation_scan_without_anchors_is_inconclusive(self):
        with tempfile.TemporaryDirectory() as directory:
            current = Path(directory) / "current.log"
            archive = Path(directory) / "archive.log"
            current.write_bytes(b"new")
            archive.write_bytes(b"old")
            result = probe.scan_rotation_candidates(str(current), [str(archive)], [str(directory)], [directory], [])
            self.assertFalse(result["scanComplete"])
            self.assertEqual(result["errorCode"], "OLD_ANCHORS_UNAVAILABLE")

    def test_rotation_scan_accepts_copy_only_when_old_anchor_matches(self):
        with tempfile.TemporaryDirectory() as directory:
            current = Path(directory) / "current.log"
            archive = Path(directory) / "archive.log"
            old = b"old generation\n"
            current.write_bytes(b"new generation\n")
            archive.write_bytes(old)
            anchor = {"startOffset": 0, "length": len(old), "sha256": hashlib.sha256(old).hexdigest()}
            result = probe.scan_rotation_candidates(str(current), [str(archive)], [str(directory)], [directory], [anchor])
            self.assertTrue(result["scanComplete"])
            self.assertEqual(result["candidates"], [{"candidateIndex": 0, "sizeBytes": str(len(old))}])

    def test_dispatch_projects_launcher_entry_with_writer_as_verified(self):
        task = {"hostAllowedRoots": ["/"], "allowedDirectories": ["/data/run"],
                "entryPaths": ["start_worker6.py"],
                "sources": [{"sourceId": "log", "kind": "log", "path": "/data/run/worker6.log"}]}
        candidate = {"processKey": {"hostBootId": "boot", "pid": 42, "startTicks": "100"},
                     "writerSources": ["/data/run/worker6.log"], "writerSourceEvidence": {},
                     "cwd": "/data/src", "scriptEntry": None,
                     "launcherEntry": "/data/run/start_worker6.py",
                     "interpreterFlags": ["-u"], "evidenceComplete": True,
                     "writerEvidenceComplete": True}
        sample = {"status": "ok", "identity": {"dev": "1", "inode": "2"}, "sizeBytes": "10", "data": b""}
        with mock.patch.object(probe, "open_readonly", return_value=sample), \
             mock.patch.object(probe, "scan_registered_processes",
                               return_value={"scanComplete": True, "errorCode": None, "candidates": [candidate]}):
            payload = probe._dispatch({"op": "probe_task", "proc": {"root": "/fake-proc"}, "task": task})
        self.assertEqual(payload["processes"][0]["roleEvidence"], "exact_entry_and_direct_writer_fd")
        self.assertEqual(payload["processes"][0]["launcherEntry"], "/data/run/start_worker6.py")

    def test_log_read_preserves_decimal_offsets_and_echoes_cas(self):
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "log.txt"
            source.write_bytes(b"small")
            offset = str(2**53 + 17)
            expected = {"generation": "g1", "revision": 9, "committedOffset": offset}
            real_seek = os.lseek

            def seek(fd, position, whence):
                # The test offset exceeds the maximum file size of some filesystems.
                if position == int(offset) and whence == os.SEEK_SET:
                    return real_seek(fd, 0, os.SEEK_END)
                return real_seek(fd, position, whence)

            with mock.patch.object(probe.os, "lseek", side_effect=seek) as seek_calls:
                result = probe._read_log({"path": str(source), "currentPath": str(source), "hostAllowedRoots": [directory], "taskAllowedDirectories": [directory], "offset": offset, "limitBytes": 256, "anchors": [], "expected": expected, "kind": "current"})
            seek_calls.assert_any_call(mock.ANY, int(offset), os.SEEK_SET)
            self.assertTrue(result["ok"])
            self.assertEqual(result["startOffset"], offset)
            self.assertEqual(result["expected"], expected)
            self.assertEqual(result["bytesLength"], 0)


if __name__ == "__main__":
    unittest.main()
