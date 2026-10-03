"""Opt-in historical raw-source audit and repair for stored percentile values.

Every audit path is read-only. Repair requires an explicit request, backs up
the database file (and verifies the backup) before any write, applies only
exact-agreement changes against a preserved raw GUIDELLM reference, and records
every change in the additive ``raw_source_repairs`` table. Rows without a
preserved raw reference are never repaired or reinterpreted.
"""

import json
import shutil
import sqlite3
import uuid
from datetime import datetime
from typing import Optional

_MISSING = object()


def _valid_unit(value, *, latency=False, positive=False):
    import math

    if not isinstance(value, (int, float)) or isinstance(value, bool):
        return False
    try:
        return math.isfinite(value) and (value > 0 if positive else value >= 0) and (not latency or value < 1000000)
    except OverflowError:
        return False


def _raw_benchmark(row):
    try:
        raw = row["guidellm_raw_json"]
    except (IndexError, KeyError):
        return None, False
    if not raw:
        return None, False
    try:
        parsed = json.loads(raw) if isinstance(raw, str) else raw
    except (TypeError, ValueError):
        return None, False
    if not isinstance(parsed, dict):
        return None, False
    benchmarks = parsed.get("benchmarks")
    if not isinstance(benchmarks, list) or not benchmarks or not isinstance(benchmarks[0], dict):
        return None, False
    return benchmarks[0], True


_LATENCY_FIELDS = (
    ("ttft_p50", "time_to_first_token_ms", "p50"),
    ("ttft_p90", "time_to_first_token_ms", "p90"),
    ("ttft_p95", "time_to_first_token_ms", "p95"),
    ("ttft_p99", "time_to_first_token_ms", "p99"),
    ("itl_p50", "inter_token_latency_ms", "p50"),
    ("itl_p90", "inter_token_latency_ms", "p90"),
    ("itl_p95", "inter_token_latency_ms", "p95"),
    ("itl_p99", "inter_token_latency_ms", "p99"),
)
_THROUGHPUT_COLUMNS = ("throughput_p50", "throughput_p90", "throughput_p95", "throughput_p99")


def _get(row, key):
    try:
        return row[key]
    except (IndexError, KeyError):
        return _MISSING


def _audit_row(row, run_id_filter):
    test_config_id = row["id"]
    run_id = row["run_id"]
    if run_id_filter is not None and run_id != run_id_filter:
        return None
    lineage = _get(row, "guidellm_raw_lineage")
    lineage = lineage if lineage is not _MISSING else None
    benchmark, raw_present = _raw_benchmark(row)
    raw_metrics = benchmark.get("metrics") if isinstance(benchmark, dict) else None
    fields = {}
    actions = 0
    if raw_present and isinstance(raw_metrics, dict):
        for column, source_key, percentile in _LATENCY_FIELDS:
            stored = _get(row, column)
            stored = None if stored is _MISSING else stored
            distribution = raw_metrics.get(source_key)
            percentiles = (
                distribution.get("successful", {}).get("percentiles", {}) if isinstance(distribution, dict) else {}
            )
            raw_value = (
                percentiles.get(percentile) if isinstance(percentiles, dict) and percentile in percentiles else None
            )
            if not _valid_unit(raw_value, latency=True):
                fields[column] = {"stored": stored, "raw": None, "action": "skip", "reason": "no_usable_raw"}
                continue
            if stored is None:
                fields[column] = {"stored": None, "raw": raw_value, "action": "fill", "reason": "exact_source_fill"}
                actions += 1
                continue
            if stored == raw_value:
                fields[column] = {"stored": stored, "raw": raw_value, "action": "keep", "reason": "exact_agreement"}
            else:
                fields[column] = {
                    "stored": stored,
                    "raw": raw_value,
                    "action": "correct",
                    "reason": "exact_source_correction",
                }
                actions += 1
        rps = raw_metrics.get("requests_per_second")
        rps_mean = rps.get("successful", {}).get("mean") if isinstance(rps, dict) else None
        for column in _THROUGHPUT_COLUMNS:
            stored = _get(row, column)
            stored = None if stored is _MISSING else stored
            if not _valid_unit(rps_mean) or rps_mean == 0:
                fields[column] = {"stored": stored, "raw": None, "action": "skip", "reason": "no_usable_raw"}
                continue
            if stored is None:
                fields[column] = {"stored": None, "raw": rps_mean, "action": "fill", "reason": "exact_source_fill"}
                actions += 1
            elif stored == rps_mean:
                fields[column] = {"stored": stored, "raw": rps_mean, "action": "keep", "reason": "exact_agreement"}
            else:
                fields[column] = {
                    "stored": stored,
                    "raw": rps_mean,
                    "action": "correct",
                    "reason": "exact_source_correction",
                }
                actions += 1
    if not raw_present or not isinstance(raw_metrics, dict):
        columns = [c for c, _, _ in _LATENCY_FIELDS] + list(_THROUGHPUT_COLUMNS)
        for column in columns:
            stored = _get(row, column)
            stored = None if stored is _MISSING else stored
            if stored is not None:
                fields[column] = {"stored": stored, "raw": None, "action": "skip", "reason": "no_usable_raw"}
    status = "repairable" if actions else ("no_raw" if not raw_present else "ok")
    return {
        "test_config_id": test_config_id,
        "run_id": run_id,
        "config_name": row["config_name"],
        "lineage": lineage,
        "raw_present": raw_present,
        "status": status,
        "fields": fields,
    }


