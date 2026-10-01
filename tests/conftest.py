"""Keep unit-test state temporary and cluster/process lifecycle effects inert.

This is a guard against accidental test side effects, not a security sandbox.
Route implementations, persistence, imports, and assertions remain real.
"""

import os
from pathlib import Path
import subprocess
import sys
import tempfile
from types import SimpleNamespace

import pytest


class TestSafetyViolation(BaseException):
    """Do not let application ``except Exception`` blocks hide unsafe operations."""

    __test__ = False


def _check_process(args):
    if isinstance(args, (str, bytes, os.PathLike)):
        raise TestSafetyViolation(f"Shell command blocked during unit tests: {args!r}")
    command = Path(os.fsdecode(args[0])).name
    if command in {"node", "npx"}:
        return  # Checked-in Node regressions and the existing ESLint runner.
    if command == "uname" or (command == "git" and list(args[1:]) == ["version"]):
        return  # Read-only dependency/platform detection.
    if command == "git" and list(args[1:]) == ["--version"]:
        return
    raise TestSafetyViolation(f"Subprocess blocked during unit tests: {args!r}")


def pytest_configure(config):
    # Must precede collection: several modules capture environment paths on import.
    temporary = tempfile.TemporaryDirectory(prefix="serveit-unit-", dir="/tmp")
    root = Path(temporary.name)
    patch = pytest.MonkeyPatch()
    config._serveit_isolation = SimpleNamespace(root=root, patch=patch)
    values = {
        "DB_PATH": str(root / "serveit.db"),
        "LAUNCHER_DB_PATH": str(root / "launcher.db"),
        "OPTIMIZATION_OUTPUT_DIR": str(root / "output"),
        "HOME_STORAGE_DIR": str(root / "storage"),
        "HOME": str(root / "home"),
        "KUBECONFIG": str(root / "no-kubeconfig"),
        "HF_HOME": str(root / "huggingface"),
        "HF_HUB_OFFLINE": "1",
        "HF_HUB_DISABLE_TELEMETRY": "1",
        "TRANSFORMERS_OFFLINE": "1",
        "MLFLOW_TRACKING_URI": f"sqlite:///{root / 'mlflow.db'}",
        "MLFLOW_ENABLE_TELEMETRY": "false",
        "XDG_CACHE_HOME": str(root / "cache"),
        "TMPDIR": str(root),
        "SECRET_KEY": "serveit-unit-tests-only-not-a-production-secret",
        "TARGET_NAMESPACE": "serveit-unit-tests",
    }
    for key, value in values.items():
        patch.setenv(key, value)
    for key in (
        "KUBERNETES_SERVICE_HOST",
        "KUBERNETES_SERVICE_PORT",
        "HF_TOKEN",
        "HUGGING_FACE_HUB_TOKEN",
        "OPENAI_API_KEY",
        "MLFLOW_TRACKING_TOKEN",
    ):
        patch.delenv(key, raising=False)
    (root / "home").mkdir()
    patch.setattr(tempfile, "tempdir", str(root))
    patch.setattr(sys, "dont_write_bytecode", True)

    # Audit hooks also cover collection-time writes and ordinary socket calls.
    # They cannot be removed, so deactivate this one at pytest cleanup.
    active = [True]

    def audit(event, args):
        if not active[0]:
            return
        if event in {"socket.connect", "socket.sendto", "socket.getaddrinfo"}:
            raise TestSafetyViolation(f"Network access blocked during unit tests: {event}")
        if event == "subprocess.Popen":
            _check_process(args[1])
        paths = ()
        if event == "open":
            path, mode, flags = args
            if (mode and any(c in mode for c in "wax+")) or flags & (
                os.O_WRONLY | os.O_RDWR | os.O_CREAT | os.O_TRUNC | os.O_APPEND
            ):
                paths = (path,)
        elif event in {"os.mkdir", "os.remove", "os.rmdir"}:
            paths = args[:1]
        elif event in {"os.rename", "os.link", "os.symlink"}:
            paths = args[:2]
        for path in paths:
            if isinstance(path, (str, bytes, os.PathLike)):
                absolute = os.path.abspath(os.fsdecode(path))
                shared_state = absolute == "/tmp/infe_recipe_state" or absolute.startswith("/tmp/infe_recipe_state/")
                if shared_state or (absolute != "/dev/null" and not absolute.startswith("/tmp/")):
                    raise TestSafetyViolation(f"Non-temporary write blocked: {absolute}")

    sys.addaudithook(audit)
    config.add_cleanup(temporary.cleanup)
    config.add_cleanup(patch.undo)
    config.add_cleanup(lambda: active.__setitem__(0, False))

    # gevent's sockets/subprocesses do not necessarily emit CPython audit events.
    import gevent.socket
    import gevent.subprocess

    def no_network(*args, **kwargs):
        raise TestSafetyViolation("Network access blocked during unit tests (gevent)")

    patch.setattr(gevent.socket.socket, "connect", no_network)
    patch.setattr(gevent.socket.socket, "connect_ex", no_network)
    patch.setattr(gevent.socket.socket, "sendto", no_network)
    original_popen = gevent.subprocess.Popen

    class SafePopen(original_popen):
        def __init__(self, args, *positional, **kwargs):
            _check_process(args)
            super().__init__(args, *positional, **kwargs)

    patch.setattr(gevent.subprocess, "Popen", SafePopen)


