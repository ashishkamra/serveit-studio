# UX simplification: implementation record

Snapshot date: **2026-10-01**.

**Status: work-in-progress handoff checkpoint, not a release-ready redesign.**
The P0.1 reporting-trust implementation is present and its targeted tests pass.
Integration review, complete runtime testing, and the remaining UX milestones
are unfinished. Read [model-handoff.md](model-handoff.md) before continuing.

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
