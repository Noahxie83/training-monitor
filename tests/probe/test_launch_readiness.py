import importlib.util
from pathlib import Path
import unittest
from unittest import mock
p=Path(__file__).parents[2]/"src"/"probe"/"readonly_probe.py"
spec=importlib.util.spec_from_file_location("readiness_probe",p)
probe=importlib.util.module_from_spec(spec)
spec.loader.exec_module(probe)
class ReadinessTests(unittest.TestCase):
    def test_first_run_missing_log_does_not_prevent_process_scan(self):
        task={"hostAllowedRoots":["/allowed"],"allowedDirectories":["/allowed/run"],"entryPaths":["train.py"],"sources":[{"sourceId":"log","kind":"log","path":"/allowed/run/new.log"}]}
        with mock.patch.object(probe,"scan_registered_processes",return_value={"scanComplete":True,"errorCode":None,"candidates":[]}) as scan, mock.patch.object(probe,"open_readonly") as read:
            result=probe._dispatch({"op":"probe_launch_readiness","task":task})
        self.assertEqual(result,{"scanComplete":True,"running":False,"errorCode":None})
        self.assertEqual(scan.call_args.args[2]["sources"],[])
        read.assert_not_called()
    def test_incomplete_scan_never_claims_readiness(self):
        with mock.patch.object(probe,"scan_registered_processes",return_value={"scanComplete":False,"errorCode":"SCAN_INCOMPLETE","candidates":[]}):
            result=probe._dispatch({"op":"probe_launch_readiness","task":{}})
        self.assertFalse(result["scanComplete"])
        self.assertEqual(result["errorCode"],"SCAN_INCOMPLETE")
