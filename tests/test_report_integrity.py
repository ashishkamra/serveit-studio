"""Deterministic report trust checks, without cluster or GPU services."""

import json
import sqlite3
from dataclasses import replace
from types import SimpleNamespace

import pytest

from core.report_analysis import ReportAnalyzer
from core.report_data import TestResult as ReportResult
from core.report_renderer import ReportRenderer


def result(test_id=1, **overrides):
    fields = dict(
        id=test_id,
        config_name=f"step6-agg-{test_id}",
        architecture="aggregated",
        prefill_pods=1,
        decode_pods=0,
        tensor_parallelism=1,
        prefill_tp=None,
        decode_tp=None,
        status="completed",
        ttft_p50=5,
        ttft_p90=10,
        ttft_p95=20,
        ttft_p99=30,
        itl_p50=1,
        itl_p90=2,
        itl_p95=3,
        itl_p99=4,
        throughput_p50=10,
        throughput_p90=10,
        throughput_p95=10,
        throughput_p99=10,
        gpu_utilization=None,
        kv_cache_usage=None,
        started_at=None,
        completed_at=None,
        manifests_yaml=None,
        test_config_json=json.dumps({"num_users": 4}),
        metrics_json=json.dumps(
            {
                "throughput_mean": 10,
                "output_tps_mean": 100,
                "e2e_latency_p50": 1,
                "e2e_latency_p90": 2,
                "e2e_latency_p95": 3,
                "e2e_latency_p99": 4,
            }
        ),
    )
    fields.update(overrides)
    return ReportResult(**fields)


@pytest.fixture
def conn():
    db = sqlite3.connect(":memory:")
    db.row_factory = sqlite3.Row
    db.execute("""CREATE TABLE optimization_runs (
        id INTEGER PRIMARY KEY, model TEXT, isl INTEGER, osl INTEGER, num_users INTEGER,
        goal TEXT, constraint_notes TEXT, created_at TEXT, completed_at TEXT,
        isl_stdev REAL, osl_stdev REAL, config_json TEXT, optimal_config TEXT, max_gpus INTEGER
    )""")
    db.execute("""INSERT INTO optimization_runs (id, model, isl, osl, num_users, goal, config_json)
                  VALUES (1, 'fixture', 100, 100, 4, 'ttft', '{}')""")
    yield db
    db.close()


def test_discarded_winner_excluded_but_diagnostics_retained(conn):
    excluded = result(
        1,
        quality="discard",
        ttft_p90=1,
        ttft_p99=1,
        itl_p90=0.1,
        throughput_p90=100,
        metrics_json='{"throughput_mean": 100, "output_tps_mean": 1000}',
    )
    warning = result(2, quality="warning")
    analyzer = ReportAnalyzer()
    rows = [excluded, warning]
    assert excluded.is_successful and not excluded.is_ranking_eligible
    assert warning.is_ranking_eligible
    stats = analyzer.get_summary_statistics(rows)
    assert stats["successful_tests"] == 2
    assert stats["eligible_tests"] == 1
    for category in ("lowest_latency", "lowest_itl", "highest_throughput", "most_efficient"):
        assert stats["best_configs"][category]["test_config_id"] == warning.id
    assert stats["by_architecture"]["aggregated"]["best_ttft"] == warning.ttft_p90
    pareto = analyzer.calculate_pareto_frontier(rows)
    assert [p.config.id for p in pareto] == [warning.id]
    rec = analyzer.build_recommendation(1, rows, conn)
    for recommendation in rec["recommendations"].values():
        assert recommendation["config"]["test_config_id"] == warning.id
    for winners in rec["best_by_percentile"].values():
        for entry in winners["aggregated"].values():
            assert entry["test_config_id"] == warning.id
    charts = analyzer.build_chart_data(rows, pareto, stats)
    assert charts["efficiency"]["test_ids"] == [warning.config_name]
    assert charts["per_user_efficiency"]["test_ids"] == [warning.config_name]
    diagnostics = analyzer.build_all_results_table(rows)
    assert {r["test_config_id"] for r in diagnostics} == {1, 2}
    assert diagnostics[0]["quality"] == "discard"
    assert diagnostics[0]["is_ranking_eligible"] is False


