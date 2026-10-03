"""Optional, standalone browser smoke test; not part of isolated pytest collection.

Run: python -m tests.report_browser_smoke --plotly /path/to/plotly-2.35.2.min.js
Requires the development-only playwright package and Chrome (or --channel chromium).
Uses real checked-in scripts/CSS, real DOM/Plotly, Python-produced fixtures, and
actual downloads. API traffic and reuse/test dispatch are intercepted: no server,
credentials, cluster, benchmark, or production state is touched.
"""

import argparse
import json
from pathlib import Path
import tempfile
from urllib.parse import urlparse

from playwright.sync_api import expect, sync_playwright

from tests.test_report_contract import generated_report

ROOT = Path(__file__).resolve().parents[1]
SHELL = """<!doctype html><html><head><meta charset="utf-8"></head><body>
<select id="chart-run-select"><option value="42">Run 42</option><option value="99">Run 99</option></select>
<button id="chart-add-btn">Add</button><button id="chart-compare-btn">Compare</button>
<a id="chart-download-link">Download HTML</a><div id="report-tab-bar"></div>
<div id="charts-content"></div></body></html>"""


def check_browser(browser, plotly_source, width):
    report = generated_report()
    errors = []
    with browser.new_context(viewport={"width": width, "height": 900}, service_workers="block") as context:

        def route_request(route):
            url = route.request.url
            path = urlparse(url).path
            if url == "https://serveit.test/":
                route.fulfill(content_type="text/html", body=SHELL)
            elif path in ("/api/runs/42/charts", "/api/runs/99/charts") and url.startswith("https://serveit.test/"):
                source = report if path == "/api/runs/42/charts" else generated_report(run_id=99)
                route.fulfill(content_type="application/json", body=json.dumps(source, allow_nan=False))
            elif url == "https://cdn.plot.ly/plotly-2.35.2.min.js":
                route.fulfill(content_type="application/javascript", body=plotly_source)
            else:
                raise AssertionError(f"Unexpected browser network request: {url}")

        context.route("**/*", route_request)
        page = context.new_page()
        page.on("pageerror", lambda error: errors.append(str(error)))
        page.on("console", lambda message: errors.append(message.text) if message.type == "error" else None)
        page.goto("https://serveit.test/")
        page.add_style_tag(path=str(ROOT / "web/static/css/style.css"))
        page.add_script_tag(content=plotly_source)
        assert page.evaluate("Plotly.version") == "2.35.2", "Use the production Plotly version"
        for file in (
            "report-model.js",
            "modules/report.js",
            "modules/ui-helpers.js",
            "modules/charts.js",
            "report-download.js",
        ):
            page.add_script_tag(path=str(ROOT / "web/static/js" / file))
        page.evaluate("""() => {
            window.applyReportConfig = key => window.smokeAction = window._recConfigs[key];
            window.showSingleTestModal = window.applyReportConfig;
        }""")
        page.get_by_role("button", name="Add", exact=True).click()
        page.wait_for_function("tabDataCache.rt1 && document.querySelector('#panel-rt1 .report-subtab')")
        expect(page.locator("#panel-rt1")).not_to_contain_text("Chart render error")
        rec = page.locator('[data-subtab-pane="recommendation-rt1"]')
        expect(rec).to_contain_text("test config ID: 1")
        expect(rec).to_contain_text("test config ID: 2")
        expect(rec).to_contain_text("Recorded c=4")
        rec.get_by_role("button", name="Reuse").first.click()
        assert page.evaluate("window.smokeAction.test_config_id") == 1
        assert page.evaluate("window.smokeAction.run_id") == "42"
        expect(rec.locator('a[href="/api/run/42/test/1/manifest/lws"]').first).to_be_visible()

        page.locator('[data-subtab="estimator-rt1"]').click()
        # Verify keyboard activation of a native action button with real focus.
        estimate = page.get_by_role("button", name="Estimate", exact=True)
        estimate.focus()
        page.keyboard.press("Enter")
        rows = page.locator("#est-results-rt1 tbody tr")
        expect(rows).to_have_count(9)
        for test_id in ("step6-ineligible", "step6-zero-gpus"):
            expect(rows.filter(has_text=test_id)).to_contain_text("Excluded")
            expect(rows.filter(has_text=test_id)).not_to_have_class("estimator-best")
        expect(rows.filter(has_text="step6-zero-itl")).to_contain_text("Unknown")
        expect(rows.filter(has_text="step6-no-tail")).to_contain_text("Unknown")
        expect(page.locator("#est-results-rt1 .estimator-best")).to_have_count(1)
        page.wait_for_function("document.getElementById('est-chart-rt1').data?.length === 1")
        table = page.locator("#est-results-rt1").inner_html()
        with page.expect_download() as download:
            page.get_by_role("button", name="Download Report", exact=True).click()
        estimate_html = Path(download.value.path()).read_text()
        assert table in estimate_html
        assert "data:image/svg+xml" in estimate_html

        # Read the downloaded estimator as a real document, not only a string.
        exported = context.new_page()
        exported.on("pageerror", lambda error: errors.append(str(error)))
        exported.set_content(estimate_html)
        expect(exported.locator("tbody tr")).to_have_count(9)
        expect(exported.locator(".estimator-best")).to_have_count(1)
        assert exported.locator("img").evaluate("img => img.complete && img.naturalWidth > 0")
        exported.close()

        page.locator("#est-tput-target-rt1").fill("0")
        estimate.click()
        expect(page.locator("#est-results-rt1 [role=alert]")).to_be_visible()
        assert page.evaluate("_lastEstResults['-rt1'].length") == 0
        assert page.locator("#est-chart-rt1 .main-svg").count() == 0
        page.locator("#est-tput-target-rt1").fill("100")
        estimate.click()

        with page.expect_download() as download:
            page.get_by_text("Download HTML", exact=True).click()
        full_html = Path(download.value.path()).read_text()
        exported = context.new_page()
        exported.on("pageerror", lambda error: errors.append(str(error)))
        # Execute the actual downloaded document and its embedded chart scripts.
        exported.set_content(full_html, wait_until="load")
        expect(exported.locator("#dl-pane-rec")).to_contain_text("test config ID: 1")
        expect(exported.locator("#dl-pane-rec")).to_contain_text("not measured average concurrency")
        # Both selected tests reuse a legacy name, but their offline downloads
        # must contain their own YAML rather than the last row with that name.
        for test_id, yaml_text in ((1, "kind: LeaderWorkerSet"), (2, "kind: SecondSource")):
            link = exported.locator(
                f"""#dl-pane-rec a[onclick="dlManifest('step6-shared','lws',{test_id});return false;"]"""
            ).first
            with exported.expect_download() as manifest:
                link.click()
            assert Path(manifest.value.path()).read_text() == yaml_text
            assert manifest.value.suggested_filename == f"run-42-test-{test_id}-lws.yaml"
        assert exported.locator(".js-plotly-plot").count() > 0
        exported.locator(".dl-tab").filter(has_text="Configurations").click()
        expect(exported.locator("#dl-pane-cfg")).to_have_class("dl-pane active")
        exported.close()

        # Actual old records have no automatically certified raw-source evidence.
        # The versioned report must disclose this and keep estimates diagnostic.
        historical = generated_report(with_raw_source=False)
        page.evaluate(
            """data => {
            tabDataCache.rt1 = data;
            renderChartsInPanel(data, 42, 'rt1');
        }""",
            historical,
        )
        expect(page.locator("#panel-rt1 .report-evidence-notice")).to_contain_text(
            "Historical P99 provenance is Unknown"
        )
        assert page.evaluate("!_lastEstResults['-rt1']")
        page.locator('[data-subtab="estimator-rt1"]').click()
        page.get_by_role("button", name="Estimate", exact=True).click()
        expect(page.locator("#est-results-rt1")).to_contain_text("No verified feasible operating point")
        expect(page.locator("#est-results-rt1 .estimator-best")).to_have_count(0)
        page.evaluate(
            """data => {
            tabDataCache.rt1 = data;
            renderChartsInPanel(data, 42, 'rt1');
        }""",
            report,
        )

        page.locator("#chart-run-select").select_option("99")
        page.get_by_role("button", name="Add", exact=True).click()
        page.wait_for_function("tabDataCache.rt2 && document.querySelector('#panel-rt2 .report-subtab')")
        assert page.evaluate("new Set(Object.values(window._recConfigs).map(r => r.run_id)).size") == 2
        page.locator('[data-tab-id="rt1"]').click()
        assert page.evaluate("!tabDataCache.rt1 && !_lastEstResults['-rt1']")
        assert page.evaluate("Object.values(window._recConfigs).every(r => r.run_id === '99')")
        page.locator('[data-tab-id="rt2"]').click()
        assert page.evaluate("Object.keys(window._recConfigs).length") == 0
        assert page.locator("#charts-content").count() == 1
        assert page.evaluate("_chartSuffix") == ""
        assert errors == [], "Browser errors: " + "\n".join(errors)
    print(f"PASS: {width}px live/export recommendations, estimator, keyboard action, SVG download, tab cleanup")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--plotly", type=Path, required=True)
    parser.add_argument("--channel", default="chrome")
    args = parser.parse_args()
    plotly_source = args.plotly.read_text()
    with tempfile.TemporaryDirectory(prefix="serveit-browser-") as downloads, sync_playwright() as playwright:
        browser = playwright.chromium.launch(channel=args.channel, downloads_path=downloads)
        try:
            print("Browser:", browser.version)
            for width in (1440, 390):
                check_browser(browser, plotly_source, width)
        finally:
            browser.close()


if __name__ == "__main__":
    main()
