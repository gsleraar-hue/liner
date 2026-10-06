'use strict';

// Draws the Liner icon (a cassette) and writes build/icon.ico,
// build/icon.png and build/icon.icns. All by hand: a PNG encoder on top of zlib
// with an ICO and an ICNS container around it, so no extra packages are needed.

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const SIZES = [16, 24, 32, 48, 64, 128, 256];
const SUB = 4; // 4x4 subsamples per pixel for smooth edges

// ---------------------------------------------------------------- shapes
// Everything in unit coordinates (0..1), signed distances: <= 0 is inside.

function sdRoundedBox(px, py, hw, hh, r) {
  const qx = Math.abs(px - 0.5) - (hw - r);
  const qy = Math.abs(py - 0.5) - (hh - r);
  return (
    Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r
  );
}

function sdRing(px, py, cx, cy, radius, thickness) {
  return Math.abs(Math.hypot(px - cx, py - cy) - radius) - thickness / 2;
}

// A capsule whose thickness tapers along its length, so the cord narrows
// instead of turning into an even handle.
function sdTaperedCapsule(px, py, ax, ay, bx, by, r0, r1) {
  const pax = px - ax;
  const pay = py - ay;
  const bax = bx - ax;
  const bay = by - ay;
  const len2 = bax * bax + bay * bay;
  let h = len2 === 0 ? 0 : (pax * bax + pay * bay) / len2;
  h = h < 0 ? 0 : h > 1 ? 1 : h;
  return Math.hypot(pax - bax * h, pay - bay * h) - (r0 + (r1 - r0) * h);
}

function mix(a, b, t) {
  const k = t < 0 ? 0 : t > 1 ? 1 : t;
  return [
    Math.round(a[0] + (b[0] - a[0]) * k),
    Math.round(a[1] + (b[1] - a[1]) * k),
    Math.round(a[2] + (b[2] - a[2]) * k),
  ];
}

const BG_TOP = [52, 48, 43];
const BG_BOTTOM = [28, 26, 23];
const PAPER = [243, 239, 230];
const ACCENT = [196, 82, 52];

// ---------------------------------------------------------------- drawing
// A cassette: a light label on a dark tile, with two red reels.

function render(size) {
  const rgba = Buffer.alloc(size * size * 4);
  const small = size <= 24;
  const stroke = Math.max(small ? 0.1 : 0.045, 2 / size);
  const reelR = small ? 0.1 : 0.075;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let ar = 0, ag = 0, ab = 0, aa = 0;
      for (let sy = 0; sy < SUB; sy++) {
        for (let sx = 0; sx < SUB; sx++) {
          const px = (x + (sx + 0.5) / SUB) / size;
          const py = (y + (sy + 0.5) / SUB) / size;
          if (sdRoundedBox(px, py, 0.5, 0.5, 0.215) > 0) continue;
          let c = mix(BG_TOP, BG_BOTTOM, py);
          const body = sdRoundedBox(px, py + 0.0, 0.36, 0.25, 0.06);
          if (body <= 0) c = PAPER;
          const reel = Math.min(sdRing(px, py, 0.37, 0.5, reelR, stroke), sdRing(px, py, 0.63, 0.5, reelR, stroke));
          if (body <= 0 && reel <= 0) c = ACCENT;
          if (!small && body <= 0 && Math.abs(py - 0.335) < 0.018 && Math.abs(px - 0.5) < 0.24) c = mix(PAPER, BG_BOTTOM, 0.35);
          ar += c[0]; ag += c[1]; ab += c[2]; aa += 1;
        }
      }
      const total = SUB * SUB;
      const i = (y * size + x) * 4;
      if (aa === 0) continue;
      rgba[i] = Math.round(ar / aa);
      rgba[i + 1] = Math.round(ag / aa);
      rgba[i + 2] = Math.round(ab / aa);
      rgba[i + 3] = Math.round((aa / total) * 255);
    }
  }
  return rgba;
}

// ---------------------------------------------------------------- png

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

function encodePng(size, rgba) {
  const stride = size * 4;
  const raw = Buffer.alloc((stride + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (stride + 1)] = 0; // filter type 0
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ---------------------------------------------------------------- ico (Windows)

function buildIco(images) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2); // type 1 = icon
  header.writeUInt16LE(images.length, 4);

  const entries = Buffer.alloc(16 * images.length);
  let offset = 6 + 16 * images.length;

  images.forEach((img, i) => {
    const e = 16 * i;
    entries[e] = img.size >= 256 ? 0 : img.size; // 0 means 256
    entries[e + 1] = img.size >= 256 ? 0 : img.size;
    entries.writeUInt16LE(1, e + 4); // color planes
    entries.writeUInt16LE(32, e + 6); // bits per pixel
    entries.writeUInt32LE(img.png.length, e + 8);
    entries.writeUInt32LE(offset, e + 12);
    offset += img.png.length;
  });

  return Buffer.concat([header, entries, ...images.map((i) => i.png)]);
}

// ---------------------------------------------------------------- icns (macOS)
//
// An .icns is a box of images just like an .ico, only laid out differently:
// four letters as the type, then the length, then a PNG.

const ICNS_TYPES = [
  ['icp4', 16],
  ['icp5', 32],
  ['ic11', 32], // 16 on a double-density screen
  ['ic12', 64], // 32 likewise
  ['ic07', 128],
  ['ic13', 256], // 128 likewise
  ['ic08', 256],
  ['ic14', 512], // 256 likewise
  ['ic09', 512],
  ['ic10', 1024], // 512 likewise
];

function buildIcns(pngOf) {
  const parts = [];
  for (const [kind, size] of ICNS_TYPES) {
    const png = pngOf(size);
    const head = Buffer.alloc(8);
    head.write(kind, 0, 4, 'ascii');
    head.writeUInt32BE(png.length + 8, 4);
    parts.push(head, png);
  }
  const body = Buffer.concat(parts);
  const head = Buffer.alloc(8);
  head.write('icns', 0, 4, 'ascii');
  head.writeUInt32BE(body.length + 8, 4);
  return Buffer.concat([head, body]);
}

// ---------------------------------------------------------------- main

const outDir = path.join(__dirname, '..', 'build');
fs.mkdirSync(outDir, { recursive: true });

const drawn = new Map();
const pngOf = (size) => {
  if (!drawn.has(size)) drawn.set(size, encodePng(size, render(size)));
  return drawn.get(size);
};

const ico = buildIco(SIZES.map((size) => ({ size, png: pngOf(size) })));
fs.writeFileSync(path.join(outDir, 'icon.ico'), ico);

// electron-builder wants at least 512x512 for macOS.
fs.writeFileSync(path.join(outDir, 'icon.png'), pngOf(512));

// Every size is drawn here, so this one takes a moment.
fs.writeFileSync(path.join(outDir, 'icon.icns'), buildIcns(pngOf));

console.log(`build/icon.ico written (${SIZES.join(', ')} px, ${ico.length} bytes)`);
console.log('build/icon.png written (512 px) and build/icon.icns written');
