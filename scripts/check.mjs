import {createHash} from "node:crypto";
import {access, lstat, readFile, readdir} from "node:fs/promises";
import {dirname, extname, join, relative, resolve, sep} from "node:path";
import {fileURLToPath} from "node:url";

import {BUILD_TARGETS} from "./build.mjs";
import {ICON_SIZES} from "./generate-icons.mjs";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(SCRIPT_DIR, "..");
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

export const EXPECTED_VENDOR_HASHES = Object.freeze({
  "darkreader.js": "4355bdf4b2305f7c206234222f4ca8b90fd2642b6d5e58a1ad00180008f43c6f",
  LICENSE: "f0a5f835174494f8981b2cbb1a34054d4f887a5c865318650d6a17afe1c7850e",
  VERSION: "7eddc91787ca854de65019f98f7b819e834fc36b61cbed99a91ac0ce624b1076",
});

export const EXPECTED_CONTENT_SCRIPTS = Object.freeze([
  "src/extension/prepaint.js",
  "vendor/darkreader/darkreader.js",
  "src/shared/settings.js",
  "src/shared/network-policy.js",
  "src/extension/content.js",
]);

const EXPECTED_MATCHES = Object.freeze(["http://*/*", "https://*/*"]);
const EXPECTED_BACKGROUND = "src/extension/background.js";
const USERSCRIPT_SECTION_NAMES = Object.freeze([
  "vendor/darkreader/darkreader.js",
  "src/shared/settings.js",
  "src/shared/network-policy.js",
  "src/userscript/adapter.js",
  "src/userscript/mobile-control.css",
  "src/userscript/mobile-control.js",
]);
const REQUIRED_EXTENSION_FILES = Object.freeze([
  EXPECTED_BACKGROUND,
  "src/extension/prepaint.js",
  "src/extension/content.js",
  "src/shared/settings.js",
  "src/shared/network-policy.js",
  "src/ui/popup.html",
  "src/ui/popup.css",
  "src/ui/popup.js",
  "src/ui/options.html",
  "src/ui/options.css",
  "src/ui/options.js",
  "vendor/darkreader/darkreader.js",
  "vendor/darkreader/LICENSE",
  "vendor/darkreader/VERSION",
  "vendor/darkreader/NOTICE.md",
  "NOTICE.md",
  "PRIVACY.md",
  "PRIVACY_AUDIT.md",
]);

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

