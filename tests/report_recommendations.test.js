const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const categories = ['balanced', 'lowest_ttft', 'lowest_itl', 'highest_tput', 'most_efficient'];
const labels = ['Best Balanced', 'Lowest TTFT', 'Lowest ITL', 'Highest Throughput', 'Most Efficient'];
const cardStart = '<div style="background:white;border-radius:12px;overflow:hidden;';

// Only trusted, checked-in scripts run here. VM is not a security sandbox.
function harness() {
    const content = { innerHTML: '', querySelectorAll: () => [] };
    const context = vm.createContext({
        window: {}, console, _chartSuffix: '',
        document: { getElementById: id => id === 'charts-content' ? content : null },
        Plotly: { newPlot() {}, Plots: { resize() {} } },
        cid: id => id,
        chartCard: () => '', statCard: (value, label) => `<div>${label}: ${value}</div>`,
        updateEstimatorScaling() {}, initReportSubtabs() {}, setTimeout() {},
    });
    for (const filename of ['web/static/js/modules/charts.js', 'web/static/js/report-download.js']) {
        vm.runInContext(readFileSync(path.join(root, filename), 'utf8'), context, { filename });
    }
    return {
        context,
        live(data, runId = 42) {
            // Call the actual renderer, without its error-swallowing UI wrapper.
            context._renderChartsImpl(data, runId, content);
            return content.innerHTML;
        },
        export(data, runId = 42) {
            return context.buildFullReport(runId, data, data.charts, data.recommendation,
                data.summary, data.summary.best_configs, data.all_results, false, false);
        },
    };
}

function config(id = 'test-A', overrides = {}) {
    return {
        test_id: id, config_name: `Deployment ${id}`, concurrency: 7, gpus: 4,
        throughput_mean: 12.5,
        ttft_p50: 101, ttft_p90: 111, ttft_p95: 151, ttft_p99: 191,
        itl_p50: 1.01, itl_p90: 1.11, itl_p95: 1.51, itl_p99: 1.91,
        e2e_p50: 201, e2e_p90: 211, e2e_p95: 251, e2e_p99: 291,
        ...overrides,
    };
}

function allCategories(cfg) {
    return Object.fromEntries(categories.map(category => [category, cfg]));
}

function fixture(cfg = config()) {
    return {
        summary: { successful_tests: 3, best_configs: {} },
        charts: { pareto: { traces: [], pareto_table: [] }, scatter: { traces: [] },
            efficiency: { configs: [] }, architecture: { architectures: [] } },
        all_results: [],
        recommendation: { model: 'fixture-model', workload: { users: 999, isl: 100, osl: 10 },
            recommendations: { throughput: { config: cfg } },
            best_by_percentile: {
                p90: { pd: allCategories(cfg) },
                p95: { pd: allCategories(config('test-B', { ttft_p95: 951, itl_p95: 9.51, e2e_p95: 952 })) },
                p99: { pd: allCategories(config('test-C', { ttft_p99: 991, itl_p99: 9.91, e2e_p99: 992 })) },
            },
        },
    };
}

function cards(html) {
    return html.split(cardStart).slice(1).map(part => part.split('</table>')[0] + '</table>');
}

function card(html, label) {
    const found = cards(html).find(part => part.includes(` ${label}</div>`));
    assert.ok(found, `Missing ${label} card`);
    return found;
}

function row(html, percentile) {
    const rows = html.match(/<tr\b[^>]*>[\s\S]*?<\/tr>/g) || [];
    const match = rows.find(value => value.includes(`>${percentile}</td>`));
    assert.ok(match, `Missing ${percentile} row`);
    return [...match.matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/g)].map(value => value[1]);
}

