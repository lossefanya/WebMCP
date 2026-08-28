#!/usr/bin/env node
/**
 * Generates the toolbar icons.
 *
 * Kept as a generator rather than four committed PNGs so the mark can be
 * adjusted without a design tool, and so nobody has to wonder what is inside
 * an opaque binary. Chrome does not accept SVG for extension icons, so these
 * have to be rasterised.
 *
 *   node scripts/make-icons.mjs
 */
import { deflateSync } from "node:zlib";
import { mkdirSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const outDir = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "packages/extension/public/icons",
);
mkdirSync(outDir, { recursive: true });

const BG = [49, 46, 129]; // indigo — dark enough to read on a light toolbar
const FG = [244, 244, 245];
const SUPERSAMPLE = 4;

/** A terminal prompt: a chevron and a caret bar. Legible down to 16px. */
function coverage(x, y, size) {
  const s = size;
  const stroke = s * 0.11;

  // Chevron ">" occupying the left two thirds.
  const chevronTop = { x: s * 0.28, y: s * 0.3 };
  const chevronMid = { x: s * 0.5, y: s * 0.5 };
  const chevronBot = { x: s * 0.28, y: s * 0.7 };
  const onChevron =
    distanceToSegment(x, y, chevronTop, chevronMid) < stroke / 2 ||
    distanceToSegment(x, y, chevronMid, chevronBot) < stroke / 2;

  // The bar after it, like a cursor waiting for input.
  const barA = { x: s * 0.58, y: s * 0.7 };
  const barB = { x: s * 0.76, y: s * 0.7 };
  const onBar = distanceToSegment(x, y, barA, barB) < stroke / 2;

  return onChevron || onBar;
}

function distanceToSegment(px, py, a, b) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lengthSquared = dx * dx + dy * dy;
  const t =
    lengthSquared === 0 ? 0 : clamp(((px - a.x) * dx + (py - a.y) * dy) / lengthSquared, 0, 1);
  return Math.hypot(px - (a.x + t * dx), py - (a.y + t * dy));
}

const clamp = (value, low, high) => Math.min(high, Math.max(low, value));

/**
 * Rounded square, so the mark reads as an app tile rather than a blob.
 *
 * Clamping the point into the inner rect and measuring from there covers all
 * three cases at once: inside the inner rect the distance is zero, in an edge
 * band it is the perpendicular distance, and near a corner it is the true
 * radial distance.
 */
function insideBackground(x, y, size) {
  const radius = size * 0.22;
  const inset = size * 0.02;
  const low = inset;
  const high = size - inset;
  if (x < low || x > high || y < low || y > high) return false;
  const cx = clamp(x, low + radius, high - radius);
  const cy = clamp(y, low + radius, high - radius);
  return Math.hypot(x - cx, y - cy) <= radius;
}

function render(size) {
  const rows = [];
  for (let py = 0; py < size; py++) {
    const row = Buffer.alloc(1 + size * 4);
    row[0] = 0; // PNG filter: none
    for (let px = 0; px < size; px++) {
      let bg = 0;
      let fg = 0;
      for (let sy = 0; sy < SUPERSAMPLE; sy++) {
        for (let sx = 0; sx < SUPERSAMPLE; sx++) {
          const x = px + (sx + 0.5) / SUPERSAMPLE;
          const y = py + (sy + 0.5) / SUPERSAMPLE;
          if (!insideBackground(x, y, size)) continue;
          bg++;
          if (coverage(x, y, size)) fg++;
        }
      }
      const samples = SUPERSAMPLE * SUPERSAMPLE;
      const alpha = bg / samples;
      const glyph = bg === 0 ? 0 : fg / bg;
      const at = 1 + px * 4;
      for (let channel = 0; channel < 3; channel++) {
        row[at + channel] = Math.round(BG[channel] * (1 - glyph) + FG[channel] * glyph);
      }
      row[at + 3] = Math.round(alpha * 255);
    }
    rows.push(row);
  }
  return png(size, size, Buffer.concat(rows));
}

/* Minimal PNG writer: IHDR + IDAT + IEND, 8-bit RGBA. */
function png(width, height, raw) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type: RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

function chunk(type, data) {
  const header = Buffer.alloc(4);
  header.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([header, body, crc]);
}

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

for (const size of [16, 32, 48, 128]) {
  const file = path.join(outDir, `icon-${size}.png`);
  writeFileSync(file, render(size));
  process.stdout.write(`${path.relative(process.cwd(), file)}\n`);
}
