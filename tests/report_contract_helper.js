'use strict';

// Python supplies JSON data, never JavaScript. Only checked-in application
// scripts execute in VM; this is global isolation, not a security sandbox.
const { readFileSync } = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

async function main() {
    const { data, runId, targets } = JSON.parse(readFileSync(0, 'utf8'));
    const elements = new Map();
    const blobs = [];
    const plots = [];
    const content = { innerHTML: '', querySelectorAll: () => [] };
    const element = id => {
        if (!elements.has(id)) elements.set(id, { id, innerHTML: '', style: {}, value: '', addEventListener() {} });
        return elements.get(id);
    };
    const context = vm.createContext({
        window: {}, console, _chartSuffix: '',
        document: {
            getElementById: id => id === 'charts-content' ? content :
                (/^(chart-add-btn|chart-compare-btn|est-)/.test(id) ? element(id) : null),
            createElement: () => ({ click() {} }),
        },
        Plotly: {
            newPlot(id, traces, layout) { plots.push({ id, traces, layout }); },
            purge() {}, Plots: { resize() {} },
            toImage: () => Promise.resolve('data:image/svg+xml;base64,PHN2Zy8+'),
        },
        Blob,
        URL: { createObjectURL(blob) { blobs.push(blob); return 'blob:contract'; }, revokeObjectURL() {} },
        alert(message) { throw new Error(message); },
        cid: id => id,
        chartCard: () => '', statCard: (value, label) => `<div>${label}: ${value}</div>`,
        updateEstimatorScaling() {}, initReportSubtabs() {}, setTimeout() {},
    });
    const root = path.resolve(__dirname, '..');
    for (const file of ['web/static/js/report-model.js', 'web/static/js/modules/charts.js', 'web/static/js/report-download.js']) {
        new vm.Script(readFileSync(path.join(root, file), 'utf8'), { filename: file })
            .runInContext(context, { timeout: 1000 });
    }
    context._renderChartsImpl(data, runId, content);
    const live = content.innerHTML;
    const exported = context.buildFullReport(runId, data, data.charts, data.recommendation,
        data.summary, data.summary.best_configs || {}, data.all_results, false, false);
    const actions = Object.entries(context.window._recConfigs);
    const scores = data.all_results.map(row => ({
        id: row.test_config_id,
        live: context.recommendationScore(row, 'highest_tput'),
        exported: context.dlRecommendationScore(row, 'highest_tput'),
    }));
    const file = 'web/static/js/modules/report.js';
    new vm.Script(readFileSync(path.join(root, file), 'utf8'), { filename: file })
        .runInContext(context, { timeout: 1000 });
    context.tabDataCache.contract = data;
    context.reportTabs.push({ id: 'contract', runId });
    for (const [key, value] of Object.entries(targets)) {
        const fields = { target_tput: 'tput-target', ttft_target: 'ttft-target', ttft_pctl: 'ttft-pctl',
            itl_target: 'itl-target', itl_pctl: 'itl-pctl' };
        element('est-' + fields[key] + '-contract').value = String(value);
    }
    context.runEstimator('-contract');
    const rows = context._lastEstResults['-contract'];
    const estimator = element('est-results-contract').innerHTML;
    await context.downloadEstimatorReport('-contract');
    const estimatorExport = await blobs.at(-1).text();
    const plot = plots.find(p => p.id === 'est-chart-contract');
    process.stdout.write(JSON.stringify({ live, exported, actions, scores, estimator, estimatorExport, plot,
        modelVersion: context.ServeItReportModel.version, evidenceNotice: context.ServeItReportModel.noticeHTML(data),
        bestGpus: context.estimatorBestGpus(rows),
        rows: rows.map(row => ({ ...row, outcome: context.estimatorOutcome(row), source: context.estimatorSource(row) })),
    }));
}

main().catch(error => { console.error(error); process.exitCode = 1; });
