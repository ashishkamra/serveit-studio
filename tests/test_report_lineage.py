"""Raw-source retention with explicit lineage: parser -> persistence -> loader -> evidence."""

import json
import sqlite3
from dataclasses import asdict
from types import SimpleNamespace

import pytest

from core.config_generator import TestConfig as RunConfig
from core.database_manager import DatabaseManager
from core.orchestrator.guidellm import GuidellmMixin
from core.orchestrator.parser import ParserMixin
from core.orchestrator.result import (
    RAW_SOURCE_LINEAGE_OUTPUT_FILE,
    RAW_SOURCE_LINEAGE_RECONSTITUTED,
    TestResult as BenchmarkResult,
)
from core.report_analysis import ReportAnalyzer
from core.report_data import ReportDataLoader
from core.report_evidence import build_test_evidence
from tests.test_report_integrity import result

MARKER = "serveit-lineage-raw-source-marker"


def _guidellm_document():
    return {
        "benchmarks": [
            {
                "name": MARKER,
                "duration": 5,
                "metrics": {
                    "time_to_first_token_ms": {
                        "successful": {"percentiles": {"p50": 5, "p90": 10, "p95": 20, "p99": 30}}
                    },
                    "inter_token_latency_ms": {"successful": {"percentiles": {"p50": 1, "p90": 2, "p95": 3, "p99": 4}}},
                    "request_latency": {"successful": {"percentiles": {"p50": 1, "p90": 2, "p95": 3, "p99": 4}}},
                    "requests_per_second": {"successful": {"mean": 10}},
                    "request_totals": {"total": 10, "successful": 10},
                },
            }
        ]
    }


def _parsed_benchmark(tmp_path, text):
    path = tmp_path / "guidellm.json"
    path.write_text(text)
    bench = BenchmarkResult("step6-agg-1", "aggregated", True, True, True, True, "2026-01-01T00:00:00")
    ParserMixin._parse_guidellm_results(str(path), bench)
    return bench


def _test_config():
    return RunConfig(
        test_id="step6-agg-1",
        architecture="aggregated",
        model_name="fixture-model",
        namespace="serveit",
        isl=100,
        osl=100,
        num_users=4,
        tensor_parallelism=1,
        replicas=1,
    )


def _persist(tmp_path, lineage):
    text = json.dumps(_guidellm_document())
    db = DatabaseManager(str(tmp_path / "serveit.db"))
    run_id = db.create_optimization_run("lineage-run", "fixture-model", 100, 100, 4)
    bench = _parsed_benchmark(tmp_path, text)
    bench.guidellm_raw_lineage = lineage
    db.insert_test_result(run_id, _test_config(), bench)
    return str(db.db_path), run_id, text


def test_parser_keeps_exact_bytes_and_does_not_infer_lineage(tmp_path):
    text = json.dumps(_guidellm_document(), indent=2) + "\n"
    bench = _parsed_benchmark(tmp_path, text)
    assert bench.guidellm_raw_json == text
    assert bench.guidellm_raw_lineage is None
    assert bench.ttft_p99 == 30


@pytest.mark.parametrize("lineage", [RAW_SOURCE_LINEAGE_OUTPUT_FILE, RAW_SOURCE_LINEAGE_RECONSTITUTED])
def test_insert_persists_raw_source_and_explicit_lineage(tmp_path, lineage):
    db_path, run_id, text = _persist(tmp_path, lineage)
    with sqlite3.connect(db_path) as conn:
        conn.row_factory = sqlite3.Row
        row = conn.execute(
            "SELECT guidellm_raw_json, guidellm_raw_lineage FROM test_configurations WHERE run_id=?",
            (run_id,),
        ).fetchone()
    assert row["guidellm_raw_json"] == text
    assert json.loads(row["guidellm_raw_json"])["benchmarks"][0]["name"] == MARKER
    assert row["guidellm_raw_lineage"] == lineage


