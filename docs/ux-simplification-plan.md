# ServeIt Studio UX simplification implementation plan

Current checkpoint: see [implementation-record.md](implementation-record.md)
for delivered changes and verified tests, and [model-handoff.md](model-handoff.md)
for integration risks and continuation instructions. This roadmap is not a
claim that every milestone has been implemented.

## Goal and delivery approach

Help a platform engineer describe a workload, set constraints, and understand the
best **tested** serving configuration without having to learn the optimization
pipeline. Preserve expert configuration and raw evidence through progressive
disclosure.

Deliver incrementally on `feat/ux-simplification` in
<https://github.com/ashishkamra/serveit-studio>. Do not merge into upstream as part
of this work. The first implementation milestone is **P0.1: reporting trust
foundation**; the remaining milestones below are planned work, not claims of
completed implementation.

## Design principles

1. **Transparent evidence:** distinguish measured, calculated, estimated,
   unavailable, excluded, and not-tested results. Every recommendation must
   identify its source run and test and explain its ranking rule.
2. **Personable, not human:** use concise task-oriented language. No chatbot is
   needed to simplify this workflow. Deterministic recommendations are not
   labeled AI-generated. Genuine future AI-authored content needs an approved
   icon plus a verbal disclosure and links to underlying evidence.
3. **Consistent product design:** use PatternFly enterprise interaction patterns
   and Red Hat visual foundations. Do not use gradients or special colors to
   signify AI. Status must not depend on color alone.
4. **Progressive disclosure:** show decisions users need to make now, not all
   controls the optimizer supports. Preserve overrides and advanced diagnostics.
5. **Safe execution:** show the effective plan before allocating resources. Do
   not silently substitute architectures, erase saved work, or imply that a
   benchmark SLO is a production guarantee.

## Target user journey

### Entry

Separate environment administration from everyday optimization. An existing
workspace leads to recent runs and **New optimization**. Cluster inventory,
database storage, node pinning, backups, and cleanup remain available in
environment settings.

### Configuration (prototype to validate)

Offer **Find a suitable configuration** and **Benchmark a known configuration**
as separate task modes. The common guided flow has four steps:

| Step | Essential input | Advanced/automatic |
| --- | --- | --- |
| Model & objective | Model, response-time/throughput objective, optional latency target | Architecture restrictions and search scope |
| Workload | Preset/dataset, input/output size, concurrent users | Variation, multi-turn behavior, cache simulation |
| Resources | Environment, GPU limit, readiness | Networking, node placement, images, engine and routing overrides |
| Review & start | Effective settings, planned tests, resource impact, warnings | Detailed methodology and generated configuration |

Start read-only preflight checks early. Mark values as **Detected**, **Default**,
or **User override**. Ask for gated-model credentials only when required. Keep
errors beside the relevant field, with an actionable summary. Provide estimates
only when evidence supports them; a hard runtime budget requires backend
enforcement, not just a new input.

### Execution and results

After Start, show a run workspace with relevant phases (Prepare, Calibrate,
Benchmark, Validate, Summarize), elapsed time, completed/failed/skipped work,
explicit stop/cleanup behavior, read-only settings, and collapsible logs.

Results have three primary views:

- **Summary:** run completeness, target outcome, one recommended tested point,
  source evidence, up to two alternatives, and Download configuration.
- **Compare:** latency/throughput scatter, accessible table, matched baseline,
  explicit filters, selected percentile, and load exploration.
- **Diagnostics:** parallelism, routing, cache, server metrics, deployment timing,
  failures, settings, and raw artifacts.

Capacity estimation is a secondary planning tool, explicitly separate from
measured performance and fleet-level SLO validation.

## Milestones and acceptance criteria

### P0.1 — Reporting trust foundation (first implementation milestone)

**Scope**

- Correct new GuideLLM P99 parsing; never silently substitute P99.9.
- Keep completion and recommendation eligibility separate. Exclude discarded
  results from ranking while preserving diagnostic visibility.