@pytest.fixture(scope="session")
def test_runtime(request):
    return request.config._serveit_isolation


@pytest.fixture(scope="module", autouse=True)
def isolated_application_paths(test_runtime):
    # Reassert isolation before application fixtures import the shared singleton.
    root = test_runtime.root
    with pytest.MonkeyPatch.context() as patch:
        patch.setenv("DB_PATH", str(root / "serveit.db"))
        patch.setenv("OPTIMIZATION_OUTPUT_DIR", str(root / "output"))
        from web import app_context

        patch.setattr(app_context, "DB_PATH", str(root / "serveit.db"))
        patch.setattr(app_context, "OPTIMIZATION_OUTPUT_DIR", str(root / "output"))
        patch.setattr(app_context, "STATE_DIR", str(root / "state"))
        patch.setattr(app_context, "STATE_FILE", str(root / "state" / "state.json"))
        # Update already-imported copies without preloading routes or server:
        # lazy route-registration defects must still be visible to the tests.
        for name in ("web.database", "web.realtime", "web.server", "web.optimization", "web.routes_api"):
            module = sys.modules.get(name)
            if module:
                for key in ("DB_PATH", "OPTIMIZATION_OUTPUT_DIR", "STATE_DIR", "STATE_FILE"):
                    if hasattr(module, key):
                        patch.setattr(module, key, getattr(app_context, key))
        yield


@pytest.fixture(autouse=True)
def isolated_api_lifecycle(request, monkeypatch):
    if request.module.__name__.split(".")[-1] not in {"test_api", "test_test_isolation"}:
        yield None
        return
    calls = SimpleNamespace(processes=[], tasks=[])
    real_run = subprocess.run

    def safe_stop_run(args, *positional, **kwargs):
        # Only intercept stop endpoint's two side-effect boundaries, not the route.
        if isinstance(args, list) and args[:3] == ["kubectl", "get", "pod"] and "app=serveit-workload" in args:
            calls.processes.append(args)
        elif (
            isinstance(args, list)
            and args[:2] == ["bash", "-c"]
            and "ps aux | grep kubectl" in args[2]
            and "xargs -r kill -9" in args[2]
        ):
            calls.processes.append(args)
        else:
            return real_run(args, *positional, **kwargs)
        empty = "" if kwargs.get("text") else b""
        return subprocess.CompletedProcess(args, 1, empty, empty)

    import gevent

    real_spawn = gevent.spawn

    def safe_spawn(target, *args, **kwargs):
        if target.__module__ == "web.realtime" and target.__name__ == "handle_start_optimization":
            calls.tasks.append((target, args, kwargs))
            # Unstarted real Greenlet: nothing is queued on the event loop.
            return gevent.Greenlet(target, *args, **kwargs)
        return real_spawn(target, *args, **kwargs)

    monkeypatch.setattr(subprocess, "run", safe_stop_run)
    monkeypatch.setattr(gevent, "spawn", safe_spawn)
    yield calls


@pytest.fixture(scope="module")
def application():
    # Use the real entry point to register auth and realtime routes before the
    # first request. Importing only routes_api leaves lazy imports order-dependent.
    from web.server import app
    from web.database import init_db

    previous = app.config["TESTING"]
    app.config["TESTING"] = True
    init_db()
    yield app
    app.config["TESTING"] = previous


@pytest.fixture
def authenticated_client(application):
    client = application.test_client()
    credentials = {"username": "unit-test-user", "password": "unit-tests-only"}
    # Exercise the actual auth routes rather than disabling the authentication
    # guard. Setup is idempotent: later clients log in to the same temporary DB.
    client.post("/setup", data={**credentials, "confirm_password": credentials["password"]})
    response = client.post("/login", data=credentials)
    assert response.status_code == 302
    with client.session_transaction() as session:
        assert session["user"] == credentials["username"]
    return client