@pytest.mark.parametrize("lineage", [RAW_SOURCE_LINEAGE_OUTPUT_FILE, RAW_SOURCE_LINEAGE_RECONSTITUTED])
def test_loader_and_evidence_report_preserved_lineage(tmp_path, lineage):
    db_path, run_id, _ = _persist(tmp_path, lineage)
    with ReportDataLoader(db_path) as loader:
        loaded = loader.get_all_test_results(run_id)[0]
    assert loaded.guidellm_raw_json is not None
    assert loaded.guidellm_raw_lineage == lineage
    evidence = build_test_evidence(loaded, run_id)
    assert evidence["raw_source"] == {"stored": True, "lineage": lineage}
    assert evidence["metrics"]["ttft_p99"]["provenance"] == "verified"
    assert evidence["metrics"]["throughput_mean"]["provenance"] == "verified"


@pytest.mark.parametrize("raw_state", ["no_raw_column", "raw_without_lineage_column"])
def test_legacy_rows_stay_unknown_or_unrecorded_never_certified(raw_state):
    row = result()
    values = asdict(row)
    if raw_state == "raw_without_lineage_column":
        import json as _json

        values["guidellm_raw_json"] = _json.dumps(_guidellm_document())
    else:
        values.pop("guidellm_raw_json", None)
    values.pop("guidellm_raw_lineage", None)
    with sqlite3.connect(":memory:") as conn:
        conn.row_factory = sqlite3.Row
        definitions = [
            name + (" INTEGER" if isinstance(value, int) else " REAL" if isinstance(value, float) else " TEXT")
            for name, value in values.items()
        ]
        conn.execute("CREATE TABLE test_configurations (run_id INTEGER, " + ",".join(definitions) + ")")
        conn.execute(
            "INSERT INTO test_configurations (run_id, "
            + ",".join(values)
            + ") VALUES ("
            + ",".join(["?"] * (len(values) + 1))
            + ")",
            [42, *values.values()],
        )
        loader = ReportDataLoader()
        loader.conn = conn
        loaded = loader.get_all_test_results(42)[0]
    assert bool(loaded.guidellm_raw_json) is (raw_state == "raw_without_lineage_column")
    assert loaded.guidellm_raw_lineage is None
    evidence = build_test_evidence(loaded, 42)
    assert evidence["raw_source"] == {
        "stored": raw_state == "raw_without_lineage_column",
        "lineage": "unrecorded",
    }
    expected = "verified" if raw_state == "raw_without_lineage_column" else "unknown"
    assert evidence["metrics"]["ttft_p99"]["provenance"] == expected


def test_report_payload_does_not_embed_raw_source():
    import json as _json

    row = result(guidellm_raw_json=_json.dumps(_guidellm_document()))
    row.guidellm_raw_lineage = RAW_SOURCE_LINEAGE_RECONSTITUTED
    with sqlite3.connect(":memory:") as conn:
        conn.row_factory = sqlite3.Row
        conn.execute("""CREATE TABLE optimization_runs (
            id INTEGER PRIMARY KEY, model TEXT, isl INTEGER, osl INTEGER, num_users INTEGER,
            goal TEXT, constraint_notes TEXT, created_at TEXT, completed_at TEXT,
            isl_stdev REAL, osl_stdev REAL, config_json TEXT, optimal_config TEXT, max_gpus INTEGER
        )""")
        conn.execute(
            """INSERT INTO optimization_runs (id, model, isl, osl, num_users, goal, config_json)
                        VALUES (1, 'lineage', 100, 100, 4, 'ttft', '{}')"""
        )
        conn.execute("""CREATE TABLE test_configurations (
            run_id INTEGER, config_name TEXT, status TEXT, test_config_json TEXT
        )""")
        loader = SimpleNamespace(conn=conn, get_all_test_results=lambda _: [row])
        report = ReportAnalyzer().build_full_report_data(1, loader)
    payload = json.dumps(report, allow_nan=False)
    assert MARKER not in payload
    assert "guidellm_raw_json" not in payload
    assert report["report_contract"]["version"] == 1


def test_runners_consume_a_four_value_guidellm_result_contract():
    # The benchmark producers return (success, result_file, metrics_path, lineage);
    # every caller must unpack all four values.
    for name in ("_run_guidellm_job", "_run_guidellm_test"):
        annotation = getattr(GuidellmMixin, name).__annotations__.get("return")
        text = str(annotation)
        assert text.count("Optional[str]") == 3, f"{name} must declare (success, file, metrics, lineage)"
