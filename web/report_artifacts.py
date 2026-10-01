"""Run-scoped report artifacts addressed by immutable test configuration IDs.

Legacy name-based routes remain in realtime.py for historical clients. New report
actions must not substitute a display name when immutable evidence is available.
"""

import json
import re

from flask import Response, jsonify

from web.app_context import app, get_db


def _test_manifests(run_id, test_config_id):
    # SQLite INTEGER is signed 64-bit; oversized URL integers are not DB errors.
    if not (0 < run_id <= 2**63 - 1 and 0 < test_config_id <= 2**63 - 1):
        return None, (jsonify(error="Test configuration not found in this run"), 404)
    with get_db() as conn:
        row = conn.execute(
            "SELECT manifests_yaml FROM test_configurations WHERE run_id = ? AND id = ?",
            (run_id, test_config_id),
        ).fetchone()
    if row is None:
        return None, (jsonify(error="Test configuration not found in this run"), 404)
    try:
        manifests = json.loads(row["manifests_yaml"]) if row["manifests_yaml"] else {}
    except (TypeError, ValueError):
        return None, (jsonify(error="Stored manifests are invalid"), 422)
    if not isinstance(manifests, dict) or any(not isinstance(value, str) for value in manifests.values()):
        return None, (jsonify(error="Stored manifests are invalid"), 422)
    return manifests, None


@app.route("/api/run/<int:run_id>/test/<int:test_config_id>/manifest/<manifest_type>")
def download_test_manifest(run_id, test_config_id, manifest_type):
    """Return only the requested immutable test's artifact, scoped to its run."""
    manifests, error = _test_manifests(run_id, test_config_id)
    if error is not None:
        return error
    if manifest_type not in manifests:
        return jsonify(error="Manifest type not available for this test", available=list(manifests)), 404
    kind = re.sub(r"[^A-Za-z0-9_.-]", "_", manifest_type)
    filename = f"run-{run_id}-test-{test_config_id}-{kind}.yaml"
    response = Response(manifests[manifest_type], mimetype="application/x-yaml")
    response.headers.set("Content-Disposition", "attachment", filename=filename)
    response.headers["X-Content-Type-Options"] = "nosniff"
    response.headers["Cache-Control"] = "no-store"
    return response


@app.route("/api/run/<int:run_id>/test/<int:test_config_id>/manifests")
def list_test_manifests(run_id, test_config_id):
    manifests, error = _test_manifests(run_id, test_config_id)
    if error is not None:
        return error
    return jsonify(run_id=run_id, test_config_id=test_config_id, available=list(manifests))