- Ensure each recommendation card uses one source test for all its percentile
  rows, in both the live and downloaded report.
- Correct category selection (including lowest ITL) and Pareto display values.
- Make estimator constraint outcomes explicitly Pass, Fail, or Unknown; only
  verified passing points can be highlighted as feasible.
- Preserve feasible lower-throughput operating points instead of discarding
  them before constraint evaluation. Expose source identity and scaling limits.
- Add deterministic regression tests without requiring a GPU cluster.

**Acceptance**

- Distinct `p99`/`p999` fixture values demonstrate correct mapping; absent P99 is
  unavailable rather than borrowed from a different percentile.
- A completed-but-discarded test cannot win a recommendation or Pareto ranking.
- A fixture with different P90/P95/P99 winners cannot produce a mixed-test card.
- Missing or non-finite required latency cannot produce Pass or best styling.
- A feasible operating point remains selectable when a faster point fails.
- Existing API/data compatibility is retained where possible. Any unresolved
  historical-data limitation is documented, not disguised by new UI labels.

### P0.2 — Evidence contract and historical data

Depends on P0.1. Establish a versioned report model shared by live/export paths:
run/test IDs, effective workload, architecture, actual concurrency, cache/routing
conditions, metric source/unit/percentile, collection time, eligibility, ranking
rule, baseline ID, constraints, and calculation version.

- Audit old stored percentile values against preserved raw GuideLLM artifacts.
  Reparse only when source evidence exists; otherwise mark provenance unknown.
  Back up data before any explicit migration; never silently rewrite old runs.
- Remove remaining mean-throughput-as-percentile presentation while retaining
  legacy API fields until a versioned deprecation path is available.
- Match architecture and EPP comparisons by deployment/workload conditions and
  store baseline IDs at experiment time.
- Reconcile general recommendations with configured SLOs and search selection.
- Distinguish no results, no eligible results, no feasible results, and partial
  results. Use non-overlapping result counts and keep excluded tests inspectable.
- Correct capacity/concurrency dimensional assumptions and define every derived
  metric; do not describe heuristic loads as production-sustainable.
- Bind reuse/retest/download actions to immutable run/test IDs, not global
  category maps or display names.

**Acceptance:** live and exported results agree; every visible claim is
traceable; historical uncertainty is explicit; unmatched comparisons cannot
claim improvement attributable to a single changed variable.

### P1 — Recommendation-first results and quick UX improvements

Depends on the relevant P0 evidence fixes.

- Replace report-overlay navigation with an addressable run-detail experience.
- Implement Summary / Compare / Diagnostics and a secondary capacity tool.
- Show one primary recommendation, or an explicit no-feasible-result message.
- Collapse the console by default; preserve access to full logs and exports.
- Fix navigation labels and remove default-only routing as a required stop.
- Replace the static methodology wall with an effective-plan summary.
- Standardize plain-language metric labels and a concise glossary.

**Acceptance:** a user identifies the recommendation, its trade-off, and target
status within one minute in a moderated test. No critical evidence is available
only on hover or through color.

### P2 — Guided configuration, execution, and recovery

Prototype the four-step flow before migrating production navigation.

- Centralize effective settings/defaults and validation across browser/backend.
- Introduce semantic step IDs and migrate persisted numeric wizard state.
- Add early preflight and explicit confirmation of architecture substitutions.
- Separate exact benchmarking from automatic optimization.
- Replace progress inferred from controls/log text with structured run state.
- Resume from the saved run's configuration; distinguish Resume remaining tests,
  Retry failed tests, and New run from this configuration.
- Separate workspace setup from per-run decisions; preserve advanced overrides.

**Acceptance:** on a configured environment, users can prepare a valid common
run in under five minutes without opening advanced settings. Back navigation,
reload, interruption, and reconnect preserve correct state. Do not count model
downloads or benchmark runtime as user configuration time.

