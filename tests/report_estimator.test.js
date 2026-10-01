'use strict';

const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const vm = require('node:vm');

// VM is a global-isolation tool, not a security boundary. Execute only this
// trusted, checked-in application script; never fixture-supplied JavaScript.
const filename = path.join(__dirname, '../web/static/js/modules/report.js');
const script = new vm.Script(readFileSync(filename, 'utf8'), { filename });
const targets = {
    target_tput: 100, ttft_target: 500, ttft_pctl: 'p99', itl_target: 20, itl_pctl: 'p90',
};

function point(overrides = {}) {
    return {
        test_id: 'step12-agg-c8', config_name: 'Same display name', architecture: 'aggregated',
        throughput_mean: 50, gpus: 2, ttft_p99: 400, itl_p90: 10, concurrency: 8,
        ...overrides,
    };
}

function harness(points = []) {
    const elements = new Map();
    const plots = [];
    const purges = [];
    const downloads = [];
    const blobs = [];
    const alerts = [];
    const images = [];
    function element(id) {
        if (!elements.has(id)) elements.set(id, { id, innerHTML: '', value: '', addEventListener() {} });
        return elements.get(id);
    }
    const context = vm.createContext({
        document: {
            getElementById: element,
            createElement(tag) {
                assert.equal(tag, 'a');
                return { click() { downloads.push({ href: this.href, download: this.download }); } };
            },
        },
        Plotly: {
            newPlot(id, traces, layout) {
                const plot = { id, traces, layout };
                element(id).plot = plot;
                plots.push(plot);
                return Promise.resolve();
            },
            purge(el) { purges.push(el.id); delete el.plot; },
            toImage(el) {
                assert.ok(el.plot, 'export must use an existing plot');
                images.push(el.plot);
                return Promise.resolve('data:image/svg+xml;base64,PHN2Zy8+');
            },
        },
        Blob,
        URL: {
            createObjectURL(blob) { blobs.push(blob); return 'blob:estimator'; },
            revokeObjectURL(url) { assert.equal(url, 'blob:estimator'); },
        },
        alert(message) { alerts.push(message); },
    });
    script.runInContext(context, { timeout: 1000 });
    function setup(suffix, rows, runId) {
        const tabId = suffix.slice(1);
        context.tabDataCache[tabId] = { all_results: rows };
        context.reportTabs.push({ id: tabId, runId });
        for (const [field, value] of Object.entries({
            'tput-target': '100', 'ttft-target': '500', 'ttft-pctl': 'p99', 'itl-target': '20', 'itl-pctl': 'p90',
        })) element('est-' + field + suffix).value = value;
    }
    setup('-rt1', points, 42);
    return {
        context, element, plots, purges, downloads, blobs, alerts, images, setup,
        run(suffix = '-rt1') {
            context.runEstimator(suffix);
            return context._lastEstResults[suffix];
        },
        html(suffix = '-rt1') { return element('est-results' + suffix).innerHTML; },
        async export(suffix = '-rt1') {
            await context.downloadEstimatorReport(suffix);
            return blobs.at(-1).text();
        },
    };
}

function bestRows(html) {
    return html.match(/<tr class="estimator-best">[\s\S]*?<\/tr>/g) || [];
}

async function assertExportParity(h, suffix = '-rt1') {
    const html = h.html(suffix);
    const exported = await h.export(suffix);
    assert.ok(exported.includes(html), 'export must include exactly the same evidence and status HTML');
    assert.equal(h.images.at(-1), h.element('est-chart' + suffix).plot);
    assert.equal(h.downloads.at(-1).download, 'gpu-estimate-100rps.html');
    assert.equal(bestRows(exported).length, bestRows(html).length);
    return exported;
}

