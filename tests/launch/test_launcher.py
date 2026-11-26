import base64
import importlib.util
import io
import json
import os
from pathlib import Path
import stat
import tempfile
import types
import unittest
from unittest import mock
import uuid


ROOT = Path(__file__).parents[2]
LAUNCHER_PATH = ROOT / "src" / "launch" / "launcher.py"
PROBE_PATH = ROOT / "src" / "probe" / "readonly_probe.py"


def load_module(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    assert spec and spec.loader
    spec.loader.exec_module(module)
    return module


launcher = load_module("training_monitor_launcher_test", LAUNCHER_PATH)
probe = load_module("training_monitor_probe_for_launcher_test", PROBE_PATH)


class LauncherTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.host = Path(self.temp.name) / "host"
        self.task = self.host / "run"
        self.logs = self.task / "logs"
        self.logs.mkdir(parents=True)
        self.script = self.task / "train.py"
        self.script.write_text("print('registered')\n", encoding="utf-8")
        self.log = self.logs / "train.log"
        self.state = self.host / launcher.STATE_DIRECTORY
        self.state.mkdir(mode=0o700)
        self.arm = str(uuid.uuid4())
        self.spawns = []
        self.scan_result = None

    def request(self):
        return {
            "version": 1,
            "requestId": "request-1",
            "sourceId": None,
            "op": "launch_task",
            "armId": self.arm,
            "taskId": "registered-task",
            "configHash": "a" * 64,
            "hostAllowedRoots": [str(self.host)],
            "taskAllowedDirectories": [str(self.task)],
            "entryPaths": [str(self.script)],
            "sources": [{"sourceId": "stdout", "path": str(self.log), "kind": "log"}],
            "launch": {
                "pythonPath": "/venv/bin/python3.12",
                "entryPath": str(self.script),
                "cwd": str(self.task),
                "arguments": "--epochs 3 --label 'two words'",
                "logSourceId": "stdout",
            },
            "gpuDevices": [
                {"deviceId": "GPU 6", "uuid": "GPU-aaaaaaaa"},
                {"deviceId": "GPU 2", "uuid": "GPU-bbbbbbbb"},
            ],
            "maxUtilizationPercent": 5,
            "maxMemoryMiB": 1024,
        }

    def fake_popen(self, status=0, **kwargs):
        pid = 4100 + len(self.spawns)
        self.spawns.append((status, kwargs))
        return types.SimpleNamespace(pid=pid)

    def launch_patches(self, *, spawn=None, gpu_idle=True, scan_result=None,
                       scan_error=None, lock_handles=None, lock_error=None,
                       patch_close=True):
        spawn = spawn or self.fake_popen
        scan_result = self.scan_result if scan_result is None else scan_result
        if lock_error is None:
            acquire = mock.patch.object(
                launcher, "_acquire_gpu_locks", return_value=lock_handles or [])
        else:
            acquire = mock.patch.object(
                launcher, "_acquire_gpu_locks", side_effect=lock_error)
        popen_patch = mock.patch.object(launcher.subprocess, "Popen", side_effect=spawn)
        if scan_error is None:
            scan = mock.patch.object(
                launcher, "_scan_for_registered_process", return_value=scan_result)
        else:
            scan = mock.patch.object(
                launcher, "_scan_for_registered_process", side_effect=scan_error)
        patches = [
            mock.patch.object(launcher, "_probe", return_value=probe),
            mock.patch.object(launcher, "_fcntl", object()),
            mock.patch.object(launcher, "_current_uid", return_value=os.stat(self.host).st_uid),
            mock.patch.object(launcher, "_state_directory", return_value=str(self.state)),
            mock.patch.object(launcher, "_gpus_idle", return_value=gpu_idle),
            acquire,
            scan,
            mock.patch.object(launcher, "_boot_id", return_value="boot-a"),
            mock.patch.object(launcher, "_fsync_directory"),
            popen_patch,
        ]
        if patch_close:
            patches.insert(6, mock.patch.object(launcher, "_close_gpu_locks"))
        return patches

    def run_launch(self, request=None, **patch_options):
        patches = self.launch_patches(**patch_options)
        popen = patches[-1]
        for patcher in patches[:-1]:
            patcher.start()
            self.addCleanup(patcher.stop)
        popen = popen.start()
        self.addCleanup(popen.stop)
        return launcher.launch_task(request or self.request()), popen

    def test_gpu_parser_matches_uuid_and_rejects_busy_na_and_unknown_without_spawn(self):
        request = launcher._validate_request(self.request())
        rows = [
            "0, GPU-aaaaaaaa, 1, 10, 8192",
            "1, GPU-bbbbbbbb, 2, 20, 8192",
        ]
        fake_probe = types.SimpleNamespace(
            _query_linux_gpu=lambda: {"status": "ok", "csv": "\n".join(rows) + "\n"})
        self.assertTrue(launcher._gpus_idle(fake_probe, request))

        for csv_text in (
            "0, GPU-aaaaaaaa, 9, 10, 8192\n1, GPU-bbbbbbbb, 2, 20, 8192\n",
            "0, GPU-aaaaaaaa, 1, 2048, 8192\n1, GPU-bbbbbbbb, 2, 20, 8192\n",
            "0, GPU-aaaaaaaa, N/A, 10, 8192\n1, GPU-bbbbbbbb, 2, 20, 8192\n",
            "0, GPU-cccccccc, 1, 10, 8192\n1, GPU-bbbbbbbb, 2, 20, 8192\n",
        ):
            with self.subTest(csv=csv_text):
                fake_probe._query_linux_gpu = lambda text=csv_text: {"status": "ok", "csv": text}
                result, popen = self.run_launch(
                    gpu_idle=launcher._gpus_idle(fake_probe, request))
                self.assertEqual(result, launcher._busy())
                popen.assert_not_called()

    def test_existing_task_returns_already_running_without_creating_claim(self):
        result, popen = self.run_launch(scan_result=launcher._already_running())
        self.assertEqual(result, launcher._already_running())
        popen.assert_not_called()
        self.assertFalse(any(self.state.glob(".claim-*")))
        self.assertFalse(any(self.state.glob(".receipt-*")))

    def test_detection_scan_does_not_require_log_sources(self):
        request = launcher._validate_request(self.request())
        scan = mock.Mock(return_value={
            "scanComplete": True,
            "errorCode": None,
            "candidates": [],
        })
        fake_probe = types.SimpleNamespace(scan_registered_processes=scan)
        with mock.patch.object(launcher, "_boot_id", return_value="boot-a"):
            result = launcher._scan_for_registered_process(
                fake_probe, request, [str(self.host)], [str(self.task)])
        self.assertIsNone(result)
        task = scan.call_args.args[2]
        self.assertEqual(task["sources"], [])
        self.assertEqual(task["entryPaths"], [str(self.script)])

    def test_incomplete_scan_fails_closed_without_spawn_or_claim(self):
        result, popen = self.run_launch(
            scan_error=launcher._LaunchError("PROCESS_SCAN_INCOMPLETE"))
        self.assertEqual(result, launcher._failed("PROCESS_SCAN_INCOMPLETE"))
        popen.assert_not_called()
        self.assertFalse(any(self.state.glob(".claim-*")))

    def test_gpu_lock_busy_returns_before_claim_and_never_spawns(self):
        result, popen = self.run_launch(lock_error=launcher._GpuLockBusy())
        self.assertEqual(result, launcher._busy())
        popen.assert_not_called()
        self.assertFalse(any(self.state.glob(".claim-*")))
        self.assertFalse(any(self.state.glob(".receipt-*")))

    def test_missing_log_parent_is_not_created(self):
        request = self.request()
        missing_parent = self.task / "missing" / "nested"
        request["sources"][0]["path"] = str(missing_parent / "train.log")
        result, popen = self.run_launch(request)
        self.assertEqual(result, launcher._failed("LOG_PARENT_MISSING"))
        popen.assert_not_called()
        self.assertFalse((self.task / "missing").exists())
        self.assertFalse(any(self.state.glob(".claim-*")))

    def test_exact_entry_and_shell_metacharacters_remain_argv_and_append_log(self):
        self.log.write_bytes(b"existing-log-tail\n")
        request = self.request()
        request["launch"]["arguments"] = (
            "--label 'two words' ; touch injected $(id) > /tmp/pwned")
        with mock.patch.dict(os.environ, {"TMUX": "/tmp/waiter,123,0", "TMUX_PANE": "%0"}):
            result, popen = self.run_launch(request)
        self.assertEqual(result["status"], "started")
        self.assertEqual(result["pid"], 4100)
        self.assertIsNone(result["errorCode"])
        self.assertEqual(self.log.read_bytes(), b"existing-log-tail\n")
        args, kwargs = popen.call_args
        self.assertEqual(args[0], [
            "/venv/bin/python3.12",
            "-u",
            str(self.script),
            "--label",
            "two words",
            ";",
            "touch",
            "injected",
            "$(id)",
            ">",
            "/tmp/pwned",
        ])
        self.assertFalse(kwargs["shell"])
        self.assertEqual(kwargs["cwd"], str(self.task))
        self.assertEqual(kwargs["stdin"], launcher.subprocess.DEVNULL)
        self.assertEqual(kwargs["stderr"], launcher.subprocess.STDOUT)
        self.assertTrue(kwargs["start_new_session"])
        self.assertTrue(kwargs["close_fds"])
        self.assertEqual(kwargs["pass_fds"], ())
        self.assertEqual(kwargs["env"]["CUDA_VISIBLE_DEVICES"],
                         "GPU-aaaaaaaa,GPU-bbbbbbbb")
        self.assertNotIn("TMUX", kwargs["env"])
        self.assertNotIn("TMUX_PANE", kwargs["env"])

    def test_spawn_inherits_gpu_lock_fds_and_parent_does_not_unlock(self):
        peer_fd, first_fd = os.pipe()
        os.close(peer_fd)
        peer_fd, second_fd = os.pipe()
        os.close(peer_fd)
        lock_module = types.SimpleNamespace(
            LOCK_UN="unlock",
            flock=mock.Mock(),
        )
        handles = [(first_fd, lock_module), (second_fd, lock_module)]
        result, popen = self.run_launch(
            lock_handles=handles, patch_close=False)
        self.assertEqual(result["status"], "started")
        self.assertEqual(popen.call_args.kwargs["pass_fds"], (first_fd, second_fd))
        self.assertTrue(popen.call_args.kwargs["close_fds"])
        lock_module.flock.assert_not_called()
        for fd in (first_fd, second_fd):
            with self.assertRaises(OSError):
                os.fstat(fd)

    def test_gpu_locks_use_nonblocking_exclusive_lock_without_unlock(self):
        lock_module = types.SimpleNamespace(
            LOCK_EX=1,
            LOCK_NB=2,
            LOCK_UN=4,
            flock=mock.Mock(),
        )
        with mock.patch.object(launcher, "_fcntl", lock_module), \
             mock.patch.object(launcher, "_current_uid",
                               return_value=os.stat(self.state).st_uid):
            handles = launcher._acquire_gpu_locks(
                str(self.state), ["GPU-bbbbbbbb", "GPU-aaaaaaaa"])
            launcher._close_gpu_locks(handles)
        self.assertEqual(lock_module.flock.call_count, 2)
        for call in lock_module.flock.call_args_list:
            self.assertEqual(call.args[1], lock_module.LOCK_EX | lock_module.LOCK_NB)
        self.assertNotIn(
            mock.call(mock.ANY, lock_module.LOCK_UN),
            lock_module.flock.call_args_list,
        )

    def test_spawn_failure_closes_lock_fds_without_unlock(self):
        peer_fd, lock_fd = os.pipe()
        os.close(peer_fd)
        lock_module = types.SimpleNamespace(
            LOCK_UN="unlock",
            flock=mock.Mock(),
        )
        result, popen = self.run_launch(
            spawn=mock.Mock(side_effect=OSError("no process")),
            lock_handles=[(lock_fd, lock_module)],
            patch_close=False,
        )
        self.assertEqual(result, launcher._failed("PROCESS_SPAWN_FAILED"))
        popen.assert_called_once()
        lock_module.flock.assert_not_called()
        with self.assertRaises(OSError):
            os.fstat(lock_fd)

    def test_unregistered_entry_is_rejected_before_spawn(self):
        other = self.task / "other.py"
        other.write_text("print('other')\n", encoding="utf-8")
        request = self.request()
        request["launch"]["entryPath"] = str(other)
        result, popen = self.run_launch(request)
        self.assertEqual(result, launcher._failed("INVALID_REQUEST"))
        popen.assert_not_called()

    def test_duplicate_arm_returns_receipt_result_without_second_spawn(self):
        request = self.request()
        first, popen = self.run_launch(request)
        self.assertEqual(first["status"], "started")
        with mock.patch.object(launcher, "_gpus_idle") as gpu_check, \
             mock.patch.object(launcher.subprocess, "Popen") as second_popen:
            second = launcher.launch_task(request)
        self.assertEqual(second, first)
        gpu_check.assert_not_called()
        second_popen.assert_not_called()
        self.assertEqual(len(popen.call_args_list), 1)

    def test_duplicate_arm_ignores_deleted_script_and_log_parent(self):
        request = self.request()
        first, popen = self.run_launch(request)
        self.assertEqual(first["status"], "started")
        self.script.unlink()
        self.log.unlink()
        self.logs.rmdir()
        with mock.patch.object(launcher, "_canonical_scope", side_effect=AssertionError("dynamic scope read")), \
             mock.patch.object(launcher.subprocess, "Popen") as second_popen:
            second = launcher.launch_task(request)
        self.assertEqual(second, first)
        second_popen.assert_not_called()
        self.assertEqual(len(popen.call_args_list), 1)

    def test_same_arm_with_changed_config_returns_config_changed(self):
        request = self.request()
        first, _ = self.run_launch(request)
        changed = self.request()
        changed["configHash"] = "b" * 64
        with mock.patch.object(launcher.subprocess, "Popen") as popen:
            second = launcher.launch_task(changed)
        self.assertEqual(first["status"], "started")
        self.assertEqual(second, launcher._failed("CONFIG_CHANGED"))
        popen.assert_not_called()

    def test_receipt_write_failure_returns_unknown_and_never_retries(self):
        request = self.request()
        with mock.patch.object(launcher, "_write_receipt", return_value=False):
            first, _ = self.run_launch(request)
        self.assertEqual(first, launcher._failed("UNKNOWN_LAUNCH_RESULT"))
        with mock.patch.object(launcher.subprocess, "Popen") as popen:
            second = launcher.launch_task(request)
        self.assertEqual(second, launcher._failed("UNKNOWN_LAUNCH_RESULT"))
        popen.assert_not_called()
        self.assertEqual(len(list(self.state.glob(".claim-*"))), 1)

    def test_corrupt_receipt_fails_closed_without_retry(self):
        request = self.request()
        first, _ = self.run_launch(request)
        self.assertEqual(first["status"], "started")
        receipt_path = next(self.state.glob(".receipt-*"))
        receipt = json.loads(receipt_path.read_text(encoding="utf-8"))
        receipt["result"]["startedAt"] = "not-an-iso-time"
        receipt_path.write_text(json.dumps(receipt), encoding="utf-8")
        with mock.patch.object(launcher.subprocess, "Popen") as popen:
            second = launcher.launch_task(request)
        self.assertEqual(second, launcher._failed("UNKNOWN_LAUNCH_RESULT"))
        popen.assert_not_called()

    def test_process_start_failure_writes_failed_receipt_and_does_not_retry(self):
        request = self.request()
        first, popen = self.run_launch(
            request, spawn=mock.Mock(side_effect=OSError("not exposed")))
        self.assertEqual(first, launcher._failed("PROCESS_SPAWN_FAILED"))
        popen.assert_called_once()
        with mock.patch.object(launcher.subprocess, "Popen") as second_popen:
            second = launcher.launch_task(request)
        self.assertEqual(second, first)
        second_popen.assert_not_called()

    def test_missing_fcntl_returns_unsupported_platform(self):
        with mock.patch.object(launcher, "_fcntl", None):
            result = launcher.launch_task(self.request())
        self.assertEqual(result, launcher._failed("UNSUPPORTED_PLATFORM"))

    @unittest.skipIf(os.name == "nt", "directory symlink creation is not portable on Windows")
    def test_script_symlink_escape_is_rejected(self):
        outside = Path(self.temp.name) / "outside"
        outside.mkdir()
        external = outside / "train.py"
        external.write_text("print('outside')\n", encoding="utf-8")
        self.script.unlink()
        self.script.symlink_to(external)
        result, popen = self.run_launch()
        self.assertIn(result, [launcher._failed("ENTRY_PATH_INVALID"), launcher._failed("SCRIPT_PATH_INVALID")])
        popen.assert_not_called()

    def test_embedded_probe_exposes_helpers_without_running_main(self):
        source = PROBE_PATH.read_text(encoding="utf-8")
        self.assertIn("raise SystemExit(main())", source)
        source = source.replace(
            "raise SystemExit(main())",
            "raise RuntimeError('readonly probe main executed')",
            1,
        )
        encoded = base64.b64encode(source.encode("utf-8")).decode("ascii")
        with mock.patch.object(launcher, "PROBE_SOURCE_B64", encoded), \
             mock.patch.object(launcher, "_PROBE", None):
            loaded = launcher._probe()
        self.assertIsInstance(loaded, types.SimpleNamespace)
        self.assertTrue(callable(loaded._canonical_task_roots))
        self.assertTrue(callable(loaded._path_in_scope))
        self.assertTrue(callable(loaded._query_linux_gpu))
        self.assertTrue(callable(loaded.open_readonly))
        self.assertTrue(callable(loaded.scan_registered_processes))

    def test_main_emits_matching_binary_frame(self):
        request = self.request()
        request["requestId"] = "frame-request"
        source = LAUNCHER_PATH.read_text(encoding="utf-8")
        encoded = base64.b64encode(json.dumps(request).encode("utf-8")).decode("ascii")
        fixed = source.replace("__MONITOR_REQUEST_B64__", encoded, 1)
        namespace = {"__name__": "launcher_main_test"}
        exec(compile(fixed, str(LAUNCHER_PATH), "exec"), namespace)
        namespace["launch_task"] = lambda _request: {
            "status": "busy", "pid": None, "processKey": None,
            "startedAt": None, "errorCode": None,
        }
        output = io.BytesIO()
        namespace["sys"] = types.SimpleNamespace(
            stdout=types.SimpleNamespace(buffer=output))
        self.assertEqual(namespace["main"](), 0)
        frame = output.getvalue()
        size = int.from_bytes(frame[:4], "big")
        envelope = json.loads(frame[4:4 + size])
        self.assertEqual(envelope, {
            "version": 1,
            "requestId": "frame-request",
            "sourceId": None,
            "payload": {
                "status": "busy", "pid": None, "processKey": None,
                "startedAt": None, "errorCode": None,
            },
        })


if __name__ == "__main__":
    unittest.main()
