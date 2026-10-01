"""Test Flask REST API endpoints."""

import json
import pytest


@pytest.fixture
def client(authenticated_client):
    return authenticated_client


def test_status_endpoint(client):
    resp = client.get("/api/status")
    assert resp.status_code == 200
    data = resp.get_json()
    assert "running" in data
    assert data["running"] is False


def test_config_lock_unlock(client):
    resp = client.post("/api/config/lock")
    assert resp.status_code == 200
    assert resp.get_json()["locked"] is True

    resp = client.post("/api/config/unlock")
    assert resp.status_code == 200
    assert resp.get_json()["locked"] is False


def test_config_save_and_read(client):
    resp = client.post(
        "/api/config",
        data=json.dumps({"model": "test/model", "image": "vllm/vllm-openai:v0.26.0"}),
        content_type="application/json",
    )
    assert resp.status_code == 200

    resp = client.get("/api/config")
    assert resp.status_code == 200
    data = resp.get_json()
    assert data.get("model") == "test/model"
    assert data.get("image") == "vllm/vllm-openai:v0.26.0"


def test_config_persists_image(client):
    """Image set via /api/config should persist in DB."""
    client.post(
        "/api/config", data=json.dumps({"image": "ghcr.io/llm-d/llm-d-cuda:v0.8.1"}), content_type="application/json"
    )

    resp = client.get("/api/config")
    assert resp.get_json().get("image") == "ghcr.io/llm-d/llm-d-cuda:v0.8.1"

    client.post("/api/config", data=json.dumps({"image": "vllm/vllm-openai:v0.27.1"}), content_type="application/json")

    resp = client.get("/api/config")
    assert resp.get_json().get("image") == "vllm/vllm-openai:v0.27.1"


def test_set_state(client):
    resp = client.post(
        "/api/set_state", data=json.dumps({"current_step": 7, "running": True}), content_type="application/json"
    )
    assert resp.status_code == 200

    resp = client.get("/api/status")
    data = resp.get_json()
    assert data["running"] is True


def test_stop_optimization_idempotent(client):
    resp = client.post("/api/stop_optimization")
    assert resp.status_code == 200
    assert resp.get_json()["success"] is True

    resp = client.post("/api/stop_optimization")
    assert resp.status_code == 200


def test_start_optimization_no_test_plan(client, isolated_api_lifecycle):
    resp = client.post(
        "/api/start_optimization", data=json.dumps({"hf_token": "test"}), content_type="application/json"
    )
    assert resp.status_code in (200, 409)
    if resp.status_code == 200:
        assert len(isolated_api_lifecycle.tasks) == 1


def test_runs_empty(client):
    resp = client.get("/api/runs")
    assert resp.status_code == 200
    data = resp.get_json()
    assert isinstance(data, list)


def test_clear_console(client):
    resp = client.post("/api/clear_console")
    assert resp.status_code == 200


def test_goal_renamed_in_status(client):
    """balanced goal should show as full_coverage in API status."""
    client.post("/api/config", data=json.dumps({"goal": "balanced"}), content_type="application/json")
    resp = client.get("/api/status")
    cfg = resp.get_json().get("config", {})
    assert cfg.get("goal") == "full_coverage"


def test_goal_other_values_unchanged(client):
    """Non-balanced goals should pass through unchanged."""
    for goal in ["ttft", "throughput", "single_test", "pd_only"]:
        client.post("/api/config", data=json.dumps({"goal": goal}), content_type="application/json")
        resp = client.get("/api/status")
        cfg = resp.get_json().get("config", {})
        assert cfg.get("goal") == goal