@pytest.mark.parametrize("rows", [[], [result(quality="discard")], [result(status="failed")]])
def test_no_eligible_results(rows, conn):
    analyzer = ReportAnalyzer()
    stats = analyzer.get_summary_statistics(rows)
    assert stats["eligible_tests"] == 0
    assert "best_configs" not in stats
    assert analyzer.calculate_pareto_frontier(rows) == []
    rec = analyzer.build_recommendation(1, rows, conn)
    assert rec["recommendations"] == {}
    assert rec["best_by_percentile"] == {}
    assert analyzer._build_calibrated_best(rows) is None
    assert analyzer._build_cache_sweep_best(rows) is None
    charts = analyzer.build_chart_data(rows, [], stats)
    assert charts["efficiency"]["values"] == []


@pytest.mark.parametrize("prefix", ["step2-", "step3-"])
def test_calibration_ranking_excludes_discarded(prefix, conn):
    excluded = result(1, config_name=prefix + "discard", quality="discard", ttft_p90=1)
    warning = result(2, config_name=prefix + "warning", quality="warning", tensor_parallelism=2)
    analyzer = ReportAnalyzer()
    rec = analyzer.build_recommendation(1, [excluded, warning], conn)
    role = "decode" if prefix == "step2-" else "prefill"
    assert rec[f"optimal_{role}_tp"]["test_config_id"] == warning.id
    assert len(rec[f"{role}_tp_all"]) == 1
    stats = analyzer.get_summary_statistics([excluded, warning])
    assert "best_configs" not in stats  # Calibration is not a workload recommendation.
    traces = analyzer.build_chart_data([], [], stats, [excluded, warning])["pareto"]["traces"]
    assert traces[0]["y"] == [warning.ttft_p90]


@pytest.mark.parametrize(
    "prefix,method", [("step11-sweep-", "_build_calibrated_best"), ("step13-", "_build_cache_sweep_best")]
)
def test_sweep_recommendations_use_eligible_same_test_evidence(prefix, method):
    excluded = result(1, config_name=prefix + "discard", quality="discard", ttft_p90=1)
    warning = result(2, config_name=prefix + "warning", quality="warning")
    entries = getattr(ReportAnalyzer(), method)([excluded, warning])
    for entry in entries.values():
        assert_same_test(entry, warning)


def assert_same_test(entry, row):
    assert entry["test_id"] == row.config_name
    assert entry["test_config_id"] == row.id
    for p in (50, 90, 95, 99):
        assert entry[f"ttft_p{p}"] == getattr(row, f"ttft_p{p}")
        assert entry[f"itl_p{p}"] == getattr(row, f"itl_p{p}")
        assert entry[f"e2e_p{p}"] == getattr(row, f"e2e_latency_p{p}") * 1000


@pytest.mark.parametrize("arch", ["aggregated", "pd", "ep"])
def test_percentile_winners_do_not_mix_card_evidence(arch, conn):
    rows = [
        result(1, architecture=arch, ttft_p90=10, ttft_p95=90, ttft_p99=100),
        result(2, architecture=arch, ttft_p90=20, ttft_p95=30, ttft_p99=90),
        result(3, architecture=arch, ttft_p90=30, ttft_p95=40, ttft_p99=50),
    ]
    rec = ReportAnalyzer().build_recommendation(1, rows, conn)
    for p, row in zip((90, 95, 99), rows):
        entry = rec["best_by_percentile"][f"p{p}"][arch]["lowest_ttft"]
        assert_same_test(entry, row)
    for entry in rec["recommendations"].values():
        source = next(r for r in rows if r.id == entry["config"]["test_config_id"])
        assert_same_test(entry["config"], source)


@pytest.mark.parametrize("bad", [None, float("nan"), float("inf"), -float("inf"), -1, 1000000])
def test_invalid_tail_cannot_win_pareto_or_percentile_ranking(bad, conn):
    invalid = result(1, ttft_p95=bad, ttft_p99=bad)
    valid = result(2, ttft_p90=20)
    analyzer = ReportAnalyzer()
    assert [p.config.id for p in analyzer.calculate_pareto_frontier([invalid, valid])] == [valid.id]
    rec = analyzer.build_recommendation(1, [invalid, valid], conn)
    for p in (95, 99):
        entries = rec["best_by_percentile"][f"p{p}"]["aggregated"]
        assert all(entry["test_config_id"] == valid.id for entry in entries.values())
    assert analyzer.calculate_pareto_frontier([invalid]) == []
    assert "p99" not in analyzer.build_recommendation(1, [invalid], conn)["best_by_percentile"]


