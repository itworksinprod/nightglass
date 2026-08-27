import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

async function loadRuntimeHelpers() {
    const context = vm.createContext({
        URL,
        Headers,
        Response,
        Uint8Array,
        atob: (value) => Buffer.from(value, "base64").toString("binary"),
        btoa: (value) => Buffer.from(value, "binary").toString("base64"),
        console
    });
    for (const relativePath of [
        "../src/extension/prepaint.js",
        "../src/shared/network-policy.js",
        "../src/extension/content.js",
        "../src/extension/background.js"
    ]) {
        const source = await readFile(new URL(relativePath, import.meta.url), "utf8");
        vm.runInContext(source, context, {filename: relativePath});
    }
    return context.NightglassRuntimeTest;
}

test("activation supports always, system, overnight schedules, and site overrides", async () => {
    const helpers = await loadRuntimeHelpers();
    const lateEvening = new Date(2026, 0, 1, 23, 30);
    const midday = new Date(2026, 0, 1, 12, 0);
    const schedule = {start: "20:00", end: "07:00"};

    assert.equal(helpers.scheduleIsActive(schedule, lateEvening), true);
    assert.equal(helpers.scheduleIsActive(schedule, midday), false);
    assert.equal(helpers.preliminaryActivation(undefined), true);
    assert.equal(helpers.preliminaryActivation({enabled: false, siteRules: {}}), false);
    assert.equal(helpers.activationDecision({enabled: true, activation: "system", siteMode: "auto"}, false).active, false);
    assert.equal(helpers.activationDecision({enabled: true, activation: "system", siteMode: "auto"}, true).active, true);
    assert.equal(helpers.activationDecision({enabled: true, activation: "schedule", schedule, siteMode: "auto"}, false, lateEvening).active, true);
    const forcedSite = helpers.activationDecision({enabled: true, globalEnabled: true, siteMode: "on"}, false);
    assert.equal(forcedSite.active, true);
    assert.equal(forcedSite.force, true);
    assert.equal(forcedSite.reason, "site-forced");
    assert.deepEqual(
        {...helpers.activationDecision({enabled: true, globalEnabled: true, siteMode: "off"}, true)},
        {active: false, force: false, reason: "site-disabled"}
    );
    assert.deepEqual(
        {...helpers.activationDecision({enabled: true, globalEnabled: false, siteMode: "on"}, true)},
        {active: false, force: false, reason: "globally-disabled"}
    );
});

test("schedule boundary timer targets the next transition without polling", async () => {
    const helpers = await loadRuntimeHelpers();
    const now = new Date(2026, 0, 1, 19, 0, 0, 0);
    const delay = helpers.millisecondsToScheduleBoundary({start: "20:00", end: "07:00"}, now);
    assert.equal(delay, 60 * 60 * 1000 + 50);
    assert.equal(helpers.millisecondsToScheduleBoundary({start: "20:00", end: "20:00"}, now), null);
});

test("rendered color parsing and luminance distinguish black from white", async () => {
    const helpers = await loadRuntimeHelpers();
    const black = helpers.parseRenderedColor("rgb(0 0 0 / 100%)");
    const white = helpers.parseRenderedColor("rgb(255, 255, 255)");
    assert.equal(helpers.relativeLuminance(black), 0);
    assert.equal(helpers.relativeLuminance(white), 1);
    assert.equal(helpers.parseRenderedColor("transparent").a, 0);
});

test("Dark Reader configuration carries dynamic theme fields, local fixes, and dim amount", async () => {
    const helpers = await loadRuntimeHelpers();
    const configuration = helpers.createDarkReaderConfiguration({
        theme: {
            brightness: 92,
            contrast: 108,
            sepia: 7,
            grayscale: 3,
            imageDim: 25,
            backgroundColor: "#101214",
            textColor: "#f1f1ef"
        },
        fixes: {
            invert: [".icon"],
            ignoreCSSUrl: [".photo"],
            disableStyleSheetsProxy: true,
            css: ".site-fix { color: white; }"
        },
        customCSS: ".reader-fix { background: black; }"
    });

    assert.equal(configuration.theme.mode, 1);
    assert.equal(configuration.theme.darkSchemeBackgroundColor, "#101214");
    assert.equal(configuration.theme.darkSchemeTextColor, "#f1f1ef");
    assert.equal(configuration.imageDim, 25);
    assert.deepEqual(Array.from(configuration.fixes.ignoreCSSUrl), [".photo"]);
    assert.equal(configuration.fixes.disableStyleSheetsProxy, true);
    assert.match(configuration.fixes.css, /site-fix/);
    assert.match(configuration.fixes.css, /reader-fix/);
});

test("stable signatures ignore object key insertion order", async () => {
    const helpers = await loadRuntimeHelpers();
    assert.equal(
        helpers.stableStringify({theme: {contrast: 100, brightness: 90}, imageDim: 0}),
        helpers.stableStringify({imageDim: 0, theme: {brightness: 90, contrast: 100}})
    );
});
