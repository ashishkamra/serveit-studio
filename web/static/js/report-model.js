// Shared live/export evidence policy. Embed this factory, not a copied rule set.
function createServeItReportModel() {
    'use strict';
    const NAME = 'serveit.report', VERSION = 1;
    const object = value => value != null && typeof value === 'object' && !Array.isArray(value);
    const has = (value, key) => object(value) && Object.prototype.hasOwnProperty.call(value, key);
    const metric = value => Number.isFinite(value) && value >= 0 ? value : null;
    const hasId = cfg => object(cfg) && Number.isSafeInteger(cfg.test_config_id) && cfg.test_config_id > 0;
    const identity = cfg => hasId(cfg) ? 'id:' + cfg.test_config_id : 'legacy:' + ((cfg || {}).test_id || (cfg || {}).config_name || '');

    function evidenceValid(cfg) {
        const e = cfg.evidence;
        return object(e) && e.version === VERSION && object(e.source) && object(e.metrics) &&
            hasId(cfg) && e.source.test_config_id === cfg.test_config_id &&
            (!cfg.test_id || e.source.test_id === cfg.test_id) &&
            (cfg.run_id == null || String(e.source.run_id) === String(cfg.run_id));
    }

    function eligible(cfg) {
        if (!object(cfg) || cfg.quality === 'discard' || cfg.is_ranking_eligible === false || cfg.recommendation_eligible === false) return false;
        if (cfg.evidence !== undefined) {
            if (!evidenceValid(cfg)) return false;
            if (!object(cfg.evidence.eligibility) || cfg.evidence.eligibility.ranking_eligible !== true || cfg.evidence.eligibility.quality === 'discard') return false;
            if (deploymentGpus(cfg) == null) return false;
            const baseLatency = metricValue(cfg, 'ttft_p90');
            const rate = metricValue(cfg, 'throughput_mean');
            if (baseLatency == null || baseLatency >= 1000000 || rate == null || rate <= 0) return false;
        }
        return true;
    }

    function unitFor(key) {
        if (/^(ttft|itl|e2e)_p(50|90|95|99)$/.test(key)) return 'ms';
        if (key === 'throughput_mean') return 'req/s';
        return null;
    }

    function sourceMatches(m) {
        if (!object(m) || metric(m.value) == null || metric(m.source_value) == null) return false;
        if (m.kind === 'calculated') {
            const c = m.calculation;
            if (!object(c) || c.name !== 'successful_requests_per_second_v1' || !Number.isSafeInteger(c.successful_requests) ||
                c.successful_requests <= 0 || !Number.isFinite(c.duration_s) || c.duration_s <= 0 ||
                c.successful_requests / c.duration_s !== m.source_value) return false;
        }
        const scale = m.unit === m.source_unit ? 1 : (m.unit === 'ms' && m.source_unit === 's' ? 1000 : null);
        if (scale == null) return false;
        const source = m.source_value * scale;
        return Number.isFinite(source) && source === m.value;
    }

    function metricValue(cfg, key, aliases = []) {
        if (!object(cfg) || unitFor(key) == null) return null;
        if (cfg.evidence !== undefined) {
            if (!evidenceValid(cfg)) return null;
            const m = cfg.evidence.metrics[key];
            if (!has(cfg.evidence.metrics, key) || !object(m) || m.unit !== unitFor(key) || m.availability !== 'available' ||
                !(key === 'throughput_mean' ? ['reported', 'compatibility', 'calculated'] : ['reported']).includes(m.kind) ||
                (/_p(50|90|95|99)$/.test(key) && m.statistic !== key.split('_').pop()) ||
                !['verified', 'unknown'].includes(m.provenance)) return null;
            if (m.provenance === 'verified' && !sourceMatches(m)) return null;
            return metric(m.value);
        }
        let value = cfg[key];
        for (const alias of aliases) if (value == null) value = cfg[alias];
        return metric(value);
    }

    function score(cfg, category) {
        if (!eligible(cfg)) return null;
        const ttft = metricValue(cfg, 'ttft_p90', ['ttft']);
        const itl = metricValue(cfg, 'itl_p90', ['itl']);
        const tput = metricValue(cfg, 'throughput_mean', ['throughput', 'throughput_p90']);
        const gpus = deploymentGpus(cfg);
        let value = null;
        if (category === 'lowest_ttft' && ttft != null) value = -ttft;
        else if (category === 'lowest_itl' && itl != null) value = -itl;
        else if (category === 'highest_tput') value = tput;
        else if (category === 'most_efficient' && tput != null && gpus > 0) value = tput / gpus;
        else if (category === 'balanced' && ttft != null && tput > 0) value = -ttft / tput;
        return Number.isFinite(value) ? value : null;
    }

    function throughputLabel(cfg) {
        if (!object(cfg)) return 'Mean throughput';
        const m = object(cfg.evidence) && object(cfg.evidence.metrics) ? cfg.evidence.metrics.throughput_mean : null;
        if (object(m) && m.kind === 'calculated') return 'Mean throughput (calculated)';
        const compatibility = cfg.evidence === undefined ? cfg.throughput_mean == null && (cfg.throughput != null || cfg.throughput_p90 != null) : object(m) && m.kind === 'compatibility';
        return compatibility ? 'Reported throughput (legacy alias)' : 'Mean throughput';
    }

    function deploymentGpus(cfg) {
        if (!object(cfg)) return null;
        if (cfg.evidence === undefined) return metric(cfg.gpus ?? cfg.total_gpus);
        if (!evidenceValid(cfg) || !object(cfg.evidence.resources)) return null;
        const count = cfg.evidence.resources.total_gpus;
        return object(count) && count.unit === 'GPU' && count.kind === 'calculated' && count.availability === 'available' &&
            Number.isSafeInteger(count.value) && count.value > 0 ? count.value : null;
    }

    function latencyMeets(value, target, isItl, evidence, key) {
        if (!Number.isFinite(value) || value < 0 || value >= 1000000 ||
            (isItl && value === 0) || !Number.isFinite(target) || target <= 0) return null;
        // Versioned estimates require matching raw source, not a historically
        // ambiguous percentile field. Legacy numeric compatibility is disclosed.
        if (evidence !== undefined) {
            if (typeof key !== 'string' || !/^(ttft|itl)_p(50|90|95|99)$/.test(key)) return null;
            const m = object(evidence) && evidence.version === VERSION && object(evidence.metrics) ? evidence.metrics[key] : null;
            if (!object(m) || m.unit !== 'ms' || m.statistic !== key.split('_').pop() ||
                m.availability !== 'available' || m.provenance !== 'verified' || m.value !== value || !sourceMatches(m)) return null;
        }
        return value <= target;
    }

    function conditionValue(cfg, key) {
        if (!object(cfg)) return null;
        const e = cfg.evidence;
        const m = object(e) && e.version === VERSION && object(e.conditions) ? e.conditions[key] : null;
        if (!object(m) || m.unit !== 'requests' || m.availability !== 'available' ||
            (key === 'configured_concurrency' && m.kind !== 'configured')) return null;
        return metric(m.value);
    }

    function capacityEvidenceVerified(evidence) {
        if (evidence === undefined) return true; // Explicit legacy compatibility.
        const m = object(evidence) && evidence.version === VERSION && object(evidence.metrics) ? evidence.metrics.throughput_mean : null;
        return object(m) && m.unit === 'req/s' && m.statistic === 'mean' &&
            ['reported', 'calculated'].includes(m.kind) &&
            m.availability === 'available' && m.provenance === 'verified' && Number.isFinite(m.value) && m.value > 0 && sourceMatches(m);
    }

    function assertSupported(data, runId) {
        if (!object(data)) throw new Error('Invalid report payload.');
        if (!has(data, 'report_contract')) return 'legacy';
        const c = data.report_contract;
        if (!object(c) || c.name !== NAME || c.version !== VERSION ||
            !Number.isSafeInteger(c.run_id) || c.run_id <= 0 ||
            c.recommendation_rule !== 'category_p90_not_slo_verification' || c.estimator_calculation !== 'whole_deployment_linear_v1' ||
            (runId != null && String(c.run_id) !== String(runId)) || !Array.isArray(data.all_results)) {
            throw new Error('Unsupported or invalid report evidence contract. Refresh the application before viewing this report.');
        }
        for (const row of data.all_results) {
            if (!object(row) || !evidenceValid(row) || String(row.evidence.source.run_id) !== String(c.run_id)) {
                throw new Error('Report evidence identity or version is invalid. No recommendations or estimates were generated.');
            }
        }
        function checkSources(value) {
            if (Array.isArray(value)) return value.forEach(checkSources);
            if (!object(value)) return;
            if (has(value, 'evidence') && has(value, 'test_config_id') &&
                (!evidenceValid(value) || String(value.evidence.source.run_id) !== String(c.run_id))) {
                throw new Error('Report candidate evidence identity or version is invalid.');
            }
            for (const [key, child] of Object.entries(value)) if (key !== 'evidence') checkSources(child);
        }
        checkSources(data);
        return 'v1';
    }

    function escapeHTML(value) {
        return String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    }

    function noticeText(data) {
        if (assertSupported(data) === 'legacy') return 'Legacy unversioned report: metric source, units and historical percentile provenance are not verified.';
        let unknown = false, unknownOther = false, mismatch = false, compatibility = false, invalid = false;
        for (const row of data.all_results) {
            for (const [key, m] of Object.entries(row.evidence.metrics)) {
                if (unitFor(key) == null) continue; // Ignore additive metrics this reader does not consume.
                if (!object(m)) { invalid = true; continue; }
                if (/_p99$/.test(key) && m.availability === 'available' && m.provenance === 'unknown') unknown = true;
                if (m.availability === 'available' && m.provenance === 'unknown') unknownOther = true;
                if (m.provenance === 'mismatch') mismatch = true;
                if (m.kind === 'compatibility') compatibility = true;
                if (m.availability === 'available' && m.provenance !== 'mismatch' && metricValue(row, key) == null) invalid = true;
            }
        }
        let text = 'Evidence contract v1: source identities and metric units are explicit. ';
        if (unknown) text += 'Historical P99 provenance is Unknown for some tests; stored P99 may reflect P99.9. ';
        else if (unknownOther) text += 'Some stored metric source provenance is Unknown. ';
        if (mismatch) text += 'Some stored metrics disagree with preserved raw source data. ';
        if (compatibility) text += 'Some throughput values use a legacy alias, not a verified mean. ';
        if (invalid) text += 'Invalid or unsupported metric evidence remains Unknown. ';
        return text + 'No historical values were repaired. Workload comparability and production SLOs are not verified.';
    }

    function noticeHTML(data) {
        return '<div class="report-evidence-notice" role="note"><p>' + escapeHTML(noticeText(data)) + '</p></div>';
    }

    return Object.freeze({
        name: NAME, version: VERSION, metric, hasId, identity, eligible,
        metricValue, score, throughputLabel, deploymentGpus, latencyMeets, conditionValue, capacityEvidenceVerified, assertSupported, escapeHTML, noticeText, noticeHTML,
        embeddedSource: () => 'var ServeItReportModel = (' + createServeItReportModel.toString() + ')();',
    });
}

var ServeItReportModel = createServeItReportModel();
if (typeof module !== 'undefined' && module.exports) module.exports = ServeItReportModel;
