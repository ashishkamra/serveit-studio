'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const vm = require('node:vm');
const model = require('../web/static/js/report-model.js');

function candidate() {
    const metrics = {};
    for (const p of ['p50', 'p90', 'p95', 'p99']) {
        for (const [family, value] of [['ttft', 20], ['itl', 3], ['e2e', 2000]]) {
            metrics[family + '_' + p] = { value, unit: 'ms', statistic: p, kind: 'reported', availability: 'available', provenance: 'verified', source_value: family === 'e2e' ? 2 : value, source_unit: family === 'e2e' ? 's' : 'ms' };
        }
    }
    metrics.throughput_mean = { value: 10, unit: 'req/s', statistic: 'mean', kind: 'reported', availability: 'available', provenance: 'verified', source_value: 10, source_unit: 'req/s' };
    return {
        test_config_id: 1, test_id: 'source', run_id: 42, quality: 'warning', is_ranking_eligible: true,
        ttft_p90: 999, itl_p90: 999, throughput_mean: 999, gpus: 2, concurrency: 999,
        evidence: { version: 1, source: { run_id: 42, test_config_id: 1, test_id: 'source' },
            eligibility: { ranking_eligible: true, quality: 'warning', slo_verified: false }, metrics,
            resources: { total_gpus: { value: 2, unit: 'GPU', kind: 'calculated', availability: 'available' } },
            conditions: { configured_concurrency: { value: 8, unit: 'requests', kind: 'configured', availability: 'available' },
                measured_mean_concurrency: { value: 3.5, unit: 'requests', statistic: 'mean', availability: 'available' } } },
    };
}

function report(row = candidate()) {
    return { report_contract: { name: model.name, version: 1, run_id: 42,
        recommendation_rule: 'category_p90_not_slo_verification', estimator_calculation: 'whole_deployment_linear_v1' }, all_results: [row] };
}

test('shared model rejects nonmeasurements and preserves explicit zero', () => {
    for (const value of [null, undefined, NaN, Infinity, -1, true, false, '10', {}, []]) assert.equal(model.metric(value), null);
    assert.equal(model.metric(0), 0);
    assert.equal(model.metric(0.01), 0.01);
    assert.equal(model.identity(null), 'legacy:');
});

test('versioned metrics and units take precedence over raw display aliases', () => {
    const cfg = candidate();
    assert.equal(model.metricValue(cfg, 'ttft_p90'), 20);
    assert.equal(model.metricValue(cfg, 'e2e_p99'), 2000);
    assert.equal(model.score(cfg, 'highest_tput'), 10);
    assert.equal(model.score(cfg, 'balanced'), -2);
    assert.equal(model.score(cfg, 'most_efficient'), 5);
    assert.equal(model.conditionValue(cfg, 'configured_concurrency'), 8);
    assert.equal(model.conditionValue(cfg, 'measured_mean_concurrency'), 3.5);
});

test('legacy aliases remain compatible but corrupt values never use a fallback', () => {
    assert.equal(model.score({ ttft: 20, throughput_p90: 10 }, 'balanced'), -2);
    assert.equal(model.score({ throughput_mean: NaN, throughput_p90: 10 }, 'highest_tput'), null);
    assert.equal(model.score({ throughput_mean: 0, throughput_p90: 10 }, 'highest_tput'), 0);
    assert.match(model.noticeText({ all_results: [] }), /Legacy unversioned/);
});

test('canonical, legacy and structured eligibility denials are all respected', () => {
    for (const mutate of [c => { c.is_ranking_eligible = false; }, c => { c.recommendation_eligible = false; },
        c => { c.quality = 'discard'; }, c => { c.evidence.eligibility.ranking_eligible = false; },
        c => { c.evidence.eligibility.quality = 'discard'; }]) {
        const cfg = candidate(); mutate(cfg);
        assert.equal(model.eligible(cfg), false);
        assert.equal(model.score(cfg, 'highest_tput'), null);
    }
    assert.equal(model.eligible(candidate()), true);
});

test('identity mismatches and malformed evidence cannot rank', () => {
    for (const mutate of [c => { c.evidence = null; }, c => { c.evidence.version = 2; },
        c => { c.evidence.source.test_config_id = 2; }, c => { c.evidence.source.run_id = 99; },
        c => { c.evidence.source.test_id = 'different'; }, c => { c.evidence.metrics = []; }]) {
        const cfg = candidate(); mutate(cfg);
        assert.equal(model.score(cfg, 'highest_tput'), null);
    }
});

test('incorrect units/statistics and verified labels without matching source are unavailable', () => {
    for (const mutate of [m => { m.unit = 's'; }, m => { m.statistic = 'p95'; },
        m => { m.source_value = 200; }, m => { m.source_value = 20 + 1e-10; }, m => { m.source_unit = 'unknown'; },
        m => { delete m.source_value; }, m => { m.availability = 'invalid'; }]) {
        const cfg = candidate(); mutate(cfg.evidence.metrics.ttft_p99);
        assert.equal(model.metricValue(cfg, 'ttft_p99'), null);
        assert.equal(model.latencyMeets(20, 500, false, cfg.evidence, 'ttft_p99'), null);
    }
});

