import base64
import importlib.util
import io
import json
import os
from pathlib import Path
import struct
import subprocess
import types
import unittest
from unittest import mock

MODULE_PATH = Path(__file__).parents[2] / "src" / "probe" / "readonly_probe.py"
SPEC = importlib.util.spec_from_file_location("readonly_probe", MODULE_PATH)
probe = importlib.util.module_from_spec(SPEC)
assert SPEC and SPEC.loader
SPEC.loader.exec_module(probe)


class GpuProbeTests(unittest.TestCase):
    """Mock-based unit tests for GPU aggregate querying, timeouts, fault isolation, and skipping."""

    def test_query_linux_gpu_exact_command_arguments_and_device_metrics_only(self):
        completed = types.SimpleNamespace(
            returncode=0,
            stdout=b"0, GPU-mock-uuid-1, 15, 2048, 8192\n",
            stderr=b"",
        )
        with mock.patch.object(probe.shutil, "which", return_value="/usr/local/bin/nvidia-smi"), \
             mock.patch.object(probe.subprocess, "run", return_value=completed) as mock_run:
            result = probe._query_linux_gpu()

        self.assertEqual(result["status"], "ok")
        self.assertIsNone(result["errorCode"])
        self.assertEqual(result["csv"], "0, GPU-mock-uuid-1, 15, 2048, 8192\n")
        self.assertIsInstance(result["observedAt"], int)

        mock_run.assert_called_once()
        called_args, called_kwargs = mock_run.call_args
        cmd = called_args[0]

        self.assertEqual(cmd, [
            "/usr/local/bin/nvidia-smi",
            "--query-gpu=index,uuid,utilization.gpu,memory.used,memory.total",
            "--format=csv,noheader,nounits",
        ])
        self.assertEqual(called_kwargs.get("timeout"), 2)
        self.assertIs(called_kwargs.get("capture_output"), True)
        self.assertIs(called_kwargs.get("check"), False)

        full_cmd_str = " ".join(cmd)
        self.assertNotIn("compute-apps", full_cmd_str)
        self.assertNotIn("pid", full_cmd_str)
        self.assertNotIn("process_name", full_cmd_str)
        self.assertNotIn("used_memory", full_cmd_str)
        self.assertNotIn("user", full_cmd_str)

    def test_query_linux_gpu_executable_fallback_to_default_path(self):
        completed = types.SimpleNamespace(returncode=0, stdout=b"0, GPU-1, 0, 0, 8192\n", stderr=b"")
        with mock.patch.object(probe.shutil, "which", return_value=None), \
             mock.patch.object(probe.subprocess, "run", return_value=completed) as mock_run:
            result = probe._query_linux_gpu()

        self.assertEqual(result["status"], "ok")
        self.assertEqual(mock_run.call_args.args[0][0], "/usr/bin/nvidia-smi")

    def test_query_linux_gpu_multi_gpu_csv_parsing(self):
        stdout_data = (
            b"0, GPU-aaaa-1111, 45, 8192, 24576\n"
            b"1, GPU-bbbb-2222, 0, 1024, 24576\n"
            b"2, GPU-cccc-3333, 98, 23000, 24576\n"
        )
        completed = types.SimpleNamespace(returncode=0, stdout=stdout_data, stderr=b"")
        with mock.patch.object(probe.shutil, "which", return_value="/usr/bin/nvidia-smi"), \
             mock.patch.object(probe.subprocess, "run", return_value=completed):
            result = probe._query_linux_gpu()

        self.assertEqual(result["status"], "ok")
        self.assertEqual(result["csv"], stdout_data.decode("utf-8"))
        self.assertIsNone(result["errorCode"])
        self.assertIsInstance(result["observedAt"], int)

    def test_query_linux_gpu_replaces_invalid_utf8_safely(self):
        completed = types.SimpleNamespace(returncode=0, stdout=b"0, GPU-1, 0, 0, 8192\n\xff\xfe", stderr=b"")
        with mock.patch.object(probe.shutil, "which", return_value="/usr/bin/nvidia-smi"), \
             mock.patch.object(probe.subprocess, "run", return_value=completed):
            result = probe._query_linux_gpu()

        self.assertEqual(result["status"], "ok")
        self.assertIn("0, GPU-1, 0, 0, 8192\n", result["csv"])
        self.assertIn("\ufffd", result["csv"])

    def test_query_linux_gpu_2s_timeout_returns_timeout_code(self):
        with mock.patch.object(probe.shutil, "which", return_value="/usr/bin/nvidia-smi"), \
             mock.patch.object(
                 probe.subprocess,
                 "run",
                 side_effect=subprocess.TimeoutExpired(cmd=["nvidia-smi"], timeout=2),
             ) as mock_run:
            result = probe._query_linux_gpu()

        self.assertEqual(result, {
            "status": "unavailable",
            "observedAt": None,
            "csv": None,
            "errorCode": "NVIDIA_SMI_TIMEOUT",
        })
        self.assertEqual(mock_run.call_args.kwargs.get("timeout"), 2)

    def test_query_linux_gpu_missing_tool_oserror_returns_unavailable(self):
        with mock.patch.object(probe.shutil, "which", return_value="/usr/bin/nvidia-smi"), \
             mock.patch.object(probe.subprocess, "run", side_effect=FileNotFoundError("Tool not found")):
            result = probe._query_linux_gpu()

        self.assertEqual(result, {
            "status": "unavailable",
            "observedAt": None,
            "csv": None,
            "errorCode": "NVIDIA_SMI_UNAVAILABLE",
        })

    def test_query_linux_gpu_permission_oserror_returns_unavailable(self):
        with mock.patch.object(probe.shutil, "which", return_value="/usr/bin/nvidia-smi"), \
             mock.patch.object(probe.subprocess, "run", side_effect=PermissionError("Permission denied")):
            result = probe._query_linux_gpu()

        self.assertEqual(result, {
            "status": "unavailable",
            "observedAt": None,
            "csv": None,
            "errorCode": "NVIDIA_SMI_UNAVAILABLE",
        })

    def test_query_linux_gpu_nonzero_exit_code_returns_failed(self):
        completed = types.SimpleNamespace(
            returncode=1,
            stdout=b"",
            stderr=b"NVIDIA-SMI has failed because it couldn't communicate with the driver",
        )
        with mock.patch.object(probe.shutil, "which", return_value="/usr/bin/nvidia-smi"), \
             mock.patch.object(probe.subprocess, "run", return_value=completed):
            result = probe._query_linux_gpu()

        self.assertEqual(result, {
            "status": "unavailable",
            "observedAt": None,
            "csv": None,
            "errorCode": "NVIDIA_SMI_FAILED",
        })

    def test_query_linux_gpu_response_exceeds_16kb_returns_response_limit(self):
        oversized_stdout = b"0, GPU-x, 0, 0, 8192\n" * 1000
        self.assertGreater(len(oversized_stdout), 16 * 1024)
        completed = types.SimpleNamespace(returncode=0, stdout=oversized_stdout, stderr=b"")
        with mock.patch.object(probe.shutil, "which", return_value="/usr/bin/nvidia-smi"), \
             mock.patch.object(probe.subprocess, "run", return_value=completed):
            result = probe._query_linux_gpu()

        self.assertEqual(result, {
            "status": "unavailable",
            "observedAt": None,
            "csv": None,
            "errorCode": "NVIDIA_SMI_RESPONSE_LIMIT",
        })

    def test_query_linux_gpu_response_exactly_at_16kb_limit_succeeds(self):
        exact_stdout = b"a" * (16 * 1024)
        completed = types.SimpleNamespace(returncode=0, stdout=exact_stdout, stderr=b"")
        with mock.patch.object(probe.shutil, "which", return_value="/usr/bin/nvidia-smi"), \
             mock.patch.object(probe.subprocess, "run", return_value=completed):
            result = probe._query_linux_gpu()

        self.assertEqual(result["status"], "ok")
        self.assertIsNone(result["errorCode"])
        self.assertEqual(len(result["csv"]), 16 * 1024)

    def test_probe_host_with_gpu_success_maintains_host_identity(self):
        fake_boot_id = "11223344-5566-7788-99aa-bbccddeeff00"
        mock_gpu_result = {
            "status": "ok",
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
        self.assertGreaterEqual(len(output_bytes), 4)
        frame_len = struct.unpack(">I", output_bytes[:4])[0]
        frame_json = json.loads(output_bytes[4:4 + frame_len].decode("utf-8"))

        self.assertEqual(frame_json["version"], 1)
        self.assertEqual(frame_json["requestId"], "req-skip-123")
        payload = frame_json["payload"]
        self.assertEqual(payload["hostBootId"], fake_boot_id)
        self.assertEqual(payload["gpu"]["status"], "skipped")
        self.assertIsNone(payload["gpu"]["errorCode"])


if __name__ == "__main__":
    unittest.main()
