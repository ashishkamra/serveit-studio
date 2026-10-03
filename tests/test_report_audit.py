"""Backup-gated historical raw-source audit/repair regressions."""

import hashlib
import json
import os
import sqlite3

import pytest

from core.report_audit import audit_test_results, repair_test_results

RAW = json.dumps(
    {
        "benchmarks": [
            {
                "metrics": {
                    "time_to_first_token_ms": {
                        "successful": {"percentiles": {"p50": 5, "p90": 10, "p95": 20, "p99": 30}}
                    },
                    "inter_token_latency_ms": {"successful": {"percentiles": {"p50": 1, "p90": 2, "p95": 3, "p99": 4}}},
                    "requests_per_second": {"successful": {"mean": 12}},
                }
            }
        ]
    }
)

COLUMNS = [
    "id INTEGER PRIMARY KEY",
    "run_id INTEGER",
    "config_name TEXT",
    "status TEXT",
    "ttft_p50 REAL",
    "ttft_p90 REAL",
    "ttft_p95 REAL",
    "ttft_p99 REAL",
    "itl_p50 REAL",
    "itl_p90 REAL",
    "itl_p95 REAL",
    "itl_p99 REAL",
    "throughput_p50 REAL",
    "throughput_p90 REAL",
    "throughput_p95 REAL",
    "throughput_p99 REAL",
    "metrics_json TEXT",
    "guidellm_raw_json TEXT",
]


def _make_db(tmp_path, rows, *, with_lineage=True):
    db = str(tmp_path / "serveit.db")
    conn = sqlite3.connect(db)
    conn.row_factory = sqlite3.Row
    columns = list(COLUMNS)
    if with_lineage:
        columns.append("guidellm_raw_lineage TEXT")
    conn.execute("CREATE TABLE test_configurations (" + ", ".join(columns) + ")")
    names = [c.split(" ")[0] for c in columns]
    for row in rows:
        conn.execute(
            f"INSERT INTO test_configurations ({', '.join(names)}) VALUES ({', '.join('?' * len(names))})",
            [row.get(name) for name in names],
        )
    conn.commit()
    conn.close()
    return db


def _row(run_id, config_name, **overrides):
    base = {
        "run_id": run_id,
        "config_name": config_name,
        "status": "completed",
        "ttft_p50": 5,
        "ttft_p90": 10,
        "ttft_p95": 20,
        "ttft_p99": 30,
        "itl_p50": 1,
        "itl_p90": 2,
        "itl_p95": 3,
        "itl_p99": 4,
        "throughput_p50": 12,
        "throughput_p90": 12,
        "throughput_p95": 12,
        "throughput_p99": 12,
        "metrics_json": json.dumps({"marker": "do-not-touch"}),
        "guidellm_raw_json": RAW,
        "guidellm_raw_lineage": "guidellm_output_file",
    }
    base.update(overrides)
    return base


def _hash(path):
    with open(path, "rb") as handle:
        return hashlib.sha256(handle.read()).hexdigest()


def _open(db):
    conn = sqlite3.connect(db)
    conn.row_factory = sqlite3.Row
    return conn


def test_audit_flags_borrowed_p99_and_legacy_rate_but_is_read_only(tmp_path):
    db = _make_db(
        tmp_path,
        [
            _row(1, "step6-borrowed", ttft_p99=999, throughput_p90=10),
            _row(1, "step6-good"),
            _row(1, "step6-noraw", guidellm_raw_json=None),
            _row(1, "step6-badraw", guidellm_raw_json="[]"),
        ],
    )
    before = _hash(db)
    conn = _open(db)
    try:
        result = audit_test_results(conn, 1)
    finally:
        conn.close()
    by_name = {r["config_name"]: r for r in result}
    borrowed = by_name["step6-borrowed"]
    assert borrowed["status"] == "repairable"
    assert borrowed["fields"]["ttft_p99"] == {
        "stored": 999,
        "raw": 30,
        "action": "correct",
        "reason": "exact_source_correction",
    }
    assert borrowed["fields"]["throughput_p90"]["action"] == "correct"
    assert by_name["step6-good"]["status"] == "ok"
    assert by_name["step6-good"]["fields"]["ttft_p99"]["action"] == "keep"
    assert by_name["step6-noraw"]["status"] == "no_raw"
    assert by_name["step6-noraw"]["fields"]["ttft_p99"]["action"] == "skip"
    assert by_name["step6-badraw"]["raw_present"] is False
    assert _hash(db) == before
    assert not list(tmp_path.iterdir()) or (tmp_path / "backups") not in tmp_path.iterdir()


def test_audit_omits_other_runs(tmp_path):
    db = _make_db(tmp_path, [_row(1, "step6-good"), _row(2, "step6-other", ttft_p99=1)])
    conn = _open(db)
    try:
        result = audit_test_results(conn, 2)
    finally:
        conn.close()
    assert [r["config_name"] for r in result] == ["step6-other"]


