import base64
import errno
import io
import importlib.util
import json
import os
from pathlib import Path
import tempfile
import threading
import types
import unittest
import uuid
from unittest import mock


ROOT = Path(__file__).parents[2]
AGENT_PATH = ROOT / "src" / "launch" / "server_agent.py"
LAUNCHER_PATH = ROOT / "src" / "launch" / "launcher.py"
PROBE_PATH = ROOT / "src" / "probe" / "readonly_probe.py"


def load_module(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    assert spec and spec.loader
    spec.loader.exec_module(module)
    return module


agent = load_module("training_monitor_server_agent_test", AGENT_PATH)
launcher = load_module("training_monitor_launcher_for_server_agent_test", LAUNCHER_PATH)
probe = load_module("training_monitor_probe_for_server_agent_test", PROBE_PATH)


class ServerAgentTests(unittest.TestCase):
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
        self.arm = str(uuid.uuid4())
        self.config_hash = "a" * 64

        self.probe_patch = mock.patch.object(
            launcher,
            "PROBE_SOURCE_B64",
            base64.b64encode(PROBE_PATH.read_bytes()).decode("ascii"),
        )
        self.probe_patch.start()
        self.addCleanup(self.probe_patch.stop)
        self.cached_probe_patch = mock.patch.object(launcher, "_PROBE", None)
        self.cached_probe_patch.start()
        self.addCleanup(self.cached_probe_patch.stop)
        self.uid_patch = mock.patch.object(
            launcher, "_current_uid", return_value=os.stat(self.host).st_uid)
        self.uid_patch.start()
        self.addCleanup(self.uid_patch.stop)
        self.fcntl = types.SimpleNamespace(
            LOCK_EX=1,
            LOCK_NB=2,
            flock=mock.Mock(),
        )
        self.fcntl_patch = mock.patch.object(launcher, "_fcntl", self.fcntl)
        self.fcntl_patch.start()
        self.addCleanup(self.fcntl_patch.stop)
        self.fsync_patch = mock.patch.object(launcher, "_fsync_directory")
        self.fsync_patch.start()
        self.addCleanup(self.fsync_patch.stop)

        def state_directory(host_root):
            path = Path(host_root) / agent.STATE_DIRECTORY
            path.mkdir(mode=0o700, exist_ok=True)
            os.chmod(path, 0o700)
            return str(path)

        self.state_directory_patch = mock.patch.object(
            launcher, "_state_directory", side_effect=state_directory)
        self.state_directory_patch.start()
        self.addCleanup(self.state_directory_patch.stop)

        self.original_new_session = agent._new_session
        self.new_session = mock.Mock()
        self.session_exists = mock.Mock(return_value=True)
        self.new_session_patch = mock.patch.object(agent, "_new_session", self.new_session)
        self.new_session_patch.start()
        self.addCleanup(self.new_session_patch.stop)
        self.session_exists_patch = mock.patch.object(agent, "_session_exists", self.session_exists)
        self.session_exists_patch.start()
        self.addCleanup(self.session_exists_patch.stop)
        self.original_check_tmux = agent._check_tmux
        self.tmux_patch = mock.patch.object(agent, "_check_tmux", return_value="/usr/bin/tmux")
        self.tmux_patch.start()
        self.addCleanup(self.tmux_patch.stop)

    def launch_request(self, **overrides):
        request = {
            "version": 1,
            "requestId": "launch-request",
            "sourceId": None,
            "op": "launch_task",
            "armId": self.arm,
            "taskId": "registered-task",
            "configHash": self.config_hash,
            "hostAllowedRoots": [str(self.host)],
            "taskAllowedDirectories": [str(self.task)],
            "entryPaths": [str(self.script)],
            "sources": [{
                "sourceId": "stdout",
                "path": str(self.log),
                "kind": "log",
            }],
            "launch": {
                "pythonPath": "/venv/bin/python3.12",
                "entryPath": str(self.script),
                "cwd": str(self.task),
                "arguments": "--secret argv-visible-only-in-private-state",
                "logSourceId": "stdout",
            },
            "gpuDevices": [],
            "maxUtilizationPercent": 5,
            "maxMemoryMiB": 1024,
        }
        request.update(overrides)
        return request

    def ensure_request(self, *, arm_id=None, idle_seconds=5, **overrides):
        launch = self.launch_request()
        if arm_id is not None:
            launch["armId"] = arm_id
        request = {
            "version": 1,
            "requestId": "ensure-request",
            "sourceId": None,
            "op": "ensure_server_wait",
            "armId": arm_id or self.arm,
            "taskId": "registered-task",
            "configHash": self.config_hash,
            "hostAllowedRoots": [str(self.host)],
            "taskAllowedDirectories": [str(self.task)],
            "launchRequest": launch,
            "idleSeconds": idle_seconds,
        }
        request.update(overrides)
        return request

    def manager_request(self, operation):
        return {
            "version": 1,
            "requestId": operation,
            "sourceId": None,
            "op": operation,
            "armId": self.arm,
            "taskId": "registered-task",
            "configHash": self.config_hash,
            "hostAllowedRoots": [str(self.host)],
            "taskAllowedDirectories": [str(self.task)],
        }

    def job_path(self):
        return Path(agent._job_path(
            str(self.host / agent.STATE_DIRECTORY),
            agent._job_key("registered-task", self.arm),
        ))

    def read_job(self):
        return json.loads(self.job_path().read_text(encoding="utf-8"))

    def write_job(self, record):
        self.job_path().write_text(
            json.dumps(record, sort_keys=True, separators=(",", ":")),
            encoding="utf-8",
        )
        os.chmod(self.job_path(), 0o600)

    def test_manager_frame_has_exact_status_shape_and_never_uses_shell(self):
        request = self.ensure_request()
        status = agent.ensure_server_wait(request, launcher, worker_source=b"worker-source")
        self.assertEqual(status["state"], "waiting")
        self.assertEqual(set(status), {
            "state",
            "armId",
            "configHash",
            "idleElapsedSeconds",
            "requiredIdleSeconds",
            "lastCheckedAt",
            "startedAt",
            "pid",
            "errorCode",
            "message",
            "sessionName",
            "selectedDeviceId",
        })
        argv = self.new_session.call_args.args
        self.assertEqual(argv[4], agent._job_key("registered-task", self.arm))
        self.assertEqual(argv[5], str(self.host / agent.STATE_DIRECTORY))

        completed = types.SimpleNamespace(returncode=0, stdout=b"tmux 3.4\n")
        with mock.patch.object(agent.subprocess, "run", return_value=completed) as run:
            self.original_new_session(
                "/usr/bin/tmux",
                1000,
                "tm-wait-test",
                "/state/.server-worker-v1-test.py",
                "a" * 64,
                "/state",
            )
        command = run.call_args.args[0]
        self.assertFalse(run.call_args.kwargs["shell"])
        expected_socket = os.path.join(agent._runtime_socket_dir(1000), "tmux.sock")
        self.assertEqual(command[:5], [
            "/usr/bin/tmux", "-S", expected_socket, "-f", "/dev/null",
        ])
        self.assertNotEqual(command[2], os.path.join("/state", "tmux.sock"))
        self.assertIn("--", command)
        self.assertEqual(command[command.index("--") + 1:], [
            agent._python_executable(),
            "-I",
            "-S",
            "-B",
            "/state/.server-worker-v1-test.py",
            "--worker",
            "a" * 64,
            "/state",
        ])
        self.assertNotIn("nohup", command)
        self.assertNotIn("kill-server", command)

    def test_tmux_version_requires_direct_multi_argument_support(self):
        with mock.patch.object(agent.shutil, "which", return_value="/usr/bin/tmux"):
            old = types.SimpleNamespace(returncode=0, stdout=b"tmux 2.0\n")
            with mock.patch.object(agent.subprocess, "run", return_value=old):
                with self.assertRaises(agent._AgentError) as raised:
                    self.original_check_tmux()
            self.assertEqual(raised.exception.error_code, "TMUX_UNAVAILABLE")

            supported = types.SimpleNamespace(returncode=0, stdout=b"tmux 2.1\n")
            with mock.patch.object(agent.subprocess, "run", return_value=supported):
                self.assertEqual(self.original_check_tmux(), "/usr/bin/tmux")

    def test_ensure_is_idempotent_without_restart_or_timer_reset(self):
        request = self.ensure_request()
        first = agent.ensure_server_wait(request, launcher, worker_source=b"worker-source")
        record = self.read_job()
        record["idleElapsedSeconds"] = 3
        record["state"] = "countdown"
        self.write_job(record)

        second = agent.ensure_server_wait(request, launcher, worker_source=b"worker-source")
        self.assertEqual(first["state"], "waiting")
        self.assertEqual(second["state"], "countdown")
        self.assertEqual(second["idleElapsedSeconds"], 3)
        self.new_session.assert_called_once()

    def test_terminal_ensure_returns_record_after_registered_paths_disappear(self):
        request = self.ensure_request()
        agent.ensure_server_wait(request, launcher, worker_source=b"worker-source")
        record = self.read_job()
        record["state"] = "failed"
        record["errorCode"] = "SERVER_WAITER_LOST"
        record["message"] = "The dedicated tmux waiter session is missing."
        self.write_job(record)
        self.script.unlink()
        self.logs.rmdir()

        status = agent.ensure_server_wait(
            request, launcher, worker_source=b"worker-source")

        self.assertEqual(status["state"], "failed")
        self.assertEqual(status["errorCode"], "SERVER_WAITER_LOST")
        self.new_session.assert_called_once()

    def test_lost_session_becomes_terminal_and_is_never_restarted(self):
        request = self.ensure_request()
        agent.ensure_server_wait(request, launcher, worker_source=b"worker-source")
        self.session_exists.return_value = False

        result = agent.ensure_server_wait(request, launcher, worker_source=b"worker-source")
        self.assertEqual(result["state"], "failed")
        self.assertEqual(result["errorCode"], "SERVER_WAITER_LOST")
        self.assertEqual(self.read_job()["state"], "failed")
        self.new_session.assert_called_once()

        again = agent.ensure_server_wait(request, launcher, worker_source=b"worker-source")
        self.assertEqual(again["state"], "failed")
        self.new_session.assert_called_once()

    def test_persistent_waiter_recreates_lost_session_with_fresh_attempt(self):
        first, status_file = self.retry_record(started=False)
        request = self.ensure_request(retryOnExit=True, idle_seconds=60)
        request["launchRequest"]["sources"].append({"sourceId": "status", "kind": "status_json", "path": str(status_file)})
        self.session_exists.return_value = False
        restored = agent.ensure_server_wait(request, launcher, worker_source=b"worker-source")
        self.assertEqual(restored["state"], "waiting")
        self.assertEqual(restored["armId"], first["armId"])
        self.assertNotEqual(self.read_job()["attemptArmId"], first["attemptArmId"])
        self.assertEqual(self.new_session.call_count, 2)
        self.session_exists.return_value = True
        agent.ensure_server_wait(request, launcher, worker_source=b"worker-source")
        self.assertEqual(self.new_session.call_count, 2)

    def test_worker_keeps_running_after_disk_full_state_write(self):
        record, _status = self.retry_record(started=False)
        error = agent._AgentError("STATE_WRITE_FAILED")
        error.__cause__ = OSError(errno.ENOSPC, "No space left on device")
        with mock.patch.object(agent, "_worker_iteration", side_effect=[error, False]) as iterate, \
             mock.patch.object(agent, "_sleep") as sleep, \
             mock.patch.object(agent, "_emit_worker_progress"):
            code = agent._run_worker(record["jobKey"], str(self.host / agent.STATE_DIRECTORY),
                                     launcher, max_iterations=2)
        self.assertEqual(code, 0)
        self.assertEqual(iterate.call_count, 2)
        sleep.assert_called_once_with(agent.POLL_SECONDS)
        self.assertEqual(self.read_job()["state"], "waiting")

    def test_second_active_arm_is_blocked_and_cancelled_arm_stays_terminal(self):
        first_arm = str(uuid.uuid4())
        second_arm = str(uuid.uuid4())
        first = self.ensure_request(arm_id=first_arm)
        agent.ensure_server_wait(first, launcher, worker_source=b"worker-source")

        second = self.ensure_request(arm_id=second_arm)
        blocked = agent.ensure_server_wait(second, launcher, worker_source=b"worker-source")
        self.assertEqual(blocked["state"], "blocked")
        self.assertEqual(blocked["errorCode"], "ACTIVE_SERVER_WAIT_EXISTS")
        self.new_session.assert_called_once()

        self.arm = first_arm
        cancelled = agent.cancel_server_wait(
            self.manager_request("cancel_server_wait"), launcher)
        self.assertEqual(cancelled["state"], "cancelled")
        again = agent.cancel_server_wait(
            self.manager_request("cancel_server_wait"), launcher)
        self.assertEqual(again["state"], "cancelled")

    def test_get_missing_does_not_create_waiter_or_touch_launch(self):
        with mock.patch.object(launcher, "launch_task") as launch:
            result = agent.get_server_wait(
                self.manager_request("get_server_wait"), launcher)
        self.assertEqual(result["state"], "missing")
        self.assertGreaterEqual(result["requiredIdleSeconds"], 1)
        launch.assert_not_called()
        self.new_session.assert_not_called()

    def test_private_status_does_not_expose_argv_sources_or_process_details(self):
        secret = "argv-secret-should-not-leak"
        request = self.ensure_request()
        request["launchRequest"]["launch"]["arguments"] = secret
        status = agent.ensure_server_wait(request, launcher, worker_source=b"worker-source")
        rendered = json.dumps(status, sort_keys=True)
        self.assertNotIn(secret, rendered)
        self.assertNotIn(str(self.log), rendered)
        self.assertNotIn("processKey", rendered)
        self.assertNotIn("launchRequest", rendered)

        record = self.read_job()
        self.assertEqual(record["launchRequest"]["launch"]["arguments"], secret)
        self.assertEqual(record["gpuDevices"] if "gpuDevices" in record else [], [])

    def test_cancel_after_started_returns_started_without_pretending_stopped(self):
        request = self.ensure_request()
        agent.ensure_server_wait(request, launcher, worker_source=b"worker-source")
        record = self.read_job()
        record.update({
            "state": "started",
            "pid": 4321,
            "startedAt": "2026-11-11T00:00:00Z",
            "selectedDeviceId": "GPU 2",
        })
        self.write_job(record)
        status = agent.cancel_server_wait(
            self.manager_request("cancel_server_wait"), launcher)
        self.assertEqual(status["state"], "started")
        self.assertEqual(status["pid"], 4321)
        self.assertEqual(status["selectedDeviceId"], "GPU 2")

    def test_cancel_after_failed_commits_cancelled(self):
        request = self.ensure_request()
        agent.ensure_server_wait(request, launcher, worker_source=b"worker-source")
        record = self.read_job()
        record["state"] = "failed"
        record["errorCode"] = "SERVER_WAITER_LOST"
        self.write_job(record)

        status = agent.cancel_server_wait(
            self.manager_request("cancel_server_wait"), launcher)
        self.assertEqual(status["state"], "cancelled")
        self.assertEqual(self.read_job()["state"], "cancelled")

    def test_distinct_gpu_timers_do_not_accumulate_while_alternating(self):
        state = agent._new_idle_state()
        times = iter([0.0, 5.0, 10.0, 15.0])
        with mock.patch.object(agent, "_iso_now", return_value="2026-11-11T00:00:00Z"):
            first = agent._update_idle_timers(
                "0, GPU-A, 0, 10, 8192\n1, GPU-B, 0, 10, 8192",
                5, 1024, next(times), state,
            )
            both_idle_at_five = agent._update_idle_timers(
                "0, GPU-A, 0, 10, 8192\n1, GPU-B, 0, 10, 8192",
                5, 1024, next(times), state,
            )
            only_a = agent._update_idle_timers(
                "0, GPU-A, 0, 10, 8192\n1, GPU-B, 90, 10, 8192",
                5, 1024, next(times), state,
            )
            only_b = agent._update_idle_timers(
                "0, GPU-A, 90, 10, 8192\n1, GPU-B, 0, 10, 8192",
                5, 1024, next(times), state,
            )

        self.assertEqual({item["uuid"] for item in first}, {"GPU-A", "GPU-B"})
        self.assertEqual({item["elapsedSeconds"] for item in both_idle_at_five}, {5})
        self.assertEqual(only_a[0]["uuid"], "GPU-A")
        self.assertEqual(only_a[0]["elapsedSeconds"], 10)
        self.assertEqual(only_b[0]["uuid"], "GPU-B")
        self.assertEqual(only_b[0]["elapsedSeconds"], 0)

    def test_busy_gpu_resets_then_busy_to_idle_starts_a_fresh_timer(self):
        state = agent._new_idle_state()
        with mock.patch.object(agent, "_iso_now", return_value="2026-11-11T00:00:00Z"):
            agent._update_idle_timers(
                "0, GPU-A, 0, 10, 8192", 5, 1024, 0.0, state)
            running = agent._update_idle_timers(
                "0, GPU-A, 0, 10, 8192", 5, 1024, 4.0, state)
            busy = agent._update_idle_timers(
                "0, GPU-A, 80, 10, 8192", 5, 1024, 8.0, state)
            fresh = agent._update_idle_timers(
                "0, GPU-A, 0, 10, 8192", 5, 1024, 12.0, state)
            five_seconds = agent._update_idle_timers(
                "0, GPU-A, 0, 10, 8192", 5, 1024, 17.0, state)
        self.assertEqual(running[0]["elapsedSeconds"], 4)
        self.assertEqual(busy, [])
        self.assertEqual(fresh[0]["elapsedSeconds"], 0)
        self.assertEqual(five_seconds[0]["elapsedSeconds"], 5)

    def test_missing_identity_change_and_long_gap_reset_relevant_timers(self):
        state = agent._new_idle_state()
        with mock.patch.object(agent, "_iso_now", return_value="2026-11-11T00:00:00Z"):
            agent._update_idle_timers(
                "1, GPU-A, 0, 10, 8192\n2, GPU-B, 0, 10, 8192",
                5, 1024, 0.0, state,
            )
            changed = agent._update_idle_timers(
                "3, GPU-A, 0, 10, 8192\n2, GPU-B, 0, 10, 8192",
                5, 1024, 4.0, state,
            )
            missing = agent._update_idle_timers(
                "2, GPU-B, 0, 10, 8192",
                5, 1024, 8.0, state,
            )
            gap = agent._update_idle_timers(
                "2, GPU-B, 0, 10, 8192",
                5, 1024, 30.0, state,
            )
        a = next(item for item in changed if item["uuid"] == "GPU-A")
        b = next(item for item in changed if item["uuid"] == "GPU-B")
        self.assertEqual(a["elapsedSeconds"], 0)
        self.assertEqual(a["deviceId"], "GPU 3")
        self.assertEqual(b["elapsedSeconds"], 4)
        self.assertEqual(missing[0]["uuid"], "GPU-B")
        self.assertEqual(missing[0]["elapsedSeconds"], 8)
        self.assertEqual(gap[0]["elapsedSeconds"], 0)

    def test_per_card_unknown_metrics_reset_only_that_cards_timer(self):
        state = agent._new_idle_state()
        with mock.patch.object(agent, "_iso_now", return_value="2026-11-11T00:00:00Z"):
            agent._update_idle_timers(
                "0, GPU-A, 0, 10, 8192\n"
                "1, GPU-B, 0, 10, 8192",
                5, 1024, 0.0, state,
            )
            five_seconds = agent._update_idle_timers(
                "0, GPU-A, N/A, 10, 8192\n"
                "1, GPU-B, 0, 10, 8192",
                5, 1024, 5.0, state,
            )
            ten_seconds = agent._update_idle_timers(
                "0, GPU-A, [N/A], 10, 8192\n"
                "1, GPU-B, 0, 10, 8192",
                5, 1024, 10.0, state,
            )
            recovered = agent._update_idle_timers(
                "0, GPU-A, 0, 10, 8192\n"
                "1, GPU-B, 0, 10, 8192",
                5, 1024, 15.0, state,
            )

        self.assertEqual(five_seconds[0]["uuid"], "GPU-B")
        self.assertEqual(five_seconds[0]["elapsedSeconds"], 5)
        self.assertEqual(ten_seconds[0]["elapsedSeconds"], 10)
        by_uuid = {item["uuid"]: item for item in recovered}
        self.assertEqual(by_uuid["GPU-A"]["elapsedSeconds"], 0)
        self.assertEqual(by_uuid["GPU-B"]["elapsedSeconds"], 15)

    def test_non_advancing_monotonic_sample_resets_idle_continuity(self):
        state = agent._new_idle_state()
        with mock.patch.object(agent, "_iso_now", return_value="2026-11-11T00:00:00Z"):
            agent._update_idle_timers(
                "0, GPU-A, 0, 10, 8192", 5, 1024, 10.0, state)
            zero_gap = agent._update_idle_timers(
                "0, GPU-A, 0, 10, 8192", 5, 1024, 10.0, state)
            backward = agent._update_idle_timers(
                "0, GPU-A, 0, 10, 8192", 5, 1024, 9.0, state)

        self.assertEqual(zero_gap[0]["elapsedSeconds"], 0)
        self.assertEqual(backward[0]["elapsedSeconds"], 0)

    def test_all_gpus_are_scanned_and_one_deterministic_ready_card_is_passed(self):
        devices = agent._parse_gpu_csv(
            "0, GPU-A, 0, 10, 8192\n"
            "2, GPU-B, 0, 10, 8192\n"
            "5, GPU-C, 75, 4096, 8192",
            5, 1024,
        )
        self.assertEqual(set(devices), {"GPU-A", "GPU-B", "GPU-C"})
        self.assertFalse(devices["GPU-C"]["idle"])

        record = {
            "launchRequest": {
                "version": 1,
                "requestId": "launch",
                "sourceId": None,
                "op": "launch_task",
                "armId": self.arm,
                "taskId": "registered-task",
                "configHash": self.config_hash,
                "hostAllowedRoots": [str(self.host)],
                "taskAllowedDirectories": [str(self.task)],
                "entryPaths": [str(self.script)],
                "sources": [],
                "launch": {},
                "gpuDevices": [],
                "maxUtilizationPercent": 5,
                "maxMemoryMiB": 1024,
            },
        }
        chosen = agent._chosen_launch_request(record, {
            "deviceId": "GPU 2",
            "uuid": "GPU-B",
        })
        self.assertEqual(chosen["gpuDevices"], [{
            "deviceId": "GPU 2",
            "uuid": "GPU-B",
        }])

        candidates = agent._update_idle_timers(
            "0, GPU-A, 0, 10, 8192\n2, GPU-B, 0, 10, 8192",
            5, 1024, 10.0, agent._new_idle_state(),
        )
        self.assertEqual(agent._best_candidate(candidates)["deviceId"], "GPU 0")

    def test_launcher_busy_result_recounts_without_terminal_receipt(self):
        request = self.ensure_request()
        agent.ensure_server_wait(request, launcher, worker_source=b"worker-source")
        record = self.read_job()
        path = str(self.job_path())
        state_root = str(self.host / agent.STATE_DIRECTORY)
        fake_launcher = types.SimpleNamespace(
            _LaunchError=launcher._LaunchError,
            launch_task=mock.Mock(return_value={"status": "busy"}),
            _current_uid=launcher._current_uid,
            _fsync_directory=launcher._fsync_directory,
        )
        candidate = {
            "uuid": "GPU-A",
            "index": 0,
            "deviceId": "GPU 0",
            "elapsedSeconds": 8,
        }
        terminal = agent._launch_candidate(
            record, path, state_root, fake_launcher, candidate)
        self.assertFalse(terminal)
        persisted = self.read_job()
        self.assertEqual(persisted["state"], "waiting")
        self.assertEqual(persisted["idleElapsedSeconds"], 0)
        self.assertIsNone(persisted["errorCode"])

    def test_busy_first_gpu_preserves_second_gpu_timer_for_next_tick(self):
        request = self.ensure_request(idle_seconds=1)
        agent.ensure_server_wait(request, launcher, worker_source=b"worker-source")
        record = self.read_job()
        job_key = record["jobKey"]
        state_root = str(self.host / agent.STATE_DIRECTORY)
        now = agent._monotonic()
        idle_state = {
            "idleSince": {"GPU-A": now - 10, "GPU-B": now - 5},
            "indexes": {"GPU-A": 0, "GPU-B": 1},
            "lastSample": now - 1,
            "lastCheckedAt": None,
        }
        fake_probe = types.SimpleNamespace(
            _query_linux_gpu=lambda: {
                "status": "ok",
                "csv": "0, GPU-A, 0, 10, 8192\n1, GPU-B, 0, 10, 8192",
            },
            _canonical_task_roots=lambda hosts, tasks: (hosts, tasks),
        )
        fake_launcher = types.SimpleNamespace(
            _LaunchError=launcher._LaunchError,
            _probe=lambda: fake_probe,
            _validate_request=launcher._validate_request,
            _scan_for_registered_process=mock.Mock(return_value=None),
            launch_task=mock.Mock(side_effect=[
                {"status": "busy"},
                {
                    "status": "started",
                    "pid": 1234,
                    "startedAt": "2026-11-11T00:00:00Z",
                },
            ]),
            _current_uid=launcher._current_uid,
            _fsync_directory=launcher._fsync_directory,
            _require_fcntl=launcher._require_fcntl,
        )

        with mock.patch.object(
            agent,
            "_monotonic",
            side_effect=[now, now + 1, now + 1, now + 2],
        ):
            self.assertTrue(agent._worker_iteration(
                job_key,
                state_root,
                fake_launcher,
                idle_state,
                tmux_executable="/usr/bin/tmux",
            ))
            self.assertFalse(agent._worker_iteration(
                job_key,
                state_root,
                fake_launcher,
                idle_state,
                tmux_executable="/usr/bin/tmux",
            ))

        chosen = [
            call.args[0]["gpuDevices"][0]
            for call in fake_launcher.launch_task.call_args_list
        ]
        self.assertEqual(chosen, [
            {"deviceId": "GPU 0", "uuid": "GPU-A"},
            {"deviceId": "GPU 1", "uuid": "GPU-B"},
        ])
        persisted = self.read_job()
        self.assertEqual(persisted["state"], "started")
        self.assertEqual(persisted["selectedDeviceId"], "GPU 1")

    def test_cancel_holds_control_lock_before_worker_can_launch(self):
        request = self.ensure_request(idle_seconds=1)
        agent.ensure_server_wait(request, launcher, worker_source=b"worker-source")
        record = self.read_job()
        job_key = record["jobKey"]
        state_root = str(self.host / agent.STATE_DIRECTORY)
        idle_state = {
            "idleSince": {"GPU-A": agent._monotonic() - 10},
            "indexes": {"GPU-A": 0},
            "lastSample": agent._monotonic() - 5,
            "lastCheckedAt": None,
        }
        fake_probe = types.SimpleNamespace(
            _query_linux_gpu=lambda: {
                "status": "ok",
                "csv": "0, GPU-A, 0, 10, 8192",
            },
            _canonical_task_roots=lambda hosts, tasks: (hosts, tasks),
        )
        fake_launcher = types.SimpleNamespace(
            _LaunchError=launcher._LaunchError,
            _probe=lambda: fake_probe,
            _validate_request=launcher._validate_request,
            _scan_for_registered_process=mock.Mock(return_value=None),
            launch_task=mock.Mock(),
            launch_task_result=None,
            _current_uid=launcher._current_uid,
            _require_fcntl=launcher._require_fcntl,
        )
        fake_launcher.launch_task.return_value = {
            "status": "started",
            "pid": 1234,
            "startedAt": "2026-11-11T00:00:00Z",
            "errorCode": None,
        }

        real_acquire = agent._acquire_file_lock
        worker_waiting = threading.Event()
        cancel_finished = threading.Event()
        errors = []

        def lock_for_race(path, lock_launcher, nonblocking=False):
            if threading.current_thread().name == "waiter-thread":
                worker_waiting.set()
                if not cancel_finished.wait(3):
                    raise AssertionError("cancel did not finish")
            return real_acquire(path, lock_launcher, nonblocking=nonblocking)

        def run_worker():
            try:
                agent._worker_iteration(
                    job_key,
                    state_root,
                    fake_launcher,
                    idle_state,
                    tmux_executable="/usr/bin/tmux",
                )
            except Exception as exc:
                errors.append(exc)

        with mock.patch.object(agent, "_acquire_file_lock", side_effect=lock_for_race):
            worker = threading.Thread(target=run_worker, name="waiter-thread")
            worker.start()
            self.assertTrue(worker_waiting.wait(3))
            cancelled = agent.cancel_server_wait(
                self.manager_request("cancel_server_wait"), launcher)
            self.assertEqual(cancelled["state"], "cancelled")
            cancel_finished.set()
            worker.join(3)

        self.assertFalse(worker.is_alive())
        self.assertEqual(errors, [])
        fake_launcher.launch_task.assert_not_called()
        self.assertEqual(self.read_job()["state"], "cancelled")

    def test_real_base64_handoff_loads_launcher_namespace_without_self_recursion(self):
        agent_source = AGENT_PATH.read_text(encoding="utf-8")
        launcher_source = LAUNCHER_PATH.read_text(encoding="utf-8").replace(
            "__READONLY_PROBE_SOURCE_B64__",
            base64.b64encode(PROBE_PATH.read_bytes()).decode("ascii"),
            1,
        )
        launcher_b64 = base64.b64encode(launcher_source.encode("utf-8")).decode("ascii")
        manager_stage = agent_source.replace(
            "__LAUNCHER_SOURCE_B64__", launcher_b64, 1)
        worker_b64 = base64.b64encode(manager_stage.encode("utf-8")).decode("ascii")
        manager_source = manager_stage.replace(
            "__SERVER_AGENT_SOURCE_B64__", worker_b64, 1)

        loaded = agent._load_launcher(launcher_b64)
        self.assertIsInstance(loaded, types.SimpleNamespace)
        self.assertTrue(callable(loaded.launch_task))
        self.assertIsNotNone(loaded._probe())

        namespace = {"__name__": "embedded_worker_template_test"}
        exec(compile(base64.b64decode(worker_b64),
                     "<worker-template>", "exec"), namespace)
        self.assertEqual(namespace["AGENT_SOURCE_B64"], "__SERVER_AGENT_SOURCE_B64__")
        self.assertEqual(namespace["REQUEST_B64"], "__MONITOR_REQUEST_B64__")
        self.assertEqual(namespace["LAUNCHER_SOURCE_B64"], launcher_b64)

        self.assertIn("__MONITOR_REQUEST_B64__", manager_source)
        self.assertIn("__SERVER_AGENT_SOURCE_B64__", base64.b64decode(worker_b64).decode("utf-8"))
        self.assertNotIn(worker_b64, base64.b64decode(worker_b64).decode("utf-8"))

    def test_real_loaded_launcher_accepts_empty_gpudevices_without_gpu_query(self):
        launcher_source = LAUNCHER_PATH.read_text(encoding="utf-8").replace(
            "__READONLY_PROBE_SOURCE_B64__",
            base64.b64encode(PROBE_PATH.read_bytes()).decode("ascii"),
            1,
        )
        loaded = agent._load_launcher(
            base64.b64encode(launcher_source.encode("utf-8")).decode("ascii"))
        common = agent._validate_manager_request(self.ensure_request())

        normalized = agent._validate_launch_request(loaded, common)

        self.assertEqual(normalized["gpuDevices"], [])
        self.assertEqual(loaded._validate_request(
            agent._chosen_launch_request(
                {"launchRequest": normalized},
                {"deviceId": "GPU 0", "uuid": "GPU-server-waiter"},
            ))["gpuDevices"],
            [{"deviceId": "GPU 0", "uuid": "GPU-server-waiter"}],
        )

    def test_worker_cli_uses_saved_script_argv_shape(self):
        with mock.patch.object(agent.sys, "argv", [
                 "/state/worker.py",
                 "--worker",
                 "a" * 64,
                 "/state",
             ]), \
             mock.patch.object(agent, "_load_launcher", return_value=object()), \
             mock.patch.object(agent, "_run_worker", return_value=0) as run_worker:
            self.assertEqual(agent._worker_main(), 0)
        run_worker.assert_called_once_with("a" * 64, "/state", mock.ANY)

    def test_worker_progress_is_one_sanitized_line_without_launch_details(self):
        secret = "argv-secret-must-not-reach-attached-pane"
        request = self.ensure_request()
        request["launchRequest"]["launch"]["arguments"] = secret
        agent.ensure_server_wait(request, launcher, worker_source=b"worker-source")
        record = self.read_job()
        record.update({
            "state": "countdown",
            "idleElapsedSeconds": 4,
            "selectedDeviceId": "GPU 2",
            "requiredIdleSeconds": 5,
        })
        self.write_job(record)
        output = io.StringIO()

        with mock.patch.object(agent, "_worker_iteration", return_value=False), \
             mock.patch.object(agent, "_iso_now",
                               return_value="2026-11-11T01:02:03Z"), \
             mock.patch.object(agent.sys, "stdout", output):
            code = agent._run_worker(
                record["jobKey"],
                str(self.host / agent.STATE_DIRECTORY),
                launcher,
                max_iterations=1,
            )

        self.assertEqual(code, 0)
        lines = output.getvalue().splitlines()
        self.assertEqual(lines, [
            "2026-11-11T01:02:03Z state=countdown candidate=GPU 2 "
            "continuous=4s required=5s",
        ])
        self.assertNotIn(secret, lines[0])
        self.assertNotIn(str(self.task), lines[0])
        self.assertNotIn(str(self.log), lines[0])
        self.assertNotIn("argv", lines[0])

    def test_worker_progress_broken_stdout_cannot_affect_iteration(self):
        request = self.ensure_request()
        agent.ensure_server_wait(request, launcher, worker_source=b"worker-source")
        record = self.read_job()

        class BrokenStdout:
            def write(self, _value):
                raise BrokenPipeError()

            def flush(self):
                raise BrokenPipeError()

        with mock.patch.object(agent, "_worker_iteration", return_value=False), \
             mock.patch.object(agent.sys, "stdout", BrokenStdout()):
            code = agent._run_worker(
                record["jobKey"],
                str(self.host / agent.STATE_DIRECTORY),
                launcher,
                max_iterations=1,
            )

        self.assertEqual(code, 0)

    def retry_record(self, *, started=True):
        status_file = self.task / "status.json"
        status_file.write_text(json.dumps({"status": "failed", "pid": 42}), encoding="utf-8")
        request = self.ensure_request(retryOnExit=True, idle_seconds=60)
        request["launchRequest"]["sources"].append({"sourceId": "status", "kind": "status_json", "path": str(status_file)})
        agent.ensure_server_wait(request, launcher, worker_source=b"worker-source")
        record = self.read_job()
        if started:
            record.update(state="started", pid=42, selectedDeviceId="GPU 5", startedAt="2026-11-11T00:00:00Z",
                          processKey={"pid": 42, "hostBootId": "boot", "startTicks": "123"})
            self.write_job(record)
        return record, status_file

    def test_exit_recounts_idle_time_and_can_switch_from_gpu5_to_gpu6(self):
        record, _status = self.retry_record()
        state_root = str(self.host / agent.STATE_DIRECTORY)
        idle = agent._new_idle_state()
        idle["idleSince"]["GPU-old"] = 1
        with mock.patch.object(agent, "_process_is_running", return_value=False):
            self.assertTrue(agent._retry_iteration(record["jobKey"], state_root, launcher, idle))
        reset = self.read_job()
        self.assertEqual(reset["state"], "waiting")
        self.assertIsNone(reset["selectedDeviceId"])
        self.assertEqual(reset["launchRequest"]["gpuDevices"], [])
        self.assertNotEqual(reset["attemptArmId"], self.arm)
        self.assertEqual(idle["idleSince"], {})
        query = mock.Mock(return_value={"status": "ok", "csv": "5, GPU-old, 99, 18000, 24564\n6, GPU-free, 0, 20, 24564"})
        real_probe = launcher._probe()
        fake_probe = types.SimpleNamespace(_query_linux_gpu=query, _canonical_task_roots=lambda h, t: (h, t), open_readonly=real_probe.open_readonly)
        receipt = {"status": "started", "pid": 84, "startedAt": "2026-11-11T00:02:00Z", "processKey": {"pid": 84, "hostBootId": "boot", "startTicks": "456"}}
        with mock.patch.object(launcher, "_probe", return_value=fake_probe), \
             mock.patch.object(launcher, "_scan_for_registered_process", return_value=None), \
             mock.patch.object(launcher, "launch_task", return_value=receipt) as launch, \
             mock.patch.object(agent, "_monotonic", side_effect=[10., 10., 20., 20., 30., 30., 40., 40., 50., 50., 60., 60., 70., 70.]):
            for _ in range(7):
                self.assertTrue(agent._worker_iteration(record["jobKey"], state_root, launcher, idle, tmux_executable="/usr/bin/tmux"))
        self.assertEqual(launch.call_count, 1)
        request = launch.call_args.args[0]
        self.assertEqual(request["gpuDevices"], [{"deviceId": "GPU 6", "uuid": "GPU-free"}])
        self.assertEqual(request["armId"], reset["attemptArmId"])
        self.assertEqual(self.read_job()["state"], "started")

    def test_live_task_keeps_watcher_without_launching_another_copy(self):
        record, _status = self.retry_record()
        with mock.patch.object(agent, "_process_is_running", return_value=True), \
             mock.patch.object(launcher, "launch_task") as launch:
            self.assertTrue(agent._worker_iteration(record["jobKey"], str(self.host / agent.STATE_DIRECTORY), launcher,
                                                   agent._new_idle_state(), tmux_executable="/usr/bin/tmux"))
        launch.assert_not_called()
        self.assertEqual(self.read_job()["pid"], 42)

    def test_completed_status_stops_automatic_retry(self):
        record, status_file = self.retry_record()
        status_file.write_text(json.dumps({"status": "completed", "pid": 42, "completed_samples": 42000, "total_samples": 42000}), encoding="utf-8")
        with mock.patch.object(agent, "_process_is_running", return_value=False):
            self.assertFalse(agent._retry_iteration(record["jobKey"], str(self.host / agent.STATE_DIRECTORY), launcher, agent._new_idle_state()))
        self.assertTrue(self.read_job()["retryFinished"])

    def test_cancel_running_retry_watcher_leaves_training_pid_unchanged(self):
        _record, _status = self.retry_record()
        status = agent.cancel_server_wait(self.manager_request("cancel_server_wait"), launcher)
        self.assertEqual(status["state"], "cancelled")
        self.assertEqual(self.read_job()["pid"], 42)

    def test_process_identity_rejects_reused_pid_and_zombie(self):
        root = self.host / "proc"
        boot = root / "sys/kernel/random/boot_id"
        boot.parent.mkdir(parents=True)
        boot.write_text("boot\n", encoding="ascii")
        stat_file = root / "42/stat"
        stat_file.parent.mkdir()
        stat_file.write_text("42 (python worker) " + " ".join(["R"] + ["0"] * 18 + ["123"]), encoding="ascii")
        key = {"pid": 42, "hostBootId": "boot", "startTicks": "123"}
        self.assertTrue(agent._process_is_running(key, str(root)))
        self.assertFalse(agent._process_is_running({**key, "startTicks": "124"}, str(root)))
        stat_file.write_text(stat_file.read_text().replace(") R ", ") Z "), encoding="ascii")
        self.assertFalse(agent._process_is_running(key, str(root)))

    def test_manager_path_never_emits_worker_progress(self):
        request = self.manager_request("get_server_wait")
        encoded = base64.b64encode(
            json.dumps(request).encode("utf-8")).decode("ascii")
        with mock.patch.object(agent, "REQUEST_B64", encoded), \
             mock.patch.object(agent, "_load_launcher", return_value=object()), \
             mock.patch.object(agent, "_dispatch", return_value=agent._missing_status(
                 self.arm, self.config_hash)), \
             mock.patch.object(agent, "_emit_worker_progress") as progress:
            code, frame = agent._manager_main()

        self.assertEqual(code, 0)
        self.assertEqual(frame["payload"]["state"], "missing")
        progress.assert_not_called()

    def test_manager_emits_one_binary_frame_with_strict_payload(self):
        request = self.manager_request("get_server_wait")
        encoded = base64.b64encode(
            json.dumps(request).encode("utf-8")).decode("ascii")
        with mock.patch.object(agent, "REQUEST_B64", encoded), \
             mock.patch.object(agent, "_load_launcher", return_value=object()), \
             mock.patch.object(agent, "_dispatch", return_value=agent._missing_status(
                 self.arm, self.config_hash)):
            code, frame = agent._manager_main()
        self.assertEqual(code, 0)
        self.assertEqual(set(frame), {"version", "requestId", "sourceId", "payload"})
        self.assertEqual(frame["requestId"], "get_server_wait")
        self.assertIsNone(frame["sourceId"])
        self.assertEqual(frame["payload"]["state"], "missing")

    def test_real_filled_manager_template_returns_missing_frame(self):
        launcher_source = LAUNCHER_PATH.read_text(encoding="utf-8").replace(
            "__READONLY_PROBE_SOURCE_B64__",
            base64.b64encode(PROBE_PATH.read_bytes()).decode("ascii"),
            1,
        )
        source = AGENT_PATH.read_text(encoding="utf-8").replace(
            "__LAUNCHER_SOURCE_B64__",
            base64.b64encode(launcher_source.encode("utf-8")).decode("ascii"),
            1,
        )
        worker_source = source
        source = source.replace(
            "__SERVER_AGENT_SOURCE_B64__",
            base64.b64encode(worker_source.encode("utf-8")).decode("ascii"),
            1,
        )
        request = self.manager_request("get_server_wait")
        source = source.replace(
            "__MONITOR_REQUEST_B64__",
            base64.b64encode(json.dumps(request).encode("utf-8")).decode("ascii"),
            1,
        )
        namespace = {"__name__": "filled_manager_template_test"}
        exec(compile(source, "<filled-manager>", "exec"), namespace)
        code, frame = namespace["_manager_main"]()
        self.assertEqual(code, 0)
        self.assertEqual(frame["requestId"], "get_server_wait")
        self.assertEqual(frame["payload"]["state"], "missing")
        self.assertGreaterEqual(frame["payload"]["requiredIdleSeconds"], 1)


if __name__ == "__main__":
    unittest.main()
