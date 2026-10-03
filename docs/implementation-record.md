# UX simplification: implementation record

Snapshot date: **2026-10-01**.

**Current status: P0.1 published; P0.2 artifacts and shared evidence contract v1
published; raw-source retention with explicit lineage implemented and validated
locally; broader redesign remains unfinished.** See **Section 12** for current
validation. Section 11 records the contract increment; Sections 9–10 preserve
preceding integration/publication snapshots.
Sections 1–8 preserve the original checkpoint inventory and limitations; their
validation counts and resolved mismatch notes are historical, not current.

## 1. Request and scope

The user requested an assessment of complexity, user journey, and result charts,
using Red Hat AI design guidance, followed by an implementation plan and work on
a feature branch in a fork owned by `ashishkamra`. They requested regular
progress updates and explicitly authorized **committing and pushing to the fork
feature branch**, not merging or pushing to upstream.

The agreed starting tranche is **P0.1: reporting trust foundation**. It precedes
visual simplification because misleading metrics and recommendations cannot be
fixed by restyling. The full roadmap is
[ux-simplification-plan.md](ux-simplification-plan.md).

The latest request is to record everything implemented and provide a detailed
handoff for another model. This document is the implementation inventory; the
handoff document contains operating instructions, risks, and next actions.

## 2. Repository setup performed

| Item | Value/action |
| --- | --- |
| Original repository | <https://github.com/openshift-psap/serveit-studio> |
| Fork created and verified | <https://github.com/ashishkamra/serveit-studio> |
| Local feature branch created | `feat/ux-simplification` |
| Branch base | `e5b9c7aaea383e48222c708ab12b1e06c39ddcb1` |
| Base subject | `Add: --override-generation-config support` |
| Original remote preserved | `origin` -> upstream |
| Additional remote | `fork` -> ashishkamra fork |
| Working tree before implementation | Clean |
| Publication target | `fork/feat/ux-simplification` |

The documents and implementation are intended to travel together in one handoff
checkpoint commit. Verify actual publication using the commands in the handoff;
this record does not imply that GitHub CI ran or that a PR was opened. No merge
or upstream push is part of this checkpoint.

## 3. Planning and assessment delivered

- Reviewed the launcher, seven-step wizard, EPP branch, report navigation,
  rendering, metric parsing, and representative bundled screenshots.
- Identified outcome/search-mode/architecture confusion, excessive console
  prominence, late readiness checks, and up to fourteen report sections.
- Assessed primary scatter, configuration sweeps, calibration, efficiency,
  concurrency, EPP, cache, telemetry, and GPU estimation.
- Researched official Red Hat AI principles, transparency, iconography, color,
  and PatternFly wizard, dashboard, chart, accessibility, and adoption guidance.
- Created the phased roadmap with acceptance criteria and preservation of
  existing Flask/Jinja/Plotly architecture.
- Distinguished deterministic benchmark recommendations from generative-AI
  output; no chatbot or misleading AI badges were introduced.

The original assessment was source/screenshot based. No live usability study,
real-browser accessibility assessment, or GPU benchmark was performed.

## 4. Production implementation inventory

### `core/orchestrator/parser.py`

- New GuideLLM TTFT, ITL, TPOT, E2E, and output-token-rate P99 fields read `p99`,
  not `p999`.
- Missing P99 remains unavailable; it is not replaced with a different tail
  percentile.
- Existing throughput percentile-named aliases are intentionally retained for
  compatibility and still contain the mean in this parsing path.
- **Historical database values have not been repaired.**

### `core/report_data.py`

- Added `valid_metric` for finite numeric, nonnegative/positive-domain checks;
  booleans are not treated as measurements.
- Added `TestResult.is_ranking_eligible`, separate from `is_successful`.
- Ranking eligibility excludes discarded results and invalid base metrics or
  resource values; a warning-quality result may still qualify.
- Missing mean throughput may use the existing compatibility fallback;
  explicitly invalid mean throughput must not be concealed by fallback.
- `throughput_mean` uses the existing common metric accessor.
- `ParetoPoint` carries latency/throughput objective names and labels so Python
  report headings can reflect the actual selected objective.

### `core/report_analysis.py`

- Applied ranking eligibility across summary, recommendation, Pareto,
  calibration, efficiency, calibrated-load/cache-sweep, and EPP ranking paths.
