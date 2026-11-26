// Generates the app icons in public/ (blue tile, white envelope). Dependency-free: draws with
// 4x4 supersampling and writes PNGs with node:zlib. Run: node scripts/make-icons.ts
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { deflateSync } from "node:zlib";

const OUT = join(import.meta.dirname, "..", "public");
const BLUE = [37, 99, 235];
const WHITE = [255, 255, 255];

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (const b of bytes) c = CRC_TABLE[(c ^ b) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, "ascii");
  const body = Buffer.concat([head.subarray(4), Buffer.from(data)]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([head.subarray(0, 4), body, crc]);
}

function png(size: number, rgba: Uint8Array): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0; // filter: none
    Buffer.from(rgba.buffer, y * size * 4, size * 4).copy(raw, y * (size * 4 + 1) + 1);
  }
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw, { level: 9 })), chunk("IEND", new Uint8Array())]);
}

function segmentDistance(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax;
  const dy = by - ay;
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

/** Colour at a point in unit coordinates: null = transparent. `inset` shrinks the envelope (maskable safe zone). */
function sample(x: number, y: number, rounded: boolean, inset: number): number[] | null {
  if (rounded) {
    const r = 0.22;
    const cx = Math.min(Math.max(x, r), 1 - r);
    const cy = Math.min(Math.max(y, r), 1 - r);
    if (Math.hypot(x - cx, y - cy) > r) return null;
  }
  // Envelope in a box centred on the tile.
  const scale = 1 - inset;
  const u = (x - 0.5) / scale + 0.5;
  const v = (y - 0.5) / scale + 0.5;
  const [l, r2, t, b] = [0.2, 0.8, 0.3, 0.7];
  const stroke = 0.045;
  const edges = [
    segmentDistance(u, v, l, t, r2, t),
    segmentDistance(u, v, r2, t, r2, b),
    segmentDistance(u, v, r2, b, l, b),
    segmentDistance(u, v, l, b, l, t),
    segmentDistance(u, v, l, t, 0.5, 0.53),
    segmentDistance(u, v, r2, t, 0.5, 0.53),
  ];
  return Math.min(...edges) <= stroke / 2 ? WHITE : BLUE;
}

function render(size: number, rounded: boolean, inset: number): Buffer {
  const rgba = new Uint8Array(size * size * 4);
  const n = 4;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let [r, g, b, a] = [0, 0, 0, 0];
      for (let sy = 0; sy < n; sy++) {
        for (let sx = 0; sx < n; sx++) {
          const c = sample((x + (sx + 0.5) / n) / size, (y + (sy + 0.5) / n) / size, rounded, inset);
          if (!c) continue;
          r += c[0]!;
          g += c[1]!;
          b += c[2]!;
          a += 255;
        }
      }
      const hits = a / 255;
      const i = (y * size + x) * 4;
      if (hits) {
        rgba[i] = Math.round(r / hits);
        rgba[i + 1] = Math.round(g / hits);
        rgba[i + 2] = Math.round(b / hits);
      }
      rgba[i + 3] = Math.round(a / (n * n));
    }
  }
  return png(size, rgba);
}

writeFileSync(join(OUT, "icon-192.png"), render(192, true, 0));
writeFileSync(join(OUT, "icon-512.png"), render(512, true, 0));
// Maskable: full-bleed tile, envelope inside the 80% safe zone (platforms crop to their own shape).
writeFileSync(join(OUT, "icon-maskable-512.png"), render(512, false, 0.25));
// iOS rounds the corners itself and does not like transparency.
writeFileSync(join(OUT, "apple-touch-icon.png"), render(180, false, 0.1));
console.log("Icons written to public/");
