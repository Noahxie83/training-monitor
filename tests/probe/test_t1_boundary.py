from pathlib import Path
import unittest


ROOT = Path(__file__).resolve().parents[2]


class ProbeBoundaryTests(unittest.TestCase):
    def test_probe_directory_contains_only_the_readonly_payload(self):
        probe_dir = ROOT / "src" / "probe"
        names = sorted(path.name for path in probe_dir.iterdir() if not (path.name == "__pycache__" and path.is_dir()))
        self.assertEqual(names, ["readonly_probe.py"])
        self.assertTrue((probe_dir / "readonly_probe.py").is_file())

    def test_mock_data_has_no_remote_transport_execution_dependency(self):
        # Target kinds in demo data are labels, not transport execution.
        # The production main now intentionally wires the real collector.
        source = (ROOT / "src/mocks/api.ts").read_text(encoding="utf-8")
        self.assertNotRegex(source, r"(?:from\s+|import\s*\()['\"][^'\"]*/transport/")
        self.assertNotRegex(source, r"(?:from\s+|import\s*\()['\"](?:node:)?child_process")
        self.assertNotRegex(source, r"\b(?:spawn|execFile|execSync|createTransport)\s*\(")


if __name__ == "__main__":
    unittest.main()