- Preserved successful discarded results in diagnostic `all_results` rather
  than treating exclusion as deletion.
- Added eligible-result counts while retaining completion semantics.
- Added same-test metric/identity payloads, including `test_config_id` (database
  primary key), quality, `is_ranking_eligible`, and TTFT/ITL/E2E percentiles.
- Retained legacy string `test_id` for compatibility; it is not the new numeric
  database ID.
- Corrected Pareto table fields so `ttft_p90` contains P90 and `ttft_p99`
  contains P99, with objective metadata. The default Pareto latency objective
  remains P99.
- Added objective-specific finite/domain checks and safer empty/all-excluded,
  calibration-only, zero-latency, and missing-tail handling.
- E2E `e2e_p*` values in recommendation payloads are milliseconds; source
  `e2e_latency_p*` values are seconds.

### `core/report_renderer.py`

- Python Pareto chart and generated HTML/Markdown labels now use the actual
  latency objective rather than labeling every objective P90.
- This does not unify the separate Python and browser report pipelines.

### `web/static/js/modules/charts.js`

- Added finite recommendation metric/ranking helpers.
- Corrected cross-architecture Lowest ITL selection to score ITL rather than
  falling through to the balanced latency/throughput ratio.
- Recommendation percentile rows use the selected test's own measurements,
  not independent P95/P99 winning tests.
- Missing/invalid card metrics display Unknown; measured zeros are preserved.
- Shows source run/test identity and the candidate's recorded concurrency.
- Updated touched recommendation/summary copy to avoid inventing tail winners,
  a throughput percentile distribution, or a production-load guarantee.
- Calibrated/cache recommendation cards use consistent same-test metrics.
- Live reuse/test keys include run and legacy test identity and preserve entries
  for other open reports instead of resetting the global map.
- Recommendation manifest actions require a test ID instead of falling back
  to a display name. Broader action lifecycle/identity migration is unfinished.

### `web/static/js/report-download.js`

- Applies corresponding same-test cards, Lowest ITL scoring, unknown/zero
  handling, source identity/concurrency, and mean-throughput wording to HTML
  downloads.
- Adds `dlRecommendationMetric`, `dlRecommendationScore`, and
  `dlRecommendationTable` helpers.
- Adds safer handling of partial/legacy category payloads and missing summary
  metrics.
- Live/export ranking helpers are still duplicated, not a shared evidence
  contract. Their current agreement is covered by targeted regressions only.

### `web/static/js/modules/report.js`

- Replaced pre-filtering to the fastest result per display name with individual
  source operating points, preserving slower points that satisfy targets.
- Added reusable target validation, calculations, Pass/Fail/Unknown evaluation,
  best-feasible selection, source/condition text, and result-table helpers.
- Unknown or invalid required latency cannot pass. A known failed constraint
  produces Fail while the other constraint's unknown status remains visible.
- Chooses lowest estimated GPUs among verified feasible points, including ties;
  cheaper failed/unknown points no longer suppress the feasible highlight.
- Shows an explicit no-verified-feasible-point state and keeps diagnostics.
- Rejects invalid/non-finite/nonpositive targets instead of silently defaulting;
  clears stale table/chart/export data on invalid input.
- Preserves selected percentile semantics; no tail substitution.
- Excludes calibration and discarded tests. Broader eligibility-flag alignment
  remains a handoff integration item.
- Exposes source run/test, recorded/measured concurrency, available cache
  conditions, and legacy-throughput fallback provenance.
- Describes sizing as whole measured deployment copies with ideal linear
  scaling, same-workload assumptions, and no fleet-level SLO verification.
- Shares table/status generation between live estimator and estimator export;
  touched dynamic HTML output is escaped.
- Explicit zero TTFT is accepted; zero ITL is conservatively Unknown. This is
  intentionally documented and needs semantic reconciliation with other paths.

## 5. Added regression tests