test('all unknown points are diagnostic, never passing or best, including export', async () => {
    const h = harness([point({ ttft_p99: null, itl_p90: undefined }), point({ test_id: 'other', itl_p90: null })]);
    const rows = h.run();
    assert.equal(rows.length, 2);
    assert.ok(rows.every(r => h.context.estimatorOutcome(r).status === 'Unknown'));
    assert.match(h.html(), /No verified feasible operating point/);
    assert.match(h.html(), /Unknown \(TTFT Unknown; ITL Unknown\)/);
    assert.equal(bestRows(h.html()).length, 0);
    assert.deepEqual(Array.from(h.plots[0].traces[0].marker.color), ['#64748b', '#64748b']);
    assert.ok(h.plots[0].traces[0].text.every(t => t.includes('Unknown')));
    await assertExportParity(h);
});

test('failure dominates unknown without concealing either constraint in any output', async () => {
    const h = harness([
        point({ ttft_p99: null, itl_p90: 21 }),
        point({ test_id: 'other', ttft_p99: 501, itl_p90: null }),
        point({ test_id: 'both-fail', ttft_p99: 501, itl_p90: 21 }),
    ]);
    h.run();
    for (const text of ['Fail (TTFT Unknown; ITL Fail)', 'Fail (TTFT Fail; ITL Unknown)', 'Fail (TTFT Fail; ITL Fail)']) {
        assert.ok(h.html().includes(text));
        assert.ok(h.plots[0].traces[0].text.some(t => t.includes(text)));
    }
    assert.ok(h.plots[0].traces[0].marker.color.every(c => c === '#ef4444'));
    assert.equal(bestRows(h.html()).length, 0);
    await assertExportParity(h);
});

test('cheapest failed or unknown points cannot suppress the cheapest verified feasible highlight', async () => {
    const h = harness([
        point({ test_id: 'cheap-fail', throughput_mean: 100, gpus: 1, ttft_p99: 900 }),
        point({ test_id: 'cheap-unknown', throughput_mean: 100, gpus: 1, itl_p90: null }),
        point({ test_id: 'feasible' }),
        point({ test_id: 'expensive-feasible', gpus: 4 }),
    ]);
    h.run();
    const best = bestRows(h.html());
    assert.equal(best.length, 1);
    assert.match(best[0], /Test feasible \/ row 3/);
    assert.doesNotMatch(h.html(), /No verified feasible operating point/);
    assert.deepEqual(Array.from(h.plots[0].traces[0].marker.color), ['#ef4444', '#64748b', '#059669', '#d97706']);
    await assertExportParity(h);
});

test('a faster failing point does not hide a slower passing point with the same config label', async () => {
    const h = harness([
        point({ test_id: 'fast', throughput_mean: 100, ttft_p99: 900, concurrency: 32, cache_hit_pct: 80 }),
        point({ test_id: 'slow', throughput_mean: 25, concurrency: 8, cache_hit_pct: 0,
            metrics_json: JSON.stringify({ concurrency_mean: 7.8 }),
            test_config: { prefix_cache_hit_pct: 0, prefix_cache_mode: 'identical', prefix_cache_groups: 1, enable_prefix_caching: false } }),
    ]);
    const rows = h.run();
    assert.equal(rows.length, 2);
    assert.equal(rows[1].replicas, 4);
    assert.equal(rows[1].total_gpus, 8);
    assert.match(bestRows(h.html())[0], /Test slow/);
    assert.match(h.html(), /Recorded concurrency: 8; measured concurrency: 7.8/);
    assert.match(h.html(), /measured cache hit: 0%; configured prefix cache: 0%; mode: identical; groups: 1; prefix caching: disabled/);
    assert.equal(new Set(h.plots[0].traces[0].y).size, 2);
    assert.ok(h.plots[0].layout.yaxis.ticktext.every(t => t.includes('Run 42 / Test')));
    await assertExportParity(h);
});

