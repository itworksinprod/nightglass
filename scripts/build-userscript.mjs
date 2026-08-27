import {access, mkdir, readFile, rename, writeFile} from "node:fs/promises";
import {dirname, join, parse, resolve} from "node:path";
import {fileURLToPath} from "node:url";

const SCRIPT_DIRECTORY = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(SCRIPT_DIRECTORY, "..");

export const USERSCRIPT_INPUTS = Object.freeze([
  "vendor/darkreader/darkreader.js",
  "vendor/darkreader/VERSION",
  "vendor/darkreader/LICENSE",
  "src/shared/settings.js",
  "src/shared/network-policy.js",
  "src/userscript/adapter.js",
  "src/userscript/mobile-control.css",
  "src/userscript/mobile-control.js",
  "package.json",
]);

function safeRoot(value) {
  const root = resolve(value);
  if (root === parse(root).root || root.length < 5) {
    throw new Error(`Refusing to build a userscript from unsafe root: ${root}`);
  }
  return root;
}

async function pathExists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function assertInputs(root) {
  const missing = [];
  for (const relativePath of USERSCRIPT_INPUTS) {
    if (!(await pathExists(join(root, relativePath)))) {
      missing.push(relativePath);
    }
  }
  if (missing.length) {
    throw new Error(`Cannot build the Nightglass userscript; missing input${missing.length === 1 ? "" : "s"}:\n- ${missing.join("\n- ")}`);
  }
}

function assertVersion(value) {
  if (typeof value !== "string" || !/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(value)) {
    throw new Error("package.json must contain a valid userscript version");
  }
  return value;
}

export function createMetadata({version}) {
  return [
    "// ==UserScript==",
    "// @name         Nightglass",
    "// @namespace    nightglass.local",
    `// @version      ${assertVersion(version)}`,
    "// @description  Private, local-only dynamic dark mode for Safari on iPhone.",
    "// @author       Nightglass contributors",
    "// @license      MIT",
    "// @match        http://*/*",
    "// @match        https://*/*",
    "// @run-at       document-start",
    "// @inject-into  content",
    "// @grant        GM.getValue",
    "// @grant        GM.setValue",
    "// @grant        GM.deleteValue",
    "// ==/UserScript==",
    "",
  ].join("\n");
}

function sourceSection(name, source) {
  return `\n/* ===== Nightglass bundled source: ${name} ===== */\n${source.trim()}\n`;
}

function embeddedStylesheet(source) {
  return sourceSection(
    "src/userscript/mobile-control.css",
    `(function attachNightglassMobileControlCSS(global) {\n    "use strict";\n    global.NightglassMobileControlCSS = ${JSON.stringify(source)};\n})(globalThis);`,
  );
}

function assertSelfContained(source) {
  const metadata = source.slice(0, source.indexOf("// ==/UserScript==") + "// ==/UserScript==".length);
  if (/^\s*\/\/\s*@(?:require|resource|downloadURL|updateURL)\b/im.test(metadata)) {
    throw new Error("Nightglass userscript metadata must not load remote code or resources");
  }
  if (/^\s*\/\/\s*@connect\b/im.test(metadata) || /@grant\s+(?:GM\.xmlHttpRequest|GM_xmlhttpRequest)\b/i.test(metadata)) {
    throw new Error("Nightglass userscript metadata must not grant privileged network access");
  }
  if (/\bimportScripts\s*\(|\bimport\s*\(\s*["']https?:/i.test(source)) {
    throw new Error("Nightglass userscript contains a remote-code loader");
  }
  if (/\b(?:GM\s*\.\s*xmlHttpRequest|GM_xmlhttpRequest)\b/.test(source)) {
    throw new Error("Nightglass userscript contains privileged network access");
  }
}

export async function buildUserscript({root = PROJECT_ROOT, quiet = false} = {}) {
  const projectRoot = safeRoot(root);
  await assertInputs(projectRoot);

  let packageMetadata;
  try {
    packageMetadata = JSON.parse(await readFile(join(projectRoot, "package.json"), "utf8"));
  } catch (error) {
    throw new Error(`Could not read userscript package metadata: ${error.message}`, {cause: error});
  }
  const version = assertVersion(packageMetadata.version);
  const pinRecord = await readFile(join(projectRoot, "vendor", "darkreader", "VERSION"), "utf8");
  const pinnedMatch = /^Dark Reader API bundle:\s*(\d+\.\d+\.\d+)\s*$/m.exec(pinRecord);
  if (!pinnedMatch) {
    throw new Error("vendor/darkreader/VERSION must pin an exact release");
  }
  const pinnedVersion = pinnedMatch[1];

  const [vendor, settings, networkPolicy, adapter, mobileCSS, mobileControl] = await Promise.all([
    readFile(join(projectRoot, "vendor", "darkreader", "darkreader.js"), "utf8"),
    readFile(join(projectRoot, "src", "shared", "settings.js"), "utf8"),
    readFile(join(projectRoot, "src", "shared", "network-policy.js"), "utf8"),
    readFile(join(projectRoot, "src", "userscript", "adapter.js"), "utf8"),
    readFile(join(projectRoot, "src", "userscript", "mobile-control.css"), "utf8"),
    readFile(join(projectRoot, "src", "userscript", "mobile-control.js"), "utf8"),
  ]);

  if (!vendor.includes(`Dark Reader v${pinnedVersion}`)) {
    throw new Error(`Vendored Dark Reader source does not match pinned version ${pinnedVersion}`);
  }
  const source = [
    createMetadata({version}),
    `/* Dark Reader ${pinnedVersion} is bundled under its MIT license; see Nightglass NOTICE.md. */\n`,
    sourceSection("vendor/darkreader/darkreader.js", vendor),
    sourceSection("src/shared/settings.js", settings),
    sourceSection("src/shared/network-policy.js", networkPolicy),
    sourceSection("src/userscript/adapter.js", adapter),
    embeddedStylesheet(mobileCSS),
    sourceSection("src/userscript/mobile-control.js", mobileControl),
  ].join("");
  assertSelfContained(source);

  const destinationDirectory = join(projectRoot, "dist");
  const output = join(destinationDirectory, "nightglass.user.js");
  const temporaryOutput = join(destinationDirectory, `.nightglass.user.js.${process.pid}.tmp`);
  await mkdir(destinationDirectory, {recursive: true});
  await writeFile(temporaryOutput, source, "utf8");
  await rename(temporaryOutput, output);
  if (!quiet) {
    console.log(`Built self-contained iPhone userscript at ${output}`);
  }
  return {output, version, darkReaderVersion: pinnedVersion, bytes: Buffer.byteLength(source)};
}

function isMainModule() {
  return process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
}

if (isMainModule()) {
  await buildUserscript();
}