def test_repair_dry_run_changes_nothing(tmp_path):
    db = _make_db(tmp_path, [_row(1, "step6-broken", ttft_p99=999, throughput_p90=None, ttft_p95=None)])
    before = _hash(db)
    summary = repair_test_results(db, run_id=1, dry_run=True)
    assert summary["dry_run"] is True
    assert summary["backup_file"] is None
    assert summary["applied"] is False
    planned = {c["field"]: c["source"] for c in summary["changes"]}
    assert planned["ttft_p95"] == "exact_source_fill"
    assert planned["ttft_p99"] == "exact_source_correction"
    assert _hash(db) == before
    assert not (tmp_path / "backups").exists()


def test_repair_applies_only_after_verified_backup_and_logs_changes(tmp_path):
    db = _make_db(tmp_path, [_row(1, "step6-broken", ttft_p99=999, throughput_p90=None)])
    summary = repair_test_results(db, run_id=1, dry_run=False)
    assert summary["applied"] is True
    backup = summary["backup_file"]
    assert os.path.exists(backup)
    backup_conn = _open(backup)
    try:
        stored = backup_conn.execute("SELECT ttft_p99 FROM test_configurations").fetchone()[0]
        assert stored == 999
        assert backup_conn.execute("PRAGMA integrity_check").fetchone()[0] == "ok"
    finally:
        backup_conn.close()
    conn = _open(db)
    try:
        row = conn.execute("SELECT ttft_p99, throughput_p90, metrics_json FROM test_configurations").fetchone()
        assert row["ttft_p99"] == 30
        assert row["throughput_p90"] == 12
        assert json.loads(row["metrics_json"]) == {"marker": "do-not-touch"}
        log = conn.execute("SELECT * FROM raw_source_repairs ORDER BY id").fetchall()
        assert {l["field"] for l in log} == {"ttft_p99", "throughput_p90"}
        assert all(l["backup_file"] == backup and l["batch_id"] == summary["batch_id"] for l in log)
        by_field = {l["field"]: l for l in log}
        assert by_field["ttft_p99"]["old_value"] == 999 and by_field["ttft_p99"]["new_value"] == 30
        rechecked = audit_test_results(conn, 1)
        assert rechecked[0]["status"] == "ok"
        assert rechecked[0]["fields"]["ttft_p99"]["action"] == "keep"
    finally:
        conn.close()


def test_repair_never_touches_rows_without_raw(tmp_path):
    db = _make_db(tmp_path, [_row(1, "step6-noraw", ttft_p99=7, guidellm_raw_json=None)])
    summary = repair_test_results(db, dry_run=False)
    assert summary["changes"] == []
    assert summary["rows_no_raw"] == 1
    backup = _open(summary["backup_file"])
    live = _open(db)
    try:
        assert backup.execute("SELECT ttft_p99 FROM test_configurations").fetchone()[0] == 7
        assert live.execute("SELECT ttft_p99 FROM test_configurations").fetchone()[0] == 7
    finally:
        backup.close()
        live.close()


def test_repair_refuses_missing_database(tmp_path):
    with pytest.raises(FileNotFoundError):
        repair_test_results(str(tmp_path / "absent.db"))
    assert not (tmp_path / "backups").exists()


def test_audit_works_on_schema_without_lineage_column(tmp_path):
    db = _make_db(tmp_path, [_row(1, "step6-old-schema", ttft_p99=999)], with_lineage=False)
    conn = _open(db)
    try:
        result = audit_test_results(conn, 1)
    finally:
        conn.close()
    assert result[0]["lineage"] is None
    assert result[0]["status"] == "repairable"
    assert result[0]["fields"]["ttft_p99"]["action"] == "correct"


def test_cli_audit_and_repair_apply(tmp_path, monkeypatch, capsys):
    from cli import inftune

    db = _make_db(tmp_path, [_row(1, "step6-broken", ttft_p99=999)])
    monkeypatch.setattr("sys.argv", ["serveit", "report", "audit", "--db", db, "--json"])
    assert inftune.main() == 0
    audit = json.loads(capsys.readouterr().out)
    assert audit["rows_audited"] == 1
    assert audit["rows_repairable"] == 1
    audit_before = _hash(db)

    monkeypatch.setattr("sys.argv", ["serveit", "report", "repair", "--db", db, "--json"])
    assert inftune.main() == 0
    dry = json.loads(capsys.readouterr().out)
    assert dry["dry_run"] is True and dry["backup_file"] is None
    assert _hash(db) == audit_before

    monkeypatch.setattr("sys.argv", ["serveit", "report", "repair", "--db", db, "--json", "--apply"])
    assert inftune.main() == 0
    applied = json.loads(capsys.readouterr().out)
    assert applied["applied"] is True
    assert applied["changes"][0]["field"] == "ttft_p99"
    conn = _open(db)
    try:
        assert conn.execute("SELECT ttft_p99 FROM test_configurations").fetchone()[0] == 30
    finally:
        conn.close()
