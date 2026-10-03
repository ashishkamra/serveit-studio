// report.js — Tabbed report management, estimator, tab switching

// ===== TABBED REPORT MANAGEMENT =====
var reportTabs = [];
var activeTabId = null;
var tabDataCache = {};
var _tabCounter = 0;
var _chartSuffix = '';
function cid(id) { return id + _chartSuffix; }

document.getElementById('chart-add-btn').addEventListener('click', () => {
    const runId = document.getElementById('chart-run-select').value;
    if (runId) addReportTab(runId);
});

document.getElementById('chart-compare-btn').addEventListener('click', function() { generateComparison(); });

function loadRunList() {
    fetch('/api/runs')
        .then(r => r.json())
        .then(runs => {
            const sel = document.getElementById('chart-run-select');
            sel.innerHTML = '';
            if (!runs.length) {
                sel.innerHTML = '<option value="">No runs found</option>';
                return;
            }
            runs.forEach(run => {
                const opt = document.createElement('option');
                opt.value = run.id;
                const modelShort = (run.model || '').split('/').pop() || '?';
                const goalMap = { ttft: 'TTFT', throughput: 'Throughput', balanced: 'Full Coverage' };
                const goal = goalMap[(run.goal || '').toLowerCase()] || run.goal || '?';
                let workload = '';
                if (run.isl && run.osl) {
                    let rcfg = null;
                    try { rcfg = run.config_json ? JSON.parse(run.config_json) : null; } catch(e) {}
                    const cpt2 = (rcfg && rcfg.chars_per_token) || 4.5;
                    const dIsl = (rcfg && rcfg.isl_original_chars) || Math.round(run.isl * cpt2);
                    const dOsl = (rcfg && rcfg.osl_original_chars) || Math.round(run.osl * cpt2);
                    const dIslStd = run.isl_stdev ? ((rcfg && rcfg.isl_stdev_original_chars) || Math.round(run.isl_stdev * cpt2)) : null;
                    workload = `${run.isl}`;
                    if (run.isl_stdev) workload += `+${run.isl_stdev}`;
                    workload += ` (${dIsl.toLocaleString()} chars)`;
                    workload += ` / ${run.osl} (${dOsl.toLocaleString()} chars)`;
                    if (run.turns && run.turns > 1) workload += ` ${run.turns}T`;
                }
                const users = run.num_users ? `${run.num_users}u` : '';
                const gpus = run.max_gpus ? `${run.max_gpus}GPU` : '';
                const date = run.created_at ? new Date(run.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '';
                const _st = run.status || 'unknown';
                const statusLabel = _st.indexOf('completed') === 0 ? '\u2705 completed' : _st === 'running' ? '\u23F3 running' : _st === 'stopped' ? '\u23F9 stopped' : _st === 'interrupted' ? '\u23F9 interrupted' : '\u274C ' + _st;
                const desc = run.notes ? `"${run.notes}"` : '';
                let imgTag = '';
                if (run.config_json) {
                    try { const rc = JSON.parse(run.config_json); imgTag = rc.image ? rc.image.split(':').pop() : ''; } catch(e) {}
                }
                const parts = [`#${run.id}`, desc, goal, modelShort, workload, users, gpus, imgTag, statusLabel, date].filter(Boolean);
                opt.textContent = parts.join(' | ');
                sel.appendChild(opt);
            });
            // No auto-load — let the user choose
        })
        .catch(err => {
            document.getElementById('charts-content').innerHTML =
                `<div class="charts-loading">Failed to load runs: ${err.message}</div>`;
        });
}

function addReportTab(runId) {
    // If tab for this run already exists, just switch to it
    const existing = reportTabs.find(t => t.runId == runId && !t.isComparison);
    if (existing) { switchReportTab(existing.id); return; }

    const tabId = 'rt' + (++_tabCounter);
    const sel = document.getElementById('chart-run-select');
    const opt = sel.querySelector('option[value="' + runId + '"]');
    const label = opt ? opt.textContent : 'Run #' + runId;

    reportTabs.push({ id: tabId, runId: runId, label: label, isComparison: false });

    // Remove placeholder text if present
    const placeholder = document.querySelector('#charts-content > .charts-loading');
    if (placeholder) placeholder.remove();

    // Create panel
    const panel = document.createElement('div');
    panel.id = 'panel-' + tabId;
    panel.className = 'report-tab-panel';
    panel.innerHTML = '<div class="charts-loading">Loading charts...</div>';
    document.getElementById('charts-content').appendChild(panel);

    updateTabBar();
    switchReportTab(tabId);

    // Fetch data and render
    fetch('/api/runs/' + runId + '/charts')
        .then(r => {
            if (!r.ok) {
                return r.json().catch(() => ({})).then(j => {
                    var msg = j.error || 'No results found for this run';
                    throw new Error(msg);
                });
            }
            return r.json();
        })
        .then(data => {
            // A closed tab must not resurrect cached data or action bindings.
            if (!reportTabs.some(t => t.id === tabId)) return;
            if (data.error) {
                panel.innerHTML = '<div class="charts-loading">' + data.error + '</div>';
                return;
            }
            ServeItReportModel.assertSupported(data, runId);
            tabDataCache[tabId] = data;
            try {
                renderChartsInPanel(data, runId, tabId);
            } catch (renderErr) {
                console.error('Chart render error:', renderErr);
                panel.innerHTML = '<div class="charts-loading">Render error: ' + renderErr.message + '</div>';
                return;
            }
            // Update download link if this is still the active tab
            if (activeTabId === tabId) {
                const dlLink = document.getElementById('chart-download-link');
                dlLink.style.display = 'inline';
                dlLink.href = '#';
                dlLink.onclick = (e) => { e.preventDefault(); downloadHTMLReport(runId, data); };
            }
        })
        .catch(err => {
            panel.innerHTML = '<div class="charts-loading">' + err.message + '</div>';
        });
}

function renderChartsInPanel(data, runId, tabId) {
    delete _lastEstResults['-' + tabId];
    const panel = document.getElementById('panel-' + tabId);
    const origContent = document.getElementById('charts-content');
    _chartSuffix = '-' + tabId;

    // Temporarily swap IDs so renderCharts writes to the panel
    panel.id = 'charts-content';
    origContent.id = '_charts-content-swap';

    try {
        renderCharts(data, runId);
    } finally {
        panel.id = 'panel-' + tabId;
        origContent.id = 'charts-content';
        _chartSuffix = '';
    }
}

function updateTabBar() {
    const bar = document.getElementById('report-tab-bar');
    const compareBtn = document.getElementById('chart-compare-btn');
    const runTabs = reportTabs.filter(t => !t.isComparison);

    if (reportTabs.length === 0) {
        bar.style.display = 'none';
        compareBtn.style.display = 'none';
        return;
    }

    bar.style.display = 'flex';
    compareBtn.style.display = runTabs.length >= 2 ? 'inline-block' : 'none';

    bar.innerHTML = '';
    reportTabs.forEach(tab => {
        const el = document.createElement('div');
        el.className = 'report-tab' + (tab.id === activeTabId ? ' active' : '') + (tab.isComparison ? ' compare-tab' : '');
        const shortLabel = tab.isComparison ? 'Compare' : '#' + tab.runId;
        el.innerHTML = '<span class="tab-label" title="' + (tab.label || '').replace(/"/g, '&quot;') + '">' + shortLabel + '</span><span class="tab-close" data-tab-id="' + tab.id + '">&times;</span>';
        el.addEventListener('click', (e) => {
            if (!e.target.classList.contains('tab-close')) switchReportTab(tab.id);
        });
        el.querySelector('.tab-close').addEventListener('click', (e) => {
            e.stopPropagation();
            closeReportTab(tab.id);
        });
        bar.appendChild(el);
    });

}

function updateEstimatorScaling(suffix) {
    var tabId = suffix.replace(/^-/, '');
    var data = tabDataCache[tabId];
    if (!data) return;
    var el = document.getElementById('est-scaling-info' + suffix);
    if (!el) return;

    el.innerHTML = estimatorAssumptionsHTML();
}

function estimatorEscape(value) {
    return String(value == null ? 'Unknown' : value).replace(/[&<>"']/g, function(c) {
        return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
}

function estimatorAssumptionsHTML() {
    return '<p><strong>Linear scaling estimate, not a fleet-level SLO verification.</strong> ' +
        'Copies = ceil(target req/s / measured req/s); total GPUs = copies × GPUs in the whole measured deployment. ' +
        'A copy includes all measured pods, not a single pod. This assumes the same workload, routing, cache conditions ' +
        'and per-copy load as the source test, with ideal load balancing and no shared bottlenecks. ' +
        'Fleet-level throughput and latency SLOs are not verified.</p>' +
        '<p>Pass requires finite measured TTFT and ITL at the selected percentiles within both targets. ' +
        'Missing, non-finite, negative or penalty latency (at least 1,000,000 ms) is Unknown; zero ITL is also Unknown (it may mean unavailable). ' +
        'An explicit zero TTFT is accepted. No percentile is substituted. ' +
        'Versioned estimates require matching raw-source evidence for the selected latency percentiles; unknown historical provenance cannot verify Pass. ' +
        'Versioned throughput sizing also requires a source-verified mean; a legacy alias remains diagnostic. ' +
        'Legacy unversioned payloads retain numeric compatibility, not a source-provenance guarantee. ' +
        'Each source test is kept separately; names are not merged across conditions or runs. ' +
        'Calibration and discarded tests are excluded. Explicit ranking ineligibility remains diagnostic only, never Pass or Best. ' +
        'Recorded concurrency is not measured average concurrency; the latter is shown only when measurement evidence exists. ' +
        'Missing capacity evidence remains diagnostic only in the table, with no sized chart bar. ' +
        'Best means lowest estimated GPU count among verified feasible points in this report; all ties are highlighted.</p>';
}

function estimatorPositive(value) {
    return Number.isFinite(value) && value > 0;
}

function estimatorTargets(input) {
    var targets = {};
    ['target_tput', 'ttft_target', 'itl_target'].forEach(function(key) {
        var raw = input[key];
        var value = typeof raw === 'number' ? raw :
            (typeof raw === 'string' && /^[+]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i.test(raw.trim()) ? Number(raw) : NaN);
        if (!estimatorPositive(value)) throw new Error('Throughput, TTFT and ITL targets must each be a finite number greater than zero.');
        targets[key] = value;
    });
    ['ttft_pctl', 'itl_pctl'].forEach(function(key) {
        if (['p50', 'p90', 'p95', 'p99'].indexOf(input[key]) === -1) {
            throw new Error('Select a supported TTFT and ITL percentile.');
        }
        targets[key] = input[key];
    });
    return targets;
}

function estimatorLatencyMeets(value, target, isItl) {
    return ServeItReportModel.latencyMeets(value, target, isItl);
}

function estimatorOutcome(r) {
    // Recheck actual values rather than trusting cached booleans in any output path.
    var ttft = ServeItReportModel.latencyMeets(r.ttft_val, r.ttft_target, false, r.evidence, 'ttft_' + r.ttft_pctl);
    var itl = ServeItReportModel.latencyMeets(r.itl_val, r.itl_target, true, r.evidence, 'itl_' + r.itl_pctl);
    var capacity = Number.isSafeInteger(r.total_gpus) && r.total_gpus > 0 && ServeItReportModel.capacityEvidenceVerified(r.evidence);
    if (r.evidence !== undefined) {
        var rate = ServeItReportModel.metricValue(r, 'throughput_mean');
        var gpus = ServeItReportModel.deploymentGpus(r);
        capacity = capacity && estimatorPositive(rate) && estimatorPositive(r.target_tput) && gpus != null &&
            r.measured_tput === rate && r.gpus_per_replica === gpus &&
            r.replicas === Math.max(1, Math.ceil(r.target_tput / rate)) && r.total_gpus === r.replicas * gpus;
    }
    var invalidBase = r.base_ttft_p90 != null &&
        (!Number.isFinite(r.base_ttft_p90) || r.base_ttft_p90 < 0 || r.base_ttft_p90 >= 1000000);
    var excluded = !ServeItReportModel.eligible(r) ||
        r.quality === 'discard' || invalidBase || /^step[23](?:-|$)/.test(String(r.test_id || ''));
    var status = excluded ? 'Excluded' : ttft === false || itl === false ? 'Fail' :
        (ttft === true && itl === true && capacity ? 'Pass' : 'Unknown');
    var label = function(v) { return v === true ? 'Pass' : (v === false ? 'Fail' : 'Unknown'); };
    return {
        status: status, feasible: status === 'Pass',
        ttft: label(ttft), itl: label(itl),
        text: status + ' (TTFT ' + label(ttft) + '; ITL ' + label(itl) + (capacity ? '' : '; capacity Unknown') +
            (excluded ? '; eligibility exclusion' : '') +
            (r.evidence !== undefined && (ttft == null || itl == null) ? '; source/metric evidence Unknown' : '') + ')',
    };
}

function calculateEstimatorResults(allResults, input, runId) {
    var targets = estimatorTargets(input);
    var results = [];
    (allResults || []).forEach(function(r, index) {
        var tid = String(r.test_id || '');
        if (r.quality === 'discard' || /^step[23](?:-|$)/.test(tid)) return;
        // Only absent means may use the legacy field; corrupt means must not be hidden.
        var tput = r.evidence === undefined ? (r.throughput_mean == null ? r.throughput_p90 : r.throughput_mean) :
            ServeItReportModel.metricValue(r, 'throughput_mean');
        var copies = estimatorPositive(tput) ? Math.max(1, Math.ceil(targets.target_tput / tput)) : null;
        var sourceGpus = r.evidence === undefined ? r.gpus : ServeItReportModel.deploymentGpus(r);
        var total = copies != null && Number.isSafeInteger(sourceGpus) && sourceGpus > 0 ? copies * sourceGpus : null;
        if (!Number.isSafeInteger(copies) || !Number.isSafeInteger(total)) { copies = null; total = null; }
        var metrics = r.metrics_json || {};
        if (typeof metrics === 'string') {
            try { metrics = JSON.parse(metrics); } catch (e) { metrics = {}; }
        }
        metrics = metrics || {};
        var tc = r.test_config || {};
        var row = Object.assign({}, targets, {
            config_name: r.config_name || tid || 'Unnamed configuration',
            test_id: r.test_id, test_config_id: r.test_config_id,
            run_id: r.run_id == null ? runId : r.run_id, source_index: index + 1,
            is_ranking_eligible: r.is_ranking_eligible, recommendation_eligible: r.recommendation_eligible,
            quality: r.quality,
            evidence: r.evidence,
            base_ttft_p90: r.ttft_p90,
            architecture: String(r.architecture || 'UNKNOWN').toUpperCase(),
            gpus_per_replica: sourceGpus, replicas: copies, total_gpus: total,
            measured_tput: estimatorPositive(tput) ? tput : null,
            throughput_source: r.evidence ? (r.evidence.metrics?.throughput_mean?.kind === 'compatibility' ? 'legacy throughput_p90' : 'throughput_mean') :
                (r.throughput_mean == null ? 'legacy throughput_p90' : 'throughput_mean'),
            ttft_val: r.evidence === undefined ? r['ttft_' + targets.ttft_pctl] : ServeItReportModel.metricValue(r, 'ttft_' + targets.ttft_pctl),
            itl_val: r.evidence === undefined ? r['itl_' + targets.itl_pctl] : ServeItReportModel.metricValue(r, 'itl_' + targets.itl_pctl),
            concurrency: r.evidence !== undefined ? ServeItReportModel.conditionValue(r, 'configured_concurrency') : r.concurrency,
            measured_concurrency: r.evidence !== undefined ? ServeItReportModel.conditionValue(r, 'measured_mean_concurrency') :
                (r.actual_concurrency == null ? metrics.concurrency_mean : r.actual_concurrency),
            cache_hit_pct: r.cache_hit_pct, prefix_cache_hit_pct: tc.prefix_cache_hit_pct,
            prefix_cache_mode: tc.prefix_cache_mode, prefix_cache_groups: tc.prefix_cache_groups,
            enable_prefix_caching: tc.enable_prefix_caching,
        });
        row.ttft_meets = estimatorLatencyMeets(row.ttft_val, row.ttft_target, false);
        row.itl_meets = estimatorLatencyMeets(row.itl_val, row.itl_target, true);
        results.push(row);
    });
    // Stable ties retain source order; unsized diagnostics follow sized points.
    results.sort(function(a, b) { return (a.total_gpus == null ? Infinity : a.total_gpus) - (b.total_gpus == null ? Infinity : b.total_gpus); });
    return results;
}

function estimatorBestGpus(results) {
    return results.reduce(function(best, r) {
        return estimatorOutcome(r).feasible && (best == null || r.total_gpus < best) ? r.total_gpus : best;
    }, null);
}

function estimatorNumber(value, digits) {
    return Number.isFinite(value) ? (digits == null ? value.toLocaleString() : value.toFixed(digits)) : 'Unknown';
}

function estimatorSource(r) {
    return 'Run ' + (r.run_id == null ? 'Unknown' : r.run_id) + ' / Test ' + (r.test_id || 'Unknown') +
        (Number.isSafeInteger(r.test_config_id) && r.test_config_id > 0 ? ' / test config ID ' + r.test_config_id : '') + ' / row ' + r.source_index;
}

function estimatorConditions(r) {
    return 'Recorded concurrency: ' + estimatorNumber(r.concurrency) +
        '; measured concurrency: ' + estimatorNumber(r.measured_concurrency) +
        '; measured cache hit: ' + estimatorNumber(r.cache_hit_pct) + '%; configured prefix cache: ' +
        estimatorNumber(r.prefix_cache_hit_pct) + '%; mode: ' + (r.prefix_cache_mode || 'Unknown') +
        '; groups: ' + estimatorNumber(r.prefix_cache_groups) + '; prefix caching: ' +
        (r.enable_prefix_caching === true ? 'enabled' : (r.enable_prefix_caching === false ? 'disabled' : 'Unknown'));
}

function runEstimator(suffix) {
    var tabId = suffix.replace(/^-/, '');
    var data = tabDataCache[tabId];
    if (!data) return;

    var input = {
        target_tput: document.getElementById('est-tput-target' + suffix).value,
        ttft_target: document.getElementById('est-ttft-target' + suffix).value,
        ttft_pctl: document.getElementById('est-ttft-pctl' + suffix).value,
        itl_target: document.getElementById('est-itl-target' + suffix).value,
        itl_pctl: document.getElementById('est-itl-pctl' + suffix).value,
    };
    var tab = reportTabs.find(function(t) { return t.id === tabId; });
    var results;
    try {
        ServeItReportModel.assertSupported(data, tab ? tab.runId : data.run_id);
        results = calculateEstimatorResults(data.all_results, input, tab ? tab.runId : data.run_id);
    } catch (e) {
        _lastEstResults[suffix] = [];
        Plotly.purge(document.getElementById('est-chart' + suffix));
        document.getElementById('est-results' + suffix).innerHTML = '<p role="alert">' + estimatorEscape(e.message) + '</p>';
        return;
    }
    renderEstimatorResults(results, suffix);
}

function estimatorResultsHTML(results) {
    var t = estimatorAssumptionsHTML();
    if (!results.length) {
        return t + '<p>No eligible measured operating points to estimate. No verified feasible operating point.</p>';
    }
    var first = results[0];
    var bestGpus = estimatorBestGpus(results);
    t += '<p>Target: ' + estimatorNumber(first.target_tput) + ' req/s | TTFT: ' + estimatorNumber(first.ttft_target) +
        ' ms ' + estimatorEscape(first.ttft_pctl.toUpperCase()) + ' | ITL: ' + estimatorNumber(first.itl_target) +
        ' ms ' + estimatorEscape(first.itl_pctl.toUpperCase()) + '</p>';
    if (bestGpus == null) t += '<p><strong>No verified feasible operating point.</strong> Failed, unknown and excluded points are shown for diagnostics, not recommendations.</p>';
    t += '<table class="estimator-table" style="margin-top:16px;"><thead><tr><th>Configuration / source</th><th>Arch</th>' +
        '<th>Source conditions</th><th>GPUs / measured deployment</th><th>Reported req/s</th><th>Whole-deployment copies (estimated)</th>' +
        '<th>Total GPUs (estimated)</th><th>TTFT ' + estimatorEscape(first.ttft_pctl.toUpperCase()) + '</th><th>ITL ' +
        estimatorEscape(first.itl_pctl.toUpperCase()) + '</th><th>Measured target status</th></tr></thead><tbody>';
    results.forEach(function(r) {
        var outcome = estimatorOutcome(r);
        var isBest = outcome.feasible && r.total_gpus === bestGpus;
        t += '<tr class="' + (isBest ? 'estimator-best' : '') + '"><td>' + estimatorEscape(r.config_name) +
            '<br><small>' + estimatorEscape(estimatorSource(r)) + '</small></td><td>' + estimatorEscape(r.architecture) +
            '</td><td>' + estimatorEscape(estimatorConditions(r)) + '</td><td>' + estimatorNumber(r.gpus_per_replica) +
            '</td><td>' + estimatorNumber(r.measured_tput, 2) + '<br><small>' + estimatorEscape(r.throughput_source) +
            '</small></td><td>' + estimatorNumber(r.replicas) + '</td><td><strong>' + estimatorNumber(r.total_gpus) +
            '</strong></td><td>' + estimatorNumber(r.ttft_val, 2) + ' ms — ' + outcome.ttft +
            '</td><td>' + estimatorNumber(r.itl_val, 2) + ' ms — ' + outcome.itl +
            '</td><td>' + outcome.text + (isBest ? '<br><strong>Best feasible (lowest GPUs)</strong>' : '') + '</td></tr>';
    });
    return t + '</tbody></table>';
}

function renderEstimatorResults(results, suffix) {
    _lastEstResults[suffix] = results;
    document.getElementById('est-results' + suffix).innerHTML = estimatorResultsHTML(results);
    if (!results.length) {
        Plotly.purge(document.getElementById('est-chart' + suffix));
        return;
    }
    var bestGpus = estimatorBestGpus(results);
    var labels = results.map(function(r) { return estimatorEscape(r.config_name + ' — ' + estimatorSource(r)); });
    var barColors = results.map(function(r) {
        var outcome = estimatorOutcome(r);
        if (outcome.feasible && r.total_gpus === bestGpus) return '#059669';
        if (outcome.status === 'Fail') return '#ef4444';
        if (outcome.status === 'Unknown' || outcome.status === 'Excluded') return '#64748b';
        return '#d97706';
    });
    var positions = results.map(function(r, i) { return i; });
    Plotly.newPlot('est-chart' + suffix, [{
        type: 'bar', orientation: 'h',
        y: positions, x: results.map(function(r) { return r.total_gpus; }),
        customdata: labels,
        text: results.map(function(r) {
            var outcome = estimatorOutcome(r);
            return estimatorNumber(r.total_gpus) + ' GPUs (' + estimatorNumber(r.replicas) +
                ' whole-deployment copies) — ' + outcome.text +
                (outcome.feasible && r.total_gpus === bestGpus ? ' — Best feasible' : '');
        }),
        textposition: 'outside',
        marker: { color: barColors },
        hovertext: results.map(function(r) { return estimatorEscape(estimatorConditions(r)); }),
        hovertemplate: '<b>%{customdata}</b><br>%{text}<br>%{hovertext}<extra></extra>',
    }], {
        title: { text: 'Estimated GPUs for ' + results[0].target_tput + ' req/s (fleet SLO not verified)' +
            (bestGpus == null ? '<br>No verified feasible operating point' : ''), font: { size: 15 } },
        xaxis: { title: 'Estimated total GPUs' },
        yaxis: { automargin: true, tickvals: positions, ticktext: labels },
        margin: { l: 200, r: 180, t: 50, b: 40 },
        height: Math.max(600, results.length * 60 + 80),
    }, { responsive: true, displayModeBar: false });

}

var _lastEstResults = {};
function downloadEstimatorReport(suffix) {
    var results = _lastEstResults[suffix];
    if (!results || !results.length) { alert('Run the estimator first'); return; }
    // Capture the same table/status snapshot used live before asynchronous image generation.
    var content = estimatorResultsHTML(results);
    var chartEl = document.getElementById('est-chart' + suffix);
    return Plotly.toImage(chartEl, { format: 'svg', width: 1200, height: Math.max(400, results.length * 60 + 80) }).then(function(chartSvg) {
        var html = '<!DOCTYPE html><html><head><meta charset="UTF-8"><title>GPU Estimate Report</title>';
        html += '<style>body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;max-width:1200px;margin:0 auto;padding:20px;color:#1e293b;}';
        html += 'table{width:100%;border-collapse:collapse;font-size:0.9em;margin:16px 0;}th,td{padding:8px 12px;border:1px solid #e2e8f0;text-align:left;}';
        html += 'th{background:#f8fafc;font-weight:700;}.estimator-best{background:#f0fdf4;}';
        html += '</style></head><body>';
        html += '<h1 style="color:#b45309;">GPU Estimate Report</h1>';
        html += content;
        html += '<img src="' + estimatorEscape(chartSvg) + '" style="width:100%;margin-top:20px;" alt="Estimated GPUs by source test">';
        html += '<p style="color:#94a3b8;font-size:0.8em;margin-top:20px;">Generated ' + new Date().toLocaleString() + '</p>';
        html += '</body></html>';
        var blob = new Blob([html], { type: 'text/html' });
        var a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = 'gpu-estimate-' + results[0].target_tput + 'rps.html';
        a.click();
        URL.revokeObjectURL(a.href);
    });
}

function downloadTableAsPng(elementId, filename) {
    var container = document.getElementById(elementId);
    if (!container) { alert('Element not found: ' + elementId); return; }

    var scale = 2;
    var W = Math.max(container.offsetWidth, 960);
    var PAD = 20;
    var ROW_H = 34;
    var SECTION_H = 38;
    var font = 'system-ui, -apple-system, sans-serif';

    // Collect drawing items by walking the DOM
    var items = [];
    function walk(node) {
        Array.from(node.children).forEach(function(el) {
            var tag = el.tagName;
            if (tag === 'TABLE') {
                Array.from(el.querySelectorAll('tr')).forEach(function(tr) {
                    var isHeader = !!tr.querySelector('th');
                    var bg = isHeader ? '#f1f5f9' : (tr.style.background || '#ffffff');
                    var cells = Array.from(tr.querySelectorAll('th,td')).map(function(td) {
                        return { text: td.textContent.trim(), bold: isHeader || td.style.fontWeight === '700' };
                    });
                    if (cells.length) items.push({ type: 'row', cells: cells, bg: bg });
                });
            } else if (tag === 'DIV') {
                var txt = el.textContent.trim();
                if (el.style.borderBottom && el.style.color) {
                    // Architecture section heading
                    items.push({ type: 'section', text: txt, color: el.style.color });
                } else if (el.children.length) {
                    walk(el);
                } else if (el.tagName === 'P' || el.style.color === '#64748b') {
                    items.push({ type: 'desc', text: txt });
                }
            } else if (tag === 'P') {
                items.push({ type: 'desc', text: el.textContent.trim() });
            } else {
                walk(el);
            }
        });
    }
    walk(container);

    // Calculate total canvas height
    var totalH = PAD;
    items.forEach(function(it) {
        totalH += it.type === 'section' ? SECTION_H : it.type === 'desc' ? 30 : ROW_H;
    });
    totalH += PAD;

    var canvas = document.createElement('canvas');
    canvas.width  = W * scale;
    canvas.height = totalH * scale;
    var ctx = canvas.getContext('2d');
    ctx.scale(scale, scale);

    // White background
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, W, totalH);

    // Column widths (must sum to W - 2*PAD)
    var inner = W - 2 * PAD;
    var colPcts = [0.26, 0.30, 0.11, 0.10, 0.15, 0.08];
    var colW = colPcts.map(function(p) { return Math.round(inner * p); });

    var y = PAD;
    items.forEach(function(it) {
        if (it.type === 'section') {
            ctx.fillStyle = it.color || '#334155';
            ctx.font = 'bold 12px ' + font;
            ctx.fillText(it.text, PAD, y + 20);
            ctx.strokeStyle = it.color || '#334155';
            ctx.lineWidth = 1.5;
            ctx.beginPath(); ctx.moveTo(PAD, y + 26); ctx.lineTo(W - PAD, y + 26); ctx.stroke();
            y += SECTION_H;
        } else if (it.type === 'desc') {
            ctx.fillStyle = '#64748b';
            ctx.font = '11px ' + font;
            ctx.fillText(it.text, PAD, y + 18, W - PAD * 2);
            y += 30;
        } else if (it.type === 'row') {
            // Row background
            ctx.fillStyle = it.bg || '#ffffff';
            ctx.fillRect(PAD, y, inner, ROW_H);
            // Cells
            var x = PAD;
            it.cells.forEach(function(cell, ci) {
                var cw = colW[ci] != null ? colW[ci] : 80;
                ctx.strokeStyle = '#e2e8f0';
                ctx.lineWidth = 0.5;
                ctx.strokeRect(x + 0.5, y + 0.5, cw - 1, ROW_H - 1);
                ctx.fillStyle = cell.bold ? '#0f172a' : '#334155';
                ctx.font = (cell.bold ? 'bold ' : '') + '11px ' + font;
                // Clip text to column width
                var txt = cell.text;
                var maxW = cw - 12;
                while (txt.length > 3 && ctx.measureText(txt).width > maxW) txt = txt.slice(0, -1);
                if (txt.length < cell.text.length) txt += '…';
                ctx.fillText(txt, x + 6, y + ROW_H / 2 + 4);
                x += cw;
            });
            y += ROW_H;
        }
    });

    var a = document.createElement('a');
    a.download = filename || 'table.png';
    a.href = canvas.toDataURL('image/png');
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
}

function downloadCalParamsTablePng(suffix) {
    downloadTableAsPng('cal-params-table' + suffix, 'calibration-test-parameters.png');
}

function switchReportTab(tabId) {
    activeTabId = tabId;
    // Toggle panel visibility
    document.querySelectorAll('#charts-content > .report-tab-panel').forEach(p => {
        p.classList.toggle('active', p.id === 'panel-' + tabId);
    });
    updateTabBar();

    // Update download link
    const tab = reportTabs.find(t => t.id === tabId);
    const dlLink = document.getElementById('chart-download-link');
    if (tab && !tab.isComparison && tabDataCache[tabId]) {
        dlLink.style.display = 'inline';
        dlLink.href = '#';
        dlLink.onclick = (e) => { e.preventDefault(); downloadHTMLReport(tab.runId, tabDataCache[tabId]); };
    } else {
        dlLink.style.display = 'none';
    }
}

function closeReportTab(tabId) {
    const idx = reportTabs.findIndex(t => t.id === tabId);
    if (idx === -1) return;
    const closed = reportTabs.splice(idx, 1)[0];
    delete tabDataCache[tabId];
    delete _lastEstResults['-' + tabId];
    if (!closed.isComparison && !reportTabs.some(t => !t.isComparison && String(t.runId) === String(closed.runId)) &&
        typeof clearReportActions === 'function') clearReportActions(closed.runId);

    const panel = document.getElementById('panel-' + tabId);
    if (panel) panel.remove();

    if (activeTabId === tabId) {
        if (reportTabs.length > 0) {
            switchReportTab(reportTabs[Math.min(idx, reportTabs.length - 1)].id);
        } else {
            activeTabId = null;
            document.getElementById('chart-download-link').style.display = 'none';
            // Show placeholder
            const content = document.getElementById('charts-content');
            if (!content.querySelector('.charts-loading')) {
                const ph = document.createElement('div');
                ph.className = 'charts-loading';
                ph.textContent = 'Select a run and click + Add to view results';
                content.appendChild(ph);
            }
        }
    }
    updateTabBar();
}

function fmtSI(v, decimals) {
    if (v == null) return '-';
    const d = decimals != null ? decimals : 1;
    if (Math.abs(v) >= 1e6) return (v / 1e6).toFixed(d) + 'M';
    if (Math.abs(v) >= 1e3) return (v / 1e3).toFixed(d) + 'K';
    return v.toFixed(d);
}

function arrowAnnotations(xs, ys, opts) {
    const color = (opts && opts.color) || '#333';
    const decimals = opts && opts.decimals != null ? opts.decimals : 1;
    const suffix = (opts && opts.suffix) || '';
    const yref = (opts && opts.yref) || 'y';
    const s = (opts && opts.spread) || 30;
    const offsets = [
        { ax: 0,          ay: -s        },
        { ax:  s * 0.9,   ay:  s * 0.7  },
        { ax: -s * 0.8,   ay: -s * 1.2  },
        { ax:  s * 1.1,   ay: -s * 0.5  },
        { ax: 0,          ay:  s * 1.1   },
        { ax: -s,         ay:  s * 0.8   },
        { ax:  s * 1.3,   ay: -s * 1.3   },
        { ax: -s * 1.2,   ay:  s * 1.3   },
    ];
    return ys.map((v, i) => {
        if (v == null) return null;
        const o = offsets[i % offsets.length];
        return {
            x: xs[i], y: v, xref: 'x', yref: yref,
            text: fmtSI(v, decimals) + suffix,
            showarrow: true, arrowhead: 0, arrowwidth: 1, arrowcolor: '#94a3b8',
            ax: o.ax, ay: o.ay,
            font: { size: 13, color: color },
            borderpad: 2,
        };
    }).filter(Boolean);
}
