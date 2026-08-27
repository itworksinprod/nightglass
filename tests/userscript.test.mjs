import assert from "node:assert/strict";
import {mkdir, mkdtemp, readFile, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {dirname, join, resolve} from "node:path";
import test from "node:test";
import vm from "node:vm";

import {buildUserscript, createMetadata} from "../scripts/build-userscript.mjs";

const PROJECT_ROOT = resolve(import.meta.dirname, "..");

async function evaluateAdapter() {
  const context = {
    AbortController,
    URL,
    Headers,
    Response,
    Uint8Array,
    TextEncoder,
    setTimeout,
    clearTimeout,
  };
  context.globalThis = context;
  for (const relativePath of ["src/shared/network-policy.js", "src/userscript/adapter.js"]) {
    const source = await readFile(join(PROJECT_ROOT, relativePath), "utf8");
    vm.runInNewContext(source, context, {filename: relativePath});
  }
  return context.NightglassUserscriptAdapter;
}

test("userscript metadata declares document-start content injection and only local bundled code", () => {
  const metadata = createMetadata({version: "1.2.3"});
  assert.match(metadata, /@match\s+http:\/\/\*\/\*/);
  assert.match(metadata, /@match\s+https:\/\/\*\/\*/);
  assert.match(metadata, /@run-at\s+document-start/);
  assert.match(metadata, /@inject-into\s+content/);
  for (const grant of ["GM.getValue", "GM.setValue", "GM.deleteValue"]) {
    assert.match(metadata, new RegExp(`@grant\\s+${grant.replace(".", "\\.")}`));
  }
  assert.doesNotMatch(metadata, /@grant\s+GM\.xmlHttpRequest/);
  assert.doesNotMatch(metadata, /@connect\b/);
  assert.doesNotMatch(metadata, /@(require|resource|downloadURL|updateURL)\b/i);
});

test("buildUserscript concatenates the pinned engine, settings, adapter, embedded CSS, and control in order", async () => {
  const root = await mkdtemp(join(tmpdir(), "nightglass-userscript-"));
  const files = {
    "package.json": JSON.stringify({version: "2.3.4"}),
    "vendor/darkreader/VERSION": "Dark Reader API bundle: 4.9.125\n",
    "vendor/darkreader/LICENSE": "MIT\n",
    "vendor/darkreader/darkreader.js": "/** Dark Reader v4.9.125 */\nglobalThis.engineMarker = true;\n",
    "src/shared/settings.js": "globalThis.settingsMarker = true;\n",
    "src/shared/network-policy.js": "globalThis.networkPolicyMarker = true;\n",
    "src/userscript/adapter.js": "globalThis.adapterMarker = true;\n",
    "src/userscript/mobile-control.css": ":host { color: #fff; }\n",
    "src/userscript/mobile-control.js": "globalThis.controlMarker = true;\n",
  };
  for (const [relativePath, contents] of Object.entries(files)) {
    const path = join(root, relativePath);
    await mkdir(dirname(path), {recursive: true});
    await writeFile(path, contents, "utf8");
  }
  const result = await buildUserscript({root, quiet: true});
  const output = await readFile(result.output, "utf8");
  assert.equal(result.version, "2.3.4");
  assert.equal(result.darkReaderVersion, "4.9.125");
  assert.equal(result.output, join(root, "dist", "nightglass.user.js"));
  const markers = ["engineMarker", "settingsMarker", "networkPolicyMarker", "adapterMarker", "NightglassMobileControlCSS", "controlMarker"];
  for (let index = 1; index < markers.length; index += 1) {
    assert.ok(output.indexOf(markers[index - 1]) < output.indexOf(markers[index]));
  }
  assert.match(output, /global\.NightglassMobileControlCSS = ":host \{ color: #fff; \}\\n"/);
  assert.doesNotMatch(output.slice(0, output.indexOf("// ==/UserScript==")), /@require\b/);
});

test("adapter schedule and site-mode decisions match the schema", async () => {
  const adapter = await evaluateAdapter();
  const api = adapter.test;
  assert.equal(api.parseClock("07:05"), 425);
  assert.equal(api.parseClock("24:00"), null);
  assert.equal(api.scheduleIsActive(
    {start: "20:00", end: "07:00"},
    new Date(2026, 0, 1, 23, 0),
  ), true);
  assert.equal(api.scheduleIsActive(
    {start: "20:00", end: "07:00"},
    new Date(2026, 0, 1, 12, 0),
  ), false);
  assert.deepEqual(
    {...api.activationDecision({enabled: true, globalEnabled: true, siteMode: "on"}, false)},
    {active: true, force: true, reason: "site-forced"},
  );
  assert.deepEqual(
    {...api.activationDecision({enabled: false, globalEnabled: true, siteMode: "off"}, true)},
    {active: false, force: false, reason: "site-disabled"},
  );
  assert.deepEqual(
    {...api.activationDecision({enabled: true, globalEnabled: false, siteMode: "on"}, true)},
    {active: false, force: false, reason: "globally-disabled"},
  );
});

test("adapter maps schema theme fields to Dark Reader without recoloring media pixels", async () => {
  const adapter = await evaluateAdapter();
  const result = adapter.test.createDarkReaderConfiguration({
    theme: {
      brightness: 110,
      contrast: 95,
      sepia: 12,
      grayscale: 4,
      imageDim: 18,
      backgroundColor: "#101419",
      textColor: "#f4f1e9",
    },
    customCSS: ".article { line-height: 1.6; }",
  });
  assert.equal(result.theme.mode, 1);
  assert.equal(result.theme.darkSchemeBackgroundColor, "#101419");
  assert.equal(result.theme.darkSchemeTextColor, "#f4f1e9");
  assert.equal(result.imageDim, 18);
  assert.match(result.fixes.css, /line-height/);
  assert.equal("filter" in result.theme, false);
});

test("userscript adapter delegates renderer requests to the native CORS policy", async () => {
  const adapter = await evaluateAdapter();
  const calls = [];
  const expectedFetcher = async () => new Response("body");
  const runtime = {
    NightglassNetworkPolicy: {
      createCORSFetch(receivedRuntime) {
        calls.push(receivedRuntime);
        return expectedFetcher;
      },
    },
  };
  assert.equal(adapter.test.createPageFetch(runtime), expectedFetcher);
  assert.deepEqual(calls, [runtime]);
});

test("mobile control exits before touching the DOM in a child frame", async () => {
  const source = await readFile(join(PROJECT_ROOT, "src", "userscript", "mobile-control.js"), "utf8");
  const context = {self: {}, top: {}, document: null};
  context.globalThis = context;
  vm.runInNewContext(source, context, {filename: "mobile-control.js"});
  assert.equal(context.__nightglassMobileControl, undefined);
});
