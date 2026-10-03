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
    for (const filename of ['web/static/js/report-model.js', 'web/static/js/modules/charts.js', 'web/static/js/report-download.js']) {
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
            data.summary[key] = { lowest_ttft: config('sweep-test', {
                ttft_p50: 0, itl_p50: 0, e2e_p50: 0, throughput_mean: 0, throughput_p90: 999,
                ttft_p99: undefined, itl_p99: null, e2e_p99: Infinity,
            }) };
            const html = harness()[renderer](data);
            const selected = card(html, 'Lowest TTFT');
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

    test(`${renderer}: canonical and legacy denials gate normal, calibrated and cache candidates`, () => {
        for (const flags of [
            { is_ranking_eligible: false },
            { is_ranking_eligible: false, recommendation_eligible: true },
            { is_ranking_eligible: true, recommendation_eligible: false },
            { recommendation_eligible: false },
            { quality: 'discard' },
        ]) {
            const cfg = config('excluded', flags);
            const data = fixture(cfg);
            data.summary.calibrated_best = allCategories(cfg);
            data.summary.cache_sweep_best = allCategories(cfg);
            assert.equal(cards(harness()[renderer](data)).length, 0, JSON.stringify(flags));
        }
        const cfg = config('warning', { quality: 'warning', is_ranking_eligible: true });
        assert.equal(cards(harness()[renderer](fixture(cfg))).length, 5);
    });

    test(`${renderer}: invalid sweep objective scores are not presented as recommendations`, () => {
        for (const key of ['calibrated_best', 'cache_sweep_best']) {
            const data = fixture();
            data.recommendation.best_by_percentile = {};
            data.summary[key] = {
                balanced: config('zero-denominator', { throughput_mean: 0 }),
                lowest_ttft: config('bad-ttft', { ttft_p90: -1 }),
                lowest_itl: config('bad-itl', { itl_p90: null }),
                highest_tput: config('bad-tput', { throughput_mean: NaN, throughput_p90: 100 }),
                most_efficient: config('bad-gpus', { gpus: 0 }),
            };
            assert.equal(cards(harness()[renderer](data)).length, 0);
        }
    });

    test(`${renderer}: numeric provenance uses immutable manifests and recorded concurrency copy`, () => {
        const html = harness()[renderer](fixture(config('legacy-route', { test_config_id: 123, manifest_types: ['lws'] })));
        assert.match(html, /Source run: 42; test: legacy-route; test config ID: 123/);
        assert.match(html, /Recorded c=7/);
        assert.match(html, /not measured average concurrency/);
        assert.doesNotMatch(html, /at its actual concurrency/);
        if (renderer === 'live') assert.match(html, /\/test\/123\/manifest\/lws/);
        else assert.match(html, /dlManifest\('legacy-route','lws',123\)/);
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

test('live: same legacy ID with different immutable IDs has separate action bindings and rerender cleanup', () => {
    const h = harness();
    const first = config('shared', { test_config_id: 101 });
    const second = config('shared', { test_config_id: 102, throughput_mean: 80 });
    const data = fixture(first);
    data.recommendation.best_by_percentile.p90.pd.highest_tput = second;
    const html = h.live(data);
    const keys = [...html.matchAll(/applyReportConfig\('([^']+)'\)/g)].map(m => m[1]);
    assert.equal(new Set(keys).size, 2);
    assert.deepEqual(new Set(Object.values(h.context.window._recConfigs).map(r => r.test_config_id)), new Set([101, 102]));
    const other = h.live(fixture(config('shared', { test_config_id: 101 })), 99);
    const otherKey = other.match(/applyReportConfig\('([^']+)'\)/)[1];
    h.live(fixture(second));
    assert.equal(Object.values(h.context.window._recConfigs).filter(r => r.run_id === 42).length, 1);
    assert.ok(h.context.window._recConfigs[otherKey]);
    h.context.clearReportActions('42');
    assert.deepEqual(Object.keys(h.context.window._recConfigs), [otherKey]);
});

function exportRuntime(data) {
    const h = harness();
    const html = h.export(data);
    const blobs = [], downloads = [], alerts = [];
    const context = vm.createContext({
        console, Blob, setTimeout() {},
        document: {
            getElementById() { return null; }, querySelectorAll() { return []; },
            createElement() { return { click() { downloads.push(this.download); } }; },
        },
        URL: { createObjectURL(blob) { blobs.push(blob); return 'blob:manifest'; }, revokeObjectURL() {} },
        alert(message) { alerts.push(message); },
    });
    for (const [, script] of html.matchAll(/<script>([\s\S]*?)<\/script>/g)) {
        new vm.Script(script).runInContext(context, { timeout: 1000 });
    }
    return { h, html, context, blobs, downloads, alerts };
}

test('export: immutable manifest downloads never merge equal legacy names or fall back from a missing ID', async () => {
    const first = config('shared', { test_config_id: 101, architecture: 'AGGREGATED', manifest_types: ['lws'], manifests: { lws: 'kind: First' } });
    const second = config('shared', { ...first, test_config_id: 102, manifests: { lws: 'kind: Second' } });
    const data = fixture(first);
    data.all_results = [first, second];
    const r = exportRuntime(data);
    r.context.dlManifest('shared', 'lws', 101);
    r.context.dlManifest('shared', 'lws', 102);
    assert.deepEqual(await Promise.all(r.blobs.map(blob => blob.text())), ['kind: First', 'kind: Second']);
    assert.deepEqual(r.downloads, ['run-42-test-101-lws.yaml', 'run-42-test-102-lws.yaml']);
    r.context.dlManifest('shared', 'lws', 999);
    r.context.dlManifest('shared', 'lws');
    assert.equal(r.downloads.length, 2);
    assert.equal(r.alerts.length, 2);
});

test('export: valid legacy manifests still download, but ambiguous legacy identities fail closed', async () => {
    const first = config('legacy', { architecture: 'AGGREGATED', manifests: { lws: 'legacy-yaml' } });
    const data = fixture(first);
    data.all_results = [first];
    let r = exportRuntime(data);
    r.context.dlManifest('legacy', 'lws');
    assert.equal(await r.blobs[0].text(), 'legacy-yaml');
    assert.deepEqual(r.downloads, ['legacy-lws.yaml']);
    data.all_results.push({ ...first, manifests: { lws: 'other-yaml' } });
    r = exportRuntime(data);
    r.context.dlManifest('legacy', 'lws');
    assert.equal(r.downloads.length, 0);
    assert.equal(r.alerts.length, 1);
});

test('manifest actions encode quoted identities and preserve script-like YAML exactly', async () => {
    const yaml = 'kind: ConfigMap\ndata: "</script><script>unsafe()</script>"\n# \u2028\u2029 café';
    const first = config("quoted'&name", { test_config_id: 101, architecture: 'AGGREGATED', manifest_types: ['lws'], manifests: { lws: yaml } });
    const data = fixture(first);
    data.all_results = [first];
    const r = exportRuntime(data);
    const call = r.h.context.dlManifestCall(first, 'lws');
    assert.equal(call, "dlManifest('quoted%27%26name','lws',101);return false;");
    vm.runInContext(call.replace(';return false;', ';'), r.context);
    assert.equal(await r.blobs[0].text(), yaml);
    assert.doesNotMatch(r.html, /<script>unsafe\(\)/);
    assert.equal(r.h.context.reportManifestUrl(42, first, 'lws'), '/api/run/42/test/101/manifest/lws');
    assert.equal(r.h.context.reportManifestUrl(42, { test_id: first.test_id }, 'lws'), '/api/run/42/config/quoted%27%26name/manifest/lws');
    assert.equal(r.h.context.reportManifestUrl(42, {}, 'lws'), null);
});

test('export: own-property checks reject prototype keys and preserve explicit empty text', async () => {
    const first = config('prototype', { test_config_id: 101, architecture: 'AGGREGATED', manifests: JSON.parse('{"__proto__":"prototype-yaml","empty":""}') });
    const data = fixture(first);
    data.all_results = [first];
    const r = exportRuntime(data);
    r.context.dlManifest('prototype', '__proto__', 101);
    r.context.dlManifest('prototype', 'empty', 101);
    r.context.dlManifest('prototype', 'toString', 101);
    assert.deepEqual(await Promise.all(r.blobs.map(blob => blob.text())), ['prototype-yaml', '']);
    assert.equal(r.alerts.length, 1);
});

test('export: manifest refresh matches immutable IDs rather than the first equal name', async () => {
    const first = config('shared', { test_config_id: 101, architecture: 'AGGREGATED', manifest_types: ['lws'] });
    const second = { ...first, test_config_id: 102 };
    const data = fixture(first);
    data.all_results = [first, second];
    const h = harness();
    h.context.fetch = async () => ({ ok: true, json: async () => ({ all_results: [
        { ...second, manifests: { lws: 'second-yaml' } }, { ...first, manifests: { lws: 'first-yaml' } },
    ] }) });
    h.context.Blob = Blob;
    h.context.URL = { createObjectURL() { return 'blob:html'; }, revokeObjectURL() {} };
    h.context.document.createElement = () => ({ click() {} });
    await h.context.downloadHTMLReport(42, data);
    assert.equal(first.manifests.lws, 'first-yaml');
    assert.equal(second.manifests.lws, 'second-yaml');
});

test('live: a source with no manifests cannot borrow downloads from another test sharing its name', () => {
    const first = config('shared', { test_config_id: 101 });
    const data = fixture(first);
    data.all_results = [{ ...first }, { ...first, test_config_id: 102, manifest_types: ['lws'] }];
    const html = harness().live(data);
    const recommendation = html.split('data-subtab-pane="recommendation">')[1].split('<div class="report-subtab-pane"')[0];
    assert.doesNotMatch(recommendation, /\/test\/101\/manifest/);
    assert.match(html, /\/test\/102\/manifest\/lws/);
});

for (const key of ['normal', 'calibrated_best', 'cache_sweep_best']) {
    test(`${key}: live/export manifest links use the selected immutable source`, () => {
        const first = config('shared', { test_config_id: 101 });
        const source = { ...first, architecture: 'AGGREGATED', manifest_types: ['lws', 'service'], manifests: { lws: 'own-yaml' } };
        const data = fixture(first);
        data.all_results = [source, { ...source, test_config_id: 102, manifests: { lws: 'wrong-yaml' } }];
        if (key !== 'normal') {
            data.recommendation.best_by_percentile = {};
            data.summary[key] = { balanced: first };
        }
        const h = harness();
        const live = h.live(data).split('data-subtab-pane="recommendation">')[1].split('<div class="report-subtab-pane"')[0];
        const exported = h.export(data).split('<div id="dl-pane-rec"')[1].split('<div id="dl-pane-')[0];
        assert.match(live, /\/test\/101\/manifest\/lws/);
        assert.match(exported, /dlManifest\('shared','lws',101\)/);
        assert.doesNotMatch(live, /\/test\/102\/manifest\/lws|\/manifest\/service/);
        assert.doesNotMatch(exported, /dlManifest\('shared','lws',102\)|dlManifest\('shared','service'/);
    });
}

test('unsupported declared evidence versions clear this run actions and refuse live/export rendering', () => {
    const h = harness();
    h.live(fixture(), 42);
    h.live(fixture(), 99);
    const data = fixture();
    data.report_contract = { name: 'serveit.report', version: 2, run_id: 42 };
    assert.throws(() => h.live(data), /Unsupported or invalid/);
    assert.throws(() => h.export(data), /Unsupported or invalid/);
    assert.ok(Object.values(h.context.window._recConfigs).every(cfg => cfg.run_id === 99));
});

test('legacy rate aliases are explicitly labelled, never advertised as a verified mean', () => {
    const cfg = config('legacy-rate', { throughput_mean: null, throughput_p90: 12.5 });
    for (const renderer of ['live', 'export']) {
        const html = harness()[renderer](fixture(cfg));
        assert.match(card(html, 'Highest Throughput'), /Reported throughput \(legacy alias\): <strong>12.50 req\/s/);
    }
});