@pytest.mark.parametrize("bad", [float("nan"), float("inf"), -float("inf")])
@pytest.mark.parametrize("field", ["ttft_p90", "throughput_p90", "throughput_mean"])
def test_nonfinite_base_metrics_never_rank(field, bad, conn):
    overrides = {field: bad} if field != "throughput_mean" else {"metrics_json": json.dumps({field: bad})}
    invalid = result(1, **overrides)
    valid = result(2)
    assert not invalid.is_ranking_eligible
    analyzer = ReportAnalyzer()
    assert (
        analyzer.get_summary_statistics([invalid, valid])["best_configs"]["highest_throughput"]["test_config_id"] == 2
    )
    assert analyzer.build_recommendation(1, [invalid], conn)["recommendations"] == {}
    assert analyzer.calculate_pareto_frontier([invalid]) == []


@pytest.mark.parametrize("bad", [None, float("nan"), float("inf"), -float("inf")])
def test_invalid_itl_never_wins_lowest_itl(bad, conn):
    invalid = result(1, itl_p90=bad, itl_p95=bad, itl_p99=bad)
    valid = result(2)
    analyzer = ReportAnalyzer()
    assert analyzer.get_summary_statistics([invalid, valid])["best_configs"]["lowest_itl"]["test_config_id"] == 2
    rec = analyzer.build_recommendation(1, [invalid, valid], conn)
    for entries in rec["best_by_percentile"].values():
        assert entries["aggregated"]["lowest_itl"]["test_config_id"] == 2
    assert analyzer.get_summary_statistics([invalid])["best_configs"]["lowest_itl"] is None


@pytest.mark.parametrize("metric", ["ttft_p99", "ttft_p95", "ttft_p90"])
def test_pareto_values_and_renderer_labels_match_objective(metric, tmp_path):
    row = result()
    analyzer = ReportAnalyzer()
    pareto = analyzer.calculate_pareto_frontier([row], metric=metric)
    assert pareto[0].ttft == getattr(row, metric)
    stats = analyzer.get_summary_statistics([row])
    table = analyzer.build_chart_data([row], pareto, stats)["pareto"]["pareto_table"][0]
    assert table["ttft_p90"] == 10
    assert table["ttft_p99"] == 30
    assert table["latency_metric"] == metric
    label = metric.replace("_", " ").upper()
    renderer = ReportRenderer()
    markdown = renderer.generate_markdown_report([row], pareto, stats, str(tmp_path / "report.md"))
    assert f"| Configuration | {label} (ms)" in markdown
    pytest.importorskip("plotly")
    chart = renderer.create_pareto_frontier_chart(pareto)
    assert chart.layout.yaxis.title.text == f"{label} (ms)"
    assert list(chart.data[0].y) == [getattr(row, metric)]
    html = renderer.generate_html_report([row], pareto, stats, str(tmp_path / "report.html"))
    assert f"<th>{label} (ms)</th>" in html


def test_full_report_retains_excluded_diagnostics_not_epp_or_calibrated_winners(conn):
    excluded = result(1, quality="discard", config_name="step11-epp-pd-discard", architecture="pd")
    valid = result(2, config_name="step11-epp-pd-warning", architecture="pd", quality="warning")
    baseline = result(3, architecture="pd")
    discarded_baseline = result(4, quality="discard", architecture="pd", ttft_p99=1)
    calibrated = result(5, config_name="step10-pd-warning", architecture="pd", quality="warning")
    discarded_cal = replace(calibrated, id=6, config_name="step10-pd-discard", quality="discard", ttft_p90=1)
    rows = [excluded, valid, baseline, discarded_baseline, discarded_cal, calibrated]
    loader = SimpleNamespace(conn=conn, get_all_test_results=lambda _: rows)
    report = ReportAnalyzer().build_full_report_data(1, loader)
    assert len(report["all_results"]) == len(rows)
    assert report["calibrated_qps"]["pd"]["test_config_id"] == calibrated.id
    epp = report["epp_tuning"]["by_architecture"]["pd"]
    assert {r["test_id"] for r in epp} == {valid.config_name, baseline.config_name}


def test_lowest_itl_has_its_own_winner(conn):
    low_ttft = result(1, ttft_p90=1, itl_p90=10, itl_p95=11, itl_p99=12)
    low_itl = result(2, ttft_p90=10, itl_p90=1, itl_p95=2, itl_p99=3)
    rec = ReportAnalyzer().build_recommendation(1, [low_ttft, low_itl], conn)
    for entries in rec["best_by_percentile"].values():
        assert_same_test(entries["aggregated"]["lowest_itl"], low_itl)
    stats = ReportAnalyzer().get_summary_statistics([low_ttft, low_itl])
    assert stats["best_configs"]["lowest_itl"]["test_config_id"] == low_itl.id