for (const renderer of ['live', 'export']) {
    test(`${renderer}: distinct percentile winners never mix test metrics`, () => {
        const html = harness()[renderer](fixture());
        for (const label of labels) {
            const selected = card(html, label);
            assert.match(selected, /Deployment test-A/);
            assert.match(selected, /c=7</);
            assert.doesNotMatch(selected, /c=999/);
            assert.match(selected, /Mean throughput: <strong>12.50 req\/s/);
            assert.deepEqual(row(selected, 'P50'), ['P50', '101 ms', '201 ms', '1.01 ms']);
            assert.deepEqual(row(selected, 'P90'), ['P90', '111 ms', '211 ms', '1.11 ms']);
            assert.deepEqual(row(selected, 'P95'), ['P95', '151 ms', '251 ms', '1.51 ms']);
            assert.deepEqual(row(selected, 'P99'), ['P99', '191 ms', '291 ms', '1.91 ms']);
        }
        assert.match(html, /Source run: 42; test: test-A/);
        assert.doesNotMatch(cards(html).join(''), /Deployment test-[BC]|951 ms|991 ms/);
    });

    test(`${renderer}: missing and invalid tails stay unknown, independent ITL is retained`, () => {
        const cfg = config('test-A', { ttft_p99: null, itl_p99: undefined, e2e_p99: Infinity,
            ttft_p95: NaN, itl_p95: 0, e2e_p95: -1, concurrency: null });
        const selected = card(harness()[renderer](fixture(cfg)), 'Best Balanced');
        assert.deepEqual(row(selected, 'P95'), ['P95', 'Unknown', 'Unknown', '0.00 ms']);
        assert.deepEqual(row(selected, 'P99'), ['P99', 'Unknown', 'Unknown', 'Unknown']);
        assert.match(selected, /c=Unknown</);
        assert.doesNotMatch(selected, /NaN|Infinity|951 ms|991 ms/);
    });

    test(`${renderer}: lowest ITL wins even when balanced ratio favors another architecture`, () => {
        const data = fixture(config('balanced-winner', { ttft_p90: 1, throughput_mean: 100, itl_p90: 20 }));
        data.recommendation.best_by_percentile.p90.ep = allCategories(config('itl-winner', {
            ttft_p90: 500, throughput_mean: 1, itl_p90: 2,
        }));
        const html = harness()[renderer](data);
        assert.match(card(html, 'Best Balanced'), /Deployment balanced-winner/);
        assert.match(card(html, 'Lowest ITL'), /Deployment itl-winner/);
    });

    test(`${renderer}: same winner at every percentile keeps the normal path`, () => {
        const cfg = config();
        const data = fixture(cfg);
        data.recommendation.best_by_percentile.p95 = { pd: allCategories(cfg) };
        data.recommendation.best_by_percentile.p99 = { pd: allCategories(cfg) };
        const html = harness()[renderer](data);
        assert.equal(cards(html).length, 5);
        assert.deepEqual(row(card(html, 'Best Balanced'), 'P99'), ['P99', '191 ms', '291 ms', '1.91 ms']);
    });

    test(`${renderer}: zero latency and throughput are not replaced by truthy aliases`, () => {
        const cfg = config('zero', { ttft_p90: 0, ttft: 999, itl_p90: 0, itl: 999,
            throughput_mean: 0, throughput_p90: 999, e2e_p90: 0 });
        const data = fixture(cfg);
        const html = harness()[renderer](data);
        assert.equal(cards(html).length, 4); // A zero denominator cannot win balanced.
        const selected = card(html, 'Lowest ITL');
        assert.deepEqual(row(selected, 'P90'), ['P90', '0 ms', '0 ms', '0.00 ms']);
        assert.match(selected, /Mean throughput: <strong>0.00 req\/s/);
    });

    test(`${renderer}: invalid required scores, discarded points and missing GPU counts cannot win`, () => {
        const data = fixture();
        data.recommendation.best_by_percentile.p90 = {
            pd: {
                balanced: config('overflow', { ttft_p90: Number.MAX_VALUE, throughput_mean: Number.MIN_VALUE }),
                lowest_itl: config('missing-itl', { itl_p90: null }),
                lowest_ttft: config('invalid-ttft', { ttft_p90: NaN }),
                highest_tput: config('infinite-tput', { throughput_mean: Infinity }),
                most_efficient: config('missing-gpus', { gpus: undefined }),
            },
            aggregated: allCategories(config('discarded', { quality: 'discard' })),
            ep: allCategories(config('valid')),
        };
        const html = harness()[renderer](data);
        assert.equal(cards(html).length, 5);
        for (const label of labels) assert.match(card(html, label), /Deployment valid/);
        delete data.recommendation.best_by_percentile.p90.ep;
        assert.equal(cards(harness()[renderer](data)).length, 0);
    });

    test(`${renderer}: legacy flat payload and a partial category map remain usable`, () => {
        const data = fixture();
        data.recommendation.best_by_percentile.p90 = { aggregated: config('legacy') };
        assert.equal(cards(harness()[renderer](data)).length, 1);
        data.recommendation.best_by_percentile.p90 = { ep: { lowest_itl: config('only-itl') } };
        data.recommendation.recommendations = {};
        const html = harness()[renderer](data);
        assert.equal(cards(html).length, 1);
        assert.match(card(html, 'Lowest ITL'), /Deployment only-itl/);
    });

    test(`${renderer}: recommendation breakdown labels mean throughput, not percentile values`, () => {
        const cfg = config();
        cfg.percentiles = { ttft: { p90: 111 }, itl: { p90: 1.11 },
            throughput: { p50: 777, p90: 777, p95: 777, p99: 777 } };
        const data = fixture(cfg);
        const html = harness()[renderer](data);
        assert.match(html, /Mean throughput \(req\/s\)<\/td><td colspan="4">12.50 \(mean, not a percentile\)/);
        assert.doesNotMatch(html, />777<\/td>/);
    });

    test(`${renderer}: calibrated and cache cards preserve zeros and unavailable tails`, () => {
        for (const key of ['calibrated_best', 'cache_sweep_best']) {
            const data = fixture();
            data.recommendation.best_by_percentile = {};
            data.summary[key] = { balanced: config('sweep-test', {
                ttft_p50: 0, itl_p50: 0, e2e_p50: 0, throughput_mean: 0, throughput_p90: 999,
                ttft_p99: undefined, itl_p99: null, e2e_p99: Infinity,
            }) };
            const html = harness()[renderer](data);
            const selected = card(html, 'Best Balanced');
            assert.deepEqual(row(selected, 'P50'), ['P50', '0 ms', '0 ms', '0.00 ms']);
            assert.deepEqual(row(selected, 'P99'), ['P99', 'Unknown', 'Unknown', 'Unknown']);
            assert.match(selected, /Mean throughput: <strong>0.00 req\/s/);
            assert.match(html, /Source run: 42; test: sweep-test/);
        }
    });

    test(`${renderer}: summary metrics tolerate unknowns without inventing tail winners`, () => {
        const data = fixture();
        data.summary.best_configs = {
            lowest_latency: { name: 'partial', ttft_p90: null, ttft_p95: 0, ttft_p99: Infinity },
            lowest_itl: { name: 'partial', itl_p90: NaN },
            highest_throughput: { name: 'partial', throughput_mean: 0, throughput_p90: 999 },
            most_efficient: { efficiency: null },
        };
        const html = harness()[renderer](data);
        assert.match(html, /TTFT P95 \(P90-selected test\)/);
        assert.doesNotMatch(html, /Best TTFT P95|Best TTFT P99|Infinity ms|NaN ms|999.00 req\/s/);
    });

    test(`${renderer}: ties are stable and unavailable throughput does not become zero`, () => {
        const data = fixture();
        data.recommendation.best_by_percentile.p90.aggregated = allCategories(config('tied'));
        const html = harness()[renderer](data);
        for (const label of labels) assert.match(card(html, label), /Deployment test-A/);
        data.recommendation.best_by_percentile.p90 = { pd: {
            lowest_itl: config('no-throughput', { throughput_mean: null }),
        } };
        const selected = card(harness()[renderer](data), 'Lowest ITL');
        assert.match(selected, /Mean throughput: <strong>Unknown/);
        assert.doesNotMatch(selected, /0.00 req\/s/);
        data.recommendation.best_by_percentile = {};
        assert.equal(cards(harness()[renderer](data)).length, 0);
    });

    test(`${renderer}: recommendation manifests use test IDs, never display names`, () => {
        const h = harness();
        const data = fixture(config('manifest-test', { manifest_types: ['lws'] }));
        const html = h[renderer](data);
        if (renderer === 'live') assert.match(html, /\/api\/run\/42\/config\/manifest-test\/manifest\/lws/);
        else assert.match(html, /dlManifest\('manifest-test','lws'\)/);
        data.recommendation.best_by_percentile.p90 = { pd: {
            balanced: config(null, { manifest_types: ['lws'] }),
        } };
        const unknown = h[renderer](data);
        assert.doesNotMatch(unknown, /dlManifest\('Deployment null'|\/config\/Deployment null\/manifest\//);
    });
}

test('live: run/test action identities survive another open report with the same categories', () => {
    const h = harness();
    const first = h.live(fixture(config('shared-id')), 'run-one');
    const firstKey = first.match(/applyReportConfig\('([^']+)'\)/)[1];
    const second = h.live(fixture(config('shared-id', { throughput_mean: 8 })), 'run-two');
    const secondKey = second.match(/applyReportConfig\('([^']+)'\)/)[1];
    assert.notEqual(firstKey, secondKey);
    assert.equal(h.context.window._recConfigs[firstKey].throughput_mean, 12.5);
    assert.equal(h.context.window._recConfigs[secondKey].throughput_mean, 8);
    assert.equal(h.context.window._recConfigs[firstKey].test_id, 'shared-id');
    const unknown = h.live(fixture(config(null)), 'run-three');
    assert.doesNotMatch(unknown, /applyReportConfig\(/);
    assert.match(unknown, /Source run: run-three; test: Unknown/);
});
