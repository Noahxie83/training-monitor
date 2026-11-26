import importlib.util
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest import mock


MODULE_PATH = Path(__file__).parents[2] / "src" / "probe" / "readonly_probe.py"
SPEC = importlib.util.spec_from_file_location("readonly_probe_phase2", MODULE_PATH)
probe = importlib.util.module_from_spec(SPEC)
assert SPEC and SPEC.loader
SPEC.loader.exec_module(probe)


def _write_fake_proc(
    proc_root: Path,
    pid: int,
    *,
    ppid: int,
    pgid: int,
    uid: int,
    cwd: Path,
    argv: list[str],
    fds: dict[int, Path],
    start_ticks: str = "12345",
    comm: str = "python3",
    rss_pages: int = 256,
    utime: int = 100,
    stime: int = 20,
    nspid: int | None = None,
):
    pdir = proc_root / str(pid)
    (pdir / "fd").mkdir(parents=True)
    (pdir / "fdinfo").mkdir(parents=True)
    # /proc/<pid>/stat: pid (comm) state ppid pgrp session tty_nr tpgid flags minflt cminflt majflt cmajflt utime stime cutime cstime priority nice num_threads itrealvalue starttime vsize rss ...
    fields = ["0"] * 24
    fields[0] = "R"          # state (index 0 after comm)
    fields[1] = str(ppid)    # ppid
    fields[2] = str(pgid)    # pgrp
    fields[11] = str(utime)  # utime
    fields[12] = str(stime)  # stime
    fields[19] = start_ticks # starttime
    fields[21] = str(rss_pages)
    (pdir / "stat").write_text(f"{pid} ({comm}) " + " ".join(fields) + "\n", encoding="ascii")
    status_lines = [f"Uid:\t{uid}\t{uid}\t{uid}\t{uid}", f"VmRSS:\t{rss_pages * 4} kB"]
    if nspid is not None:
        status_lines.append(f"NSpid:\t{pid}\t{nspid}")
    (pdir / "status").write_text("\n".join(status_lines) + "\n", encoding="ascii")
    (pdir / "cmdline").write_bytes(b"\x00".join(a.encode("utf-8") for a in argv) + b"\x00")
    os.symlink(str(cwd), pdir / "cwd")
    os.symlink("/usr/bin/python3", pdir / "exe")
    for fd_num, target in fds.items():
        os.symlink(str(target), pdir / "fd" / str(fd_num))
        # Write-capable fdinfo flags (O_WRONLY | O_APPEND = 0102001)
        (pdir / "fdinfo" / str(fd_num)).write_text("pos:\t0\nflags:\t0102001\n", encoding="ascii")
    return pdir


def _init_fake_proc_root(proc_root: Path, boot_id: str = "boot-phase2"):
    (proc_root / "sys" / "kernel" / "random").mkdir(parents=True)
    (proc_root / "sys" / "kernel" / "random" / "boot_id").write_text(boot_id + "\n", encoding="ascii")
    (proc_root / "uptime").write_text("1000.00 500.00\n", encoding="ascii")
    (proc_root / "stat").write_text("cpu  1000 0 200 8800 0 0 0 0 0 0\n", encoding="ascii")
    (proc_root / "meminfo").write_text(
        "MemTotal:       65536000 kB\nMemAvailable:   32768000 kB\n", encoding="ascii"
    )