| File | Coverage |
| --- | --- |
| `tests/test_metric_parser.py` | Distinct, zero, null, and absent P99 vs P99.9 across five metric families; unchanged aliases |
| `tests/test_report_integrity.py` | Eligibility vs completion, excluded diagnostics, warning candidates, empty results, calibration/sweep/EPP selection, same-test payloads, Pareto field/label integrity, invalid metrics and zero handling |
| `tests/report_recommendations.test.js` | 25 behavior tests of actual live/export renderers with trusted-script VM and DOM/Plotly stubs |
| `tests/test_report_recommendations.py` | Runs the Node recommendation suite through pytest |
| `tests/report_estimator.test.js` | 16 behavior tests, including all nine constraint-status combinations, feasible slower points, ties, invalid input, empty results, escaping, multiple tabs, and export parity |
| `tests/test_report_estimator.py` | Runs the Node estimator suite through pytest |

No new production dependency or npm test framework was introduced. The Node
tests are not a substitute for real DOM, accessibility, or browser-layout tests.

## 6. Verification performed at handoff

| Check | Observed result |
| --- | --- |
| Four new pytest modules together | **53 passed** |
| Both Node suites directly | **41 passed**, 0 failed, 0 skipped |
| `python3 -m ruff check .` | Passed |
| `node --check` for all three changed production JS files | Passed |
| `git diff --check` | Passed at snapshot review |
| Existing `tests/test_imports.py` | **64 passed, 9 failed** |
| Full repository suite | Not completed |
| CI / Python 3.11 / Node 20 execution | Not verified |
| Browser / screen reader / real cluster | Not performed |

The 53 pytest results include two wrappers that execute the 41 Node tests; do
not count those wrappers as another independent set of 41 tests.

Import failures: seven paths encounter missing `flask` (`web.app_context`,
`web.auth`, `web.database`, `web.realtime`, `web.routes_api`, `launcher.app`,
`launcher.auth`); two encounter missing `gevent` (`web.optimization`,
`web.server`). Those are the observed errors, not proof that no further errors
will surface after dependencies are installed.

Local validation used Python 3.14.6, Node 22.22.3, and Ruff 0.14.1. Repository CI
specifies Python 3.11 and Node 20. No dependency installation or isolated test
environment creation was completed before this handoff.

## 7. Known remaining work

- **Immediate integration mismatch:** backend emits `is_ranking_eligible`, but
  frontend score helpers check `recommendation_eligible`. Align the contract and
  test actual backend-generated payloads. Built-in backend ranking already
  filters candidates; do not infer that every current card is wrong.
- Review whether the estimator should honor explicit backend ineligibility,
  while retaining unsuitable points as diagnostics.
- Review numeric `test_config_id` adoption for actions, exports, and provenance;
  current frontend action keys still use the legacy string ID.
- Reconcile zero ITL semantics, legacy mean-throughput fallback, and the meaning
  of actual vs configured/measured concurrency.
- Four backend production files have file-level `# fmt: off` markers introduced
  during removal of unrelated formatting. Review whether to remove/narrow them
  without reformatting the entire modules.
- Complete P0.2 historical provenance/repair, shared evidence model, matched
  baselines, SLO-aware recommendations, and remaining alias/capacity corrections.
- Implement P1/P2/P3 workflow, result hierarchy, chart redesign, and accessibility.

## 8. Explicit non-changes

No cluster resources were deployed, no benchmark was run, no production data was
migrated, no credentials were added to the repository, and no React/PatternFly
package migration was performed. The seven-step workflow, dominant console,
launcher layout, and main report tab hierarchy have **not** been redesigned in
this checkpoint. Existing architecture and expert options remain intact.

## 9. Resumed integration follow-up (2026-10-01)

### Recovered and completed

- Live/export recommendation gates honor canonical `is_ranking_eligible` and
  compatibility `recommendation_eligible`. Either explicit denial excludes a
  candidate, including calibrated/cache cards; warning-quality valid rows remain
  eligible. Objective validation also applies to the sweep cards.
- Estimator preserves explicit ineligibility as **Excluded** diagnostic rows,
  never Pass/Best. Known invalid base TTFT and selected penalty latency cannot
  become passing estimates. Existing zero semantics remain explicit: zero ITL
  is Unknown for sizing, while measured zero can rank in category cards.
- Recommendation action identities use run plus immutable `test_config_id` when
  available, with a legacy fallback. Source labels expose both identities, and
  card telemetry lookups no longer conflate tests with the same legacy name.
  Existing manifest routes still require the legacy configuration identifier;
  this is **not** a complete immutable-ID download/API migration.
- Rerender/close cleanup removes only the relevant run's action bindings and
  tab-local estimator caches. Late fetches cannot resurrect closed tabs. Panel
  IDs and chart suffix are restored even after a renderer throws.
