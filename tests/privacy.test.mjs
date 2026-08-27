import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import {join, resolve} from "node:path";
import test from "node:test";

const PROJECT_ROOT = resolve(import.meta.dirname, "..");
const PRODUCTION_JAVASCRIPT = [
  "src/extension/background.js",
  "src/extension/content.js",
  "src/extension/prepaint.js",
  "src/shared/network-policy.js",
  "src/shared/settings.js",
  "src/ui/options.js",
  "src/ui/popup.js",
  "src/userscript/adapter.js",
  "src/userscript/mobile-control.js",
];

async function source(path) {
  return readFile(join(PROJECT_ROOT, path), "utf8");
}

test("production code contains no analytics, telemetry, sync storage, or fixed collector", async () => {
  const files = await Promise.all(PRODUCTION_JAVASCRIPT.map(async (path) => [path, await source(path)]));
  const forbidden = [
    /\bnavigator\s*\.\s*sendBeacon\s*\(/i,
    /\bnew\s+(?:WebSocket|EventSource|XMLHttpRequest|RTCPeerConnection)\s*\(/i,
    /\b(?:browser|chrome)\s*\.\s*storage\s*\.\s*sync\b/i,
    /\b(?:fetch|sendBeacon|xmlHttpRequest)\s*\(\s*["'`]\s*https?:\/\/[a-z0-9]/i,
  ];
  for (const [path, contents] of files) {
    for (const pattern of forbidden) {
      assert.doesNotMatch(contents, pattern, `${path} must not contain a collection or fixed-egress sink`);
    }
  }

  const packageMetadata = JSON.parse(await source("package.json"));
  assert.equal(packageMetadata.dependencies, undefined);
  assert.equal(packageMetadata.devDependencies, undefined);
});

test("manifests declare only local settings storage and Firefox declares no data collection", async () => {
  for (const target of ["chromium", "firefox", "safari-web-extension"]) {
    const manifest = JSON.parse(await source(`manifests/${target}.json`));
    assert.deepEqual(manifest.permissions, ["storage"]);
    assert.equal(manifest.update_url, undefined);
    assert.equal(manifest.optional_permissions, undefined);
    assert.match(manifest.content_security_policy.extension_pages, /connect-src 'none'/);
  }
  const firefox = JSON.parse(await source("manifests/firefox.json"));
  assert.deepEqual(firefox.browser_specific_settings.gecko.data_collection_permissions.required, ["none"]);
});

test("renderer resource caches are memory-only", async () => {
  const renderer = await source("vendor/darkreader/darkreader.js");
  assert.doesNotMatch(renderer, /\bsessionStorage\s*\.\s*(?:getItem|setItem)\s*\(/);
  assert.doesNotMatch(renderer, /__darkreader__(?:cssFetch|imageDetails)/);
  assert.match(renderer, /const runtimeImageDetailsCache = new Map\(\)/);
  assert.match(renderer, /const runtimeCSSFetchCache = new Map\(\)/);
});

test("the iPhone control is closed and persistent writes require trusted events", async () => {
  const control = await source("src/userscript/mobile-control.js");
  assert.match(control, /attachShadow\(\{mode: "closed"\}\)/);
  assert.doesNotMatch(control, /attachShadow\(\{mode: "open"\}\)/);
  assert.match(control, /function isTrustedUserEvent\(event\)/);
  assert.match(control, /isTrustedUserEvent\(event\) && input\.checked/);
  assert.match(control, /if \(!isTrustedUserEvent\(event\)\) \{\s*return;/);
});

test("renderer networking stays in native page CORS and is credentialless, redirect-free, and bounded", async () => {
  const background = await source("src/extension/background.js");
  assert.doesNotMatch(background, /\bfetch\s*\(/);
  assert.doesNotMatch(background, /runtime\s*\.\s*onMessage/);

  const adapter = await source("src/userscript/adapter.js");
  assert.match(adapter, /NetworkPolicy\.createCORSFetch\(runtime\)/);
  assert.doesNotMatch(adapter, /GM\s*\.\s*xmlHttpRequest|GM_xmlhttpRequest/);

  const policy = await source("src/shared/network-policy.js");
  assert.match(policy, /mode: "cors"/);
  assert.match(policy, /credentials: "omit"/);
  assert.match(policy, /redirect: "error"/);
  assert.match(policy, /referrerPolicy: "no-referrer"/);
  assert.match(policy, /MAX_CONCURRENT_REQUESTS = 4/);
  assert.match(policy, /MAX_DOCUMENT_REQUESTS = 128/);
  assert.match(policy, /MAX_DOCUMENT_BYTES = 32 \* 1024 \* 1024/);

  const userscriptBuilder = await source("scripts/build-userscript.mjs");
  assert.doesNotMatch(userscriptBuilder, /"\/\/ @connect\s/);
  assert.doesNotMatch(userscriptBuilder, /"\/\/ @grant\s+GM\.xmlHttpRequest/);
});
