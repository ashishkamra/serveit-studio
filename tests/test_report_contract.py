"""Real ReportAnalyzer JSON consumed by actual browser helpers/renderers.

No server, deployment, or new dependency: in-memory run metadata and trusted JS.
"""

import json
import shutil
import sqlite3
import subprocess
from pathlib import Path
from types import SimpleNamespace

import pytest

from core.report_analysis import ReportAnalyzer
from tests.test_report_integrity import result

ROOT = Path(__file__).resolve().parents[1]
CATEGORIES = ("balanced", "lowest_ttft", "lowest_itl", "highest_tput", "most_efficient")


def generated_report():
    def metrics(mean=10, server_tps=0, **extra):
        return json.dumps(
            {
                "throughput_mean": mean,
                "concurrency_mean": 3.5,
                "e2e_latency_p50": 1,
                "e2e_latency_p90": 2,
                "e2e_latency_p95": 3,
                "e2e_latency_p99": 4,
                "prometheus_metrics": {"vllm_generation_tokens_rate": {"avg": server_tps}},
                **extra,
            }
        )

    rows = [
        result(
            1,
            config_name="step6-shared",
            quality="warning",
            metrics_json=metrics(server_tps=100),
            manifests_yaml='{"lws": "kind: LeaderWorkerSet"}',
        ),
        result(
            2,
            config_name="step6-shared",
            ttft_p90=20,
            ttft_p99=40,
            itl_p90=3,
            throughput_p90=20,
            metrics_json=metrics(20, server_tps=200),
        ),
        # Diagnostic success, but invalid mean. Serialized mean becomes None;
        # canonical eligibility must still block the tempting legacy fallback.
        result(3, config_name="step6-ineligible", metrics_json=metrics(0)),
        result(4, config_name="step6-zero-gpus", prefill_pods=0, metrics_json=metrics()),
        result(5, config_name="step6-discard", quality="discard", metrics_json=metrics()),
        result(6, config_name="step2-calibration", metrics_json=metrics()),
        result(7, config_name="step11-sweep-contract", ttft_p90=30, metrics_json=metrics()),
        result(8, config_name="step13-contract", ttft_p90=30, metrics_json=metrics()),
        result(9, config_name="step6-legacy-mean", throughput_p90=5, metrics_json='{"concurrency_mean": 3.5}'),
        result(10, config_name="step6-zero-itl", itl_p90=0, metrics_json=metrics()),
        result(11, config_name="step6-no-tail", ttft_p99=None, metrics_json=metrics()),
    ]
    with sqlite3.connect(":memory:") as conn:
        conn.row_factory = sqlite3.Row
        conn.execute("""CREATE TABLE optimization_runs (
            id INTEGER PRIMARY KEY, model TEXT, isl INTEGER, osl INTEGER, num_users INTEGER,
            goal TEXT, constraint_notes TEXT, created_at TEXT, completed_at TEXT,
            isl_stdev REAL, osl_stdev REAL, config_json TEXT, optimal_config TEXT, max_gpus INTEGER
        )""")
        conn.execute("""INSERT INTO optimization_runs (id, model, isl, osl, num_users, goal, config_json)
                        VALUES (42, 'contract', 100, 100, 4, 'ttft',
                        '{"isl": 100, "osl": 100, "num_users": 4, "model_name": "contract"}')""")
        conn.execute("""CREATE TABLE test_configurations (
            run_id INTEGER, config_name TEXT, status TEXT, test_config_json TEXT
        )""")
        loader = SimpleNamespace(conn=conn, get_all_test_results=lambda _: rows)
        return ReportAnalyzer().build_full_report_data(42, loader)


def consume(report):
    node = shutil.which("node")
    assert node is not None, "Node.js 20+ is required for cross-layer contract tests"
    payload = {
        "data": report,
        "runId": 42,
        "targets": {
            "target_tput": 100,
            "ttft_target": 500,
            "ttft_pctl": "p99",
            "itl_target": 20,
            "itl_pctl": "p90",
        },
    }
    completed = subprocess.run(
        [node, str(ROOT / "tests/report_contract_helper.js")],
        cwd=ROOT,
        input=json.dumps(payload, allow_nan=False),
        capture_output=True,
        text=True,
        timeout=30,
        check=False,
    )
    assert completed.returncode == 0, completed.stderr
    return json.loads(completed.stdout)


def cards(html):
    return [
        part.split("</table>", 1)[0]
        for part in html.split('<div style="background:white;border-radius:12px;overflow:hidden;')[1:]
    ]