class Phase2ProbeTests(unittest.TestCase):
    def test_ddp_multiprocess_tree_aggregation(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            proc = root / "proc"
            _init_fake_proc_root(proc)
            task_dir = root / "workspace" / "exp1"
            task_dir.mkdir(parents=True)
            train_py = task_dir / "train.py"
            train_py.write_text("# train\n", encoding="utf-8")
            log_file = task_dir / "train.log"
            log_file.write_text("step=10 loss=0.5\n", encoding="utf-8")
            uid = os.getuid() if hasattr(os, "getuid") else 1000

            # Parent torchrun + 2 DDP rank workers in same PGID sharing log FD
            _write_fake_proc(
                proc, 100, ppid=1, pgid=100, uid=uid, cwd=task_dir,
                argv=["/usr/bin/python3", "/usr/bin/torchrun", "--nproc_per_node=2", "train.py"],
                fds={1: log_file}, start_ticks="1000",
            )
            _write_fake_proc(
                proc, 101, ppid=100, pgid=100, uid=uid, cwd=task_dir,
                argv=["/usr/bin/python3", "train.py", "--local-rank=0"],
                fds={1: log_file}, start_ticks="1010", rss_pages=1024,
            )
            _write_fake_proc(
                proc, 102, ppid=100, pgid=100, uid=uid, cwd=task_dir,
                argv=["/usr/bin/python3", "train.py", "--local-rank=1"],
                fds={1: log_file}, start_ticks="1020", rss_pages=1024,
            )

            res = probe._dispatch({
                "op": "probe_task",
                "proc": {"root": str(proc)},
                "task": {
                    "hostAllowedRoots": [str(root / "workspace")],
                    "allowedDirectories": [str(task_dir)],
                    "entryPaths": ["train.py"],
                    "sources": [{"sourceId": "log", "kind": "log", "path": str(log_file)}],
                },
            })
            self.assertTrue(res["scanComplete"])
            self.assertIsNone(res["errorCode"])
            pids = {p["processKey"]["pid"] for p in res["processes"]}
            self.assertEqual(pids, {100, 101, 102})
            for p in res["processes"]:
                self.assertEqual(p["pgid"], 100)
                self.assertIn("log", p["writerSourceIds"])

    def test_over_200_open_fds_does_not_fail_scan(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            proc = root / "proc"
            _init_fake_proc_root(proc)
            task_dir = root / "workspace"
            task_dir.mkdir(parents=True)
            train_py = task_dir / "train.py"
            train_py.write_text("# train\n", encoding="utf-8")
            log_file = task_dir / "train.log"
            log_file.write_text("Epoch 1/10 loss=0.4\n", encoding="utf-8")
            dummy = task_dir / "shard.bin"
            dummy.write_bytes(b"0")
            uid = os.getuid() if hasattr(os, "getuid") else 1000

            fds = {i: dummy for i in range(3, 240)}
            fds[240] = log_file
            _write_fake_proc(
                proc, 200, ppid=1, pgid=200, uid=uid, cwd=task_dir,
                argv=["/usr/bin/python3", "train.py"],
                fds=fds, start_ticks="2000",
            )
            res = probe._dispatch({
                "op": "probe_task",
                "proc": {"root": str(proc)},
                "task": {
                    "hostAllowedRoots": [str(task_dir)],
                    "allowedDirectories": [str(task_dir)],
                    "entryPaths": ["train.py"],
                    "sources": [{"sourceId": "log", "kind": "log", "path": str(log_file)}],
                },
            })
            self.assertTrue(res["scanComplete"])
            self.assertIsNone(res["errorCode"])
            self.assertEqual(len(res["processes"]), 1)
            self.assertFalse(res["processes"][0].get("fdScanTruncated", False))
            self.assertIn("log", res["processes"][0]["writerSourceIds"])

    def test_growing_log_during_scan_does_not_trigger_eof_race(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            proc = root / "proc"
            _init_fake_proc_root(proc)
            task_dir = root / "workspace"
            task_dir.mkdir(parents=True)
            train_py = task_dir / "train.py"
            train_py.write_text("# train\n", encoding="utf-8")
            log_file = task_dir / "train.log"
            log_file.write_text("line 1\n", encoding="utf-8")
            uid = os.getuid() if hasattr(os, "getuid") else 1000

            _write_fake_proc(
                proc, 300, ppid=1, pgid=300, uid=uid, cwd=task_dir,
                argv=["/usr/bin/python3", "train.py"],
                fds={1: log_file}, start_ticks="3000",
            )

            real_stat = os.stat
            calls = {"count": 0}

            def growing_stat(path, *args, **kwargs):
                st = real_stat(path, *args, **kwargs)
                if os.path.realpath(str(path)) == os.path.realpath(str(log_file)):
                    calls["count"] += 1
                    if calls["count"] == 2:
                        # Append bytes between initial source stat and FD inspection!
                        with open(log_file, "a", encoding="utf-8") as fh:
                            fh.write("line 2 appended concurrently during scan\n")
                        return real_stat(path, *args, **kwargs)
                return st

            with mock.patch("os.stat", side_effect=growing_stat):
                res = probe._dispatch({
                    "op": "probe_task",
                    "proc": {"root": str(proc)},
                    "task": {
                        "hostAllowedRoots": [str(task_dir)],
                        "allowedDirectories": [str(task_dir)],
                        "entryPaths": ["train.py"],
                        "sources": [{"sourceId": "log", "kind": "log", "path": str(log_file)}],
                    },
                })
            self.assertTrue(res["scanComplete"])
            self.assertIsNone(res["errorCode"])
            self.assertEqual(len(res["processes"]), 1)
            proc_obs = res["processes"][0]
            self.assertTrue(proc_obs["writerEvidenceComplete"])
            self.assertIn("log", proc_obs["writerSourceIds"])

    def test_python_module_torchrun_and_tee_pipeline_matching(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            proc = root / "proc"
            _init_fake_proc_root(proc)
            task_dir = root / "workspace"
            task_dir.mkdir(parents=True)
            log_file = task_dir / "train.log"
            log_file.write_text("step=1 loss=1.0\n", encoding="utf-8")
            uid = os.getuid() if hasattr(os, "getuid") else 1000

            # python -u -m mypkg.train piped to `tee train.log` in same PGID!
            _write_fake_proc(
                proc, 401, ppid=400, pgid=400, uid=uid, cwd=task_dir,
                argv=["/usr/bin/python3", "-u", "-m", "mypkg.train", "--epochs", "5"],
                fds={}, start_ticks="4010",
            )
            _write_fake_proc(
                proc, 402, ppid=400, pgid=400, uid=uid, cwd=task_dir,
                argv=["/usr/bin/tee", "-a", str(log_file)],
                fds={3: log_file}, start_ticks="4020", comm="tee",
            )

            res = probe._dispatch({
                "op": "probe_task",
                "proc": {"root": str(proc)},
                "task": {
                    "hostAllowedRoots": [str(task_dir)],
                    "allowedDirectories": [str(task_dir)],
                    "entryPaths": ["module:mypkg.train"],
                    "sources": [{"sourceId": "log", "kind": "log", "path": str(log_file)}],
                },
            })
            self.assertTrue(res["scanComplete"])
            self.assertGreaterEqual(len(res["processes"]), 1)
            p = next(item for item in res["processes"] if item["processKey"]["pid"] == 401)
            self.assertEqual(p["scriptEntry"], "module:mypkg.train")
            self.assertIn("log", p["writerSourceIds"])
            self.assertEqual(p["roleEvidence"], "exact_entry_and_direct_writer_fd")

    def test_symlink_latest_log_inside_root_accepted_and_out_of_root_rejected(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            allowed = root / "allowed"
            outside = root / "outside"
            allowed.mkdir()
            outside.mkdir()
            real_log = allowed / "run_001.log"
            real_log.write_text("hello inside\n", encoding="utf-8")
            secret = outside / "secret.log"
            secret.write_text("secret\n", encoding="utf-8")

            in_link = allowed / "latest.log"
            os.symlink(str(real_log), in_link)
            out_link = allowed / "escape.log"
            os.symlink(str(secret), out_link)

            ok = probe.open_readonly(str(in_link), [str(allowed)], [str(allowed)], limit_bytes=1024)
            self.assertEqual(ok["status"], "ok")
            self.assertEqual(ok["data"], b"hello inside\n")

            denied = probe.open_readonly(str(out_link), [str(allowed)], [str(allowed)], limit_bytes=1024)
            self.assertNotEqual(denied["status"], "ok")
            self.assertIn(denied["errorCode"], {"PATH_OUTSIDE_TASK_ROOT", "PATH_OUTSIDE_ALLOWED_ROOT", "PATH_OUTSIDE_ALLOWED_ROOTS", "SYMLINK_OUTSIDE_ROOT", "SOURCE_PERMISSION"})

    def test_directory_and_sharded_checkpoint_scanning(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            ckpt_root = root / "outputs"
            ckpt_root.mkdir()
            # HuggingFace checkpoint directory with trainer_state.json + safetensors shards
            hf_dir = ckpt_root / "checkpoint-1500"
            hf_dir.mkdir()
            (hf_dir / "model-00001-of-00002.safetensors").write_bytes(b"a" * 1024)
            (hf_dir / "model-00002-of-00002.safetensors").write_bytes(b"b" * 2048)
            (hf_dir / "trainer_state.json").write_text(
                json.dumps({"global_step": 1500, "epoch": 3.0, "best_metric": 0.42}),
                encoding="utf-8",
            )
            os.utime(hf_dir, (1700000100, 1700000100))

            res = probe.scan_checkpoints([str(ckpt_root)], [str(root)], [str(root)])
            self.assertTrue(res["scanComplete"])
            latest = res["checkpoint"]
            self.assertIsNotNone(latest)
            self.assertEqual(latest["name"], "checkpoint-1500")
            self.assertTrue(latest["isDirectory"])
            self.assertEqual(latest["fileCount"], 3)
            self.assertEqual(latest["fileStepIndex"], 1500)
            self.assertEqual(latest["stepSource"], "metadata")
            self.assertGreaterEqual(int(latest["sizeBytes"]), 3072)

    def test_discover_processes_rpc(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            proc = root / "proc"
            _init_fake_proc_root(proc)
            task_dir = root / "proj"
            task_dir.mkdir()
            log_file = task_dir / "train.log"
            log_file.write_text("epoch 1\n", encoding="utf-8")
            uid = os.getuid() if hasattr(os, "getuid") else 1000

            _write_fake_proc(
                proc, 555, ppid=1, pgid=555, uid=uid, cwd=task_dir,
                argv=["/usr/bin/python3", "train_llm.py", "--lr", "1e-4"],
                fds={1: log_file}, start_ticks="5550",
            )
            # Basic GPU CSV order: index,uuid,utilization.gpu,memory.used,memory.total
            gpu_csv = "0, GPU-aaaa, 85, 42000, 81920\n"
            apps_csv = "555, GPU-aaaa, 41500\n"
            with mock.patch.object(probe, "_find_nvidia_smi", return_value="/usr/bin/nvidia-smi"), \
                 mock.patch.object(probe, "_run_bounded_command", side_effect=[
                     (gpu_csv.encode("utf-8"), None),
                     (apps_csv.encode("utf-8"), None),
                 ]):
                res = probe._dispatch({"op": "discover_processes", "proc": {"root": str(proc)}})
            self.assertIsNone(res["errorCode"])
            procs = res["processes"]
            self.assertEqual(len(procs), 1)
            item = procs[0]
            self.assertEqual(item["pid"], 555)
            self.assertEqual(item["pgid"], 555)
            self.assertEqual(item["gpuIndices"], [0])
            self.assertEqual(item["gpuMemoryMiB"], 41500.0)
            self.assertIn(str(log_file), item["openLogPaths"])
            self.assertEqual(item["suggestedEntry"], "train_llm.py")

    def test_host_system_health_and_rich_gpu_telemetry(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            proc = root / "proc"
            _init_fake_proc_root(proc)
            # Exact rich GPU CSV order:
            # index,uuid,utilization.gpu,memory.used,memory.total,memory.free,name,temperature.gpu,power.draw,power.limit,fan.speed,pci.bus_id,compute_mode,ecc
            rich_gpu_csv = (
                "0, GPU-1111, 92, 61440, 81920, 20480, NVIDIA H100 80GB HBM3, 68, 512.3, 700.0, 60, 00000000:1B:00.0, Default, 0\n"
            )
            apps_csv = "999, GPU-1111, 60000\n"
            with mock.patch.object(probe, "_find_nvidia_smi", return_value="/usr/bin/nvidia-smi"), \
                 mock.patch.object(probe, "_run_bounded_command", side_effect=[
                     (rich_gpu_csv.encode("utf-8"), None),
                     (apps_csv.encode("utf-8"), None),
                 ]):
                res = probe._dispatch({
                    "op": "probe_host",
                    "proc": {"root": str(proc)},
                    "diskPaths": [str(root)],
                    "richGpu": True,
                })
            self.assertTrue(res["scanComplete"])
            self.assertIn("system", res)
            sys_info = res["system"]
            self.assertGreater(int(sys_info["memoryTotalBytes"]), 0)
            self.assertGreaterEqual(len(sys_info["disks"]), 1)
            gpu = res["gpu"]
            self.assertEqual(gpu["status"], "ok")
            self.assertEqual(len(gpu["devices"]), 1)
            dev = gpu["devices"][0]
            self.assertEqual(dev["name"], "NVIDIA H100 80GB HBM3")
            self.assertEqual(dev["temperatureC"], 68.0)
            self.assertAlmostEqual(dev["powerDrawW"], 512.3)
            self.assertEqual(dev["activeProcesses"][0]["pid"], 999)


if __name__ == "__main__":
    unittest.main()
