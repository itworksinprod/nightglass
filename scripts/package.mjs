import {createHash} from "node:crypto";
import {cp, lstat, mkdir, readFile, readdir, rm, writeFile} from "node:fs/promises";
import {basename, dirname, join, relative, resolve, sep} from "node:path";
import {fileURLToPath} from "node:url";
import {deflateRawSync} from "node:zlib";

import {build} from "./build.mjs";
import {check} from "./check.mjs";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(SCRIPT_DIR, "..");
const FIXED_DOS_DATE = 0x0021;
const UTF8_FLAG = 0x0800;
const CRC_TABLE = makeCrcTable();

function makeCrcTable() {
  const table = new Uint32Array(256);
  for (let n = 0; n < table.length; n += 1) {
    let value = n;
    for (let bit = 0; bit < 8; bit += 1) {
      value = (value & 1) === 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[n] = value >>> 0;
  }
  return table;
}

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function normalizedArchivePath(path) {
  const normalized = path.split(sep).join("/");
  if (normalized.startsWith("/") || normalized.split("/").includes("..") || normalized.includes("\\")) {
    throw new Error(`Unsafe archive path: ${path}`);
  }
  return normalized;
}

async function collectEntries(directory, base = directory, output = []) {
  const children = await readdir(directory, {withFileTypes: true});
  children.sort((left, right) => left.name.localeCompare(right.name, "en"));
  for (const child of children) {
    const path = join(directory, child.name);
    if (child.isSymbolicLink()) {
      throw new Error(`Refusing to archive symbolic link: ${path}`);
    }
    if (child.isDirectory()) {
      await collectEntries(path, base, output);
    } else if (child.isFile()) {
      const fileStat = await lstat(path);
      if (fileStat.size > 0xffffffff) {
        throw new Error(`ZIP64 is not supported; file is too large: ${path}`);
      }
      output.push({
        name: normalizedArchivePath(relative(base, path)),
        data: await readFile(path),
      });
    }
  }
  return output;
}

function makeZip(entries) {
  if (entries.length > 0xffff) {
    throw new Error("ZIP64 is not supported; archive has too many files");
  }

  const localParts = [];
  const centralParts = [];
  let localOffset = 0;
  const seen = new Set();

  for (const entry of [...entries].sort((left, right) => left.name.localeCompare(right.name, "en"))) {
    const name = normalizedArchivePath(entry.name);
    if (seen.has(name)) {
      throw new Error(`Duplicate archive path: ${name}`);
    }
    seen.add(name);

    const nameBytes = Buffer.from(name, "utf8");
    const raw = Buffer.from(entry.data);
    const deflated = deflateRawSync(raw, {level: 9});
    const useDeflate = deflated.length < raw.length;
    const payload = useDeflate ? deflated : raw;
    const method = useDeflate ? 8 : 0;
    const checksum = crc32(raw);

    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(20, 4);
    localHeader.writeUInt16LE(UTF8_FLAG, 6);
    localHeader.writeUInt16LE(method, 8);
    localHeader.writeUInt16LE(0, 10);
    localHeader.writeUInt16LE(FIXED_DOS_DATE, 12);
    localHeader.writeUInt32LE(checksum, 14);
    localHeader.writeUInt32LE(payload.length, 18);
    localHeader.writeUInt32LE(raw.length, 22);
    localHeader.writeUInt16LE(nameBytes.length, 26);
    localHeader.writeUInt16LE(0, 28);
    localParts.push(localHeader, nameBytes, payload);

    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(0x02014b50, 0);
    centralHeader.writeUInt16LE((3 << 8) | 20, 4);
    centralHeader.writeUInt16LE(20, 6);
    centralHeader.writeUInt16LE(UTF8_FLAG, 8);
    centralHeader.writeUInt16LE(method, 10);
    centralHeader.writeUInt16LE(0, 12);
    centralHeader.writeUInt16LE(FIXED_DOS_DATE, 14);
    centralHeader.writeUInt32LE(checksum, 16);
    centralHeader.writeUInt32LE(payload.length, 20);
    centralHeader.writeUInt32LE(raw.length, 24);
    centralHeader.writeUInt16LE(nameBytes.length, 28);
    centralHeader.writeUInt16LE(0, 30);
    centralHeader.writeUInt16LE(0, 32);
    centralHeader.writeUInt16LE(0, 34);
    centralHeader.writeUInt16LE(0, 36);
    centralHeader.writeUInt32LE((0o100644 << 16) >>> 0, 38);
    centralHeader.writeUInt32LE(localOffset, 42);
    centralParts.push(centralHeader, nameBytes);

    localOffset += localHeader.length + nameBytes.length + payload.length;
    if (localOffset > 0xffffffff) {
      throw new Error("ZIP64 is not supported; archive is too large");
    }
  }

  const centralDirectory = Buffer.concat(centralParts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralDirectory.length, 12);
  end.writeUInt32LE(localOffset, 16);
  end.writeUInt16LE(0, 20);
  return Buffer.concat([...localParts, centralDirectory, end]);
}

async function writeArchive(sourceDirectory, destination) {
  const entries = await collectEntries(sourceDirectory);
  const zip = makeZip(entries);
  await writeFile(destination, zip);
  return destination;
}

async function sha256(path) {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

export async function packageBuilds({root = PROJECT_ROOT, quiet = false} = {}) {
  const projectRoot = resolve(root);
  const artifacts = resolve(projectRoot, "artifacts");
  if (dirname(artifacts) !== projectRoot || basename(artifacts) !== "artifacts") {
    throw new Error(`Refusing to modify unexpected artifacts directory: ${artifacts}`);
  }

  const buildResult = await build({root: projectRoot, quiet: true});
  await check({root: projectRoot, quiet: true});
  await rm(artifacts, {recursive: true, force: true});
  await mkdir(artifacts, {recursive: true});

  const outputs = [];
  const archiveTargets = [
    ["chromium", `nightglass-${buildResult.version}-chromium.zip`],
    ["firefox", `nightglass-${buildResult.version}-firefox.xpi`],
    ["safari-web-extension", `nightglass-${buildResult.version}-safari-web-extension.zip`],
  ];
  for (const [target, filename] of archiveTargets) {
    outputs.push(await writeArchive(join(buildResult.dist, target), join(artifacts, filename)));
  }

  const userscriptCandidates = [
    join(buildResult.dist, "nightglass.user.js"),
    ...buildResult.userscripts,
  ];
  const userscriptNames = new Set();
  for (const userscript of userscriptCandidates) {
    try {
      const fileStat = await lstat(userscript);
      if (!fileStat.isFile()) {
        continue;
      }
    } catch {
      continue;
    }
    const originalName = basename(userscript);
    if (userscriptNames.has(originalName)) {
      continue;
    }
    userscriptNames.add(originalName);
    const artifactName = originalName === "nightglass.user.js"
      ? `nightglass-${buildResult.version}.user.js`
      : originalName;
    const destination = join(artifacts, artifactName);
    await cp(userscript, destination);
    outputs.push(destination);
  }

  const installArtifact = join(artifacts, "INSTALL.md");
  await cp(join(buildResult.dist, "INSTALL.md"), installArtifact);
  outputs.push(installArtifact);

  const hashes = [];
  for (const output of [...outputs].sort((left, right) => basename(left).localeCompare(basename(right), "en"))) {
    hashes.push(`${await sha256(output)}  ${basename(output)}`);
  }
  const checksumFile = join(artifacts, "SHA256SUMS");
  await writeFile(checksumFile, `${hashes.join("\n")}\n`, "utf8");

  if (!quiet) {
    console.log(`Packaged ${outputs.length} Nightglass artifacts in ${artifacts}`);
  }
  return {artifacts, files: [...outputs, checksumFile], version: buildResult.version};
}

function isMainModule() {
  return process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
}

if (isMainModule()) {
  await packageBuilds();
}