test('missing, non-finite, negative and nonnumeric latency never verify a pass', async () => {
    const invalid = [undefined, null, NaN, Infinity, -Infinity, -1, '10', '', false];
    const points = invalid.flatMap((value, i) => [
        point({ test_id: 'ttft-' + i, ttft_p99: value }),
        point({ test_id: 'itl-' + i, itl_p90: value }),
    ]);
    const h = harness(points);
    const rows = h.run();
    assert.equal(rows.length, points.length);
    assert.ok(rows.every(r => h.context.estimatorOutcome(r).status === 'Unknown'));
    assert.equal(bestRows(h.html()).length, 0);
    assert.doesNotMatch(h.html(), /NaN|Infinity/);
    await assertExportParity(h);
});

test('zero ITL is unknown, explicit zero TTFT is valid, and equality passes', () => {
    const h = harness([
        point({ test_id: 'zero-itl', itl_p90: 0 }),
        point({ test_id: 'zero-ttft', ttft_p99: 0 }),
        point({ test_id: 'equal', ttft_p99: 500, itl_p90: 20 }),
    ]);
    const rows = h.run();
    assert.equal(rows[0].itl_meets, null);
    assert.equal(rows[1].ttft_meets, true);
    assert.equal(rows[2].ttft_meets, true);
    assert.equal(rows[2].itl_meets, true);
    assert.equal(bestRows(h.html()).length, 2);
    assert.match(h.html(), /zero ITL is also Unknown/);
});

test('selected percentiles are exact and are never substituted', () => {
    const h = harness();
    for (const pctl of ['p50', 'p90', 'p95', 'p99']) {
        const rows = h.context.calculateEstimatorResults([point({
            ttft_p50: 50, ttft_p90: 90, ttft_p95: 95, ttft_p99: 99,
            itl_p50: 5, itl_p90: 9, itl_p95: 9.5, itl_p99: 9.9,
        })], { ...targets, ttft_pctl: pctl, itl_pctl: pctl }, 42);
        assert.equal(rows[0].ttft_val, Number(pctl.slice(1)));
        assert.equal(rows[0].itl_val, Number(pctl.slice(1)) / 10);
    }
    const [missing] = h.context.calculateEstimatorResults([point({ ttft_p99: undefined, ttft_p999: 1, ttft_p90: 1 })], targets, 42);
    assert.equal(missing.ttft_meets, null);
    // Renderers must not trust stale/forged flags over the actual evidence.
    missing.ttft_meets = true;
    assert.equal(h.context.estimatorOutcome(missing).status, 'Unknown');
});

test('invalid targets clear previous table, chart and export rather than applying defaults', () => {
    for (const field of ['tput-target', 'ttft-target', 'itl-target']) {
        for (const invalid of ['', ' ', '0', '-1', 'NaN', 'Infinity', '-Infinity', '1e309', '10junk', '0x10']) {
            const h = harness([point()]);
            h.run();
            assert.equal(bestRows(h.html()).length, 1);
            h.element('est-' + field + '-rt1').value = invalid;
            assert.equal(h.run().length, 0, field + '=' + invalid);
            assert.match(h.html(), /role="alert"/);
            assert.match(h.html(), /finite number greater than zero/);
            assert.equal(bestRows(h.html()).length, 0);
            assert.equal(h.element('est-chart-rt1').plot, undefined);
            h.context.downloadEstimatorReport('-rt1');
            assert.equal(h.downloads.length, 0);
            assert.equal(h.alerts.length, 1);
        }
    }
});

test('helper validation rejects invalid types/percentiles and accepts positive fractional/scientific targets', () => {
    const h = harness();
    for (const invalid of [undefined, null, false, true, [], {}, NaN, Infinity, 0, -1]) {
        assert.throws(() => h.context.calculateEstimatorResults([], { ...targets, target_tput: invalid }), /finite number/);
    }
    for (const pctl of ['', 'p999', '<script>']) {
        assert.throws(() => h.context.calculateEstimatorResults([], { ...targets, ttft_pctl: pctl }), /supported/);
        assert.throws(() => h.context.calculateEstimatorResults([], { ...targets, itl_pctl: pctl }), /supported/);
    }
    const [r] = h.context.calculateEstimatorResults([point()], { ...targets, target_tput: ' 1e2 ', itl_target: '.5', ttft_target: '+500.' });
    assert.equal(r.target_tput, 100);
    assert.equal(r.itl_target, 0.5);
    assert.equal(r.itl_meets, false);
});

