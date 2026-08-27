import {mkdir, rename, writeFile} from "node:fs/promises";
import {dirname, join, resolve} from "node:path";
import {fileURLToPath} from "node:url";
import {deflateSync} from "node:zlib";

export const ICON_SIZES = Object.freeze([16, 32, 48, 64, 96, 128, 256, 512]);

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(SCRIPT_DIR, "..");
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
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

function chunk(type, data = Buffer.alloc(0)) {
  const typeBytes = Buffer.from(type, "ascii");
  const output = Buffer.allocUnsafe(12 + data.length);
  output.writeUInt32BE(data.length, 0);
  typeBytes.copy(output, 4);
  data.copy(output, 8);
  output.writeUInt32BE(crc32(Buffer.concat([typeBytes, data])), 8 + data.length);
  return output;
}

function encodePng(size, pixels) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8;
  header[9] = 6;
  header[10] = 0;
  header[11] = 0;
  header[12] = 0;

  const stride = size * 4;
  const scanlines = Buffer.allocUnsafe((stride + 1) * size);
  for (let y = 0; y < size; y += 1) {
    const row = y * (stride + 1);
    scanlines[row] = 0;
    pixels.copy(scanlines, row + 1, y * stride, (y + 1) * stride);
  }

  return Buffer.concat([
    PNG_SIGNATURE,
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(scanlines, {level: 9})),
    chunk("IEND"),
  ]);
}

function clamp(value, low = 0, high = 1) {
  return Math.min(high, Math.max(low, value));
}

function mix(start, end, amount) {
  return start + (end - start) * clamp(amount);
}

function composite(base, overlay) {
  const alpha = overlay[3] + base[3] * (1 - overlay[3]);
  if (alpha <= 0) {
    return [0, 0, 0, 0];
  }
  return [
    (overlay[0] * overlay[3] + base[0] * base[3] * (1 - overlay[3])) / alpha,
    (overlay[1] * overlay[3] + base[1] * base[3] * (1 - overlay[3])) / alpha,
    (overlay[2] * overlay[3] + base[2] * base[3] * (1 - overlay[3])) / alpha,
    alpha,
  ];
}

function roundedSquareDistance(x, y) {
  const radius = 0.16;
  const halfSize = 0.47;
  const qx = Math.abs(x - 0.5) - (halfSize - radius);
  const qy = Math.abs(y - 0.5) - (halfSize - radius);
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - radius;
}

function segmentDistance(x, y, startX, startY, endX, endY) {
  const dx = endX - startX;
  const dy = endY - startY;
  const amount = clamp(((x - startX) * dx + (y - startY) * dy) / (dx * dx + dy * dy));
  return Math.hypot(x - (startX + dx * amount), y - (startY + dy * amount));
}

