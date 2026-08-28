import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import test from "node:test";

const [popupHTML, popupCSS, optionsHTML, optionsCSS, fixtureHTML, fixtureCSS, settingsJS, previewApi, fixturePreview, popupPreview] = await Promise.all([
  readFile(new URL("../src/ui/popup.html", import.meta.url), "utf8"),
  readFile(new URL("../src/ui/popup.css", import.meta.url), "utf8"),
  readFile(new URL("../src/ui/options.html", import.meta.url), "utf8"),
  readFile(new URL("../src/ui/options.css", import.meta.url), "utf8"),
  readFile(new URL("../fixtures/lab.html", import.meta.url), "utf8"),
  readFile(new URL("../fixtures/lab.css", import.meta.url), "utf8"),
  readFile(new URL("../src/shared/settings.js", import.meta.url), "utf8"),
  readFile(new URL("../src/ui/preview-api.js", import.meta.url), "utf8"),
  readFile(new URL("../fixtures/nightglass-preview.js", import.meta.url), "utf8"),
  readFile(new URL("../fixtures/popup-preview.html", import.meta.url), "utf8"),
]);

const UI_PALETTE = Object.freeze([
  "#101c34",
  "#0c2945",
  "#49dbd6",
  "#70f5ec",
  "#22bada",
  "#cae3ff",
  "#f4faff",
]);

test("Nightglass surfaces share the canonical name and packaged icon", () => {
  assert.match(popupHTML, />Nightglass</);
  assert.match(optionsHTML, />Nightglass</);
  assert.match(fixtureHTML, />Nightglass Rendering Lab</);
  assert.doesNotMatch(fixtureHTML, /Northwind/i);

  for (const source of [popupHTML, optionsHTML]) {
    assert.match(source, /src="\.\.\/\.\.\/assets\/icons\/nightglass-64\.png"/);
  }
  assert.match(fixtureHTML, /src="\.\.\/assets\/icons\/nightglass-64\.png"/);
});

test("popup and settings use the same navy, teal, cyan, and ice palette", () => {
  for (const token of UI_PALETTE) {
    assert.ok(popupCSS.toLowerCase().includes(token), `popup should use ${token}`);
    assert.ok(optionsCSS.toLowerCase().includes(token), `settings should use ${token}`);
  }

  assert.match(fixtureCSS, /--ink:\s*#101c34/i);
  assert.match(fixtureCSS, /--brand:\s*#087886/i);
  assert.match(fixtureCSS, /rgba\(73, 219, 214, \.34\)/i);
  assert.match(settingsJS, /neutral:[\s\S]*?backgroundColor:\s*"#101c34"[\s\S]*?textColor:\s*"#f4faff"/i);
});

test("rendering fixture keeps green, amber, and red semantic coverage", () => {
  assert.match(fixtureHTML, /class="dot green"/);
  assert.match(fixtureHTML, /class="dot amber"/);
  assert.match(fixtureHTML, /class="dot red"/);
  assert.match(fixtureCSS, /\.green\s*{\s*background:\s*#[0-9a-f]{6}/i);
  assert.match(fixtureCSS, /\.amber\s*{\s*background:\s*#[0-9a-f]{6}/i);
  assert.match(fixtureCSS, /\.red\s*{\s*background:\s*#[0-9a-f]{6}/i);
});

test("repeatable previews stay local and use the canonical neutral theme", () => {
  assert.match(previewApi, /127\.0\.0\.1/);
  assert.match(previewApi, /localhost/);
  assert.match(previewApi, /get\("preview"\)\s*===\s*"1"/);
  assert.doesNotMatch(previewApi, /\bfetch\s*\(/);
  assert.match(fixturePreview, /get\("nightglass-preview"\)\s*!==\s*"1"/);
  assert.match(fixturePreview, /darkSchemeBackgroundColor:\s*"#101c34"/i);
  assert.match(fixturePreview, /darkSchemeTextColor:\s*"#f4faff"/i);
  assert.match(popupPreview, /src="\.\.\/assets\/icons\/nightglass-64\.png"/);
  assert.match(popupPreview, /src="\.\.\/src\/ui\/popup\.html\?preview=1"/);
});
