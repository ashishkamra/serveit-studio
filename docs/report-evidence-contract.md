# Report evidence contract v1

This is the first additive contract for browser report recommendations and sizing.
It is not a historical migration, full API schema validator, production SLO
certificate, or a replacement for every legacy chart/report pipeline.

## Envelope and compatibility

`ReportAnalyzer.build_full_report_data` adds this envelope to available reports:

```json
{
  "report_contract": {
    "name": "serveit.report",
    "version": 1,
    "run_id": 42,
    "recommendation_rule": "category_p90_not_slo_verification",
    "estimator_calculation": "whole_deployment_linear_v1",
    "historical_policy": "unknown_without_matching_raw_source; never_repair_on_read",
    "compatibility": "legacy_fields_retained"
  }
}
```

The reader requires the name, numeric version, positive safe-integer run ID,
supported recommendation/calculation policies, and an `all_results` array.
Each versioned source row must have valid evidence with matching run/test
identities. ID-bearing recommendation evidence is checked too, not just the
diagnostic rows. Unknown declared versions/policies, null/partial envelopes,
and mismatched sources fail closed rather than silently using legacy rules.
Additional unrelated properties are allowed; interpreting a new policy requires
a supported version, not an optimistic fallback.

A report **without** `report_contract` remains a legacy unversioned payload.
Legacy numeric behavior and aliases remain compatible, with an explicit notice
that source provenance and units are unverified. This compatibility path is not
a source-provenance guarantee. Backend-generated reports now declare v1 even
when their original records are historical.

## Same-test evidence

Existing immutable-ID-bearing payloads receive `evidence` from the corresponding
test record. Legacy fields are retained. Same-named records are never used as
the identity for attaching evidence.

