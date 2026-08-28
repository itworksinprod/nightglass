import {createHash} from "node:crypto";
import {access, cp, mkdir, readFile, rm, writeFile} from "node:fs/promises";
import {basename, dirname, join, parse, resolve, sep} from "node:path";
import {fileURLToPath, pathToFileURL} from "node:url";

import {generateIcons} from "./generate-icons.mjs";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(SCRIPT_DIR, "..");

export const BUILD_TARGETS = Object.freeze([
  Object.freeze({name: "chromium", template: "chromium.json"}),
  Object.freeze({name: "firefox", template: "firefox.json"}),
  Object.freeze({name: "safari-web-extension", template: "safari-web-extension.json"}),
]);

const EXPECTED_VENDOR_HASHES = Object.freeze({
  "darkreader.js": "4355bdf4b2305f7c206234222f4ca8b90fd2642b6d5e58a1ad00180008f43c6f",
  LICENSE: "f0a5f835174494f8981b2cbb1a34054d4f887a5c865318650d6a17afe1c7850e",
  VERSION: "7eddc91787ca854de65019f98f7b819e834fc36b61cbed99a91ac0ce624b1076",
});

export const REQUIRED_SOURCE_FILES = Object.freeze([
  "src/extension/background.js",
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
  "src/ui/preview-api.js",
  "vendor/darkreader/darkreader.js",
  "vendor/darkreader/LICENSE",
  "vendor/darkreader/VERSION",
  "NOTICE.md",
  "docs/PRIVACY.md",
  "docs/PRIVACY_AUDIT.md",
  "package.json",
  "scripts/build-userscript.mjs",
]);

function assertSafeProjectRoot(root) {
  const projectRoot = resolve(root);
  if (projectRoot === parse(projectRoot).root || projectRoot.length < 5) {
    throw new Error(`Refusing to use unsafe project root: ${projectRoot}`);
  }
  return projectRoot;
}

function generatedDirectory(root, name) {
  const destination = resolve(root, name);
  if (dirname(destination) !== root || !["dist", "artifacts"].includes(basename(destination))) {
    throw new Error(`Refusing to modify unexpected generated directory: ${destination}`);
  }
  return destination;
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
  const required = [
    ...REQUIRED_SOURCE_FILES,
    ...BUILD_TARGETS.map(({template}) => `manifests/${template}`),
  ];
  const missing = [];
  for (const path of required) {
    if (!(await pathExists(join(root, path)))) {
      missing.push(path);
    }
  }
  if (missing.length > 0) {
    throw new Error(`Cannot build Nightglass; missing required input${missing.length === 1 ? "" : "s"}:\n- ${missing.join("\n- ")}`);
  }
}

async function assertPinnedVendorInputs(root) {
  for (const [filename, expectedHash] of Object.entries(EXPECTED_VENDOR_HASHES)) {
    const relativePath = `vendor/darkreader/${filename}`;
    const source = join(root, relativePath);
    const actualHash = createHash("sha256").update(await readFile(source)).digest("hex");
    if (actualHash !== expectedHash) {
      throw new Error(`${relativePath}: SHA-256 mismatch (expected ${expectedHash}, found ${actualHash})`);
    }
  }
}

async function readJson(path) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    throw new Error(`Could not parse ${path}: ${error.message}`, {cause: error});
  }
}

async function copyExtensionSource(sourceRoot, destinationRoot) {
  const userscriptRoot = resolve(sourceRoot, "userscript");
  await cp(sourceRoot, destinationRoot, {
    recursive: true,
    filter(source) {
      const candidate = resolve(source);
      return candidate !== userscriptRoot && !candidate.startsWith(`${userscriptRoot}${sep}`);
    },
  });
}

async function runUserscriptBuilder(root, dist) {
  const builder = join(root, "scripts", "build-userscript.mjs");
  if (!(await pathExists(builder))) {
    return [];
  }

  try {
    const userscriptModule = await import(pathToFileURL(builder).href);
    if (typeof userscriptModule.buildUserscript !== "function") {
      throw new TypeError("scripts/build-userscript.mjs must export buildUserscript({root, quiet})");
    }
    await userscriptModule.buildUserscript({root, quiet: true});
  } catch (error) {
    throw new Error(`Userscript build failed: ${error.message}`, {cause: error});
  }

  const output = join(dist, "nightglass.user.js");
  if (!(await pathExists(output))) {
    throw new Error("scripts/build-userscript.mjs completed without creating dist/nightglass.user.js");
  }
  return [output];
}