- Live/export copy distinguishes recorded concurrency from measured average
  concurrency; estimator displays measured concurrency only with evidence.
- `test_report_contract.py` and `report_contract_helper.js` feed real
  `ReportAnalyzer` JSON into checked-in JavaScript renderers, including canonical,
  deliberately ineligible candidate, and valid legacy variants.

### Test isolation and import-order correction

`tests/conftest.py` redirects databases, state files, output, HOME, model caches,
and tracking state to a temporary directory before collection. It clears cluster
credentials and blocks ordinary network/process/persistent-write side effects,
including explicit gevent boundaries. The lifecycle fixture intercepts only the
stop route's subprocess boundaries and start dispatch; routes, auth, and
persistence remain real. These safeguards are **not a security sandbox**; the
checked-in Node/ESLint subprocesses remain allowed.

An initial full run reported 177 passed / 3 skipped. Running imports before API
tests exposed ten failures: loading auth first made API clients unauthenticated.
The API fixtures now load the real server entry point before any request and use
the real setup/login routes. They no longer skip arbitrary setup/assertion
failures or set environment paths during collection. A regression verifies start
dispatch is recorded without scheduling optimization. Safety tests verify real
stop persistence while destructive commands stay intercepted.

### Current observed validation

| Check | Result |
| --- | --- |
| Full `tests/` suite, isolated Python 3.11.15 | **180 passed, 0 skipped**, one gevent warning |
| Imports → API → safety tests in a fresh process | **102 passed, 0 skipped**, same warning |
| Node recommendation/estimator behavior suites, Node 22.22.3 | **54 passed, 0 failed/skipped** |
| Whole-repository Ruff | Passed |
| Production JS syntax checks / diff whitespace | Passed |
| Chrome 150.0.7871.100, production Plotly 2.35.2 | Desktop 1440px and narrow 390px smoke checks passed |

The full-suite count includes the Node wrappers; do not double-count their
underlying 54 cases. The recovered isolated environment at
`/tmp/serveit-ux-validation` resolves the original missing Flask/gevent import
blockers. Browser-only Playwright 1.63.0 was installed there, not as a production
dependency. No OS Python, production requirements, cluster, or stored benchmark
data was changed.

The remaining warning is gevent's late SSL monkey-patching during pytest imports.
Tests pass, but this is **not** proof of production TLS behavior. Production
startup ordering was not changed. Python matches CI's 3.11 series; local Node
was 22, not CI's 20, and hosted CI was not run.

### Browser scope and reproduction

