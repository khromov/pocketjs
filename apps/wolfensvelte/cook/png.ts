// apps/wolfensvelte/cook/png.ts — PNG codec for the asset cooker.
//
// framework/compiler/pak.ts decodePng reads only 8-bit gray/RGB/RGBA, which is
// all the build pipeline needs. The Wolfensvelte source art is mostly palette
// PNGs at 1/4/8 bits with tRNS transparency, so the cooker carries a fuller
// decoder (colour types 0/2/3/4/6, bit depths 1-16, filters 0-4, non-interlaced)
// and the same encoder subset the gallery cooker validated against decodePng
// (colour type 6, bit depth 8, filter 0, one zlib IDAT).

import { deflateSync, inflateSync } from "node:zlib";

export interface Rgba {
  readonly width: number;
  readonly height: number;
  /** Straight (non-premultiplied) RGBA, row-major, 4 bytes per pixel. */
  readonly rgba: Uint8Array;
}

const SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];

function readU32(b: Uint8Array, off: number): number {
  return ((b[off] << 24) | (b[off + 1] << 16) | (b[off + 2] << 8) | b[off + 3]) >>> 0;
}

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}

export function decodePng(bytes: Uint8Array, label = "png"): Rgba {
  for (let i = 0; i < 8; i++) {
    if (bytes[i] !== SIGNATURE[i]) throw new Error(`${label}: not a PNG`);
  }
  let width = 0;
  let height = 0;
  let depth = 0;
  let colorType = 0;
  let interlace = 0;
  let palette: Uint8Array | null = null;
  let trns: Uint8Array | null = null;
  const idat: Uint8Array[] = [];
  for (let off = 8; off + 8 <= bytes.length; ) {
    const len = readU32(bytes, off);
    const type = String.fromCharCode(bytes[off + 4], bytes[off + 5], bytes[off + 6], bytes[off + 7]);
    const data = bytes.subarray(off + 8, off + 8 + len);
    if (type === "IHDR") {
      width = readU32(data, 0);
      height = readU32(data, 4);
      depth = data[8];
      colorType = data[9];
      interlace = data[12];
    } else if (type === "PLTE") {
      palette = data;
    } else if (type === "tRNS") {
      trns = data;
    } else if (type === "IDAT") {
      idat.push(data);
    } else if (type === "IEND") {
      break;
    }
    off += 12 + len;
  }
  if (width === 0 || height === 0) throw new Error(`${label}: missing IHDR`);
  if (interlace !== 0) throw new Error(`${label}: interlaced PNGs are not supported`);
  const channels =
    colorType === 0 ? 1 : colorType === 2 ? 3 : colorType === 3 ? 1 : colorType === 4 ? 2 : colorType === 6 ? 4 : 0;
  if (channels === 0) throw new Error(`${label}: unsupported colour type ${colorType}`);
  if (colorType === 3 && !palette) throw new Error(`${label}: palette PNG without PLTE`);

  const total = idat.reduce((n, c) => n + c.length, 0);
  const zipped = new Uint8Array(total);
  let z = 0;
  for (const c of idat) {
    zipped.set(c, z);
    z += c.length;
  }
  const raw = new Uint8Array(inflateSync(zipped));

  const bitsPerPixel = channels * depth;
  const stride = Math.ceil((width * bitsPerPixel) / 8);
  const bpp = Math.max(1, Math.ceil(bitsPerPixel / 8)); // filter byte distance
  const unfiltered = new Uint8Array(stride * height);
  let prev = new Uint8Array(stride);
  let src = 0;
  for (let y = 0; y < height; y++) {
    const filter = raw[src++];
    const row = unfiltered.subarray(y * stride, (y + 1) * stride);
    for (let i = 0; i < stride; i++) {
      const x = raw[src + i];
      const a = i >= bpp ? row[i - bpp] : 0;
      const b = prev[i];
      const c = i >= bpp ? prev[i - bpp] : 0;
      let v: number;
      switch (filter) {
        case 0: v = x; break;
        case 1: v = x + a; break;
        case 2: v = x + b; break;
        case 3: v = x + ((a + b) >> 1); break;
        case 4: v = x + paeth(a, b, c); break;
        default: throw new Error(`${label}: bad filter ${filter} on row ${y}`);
      }
      row[i] = v & 0xff;
    }
    src += stride;
    prev = row;
  }

  // Sample reader for sub-byte and 16-bit depths (16-bit keeps the high byte).
  const maxv = (1 << depth) - 1;
  const sample = (row: Uint8Array, index: number): number => {
    if (depth === 8) return row[index];
    if (depth === 16) return row[index * 2];
    const bit = index * depth;
    const byte = row[bit >> 3];
    const shift = 8 - depth - (bit & 7);
    return (byte >> shift) & maxv;
  };
  const scale = (v: number): number => (depth === 8 || depth === 16 ? v : Math.round((v * 255) / maxv));

  const rgba = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    const row = unfiltered.subarray(y * stride, (y + 1) * stride);
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * 4;
      if (colorType === 3) {
        const idx = sample(row, x);
        rgba[o] = palette![idx * 3];
        rgba[o + 1] = palette![idx * 3 + 1];
        rgba[o + 2] = palette![idx * 3 + 2];
        rgba[o + 3] = trns && idx < trns.length ? trns[idx] : 255;
      } else if (colorType === 0) {
        const g = sample(row, x);
        const v = scale(g);
        rgba[o] = rgba[o + 1] = rgba[o + 2] = v;
        rgba[o + 3] = trns && trns.length >= 2 && g === ((trns[0] << 8) | trns[1]) ? 0 : 255;
      } else if (colorType === 4) {
        rgba[o] = rgba[o + 1] = rgba[o + 2] = scale(sample(row, x * 2));
        rgba[o + 3] = scale(sample(row, x * 2 + 1));
      } else if (colorType === 2) {
        const r = sample(row, x * 3);
        const g = sample(row, x * 3 + 1);
        const b = sample(row, x * 3 + 2);
        rgba[o] = scale(r);
        rgba[o + 1] = scale(g);
        rgba[o + 2] = scale(b);
        const keyed =
          trns && trns.length >= 6 &&
          r === ((trns[0] << 8) | trns[1]) && g === ((trns[2] << 8) | trns[3]) && b === ((trns[4] << 8) | trns[5]);
        rgba[o + 3] = keyed ? 0 : 255;
      } else {
        rgba[o] = scale(sample(row, x * 4));
        rgba[o + 1] = scale(sample(row, x * 4 + 1));
        rgba[o + 2] = scale(sample(row, x * 4 + 2));
        rgba[o + 3] = scale(sample(row, x * 4 + 3));
      }
    }
  }
  return { width, height, rgba };
}