test('unknown and mismatched historical provenance cannot verify a versioned latency pass', () => {
    const cfg = candidate();
    for (const provenance of ['unknown', 'mismatch']) {
        cfg.evidence.metrics.ttft_p99.provenance = provenance;
        assert.equal(model.latencyMeets(20, 500, false, cfg.evidence, 'ttft_p99'), null);
    }
    cfg.evidence.metrics.ttft_p99.provenance = 'verified';
    assert.equal(model.latencyMeets(20, 20, false, cfg.evidence, 'ttft_p99'), true);
    assert.equal(model.latencyMeets(20, 19, false, cfg.evidence, 'ttft_p99'), false);
    assert.equal(model.latencyMeets(1, 20, false, cfg.evidence, 'ttft_p99'), null); // Cached value corruption.
});

test('capacity requires a verified mean, not a numeric legacy alias', () => {
    const cfg = candidate();
    assert.equal(model.capacityEvidenceVerified(cfg.evidence), true);
    cfg.evidence.metrics.throughput_mean.provenance = 'unknown';
    assert.equal(model.capacityEvidenceVerified(cfg.evidence), false);
    cfg.evidence.metrics.throughput_mean.provenance = 'verified';
    cfg.evidence.metrics.throughput_mean.statistic = null;
    cfg.evidence.metrics.throughput_mean.kind = 'compatibility';
    assert.equal(model.capacityEvidenceVerified(cfg.evidence), false);
});

test('declared unknown versions, policies, run boundaries and partial contracts fail closed', () => {
    for (const mutate of [r => { r.report_contract = null; }, r => { r.report_contract.version = '1'; },
        r => { r.report_contract.version = 2; }, r => { r.report_contract.name = 'different'; },
        r => { r.report_contract.run_id = 99; }, r => { r.report_contract.estimator_calculation = 'invented'; },
        r => { delete r.all_results[0].evidence; }, r => { r.all_results = null; }]) {
        const data = report(); mutate(data);
        assert.throws(() => model.assertSupported(data, 42), /invalid|Unsupported/);
    }
    const data = report(); data.additional_future_field = { accepted: true };
    assert.equal(model.assertSupported(data, '42'), 'v1');
});

test('recommendation candidate source boundaries are checked, not just diagnostic rows', () => {
    const data = report();
    data.recommendation = { config: candidate() };
    data.recommendation.config.evidence.source.run_id = 99;
    delete data.recommendation.config.run_id;
    assert.throws(() => model.assertSupported(data), /candidate evidence/);
});

test('historical notices disclose uncertainty, mismatches and legacy rate aliases without repair', () => {
    const data = report();
    data.all_results[0].evidence.metrics.ttft_p99.provenance = 'unknown';
    data.all_results[0].evidence.metrics.itl_p90.provenance = 'mismatch';
    data.all_results[0].evidence.metrics.throughput_mean.kind = 'compatibility';
    const html = model.noticeHTML(data);
    assert.match(html, /Historical P99 provenance is Unknown/);
    assert.match(html, /P99\.9/);
    assert.match(html, /disagree with preserved raw source/);
    assert.match(html, /not a verified mean/);
    assert.match(html, /No historical values were repaired/);
    assert.match(html, /role="note"/);
});

test('the embedded factory runs identically in an isolated browser-like global', () => {
    const context = vm.createContext({});
    new vm.Script(model.embeddedSource()).runInContext(context);
    const embedded = context.ServeItReportModel;
    assert.equal(embedded.version, 1);
    assert.equal(embedded.embeddedSource(), model.embeddedSource());
    assert.equal(embedded.noticeHTML(report()), model.noticeHTML(report()));
    for (const category of ['balanced', 'lowest_ttft', 'lowest_itl', 'highest_tput', 'most_efficient', 'unknown']) {
        assert.equal(embedded.score(candidate(), category), model.score(candidate(), category));
    }
});

test('versioned GPU counts are integral deployment counts, not aliases or costs', () => {
    const cfg = candidate();
    cfg.gpus = 999;
    assert.equal(model.deploymentGpus(cfg), 2);
    assert.equal(model.score(cfg, 'most_efficient'), 5);
    for (const value of [0, -1, 2.5, Infinity, '2', true]) {
        cfg.evidence.resources.total_gpus.value = value;
        assert.equal(model.deploymentGpus(cfg), null);
        assert.equal(model.eligible(cfg), false);
    }
    cfg.evidence.resources.total_gpus.value = 2;
    cfg.evidence.resources.total_gpus.unit = 'USD';
    assert.equal(model.deploymentGpus(cfg), null);
});

test('a declared calculated request rate requires the known count/duration recipe', () => {
    const cfg = candidate();
    const m = cfg.evidence.metrics.throughput_mean;
    Object.assign(m, { value: 2, source_value: 2, kind: 'calculated', calculation: { name: 'successful_requests_per_second_v1', successful_requests: 10, duration_s: 5 } });
    assert.equal(model.score(cfg, 'highest_tput'), 2);
    assert.equal(model.capacityEvidenceVerified(cfg.evidence), true);
    assert.equal(model.throughputLabel(cfg), 'Mean throughput (calculated)');
    m.calculation.name = 'unknown_recipe';
    assert.equal(model.score(cfg, 'highest_tput'), null);
    assert.equal(model.capacityEvidenceVerified(cfg.evidence), false);
});