test('all cheapest verified ties are highlighted in source order, not unknown ties', async () => {
    const h = harness([
        point({ test_id: 'tie-b' }), point({ test_id: 'tie-a' }), point({ test_id: 'tie-unknown', itl_p90: null }),
    ]);
    const rows = h.run();
    assert.deepEqual(Array.from(rows, r => r.test_id), ['tie-b', 'tie-a', 'tie-unknown']);
    const best = bestRows(h.html());
    assert.equal(best.length, 2);
    assert.match(best[0], /tie-b/);
    assert.match(best[1], /tie-a/);
    await assertExportParity(h);
});

test('empty and all-excluded results clear a previous plot and cannot export stale estimates', () => {
    const h = harness([point()]);
    h.run();
    h.context.tabDataCache.rt1.all_results = [];
    assert.equal(h.run().length, 0);
    assert.match(h.html(), /No eligible measured operating points/);
    assert.match(h.html(), /No verified feasible operating point/);
    assert.equal(h.element('est-chart-rt1').plot, undefined);
    h.context.downloadEstimatorReport('-rt1');
    assert.equal(h.downloads.length, 0);
    h.context.tabDataCache.rt1.all_results = [
        point({ test_id: 'step2-cal' }), point({ test_id: 'step3-cal' }), point({ quality: 'discard' }),
    ];
    assert.equal(h.run().length, 0);
    h.context.tabDataCache.rt1.all_results.push(point({ test_id: 'step12-real' }));
    assert.equal(h.run().length, 1);
    assert.match(bestRows(h.html())[0], /step12-real/);
});

test('invalid capacity stays diagnostic, with explicit legacy throughput fallback only when mean is absent', async () => {
    const h = harness([
        ...[NaN, Infinity, -Infinity, -1, 0, '50'].map((value, i) => point({ test_id: 'bad-tput-' + i, throughput_mean: value, throughput_p90: 100 })),
        ...[undefined, NaN, Infinity, -1, 0, 1.5, '2'].map((value, i) => point({ test_id: 'bad-gpus-' + i, gpus: value })),
        point({ test_id: 'missing-throughput', throughput_mean: undefined }),
        point({ test_id: 'overflow', throughput_mean: Number.MIN_VALUE }),
    ]);
    const rows = h.run();
    assert.ok(rows.every(r => r.total_gpus === null && r.replicas === null));
    assert.ok(rows.every(r => h.context.estimatorOutcome(r).status === 'Unknown'));
    assert.equal(bestRows(h.html()).length, 0);
    assert.match(h.html(), /capacity Unknown/);
    await assertExportParity(h);
    const [legacy] = h.context.calculateEstimatorResults([point({ throughput_mean: null, throughput_p90: 50 })], targets, 42);
    assert.equal(legacy.total_gpus, 4);
    assert.equal(legacy.throughput_source, 'legacy throughput_p90');
    const [tiny] = h.context.calculateEstimatorResults([point({ throughput_mean: Number.MAX_VALUE })], { ...targets, target_tput: Number.MIN_VALUE }, 42);
    assert.equal(tiny.replicas, 1, 'underflow must not estimate zero deployments');
});

