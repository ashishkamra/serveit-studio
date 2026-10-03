"""Exercise the checked-in report renderers with Node's dependency-free test runner."""

from pathlib import Path
import shutil
import subprocess

import pytest


def test_report_recommendations():
    node = shutil.which("node")
    if node is None:
        pytest.skip("Node.js is required for report renderer regression tests")
    root = Path(__file__).resolve().parents[1]
    result = subprocess.run(
        [node, "--test", "tests/report_recommendations.test.js", "tests/report_model.test.js"],
        cwd=root,
        capture_output=True,
        text=True,
        timeout=60,
    )
    assert result.returncode == 0, f"Report renderer regressions:\n{result.stdout}\n{result.stderr}"
