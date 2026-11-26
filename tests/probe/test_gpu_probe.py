import base64
import importlib.util
import io
import json
import os
from pathlib import Path
import struct
import subprocess
import sys
import types
import unittest
from unittest import mock

MODULE_PATH = Path(__file__).parents[2] / "src" / "probe" / "readonly_probe.py"
SPEC = importlib.util.spec_from_file_location("readonly_probe", MODULE_PATH)
probe = importlib.util.module_from_spec(SPEC)
assert SPEC and SPEC.loader
SPEC.loader.exec_module(probe)


def _fake_popen_factory(stdout_bytes=b"", returncode=0, raise_exc=None, delay_wait_timeout=False):
    """Build a Popen replacement backed by a real OS pipe so streaming selector reads are exercised."""
    recorded = []

    def _factory(cmd, **kwargs):
        recorded.append((cmd, kwargs))
        if raise_exc is not None:
            raise raise_exc
        r_fd, w_fd = os.pipe()
        # Write in a thread if larger than pipe buffer so we never deadlock
        import threading

        def _writer():
            try:
                view = memoryview(stdout_bytes)
                offset = 0
                while offset < len(view):
                    written = os.write(w_fd, view[offset:offset + 8192])
                    offset += written
            except OSError:
                pass
            finally:
                try:
                    os.close(w_fd)
                except OSError:
                    pass

        t = threading.Thread(target=_writer, daemon=True)
        t.start()
        reader = os.fdopen(r_fd, "rb", buffering=0)

        class _FakeChild:
            def __init__(self):
                self.stdout = reader
                self._killed = False
                self._rc = returncode

            def poll(self):
                return self._rc if self._killed else None

            def kill(self):
                self._killed = True
                try:
                    reader.close()
                except OSError:
                    pass

            def wait(self, timeout=None):
                if delay_wait_timeout and not self._killed:
                    raise subprocess.TimeoutExpired(cmd=cmd, timeout=timeout or 2)
                t.join(timeout=0.5)
                return self._rc

        return _FakeChild()

    return _factory, recorded


