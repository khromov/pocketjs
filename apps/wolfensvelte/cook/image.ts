// apps/wolfensvelte/cook/image.ts — RGBA raster helpers for the asset cooker.

import type { Rgba } from "./png.ts";

export function blank(width: number, height: number, fill: readonly number[] = [0, 0, 0, 0]): Rgba {
  const rgba = new Uint8Array(width * height * 4);
  if (fill[0] || fill[1] || fill[2] || fill[3]) {
    for (let i = 0; i < width * height; i++) {
      rgba[i * 4] = fill[0];
      rgba[i * 4 + 1] = fill[1];
      rgba[i * 4 + 2] = fill[2];
      rgba[i * 4 + 3] = fill[3];
    }
  }
  return { width, height, rgba };
}

/** Copy `src[sx..sx+w, sy..sy+h]` into `dst` at (dx, dy); clips to both. */
export function blit(
  dst: Rgba,
  dx: number,
  dy: number,
  src: Rgba,
  sx = 0,
  sy = 0,
  w = src.width - sx,
  h = src.height - sy,
): void {
  for (let y = 0; y < h; y++) {
    const ty = dy + y;
    const fy = sy + y;
    if (ty < 0 || ty >= dst.height || fy < 0 || fy >= src.height) continue;
    for (let x = 0; x < w; x++) {
      const tx = dx + x;
      const fx = sx + x;
      if (tx < 0 || tx >= dst.width || fx < 0 || fx >= src.width) continue;
      const si = (fy * src.width + fx) * 4;
      const di = (ty * dst.width + tx) * 4;
      dst.rgba[di] = src.rgba[si];
      dst.rgba[di + 1] = src.rgba[si + 1];
      dst.rgba[di + 2] = src.rgba[si + 2];
      dst.rgba[di + 3] = src.rgba[si + 3];
    }
  }
}

export function crop(src: Rgba, sx: number, sy: number, w: number, h: number): Rgba {
  const out = blank(w, h);
  blit(out, 0, 0, src, sx, sy, w, h);
  return out;
}

/** Place `src` at the top-left of a `w` x `h` transparent canvas. */
export function pad(src: Rgba, w: number, h: number): Rgba {
  const out = blank(w, h);
  blit(out, 0, 0, src);
  return out;
}

/** Replace every pixel's alpha with 255, compositing over `bg`. */
export function flatten(src: Rgba, bg: readonly number[] = [0, 0, 0]): Rgba {
  const rgba = new Uint8Array(src.rgba);
  for (let i = 0; i < src.width * src.height; i++) {
    const a = rgba[i * 4 + 3] / 255;
    rgba[i * 4] = Math.round(rgba[i * 4] * a + bg[0] * (1 - a));
    rgba[i * 4 + 1] = Math.round(rgba[i * 4 + 1] * a + bg[1] * (1 - a));
    rgba[i * 4 + 2] = Math.round(rgba[i * 4 + 2] * a + bg[2] * (1 - a));
    rgba[i * 4 + 3] = 255;
  }
  return { width: src.width, height: src.height, rgba };
}

/** Alpha-weighted box downsample by an integer factor. */
export function downsample(src: Rgba, factor: number): Rgba {
  const w = Math.floor(src.width / factor);
  const h = Math.floor(src.height / factor);
  const out = blank(w, h);
  const n = factor * factor;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (let dy = 0; dy < factor; dy++) {
        for (let dx = 0; dx < factor; dx++) {
          const si = ((y * factor + dy) * src.width + x * factor + dx) * 4;
          const sa = src.rgba[si + 3];
          r += src.rgba[si] * sa;
          g += src.rgba[si + 1] * sa;
          b += src.rgba[si + 2] * sa;
          a += sa;
        }
      }
      const oi = (y * w + x) * 4;
      if (a > 0) {
        out.rgba[oi] = Math.round(r / a);
        out.rgba[oi + 1] = Math.round(g / a);
        out.rgba[oi + 2] = Math.round(b / a);
      }
      out.rgba[oi + 3] = Math.round(a / n);
    }
  }
  return out;
}

/** Nearest-neighbour scale up by an integer factor. */
export function upscale(src: Rgba, factor: number): Rgba {
  const out = blank(src.width * factor, src.height * factor);
  for (let y = 0; y < out.height; y++) {
    for (let x = 0; x < out.width; x++) {
      const si = ((y / factor | 0) * src.width + (x / factor | 0)) * 4;
      const oi = (y * out.width + x) * 4;
      out.rgba[oi] = src.rgba[si];
      out.rgba[oi + 1] = src.rgba[si + 1];
      out.rgba[oi + 2] = src.rgba[si + 2];
      out.rgba[oi + 3] = src.rgba[si + 3];
    }
  }
  return out;
}

export function fillRect(dst: Rgba, x0: number, y0: number, w: number, h: number, c: readonly number[]): void {
  for (let y = Math.max(0, y0); y < Math.min(dst.height, y0 + h); y++) {
    for (let x = Math.max(0, x0); x < Math.min(dst.width, x0 + w); x++) {
      const i = (y * dst.width + x) * 4;
      dst.rgba[i] = c[0];
      dst.rgba[i + 1] = c[1];
      dst.rgba[i + 2] = c[2];
      dst.rgba[i + 3] = c.length > 3 ? c[3] : 255;
    }
  }
}

/** Area-averaging resize to any size (box filter over source coverage). */
export function resize(src: Rgba, w: number, h: number): Rgba {
  const out = blank(w, h);
  const sx = src.width / w;
  const sy = src.height / h;
  for (let y = 0; y < h; y++) {
    const y0 = y * sy;
    const y1 = y0 + sy;
    for (let x = 0; x < w; x++) {
      const x0 = x * sx;
      const x1 = x0 + sx;
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      let cover = 0;
      for (let yy = Math.floor(y0); yy < Math.ceil(y1); yy++) {
        const wy = Math.min(y1, yy + 1) - Math.max(y0, yy);
        if (wy <= 0) continue;
        for (let xx = Math.floor(x0); xx < Math.ceil(x1); xx++) {
          const wx = Math.min(x1, xx + 1) - Math.max(x0, xx);
          if (wx <= 0) continue;
          const wgt = wx * wy;
          const i = (Math.min(src.height - 1, yy) * src.width + Math.min(src.width - 1, xx)) * 4;
          r += src.rgba[i] * wgt;
          g += src.rgba[i + 1] * wgt;
          b += src.rgba[i + 2] * wgt;
          a += src.rgba[i + 3] * wgt;
          cover += wgt;
        }
      }
      const oi = (y * w + x) * 4;
      if (cover > 0) {
        out.rgba[oi] = Math.round(r / cover);
        out.rgba[oi + 1] = Math.round(g / cover);
        out.rgba[oi + 2] = Math.round(b / cover);
        out.rgba[oi + 3] = Math.round(a / cover);
      }
    }
  }
  return out;
}
