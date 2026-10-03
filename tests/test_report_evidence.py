"""Evidence v1 is explicit, source-backed where possible, and read-only."""

from dataclasses import asdict
import json
import sqlite3

import pytest

from core.orchestrator.parser import ParserMixin
from core.orchestrator.result import TestResult as BenchmarkResult
from core.report_analysis import ReportAnalyzer
from core.report_data import ReportDataLoader, valid_metric
from core.report_evidence import attach_report_evidence, build_test_evidence
from tests.test_report_integrity import result


def raw_source(row):
    metrics = {}
    for source_key, attribute in (
        ("time_to_first_token_ms", "ttft"),
        ("inter_token_latency_ms", "itl"),
        ("request_latency", "e2e_latency"),
    ):
        metrics[source_key] = {
            "successful": {"percentiles": {p: getattr(row, f"{attribute}_{p}") for p in ("p50", "p90", "p95", "p99")}}
        }
    metrics["requests_per_second"] = {"successful": {"mean": row.throughput_mean}}
    metrics["request_totals"] = {"total": 10, "successful": 10}
    return json.dumps({"benchmarks": [{"metrics": metrics, "duration": 5}]}, allow_nan=False)


def test_unknown_history_is_not_certified_or_rewritten():
    row = result()
    before = asdict(row)
    evidence = build_test_evidence(row, 42)
    assert evidence["version"] == 1
    assert evidence["source"] == {"run_id": 42, "test_config_id": 1, "test_id": row.config_name}
    assert evidence["metrics"]["ttft_p99"]["value"] == 30
    assert evidence["metrics"]["ttft_p99"]["provenance"] == "unknown"
    assert evidence["metrics"]["ttft_p99"]["raw_source_field"] is None
    assert evidence["metrics"]["throughput_mean"]["provenance"] == "unknown"
    assert evidence["eligibility"]["slo_verified"] is False
    assert evidence["recorded_timestamps"]["measurement_window_verified"] is False
    assert evidence["resources"]["total_gpus"]["kind"] == "calculated"
    assert asdict(row) == before


def test_matching_raw_source_verifies_exact_percentiles_and_units():
    row = result()
    row.guidellm_raw_json = raw_source(row)
    evidence = build_test_evidence(row, 42)
    for key in ("ttft_p99", "itl_p90", "throughput_mean"):
        assert evidence["metrics"][key]["provenance"] == "verified"
    e2e = evidence["metrics"]["e2e_p99"]
    assert e2e["value"] == 4000 and e2e["unit"] == "ms"
    assert e2e["source_value"] == 4 and e2e["source_unit"] == "s"
    assert e2e["statistic"] == "p99"
    assert e2e["source_field"] == "metrics_json.e2e_latency_p99"
    assert e2e["raw_source_field"] == "guidellm.request_latency.successful.percentiles.p99"
    json.dumps(evidence, allow_nan=False)


def test_historical_p999_mismatch_is_diagnostic_not_a_repair():
    row = result(ttft_p99=999)
    raw = json.loads(raw_source(row))
    raw["benchmarks"][0]["metrics"]["time_to_first_token_ms"]["successful"]["percentiles"].update(p99=99, p999=999)
    row.guidellm_raw_json = json.dumps(raw)
    evidence = build_test_evidence(row, 42)["metrics"]["ttft_p99"]
    assert evidence["value"] == 999
    assert evidence["source_value"] == 99
    assert evidence["provenance"] == "mismatch"
    assert row.ttft_p99 == 999


def test_nearly_matching_source_is_not_certified_across_a_target_boundary():
    row = result(ttft_p99=30)
    raw = json.loads(raw_source(row))
    raw["benchmarks"][0]["metrics"]["time_to_first_token_ms"]["successful"]["percentiles"]["p99"] = 30 + 1e-10
    row.guidellm_raw_json = json.dumps(raw)
    assert build_test_evidence(row)["metrics"]["ttft_p99"]["provenance"] == "mismatch"


@pytest.mark.parametrize("raw", [None, "invalid-json", "[]", "null", '{"benchmarks": []}', '{"benchmarks": [null]}'])
def test_missing_or_malformed_raw_source_remains_unknown(raw):
    row = result(guidellm_raw_json=raw)
    assert build_test_evidence(row)["metrics"]["ttft_p99"]["provenance"] == "unknown"


@pytest.mark.parametrize("value", [None, -1, True, "30", float("nan"), float("inf"), 1000000, 10**400])
def test_invalid_optional_latency_has_json_safe_evidence(value):
    row = result(ttft_p99=value)
    evidence = build_test_evidence(row)
    metric = evidence["metrics"]["ttft_p99"]
    assert metric["value"] is None
    assert metric["availability"] != "available"
    json.dumps(evidence, allow_nan=False)
    assert not valid_metric(10**400)


def test_zero_metrics_are_not_missing():
    row = result(ttft_p99=0, itl_p90=0)
    row.guidellm_raw_json = raw_source(row)
    evidence = build_test_evidence(row)
    assert evidence["metrics"]["ttft_p99"]["value"] == 0
    assert evidence["metrics"]["itl_p90"]["value"] == 0
    assert evidence["metrics"]["itl_p90"]["provenance"] == "verified"
    table = ReportAnalyzer().build_all_results_table([row])
    assert table[0]["ttft_p99"] == table[0]["itl_p90"] == 0