class GpuProbeTests(unittest.TestCase):
    """Mock-based unit tests for GPU aggregate querying, streaming limits, MIG/N/A, and CPU fallback."""

    def test_query_linux_gpu_exact_command_arguments_and_device_metrics_only(self):
        popen_fn, recorded = _fake_popen_factory(b"0, GPU-mock-uuid-1, 15, 2048, 8192\n")
        with mock.patch.object(probe, "_find_nvidia_smi", return_value="/usr/local/bin/nvidia-smi"), \
             mock.patch.object(probe.subprocess, "Popen", side_effect=popen_fn):
            result = probe._query_linux_gpu()

        self.assertEqual(result["status"], "ok")
        self.assertEqual(result["acceleratorAvailability"], "available")
        self.assertIsNone(result["errorCode"])
        self.assertEqual(result["csv"], "0, GPU-mock-uuid-1, 15, 2048, 8192\n")
        self.assertIsInstance(result["observedAt"], int)

        self.assertEqual(len(recorded), 1)
        cmd, kwargs = recorded[0]
        self.assertEqual(cmd, [
            "/usr/local/bin/nvidia-smi",
            "--query-gpu=index,uuid,utilization.gpu,memory.used,memory.total",
            "--format=csv,noheader,nounits",
        ])
        self.assertEqual(kwargs.get("stdout"), subprocess.PIPE)
        self.assertEqual(kwargs.get("stderr"), subprocess.DEVNULL)

        full_cmd_str = " ".join(cmd)
        self.assertNotIn("compute-apps", full_cmd_str)
        self.assertNotIn("pid", full_cmd_str)
        self.assertNotIn("process_name", full_cmd_str)
        self.assertNotIn("used_memory", full_cmd_str)
        self.assertNotIn("user", full_cmd_str)

    def test_find_nvidia_smi_prefers_trusted_paths_before_path(self):
        with mock.patch.object(probe.os, "name", "posix"), \
             mock.patch.object(probe.os.path, "isfile", side_effect=lambda p: p == "/usr/bin/nvidia-smi"), \
             mock.patch.object(probe.os, "access", return_value=True), \
             mock.patch.object(probe.shutil, "which", return_value="/tmp/evil/nvidia-smi"):
            self.assertEqual(probe._find_nvidia_smi(), "/usr/bin/nvidia-smi")

    def test_query_linux_gpu_cpu_only_returns_none_gracefully(self):
        with mock.patch.object(probe, "_find_nvidia_smi", return_value=None):
            result = probe._query_linux_gpu()
        self.assertEqual(result, {
            "status": "none",
            "acceleratorAvailability": "none",
            "observedAt": None,
            "csv": None,
            "errorCode": None,
        })

    def test_query_linux_gpu_multi_gpu_csv_parsing(self):
        stdout_data = (
            b"0, GPU-aaaa-1111, 45, 8192, 24576\n"
            b"1, GPU-bbbb-2222, 0, 1024, 24576\n"
            b"2, MIG-cccc-3333/0/0, [N/A], [Not Supported], 24576\n"
        )
        popen_fn, _ = _fake_popen_factory(stdout_data)
        with mock.patch.object(probe, "_find_nvidia_smi", return_value="/usr/bin/nvidia-smi"), \
             mock.patch.object(probe.subprocess, "Popen", side_effect=popen_fn):
            result = probe._query_linux_gpu()

        self.assertEqual(result["status"], "ok")
        self.assertEqual(result["csv"], stdout_data.decode("utf-8"))
        self.assertIsNone(result["errorCode"])
        self.assertIsInstance(result["observedAt"], int)
        devices = probe._gpu_devices_from_csv(result["csv"])
        self.assertEqual(len(devices), 3)
        self.assertEqual(devices[2]["uuid"], "MIG-cccc-3333/0/0")

    def test_missing_gpu_values_and_mig_uuid_helpers(self):
        for token in ("[N/A]", "[Not Supported]", "N/A", "NA", "Not Supported", "Unknown", "-", ""):
            self.assertTrue(probe._is_missing_gpu_value(token), token)
        self.assertFalse(probe._is_missing_gpu_value("42"))
        self.assertTrue(probe._is_valid_gpu_uuid("GPU-1234-abcd"))
        self.assertTrue(probe._is_valid_gpu_uuid("MIG-GPU-1234/0/1"))
        self.assertFalse(probe._is_valid_gpu_uuid("bad-uuid"))
        self.assertFalse(probe._is_valid_gpu_uuid("GPU-../escape"))

    def test_query_linux_gpu_replaces_invalid_utf8_safely(self):
        popen_fn, _ = _fake_popen_factory(b"0, GPU-1, 0, 0, 8192\n\xff\xfe")
        with mock.patch.object(probe, "_find_nvidia_smi", return_value="/usr/bin/nvidia-smi"), \
             mock.patch.object(probe.subprocess, "Popen", side_effect=popen_fn):
            result = probe._query_linux_gpu()

        self.assertEqual(result["status"], "ok")
        self.assertIn("0, GPU-1, 0, 0, 8192\n", result["csv"])
        self.assertIn("\ufffd", result["csv"])

    def test_query_linux_gpu_2s_timeout_returns_timeout_code(self):
        popen_fn, _ = _fake_popen_factory(b"", delay_wait_timeout=True)
        with mock.patch.object(probe, "_find_nvidia_smi", return_value="/usr/bin/nvidia-smi"), \
             mock.patch.object(probe.subprocess, "Popen", side_effect=popen_fn):
            result = probe._query_linux_gpu()

        self.assertEqual(result, {
            "status": "unavailable",
            "acceleratorAvailability": "unavailable",
            "observedAt": None,
            "csv": None,
            "errorCode": "NVIDIA_SMI_TIMEOUT",
        })

    def test_query_linux_gpu_missing_tool_oserror_returns_unavailable(self):
        popen_fn, _ = _fake_popen_factory(raise_exc=FileNotFoundError("Tool not found"))
        with mock.patch.object(probe, "_find_nvidia_smi", return_value="/usr/bin/nvidia-smi"), \
             mock.patch.object(probe.subprocess, "Popen", side_effect=popen_fn):
            result = probe._query_linux_gpu()

        self.assertEqual(result, {
            "status": "unavailable",
            "acceleratorAvailability": "unavailable",
            "observedAt": None,
            "csv": None,
            "errorCode": "NVIDIA_SMI_UNAVAILABLE",
        })

    def test_query_linux_gpu_permission_oserror_returns_unavailable(self):
        popen_fn, _ = _fake_popen_factory(raise_exc=PermissionError("Permission denied"))
        with mock.patch.object(probe, "_find_nvidia_smi", return_value="/usr/bin/nvidia-smi"), \
             mock.patch.object(probe.subprocess, "Popen", side_effect=popen_fn):
            result = probe._query_linux_gpu()

        self.assertEqual(result, {
            "status": "unavailable",
            "acceleratorAvailability": "unavailable",
            "observedAt": None,
            "csv": None,
            "errorCode": "NVIDIA_SMI_UNAVAILABLE",
        })

    def test_query_linux_gpu_nonzero_exit_code_returns_failed(self):
        popen_fn, _ = _fake_popen_factory(b"", returncode=1)
        with mock.patch.object(probe, "_find_nvidia_smi", return_value="/usr/bin/nvidia-smi"), \
             mock.patch.object(probe.subprocess, "Popen", side_effect=popen_fn):
            result = probe._query_linux_gpu()

        self.assertEqual(result, {
            "status": "unavailable",
            "acceleratorAvailability": "unavailable",
            "observedAt": None,
            "csv": None,
            "errorCode": "NVIDIA_SMI_FAILED",
        })

    def test_query_linux_gpu_response_exceeds_16kb_returns_response_limit(self):
        oversized_stdout = b"0, GPU-x, 0, 0, 8192\n" * 1000
        self.assertGreater(len(oversized_stdout), 16 * 1024)
        popen_fn, _ = _fake_popen_factory(oversized_stdout)
        with mock.patch.object(probe, "_find_nvidia_smi", return_value="/usr/bin/nvidia-smi"), \
             mock.patch.object(probe.subprocess, "Popen", side_effect=popen_fn):
            result = probe._query_linux_gpu()

        self.assertEqual(result, {
            "status": "unavailable",
            "acceleratorAvailability": "unavailable",
            "observedAt": None,
            "csv": None,
            "errorCode": "NVIDIA_SMI_RESPONSE_LIMIT",
        })

    def test_query_linux_gpu_response_exactly_at_16kb_limit_succeeds(self):
        exact_stdout = b"a" * (16 * 1024)
        popen_fn, _ = _fake_popen_factory(exact_stdout)
        with mock.patch.object(probe, "_find_nvidia_smi", return_value="/usr/bin/nvidia-smi"), \
             mock.patch.object(probe.subprocess, "Popen", side_effect=popen_fn):
            result = probe._query_linux_gpu()

        self.assertEqual(result["status"], "ok")
        self.assertIsNone(result["errorCode"])
        self.assertEqual(len(result["csv"]), 16 * 1024)

    def test_probe_host_cpu_only_node_keeps_host_connected_and_reports_none(self):
        fake_boot_id = "boot-id-cpu-only"
        with mock.patch("builtins.open", mock.mock_open(read_data=fake_boot_id + "\n")), \
             mock.patch.object(probe, "_find_nvidia_smi", return_value=None):
            response = probe._dispatch({"op": "probe_host"})

        self.assertEqual(response["hostBootId"], fake_boot_id)
        self.assertIs(response["scanComplete"], True)
        self.assertIsNone(response["errorCode"])
        self.assertEqual(response["acceleratorAvailability"], "none")
        self.assertEqual(response["gpu"]["status"], "none")
        self.assertEqual(response["gpu"]["acceleratorAvailability"], "none")

    def test_probe_host_with_gpu_success_maintains_host_identity(self):
        fake_boot_id = "11223344-5566-7788-99aa-bbccddeeff00"
        mock_gpu_result = {
            "status": "ok",
            "acceleratorAvailability": "available",
            "observedAt": 1700000000000,
            "csv": "0, GPU-uuid-0, 20, 4096, 16384\n",
            "errorCode": None,
        }
        with mock.patch("builtins.open", mock.mock_open(read_data=fake_boot_id + "\n")), \
             mock.patch.object(probe, "_query_linux_gpu", return_value=mock_gpu_result):
            response = probe._dispatch({"op": "probe_host"})

        self.assertEqual(response["hostBootId"], fake_boot_id)
        self.assertIs(response["scanComplete"], True)
        self.assertIsNone(response["errorCode"])
        self.assertIsNone(response["errorScope"])
        self.assertIsNone(response["phase"])
        self.assertEqual(response["gpu"], mock_gpu_result)
        self.assertEqual(response["acceleratorAvailability"], "available")

    def test_probe_host_timeout_does_not_affect_host_status(self):
        fake_boot_id = "boot-id-timeout-test"
        timeout_gpu_result = {
            "status": "unavailable",
            "observedAt": None,
            "csv": None,
            "errorCode": "NVIDIA_SMI_TIMEOUT",
        }
        with mock.patch("builtins.open", mock.mock_open(read_data=fake_boot_id + "\n")), \
             mock.patch.object(probe, "_query_linux_gpu", return_value=timeout_gpu_result):
            response = probe._dispatch({"op": "probe_host"})

        self.assertEqual(response["hostBootId"], fake_boot_id)
        self.assertIs(response["scanComplete"], True)
        self.assertIsNone(response["errorCode"])
        self.assertIsNone(response["errorScope"])
        self.assertIsNone(response["phase"])
        self.assertEqual(response["gpu"]["status"], "unavailable")
        self.assertEqual(response["gpu"]["errorCode"], "NVIDIA_SMI_TIMEOUT")

    def test_probe_host_missing_tool_does_not_affect_host_status(self):
        fake_boot_id = "boot-id-missing-tool-test"
        missing_gpu_result = {
            "status": "unavailable",
            "observedAt": None,
            "csv": None,
            "errorCode": "NVIDIA_SMI_UNAVAILABLE",
        }
        with mock.patch("builtins.open", mock.mock_open(read_data=fake_boot_id + "\n")), \
             mock.patch.object(probe, "_query_linux_gpu", return_value=missing_gpu_result):
            response = probe._dispatch({"op": "probe_host"})

        self.assertEqual(response["hostBootId"], fake_boot_id)
        self.assertIs(response["scanComplete"], True)
        self.assertIsNone(response["errorCode"])
        self.assertIsNone(response["errorScope"])
        self.assertIsNone(response["phase"])
        self.assertEqual(response["gpu"]["status"], "unavailable")
        self.assertEqual(response["gpu"]["errorCode"], "NVIDIA_SMI_UNAVAILABLE")

    def test_probe_host_nonzero_exit_does_not_affect_host_status(self):
        fake_boot_id = "boot-id-nonzero-exit-test"
        failed_gpu_result = {
            "status": "unavailable",
            "observedAt": None,
            "csv": None,
            "errorCode": "NVIDIA_SMI_FAILED",
        }
        with mock.patch("builtins.open", mock.mock_open(read_data=fake_boot_id + "\n")), \
             mock.patch.object(probe, "_query_linux_gpu", return_value=failed_gpu_result):
            response = probe._dispatch({"op": "probe_host"})

        self.assertEqual(response["hostBootId"], fake_boot_id)
        self.assertIs(response["scanComplete"], True)
        self.assertIsNone(response["errorCode"])
        self.assertIsNone(response["errorScope"])
        self.assertIsNone(response["phase"])
        self.assertEqual(response["gpu"]["status"], "unavailable")
        self.assertEqual(response["gpu"]["errorCode"], "NVIDIA_SMI_FAILED")

    def test_probe_host_skips_gpu_when_include_gpu_is_false(self):
        fake_boot_id = "boot-id-skip-test"
        with mock.patch("builtins.open", mock.mock_open(read_data=fake_boot_id + "\n")), \
             mock.patch.object(probe, "_query_linux_gpu") as mock_gpu_query:
            response = probe._dispatch({"op": "probe_host", "includeGpu": False})

        mock_gpu_query.assert_not_called()
        self.assertEqual(response["hostBootId"], fake_boot_id)
        self.assertIs(response["scanComplete"], True)
        self.assertIsNone(response["errorCode"])
        self.assertIsNone(response["errorScope"])
        self.assertIsNone(response["phase"])
        self.assertEqual(response["gpu"], {
            "status": "skipped",
            "observedAt": None,
            "csv": None,
            "errorCode": None,
        })

    def test_probe_host_queries_gpu_when_include_gpu_is_true(self):
        fake_boot_id = "boot-id-explicit-true-test"
        mock_gpu_result = {"status": "ok", "observedAt": 1000, "csv": "0, GPU, 0, 0, 0\n", "errorCode": None}
        with mock.patch("builtins.open", mock.mock_open(read_data=fake_boot_id + "\n")), \
             mock.patch.object(probe, "_query_linux_gpu", return_value=mock_gpu_result) as mock_gpu_query:
            response = probe._dispatch({"op": "probe_host", "includeGpu": True})

        mock_gpu_query.assert_called_once()
        self.assertEqual(response["gpu"], mock_gpu_result)

    def test_probe_host_queries_gpu_when_include_gpu_omitted(self):
        fake_boot_id = "boot-id-default-true-test"
        mock_gpu_result = {"status": "ok", "observedAt": 2000, "csv": "0, GPU, 0, 0, 0\n", "errorCode": None}
        with mock.patch("builtins.open", mock.mock_open(read_data=fake_boot_id + "\n")), \
             mock.patch.object(probe, "_query_linux_gpu", return_value=mock_gpu_result) as mock_gpu_query:
            response = probe._dispatch({"op": "probe_host"})

        mock_gpu_query.assert_called_once()
        self.assertEqual(response["gpu"], mock_gpu_result)

    def test_probe_host_failure_does_not_call_gpu_query(self):
        with mock.patch("builtins.open", side_effect=OSError("Cannot read /proc/sys/kernel/random/boot_id")), \
             mock.patch.object(probe, "_query_linux_gpu") as mock_gpu_query:
            response = probe._dispatch({"op": "probe_host"})

        mock_gpu_query.assert_not_called()
        self.assertIsNone(response["hostBootId"])
        self.assertIs(response["scanComplete"], False)
        self.assertEqual(response["errorCode"], "HOST_IDENTITY_UNAVAILABLE")
        self.assertEqual(response["errorScope"], "host")
        self.assertEqual(response["phase"], "probe")
        self.assertNotIn("gpu", response)

    def test_main_envelope_probe_host_with_skipped_gpu(self):
        request_payload = {
            "version": 1,
            "requestId": "req-skip-123",
            "sourceId": None,
            "op": "probe_host",
            "includeGpu": False,
        }
        req_b64 = base64.b64encode(json.dumps(request_payload).encode("utf-8")).decode("ascii")
        fake_boot_id = "boot-id-main-test"
        stdout_buffer = io.BytesIO()

        with mock.patch.object(probe, "REQUEST_B64", req_b64), \
             mock.patch("builtins.open", mock.mock_open(read_data=fake_boot_id + "\n")), \
             mock.patch.object(probe.sys, "stdout", types.SimpleNamespace(buffer=stdout_buffer)):
            exit_code = probe.main()

        self.assertEqual(exit_code, 0)
        output_bytes = stdout_buffer.getvalue()
        self.assertEqual(output_bytes[:4], b"TMF1")
        frame_len = struct.unpack(">I", output_bytes[4:8])[0]
        frame_json = json.loads(output_bytes[8:8 + frame_len].decode("utf-8"))

        self.assertEqual(frame_json["version"], 1)
        self.assertEqual(frame_json["requestId"], "req-skip-123")
        payload = frame_json["payload"]
        self.assertEqual(payload["hostBootId"], fake_boot_id)
        self.assertEqual(payload["gpu"]["status"], "skipped")
        self.assertIsNone(payload["gpu"]["errorCode"])

    def test_serve_mode_handles_multiple_requests_and_shutdown(self):
        req1 = json.dumps({"version": 1, "requestId": "r1", "sourceId": None, "op": "probe_host", "includeGpu": False}).encode("utf-8")
        req2 = json.dumps({"version": 1, "requestId": "r2", "sourceId": None, "op": "shutdown"}).encode("utf-8")
        stdin_bytes = b"banner noise\n" + b"TMF1" + struct.pack(">I", len(req1)) + req1 + b"TMF1" + struct.pack(">I", len(req2)) + req2
        stdin_buf = io.BytesIO(stdin_bytes)
        stdout_buf = io.BytesIO()

        with mock.patch("builtins.open", mock.mock_open(read_data="serve-boot-id\n")), \
             mock.patch.object(probe.sys, "stdin", types.SimpleNamespace(buffer=stdin_buf)), \
             mock.patch.object(probe.sys, "stdout", types.SimpleNamespace(buffer=stdout_buf)), \
             mock.patch.object(probe.sys, "argv", ["readonly_probe.py", "--serve"]):
            exit_code = probe.main()

        self.assertEqual(exit_code, 0)
        out = stdout_buf.getvalue()
        frames = []
        offset = 0
        while offset < len(out):
            self.assertEqual(out[offset:offset + 4], b"TMF1")
            size = struct.unpack(">I", out[offset + 4:offset + 8])[0]
            frames.append(json.loads(out[offset + 8:offset + 8 + size].decode("utf-8")))
            offset += 8 + size
        self.assertEqual([f["requestId"] for f in frames], ["r1", "r2"])
        self.assertEqual(frames[0]["payload"]["hostBootId"], "serve-boot-id")
        self.assertEqual(frames[1]["payload"], {"shutdown": True})

    def test_process_gpu_utilization_tolerates_clock_skew_within_2s(self):
        now_us = 1_700_000_000_000_000
        uptime_us = 100_000_000
        candidates = {42: {"hostBootId": "b", "pid": 42, "startTicks": "100"}}
        device_map = {"GPU-1": "GPU 0"}
        pairs = {(42, "GPU 0"): 1024}
        with mock.patch.object(probe.time, "time_ns", return_value=now_us * 1000), \
             mock.patch.object(probe.time, "clock_gettime_ns", return_value=uptime_us * 1000), \
             mock.patch.object(probe.os, "sysconf", return_value=100), \
             mock.patch.object(probe, "_nvml_process_samples", return_value=[(42, "GPU 0", now_us + 1_500_000, 77)]):
            util = probe._process_gpu_utilization(candidates, device_map, pairs)
        self.assertEqual(util, {(42, "GPU 0"): 77})


if __name__ == "__main__":
    unittest.main()
