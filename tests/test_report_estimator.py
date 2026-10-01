"""Run browser-free estimator regressions with Node's built-in test runner."""

import shutil
import subprocess
from pathlib import Path


def test_report_estimator():
    root = Path(__file__).resolve().parents[1]
    node = shutil.which("node")
    assert node is not None, "Node.js 20+ is required for the estimator regression tests"
    result = subprocess.run(
        [node, "--test", str(root / "tests" / "report_estimator.test.js")],
        cwd=root,
        capture_output=True,
        text=True,
        timeout=60,
        check=False,
    )
    assert result.returncode == 0, f"Estimator regressions failed:\n{result.stdout}\n{result.stderr}"