def test_long_e2e_is_not_a_ttft_itl_penalty_sentinel():
    row = result(metrics_json='{"throughput_mean": 10, "e2e_latency_p99": 2000}')
    row.guidellm_raw_json = raw_source(row)
    metric = build_test_evidence(row)["metrics"]["e2e_p99"]
    assert metric["value"] == 2000000 and metric["unit"] == "ms"
    assert metric["availability"] == "available" and metric["provenance"] == "verified"


def test_missing_mean_is_compatibility_not_verified_mean():
    row = result(metrics_json="{}")
    metric = build_test_evidence(row)["metrics"]["throughput_mean"]
    assert metric["value"] == 10
    assert metric["kind"] == "compatibility"
    assert metric["statistic"] is None and metric["provenance"] == "unknown"


def test_invalid_mean_cannot_hide_behind_legacy_alias():
    row = result(metrics_json='{"throughput_mean": -1}')
    evidence = build_test_evidence(row)
    assert evidence["metrics"]["throughput_mean"]["value"] is None
    assert evidence["metrics"]["throughput_mean"]["kind"] == "reported"
    assert evidence["eligibility"]["ranking_eligible"] is False


@pytest.mark.parametrize("stored_mean,provenance", [(2, "verified"), (3, "mismatch")])
def test_parser_count_duration_fallback_is_explicit_calculation_not_repair(stored_mean, provenance):
    row = result(metrics_json=json.dumps({"throughput_mean": stored_mean}))
    raw = json.loads(raw_source(row))
    raw["benchmarks"][0]["metrics"]["requests_per_second"]["successful"]["mean"] = 0
    row.guidellm_raw_json = json.dumps(raw)
    before = row.metrics_json
    metric = build_test_evidence(row)["metrics"]["throughput_mean"]
    assert metric["kind"] == "calculated"
    assert metric["provenance"] == provenance
    assert metric["value"] == stored_mean and metric["source_value"] == 2
    assert metric["calculation"] == {
        "name": "successful_requests_per_second_v1",
        "successful_requests": 10,
        "duration_s": 5,
    }
    assert row.metrics_json == before


def test_configured_and_measured_concurrency_are_separate_without_inference():
    row = result(
        test_config_json='{"num_users": 8, "hf_token": "do-not-export", "isl": 100}',
        metrics_json='{"throughput_mean": 10, "concurrency_mean": 3.5}',
    )
    conditions = build_test_evidence(row)["conditions"]
    assert conditions["configured_concurrency"]["value"] == 8
    assert conditions["configured_concurrency"]["kind"] == "configured"
    assert conditions["measured_mean_concurrency"]["value"] == 3.5
    assert "hf_token" not in conditions["workload"]
    assert conditions["baseline_test_config_id"] is None and conditions["comparability"] == "not_verified"
    row.test_config_json = "{}"
    assert build_test_evidence(row)["conditions"]["configured_concurrency"]["value"] is None


@pytest.mark.parametrize("with_raw_column", [False, True])
def test_loader_handles_legacy_and_optional_raw_columns(with_raw_column):
    row = result()
    values = asdict(row)
    if with_raw_column:
        values["guidellm_raw_json"] = raw_source(row)
    else:
        values.pop("guidellm_raw_json")
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
        assert bool(loaded.guidellm_raw_json) is with_raw_column
        provenance = build_test_evidence(loaded, 42)["metrics"]["ttft_p99"]["provenance"]
        assert provenance == ("verified" if with_raw_column else "unknown")


def test_actual_parser_result_can_be_checked_without_p999_substitution(tmp_path):
    row = result()
    raw = json.loads(raw_source(row))
    raw["benchmarks"][0]["metrics"]["time_to_first_token_ms"]["successful"]["percentiles"]["p999"] = 999
    path = tmp_path / "source.json"
    path.write_text(json.dumps(raw))
    benchmark = BenchmarkResult("fixture", "aggregated", True, True, True, True, "2026-01-01")
    ParserMixin._parse_guidellm_results(str(path), benchmark)
    row.ttft_p99 = benchmark.ttft_p99
    row.guidellm_raw_json = benchmark.guidellm_raw_json
    assert build_test_evidence(row)["metrics"]["ttft_p99"]["provenance"] == "verified"
    assert row.ttft_p99 == 30


def test_attachment_uses_immutable_ids_and_does_not_merge_legacy_names():
    rows = [result(1, config_name="shared"), result(2, config_name="shared", ttft_p99=99)]
    report = {
        "all_results": [{"test_config_id": 1}, {"test_config_id": 2}],
        "recommendation": {"config": {"test_config_id": 2}},
        "future": {"test_config_id": []},
    }
    attach_report_evidence(report, rows, 42)
    assert report["report_contract"]["name"] == "serveit.report"
    assert report["report_contract"]["version"] == 1
    assert report["all_results"][0]["run_id"] == 42
    assert report["all_results"][0]["evidence"]["metrics"]["ttft_p99"]["value"] == 30
    assert report["recommendation"]["config"]["evidence"]["metrics"]["ttft_p99"]["value"] == 99
    assert "evidence" not in report["future"]
    json.dumps(report, allow_nan=False)


def test_real_page_loads_shared_model_before_report_consumers(authenticated_client):
    response = authenticated_client.get("/")
    assert response.status_code == 200
    html = response.get_data(as_text=True)
    model = html.index("js/report-model.js")
    for consumer in ("js/modules/report.js", "js/modules/charts.js", "js/report-download.js"):
        assert model < html.index(consumer)
    asset = authenticated_client.get("/static/js/report-model.js")
    assert asset.status_code == 200
    assert "createServeItReportModel" in asset.get_data(as_text=True)