test('source identity and unlike conditions remain separate, with dynamic HTML escaped', async () => {
    const h = harness([
        point({ test_id: 'same-test', run_id: 11, config_name: '<img src=x onerror="boom">', architecture: '<b>pd</b>' }),
        point({ test_id: 'same-test', run_id: 12, config_name: '<img src=x onerror="boom">', concurrency: 64 }),
        point({ test_id: undefined, metrics_json: 'not json', test_config: { prefix_cache_mode: '<script>bad</script>' } }),
        point({ test_id: undefined }),
    ]);
    const rows = h.run();
    assert.equal(rows.length, 4);
    assert.match(h.html(), /Run 11 \/ Test same-test/);
    assert.match(h.html(), /Run 12 \/ Test same-test/);
    assert.match(h.html(), /Run 42 \/ Test Unknown \/ row 3/);
    assert.match(h.html(), /Run 42 \/ Test Unknown \/ row 4/);
    assert.doesNotMatch(h.html(), /<img|<script>|<b>pd/);
    assert.match(h.html(), /&lt;img/);
    assert.match(h.html(), /&lt;script&gt;bad/);
    assert.ok(h.plots[0].layout.yaxis.ticktext.every(t => !t.includes('<img')));
    assert.equal(new Set(h.plots[0].traces[0].y).size, 4);
    const exported = await assertExportParity(h);
    assert.doesNotMatch(exported, /<script>bad|<img src=x/);
});

test('multiple tabs keep independent source runs, results and exports', async () => {
    const h = harness([point({ test_id: 'run42-test' })]);
    h.setup('-rt2', [point({ test_id: 'run99-test', ttft_p99: null })], 99);
    h.run();
    h.run('-rt2');
    assert.equal(bestRows(h.html()).length, 1);
    assert.equal(bestRows(h.html('-rt2')).length, 0);
    const first = await assertExportParity(h);
    const second = await assertExportParity(h, '-rt2');
    assert.match(first, /Run 42 \/ Test run42-test/);
    assert.doesNotMatch(first, /run99-test/);
    assert.match(second, /Run 99 \/ Test run99-test/);
    assert.doesNotMatch(second, /run42-test/);
});

test('scaling explanation describes whole deployments and assumptions, not an unqualified guarantee', async () => {
    const h = harness([point()]);
    h.context.updateEstimatorScaling('-rt1');
    const copy = h.element('est-scaling-info-rt1').innerHTML;
    assert.match(copy, /Linear scaling estimate/);
    assert.match(copy, /whole measured deployment/);
    assert.match(copy, /same workload/);
    assert.match(copy, /Fleet-level throughput and latency SLOs are not verified/);
    assert.doesNotMatch(copy, /no workload scaling or estimation|per replica/);
    h.run();
    assert.ok(h.html().includes(copy));
    await assertExportParity(h);
});

test('all nine constraint combinations agree across actual rendering, chart and export', async () => {
    const ttftCases = [[400, 'Pass'], [600, 'Fail'], [undefined, 'Unknown']];
    const itlCases = [[10, 'Pass'], [30, 'Fail'], [undefined, 'Unknown']];
    for (const [ttft, ttftStatus] of ttftCases) {
        for (const [itl, itlStatus] of itlCases) {
            const h = harness([point({ ttft_p99: ttft, itl_p90: itl })]);
            const [r] = h.run();
            const expected = ttftStatus === 'Fail' || itlStatus === 'Fail' ? 'Fail' :
                (ttftStatus === 'Pass' && itlStatus === 'Pass' ? 'Pass' : 'Unknown');
            assert.equal(h.context.estimatorOutcome(r).status, expected);
            const text = `${expected} (TTFT ${ttftStatus}; ITL ${itlStatus})`;
            assert.ok(h.html().includes(text));
            assert.ok(h.plots[0].traces[0].text[0].includes(text));
            assert.equal(bestRows(h.html()).length, expected === 'Pass' ? 1 : 0);
            if (expected === 'Pass') assert.match(h.plots[0].traces[0].text[0], /Best feasible/);
            else assert.match(h.plots[0].layout.title.text, /No verified feasible operating point/);
            await assertExportParity(h);
        }
    }
});
