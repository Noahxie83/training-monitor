import importlib.util
import os
from pathlib import Path
import tempfile
import types
import unittest
from unittest import mock


MODULE_PATH = Path(__file__).parents[2] / "src" / "probe" / "readonly_probe.py"
SPEC = importlib.util.spec_from_file_location("readonly_probe_process_gpu", MODULE_PATH)
probe = importlib.util.module_from_spec(SPEC)
assert SPEC and SPEC.loader
SPEC.loader.exec_module(probe)


def candidate(pid, start_ticks="100", *, evidence=True, role_evidence="exact_script_entry", script_entry="/registered/train.py"):
    return {
        "processKey": {"hostBootId": "boot-a", "pid": pid, "startTicks": start_ticks},
        "roleEvidence": role_evidence,
        "scriptEntry": script_entry,
        "evidenceComplete": evidence,
    }


class ProcessGpuProbeTests(unittest.TestCase):
    def sample(self, rows, csv=b"", query_error=None, *, owners=None, identities=None, utilization=None):
        owners = owners or {}
        identities = identities or {}
        owner_counts = {}
        identity_counts = {}

        def fake_stat(path, follow_symlinks=False):
            pid = int(os.path.basename(path))
            values = owners.get(pid, [1000])
            index = owner_counts.get(pid, 0)
            owner_counts[pid] = index + 1
            uid = values[min(index, len(values) - 1)]
            return types.SimpleNamespace(st_uid=uid)

        def fake_identity(_root, pid, boot_id):
            values = identities.get(pid, ["100"])
            index = identity_counts.get(pid, 0)
            identity_counts[pid] = index + 1
            return {"bootId": boot_id, "pid": pid, "startTicks": values[min(index, len(values) - 1)]}

        with mock.patch.object(probe.os, "getuid", return_value=1000, create=True), \
             mock.patch.object(probe.os, "stat", side_effect=fake_stat), \
             mock.patch.object(probe, "_proc_identity", side_effect=fake_identity), \
             mock.patch.object(probe, "_query_process_gpu_csv", return_value=(csv, query_error)) as query, \
             mock.patch.object(probe, "_process_gpu_utilization", return_value=utilization or {}), \
             mock.patch.object(probe.time, "time_ns", return_value=1_765_000_000_000_000_000):
            result = probe._sample_process_gpu("/fake-proc", "boot-a", rows, [
                {"uuid": "GPU-aaa", "index": 6},
                {"uuid": "GPU-bbb", "index": 0},
            ])
        return result, query

    def test_nvml_use_is_covered_by_a_final_pid_identity_check(self):
        result, _ = self.sample([candidate(101)], b"101, GPU-aaa, 8\n", utilization={(101, "GPU 6"): 74}, identities={101: ["100", "100", "200"]})
        self.assertEqual(result["samples"], [])
        self.assertEqual(result["processKeys"], [])

    def test_recent_nvml_samples_are_filtered_by_pid_lifetime_gpu_and_age(self):
        now_us = 1_000_000_000
        samples = [(101, "GPU 6", now_us - 100_000, 74), (101, "GPU 6", now_us - 200_000, 64),
                   (101, "GPU 6", now_us - 700_000, 99), (101, "GPU 6", now_us - 6_000_000, 99),
                   (999, "GPU 6", now_us - 100_000, 99), (101, "GPU 0", now_us - 100_000, 99)]
        with mock.patch.object(probe.time, "time_ns", return_value=now_us * 1000), \
             mock.patch.object(probe.time, "CLOCK_BOOTTIME", 7, create=True), \
             mock.patch.object(probe.time, "clock_gettime_ns", return_value=900_000_000_000, create=True), \
             mock.patch.object(probe.os, "sysconf", return_value=100, create=True), \
             mock.patch.object(probe, "_nvml_process_samples", return_value=samples):
            result = probe._process_gpu_utilization({101: candidate(101, "89950")["processKey"]}, {"GPU-aaa": "GPU 6"}, {(101, "GPU 6"): 1})
        self.assertEqual(result, {(101, "GPU 6"): 74})

    def test_nvml_unavailability_keeps_unknown_as_unknown(self):
        with mock.patch.object(probe.time, "CLOCK_BOOTTIME", 7, create=True), \
             mock.patch.object(probe.time, "clock_gettime_ns", return_value=900_000_000_000, create=True), \
             mock.patch.object(probe.os, "sysconf", return_value=100, create=True), \
             mock.patch.object(probe, "_nvml_process_samples", side_effect=OSError("unsupported")):
            self.assertEqual(probe._process_gpu_utilization({101: candidate(101)["processKey"]}, {"GPU-aaa": "GPU 6"}, {(101, "GPU 6"): 1}), {})

    def test_multiple_processes_and_gpus_filter_foreign_pid_and_deduplicate(self):
        rows = [candidate(101), candidate(102), candidate(103)]
        csv = (
            b"999, GPU-aaa, 777\n"  # unrelated PID is dropped
            b"101, GPU-aaa, 0\n"
            b"101, GPU-aaa, 0\n"  # duplicate does not increase memory
            b"101, GPU-bbb, 4\n"
            b"102, GPU-bbb, N/A\n"
        )
        result, query = self.sample(rows, csv)

        self.assertEqual(query.call_count, 1)
        self.assertEqual(result["status"], "ok")
        self.assertEqual(result["observedAt"], 1_765_000_000_000)
        self.assertEqual(result["errorCode"], None)
        self.assertEqual([key["pid"] for key in result["processKeys"]], [101, 102, 103])
        self.assertEqual(
            [(sample["processKey"]["pid"], sample["deviceId"], sample["memoryBytes"], sample["utilizationPercent"])
             for sample in result["samples"]],
            [(101, "GPU 0", 4 * 1024 * 1024, None),
             (101, "GPU 6", 0, None),
             (102, "GPU 0", None, None)],
        )
        for sample in result["samples"]:
            self.assertEqual(sample["processKey"], sample["keyBeforeSample"])
            self.assertEqual(sample["processKey"], sample["keyAfterSample"])
        self.assertNotIn(999, [key["pid"] for key in result["processKeys"]])

    def test_no_verified_targets_skips_nvidia_and_does_not_claim_process_keys(self):
        result, query = self.sample([
            candidate(101, evidence=False),
            candidate(102, role_evidence="none"),
            candidate(103, script_entry=None),
        ])
        self.assertEqual(result["status"], "unavailable")
        self.assertEqual(result["errorCode"], "NO_VERIFIED_PROCESS_CANDIDATES")
        self.assertEqual(result["samples"], [])
        self.assertEqual(result["processKeys"], [])
        query.assert_not_called()

    def test_empty_process_rows_is_ok_without_nvidia_call(self):
        result, query = self.sample([])
        self.assertEqual(result["status"], "ok")
        self.assertEqual(result["samples"], [])
        self.assertEqual(result["processKeys"], [])
        query.assert_not_called()

    def test_pid_reuse_between_sample_checks_discards_sample_and_process_key(self):
        result, query = self.sample([candidate(101)], b"101, GPU-aaa, 8\n", identities={101: ["100", "101"]})
        self.assertEqual(result["status"], "ok")
        self.assertEqual(result["samples"], [])
        self.assertEqual(result["processKeys"], [])
        query.assert_called_once()

    def test_owner_change_between_sample_checks_discards_sample_and_process_key(self):
        result, query = self.sample([candidate(101)], b"101, GPU-aaa, 8\n", owners={101: [1000, 2000]})
        self.assertEqual(result["status"], "ok")
        self.assertEqual(result["samples"], [])
        self.assertEqual(result["processKeys"], [])
        query.assert_called_once()

    def test_timeout_keeps_only_stable_checked_keys_and_returns_no_samples(self):
        result, _query = self.sample([candidate(101)], query_error="NVIDIA_SMI_TIMEOUT")
        self.assertEqual(result["status"], "unavailable")
        self.assertEqual(result["errorCode"], "NVIDIA_SMI_TIMEOUT")
        self.assertEqual(result["samples"], [])
        self.assertEqual(result["processKeys"], [candidate(101)["processKey"]])

    def test_unmapped_uuid_is_unavailable_without_returning_raw_row(self):
        result, _query = self.sample([candidate(101)], b"101, GPU-secret-unmapped, 9\n")
        self.assertEqual(result["status"], "unavailable")
        self.assertEqual(result["errorCode"], "GPU_DEVICE_UNMAPPED")
        self.assertEqual(result["samples"], [])
        self.assertNotIn("GPU-secret-unmapped", repr(result))
        self.assertNotIn("csv", result)

    def test_unsupported_query_is_isolated_and_has_no_stderr_or_csv_in_payload(self):
        result, _query = self.sample([candidate(101)], query_error="NVIDIA_SMI_UNAVAILABLE")
        self.assertEqual(result["status"], "unavailable")
        self.assertEqual(result["errorCode"], "NVIDIA_SMI_UNAVAILABLE")
        self.assertNotIn("stderr", repr(result).lower())

    def test_device_mapping_requires_unique_uuid_and_index_and_skips_command(self):
        rows = [candidate(101)]
        with mock.patch.object(probe.os, "getuid", return_value=1000, create=True), \
             mock.patch.object(probe, "_query_process_gpu_csv") as query:
            result = probe._sample_process_gpu("/fake-proc", "boot-a", rows, [
                {"uuid": "GPU-aaa", "index": 6}, {"uuid": "GPU-bbb", "index": 6},
            ])
        self.assertEqual(result["status"], "unavailable")
        self.assertEqual(result["errorCode"], "GPU_DEVICE_LIST_INVALID")
        query.assert_not_called()

    def test_query_uses_fixed_compute_apps_command_and_two_second_cap(self):
        with mock.patch.object(probe.shutil, "which", return_value="/usr/bin/nvidia-smi"), \
             mock.patch.object(probe, "_run_bounded_process_command", return_value=(b"", None)) as run:
            self.assertEqual(probe._query_process_gpu_csv(), (b"", None))
        self.assertEqual(run.call_args.args[0], "/usr/bin/nvidia-smi")
        self.assertEqual(run.call_args.args[1], ["--query-compute-apps=pid,gpu_uuid,used_gpu_memory", "--format=csv,noheader,nounits"])
        self.assertEqual(run.call_args.kwargs["timeout_seconds"], 2.0)

    def test_dispatch_opt_in_payload_failure_does_not_change_scan_or_logs(self):
        with tempfile.TemporaryDirectory() as directory:
            proc_root = Path(directory) / "proc"
            boot_file = proc_root / "sys" / "kernel" / "random" / "boot_id"
            boot_file.parent.mkdir(parents=True)
            boot_file.write_text("boot-a\n", encoding="ascii")
            scan = {
                "scanComplete": True,
                "errorCode": None,
                "candidates": [],
            }
            scan["candidates"] = [{
                "processKey": candidate(101)["processKey"],
                "role": "unknown", "writerSources": [], "writerSourceEvidence": {},
                "cwd": "/registered", "scriptEntry": "/registered/train.py",
                "interpreterFlags": [], "evidenceComplete": True,
                "writerEvidenceComplete": True,
            }]
            with mock.patch.object(probe, "scan_registered_processes", return_value=scan), \
                 mock.patch.object(probe.os, "getuid", return_value=1000, create=True), \
                 mock.patch.object(probe.os, "stat", return_value=types.SimpleNamespace(st_uid=1000)), \
                 mock.patch.object(probe, "_proc_identity", return_value={"bootId": "boot-a", "pid": 101, "startTicks": "100"}), \
                 mock.patch.object(probe, "_query_process_gpu_csv", return_value=(None, "NVIDIA_SMI_TIMEOUT")):
                payload = probe._dispatch({
                    "op": "probe_task", "proc": {"root": str(proc_root)}, "task": {"sources": []},
                    "includeProcessGpu": True, "gpuDevices": [{"uuid": "GPU-aaa", "index": 0}],
                })
            self.assertTrue(payload["scanComplete"])
            self.assertIsNone(payload["errorCode"])
            self.assertEqual(payload["processGpu"]["errorCode"], "NVIDIA_SMI_TIMEOUT")
            self.assertEqual(payload["processes"][0]["processKey"]["pid"], 101)
            self.assertEqual(payload["sources"], [])

    def test_dispatch_default_does_not_add_process_gpu_or_query_nvidia(self):
        with tempfile.TemporaryDirectory() as directory:
            proc_root = Path(directory) / "proc"
            boot_file = proc_root / "sys" / "kernel" / "random" / "boot_id"
            boot_file.parent.mkdir(parents=True)
            boot_file.write_text("boot-a\n", encoding="ascii")
            with mock.patch.object(probe, "scan_registered_processes", return_value={"scanComplete": True, "errorCode": None, "candidates": []}), \
                 mock.patch.object(probe, "_query_process_gpu_csv") as query:
                payload = probe._dispatch({"op": "probe_task", "proc": {"root": str(proc_root)}, "task": {"sources": []}})
            self.assertNotIn("processGpu", payload)
            query.assert_not_called()


if __name__ == "__main__":
    unittest.main()