def test_zero_latency_is_measured_not_missing(conn):
    zero = result(1, ttft_p50=0, ttft_p90=0, ttft_p95=0, ttft_p99=0, itl_p50=0, itl_p90=0, itl_p95=0, itl_p99=0)
    other = result(2)
    analyzer = ReportAnalyzer()
    rec = analyzer.build_recommendation(1, [other, zero], conn)
    for entries in rec["best_by_percentile"].values():
        for category in ("balanced", "lowest_ttft", "lowest_itl"):
            assert_same_test(entries["aggregated"][category], zero)
    for prefix, method in (("step11-sweep-", "_build_calibrated_best"), ("step13-", "_build_cache_sweep_best")):
        rows = [replace(other, config_name=prefix + "other"), replace(zero, config_name=prefix + "zero")]
        entries = getattr(analyzer, method)(rows)
        assert entries["lowest_ttft"]["ttft_p90"] == 0
        assert entries["lowest_itl"]["itl_p90"] == 0
    pareto = analyzer.calculate_pareto_frontier([other, zero])
    assert [p.config.id for p in pareto] == [zero.id]
    table = analyzer.build_chart_data([zero], pareto, {})["pareto"]["pareto_table"]
    assert table[0]["ttft_p99"] == 0


@pytest.mark.parametrize("bad", [None, float("nan"), float("inf"), -float("inf"), 0, -1])
def test_custom_pareto_throughput_requires_finite_positive_metric(bad):
    invalid = result(1, throughput_p99=bad)
    valid = result(2)
    pareto = ReportAnalyzer().calculate_pareto_frontier([invalid, valid], throughput_metric="throughput_p99")
    assert [p.config.id for p in pareto] == [valid.id]


def test_missing_p99_comparison_is_unknown_not_p90(conn):
    pd = result(1, architecture="pd")
    agg = result(2, ttft_p99=None)
    rec = ReportAnalyzer().build_recommendation(1, [pd, agg], conn)
    assert rec["pd_vs_agg"]["ttft_p99_winner"] is None
    assert rec["pd_vs_agg"]["ttft_p99_diff_pct"] is None
    assert rec["aggregated_baseline"]["ttft_p99"] is None
    assert rec["aggregated_baseline"]["percentiles"]["ttft"]["p99"] is None


def test_invalid_optional_card_metrics_are_unavailable(conn):
    row = result(
        ttft_p99=float("nan"),
        itl_p99=float("inf"),
        metrics_json=json.dumps({"throughput_mean": 10, "e2e_latency_p99": float("inf")}),
    )
    analyzer = ReportAnalyzer()
    rec = analyzer.build_recommendation(1, [row], conn)
    for recommendation in rec["recommendations"].values():
        entry = recommendation["config"]
        assert entry["ttft_p99"] is None
        assert entry["itl_p99"] is None
        assert entry["e2e_p99"] is None
    json.dumps(rec, allow_nan=False)
    stats = analyzer.get_summary_statistics([row])
    assert stats["best_configs"]["lowest_latency"]["ttft_p99"] is None


def test_all_excluded_full_report_still_has_diagnostics(conn):
    rows = [result(quality="discard")]
    loader = SimpleNamespace(conn=conn, get_all_test_results=lambda _: rows)
    report = ReportAnalyzer().build_full_report_data(1, loader)
    assert report["summary"]["successful_tests"] == 1
    assert report["summary"]["eligible_tests"] == 0
    assert len(report["all_results"]) == 1
    assert report["recommendation"]["recommendations"] == {}
    assert report["charts"]["pareto"]["pareto_table"] == []


def test_missing_mean_keeps_legacy_throughput_ranking():
    analyzer = ReportAnalyzer()
    slow = result(1, config_name="step11-sweep-slow", throughput_p90=5, metrics_json="{}")
    fast = result(2, config_name="step11-sweep-fast", throughput_p90=10, metrics_json="{}")
    assert slow.is_ranking_eligible and fast.is_ranking_eligible
    assert analyzer._build_calibrated_best([slow, fast])["highest_tput"]["test_config_id"] == fast.id


def test_zero_gpu_cannot_rank_but_diagnostic_table_is_safe():
    row = result(prefill_pods=0, decode_pods=0)
    assert row.is_successful and not row.is_ranking_eligible
    assert ReportAnalyzer().build_all_results_table([row])[0]["efficiency"] is None