function installInstructions({hasUserscript}) {
  const userscriptSection = hasUserscript
    ? `\n## iPhone fallback: Userscripts\n\nThe self-contained script is \`dist/nightglass.user.js\` in a source build, or\nthe versioned \`.user.js\` file beside this guide in a release package. Put it\nin the folder watched by the free Userscripts app, enable Userscripts in\n**Settings > Apps > Safari > Extensions**, grant **Always Allow** access for\n**All Websites**, and enable the script.\n`
    : "";

  return `# Install Nightglass locally\n\nRun \`npm run build\` from this directory whenever the source changes. Nightglass\nkeeps all settings in browser-local storage and does not need an account.\n\n## Chrome or Edge 148+\n\n1. Open \`chrome://extensions\` in Chrome or \`edge://extensions\` in Edge.\n2. Turn on **Developer mode**.\n3. Choose **Load unpacked** and select \`dist/chromium\`.\n4. Pin Nightglass, open it, and grant access to the websites where it should run.\n\n## Firefox 128+\n\n1. Open \`about:debugging#/runtime/this-firefox\`.\n2. Choose **Load Temporary Add-on**.\n3. Select \`dist/firefox/manifest.json\`.\n\nTemporary Firefox add-ons are removed when Firefox exits. Run \`npm run package\`\nto create the XPI artifact used by permanent developer or signed-install flows.\n\n## Safari 18.4+ on this Mac\n\nSafari 18.4 and newer can temporarily load \`dist/safari-web-extension\`. In\n**Safari > Settings > Developer**, enable **Allow unsigned extensions**, choose\n**Add Temporary Extension…**, and select the extension folder. Safari removes a\ntemporary extension after 24 hours or when Safari quits.\n\n## Safari on Mac and iPhone\n\nA Safari Web Extension must be wrapped in an Apple app before it can run on an\niPhone. With the full current Xcode app installed, create a multiplatform Swift\nproject from the shared extension resources:\n\n\`\`\`sh\nxcrun safari-web-extension-packager dist/safari-web-extension --swift --app-name Nightglass --bundle-identifier com.example.Nightglass --project-location dist/safari-app\n\`\`\`\n\nReplace \`com.example.Nightglass\` with a reverse-DNS identifier that belongs to\nyou. Open the generated Xcode project, select your signing team, choose an iPhone\nsimulator or your connected iPhone, and run the iOS app. On the phone, enable\nNightglass in **Settings > Apps > Safari > Extensions** and allow website access.\nPhysical-iPhone testing requires Apple Developer Program membership; simulator\ntesting does not.\n${userscriptSection}\n## Release artifacts\n\nRun \`npm run package\`. Reproducible ZIP/XPI files are written to \`artifacts/\`.\n`;
}

async function copyLegalFiles(root, destination) {
  await cp(join(root, "NOTICE.md"), join(destination, "NOTICE.md"));
  await cp(join(root, "NOTICE.md"), join(destination, "vendor", "darkreader", "NOTICE.md"));
  await cp(join(root, "docs", "PRIVACY.md"), join(destination, "PRIVACY.md"));
  await cp(join(root, "docs", "PRIVACY_AUDIT.md"), join(destination, "PRIVACY_AUDIT.md"));
  const projectLicense = join(root, "LICENSE");
  if (await pathExists(projectLicense)) {
    await cp(projectLicense, join(destination, "LICENSE"));
  }
}

export async function build({root = PROJECT_ROOT, quiet = false} = {}) {
  const projectRoot = assertSafeProjectRoot(root);
  await assertInputs(projectRoot);
  await assertPinnedVendorInputs(projectRoot);

  const packageMetadata = await readJson(join(projectRoot, "package.json"));
  if (typeof packageMetadata.version !== "string" || !/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(packageMetadata.version)) {
    throw new Error("package.json must contain a valid extension version");
  }

  await generateIcons({root: projectRoot, quiet: true});
  const dist = generatedDirectory(projectRoot, "dist");
  await rm(dist, {recursive: true, force: true});
  await mkdir(dist, {recursive: true});

  for (const target of BUILD_TARGETS) {
    const destination = join(dist, target.name);
    await mkdir(destination, {recursive: true});
    await copyExtensionSource(join(projectRoot, "src"), join(destination, "src"));
    await cp(join(projectRoot, "assets"), join(destination, "assets"), {recursive: true});
    await cp(join(projectRoot, "vendor", "darkreader"), join(destination, "vendor", "darkreader"), {recursive: true});
    await copyLegalFiles(projectRoot, destination);

    const manifest = await readJson(join(projectRoot, "manifests", target.template));
    manifest.version = packageMetadata.version;
    await writeFile(join(destination, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  }

  const userscripts = await runUserscriptBuilder(projectRoot, dist);
  const install = installInstructions({hasUserscript: userscripts.length > 0});
  await writeFile(join(dist, "INSTALL.md"), install, "utf8");

  if (!quiet) {
    const suffix = userscripts.length > 0 ? ` and ${userscripts.length} userscript${userscripts.length === 1 ? "" : "s"}` : "";
    console.log(`Built ${BUILD_TARGETS.length} Nightglass browser targets${suffix} in ${dist}`);
  }

  return {
    dist,
    targets: BUILD_TARGETS.map(({name}) => join(dist, name)),
    userscripts,
    version: packageMetadata.version,
  };
}

function isMainModule() {
  return process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
}

if (isMainModule()) {
  await build();
}
