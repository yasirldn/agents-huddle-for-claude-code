// Draws the app and tray icons from code, so the repository holds no design files.
// Usage: node scripts/make-icons.mjs
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { crc32, deflateSync } from "node:zlib";

const out = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "assets");

const BODY = [0x5b, 0x8d, 0xef];
const SHADE = [0x4a, 0x76, 0xcf];
const INK = [0x17, 0x17, 0x1a];

// The figure on a 40 by 48 grid: two feet, a body, two eyes and a mouth.
const layers = [
  { x: 11, y: 36, w: 6, h: 8, r: 2.5, color: SHADE },
  { x: 23, y: 36, w: 6, h: 8, r: 2.5, color: SHADE },
  { x: 6, y: 8, w: 28, h: 30, r: 7, color: BODY },
  { x: 13.25, y: 20.5, w: 3.5, h: 5, r: 1.75, color: INK },
  { x: 23.25, y: 20.5, w: 3.5, h: 5, r: 1.75, color: INK },
  { x: 17.5, y: 29.25, w: 5, h: 1.5, r: 0.75, color: INK },
];

function inside(layer, x, y) {
  const dx = Math.max(Math.abs(x - (layer.x + layer.w / 2)) - (layer.w / 2 - layer.r), 0);
  const dy = Math.max(Math.abs(y - (layer.y + layer.h / 2)) - (layer.h / 2 - layer.r), 0);
  return dx * dx + dy * dy <= layer.r * layer.r;
}

function draw(size) {
  const pixels = Buffer.alloc(size * size * 4);
  const scale = size / 48;
  const offsetX = (size - 40 * scale) / 2;
  const samples = 4;
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let r = 0;
      let g = 0;
      let b = 0;
      let covered = 0;
      for (let sy = 0; sy < samples; sy++) {
        for (let sx = 0; sx < samples; sx++) {
          const x = (px + (sx + 0.5) / samples - offsetX) / scale;
          const y = (py + (sy + 0.5) / samples) / scale;
          const hit = layers.findLast((layer) => inside(layer, x, y));
          if (!hit) continue;
          r += hit.color[0];
          g += hit.color[1];
          b += hit.color[2];
          covered += 1;
        }
      }
      const at = (py * size + px) * 4;
      if (!covered) continue;
      pixels[at] = Math.round(r / covered);
      pixels[at + 1] = Math.round(g / covered);
      pixels[at + 2] = Math.round(b / covered);
      pixels[at + 3] = Math.round((covered / (samples * samples)) * 255);
    }
  }
  return pixels;
}

function png(size, pixels) {
  const stride = size * 4 + 1;
  const raw = Buffer.alloc(stride * size);
  for (let y = 0; y < size; y++) pixels.copy(raw, y * stride + 1, y * size * 4, (y + 1) * size * 4);
  const chunk = (type, data) => {
    const body = Buffer.concat([Buffer.from(type), data]);
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const check = Buffer.alloc(4);
    check.writeUInt32BE(crc32(body) >>> 0);
    return Buffer.concat([length, body, check]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8;
  header[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", header), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

function ico(images) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(images.length, 4);
  let offset = 6 + images.length * 16;
  const entries = images.map(({ size, data }) => {
    const entry = Buffer.alloc(16);
    entry[0] = size === 256 ? 0 : size;
    entry[1] = size === 256 ? 0 : size;
    entry.writeUInt16LE(1, 4);
    entry.writeUInt16LE(32, 6);
    entry.writeUInt32LE(data.length, 8);
    entry.writeUInt32LE(offset, 12);
    offset += data.length;
    return entry;
  });
  return Buffer.concat([header, ...entries, ...images.map((image) => image.data)]);
}

mkdirSync(out, { recursive: true });
const sizes = [16, 32, 48, 256];
const images = sizes.map((size) => ({ size, data: png(size, draw(size)) }));
writeFileSync(path.join(out, "tray.png"), images[1].data);
writeFileSync(path.join(out, "icon.png"), images[3].data);
writeFileSync(path.join(out, "icon.ico"), ico(images));
console.log(`wrote tray.png, icon.png and icon.ico to ${out}`);
