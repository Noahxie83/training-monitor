import base64
import builtins
import importlib.util
import io
import json
import os
from pathlib import Path
import signal
import tempfile
import types
import unittest
from unittest import mock
import uuid


ROOT = Path(__file__).parents[2]
LAUNCHER_PATH = ROOT / "src" / "launch" / "launcher.py"
AGENT_PATH = ROOT / "src" / "launch" / "server_agent.py"
PROBE_PATH = ROOT / "src" / "probe" / "readonly_probe.py"


def _load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    mod = importlib.util.module_from_spec(spec)
    assert spec and spec.loader
    spec.loader.exec_module(mod)
    return mod


launcher = _load("phase2_launcher_mod", LAUNCHER_PATH)
agent = _load("phase2_agent_mod", AGENT_PATH)
probe = _load("phase2_probe_mod", PROBE_PATH)
launcher.PROBE_SOURCE_B64 = base64.b64encode(PROBE_PATH.read_bytes()).decode("ascii")


class Phase2LaunchTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.host = Path(self.temp.name) / "host"
        self.task = self.host / "run"
        self.logs = self.task / "logs"
        self.logs.mkdir(parents=True)
        self.script = self.task / "train.py"
        self.script.write_text("print('ok')\n", encoding="utf-8")
        self.log = self.logs / "train.log"
        self.state = self.host / agent.STATE_DIRECTORY
        self.state.mkdir(mode=0o700)
        self.arm = str(uuid.uuid4())
        self.config_hash = "b" * 64

    def _base_launch_request(self, **overrides):
        req = {
            "version": 1,
            "op": "launch_task",
            "requestId": str(uuid.uuid4()),
            "sourceId": None,
            "taskId": "task-p2",
            "armId": self.arm,
            "configHash": self.config_hash,
            "hostAllowedRoots": [str(self.host)],
            "taskAllowedDirectories": [str(self.task)],
            "entryPaths": ["train.py"],
            "sources": [{"sourceId": "log", "kind": "log", "path": str(self.log)}],
            "gpuDevices": [
                {"deviceId": "GPU 0", "uuid": "GPU-aaaa"},
                {"deviceId": "GPU 2", "uuid": "GPU-cccc"},
            ],
            "cudaVisibleDevicesMode": "index",
            "maxUtilizationPercent": 5,
            "maxMemoryMiB": 1024,
            "launch": {
                "mode": "python_script",
                "pythonPath": "/usr/bin/python3",
                "entryPath": "train.py",
                "cwd": str(self.task),
                "arguments": "--epochs 10",
                "logSourceId": "log",
            },
        }
        req.update(overrides)
        return req

    def _spawn_validated(self, req):
        validated = launcher._validate_request(req)
        log_fd = os.open(str(self.log), os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o600)
        with mock.patch.object(launcher.subprocess, "Popen") as popen_mock, \
             mock.patch.object(launcher, "_process_key", return_value={"hostBootId": "boot-1", "pid": 999, "startTicks": "123"}):
            popen_mock.return_value = types.SimpleNamespace(pid=999)
            launcher._spawn_process(
                validated,
                str(self.script),
                str(self.task),
                log_fd,
                "boot-1",
                [],
                state_directory=str(self.state),
            )
            return popen_mock.call_args.args[0], popen_mock.call_args.kwargs

    @unittest.skipUnless(os.name == "posix", "requires POSIX process, permission, or runtime directory semantics")
    def test_ngpu_simultaneous_idle_wait_and_index_vs_uuid_mode(self):
        request = {
            "version": 1,
            "op": "ensure_server_wait",
            "requestId": str(uuid.uuid4()),
            "sourceId": None,
            "taskId": "task-ngpu",
            "armId": self.arm,
            "configHash": self.config_hash,
            "hostAllowedRoots": [str(self.host)],
            "taskAllowedDirectories": [str(self.task)],
            "idleSeconds": 20,
            "requiredGpuCount": 2,
            "gpuDeviceIds": ["GPU 0", "GPU 1", "GPU 2"],
            "gpuExcludeIds": ["GPU 1"],
            "launchRequest": self._base_launch_request(taskId="task-ngpu", gpuDevices=[]),
        }
        with mock.patch.object(agent, "_session_exists", return_value=True), \
             mock.patch.object(agent, "_new_session"):
            status = agent.ensure_server_wait(request, launcher, tmux_executable="/usr/bin/tmux", worker_source=b"worker")
        self.assertEqual(status["state"], "waiting")

        job_key = agent._job_key("task-ngpu", self.arm)
        idle = agent._new_idle_state()
        csv_data = (
            "0, GPU-aaaa, 0, 10, 24564\n"
            "1, GPU-bbbb, 0, 10, 24564\n"
            "2, GPU-cccc, 0, 10, 24564\n"
            "3, GPU-dddd, 0, 10, 24564\n"
        )
        fake_probe = types.SimpleNamespace(
            _query_linux_gpu=mock.Mock(return_value={"status": "ok", "csv": csv_data}),
            _canonical_task_roots=lambda h, t: (h, t),
            open_readonly=probe.open_readonly,
        )
        receipt = {
            "status": "started", "pid": 777, "startedAt": "2026-11-11T00:01:00Z",
            "processKey": {"pid": 777, "hostBootId": "boot", "startTicks": "777"},
        }
        with mock.patch.object(launcher, "_probe", return_value=fake_probe), \
             mock.patch.object(launcher, "_scan_for_registered_process", return_value=None), \
             mock.patch.object(agent, "_session_exists", return_value=True), \
             mock.patch.object(launcher, "launch_task", return_value=receipt) as launch_mock, \
             mock.patch.object(agent, "_monotonic", side_effect=[10., 10., 20., 20., 30., 30.]):
            for _ in range(3):
                agent._worker_iteration(job_key, str(self.state), launcher, idle, tmux_executable="/usr/bin/tmux")

        self.assertEqual(launch_mock.call_count, 1)
        launched_req = launch_mock.call_args.args[0]
        self.assertEqual(
            launched_req["gpuDevices"],
            [{"deviceId": "GPU 0", "uuid": "GPU-aaaa"}, {"deviceId": "GPU 2", "uuid": "GPU-cccc"}],
        )

        # Verify CUDA_VISIBLE_DEVICES in both index and uuid modes
        for mode, expected_cvd in (("index", "0,2"), ("uuid", "GPU-aaaa,GPU-cccc")):
            _argv, kwargs = self._spawn_validated(self._base_launch_request(cudaVisibleDevicesMode=mode))
            self.assertEqual(kwargs["env"]["CUDA_VISIBLE_DEVICES"], expected_cvd)

    def test_arbitrary_command_and_python_module_with_env_and_no_shell(self):
        # Mode 1: arbitrary command (torchrun) + custom env vars
        cmd_req = self._base_launch_request(
            entryPaths=["torchrun"],
            launch={
                "mode": "command",
                "command": ["/usr/local/bin/torchrun", "--nproc_per_node=2", "train.py"],
                "cwd": str(self.task),
                "arguments": "--batch-size 32 ; $(whoami)",
                "logSourceId": "log",
                "env": {"WANDB_MODE": "offline", "NCCL_DEBUG": "INFO"},
            },
        )
        argv, kwargs = self._spawn_validated(cmd_req)
        self.assertFalse(kwargs["shell"])
        self.assertEqual(argv[:3], ["/usr/local/bin/torchrun", "--nproc_per_node=2", "train.py"])
        self.assertIn("$(whoami)", argv)
        self.assertEqual(kwargs["env"]["WANDB_MODE"], "offline")
        self.assertEqual(kwargs["env"]["NCCL_DEBUG"], "INFO")

        # Mode 2: python_module (-m)
        mod_req = self._base_launch_request(
            entryPaths=["module:mypkg.train"],
            launch={
                "mode": "python_module",
                "pythonPath": "/usr/bin/python3",
                "moduleName": "mypkg.train",
                "cwd": str(self.task),
                "arguments": "--lr 1e-4",
                "logSourceId": "log",
            },
        )
        mod_argv, _mod_kwargs = self._spawn_validated(mod_req)
        self.assertEqual(mod_argv[:4], ["/usr/bin/python3", "-u", "-m", "mypkg.train"])
        self.assertEqual(mod_argv[4:], ["--lr", "1e-4"])

    @unittest.skipUnless(os.name == "posix", "requires POSIX process, permission, or runtime directory semantics")
    def test_local_tmpfs_socket_and_gc_beyond_256_files(self):
        uid = os.getuid() if hasattr(os, "getuid") else 1000
        sock_dir = agent._runtime_socket_dir(uid)
        self.assertFalse(sock_dir.startswith(str(self.host)))
        self.assertLess(len(os.path.join(sock_dir, "tmux.sock")), 108)

        # Populate 280 old terminal wait files (.server-wait-<64hex>.json) — GC cleans them automatically!
        old_mtime = 1_000_000_000
        for i in range(280):
            p = self.state / f".server-wait-{i:064x}.json"
            p.write_text(json.dumps({"state": "started", "taskId": f"t{i}"}), encoding="utf-8")
            os.chmod(p, 0o600)
            os.utime(p, (old_mtime, old_mtime))

        removed = agent._gc_state_directory(str(self.state), launcher)
        self.assertGreaterEqual(removed, 280)
        remaining = list(self.state.glob(".server-wait-*.json"))
        self.assertEqual(len(remaining), 0)

    @unittest.skipUnless(os.name == "posix", "requires POSIX process, permission, or runtime directory semantics")
    def test_retry_on_exit_stops_at_max_retries_and_on_zero_exit_code(self):
        request = {
            "version": 1,
            "op": "ensure_server_wait",
            "requestId": str(uuid.uuid4()),
            "sourceId": None,
            "taskId": "task-retry",
            "armId": self.arm,
            "configHash": self.config_hash,
            "hostAllowedRoots": [str(self.host)],
            "taskAllowedDirectories": [str(self.task)],
            "idleSeconds": 10,
            "retryOnExit": True,
            "maxRetries": 2,
            "retryBackoffSeconds": 0,
            "launchRequest": self._base_launch_request(taskId="task-retry", gpuDevices=[]),
        }
        with mock.patch.object(agent, "_session_exists", return_value=True), \
             mock.patch.object(agent, "_new_session"):
            agent.ensure_server_wait(request, launcher, tmux_executable="/usr/bin/tmux", worker_source=b"worker")

        job_key = agent._job_key("task-retry", self.arm)
        job_path = agent._job_path(str(self.state), job_key)

        # Simulate 3 consecutive exits -> first 2 retry, 3rd hits MAX_RETRIES_EXCEEDED!
        for attempt in range(3):
            rec = json.loads(Path(job_path).read_text(encoding="utf-8"))
            rec["state"] = "started"
            rec["pid"] = 100 + attempt
            rec["processKey"] = {"pid": 100 + attempt, "hostBootId": "b", "startTicks": str(10 + attempt)}
            Path(job_path).write_text(json.dumps(rec), encoding="utf-8")
            with mock.patch.object(agent, "_process_is_running", return_value=False):
                cont = agent._retry_iteration(job_key, str(self.state), launcher, agent._new_idle_state())
            updated = json.loads(Path(job_path).read_text(encoding="utf-8"))
            if attempt < 2:
                self.assertTrue(cont)
                self.assertEqual(updated["state"], "waiting")
                self.assertEqual(updated["retryCount"], attempt + 1)
            else:
                self.assertFalse(cont)
                self.assertEqual(updated["state"], "failed")
                self.assertEqual(updated["errorCode"], "MAX_RETRIES_EXCEEDED")

        # Verify exitCode == 0 stops retry cleanly as completed!
        rec = json.loads(Path(job_path).read_text(encoding="utf-8"))
        rec["state"] = "started"
        rec["retryFinished"] = False
        rec["retryCount"] = 0
        rec["pid"] = 500
        rec["processKey"] = {"pid": 500, "hostBootId": "b", "startTicks": "500"}
        Path(job_path).write_text(json.dumps(rec), encoding="utf-8")
        exit_path = launcher._exit_receipt_path(str(self.state), "task-retry", rec["attemptArmId"])
        Path(exit_path).write_text(json.dumps({"exitCode": 0, "pid": 500}), encoding="utf-8")
        os.chmod(exit_path, 0o600)
        with mock.patch.object(agent, "_process_is_running", return_value=False):
            cont = agent._retry_iteration(job_key, str(self.state), launcher, agent._new_idle_state())
        self.assertFalse(cont)
        done = json.loads(Path(job_path).read_text(encoding="utf-8"))
        self.assertTrue(done["retryFinished"])
        self.assertEqual(done["exitCode"], 0)

    @unittest.skipUnless(os.name == "posix", "requires POSIX process, permission, or runtime directory semantics")
    def test_signal_task_verifies_process_key_before_signaling(self):
        fake_key = {"hostBootId": "boot-sig", "pid": 4321, "startTicks": "9999"}
        fields = ["0"] * 22
        fields[0] = "R"
        fields[2] = "4321"
        fields[19] = "9999"
        fake_stat_text = "4321 (python3) " + " ".join(fields) + "\n"
        real_open = builtins.open

        def fake_open(path, *args, **kwargs):
            if str(path) == "/proc/4321/stat":
                return io.StringIO(fake_stat_text)
            return real_open(path, *args, **kwargs)

        with mock.patch.object(launcher, "_boot_id", return_value="boot-sig"), \
             mock.patch.object(launcher, "_current_uid", return_value=1000), \
             mock.patch("os.stat", return_value=types.SimpleNamespace(st_uid=1000)), \
             mock.patch.object(builtins, "open", side_effect=fake_open), \
             mock.patch("os.killpg") as killpg_mock:
            res = launcher.signal_task({"op": "signal_task", "action": "stop", "processKeys": [fake_key]})
        self.assertTrue(res["ok"])
        self.assertEqual(res["pidsSignaled"], [4321])
        killpg_mock.assert_called_once_with(4321, signal.SIGTERM)


if __name__ == "__main__":
    unittest.main()
