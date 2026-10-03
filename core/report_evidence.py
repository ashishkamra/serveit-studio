"""Additive report evidence v1. Reading provenance never repairs stored values."""

import json
import math

from core.report_data import valid_metric

CONTRACT_NAME = "serveit.report"
CONTRACT_VERSION = 1
PERCENTILES = ("p50", "p90", "p95", "p99")
WORKLOAD_FIELDS = (
    "isl",
    "osl",
    "num_users",
    "rate_type",
    "turns",
    "prefix_cache_hit_pct",
    "prefix_cache_mode",
    "prefix_cache_groups",
    "enable_prefix_caching",
)


def _object(value):
    try:
        value = json.loads(value) if isinstance(value, str) else value
    except (TypeError, ValueError):
        return {}
    return value if isinstance(value, dict) else {}


def _source_benchmark(result):
    raw = _object(getattr(result, "guidellm_raw_json", None))
    benchmarks = raw.get("benchmarks")
    if not isinstance(benchmarks, list) or not benchmarks:
        return {}
    return _object(benchmarks[0])


def _measurement(
    value,
    unit,
    statistic=None,
    *,
    source_field=None,
    raw_source_field=None,
    raw_value=None,
    raw_present=False,
    scale=1,
    latency=False,
    kind="reported",
):
    valid = valid_metric(value) and valid_metric(value * scale) and (not latency or value * scale < 1000000)
    availability = "available" if valid else ("unavailable" if value is None else "invalid")
    provenance = "unknown"
    if raw_present and valid_metric(raw_value):
        provenance = (
            "verified"
            if valid_metric(raw_value)
            and valid_metric(value)
            and isinstance(value, (int, float))
            and isinstance(raw_value, (int, float))
            and value == raw_value
            else "mismatch"
        )
    return {
        "value": value * scale if valid else None,
        "unit": unit,
        "statistic": statistic,
        "kind": kind,
        "availability": availability,
        "source_field": source_field,
        "raw_source_field": raw_source_field if raw_present else None,
        "provenance": provenance,
        "source_value": raw_value if valid_metric(raw_value) else None,
        "source_unit": "s" if scale == 1000 else unit,
    }


def build_test_evidence(result, run_id=None):
    metrics_json = _object(result.metrics_json)
    test_config = _object(result.test_config_json)
    raw_benchmark = _source_benchmark(result)
    raw_metrics = _object(raw_benchmark.get("metrics"))
    metrics = {}
    for family, source_key, attribute, scale in (
        ("ttft", "time_to_first_token_ms", "ttft", 1),
        ("itl", "inter_token_latency_ms", "itl", 1),
        ("e2e", "request_latency", "e2e_latency", 1000),
    ):
        distribution = _object(_object(raw_metrics.get(source_key)).get("successful"))
        percentiles = _object(distribution.get("percentiles"))
        for percentile in PERCENTILES:
            field = f"{attribute}_{percentile}"
            value = getattr(result, field, None)
            metrics[f"{family}_{percentile}"] = _measurement(
                value,
                "ms",
                percentile,
                scale=scale,
                latency=family in ("ttft", "itl"),
                source_field=f"metrics_json.{field}" if family == "e2e" else f"test_record.{field}",
                raw_source_field=f"guidellm.{source_key}.successful.percentiles.{percentile}",
                raw_value=percentiles.get(percentile),
                raw_present=percentile in percentiles,
            )
    mean = result.throughput_mean
    fallback = mean is None
    throughput = result.throughput_p90 if fallback else mean
    distribution = _object(_object(raw_metrics.get("requests_per_second")).get("successful"))
    metrics["throughput_mean"] = _measurement(
        throughput,
        "req/s",
        None if fallback else "mean",
        source_field="legacy.throughput_p90" if fallback else "metrics_json.throughput_mean",
        raw_source_field="guidellm.requests_per_second.successful.mean",
        kind="compatibility" if fallback else "reported",
        raw_value=distribution.get("mean"),
        raw_present=not fallback and "mean" in distribution,
    )
    # Mirror the existing parser's documented count/duration fallback without
    # changing the stored mean or inventing a mean when only an alias exists.
    successful = _object(raw_metrics.get("request_totals")).get("successful")
    duration = raw_benchmark.get("duration")
    if (
        not fallback
        and distribution.get("mean") in (None, 0)
        and isinstance(successful, (int, float))
        and isinstance(duration, (int, float))
        and valid_metric(successful, positive=True)
        and successful <= 2**53 - 1
        and successful == int(successful)
        and valid_metric(duration, positive=True)
    ):
        derived_rate = successful / duration
        if valid_metric(derived_rate, positive=True):
            metrics["throughput_mean"] = _measurement(
                throughput,
                "req/s",
                "mean",
                kind="calculated",
                source_field="metrics_json.throughput_mean",
                raw_value=derived_rate,
                raw_present=True,
            )
            metrics["throughput_mean"]["raw_source_fields"] = [
                "guidellm.request_totals.successful",
                "guidellm.benchmark.duration",
            ]
            metrics["throughput_mean"]["calculation"] = {
                "name": "successful_requests_per_second_v1",
                "successful_requests": successful,
                "duration_s": duration,
            }
    return {
        "version": CONTRACT_VERSION,
        "source": {"run_id": run_id, "test_config_id": result.id, "test_id": result.config_name},
        "recorded_timestamps": {
            "started_at": result.started_at,
            "completed_at": result.completed_at,
            "source": "test_record",
            "measurement_window_verified": False,
        },
        "resources": {
            "architecture": result.architecture,
            "total_gpus": _measurement(
                result.total_gpus, "GPU", kind="calculated", source_field="test_record.deployment_topology"
            ),
        },
        "eligibility": {
            "ranking_eligible": result.is_ranking_eligible,
            "quality": result.quality,
            "slo_verified": False,
        },
        "conditions": {
            "configured_concurrency": _measurement(
                test_config.get("num_users"), "requests", kind="configured", source_field="test_config.num_users"
            ),
            "measured_mean_concurrency": _measurement(
                metrics_json.get("concurrency_mean"), "requests", "mean", source_field="metrics_json.concurrency_mean"
            ),
            "workload": {
                key: value
                for key in WORKLOAD_FIELDS
                if (value := test_config.get(key)) is not None
                and (not isinstance(value, float) or math.isfinite(value))
                and isinstance(value, (str, int, float, bool))
            },
            "baseline_test_config_id": None,
            "comparability": "not_verified",
        },
        "metrics": metrics,
    }


def attach_report_evidence(report, results, run_id):
    """Attach same-test evidence to existing ID-bearing payloads, without aliases."""
    by_id = {result.id: build_test_evidence(result, run_id) for result in results}

    def attach(value):
        if isinstance(value, dict):
            identity = value.get("test_config_id")
            source = by_id.get(identity) if isinstance(identity, int) and not isinstance(identity, bool) else None
            if source is not None:
                value["evidence"] = source
            for key, child in list(value.items()):
                if key != "evidence":
                    attach(child)
        elif isinstance(value, list):
            for child in value:
                attach(child)

    attach(report)
    for row in report.get("all_results", []):
        row["run_id"] = run_id
    report["report_contract"] = {
        "name": CONTRACT_NAME,
        "version": CONTRACT_VERSION,
        "run_id": run_id,
        "recommendation_rule": "category_p90_not_slo_verification",
        "estimator_calculation": "whole_deployment_linear_v1",
        "historical_policy": "unknown_without_matching_raw_source; never_repair_on_read",
        "compatibility": "legacy_fields_retained",
    }
    return report
