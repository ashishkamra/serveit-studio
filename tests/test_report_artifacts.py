"""Run-scoped immutable artifact routes, with real auth and read-only SQLite."""

from contextlib import contextmanager
import json
import sqlite3
from urllib.parse import quote

import pytest


@pytest.fixture
def artifacts(authenticated_client, monkeypatch):
    from web import realtime, report_artifacts

    conn = sqlite3.connect(":memory:")
    conn.row_factory = sqlite3.Row
    conn.execute(
        "CREATE TABLE test_configurations (id INTEGER PRIMARY KEY, run_id INTEGER, config_name TEXT, manifests_yaml TEXT)"
    )
    rows = [
        (101, 42, "shared", json.dumps({"lws": "kind: First\n# café\n", "epp-configmap": "kind: ConfigMap\n"})),
        (102, 99, "shared", json.dumps({"lws": "kind: Second\n"})),
        (103, 42, "no-manifest", None),
        (104, 42, "broken", "not-json"),
        (105, 42, "array", "[]"),
        (106, 42, "not-yaml-text", '{"lws": 12}'),
        (107, 42, "empty-text", '{"lws": ""}'),
        (108, 42, "unsafe-name", json.dumps({'bad"kind': "kind: Safe\n"})),
    ]
    conn.executemany("INSERT INTO test_configurations VALUES (?, ?, ?, ?)", rows)
    conn.commit()

    @contextmanager
    def get_db():
        yield conn

    monkeypatch.setattr(report_artifacts, "get_db", get_db)
    monkeypatch.setattr(realtime, "get_db", get_db)
    yield authenticated_client, conn
    conn.close()


def test_immutable_download_is_scoped_to_run_and_does_not_mutate(artifacts):
    client, conn = artifacts
    before = conn.total_changes
    for run_id, test_id, text in ((42, 101, "kind: First\n# café\n"), (99, 102, "kind: Second\n")):
        response = client.get(f"/api/run/{run_id}/test/{test_id}/manifest/lws")
        assert response.status_code == 200
        assert response.get_data(as_text=True) == text
        assert response.mimetype == "application/x-yaml"
        assert f"run-{run_id}-test-{test_id}-lws.yaml" in response.headers["Content-Disposition"]
        assert response.headers["X-Content-Type-Options"] == "nosniff"
        assert response.headers["Cache-Control"] == "no-store"
    assert client.get("/api/run/42/test/102/manifest/lws").status_code == 404
    assert client.get("/api/run/99/test/101/manifest/lws").status_code == 404
    assert conn.total_changes == before


def test_list_contains_exact_source_identity(artifacts):
    client, _ = artifacts
    response = client.get("/api/run/42/test/101/manifests")
    assert response.status_code == 200
    assert response.json == {"run_id": 42, "test_config_id": 101, "available": ["lws", "epp-configmap"]}
    assert client.get("/api/run/99/test/101/manifests").status_code == 404
    assert client.get("/api/run/42/test/103/manifests").json["available"] == []


@pytest.mark.parametrize(
    "source",
    [
        "42/test/999",
        "42/test/0",
        "0/test/101",
        "42/test/-1",
        "42/test/1.5",
        "42/test/name",
        f"42/test/{2**64}",
        f"{2**64}/test/101",
    ],
)
def test_invalid_or_unknown_identity_is_not_a_server_error(artifacts, source):
    client, _ = artifacts
    for suffix in ("manifests", "manifest/lws"):
        assert client.get(f"/api/run/{source}/{suffix}").status_code == 404


@pytest.mark.parametrize("test_id", [104, 105, 106])
def test_malformed_stored_artifacts_are_explicitly_unavailable(artifacts, test_id):
    client, _ = artifacts
    for suffix in ("manifests", "manifest/lws"):
        response = client.get(f"/api/run/42/test/{test_id}/{suffix}")
        assert response.status_code == 422
        assert response.json["error"] == "Stored manifests are invalid"


def test_missing_type_does_not_substitute_another_manifest(artifacts):
    client, _ = artifacts
    response = client.get("/api/run/42/test/101/manifest/decode")
    assert response.status_code == 404
    assert response.json["available"] == ["lws", "epp-configmap"]
    assert client.get("/api/run/42/test/103/manifest/lws").status_code == 404
    assert client.get("/api/run/42/test/107/manifest/lws").data == b""


def test_filename_uses_safe_identity_not_user_name(artifacts):
    client, _ = artifacts
    response = client.get("/api/run/42/test/108/manifest/" + quote('bad"kind', safe=""))
    assert response.status_code == 200
    assert "run-42-test-108-bad_kind.yaml" in response.headers["Content-Disposition"]
    assert response.data == b"kind: Safe\n"


def test_legacy_routes_still_download_by_name(artifacts):
    client, _ = artifacts
    assert client.get("/api/run/42/config/shared/manifest/lws").get_data(as_text=True) == "kind: First\n# café\n"
    assert client.get("/api/run/99/config/shared/manifest/lws").get_data(as_text=True) == "kind: Second\n"
    assert client.get("/api/run/42/config/shared/manifests").json["available"] == ["lws", "epp-configmap"]


def test_immutable_routes_keep_real_auth_guard(artifacts, application):
    anonymous = application.test_client()
    assert anonymous.get("/api/run/42/test/101/manifest/lws").status_code == 302
    assert anonymous.get("/api/run/42/test/101/manifests").status_code == 302