@pytest.mark.parametrize("variant", ["canonical", "overridden_candidates", "legacy"])
def test_backend_to_browser_contract(variant):
    report = generated_report()
    raw = {r["test_config_id"]: r for r in report["all_results"]}
    assert raw[3]["is_ranking_eligible"] is False
    assert raw[3]["throughput_mean"] is None and raw[3]["throughput_p90"] == 10
    assert raw[4]["is_ranking_eligible"] is False
    if variant == "overridden_candidates":
        # Deliberately bypass backend candidate selection to test defensive gates
        # on real backend diagnostic JSON, not independently invented JS fixtures.
        candidate = {**raw[3], "recommendation_eligible": True}
        report["recommendation"]["best_by_percentile"] = {
            "p90": {"aggregated": dict.fromkeys(CATEGORIES, candidate)},
        }
        report["summary"]["calibrated_best"] = dict.fromkeys(CATEGORIES, candidate)
        report["summary"]["cache_sweep_best"] = dict.fromkeys(CATEGORIES, candidate)
    elif variant == "legacy":

        def strip(value):
            if isinstance(value, dict):
                value.pop("is_ranking_eligible", None)
                value.pop("test_config_id", None)
                for child in value.values():
                    strip(child)
            elif isinstance(value, list):
                for child in value:
                    strip(child)

        # This variant models genuinely old *valid* payloads, not corrupted means.
        report["all_results"] = [raw[i] for i in (1, 2, 5, 6, 7, 8, 9, 10, 11)]
        strip(report)

    observed = consume(report)
    estimator_rows = {r["test_id"]: r for r in observed["rows"]}
    assert "step6-discard" not in estimator_rows
    assert "step2-calibration" not in estimator_rows
    assert estimator_rows["step6-zero-itl"]["outcome"]["status"] == "Unknown"
    assert estimator_rows["step6-no-tail"]["outcome"]["status"] == "Unknown"
    fallback = estimator_rows["step6-legacy-mean"]
    assert fallback["measured_tput"] == 5 and fallback["replicas"] == 20
    assert fallback["throughput_source"] == "legacy throughput_p90"
    assert observed["estimator"] in observed["estimatorExport"]
    assert "Recorded concurrency: 4; measured concurrency: 3.5" in observed["estimator"]
    assert "not measured average concurrency" in observed["live"]
    assert "not measured average concurrency" in observed["exported"]
    assert "zero ITL is also Unknown" in observed["estimator"]

    if variant != "legacy":
        for test_id in ("step6-ineligible", "step6-zero-gpus"):
            row = estimator_rows[test_id]
            assert row["outcome"]["status"] == "Excluded"
            assert row["outcome"]["feasible"] is False
            assert "eligibility exclusion" in row["outcome"]["text"]
        scores = {s["id"]: s for s in observed["scores"]}
        for test_config_id in (3, 4, 5):
            assert scores[test_config_id]["live"] is None
            assert scores[test_config_id]["exported"] is None
        assert "test config ID 3" in observed["estimator"]
        assert "test config ID 4" in observed["estimatorExport"]
        points = observed["rows"]
        for index, row in enumerate(points):
            if row["outcome"]["status"] == "Excluded":
                assert observed["plot"]["traces"][0]["marker"]["color"][index] == "#64748b"
                assert "Best feasible" not in observed["plot"]["traces"][0]["text"][index]

    if variant == "overridden_candidates":
        assert cards(observed["live"]) == []
        assert cards(observed["exported"]) == []
        assert observed["actions"] == []
    else:
        assert len(cards(observed["live"])) >= 5
        assert len(cards(observed["exported"])) >= 5
        for html in (observed["live"], observed["exported"]):
            assert "30 ms" in cards(html)[0]  # P99 from the P90-selected source.
            assert "4.0 s" in cards(html)[0]  # Python seconds -> card milliseconds.
        if variant == "canonical":
            for html in (observed["live"], observed["exported"]):
                assert "100 tok/s" in cards(html)[0]
                highest = next(card for card in cards(html) if " Highest Throughput</div>" in card)
                assert "200 tok/s" in highest
            actions = dict(observed["actions"])
            shared = [(key, value) for key, value in actions.items() if value["test_id"] == "step6-shared"]
            assert {value["test_config_id"] for _, value in shared} == {1, 2}
            assert len({key for key, _ in shared}) == 2
            assert all(value["run_id"] == 42 for _, value in shared)
            assert "/config/step6-shared/manifest/lws" in observed["live"]
            assert "dlManifest('step6-shared','lws')" in observed["exported"]
            assert "test config ID: 1" in observed["live"]
            assert "test config ID: 2" in observed["exported"]