function sampleIcon(x, y) {
  const edge = roundedSquareDistance(x, y);
  if (edge > 0) {
    return [0, 0, 0, 0];
  }

  const diagonal = clamp((x * 0.36 + y * 0.64 - 0.06) / 0.88);
  const vignette = clamp(Math.hypot(x - 0.5, y - 0.46) / 0.67);
  let color = [
    mix(16, 12, diagonal) / 255,
    mix(28, 41, diagonal) / 255,
    mix(52, 69, diagonal) / 255,
    1,
  ];
  color = composite(color, [2 / 255, 7 / 255, 20 / 255, vignette * 0.22]);

  if (edge > -0.028) {
    color = composite(color, [73 / 255, 219 / 255, 214 / 255, 0.64]);
  }

  const stars = [
    [0.2, 0.22, 0.012],
    [0.76, 0.23, 0.016],
    [0.19, 0.69, 0.009],
  ];
  for (const [starX, starY, radius] of stars) {
    const dx = Math.abs(x - starX);
    const dy = Math.abs(y - starY);
    if (Math.min(Math.max(dx, dy) * 0.55, dx + dy) < radius) {
      color = composite(color, [0.76, 0.95, 1, 0.9]);
    }
  }

  const handleDistance = segmentDistance(x, y, 0.59, 0.59, 0.77, 0.78);
  if (handleDistance < 0.082) {
    color = composite(color, [1 / 255, 9 / 255, 21 / 255, 0.56]);
  }
  if (handleDistance < 0.058) {
    const handleShade = clamp((x + y - 1.08) / 0.5);
    color = composite(color, [
      mix(74, 31, handleShade) / 255,
      mix(229, 158, handleShade) / 255,
      mix(222, 211, handleShade) / 255,
      1,
    ]);
  }
  if (segmentDistance(x, y, 0.61, 0.6, 0.755, 0.75) < 0.012) {
    color = composite(color, [0.8, 1, 1, 0.52]);
  }

  const lensX = x - 0.43;
  const lensY = y - 0.42;
  const lensRadius = Math.hypot(lensX, lensY);
  if (lensRadius < 0.3) {
    color = composite(color, [25 / 255, 75 / 255, 108 / 255, 0.36]);
  }
  if (lensRadius > 0.252 && lensRadius < 0.305) {
    const ringShade = clamp((x + y - 0.42) / 0.73);
    color = composite(color, [
      mix(112, 34, ringShade) / 255,
      mix(245, 186, ringShade) / 255,
      mix(236, 218, ringShade) / 255,
      1,
    ]);
  }
  if (lensRadius > 0.225 && lensRadius < 0.246 && x + y < 0.73) {
    color = composite(color, [0.83, 1, 1, 0.62]);
  }

  const moonDistance = Math.hypot(x - 0.398, y - 0.414);
  const cutoutDistance = Math.hypot(x - 0.473, y - 0.372);
  if (moonDistance < 0.172 && cutoutDistance > 0.158) {
    const glow = clamp((0.172 - moonDistance) / 0.172);
    color = composite(color, [
      mix(202, 244, glow) / 255,
      mix(227, 250, glow) / 255,
      1,
      1,
    ]);
  }

  const glintX = Math.abs(x - 0.505);
  const glintY = Math.abs(y - 0.331);
  if (Math.min(Math.max(glintX, glintY) * 0.48, glintX + glintY) < 0.016) {
    color = composite(color, [0.92, 1, 1, 0.95]);
  }

  return color;
}

function renderIcon(size) {
  const pixels = Buffer.alloc(size * size * 4);
  const samples = size <= 32 ? 5 : size <= 128 ? 4 : 3;
  const sampleCount = samples * samples;

  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const total = [0, 0, 0, 0];
      for (let sy = 0; sy < samples; sy += 1) {
        for (let sx = 0; sx < samples; sx += 1) {
          const sample = sampleIcon(
            (x + (sx + 0.5) / samples) / size,
            (y + (sy + 0.5) / samples) / size,
          );
          for (let channel = 0; channel < 4; channel += 1) {
            total[channel] += sample[channel];
          }
        }
      }

      const offset = (y * size + x) * 4;
      for (let channel = 0; channel < 4; channel += 1) {
        pixels[offset + channel] = Math.round(clamp(total[channel] / sampleCount) * 255);
      }
    }
  }

  return encodePng(size, pixels);
}

export async function generateIcons({root = PROJECT_ROOT, quiet = false} = {}) {
  const iconDirectory = join(resolve(root), "assets", "icons");
  await mkdir(iconDirectory, {recursive: true});

  const generated = [];
  for (const size of ICON_SIZES) {
    const destination = join(iconDirectory, `nightglass-${size}.png`);
    const temporary = `${destination}.tmp-${process.pid}`;
    await writeFile(temporary, renderIcon(size));
    await rename(temporary, destination);
    generated.push(destination);
  }

  if (!quiet) {
    console.log(`Generated ${generated.length} Nightglass icons in ${iconDirectory}`);
  }
  return generated;
}

function isMainModule() {
  return process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
}

if (isMainModule()) {
  await generateIcons();
}