// ---- encoder (matches framework/compiler/pak.ts decodePng: type 6, depth 8, filter 0) ----

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 255] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function u32be(n: number): Uint8Array {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, n >>> 0, false);
  return b;
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const tb = new TextEncoder().encode(type);
  const body = new Uint8Array(tb.length + data.length);
  body.set(tb, 0);
  body.set(data, tb.length);
  const out = new Uint8Array(4 + body.length + 4);
  out.set(u32be(data.length), 0);
  out.set(body, 4);
  out.set(u32be(crc32(body)), 4 + body.length);
  return out;
}

export function encodePng(img: Rgba): Uint8Array {
  const { width: w, height: h, rgba } = img;
  const stride = w * 4;
  const raw = new Uint8Array((stride + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (stride + 1)] = 0;
    raw.set(rgba.subarray(y * stride, y * stride + stride), y * (stride + 1) + 1);
  }
  const ihdr = new Uint8Array(13);
  const dv = new DataView(ihdr.buffer);
  dv.setUint32(0, w, false);
  dv.setUint32(4, h, false);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const idat = new Uint8Array(deflateSync(raw, { level: 9 }));
  const parts = [
    new Uint8Array(SIGNATURE),
    chunk("IHDR", ihdr),
    chunk("IDAT", idat),
    chunk("IEND", new Uint8Array(0)),
  ];
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}
