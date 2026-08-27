#!/usr/bin/env python3
"""Run Nightglass's packaged Firefox extension in an isolated real browser."""

from __future__ import annotations

import argparse
import json
import re
import time
from pathlib import Path

from selenium import webdriver
from selenium.webdriver.firefox.options import Options
from selenium.webdriver.firefox.service import Service
from selenium.webdriver.support.ui import WebDriverWait


PAGE_SUMMARY = r"""
return (() => {
  const rootStyle = getComputedStyle(document.documentElement);
  const bodyStyle = document.body ? getComputedStyle(document.body) : null;
  const liveCard = document.querySelector('.live-card');
  const frame = document.querySelector('iframe');
  const shadowArticle = document.querySelector('#shadow-host')?.shadowRoot?.querySelector('article');
  let frameDarkreaderNodes = null;
  try {
    frameDarkreaderNodes = frame?.contentDocument?.querySelectorAll('.darkreader, [data-darkreader-mode]').length ?? null;
  } catch (_error) {}
  return {
    url: location.href,
    title: document.title,
    darkreaderNodes: document.querySelectorAll('.darkreader, [data-darkreader-mode]').length,
    darkreaderMode: document.documentElement.getAttribute('data-darkreader-mode'),
    darkreaderScheme: document.documentElement.getAttribute('data-darkreader-scheme'),
    rootBackground: rootStyle.backgroundColor,
    bodyBackground: bodyStyle?.backgroundColor ?? null,
    bodyColor: bodyStyle?.color ?? null,
    liveCardPresent: Boolean(liveCard),
    liveCardBackground: liveCard ? getComputedStyle(liveCard).backgroundColor : null,
    frameDarkreaderNodes,
    shadowBackground: shadowArticle ? getComputedStyle(shadowArticle).backgroundColor : null,
  };
})();
"""


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--firefox", required=True)
    parser.add_argument("--geckodriver", required=True)
    parser.add_argument("--xpi", required=True)
    parser.add_argument("--base", default="http://127.0.0.1:18765")
    parser.add_argument("--output", default="/private/tmp/nightglass-firefox-smoke")
    return parser.parse_args()


def wait_for(driver: webdriver.Firefox, expression: str, timeout: float = 12) -> None:
    WebDriverWait(driver, timeout).until(lambda active: active.execute_script(expression))


def summary(driver: webdriver.Firefox) -> dict:
    return driver.execute_script(PAGE_SUMMARY)


def navigate_extension_page(driver: webdriver.Firefox, url: str) -> None:
    with driver.context(driver.CONTEXT_CHROME):
        driver.execute_script(
            """
            const uri = Services.io.newURI(arguments[0]);
            window.gBrowser.selectedBrowser.loadURI(uri, {
              triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal(),
            });
            """,
            url,
        )
    WebDriverWait(driver, 12).until(lambda active: active.current_url == url)
    wait_for(driver, "return document.readyState === 'complete'")


def set_site_mode(driver: webdriver.Firefox, mode: str) -> None:
    result = driver.execute_async_script(
        """
        const mode = arguments[0];
        const done = arguments[arguments.length - 1];
        browser.storage.local.get('nightglassSettings').then(({nightglassSettings}) => {
          const settings = nightglassSettings || {};
          const siteRules = {...(settings.siteRules || {})};
          if (mode === 'auto') {
            delete siteRules['127.0.0.1'];
          } else {
            siteRules['127.0.0.1'] = {mode};
          }
          return browser.storage.local.set({nightglassSettings: {...settings, enabled: true, siteRules}});
        }).then(() => done({ok: true}), (error) => done({ok: false, error: String(error)}));
        """,
        mode,
    )
    if not result or not result.get("ok"):
        raise RuntimeError(f"Could not store Firefox site mode {mode}: {result}")


def extension_uuid(profile_path: Path, addon_id: str) -> str:
    preferences = profile_path / "prefs.js"
    deadline = time.monotonic() + 10
    pattern = re.compile(r'user_pref\("extensions\.webextensions\.uuids",\s*"(.*)"\);')
    while time.monotonic() < deadline:
        if preferences.exists():
            text = preferences.read_text(encoding="utf-8", errors="replace")
            match = pattern.search(text)
            if match:
                encoded = match.group(1)
                decoded = json.loads(f'"{encoded}"')
                mapping = json.loads(decoded)
                if addon_id in mapping:
                    return mapping[addon_id]
        time.sleep(0.2)
    raise RuntimeError(f"Could not resolve the Firefox UUID for {addon_id}")