| Field | Meaning |
| --- | --- |
| `version` | Evidence version, currently numeric `1` |
| `source.run_id` | Source optimization run |
| `source.test_config_id` | Immutable database test primary key |
| `source.test_id` | Legacy stored configuration identifier, not a display name |
| `raw_source.stored` | Whether a preserved raw GUIDELLM-shaped artifact exists for this record |
| `raw_source.lineage` | Explicit capture lineage: `guidellm_output_file` (guidellm's own output), `reconstituted_parse_guidellm` (reconstituted from `parse_guidellm` extraction), or `unrecorded` when preserved without a lineage record; never inferred |
| `recorded_timestamps` | Database-record timestamps; **not** a certified benchmark collection window |
| `resources.architecture` | Architecture recorded for this source |
| `resources.total_gpus` | Whole-deployment GPU count **calculated** from deployment topology |
| `eligibility` | Ranking eligibility and quality, separate from completion and SLO verification |
| `conditions.configured_concurrency` | Only explicit per-test `num_users`; never inferred from measured average |
| `conditions.measured_mean_concurrency` | Reported `metrics_json.concurrency_mean`, without integer rounding |
| `conditions.workload` | Allowlisted per-test workload/cache settings; no guessed defaults or credentials |
| `conditions.baseline_test_config_id` | Currently null; a matched baseline is not manufactured |
| `conditions.comparability` | Currently `not_verified` |
| `metrics` | Typed values, source references, availability, and provenance |

`eligibility.slo_verified` is false. Category ranking does not verify all user
constraints. Warning-quality results may rank; explicit canonical, compatibility,
or structured eligibility denials cannot become an allow. The shared reader also
rechecks usable base TTFT, positive rate, and integral GPU counts.

## Metric descriptors and units

Initial metric keys are TTFT, ITL and E2E `p50/p90/p95/p99`, plus `throughput_mean`.
Each descriptor records:

- `value`: canonical finite, nonnegative numeric value, or null.
- `unit`: `ms` for canonical latency; `req/s` for request rate.
- `statistic`: exact percentile or mean; null for a compatibility rate alias.
- `kind`: `reported`, `calculated`, or `compatibility` for these metrics.
- `availability`: `available`, `unavailable`, or `invalid`.
- `source_field`: record/metrics field supplying the stored value.
- `raw_source_field` or `raw_source_fields`: available preserved JSON references
  used for comparison, not an assertion that a missing raw source exists.
- `provenance`: `verified`, `unknown`, or `mismatch`.
- `source_value` and `source_unit`: usable comparison value/unit, or null value.
- `calculation`: present for a recognized derived request-rate recipe.

E2E source values are seconds; canonical E2E values are milliseconds. The legacy
`all_results.e2e_latency_p90` field already contains milliseconds, despite its
source-like name. Consumers must not infer units from that name or substitute a
different percentile. TTFT/ITL penalty values at least 1,000,000 ms are invalid.
Booleans, numeric strings, negative/non-finite values and overflow are not
measurements. Explicit zero is retained rather than converted to missing.

Missing mean throughput may retain the existing `throughput_p90` fallback as
**compatibility** evidence, labelled “Reported throughput (legacy alias)”. An
explicitly invalid mean cannot be concealed by a fallback. The contract does
not claim a legacy alias is a verified mean.

The parser's existing successful-request-count / benchmark-duration fallback is
represented as `successful_requests_per_second_v1`, with positive duration and
an integral, safe, positive successful count. Exact agreement with the stored
mean can verify this **calculated** rate; the reader rechecks the recipe and
labels it “Mean throughput (calculated)”. It does not invent a stored mean when
only a compatibility alias exists.

## Historical provenance policy

The loader can read the optional existing `guidellm_raw_json` column; older schemas
without it continue working. Verification compares stored values to the exact
percentile fields in the first preserved benchmark, never substituting `p999` for
`p99`. Matching uses exact numeric equality and explicit unit conversion, so
tolerance cannot create a false pass across a tight target.

- No usable raw reference: **unknown**, even if a stored value looks plausible.
- A usable raw reference disagrees: **mismatch**; retain diagnostics, not a repair.
- Exact agreement or the recognized rate calculation: **verified agreement**.

“Verified” means numerical agreement with available GUIDELLM-shaped input. It
does **not** authenticate that file, establish original-versus-reconstituted
lineage, certify measurement-window/workload comparability, or prove production
capacity. Those require stronger capture/provenance and experiment design.

## Source retention and lineage

`DatabaseManager.insert_test_result` now persists the parsed raw artifact verbatim
in `guidellm_raw_json` together with `guidellm_raw_lineage`, the new TEXT column
added by schema migration. Lineage is assigned only where the source is known:
guidellm's own output file yields `guidellm_output_file`; the locally
reconstituted `parse_guidellm` extraction yields
`reconstituted_parse_guidellm`. The parser stores the exact parsed bytes and does
not assign lineage; absent lineage is `unrecorded`, not certified.

Lineage is **not** authentication. Even `guidellm_output_file` does not prove file
authenticity, collection-window, or workload comparability. Historical rows keep
their previous behavior: no raw reference means `unknown`; raw-without-lineage
means stored but `unrecorded`. Nothing is backfilled or rewritten on read.

Because historical persisted records mostly lack raw evidence, versioned sizing may
legitimately report no source-verified feasible point. Report generation itself
never repairs stored values; only the explicit audit/repair flow below may.

The browser report payload never embeds the raw artifact; only the same-test
evidence descriptors above reference it.

## Historical audit and repair (opt-in)

`core/report_audit.py` provides the audit/repair flow, exposed as
`serveit report audit` (read-only) and `serveit report repair` (dry run by
default).

- Audit compares the stored TTFT/ITL percentile columns and throughput
  percentile columns against the preserved raw references (latency
  percentiles; request rate mean). It never writes. Missing raw reference
  stays `no_raw`; malformed raw is treated as absent.
- Repair applies only **exact-agreement** changes: filling a missing column from
  a valid raw reference, or correcting a stored value that exactly disagrees
  with it. No tolerance is used, and no row without a usable raw reference is
  ever modified. `metrics_json` and every other column are untouched.
- Repair is backup-gated: the database file is copied to
  `<db directory>/backups` (or `--backup-dir`) and `PRAGMA integrity_check`
  must pass on the backup before any write. Without `--apply` it is a dry run
  with no backup and no writes.
- Every applied change is logged in the additive `raw_source_repairs` table
  (batch id, backup file, run/test identity, field, old/new/raw values, reason,
  timestamp), so a repair batch can be inspected or rolled back by hand from
  the backup.

## Shared consumer and sizing policy

`web/static/js/report-model.js` supplies the shared reader, metric/identity rules,
eligibility/category scoring, notices, and evidence checks. Jinja loads it before
report consumers. Browser-generated HTML embeds the **same factory** and contract
metadata, without another model asset or a copied policy implementation.

For v1, a sizing Pass requires:

1. Eligible same-source identity and valid base measurements/resources.
2. Source-verified TTFT and ITL at the exact selected percentiles, within targets.
3. A source-verified reported/calculated mean rate, not a legacy alias.
4. Integral whole-deployment GPU count and consistent derived sizing:
   `copies = max(1, ceil(target req/s / source req/s))`,
   `estimated GPUs = copies × source whole-deployment GPUs`.

Zero TTFT is allowed; zero ITL remains Unknown for conservative sizing. A known
failed constraint can produce Fail while other evidence is unknown. Only verified
feasible points can be Best. Unknown rate provenance can leave a numeric planning
estimate diagnostic, but cannot verify capacity or win. Cached booleans/sizing
do not override source checks. Invalid input, incompatible contracts, tab closure,
or rerender invalidate the affected estimate snapshot.

A Pass remains a source-point check and **linear planning estimate**, not a tested
fleet-level SLO. Matched comparisons, uniform SLO-aware recommendation selection,
remaining legacy chart aliases, and Python HTML/Markdown renderer migration are
not completed by this contract.
