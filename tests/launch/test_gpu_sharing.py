"""Shared GPU admission, real lock limits and free-memory threshold tests."""
import importlib.util
import json
import os
from pathlib import Path
import tempfile
import unittest
from concurrent.futures import ThreadPoolExecutor
from unittest import mock

ROOT = Path(__file__).parents[2]


def load(name, relative):
    spec = importlib.util.spec_from_file_location(name, ROOT/relative)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


launcher = load('sharing_launcher', 'src/launch/launcher.py')
agent = load('sharing_agent', 'src/launch/server_agent.py')


class SharingTests(unittest.TestCase):
    def test_free_memory_allows_busy_gpu_and_requires_actual_free_8192(self):
        row = '1, GPU-abc, 99, 12000, 24564, 8192\n'
        self.assertTrue(agent._parse_gpu_csv(row,100,1024,8192)['GPU-abc']['idle'])
        self.assertFalse(agent._parse_gpu_csv(row.replace('8192','8191'),100,1024,8192)['GPU-abc']['idle'])
        self.assertTrue(agent._parse_gpu_csv(row.replace('8192','N/A'),100,1024,8192)['GPU-abc']['unavailable'])
        probe = mock.Mock()
        request = {'_gpuUuids':['GPU-abc'],'minFreeMemoryMiB':8192,'maxMemoryMiB':1024,'maxUtilizationPercent':100}
        probe._query_linux_gpu.return_value = {'status':'ok','csv':row}
        self.assertTrue(launcher._gpus_idle(probe, request))
        probe._query_linux_gpu.return_value = {'status':'ok','csv':row.replace('8192','8191')}
        self.assertFalse(launcher._gpus_idle(probe, request))

    def test_threshold_must_hold_for_60_seconds(self):
        state = agent._new_idle_state()
        for second in range(0,61,5):
            candidates = agent._update_idle_timers('1, GPU-abc, 100, 12000, 24564, 8192',100,1048576,second,state,8192)
        self.assertEqual(candidates[0]['elapsedSeconds'],60)
        self.assertEqual(agent._update_idle_timers('1, GPU-abc, 100, 12000, 24564, 8191',100,1048576,65,state,8192),[])
        self.assertEqual(agent._update_idle_timers('1, GPU-abc, 100, 12000, 24564, 8192',100,1048576,70,state,8192)[0]['elapsedSeconds'],0)

    @unittest.skipIf(launcher._fcntl is None, 'real Linux flock required')
    def test_two_per_gpu_three_devices_and_release(self):
        with tempfile.TemporaryDirectory() as directory:
            status = Path(directory)/'status.json'
            status.write_text(json.dumps({'pid':os.getpid(),'status':'running'}))
            handles=[]
            def acquire(gpu):
                req={'gpuSharing':{'groupId':'hdps','maxDevices':3,'maxWorkersPerDevice':2},'_gpuUuids':[gpu], 'sources':[{'path':str(status),'kind':'status_json'}]}
                h=launcher._acquire_shared_gpu_locks(directory,req)
                path=Path(req['_sharingSlotPath']);d=json.loads(path.read_text());d['pid']=os.getpid();path.write_text(json.dumps(d))
                handles.append(h)
                return h
            try:
                for gpu in ['GPU-a','GPU-a','GPU-b','GPU-b','GPU-c','GPU-c']:acquire(gpu)
                with self.assertRaises(launcher._GpuLockBusy):acquire('GPU-a')
                with self.assertRaises(launcher._GpuLockBusy):acquire('GPU-d')
                launcher._close_gpu_locks(handles.pop(0));acquire('GPU-a')
                launcher._close_gpu_locks(handles.pop(0))
                launcher._close_gpu_locks(handles.pop())
                acquire('GPU-d')
            finally:
                for h in handles:launcher._close_gpu_locks(h)

    @unittest.skipIf(launcher._fcntl is None, 'real Linux flock required')
    def test_same_gpu_loading_is_serial_and_exclusive_lock_is_respected(self):
        with tempfile.TemporaryDirectory() as directory:
            req={'gpuSharing':{'groupId':'hdps','maxDevices':3,'maxWorkersPerDevice':2},'_gpuUuids':['GPU-a'],'sources':[{'path':str(Path(directory)/'status.json'),'kind':'status_json'}]}
            h=launcher._acquire_shared_gpu_locks(directory,req)
            try:
                with self.assertRaises(launcher._GpuLockBusy):launcher._acquire_shared_gpu_locks(directory,req)
                with self.assertRaises(launcher._GpuLockBusy):launcher._acquire_gpu_locks(directory,['GPU-a'])
            finally:launcher._close_gpu_locks(h)
            exclusive=launcher._acquire_gpu_locks(directory,['GPU-a'])
            try:
                with self.assertRaises(launcher._GpuLockBusy):launcher._acquire_shared_gpu_locks(directory,req)
            finally:launcher._close_gpu_locks(exclusive)

    @unittest.skipIf(launcher._fcntl is None, 'real Linux flock required')
    def test_concurrent_launches_cannot_exceed_three_physical_gpus(self):
        with tempfile.TemporaryDirectory() as directory:
            def attempt(i):
                req={'gpuSharing':{'groupId':'hdps','maxDevices':3,'maxWorkersPerDevice':2},'_gpuUuids':[f'GPU-{i}'],'sources':[{'path':str(Path(directory)/f'status{i}.json'),'kind':'status_json'}]}
                try:return launcher._acquire_shared_gpu_locks(directory,req)
                except launcher._GpuLockBusy:return None
            with ThreadPoolExecutor(max_workers=8) as pool:results=list(pool.map(attempt,range(8)))
            try:self.assertEqual(sum(h is not None for h in results),3)
            finally:
                for h in results:launcher._close_gpu_locks(h)


if __name__ == '__main__':unittest.main(verbosity=2)