def main() -> None:
    args = parse_args()
    output = Path(args.output).resolve()
    output.mkdir(parents=True, exist_ok=True)
    xpi = Path(args.xpi).resolve()

    options = Options()
    options.binary_location = str(Path(args.firefox).resolve())
    options.add_argument("-headless")
    options.set_preference("browser.shell.checkDefaultBrowser", False)
    options.set_preference("browser.startup.homepage_override.mstone", "ignore")
    options.set_preference("datareporting.policy.dataSubmissionEnabled", False)
    options.set_preference("toolkit.telemetry.reportingpolicy.firstRun", False)
    options.set_preference("extensions.webextensions.restrictedDomains", "")
    service = Service(
        executable_path=str(Path(args.geckodriver).resolve()),
        service_args=["--allow-system-access"],
    )

    report: dict = {
        "firefoxVersion": None,
        "addonID": None,
        "lightFixture": None,
        "dynamicFixture": None,
        "nativeFixture": None,
        "siteModes": {},
        "extensionUI": None,
    }

    driver = webdriver.Firefox(options=options, service=service)
    try:
        driver.set_page_load_timeout(30)
        driver.set_window_size(1280, 900)
        report["firefoxVersion"] = driver.capabilities.get("browserVersion")
        addon_id = driver.install_addon(str(xpi), temporary=True)
        report["addonID"] = addon_id
        profile_path = Path(driver.capabilities["moz:profile"])
        uuid = extension_uuid(profile_path, addon_id)

        base = args.base.rstrip("/")
        driver.get(f"{base}/lab.html")
        wait_for(driver, "return document.documentElement.getAttribute('data-darkreader-mode') === 'dynamic'")
        report["lightFixture"] = summary(driver)

        driver.find_element("id", "add-card").click()
        wait_for(driver, "return Boolean(document.querySelector('.live-card'))")
        wait_for(driver, "return getComputedStyle(document.querySelector('.live-card')).backgroundColor !== 'rgb(242, 255, 247)'")
        report["dynamicFixture"] = summary(driver)
        driver.save_screenshot(str(output / "lab-themed.png"))

        driver.get(f"{base}/native-dark.html")
        time.sleep(2)
        report["nativeFixture"] = summary(driver)

        options_url = f"moz-extension://{uuid}/src/ui/options.html"
        navigate_extension_page(driver, options_url)
        wait_for(driver, "return document.querySelectorAll('input[name=\"preset\"]').length === 5")
        options_summary = driver.execute_script(
            """
            return {
              title: document.title,
              heading: document.querySelector('h1')?.textContent.trim(),
              saveStatus: document.querySelector('#save-status')?.textContent.trim(),
              presetCount: document.querySelectorAll('input[name="preset"]').length,
              enabled: document.querySelector('#enabled')?.checked,
            };
            """
        )
        driver.save_screenshot(str(output / "options.png"))

        set_site_mode(driver, "off")
        driver.get(f"{base}/lab.html")
        time.sleep(2)
        report["siteModes"]["off"] = summary(driver)

        navigate_extension_page(driver, options_url)
        set_site_mode(driver, "on")
        driver.get(f"{base}/native-dark.html")
        wait_for(driver, "return document.documentElement.getAttribute('data-darkreader-mode') === 'dynamic'")
        report["siteModes"]["onNativeDark"] = summary(driver)

        navigate_extension_page(driver, options_url)
        set_site_mode(driver, "auto")
        driver.get(f"{base}/lab.html")
        wait_for(driver, "return document.documentElement.getAttribute('data-darkreader-mode') === 'dynamic'")
        report["siteModes"]["auto"] = summary(driver)

        popup_url = f"moz-extension://{uuid}/src/ui/popup.html"
        navigate_extension_page(driver, popup_url)
        wait_for(driver, "return document.querySelectorAll('input[name=\"preset\"]').length === 4")
        popup_summary = driver.execute_script(
            """
            return {
              title: document.title,
              siteHeading: document.querySelector('#site-heading')?.textContent.trim(),
              status: document.querySelector('#status-label')?.textContent.trim(),
              presetCount: document.querySelectorAll('input[name="preset"]').length,
              globalTogglePresent: Boolean(document.querySelector('#global-toggle')),
            };
            """
        )
        driver.save_screenshot(str(output / "popup.png"))
        report["extensionUI"] = {"options": options_summary, "popup": popup_summary}

        assert report["lightFixture"]["darkreaderNodes"] > 0
        assert report["lightFixture"]["frameDarkreaderNodes"] > 0
        assert report["dynamicFixture"]["liveCardPresent"] is True
        assert report["nativeFixture"]["darkreaderNodes"] == 0
        assert report["siteModes"]["off"]["darkreaderNodes"] == 0
        assert report["siteModes"]["onNativeDark"]["darkreaderNodes"] > 0
        assert report["siteModes"]["auto"]["darkreaderNodes"] > 0
        assert options_summary["presetCount"] == 5
        assert popup_summary["presetCount"] == 4
    finally:
        driver.quit()

    report_path = output / "report.json"
    report_path.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(report, indent=2))
    print(f"Firefox smoke report: {report_path}")


if __name__ == "__main__":
    main()
