"""Regression checks for unit-test safety, without invoking a real cluster."""

import copy
import json
import os
from pathlib import Path
import subprocess
import sys
from types import SimpleNamespace

import gevent
import gevent.socket
import pytest

from tests.conftest import TestSafetyViolation, _check_process


def test_application_paths_are_temporary(test_runtime):
    from web import app_context, database
    from launcher import database as launcher_db

    for path in (
        app_context.DB_PATH,
        database.DB_PATH,
        launcher_db.DB_PATH,
        app_context.STATE_DIR,
        database.STATE_FILE,
        app_context.OPTIMIZATION_OUTPUT_DIR,
        os.environ["HOME_STORAGE_DIR"],
        os.environ["HF_HOME"],
        os.environ["HOME"],
    ):
        assert Path(path).is_relative_to(test_runtime.root)
    assert not Path(os.environ["KUBECONFIG"]).exists()
    assert "KUBERNETES_SERVICE_HOST" not in os.environ
    assert os.environ["HF_HUB_OFFLINE"] == "1"


def test_launcher_persistence_uses_temporary_database(test_runtime):
    from launcher import database

    database.init_db()
    with database.get_db() as conn:
        assert conn.execute("SELECT COUNT(*) FROM users").fetchone()[0] == 0
    assert (test_runtime.root / "launcher.db").is_file()


@pytest.mark.parametrize(
    "command",
    [
        ["kubectl", "delete", "namespace", "serveit"],
        ["/usr/local/bin/oc", "apply", "-f", "-"],
        ["guidellm", "run"],
        ["bash", "-c", "kill -9 123"],
        ["pkill", "-f", "kubectl"],
    ],
)
def test_cluster_and_process_commands_fail_closed(command):
    with pytest.raises(TestSafetyViolation, match="Subprocess blocked"):
        subprocess.run(command, check=False)


@pytest.mark.parametrize(
    "command",
    [
        ["node", "--test", "tests/report_estimator.test.js"],
        ["npx", "--yes", "eslint@8", "--version"],
    ],
)
def test_existing_node_test_commands_are_allowed(command):
    _check_process(command)


@pytest.mark.parametrize(
    "event,args",
    [
        ("socket.connect", (None, ("cluster.invalid", 443))),
        ("socket.sendto", (None, ("cluster.invalid", 443))),
        ("socket.getaddrinfo", ("cluster.invalid", 443, 0, 0, 0)),
        ("os.mkdir", ("/mnt/storage/serveit-validation", 0o777, -1)),
        ("open", ("/mnt/storage/serveit.db", "w", os.O_WRONLY)),
        ("open", ("/tmp/infe_recipe_state/state.json", "w", os.O_WRONLY)),
    ],
)
def test_audit_guards_reject_network_and_persistent_writes(event, args):
    # Synthetic audit events exercise the guard without reaching any system call.
    with pytest.raises(TestSafetyViolation):
        sys.audit(event, *args)


def test_gevent_network_is_blocked():
    with gevent.socket.socket() as sock:
        with pytest.raises(TestSafetyViolation, match="Network access blocked"):
            sock.connect(("127.0.0.1", 1))


def test_start_dispatch_never_schedules_lifecycle(isolated_api_lifecycle):
    target = SimpleNamespace(__module__="web.realtime", __name__="handle_start_optimization")

    # Greenlet requires a callable, so use a sentinel with the real boundary name.
    def lifecycle(data):
        pytest.fail("Lifecycle sentinel must never execute")

    lifecycle.__module__ = target.__module__
    lifecycle.__name__ = target.__name__
    task = gevent.spawn(lifecycle, {"model": "fixture"})
    gevent.sleep(0)
    assert not task.started
    assert isolated_api_lifecycle.tasks == [(lifecycle, ({"model": "fixture"},), {})]


def test_stop_retains_real_route_and_persistence(isolated_api_lifecycle, authenticated_client):
    from web import app_context, database
    import web.routes_api  # noqa: F401

    database.init_db()
    before = copy.deepcopy(app_context.state)
    try:
        app_context.state["optimization_running"] = True
        app_context.state["config_locked"] = True
        with app_context.get_db() as conn:
            conn.execute("UPDATE ui_session_state SET optimization_running = 1 WHERE id = 1")
        client = authenticated_client
        for _ in range(2):
            response = client.post("/api/stop_optimization")
            assert response.status_code == 200
            assert response.get_json()["success"] is True
        assert app_context.state["optimization_running"] is False
        assert app_context.state["config_locked"] is False
        assert app_context.state["_stop_requested"] is True
        with app_context.get_db() as conn:
            assert conn.execute("SELECT optimization_running FROM ui_session_state WHERE id = 1").fetchone()[0] == 0
        assert json.loads(Path(database.STATE_FILE).read_text())["running"] is False
        assert len(isolated_api_lifecycle.processes) == 4
        assert [args[0] for args in isolated_api_lifecycle.processes] == ["kubectl", "bash"] * 2
    finally:
        app_context.state.clear()
        app_context.state.update(before)
        database.save_state()
