// apps/wolfensvelte/cook/bmp.ts — Windows BMP reader for the asset cooker.
//
// The Wolfensvelte HUD, face and menu art are 8-bit indexed, uncompressed,
// bottom-up BITMAPINFOHEADER files (palette as BGRA quads after the header).
// 24-bit and 32-bit files decode too, so a swapped source asset still cooks.

import type { Rgba } from "./png.ts";

export function decodeBmp(bytes: Uint8Array, label = "bmp"): Rgba {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes[0] !== 0x42 || bytes[1] !== 0x4d) throw new Error(`${label}: not a BMP`);
  const pixelOffset = v.getUint32(10, true);
  const headerSize = v.getUint32(14, true);
  const width = v.getInt32(18, true);
  const rawHeight = v.getInt32(22, true);
  const bpp = v.getUint16(28, true);
  const compression = v.getUint32(30, true);
  if (compression !== 0) throw new Error(`${label}: compressed BMP (${compression}) not supported`);
  const height = Math.abs(rawHeight);
  const bottomUp = rawHeight > 0;
  let colours = v.getUint32(46, true);
  if (colours === 0 && bpp <= 8) colours = 1 << bpp;
  const paletteOffset = 14 + headerSize;
  const stride = ((width * bpp + 31) >> 5) << 2;
  const rgba = new Uint8Array(width * height * 4);
  for (let row = 0; row < height; row++) {
    const y = bottomUp ? height - 1 - row : row;
    const line = pixelOffset + row * stride;
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * 4;
      if (bpp === 8) {
        const idx = bytes[line + x];
        const p = paletteOffset + idx * 4;
        rgba[o] = bytes[p + 2];
        rgba[o + 1] = bytes[p + 1];
        rgba[o + 2] = bytes[p];
        rgba[o + 3] = 255;
      } else if (bpp === 4) {
        const byte = bytes[line + (x >> 1)];
        const idx = x & 1 ? byte & 0x0f : byte >> 4;
        const p = paletteOffset + idx * 4;
        rgba[o] = bytes[p + 2];
        rgba[o + 1] = bytes[p + 1];
        rgba[o + 2] = bytes[p];
        rgba[o + 3] = 255;
      } else if (bpp === 24) {
        const p = line + x * 3;
        rgba[o] = bytes[p + 2];
        rgba[o + 1] = bytes[p + 1];
        rgba[o + 2] = bytes[p];
        rgba[o + 3] = 255;
      } else if (bpp === 32) {
        const p = line + x * 4;
        rgba[o] = bytes[p + 2];
        rgba[o + 1] = bytes[p + 1];
        rgba[o + 2] = bytes[p];
        rgba[o + 3] = 255;
      } else {
        throw new Error(`${label}: ${bpp}-bit BMP not supported`);
      }
    }
  }
  return { width, height, rgba };
}
