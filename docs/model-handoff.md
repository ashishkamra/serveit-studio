# Model handoff: continue ServeIt Studio UX simplification

Snapshot date: **2026-10-01**.

## Latest continuation: publication and P0.2 artifact identity

The user requested a local commit/push and then continued implementation. After
explicit destination confirmation, P0.1 was pushed to the **fork** feature branch
as `b2f2084` (not to openshift-psap or main). The subsequent P0.2 artifact increment
is implemented/tested but remains local and uncommitted. See
[implementation record, Section 10](implementation-record.md#10-publication-and-p02-immutable-artifact-increment).

Current checks: **198 full-suite tests**, **120 alternate-order integration
checks**, **63 Node behavior cases**, and desktop/narrow Chrome checks all pass.
The existing gevent SSL warning remains. New `web/report_artifacts.py` routes
require run plus immutable test ID and preserve auth; browser live/downloaded
artifact actions prefer the same identity. Legacy name routes remain compatible,
and offline legacy ambiguity fails closed. No stored data was migrated.

The next P0.2 step is the **shared versioned evidence contract and historical
provenance policy**, not another eligibility or artifact-name fix. Trial payloads
without immutable IDs still use compatibility routes; do not claim every legacy
action or all P0.2 acceptance criteria are complete. The earlier updates below
are chronological snapshots, superseded by this section where noted.

## Resume update: P0.1 integration checks completed locally

The parent session was recovered from the pending working tree. Read
[implementation record, Section 9](implementation-record.md#9-resumed-integration-follow-up-2026-10-01)
before using the original checkpoint instructions below. The canonical eligibility
mismatch, estimator exclusion gate, immutable recommendation action identities,
and tab cleanup are now addressed in local changes, with real backend-to-browser
payload regressions. The original missing-dependency blockers were resolved in an
isolated Python 3.11.15 environment.

Current validation: **180 full-suite tests passed with no skips**, **102**
imports/API/safety checks passed in alternate order, **54 Node behavior tests**
passed, and real Chrome fixture smoke checks passed at **1440px and 390px** using
Plotly 2.35.2. Ruff, production JavaScript syntax, and whitespace checks pass.
The full-suite number includes Node wrappers. A late gevent SSL patch warning
remains; browser checks are fixture-driven, not a cluster/runtime or accessibility
certification. Node 20 and hosted CI were not exercised.

At that snapshot, no resumed-session changes had been committed/pushed; the latest
continuation above records the later explicit authorization and completed push.
Review the current local increment before any further publication.
The four legacy formatter guards were retained to avoid noisy automatic formatting.
The next implementation tranche is **P0.2**, not another eligibility-field fix.
Historical repair, a shared contract, SLO-aware selection, full immutable-ID
download routes, and P1/P2/P3 UI changes are still unfinished. The original
snapshot below remains for architecture/history; its mismatch and validation
limitations are superseded where explicitly resolved by this update.

## Start here

You are continuing a partially implemented UX/reporting improvement, not
starting a new assessment. Read these documents in order:

1. This handoff, especially **Immediate continuation order** and **Known risks**.
2. [Implementation record](implementation-record.md): everything changed and the
   exact observed validation results.
3. [Implementation plan](ux-simplification-plan.md): P0.1/P0.2/P1/P2/P3 scope,
   design rationale, and acceptance criteria.

**Do not claim the redesign or all P0 work is finished.** The original checkpoint
had a field-contract mismatch and incomplete validation; see the resume update
above for their resolution. Real cluster validation and the broader roadmap
remain outside the completed integration tranche.

## User intent and authorization

- Assess and simplify the tool's complexity, journey, and final charts using
  <https://ux.redhat.com/ai-guidelines/ai-design-principles/>.
- Create an implementation plan and start work in a feature branch in a fork
  under `github.com/ashishkamra`.
- Give regular progress updates. The user subsequently said to keep going until
  finished, then requested a detailed implementation record and model handoff.
- The user explicitly selected **Commit and push (Recommended)** when asked
  whether changes may be published to their fork feature branch.
- This authorization does **not** include merging, force-pushing, upstream
  pushes, or running real cluster workloads. No PR was requested.
- Preserve unrelated user changes. The tree was clean when this work started.

## Repository and publication

| Item | Value |
| --- | --- |
| Workspace used | `/home/akamra/workspace/serveit-studio` |
| Upstream | `https://github.com/openshift-psap/serveit-studio` |
| Fork | `https://github.com/ashishkamra/serveit-studio` |
| Feature branch | `feat/ux-simplification` |
| Base commit | `e5b9c7aaea383e48222c708ab12b1e06c39ddcb1` |
| Local `origin` at handoff | Upstream; **do not push here** |
| Local `fork` at handoff | ashishkamra fork; approved push destination |

The checkpoint commit is intended to contain the implementation, tests, and all
three documents together. Its hash cannot be embedded in its own document;
verify the actual checkout and remote before continuing. In a fresh clone of
the fork, remote naming may differ—verify URLs, not just names.

Run from the repository root:

```bash
git status --short --branch
git log -3 --oneline
git remote -v
git diff e5b9c7aaea383e48222c708ab12b1e06c39ddcb1...HEAD --stat
gh api repos/ashishkamra/serveit-studio/branches/feat%2Fux-simplification --jq .commit.sha
```

If the remote branch is absent or hashes differ, inspect local commits and
uncommitted changes before any push. Do not reset or overwrite the checkpoint.

The existing CI workflow triggers on pushes to `main` and PRs targeting `main`,
**not feature-branch pushes**. Publication alone is not a CI pass. Do not open
an upstream PR or change triggers merely to make a green badge without deciding
the intended review/release path.

## Architecture and implementation map

### Data path

GuideLLM JSON -> `core/orchestrator/parser.py` -> orchestrator `TestResult` ->
stored metrics -> `core/report_data.py` report `TestResult` ->
`core/report_analysis.py` -> report API payload -> browser renderers.

There are two different `TestResult` dataclasses:

- `core/orchestrator/result.py`: benchmark collection object.
- `core/report_data.py`: database/report object, now with ranking eligibility.

Do not confuse the two or add fields to one expecting the other to update.

### Backend touched

- `core/orchestrator/parser.py`: new P99 parsing fix for five client metrics.
- `core/report_data.py`: `valid_metric`, `is_ranking_eligible`, Pareto objective
  metadata. `is_successful` retains its previous diagnostic meaning.
- `core/report_analysis.py`: eligible selection and same-test payloads across
  summary, recommendation, Pareto, calibration, calibrated/cache, EPP, and
  efficiency paths; diagnostic retention and objective-consistent fields.
- `core/report_renderer.py`: objective-aware Python chart/HTML/Markdown labels.

### Frontend touched

- `web/static/js/modules/charts.js`: live recommendations, card/summary metrics,
  score helpers, source labels, and run/test-scoped action keys.
- `web/static/js/report-download.js`: HTML-report counterpart, including
  `dlRecommendationTable` and related helpers.
- `web/static/js/modules/report.js`: estimator calculation, input validation,
  outcome, feasible sizing, rendering/export, provenance, and assumptions.

Do not start by rewriting the 4,000+ line chart renderer or replacing Flask.
Keep improvements reviewable and migrate behavior incrementally.

### Important current contracts

| Field/behavior | Meaning |
| --- | --- |
| `test_id` in report payload | Legacy string identity retained for compatibility, commonly the stored configuration identifier |
| `test_config_id` | Newly exposed immutable database primary key; not yet adopted by all frontend actions |
| `is_successful` | Existing completion/base-metric diagnostic predicate |
| `is_ranking_eligible` | Backend quality/base-metric gate; each objective still validates its own metric |
| `quality='warning'` | May rank; preserve/explain warnings rather than equating them with discard |
| `quality='discard'` | Excluded from ranking, retained in successful diagnostic rows |
| `throughput_mean` | Preferred request rate; legacy percentile-named aliases still exist |
| `e2e_latency_p*` | Source E2E values in seconds |
| `e2e_p*` | Recommendation card values converted to milliseconds |
| Default Pareto objective | P99 latency; now carries actual metric metadata |
| Card selection | P90-category selection, with all displayed percentiles from that same source test |
| Estimator copies | Whole measured deployment copies, not a single pod/replica of only one role |

No historical database migration or universally shared/versioned report contract
exists yet. New parser behavior does not repair old persisted P99 values.

## Validation checkpoint

Independently rerun immediately before writing this handoff:

- Four new pytest modules: **53 passed**.
- Direct Node behavior suites: **41 passed**, 0 failed/skipped.
- Whole-repository Ruff: passed.
- Syntax checks for the three modified production JavaScript files: passed.
- Whitespace diff check: passed at checkpoint review.
- Existing import suite: **64 passed, 9 failed** due to missing dependencies.

The pytest count includes the two wrappers running the Node suites. Do not
double-count them or claim the full existing test suite passed.

### Reproduce the targeted checks

```bash
python3 -m pytest -p no:cacheprovider \
  tests/test_metric_parser.py \
  tests/test_report_integrity.py \
  tests/test_report_recommendations.py \
  tests/test_report_estimator.py -q

node --test tests/report_recommendations.test.js tests/report_estimator.test.js

python3 -m ruff check .
node --check web/static/js/modules/charts.js
node --check web/static/js/modules/report.js
node --check web/static/js/report-download.js
git diff --check
```

### Test implementation details

- Python tests use in-memory SQLite and temporary GuideLLM fixture files.
- Node tests execute trusted, checked-in scripts in `node:vm`, using DOM,
  Plotly, and download stubs to inspect real generated output.
- These tests do not require a running Flask server or GPU cluster.
- Node VM is not a security sandbox and is not used for untrusted content.
- `tests/test_report_recommendations.py` skips when Node is absent, while
  `tests/test_report_estimator.py` asserts Node exists. Consider aligning that
  policy; CI already installs Node.
- Extend behavior tests, not only source-string assertions.

## Environment and full-suite limitations

Local tools observed: Python **3.14.6**, Node **22.22.3**, Ruff **0.14.1**, uv
**0.11.28**. CI specifies Python **3.11** and Node **20** in
`.github/workflows/ci.yml`. The CI file, rather than a root requirements/package
manifest, was the dependency reference inspected for testing.

Observed import failures:

| Missing package | Failing modules |
| --- | --- |
| `flask` | `web.app_context`, `web.auth`, `web.database`, `web.realtime`, `web.routes_api`, `launcher.app`, `launcher.auth` |
| `gevent` | `web.optimization`, `web.server` |

No dependency installation or isolated environment was completed before the
handoff. No full runtime server or cluster was started. Do not report these
failures as fixed just because focused tests pass.

For broader testing, create an isolated Python 3.11 environment after verifying
the directory and current dependency guidance. Use the dependency list in the
CI workflow; do not modify the OS Python installation or casually change
production requirements. Then rerun imports and the full suite, investigating
any additional failures instead of suppressing them.

Existing test caveats:

- `tests/test_js_lint.py` calls `npx --yes eslint@8`, which can download a package.
- API tests can invoke lifecycle endpoints. Review/mock deployment paths and
  isolate test databases/state before running; do not use a real kubeconfig.
- CI prepares `/mnt/serveit-state`; local tests may need isolated equivalents.
- Route-registration and environment skips exist in current tests; report skips
  accurately rather than treating a skip as behavior validation.

Official references already consulted:

- <https://docs.pytest.org/en/stable/how-to/monkeypatch.html>
- <https://nodejs.org/api/vm.html> (use Node 20/22-compatible APIs, not latest-only APIs)
- <https://flask.palletsprojects.com/en/stable/installation/>
- <https://flask-socketio.readthedocs.io/en/latest/intro.html>
- <https://docs.astral.sh/uv/pip/environments/>

## Known risks and unfinished integration review

### 1. Confirmed eligibility-field mismatch — fix first

The backend publishes **`is_ranking_eligible`**, but
`recommendationScore` in `charts.js` and `dlRecommendationScore` in
`report-download.js` check **`recommendation_eligible`**.

The backend already filters its own candidate maps, so this does not establish
that all current rendered cards are wrong. It does mean the defensive frontend
gate does not match the actual backend field. Align it, decide whether to
temporarily accept both spellings, and add a regression using an actual backend
payload with an explicitly ineligible candidate. Avoid silently inventing a
third spelling.

The estimator currently excludes discarded/calibration records but does not use
the explicit backend eligibility flag. Review how to retain ineligible records
as diagnostics without allowing them to become feasible recommendations.

### 2. Identity and action compatibility

New numeric `test_config_id` is exposed, but frontend action keys, downloads,
and source labels still primarily use legacy `test_id`. Review the manifest,
reuse, and exact-test API contracts before migrating IDs. Do not substitute the
numeric ID into a route that expects the legacy identifier without updating the
route and tests together.

The live global recommendation map is no longer cleared on every report render,
which protects other open reports. Review cleanup when closing/rerendering tabs,
stale entries, and reuse/retest binding in `config.js`. The entire lifecycle was
not redesigned in this tranche.

### 3. Metrics and assumptions

- Historical stored P99 can still represent the old mapping. Plan source-backed
  reparsing and explicit unknown provenance, with backups and no silent rewrite.
- Throughput alias labels are fixed in touched recommendation views, not across
  every chart or API. Some legacy fallbacks may represent different historical
  semantics and must not be asserted to be measured means without provenance.
- Backend/recommendation paths accept measured zero ITL; estimator treats zero
  ITL as unavailable. Agree on semantics and tests before claiming uniformity.
- The new card concurrency comes from the selected payload. Verify whether it
  represents configured concurrency or measured average; label it accordingly.
- Recommendations are still category/P90 based and do not uniformly enforce all
  user SLOs. New wording discloses this; full SLO-aware selection is P0.2.
- Keeping estimator rows separate is safer than merging by name, but feasibility
  still depends on workload/cache/routing comparability. Verify the displayed
  conditions and prevent unmatched comparisons from implying a global winner.
- Pareto percentile field integrity was addressed; the different latency
  objectives across views still need a coherent user-facing selection policy.

### 4. Maintainability and tests

- Live/export score helpers are duplicated and explicitly marked to stay in
  sync. A shared report model is planned, not implemented.
- Cross-layer fixture tests should feed actual Python-produced report data into
  both JavaScript paths. Current independent fixtures missed the flag mismatch.
- Browser tests must validate real DOM structure, chart behavior, focus,
  keyboard handling, responsive layout, and actual downloaded HTML behavior.
- The backend contributor removed large unrelated formatting changes. Four
  production files now start with `# fmt: off` (parser, report data, analysis,
  renderer). Decide whether to remove/narrow those markers without reformatting
  entire existing modules. Do not restore the earlier noisy formatting diff.
- Review HTML/onclick escaping and chart labels in actual browsers. Local
  escaping improvements are not a complete security/accessibility audit.

## Immediate continuation order

```markdown
- [ ] Verify branch, remotes, checkpoint commit, and local modifications.
- [ ] Read the implementation record and inspect the focused checkpoint diff.
- [ ] Align eligibility flags and add cross-layer payload regressions.
- [ ] Review estimator eligibility, identity/action contracts, and zero semantics.
- [ ] Remove/narrow incidental formatter suppression if safe.
- [ ] Reproduce all targeted tests and repository lint.
- [ ] Create an isolated CI-compatible environment; resolve missing dependencies.
- [ ] Run existing imports/full tests safely and document failures/skips.
- [ ] Perform browser smoke tests for live/export recommendations and estimator.
- [ ] Update the record and plan with verified results and unresolved limitations.
- [ ] Commit/push reviewed follow-up changes to the fork feature branch only.
- [ ] Continue P0.2 evidence integrity before presenting stronger UX guarantees.
```

The user authorized continuing implementation, but the current checkpoint is not
permission to run costly real workloads or change infrastructure. If a real
cluster smoke test is necessary, obtain explicit authorization and resource
limits first.

## Subsequent roadmap (not implemented)

### P0.2: evidence and history

Versioned shared report contract, source-backed historical percentile repair,
matched baselines, uniform SLO selection, remaining throughput/capacity fixes,
and immutable-ID actions. No unknown metric may be presented as passing.

### P1: recommendation-first results

Summary / Compare / Diagnostics, one primary recommendation or clear no-feasible
state, addressable run details, collapsible console, clearer navigation labels,
and a configuration-specific review summary.

### P2: guided configuration and recovery

Validate the four-step prototype: Model & objective -> Workload -> Resources ->
Review & start. Separate exact benchmarking, run early preflight, migrate saved
numeric steps to semantic IDs, preserve expert overrides, and use structured
run state for stop/reconnect/resume.

### P3: design-system charts and accessibility

PatternFly-aligned components and semantics, consistent colors/units, primary
latency/throughput scatter, categorical configuration comparisons, numeric
concurrency axes, one percentile selection instead of duplicated charts,
accessible tables and text summaries, keyboard and screen-reader validation.

The initial target is a platform engineer who knows the model/workload but
should not need TP/PD/EP/EPP expertise. Keep expert controls accessible. The
four-step proposal is a usability hypothesis, not an instruction to cram every
field into four screens.

## Red Hat design decisions to preserve

- Apply transparency to **measured / calculated / estimated / unavailable**.
- The inspected built-in recommendations are deterministic. Do not add AI
  sparkles or generated-by-AI labels to ordinary calculations.
- Any future generative explanation needs approved iconography plus text
  disclosure and access to evidence; do not anthropomorphize it.
- Use PatternFly product/workflow guidance with Red Hat visual foundations.
  HTML/CSS adoption is possible; a React rewrite is not a prerequisite.
- Do not use special gradients/colors to communicate AI. Do not depend on color
  alone for statuses or chart interpretation.
- Do not call req/s/GPU monetary cost optimization without pricing data.
- Say best tested configuration under stated conditions, not universally optimal
  or production-guaranteed.

The roadmap links the official design references. The initial Google searches
returned JavaScript shells; recommendations came from directly fetched official
documentation, not assumed search-result summaries.

## Progress communication and definition of done

Give concise updates when beginning a tranche, completing implementation,
discovering a blocker, finishing tests, and publishing. Distinguish implementation
completion, targeted test success, full-suite validation, browser validation,
and publication. They are separate milestones.

Do not mark P0.1 release-ready until the integration mismatch is addressed and
validation limitations are either resolved or explicitly accepted. Do not mark
P1/P2/P3 complete based on this checkpoint: their actual layout/navigation work
has not started. Keep the implementation record and delivery log current.