async function hashFile(path) {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

function hashText(source) {
  return createHash("sha256").update(source, "utf8").digest("hex");
}

function sameArray(actual, expected) {
  return Array.isArray(actual) && actual.length === expected.length && actual.every((value, index) => value === expected[index]);
}

function withinDirectory(root, path) {
  const pathFromRoot = relative(root, path);
  return pathFromRoot !== "" && pathFromRoot !== ".." && !pathFromRoot.startsWith(`..${sep}`) && !pathFromRoot.startsWith(sep);
}

async function walkFiles(directory, problems, output = []) {
  if (!(await exists(directory))) {
    return output;
  }
  for (const entry of await readdir(directory, {withFileTypes: true})) {
    const path = join(directory, entry.name);
    if (entry.isSymbolicLink()) {
      problems.push(`Symbolic links are not allowed in generated packages: ${path}`);
    } else if (entry.isDirectory()) {
      await walkFiles(path, problems, output);
    } else if (entry.isFile()) {
      output.push(path);
    }
  }
  return output;
}

function referencedManifestFiles(manifest) {
  const paths = new Set();
  const add = (value) => {
    if (typeof value === "string") {
      paths.add(value);
    }
  };

  Object.values(manifest.icons ?? {}).forEach(add);
  add(manifest.action?.default_popup);
  Object.values(manifest.action?.default_icon ?? {}).forEach(add);
  add(manifest.options_ui?.page);
  add(manifest.background?.service_worker);
  (manifest.background?.scripts ?? []).forEach(add);
  for (const contentScript of manifest.content_scripts ?? []) {
    (contentScript.js ?? []).forEach(add);
    (contentScript.css ?? []).forEach(add);
  }
  for (const resourceGroup of manifest.web_accessible_resources ?? []) {
    (resourceGroup.resources ?? []).forEach(add);
  }
  return [...paths];
}

function inspectHtml(path, source, problems) {
  for (const match of source.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi)) {
    if (match[2].trim().length > 0) {
      problems.push(`${path}: inline script blocks are forbidden`);
    }
    if (/\bsrc\s*=\s*["']\s*(?:https?:)?\/\//i.test(match[1])) {
      problems.push(`${path}: remote script sources are forbidden`);
    }
  }
  if (/<style\b/i.test(source)) {
    problems.push(`${path}: inline style blocks are forbidden`);
  }
  if (/\s(?:on[a-z]+|style|srcdoc)\s*=/i.test(source)) {
    problems.push(`${path}: inline event, style, or srcdoc attributes are forbidden`);
  }
  if (/\bjavascript\s*:/i.test(source)) {
    problems.push(`${path}: javascript: URLs are forbidden`);
  }
  if (/<link\b[^>]*\brel\s*=\s*["']?stylesheet["']?[^>]*\bhref\s*=\s*["']\s*(?:https?:)?\/\//i.test(source)
    || /<link\b[^>]*\bhref\s*=\s*["']\s*(?:https?:)?\/\/[^>]*\brel\s*=\s*["']?stylesheet/i.test(source)) {
    problems.push(`${path}: remote stylesheets are forbidden`);
  }
}

function inspectJavaScript(path, source, problems) {
  const rules = [
    [/\beval\s*\(/, "eval() is forbidden"],
    [/\bnew\s+Function\s*\(/, "the Function constructor is forbidden"],
    [/\bFunction\s*\(\s*["'`]/, "the Function constructor is forbidden"],
    [/\b(?:setTimeout|setInterval)\s*\(\s*["'`]/, "string-based timers are forbidden"],
    [/\b(?:importScripts|import)\s*\(\s*["'`]\s*(?:https?:)?\/\//i, "remote imports are forbidden"],
    [/\bnew\s+(?:Shared)?Worker\s*\(\s*["'`]\s*(?:https?:)?\/\//i, "remote workers are forbidden"],
    [/\.createElement\s*\(\s*["'`]script["'`]\s*\)/i, "dynamically created scripts are forbidden"],
    [/\b(?:script|worker)\s*\.\s*src\s*=\s*["'`]\s*(?:https?:)?\/\//i, "remote executable sources are forbidden"],
    [/\bnavigator\s*\.\s*sendBeacon\s*\(/i, "telemetry beacons are forbidden"],
    [/\bnew\s+(?:WebSocket|EventSource|XMLHttpRequest|RTCPeerConnection)\s*\(/i, "general-purpose outbound channels are forbidden"],
    [/\b(?:browser|chrome)\s*\.\s*storage\s*\.\s*sync\b/i, "browser sync storage is forbidden"],
    [/\bfetch\s*\(\s*["'`]\s*https?:\/\//i, "fixed remote fetch destinations are forbidden"],
  ];
  for (const [pattern, message] of rules) {
    if (pattern.test(source)) {
      problems.push(`${path}: ${message}`);
    }
  }
}

function inspectCss(path, source, problems) {
  if (/@import\s+(?:url\s*\()?\s*["']?\s*(?:https?:)?\/\//i.test(source)) {
    problems.push(`${path}: remote CSS imports are forbidden`);
  }
  if (/url\s*\(\s*["']?\s*(?:https?:)?\/\//i.test(source)) {
    problems.push(`${path}: remote CSS resources are forbidden`);
  }
}

function userscriptSectionMarker(name) {
  return `/* ===== Nightglass bundled source: ${name} ===== */`;
}

function countOccurrences(source, needle) {
  let count = 0;
  let offset = 0;
  while ((offset = source.indexOf(needle, offset)) !== -1) {
    count += 1;
    offset += needle.length;
  }
  return count;
}

async function validateGeneratedUserscript(projectRoot, generatedUserscript, problems) {
  const label = "dist/nightglass.user.js";
  const bundled = await readFile(generatedUserscript, "utf8");
  const markers = USERSCRIPT_SECTION_NAMES.map(userscriptSectionMarker);
  const markerIndexes = markers.map((marker) => bundled.indexOf(marker));

  for (let index = 0; index < markers.length; index += 1) {
    if (markerIndexes[index] === -1) {
      problems.push(`${label}: missing source boundary for ${USERSCRIPT_SECTION_NAMES[index]}`);
    } else if (countOccurrences(bundled, markers[index]) !== 1) {
      problems.push(`${label}: source boundary for ${USERSCRIPT_SECTION_NAMES[index]} must occur exactly once`);
    }
    if (index > 0 && markerIndexes[index] <= markerIndexes[index - 1]) {
      problems.push(`${label}: bundled source sections are out of order`);
    }
  }
  if (markerIndexes.some((index) => index < 0)) {
    return;
  }

  const sections = new Map();
  for (let index = 0; index < markers.length; index += 1) {
    const start = markerIndexes[index] + markers[index].length;
    const end = index + 1 < markers.length ? markerIndexes[index + 1] : bundled.length;
    sections.set(USERSCRIPT_SECTION_NAMES[index], bundled.slice(start, end).trim());
  }

  const pinnedVendor = (await readFile(join(projectRoot, "vendor", "darkreader", "darkreader.js"), "utf8")).trim();
  const bundledVendor = sections.get("vendor/darkreader/darkreader.js");
  const expectedVendorSegmentHash = hashText(pinnedVendor);
  const bundledVendorSegmentHash = hashText(bundledVendor);
  if (bundledVendorSegmentHash !== expectedVendorSegmentHash || bundledVendor !== pinnedVendor) {
    problems.push(`${label}: pinned Dark Reader segment SHA-256 mismatch (expected ${expectedVendorSegmentHash}, found ${bundledVendorSegmentHash})`);
  }

  const expectedSources = new Map();
  for (const name of ["src/shared/settings.js", "src/shared/network-policy.js", "src/userscript/adapter.js", "src/userscript/mobile-control.js"]) {
    expectedSources.set(name, (await readFile(join(projectRoot, name), "utf8")).trim());
  }
  const mobileCss = await readFile(join(projectRoot, "src", "userscript", "mobile-control.css"), "utf8");
  expectedSources.set(
    "src/userscript/mobile-control.css",
    `(function attachNightglassMobileControlCSS(global) {\n    "use strict";\n    global.NightglassMobileControlCSS = ${JSON.stringify(mobileCss)};\n})(globalThis);`,
  );

  for (const [name, expected] of expectedSources) {
    if (sections.get(name) !== expected) {
      problems.push(`${label}: bundled first-party section differs from ${name}`);
    }
  }

  const metadataEndMarker = "// ==/UserScript==";
  const metadataEnd = bundled.indexOf(metadataEndMarker);
  const metadata = metadataEnd === -1 ? "" : bundled.slice(0, metadataEnd + metadataEndMarker.length);
  if (!bundled.startsWith("// ==UserScript==") || metadataEnd === -1) {
    problems.push(`${label}: userscript metadata block is missing or malformed`);
  } else {
    if (/^\s*\/\/\s*@(?:require|resource|downloadURL|updateURL)\b/im.test(metadata)) {
      problems.push(`${label}: userscript metadata must not load remote code or resources`);
    }
    if (/^\s*\/\/\s*@connect\b/im.test(metadata) || /GM\.xmlHttpRequest/.test(metadata)) {
      problems.push(`${label}: userscript metadata must not grant privileged network access`);
    }
    for (const directive of ["@match        http://*/*", "@match        https://*/*", "@run-at       document-start", "@inject-into  content"]) {
      if (!metadata.includes(directive)) {
        problems.push(`${label}: userscript metadata is missing ${directive.trim()}`);
      }
    }
  }

  // The pinned upstream engine legitimately creates one fixed, local script node
  // for its CSSOM proxy. It is checked byte-for-byte above, so run executable-code
  // policy only over Nightglass-owned metadata and source sections.
  const firstPartySource = `${bundled.slice(0, markerIndexes[0])}\n${bundled.slice(markerIndexes[1])}`;
  inspectJavaScript(label, firstPartySource, problems);
  inspectCss("src/userscript/mobile-control.css", mobileCss, problems);
}

async function inspectForbiddenPatterns(buildRoot, problems) {
  const files = await walkFiles(buildRoot, problems);
  for (const path of files) {
    const relativePath = relative(buildRoot, path);
    if (relativePath === "vendor/darkreader/darkreader.js") {
      continue;
    }
    const extension = extname(path).toLowerCase();
    if (![".html", ".js", ".mjs", ".css", ".json"].includes(extension)) {
      continue;
    }
    const source = await readFile(path, "utf8");
    if (extension === ".html") {
      inspectHtml(relativePath, source, problems);
    } else if (extension === ".js" || extension === ".mjs") {
      inspectJavaScript(relativePath, source, problems);
    } else if (extension === ".css") {
      inspectCss(relativePath, source, problems);
    } else if (extension === ".json") {
      if (/"(?:update_url|sandbox)"\s*:/i.test(source)) {
        problems.push(`${relativePath}: remote update and sandbox manifest features are forbidden`);
      }
      if (/unsafe-(?:eval|inline)/i.test(source)) {
        problems.push(`${relativePath}: unsafe CSP sources are forbidden`);
      }
    }
  }
}

async function verifyPng(path, size, problems) {
  try {
    const data = await readFile(path);
    if (data.length < 24 || !data.subarray(0, 8).equals(PNG_SIGNATURE)) {
      problems.push(`${path}: is not a PNG file`);
      return;
    }
    const width = data.readUInt32BE(16);
    const height = data.readUInt32BE(20);
    if (width !== size || height !== size) {
      problems.push(`${path}: expected ${size}x${size}, found ${width}x${height}`);
    }
  } catch (error) {
    problems.push(`${path}: ${error.message}`);
  }
}

function validateCommonManifest(target, manifest, packageMetadata, problems) {
  const label = `${target}/manifest.json`;
  const expect = (condition, message) => {
    if (!condition) {
      problems.push(`${label}: ${message}`);
    }
  };

  expect(manifest.manifest_version === 3, "manifest_version must be 3");
  expect(manifest.name === "Nightglass", "name must be Nightglass");
  expect(manifest.version === packageMetadata.version, `version must match package.json (${packageMetadata.version})`);
  expect(sameArray(manifest.permissions, ["storage"]), "permissions must contain only storage");
  expect(sameArray(manifest.host_permissions, EXPECTED_MATCHES), "host_permissions must contain HTTP and HTTPS only");
  expect(manifest.action?.default_popup === "src/ui/popup.html", "action popup is missing or incorrect");
  expect(manifest.options_ui?.page === "src/ui/options.html", "options page is missing or incorrect");
  expect(manifest.options_ui?.open_in_tab === true, "options page must open in a tab");

  expect(Array.isArray(manifest.content_scripts) && manifest.content_scripts.length === 1, "exactly one content script declaration is required");
  const contentScript = manifest.content_scripts?.[0] ?? {};
  expect(sameArray(contentScript.matches, EXPECTED_MATCHES), "content script matches must contain HTTP and HTTPS only");
  expect(sameArray(contentScript.js, EXPECTED_CONTENT_SCRIPTS), `content scripts must be ordered as ${EXPECTED_CONTENT_SCRIPTS.join(", ")}`);
  expect(contentScript.run_at === "document_start", "content scripts must run at document_start");
  expect(contentScript.all_frames === true, "content scripts must run in all frames");
  expect(contentScript.match_about_blank === true, "match_about_blank must be enabled");
  expect(contentScript.match_origin_as_fallback === true, "match_origin_as_fallback must be enabled");

  const command = manifest.commands?.["toggle-nightglass"];
  expect(Boolean(command), "toggle-nightglass keyboard command is required");
  expect(typeof command?.suggested_key?.default === "string", "keyboard command needs a default shortcut");
  expect(typeof command?.suggested_key?.mac === "string", "keyboard command needs a Mac shortcut");

  const csp = manifest.content_security_policy?.extension_pages;
  expect(typeof csp === "string", "extension page CSP must use the Manifest V3 object form");
  for (const directive of ["default-src 'none'", "script-src 'self'", "connect-src 'none'", "object-src 'none'", "base-uri 'none'", "frame-ancestors 'none'"]) {
    expect(csp?.includes(directive), `CSP must include ${directive}`);
  }
  expect(!/unsafe-(?:eval|inline)/i.test(csp ?? ""), "CSP must not allow unsafe-eval or unsafe-inline");
  const scriptDirective = csp?.split(";").find((directive) => directive.trim().startsWith("script-src")) ?? "";
  expect(!/https?:|\*/i.test(scriptDirective), "script-src must not allow remote code");
}

function validatePlatformManifest(target, manifest, problems) {
  const label = `${target}/manifest.json`;
  const expect = (condition, message) => {
    if (!condition) {
      problems.push(`${label}: ${message}`);
    }
  };

  if (target === "chromium") {
    expect(manifest.minimum_chrome_version === "148", "minimum_chrome_version must be 148");
    expect(manifest.background?.service_worker === EXPECTED_BACKGROUND, "Chromium must use the MV3 background service worker");
    expect(!manifest.background?.scripts, "Chromium must not use background scripts");
  } else if (target === "firefox") {
    expect(sameArray(manifest.background?.scripts, [EXPECTED_BACKGROUND]), "Firefox must use MV3 background scripts");
    expect(!manifest.background?.service_worker, "Firefox must not use a background service_worker entry");
    const gecko = manifest.browser_specific_settings?.gecko;
    expect(typeof gecko?.id === "string" && gecko.id.includes("@"), "Firefox must declare a Gecko extension ID");
    expect(gecko?.strict_min_version === "128.0", "Firefox strict_min_version must be 128.0");
    expect(sameArray(gecko?.data_collection_permissions?.required, ["none"]), "Firefox must declare required data collection permission none");
  } else if (target === "safari-web-extension") {
    expect(manifest.background?.service_worker === EXPECTED_BACKGROUND, "Safari must use an MV3 background service worker");
    expect(manifest.browser_specific_settings?.safari?.strict_min_version === "18.4", "Safari strict_min_version must be 18.4");
  }
}

async function verifyReferencedFiles(buildRoot, manifest, problems) {
  for (const manifestPath of referencedManifestFiles(manifest)) {
    if (manifestPath.includes("*") || manifestPath.includes("\\") || manifestPath.split("/").includes("..")) {
      problems.push(`${relative(dirname(buildRoot), buildRoot)}/manifest.json: unsafe referenced path ${manifestPath}`);
      continue;
    }
    const absolute = resolve(buildRoot, manifestPath);
    if (!withinDirectory(buildRoot, absolute)) {
      problems.push(`${relative(dirname(buildRoot), buildRoot)}/manifest.json: referenced path escapes package: ${manifestPath}`);
    } else if (!(await exists(absolute))) {
      problems.push(`${relative(dirname(buildRoot), buildRoot)}/manifest.json: referenced file is missing: ${manifestPath}`);
    } else if (!(await lstat(absolute)).isFile()) {
      problems.push(`${relative(dirname(buildRoot), buildRoot)}/manifest.json: referenced path is not a file: ${manifestPath}`);
    }
  }
}

async function discoverSourceUserscripts(root) {
  const scripts = [];
  async function visit(directory) {
    if (!(await exists(directory))) {
      return;
    }
    for (const entry of await readdir(directory, {withFileTypes: true})) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        await visit(path);
      } else if (entry.isFile() && entry.name.endsWith(".user.js")) {
        scripts.push(path);
      }
    }
  }
  await visit(join(root, "src", "userscript"));
  await visit(join(root, "userscript"));
  const rootScript = join(root, "nightglass.user.js");
  if (await exists(rootScript)) {
    scripts.push(rootScript);
  }
  return [...new Set(scripts.map((path) => resolve(path)))];
}

export async function check({root = PROJECT_ROOT, quiet = false} = {}) {
  const projectRoot = resolve(root);
  const dist = join(projectRoot, "dist");
  const problems = [];

  let packageMetadata;
  try {
    packageMetadata = await readJson(join(projectRoot, "package.json"));
  } catch (error) {
    throw new Error(`Cannot read package.json: ${error.message}`, {cause: error});
  }

  for (const [filename, expectedHash] of Object.entries(EXPECTED_VENDOR_HASHES)) {
    const source = join(projectRoot, "vendor", "darkreader", filename);
    if (!(await exists(source))) {
      problems.push(`Pinned vendor file is missing: vendor/darkreader/${filename}`);
    } else {
      const actualHash = await hashFile(source);
      if (actualHash !== expectedHash) {
        problems.push(`vendor/darkreader/${filename}: SHA-256 mismatch (expected ${expectedHash}, found ${actualHash})`);
      }
    }
  }

  const pinnedRenderer = await readFile(join(projectRoot, "vendor", "darkreader", "darkreader.js"), "utf8");
  if (/\bsessionStorage\s*\.\s*(?:getItem|setItem)\s*\(/.test(pinnedRenderer)) {
    problems.push("vendor/darkreader/darkreader.js: page-origin sessionStorage caches are forbidden");
  }
  const pinRecord = await readFile(join(projectRoot, "vendor", "darkreader", "VERSION"), "utf8");
  if (!pinRecord.includes("Nightglass privacy patch: renderer resource caches use memory only")) {
    problems.push("vendor/darkreader/VERSION: the memory-only privacy patch must be documented");
  }

  const backgroundSource = await readFile(join(projectRoot, "src", "extension", "background.js"), "utf8");
  if (/\bfetch\s*\(|XMLHttpRequest|runtime\s*\.\s*onMessage/.test(backgroundSource)) {
    problems.push("src/extension/background.js: background networking and request brokers are forbidden");
  }
  const userscriptAdapter = await readFile(join(projectRoot, "src", "userscript", "adapter.js"), "utf8");
  if (/GM\s*\.\s*xmlHttpRequest|GM_xmlhttpRequest/.test(userscriptAdapter)) {
    problems.push("src/userscript/adapter.js: privileged userscript networking is forbidden");
  }

  for (const {name: target} of BUILD_TARGETS) {
    const buildRoot = join(dist, target);
    const manifestPath = join(buildRoot, "manifest.json");
    if (!(await exists(manifestPath))) {
      problems.push(`${target}/manifest.json is missing; run npm run build first`);
      continue;
    }

    let manifest;
    try {
      manifest = await readJson(manifestPath);
    } catch (error) {
      problems.push(`${target}/manifest.json is invalid JSON: ${error.message}`);
      continue;
    }

    validateCommonManifest(target, manifest, packageMetadata, problems);
    validatePlatformManifest(target, manifest, problems);
    await verifyReferencedFiles(buildRoot, manifest, problems);

    for (const requiredPath of REQUIRED_EXTENSION_FILES) {
      if (!(await exists(join(buildRoot, requiredPath)))) {
        problems.push(`${target}: required packaged file is missing: ${requiredPath}`);
      }
    }

    for (const size of ICON_SIZES) {
      const expectedPath = `assets/icons/nightglass-${size}.png`;
      if (manifest.icons?.[String(size)] !== expectedPath) {
        problems.push(`${target}/manifest.json: icon ${size} must reference ${expectedPath}`);
      }
      await verifyPng(join(buildRoot, expectedPath), size, problems);
    }

    for (const [filename, expectedHash] of Object.entries(EXPECTED_VENDOR_HASHES)) {
      const packaged = join(buildRoot, "vendor", "darkreader", filename);
      if (await exists(packaged)) {
        const actualHash = await hashFile(packaged);
        if (actualHash !== expectedHash) {
          problems.push(`${target}/vendor/darkreader/${filename}: SHA-256 mismatch`);
        }
      }
    }

    const sourceNotice = join(projectRoot, "NOTICE.md");
    const rootNotice = join(buildRoot, "NOTICE.md");
    const vendorNotice = join(buildRoot, "vendor", "darkreader", "NOTICE.md");
    if (await exists(sourceNotice) && await exists(rootNotice) && await exists(vendorNotice)) {
      const expectedNoticeHash = await hashFile(sourceNotice);
      if (await hashFile(rootNotice) !== expectedNoticeHash || await hashFile(vendorNotice) !== expectedNoticeHash) {
        problems.push(`${target}: packaged third-party notices differ from NOTICE.md`);
      }
    }

    await inspectForbiddenPatterns(buildRoot, problems);
  }

  const installPath = join(dist, "INSTALL.md");
  if (!(await exists(installPath))) {
    problems.push("dist/INSTALL.md is missing");
  } else {
    const install = await readFile(installPath, "utf8");
    if (!install.includes("safari-web-extension-packager")) {
      problems.push("dist/INSTALL.md must use safari-web-extension-packager");
    }
    if (install.includes("safari-web-extension-converter")) {
      problems.push("dist/INSTALL.md references the obsolete Safari converter command");
    }
    for (const target of ["dist/chromium", "dist/firefox", "dist/safari-web-extension"]) {
      if (!install.includes(target)) {
        problems.push(`dist/INSTALL.md does not mention ${target}`);
      }
    }
  }

  for (const source of await discoverSourceUserscripts(projectRoot)) {
    problems.push(`Unexpected source userscript is forbidden: ${relative(projectRoot, source)}`);
  }

  const copiedUserscriptDirectory = join(dist, "userscript");
  if (await exists(copiedUserscriptDirectory)) {
    problems.push("dist/userscript is forbidden; only generated dist/nightglass.user.js may be shipped");
  }

  const userscriptBuilder = join(projectRoot, "scripts", "build-userscript.mjs");
  const generatedUserscript = join(dist, "nightglass.user.js");
  if (await exists(userscriptBuilder)) {
    if (!(await exists(generatedUserscript))) {
      problems.push("scripts/build-userscript.mjs exists but dist/nightglass.user.js is missing");
    } else {
      await validateGeneratedUserscript(projectRoot, generatedUserscript, problems);
    }
  }

  if (problems.length > 0) {
    throw new Error(`Nightglass validation failed with ${problems.length} problem${problems.length === 1 ? "" : "s"}:\n- ${problems.join("\n- ")}`);
  }

  if (!quiet) {
    console.log(`Validated ${BUILD_TARGETS.length} Nightglass builds, pinned vendor hashes, CSP, assets, and local-code policy`);
  }
  return {dist, targets: BUILD_TARGETS.map(({name}) => join(dist, name))};
}

function isMainModule() {
  return process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
}

if (isMainModule()) {
  try {
    await check();
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
