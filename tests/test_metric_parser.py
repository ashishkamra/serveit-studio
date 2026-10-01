"""Client percentile parsing must not relabel a different tail percentile."""

import json

import pytest

from core.orchestrator.parser import ParserMixin
from core.orchestrator.result import TestResult as BenchmarkResult


@pytest.mark.parametrize("p99", [99.0, 0.0, None, "missing"])
def test_client_p99_is_never_p999(tmp_path, p99):
    metric_fields = {
        "time_to_first_token_ms": "ttft",
        "inter_token_latency_ms": "itl",
        "time_per_output_token_ms": "tpot",
        "request_latency": "e2e_latency",
        "output_tokens_per_second": "output_tps",
    }
    metrics = {}
    for index, key in enumerate(metric_fields):
        percentiles = {"p50": 50 + index, "p90": 90 + index, "p95": 95 + index, "p999": 999 + index}
        if p99 != "missing":
            percentiles["p99"] = p99 + index if p99 is not None else None
        metrics[key] = {"successful": {"mean": 42, "percentiles": percentiles}}
    metrics["request_totals"] = {"total": 10, "successful": 10}
    metrics["requests_per_second"] = {"successful": {"mean": 2, "percentiles": {"p99": 8, "p999": 9}}}
    path = tmp_path / "guidellm.json"
    path.write_text(json.dumps({"benchmarks": [{"metrics": metrics, "duration": 5}]}))
    result = BenchmarkResult("fixture", "aggregated", True, True, True, True, "2026-01-01")
    # Prove parsing clears stale values too, rather than merely using defaults.
    for field in metric_fields.values():
        setattr(result, f"{field}_p99", 12345)
    ParserMixin._parse_guidellm_results(str(path), result)
    for index, field in enumerate(metric_fields.values()):
        expected = None if p99 in (None, "missing") else p99 + index
        assert getattr(result, f"{field}_p99") == expected
        for percentile in (50, 90, 95):
            assert getattr(result, f"{field}_p{percentile}") == percentile + index
    assert result.guidellm_success
    assert json.loads(result.guidellm_raw_json)["benchmarks"][0]["metrics"] == metrics
    # Legacy throughput aliases intentionally remain unchanged in P0.1.
    assert result.throughput_mean == 2
    assert [getattr(result, f"throughput_p{p}") for p in (50, 90, 95, 99)] == [2] * 4