### P3 — PatternFly-aligned charts and accessible interaction

Apply incrementally; do not require a React migration or replacement of Plotly.
PatternFly HTML/CSS needs application-owned interaction and accessibility logic.

- Adopt consistent forms, buttons, description lists, alerts, tabs, drawers,
  progress, tables, typography, spacing, and focus treatment.
- Keep throughput/selected-latency scatter as the primary comparison. Identify
  the recommendation, baseline, GPU count, and target explicitly.
- Use categorical dot/bar comparisons for configuration and routing treatments;
  avoid smoothed lines implying continuous relationships.
- Use numeric concurrency axes with aligned latency/throughput panels. Offer a
  percentile selector rather than repeating three near-identical charts.
- Put calibration and telemetry in Diagnostics; use stable architecture colors,
  non-color status cues, precise units, meaningful precision, and data tables.
- Add accessible sorting, keyboard navigation, status announcements, chart text
  summaries, zoom/reflow checks, and export warnings/provenance parity.

**Acceptance:** primary tasks work by keyboard and screen reader. Validate
contrast and reflow manually; component adoption alone is not accessibility
certification. Exports preserve the evidence and limitations of the live view.

## Test and release strategy

Use Python/pytest for parsing and report analysis, and Node's built-in test/VM
facilities for deterministic JavaScript behavior. No new production dependency
is required for the first milestone. Keep benchmark/deployment operations
mocked or out of unit tests.

Cover distinct/missing percentiles, invalid/non-finite metrics, discarded tests,
all-failed/all-excluded runs, no feasible operating point, different percentile
winners, ties, single-test/architecture-only modes, partial reports, multiple
open reports, and live/export parity. Later browser tests cover guided setup,
stop/reconnect/resume, keyboard/focus, and no-RDMA fallbacks.

Run targeted tests after each change, then repository lint and available full
tests. Report skipped tests and environment blockers explicitly. Use a real
cluster only in a separately authorized smoke test; unit-test success does not
establish production inference performance.

Publish progress at scope definition, implementation completion, validation,
and push. Commit only reviewed files to the fork feature branch. Later
milestones should be separately reviewable changes, not one large rewrite.

## Official design references

- [Red Hat AI design principles](https://ux.redhat.com/ai-guidelines/ai-design-principles/)
- [AI transparency notices](https://ux.redhat.com/ai-guidelines/transparency-notices/)
- [AI iconography](https://ux.redhat.com/ai-guidelines/iconography/)
- [AI color guidance](https://ux.redhat.com/ai-guidelines/color/)
- [PatternFly wizard](https://patternfly.org/components/wizard/design-guidelines)
- [PatternFly dashboards](https://patternfly.org/patterns/dashboard/design-guidelines)
- [PatternFly charts](https://patternfly.org/components/charts/overview/design-guidelines)
- [PatternFly accessibility](https://patternfly.org/accessibility/design)
- [PatternFly HTML/CSS and React adoption](https://patternfly.org/get-started/develop)

## Delivery log

| Milestone | Status | Notes |
| --- | --- | --- |
| Plan and fork setup | Complete | Fork verified; feature branch based on upstream `e5b9c7a` |
| P0.1 reporting trust foundation | Integration follow-up validated locally | 180 isolated full-suite tests, no skips; 54 Node cases; desktop/narrow Chrome fixture checks. See implementation record Section 9 for warning, scope, and uncommitted status |
| P0.2 evidence contract and historical data | In progress: immutable artifact increment validated locally | Run/test-scoped manifest routes and offline download parity; 198 suite tests / 63 Node cases. Shared versioned evidence, historical repair, baselines, and SLO-aware selection remain pending |
| P1 recommendation-first experience | Planned | Validate hierarchy before broad visual changes |
| P2 guided flow and recovery | Planned | Preserve saved state and expert overrides |
| P3 accessible design-system alignment | Planned | Includes browser and assistive-technology validation |