def audit_test_results(conn: sqlite3.Connection, run_id: Optional[int] = None):
    """Read-only audit of stored percentiles against preserved raw sources."""
    cursor = conn.execute("SELECT * FROM test_configurations ORDER BY run_id, id")
    rows = []
    for row in cursor.fetchall():
        audited = _audit_row(row, run_id)
        if audited is not None:
            rows.append(audited)
    return rows


def _backup_database(db_file: str, backup_dir: Optional[str]) -> str:
    import os

    target_dir = backup_dir or os.path.join(os.path.dirname(os.path.abspath(db_file)), "backups")
    os.makedirs(target_dir, exist_ok=True)
    stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    backup_path = os.path.join(target_dir, f"serveit-backup-{stamp}-{uuid.uuid4().hex[:8]}.sqlite")
    shutil.copy2(db_file, backup_path)
    check = sqlite3.connect(backup_path)
    try:
        result = check.execute("PRAGMA integrity_check").fetchone()
    finally:
        check.close()
    if not result or result[0] != "ok":
        raise RuntimeError(f"backup integrity check failed for {backup_path}")
    return backup_path


def repair_test_results(
    db_path: str,
    run_id: Optional[int] = None,
    backup_dir: Optional[str] = None,
    dry_run: bool = False,
) -> dict:
    """Plan (dry_run) or apply a backup-gated exact-source repair."""
    import os

    if not os.path.exists(db_path):
        raise FileNotFoundError(db_path)
    backup_file = None
    if not dry_run:
        backup_file = _backup_database(db_path, backup_dir)

    batch_id = uuid.uuid4().hex
    now = datetime.now().isoformat()
    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    applied = []
    try:
        audited_rows = audit_test_results(conn, run_id)
        for item in audited_rows:
            for column, detail in item["fields"].items():
                if detail["action"] not in ("fill", "correct"):
                    continue
                change = {
                    "run_id": item["run_id"],
                    "test_config_id": item["test_config_id"],
                    "config_name": item["config_name"],
                    "field": column,
                    "old_value": detail["stored"],
                    "new_value": detail["raw"],
                    "raw_value": detail["raw"],
                    "source": detail["reason"],
                }
                applied.append(change)
                if not dry_run:
                    conn.execute(
                        f"UPDATE test_configurations SET {column} = ? WHERE id = ? AND run_id = ?",
                        (detail["raw"], item["test_config_id"], item["run_id"]),
                    )
        if not dry_run and applied:
            conn.execute(
                """CREATE TABLE IF NOT EXISTS raw_source_repairs (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    batch_id TEXT NOT NULL,
                    backup_file TEXT,
                    run_id INTEGER NOT NULL,
                    test_config_id INTEGER NOT NULL,
                    config_name TEXT,
                    field TEXT NOT NULL,
                    old_value REAL,
                    new_value REAL NOT NULL,
                    raw_value REAL NOT NULL,
                    source TEXT NOT NULL,
                    created_at TEXT NOT NULL
                )"""
            )
            conn.executemany(
                "INSERT INTO raw_source_repairs (batch_id, backup_file, run_id, test_config_id,"
                " config_name, field, old_value, new_value, raw_value, source, created_at)"
                " VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                [
                    (
                        batch_id,
                        backup_file,
                        c["run_id"],
                        c["test_config_id"],
                        c["config_name"],
                        c["field"],
                        c["old_value"],
                        c["new_value"],
                        c["raw_value"],
                        c["source"],
                        now,
                    )
                    for c in applied
                ],
            )
        conn.commit()
    finally:
        conn.close()

    no_raw = sum(1 for item in audited_rows if item["status"] == "no_raw")
    return {
        "dry_run": dry_run,
        "backup_file": backup_file,
        "batch_id": batch_id,
        "run_id": run_id,
        "rows_audited": len(audited_rows),
        "rows_no_raw": no_raw,
        "applied": (not dry_run),
        "changes": applied,
    }