`tests/report_browser_smoke.py` is optional and standalone (not collected by
pytest's cluster-safe unit harness). It uses production CSS, real DOM/Plotly and
Python-produced fixtures. It checks recommendation provenance/action binding,
legacy manifest URLs, estimator Excluded/Unknown/Best states, native keyboard
activation, invalid-target cleanup, actual HTML/SVG downloads, execution of the
downloaded report's chart scripts, and two-run cache/action cleanup. Requests
are fulfilled with fixtures, and reuse/test dispatch is captured, not executed.
These are viewport smoke checks, **not** full responsive/accessibility
certification or a server/cluster end-to-end test.

```bash
PYTHONDONTWRITEBYTECODE=1 PYTEST_DISABLE_PLUGIN_AUTOLOAD=1 \
  npm_config_cache=/tmp/serveit-ux-npm-cache npm_config_offline=true \
  /tmp/serveit-ux-validation/bin/python -m pytest \
  -p no:cacheprovider tests/ -q -rs

node --test tests/report_recommendations.test.js tests/report_estimator.test.js
python3 -m ruff check .
node --check web/static/js/modules/charts.js
node --check web/static/js/modules/report.js
node --check web/static/js/report-download.js
git diff --check

# Optional browser checks: development-only playwright and Chrome required.
# Fetch the pinned Plotly asset separately; the browser run blocks live traffic.
curl --fail --location --silent --show-error \
  https://cdn.plot.ly/plotly-2.35.2.min.js \
  --output /tmp/serveit-ux-plotly-2.35.2.min.js
PYTHONDONTWRITEBYTECODE=1 /tmp/serveit-ux-validation/bin/python \
  -m tests.report_browser_smoke --plotly /tmp/serveit-ux-plotly-2.35.2.min.js
```

For a new environment, use the dependency list in `.github/workflows/ci.yml` and
an isolated Python 3.11 venv; provision/cache ESLint 8 before the offline command.
Install Playwright only if running the optional browser script. The `/tmp`
environment is disposable and is not a repository dependency lockfile.

### Remaining boundaries

P0.2/P1/P2/P3 remain planned, including historical percentile provenance/repair,
a shared versioned evidence model, matched baselines, uniform SLO selection,
complete immutable-ID manifest routes, guided-flow/result hierarchy, and manual
keyboard/screen-reader/accessibility validation. File-level formatter guards in
four legacy Python modules were reviewed but retained to avoid automatic,
unrelated whole-file formatting during this focused follow-up. Follow-up changes
remain local and uncommitted; no new push or PR was made in the resumed session.

## 10. Publication and P0.2 immutable artifact increment

On the user's explicit commit/push request, the P0.1 integration follow-up was
committed as **`b2f20840a77adf12d8b202aef006007d0a529590`**:
`Fix: Align report eligibility and validate integration safely`.
The user clarified that “upstream” meant their tracking **fork**, not the original
openshift-psap repository. Push and remote SHA verification succeeded at
`ashishkamra/serveit-studio`, branch `feat/ux-simplification`. No main-branch push,
upstream-organization push, force push, merge, or PR was performed.

Implementation then continued with this separately reviewable P0.2 increment:

- Added `web/report_artifacts.py`, registered by the real server entry point.
  New authenticated GET endpoints use **both run ID and immutable database test
  ID** for listing/downloads. An ID from another run returns 404, never a
  name-based substitute. Oversized/invalid IDs are handled without SQLite
  overflow errors; malformed stored JSON/non-text artifacts return 422.
- Download names expose run/test identity and sanitize the manifest kind.
  Exact stored UTF-8 YAML is returned as an attachment, with `no-store` and
  `nosniff`; explicitly empty stored text is preserved. No database mutation,
  migration, benchmark, or deployment is performed.
- Live report manifest links now prefer immutable routes where IDs are
  available. Recommendation artifact types are retrieved from the selected
  source, not another row's matching name. Existing name-based routes remain
  unchanged for old clients/payloads; this is not a schema migration. The
  current database already enforces `UNIQUE(run_id, config_name)`.
- Offline exports key embedded artifacts by immutable identity, match refreshed
  payloads by that identity, and refuse ambiguous legacy identities. An unknown
  numeric ID never falls back to a name. YAML data containing script delimiters,
  quotes, Unicode separators, or prototype-like keys remains data. Touched
  action arguments/labels and embedded-script serialization are escaped; this
  is not a full audit of every legacy report HTML interpolation.
- Standard, calibrated, and cache recommendation cards share exported artifact
  link generation, including same-source fallback when the card lacks explicit
  manifest types. Old valid legacy-only exports can still download YAML.
- Added 17 authenticated API cases in `test_report_artifacts.py`, import coverage,
  nine more Node behavior cases, and stronger actual Python-payload/browser
  regressions. The exported script itself is executed to verify downloaded Blob
  contents. Browser tests download two distinct YAML bodies from source records
  sharing a legacy name and verify immutable filenames at both viewports.

### Verified results for this increment

| Check | Result |
| --- | --- |
| Full isolated Python 3.11.15 suite | **198 passed, 0 skipped**, existing gevent SSL warning |
| Imports → API → artifacts → safety in a fresh process | **120 passed, 0 skipped**, same warning |
| Direct Node recommendation/estimator suites | **63 passed** |
| Chrome desktop 1440px / narrow 390px | Live/export reports and actual offline YAML downloads passed |
| Ruff, production JS syntax, whitespace diff | Passed |

An initial parity-test failure was in test scoping: its recommendation assertion
included diagnostic links. The regression now extracts the recommendation pane
explicitly, and the full suite passes. Artifact API checks use in-memory SQLite
and real application auth; browser APIs are fixture-backed. These tests do not
prove real cluster behavior, hosted CI, Node 20 behavior, or accessibility
certification. No new production dependency was added.

The artifact increment is **local and uncommitted** after the requested checkpoint
push. Broader P0.2 work remains: a shared versioned report/evidence model,
source-backed historical percentile provenance/repair, matched baselines, SLO-aware
selection, remaining metric/concurrency semantics, and migrating trial payloads
that still lack immutable IDs. P1/P2/P3 remain planned. See
[API reference](api-reference.md#manifests) for the new endpoint contract.

## 11. Artifact publication and shared evidence contract v1

The user explicitly requested another commit/push/continue checkpoint. The
artifact increment was committed as **`c821aad7cfd4ecde6f6fdfb4d0035048ddca3ffc`**:
`Add: Bind report artifacts to immutable run and test identities`. Push to the
confirmed fork feature branch succeeded and its remote SHA was verified. No
original-upstream/main push, merge, force push, or PR was performed.

Implementation then continued with the initial versioned browser evidence model:

- `core/report_evidence.py` produces the additive `serveit.report` v1 envelope and
  same-test evidence attached by immutable ID. It records explicit metric units,
  statistics, availability, source references/agreement, eligibility, configured
  versus measured concurrency, calculated whole-deployment GPUs, and allowlisted
  workload conditions. No matched baseline or production SLO is invented.
- `core/report_data.py` reads the optional existing raw-JSON column without
  requiring a migration. Numeric validation handles extreme integer overflow.
  `core/report_analysis.py` adds the contract to browser payloads and preserves
  zeros/finite optional metrics instead of relying on truthiness. Legacy fields
  and E2E millisecond aliases remain compatible.
- Provenance remains unknown without usable preserved raw input. Exact disagreement
  is diagnostic, not repaired. Exact agreement checks the actual percentile,
  never P99.9 in place of P99, and rechecks source units. No tolerance can create
  a false pass across a tight target. E2E seconds are converted explicitly to
  milliseconds; long E2E is not mistaken for a TTFT/ITL penalty sentinel.
- The parser's existing successful-count / duration request-rate fallback is
  described as an explicit, supported calculation. Source counts/duration and
  exact result agreement are rechecked. Invalid means cannot borrow a good alias;
  compatibility rate aliases are not certified as means.
- `web/static/js/report-model.js` is the shared policy for live/export metric,
  identity, eligibility, category scoring, source notices, units and sizing checks.
  The actual Jinja page loads it before consumers. Browser-generated HTML embeds
  the same factory and contract metadata, not a copied implementation or another
  model asset dependency. Existing public helper names delegate to the model.
- Versioned cards consume typed values instead of guessing from legacy aliases.
  Unknown versions/policies and cross-run/test evidence fail closed. Per-value
  invalid/unsupported evidence remains unavailable, with source notices. Legacy
  unversioned reports retain numeric compatibility with an explicit limitation.
- Versioned estimator Pass/Best requires matching source latency evidence, a
  verified reported/calculated mean, integral deployment GPU count and consistent
  whole-deployment sizing. Unknown/mismatched evidence remains diagnostic. Cached
  booleans/derived counts cannot bypass checks; rerender invalidates only that
  tab's estimate snapshot. A Pass still is not a measured fleet-level guarantee.

### Validation and findings

| Check | Result |
| --- | --- |
| Full isolated Python 3.11.15 suite | **231 passed, 0 skipped**, existing gevent SSL warning |
| Imports → API → evidence → contract → artifacts → safety in a fresh process | **156 passed, 0 skipped**, same warning |
| Direct model/recommendation/estimator Node suites | **84 passed, 0 failed/skipped** |
| Chrome 1440px / 390px fixture checks | Passed, including unknown-history no-feasible state, rerender invalidation, actual HTML/SVG/YAML downloads |
| Real authenticated Flask index/static asset checks | Passed; model loaded before consumers |
| Whole-repository Ruff, four production JS syntax checks, whitespace | Passed |

Counts include Node wrappers; do not double-count the underlying Node cases.
The new tests cover missing/malformed/mismatched/exact raw sources, old SQLite
schemas, units, zeros/overflow, calculated rates, strict target boundaries,
cross-layer card agreement, unsupported contracts, source identities, and cache
invalidation. Browser fixtures now return each run's actual identity: the new
guard correctly rejected the old fixture returning run 42 data for run 99.
A wording regression also caught a missing rate being falsely described as an
existing alias; the label now changes only for an actual compatibility value.

### Limitations and next step

See [report-evidence-contract.md](report-evidence-contract.md) for the normative
initial contract. Source “verified” means numerical agreement with available
GUIDELLM-shaped input, not file authenticity, original-versus-reconstituted
lineage, collection-window certification, matched workloads, or production SLOs.
Database-record timestamps are explicitly **not** a verified measurement window.

**Important discovered limitation:** `DatabaseManager.insert_test_result` currently
does not populate its existing raw-JSON column. This tranche did not change
ingestion or backfill it. Many existing/newly persisted records therefore remain
unknown, and source-verified sizing can legitimately have no feasible point.
The next P0.2 tranche is preserving new raw sources with explicit lineage, followed
by a backed-up, opt-in historical audit/repair flow—not silently rewriting records
on read. No source file, stored metrics, cluster resource, or production dependency
was changed by this read-only contract work.

This contract increment was committed and pushed to the confirmed fork feature
branch as **`f4d00d3`** after its validation. Broader P0.2 remains incomplete:
baseline matching, uniform SLO-aware recommendation selection, remaining legacy
chart semantics, trial identities, and Python HTML/Markdown evidence migration.
P1/P2/P3 layouts, guided recovery, and accessibility remain planned. Node 20,
hosted CI, real clusters and assistive-technology certification were not
exercised.

## 12. Raw-source retention with explicit lineage

The next P0.2 step from Section 11 is now implemented: newly completed
benchmarks persist their raw source artifact **with explicit lineage**, and the
report evidence states that lineage instead of implying it.

- `DatabaseManager.insert_test_result` now writes the existing
  `guidellm_raw_json` column (verbatim parsed bytes) plus a new
  `guidellm_raw_lineage` TEXT column (schema and legacy-DB migration).
  `web/database.py` migrates the same column.
- `core/orchestrator/result.py` records `guidellm_raw_lineage` on the
  orchestrator result; the benchmark producers return it as the fourth tuple
  value: `_run_guidellm_job` returns `guidellm_output_file` for guidellm's own
  output file and `reconstituted_parse_guidellm` for the locally reconstituted
  `parse_guidellm` extraction; `_run_guidellm_test` returns `guidellm_output_file`.
  Failure paths return a null lineage. Both callers (runner and the legacy
  web validation path) consume all four values.
- `ParserMixin._parse_guidellm_results` keeps storing the exact parsed bytes and
  does not infer lineage; a parsed artifact without a producer-assigned lineage
  is reported `unrecorded`, never certified.
- `ReportDataLoader` reads the optional lineage column (old schemas work), and
  `build_test_evidence` adds a `raw_source` block: `stored` (raw artifact
  present) and `lineage` (`guidellm_output_file`,
  `reconstituted_parse_guidellm`, or `unrecorded`).
- The raw artifact never enters the browser report payload; only the same-test
  evidence descriptors reference it.
- `# fmt: off` guards were added to the legacy modules this increment edited
  (`core/orchestrator/result.py`, `core/orchestrator/guidellm.py`,
  `core/orchestrator/runner.py`, `core/database_manager.py`, `web/optimization.py`,
  `web/database.py`) to prevent unrelated whole-file formatting churn.

Historical rows are unchanged: no raw reference remains `unknown`; raw without a
lineage record is stored but `unrecorded`. Nothing is backfilled or rewritten on
read, and a backed-up, opt-in historical audit/repair flow remains the next
P0.2 tranche. The new `tests/test_report_lineage.py` covers parser byte
identity, persistence of both columns, loader/evidence lineage propagation,
legacy-schema behavior, payload raw-artifact exclusion, and the four-value
producer contract.

### Validation and findings

| Check | Result |
| --- | --- |
| Full isolated Python 3.11.15 suite | **240 passed, 0 skipped**, existing gevent SSL warning |
| Imports → API → evidence → lineage → contract → artifacts → safety, fresh process | **165 passed, 0 skipped**, same warning |
| Direct model/recommendation/estimator Node suites | **84 passed, 0 failed/skipped** |
| Chrome 1440px / 390px fixture checks | Passed |
| Whole-repository Ruff, production JS syntax checks, whitespace | Passed |

Lineage is not authentication: it identifies where the preserved artifact came
from, not whether the file is genuine, the window it covers, or workload
comparability. An actual cluster benchmark was not run; the persistence path was
exercised with real parser/database/loader/report code against temporary
databases only.
