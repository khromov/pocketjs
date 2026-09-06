// apps/svelte-shooter/gen-assets.ts — cook the shooter's textures.
//
//   bun apps/svelte-shooter/gen-assets.ts              # fetch the Kenney pack into .cache/
//   bun apps/svelte-shooter/gen-assets.ts --zip <path> # use a local copy of the zip
//
// Outputs (all committed; the build never runs this):
//   art/*.png             power-of-two RGBA textures (framework/compiler/pak.ts
//                         rejects anything else): ships, boss, shot, shield,
//                         life icon and background from Kenney's Space Shooter
//                         Redux; enemy bullets and the hit burst drawn here as
//                         radial glows, because the pack's round "laser" shapes
//                         are hollow outlines that vanish at bullet size
//   art/LICENSE-kenney.txt the pack's CC0 notice
//   images.json           per-texture pixel format hints for the pak
//
// Source: Kenney "Space Shooter Redux" (CC0 1.0), mirrored on OpenGameArt:
// https://opengameart.org/sites/default/files/SpaceShooterRedux.zip

import { createCanvas, loadImage, type Canvas } from "@napi-rs/canvas";
import { copyFileSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const ROOT = join(HERE, "..", "..");
const ART = join(HERE, "art");
const ZIP_URL = "https://opengameart.org/sites/default/files/SpaceShooterRedux.zip";

/** Supersample factor for the box-filtered downscale (tools/icon-raster.ts does the same). */
const SS = 4;

interface Sprite {
  out: string;
  src: string;
  /** Texture box, each side a power of two. */
  box: [number, number];
  /** Longest drawn side inside the box (aspect preserved, centered). */
  drawn: number;
  /** Pak pixel format: 2 = 4444 (half the memory; glows and beams), default 8888. */
  psm?: number;
  linear?: boolean;
}

const SPRITES: readonly Sprite[] = [
  { out: "ship.png", src: "PNG/playerShip1_blue.png", box: [32, 32], drawn: 30 },
  { out: "shot.png", src: "PNG/Lasers/laserBlue07.png", box: [8, 32], drawn: 30, psm: 2 },
  { out: "drone.png", src: "PNG/Enemies/enemyBlack1.png", box: [32, 32], drawn: 28 },
  { out: "gunship.png", src: "PNG/Enemies/enemyRed2.png", box: [32, 32], drawn: 32 },
  { out: "heavy.png", src: "PNG/Enemies/enemyGreen5.png", box: [64, 64], drawn: 48 },
  { out: "boss.png", src: "PNG/ufoRed.png", box: [64, 64], drawn: 64 },
  { out: "shield.png", src: "PNG/Effects/shield1.png", box: [64, 64], drawn: 52, psm: 2 },
  { out: "life.png", src: "PNG/UI/playerLife1_blue.png", box: [16, 16], drawn: 16 },
  { out: "bg.png", src: "Backgrounds/darkPurple.png", box: [256, 256], drawn: 256, linear: true },
];

interface Glow {
  out: string;
  size: number;
  diameter: number;
  rgb: [number, number, number];
}

const ORBS: readonly Glow[] = [
  { out: "bullet-red.png", size: 16, diameter: 12, rgb: [255, 80, 110] },
  { out: "bullet-blue.png", size: 16, diameter: 14, rgb: [90, 200, 255] },
  { out: "bullet-green.png", size: 8, diameter: 8, rgb: [150, 255, 120] },
];

// ---------------------------------------------------------------------------
// Source archive
// ---------------------------------------------------------------------------

async function resolvePack(argv: readonly string[]): Promise<string> {
  const cache = join(ROOT, ".cache");
  const dir = join(cache, "space-shooter-redux");
  if (existsSync(join(dir, "PNG", "playerShip1_blue.png"))) return dir;
  mkdirSync(cache, { recursive: true });
  const i = argv.indexOf("--zip");
  let zip = i >= 0 ? argv[i + 1] : join(cache, "SpaceShooterRedux.zip");
  if (i >= 0 && (!zip || !existsSync(zip))) throw new Error(`--zip must point at the pack (got ${zip})`);
  if (!existsSync(zip)) {
    console.log(`fetching ${ZIP_URL}`);
    const res = await fetch(ZIP_URL);
    if (!res.ok) throw new Error(`download failed: ${res.status} ${res.statusText}`);
    writeFileSync(zip, new Uint8Array(await res.arrayBuffer()));
  }
  if (existsSync(dir)) rmSync(dir, { recursive: true });
  const proc = Bun.spawnSync(["unzip", "-oq", zip, "-d", dir]);
  if (proc.exitCode !== 0) throw new Error(`unzip failed: ${proc.stderr.toString()}`);
  return dir;
}

// ---------------------------------------------------------------------------
// Rasterization
// ---------------------------------------------------------------------------

/** Box-filter `big` (SS x the target) down to `w` x `h`, averaging premultiplied samples. */
function downsample(big: Canvas, w: number, h: number): Canvas {
  const px = big.getContext("2d").getImageData(0, 0, big.width, big.height).data;
  const out = createCanvas(w, h);
  const ctx = out.getContext("2d");
  const img = ctx.createImageData(w, h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (let yy = 0; yy < SS; yy++) {
        for (let xx = 0; xx < SS; xx++) {
          const i = ((y * SS + yy) * big.width + x * SS + xx) * 4;
          const alpha = px[i + 3];
          a += alpha;
          r += px[i] * alpha;
          g += px[i + 1] * alpha;
          b += px[i + 2] * alpha;
        }
      }
      const o = (y * w + x) * 4;
      img.data[o] = a ? Math.round(r / a) : 0;
      img.data[o + 1] = a ? Math.round(g / a) : 0;
      img.data[o + 2] = a ? Math.round(b / a) : 0;
      img.data[o + 3] = Math.round(a / (SS * SS));
    }
  }
  ctx.putImageData(img, 0, 0);
  return out;
}

async function cookSprite(pack: string, s: Sprite): Promise<void> {
  const image = await loadImage(join(pack, s.src));
  const [bw, bh] = s.box;
  const scale = s.drawn / Math.max(image.width, image.height);
  const dw = image.width * scale;
  const dh = image.height * scale;
  if (dw > bw + 1e-6 || dh > bh + 1e-6) {
    throw new Error(`${s.out}: ${dw.toFixed(1)}x${dh.toFixed(1)} does not fit ${bw}x${bh}`);
  }
  const big = createCanvas(bw * SS, bh * SS);
  const ctx = big.getContext("2d");
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(image, ((bw - dw) / 2) * SS, ((bh - dh) / 2) * SS, dw * SS, dh * SS);
  writeFileSync(join(ART, s.out), downsample(big, bw, bh).toBuffer("image/png"));
  console.log(`  ${s.out.padEnd(18)} ${bw}x${bh}  <- ${s.src} ${image.width}x${image.height}`);
}

/** A bullet-hell orb: white core, saturated rim, dark edge, soft falloff. */
function cookOrb(o: Glow): void {
  const c = createCanvas(o.size, o.size);
  const g = c.getContext("2d");
  const cx = o.size / 2;
  const r = o.diameter / 2;
  const [R, G, B] = o.rgb;
  const grad = g.createRadialGradient(cx, cx, 0, cx, cx, r);
  grad.addColorStop(0, "rgba(255,255,255,1)");
  grad.addColorStop(0.38, "rgba(255,255,255,1)");
  grad.addColorStop(0.55, `rgba(${R},${G},${B},1)`);
  grad.addColorStop(0.86, `rgba(${R},${G},${B},1)`);
  grad.addColorStop(0.92, `rgba(${R >> 1},${G >> 1},${B >> 1},1)`);
  grad.addColorStop(1, `rgba(${R >> 1},${G >> 1},${B >> 1},0)`);
  g.fillStyle = grad;
  g.beginPath();
  g.arc(cx, cx, r, 0, Math.PI * 2);
  g.fill();
  writeFileSync(join(ART, o.out), c.toBuffer("image/png"));
  console.log(`  ${o.out.padEnd(18)} ${o.size}x${o.size}  <- radial glow`);
}

/** The hit burst: a bright ring that the game scales up and fades out. */
function cookBurst(): void {
  const size = 32;
  const c = createCanvas(size, size);
  const g = c.getContext("2d");
  const cx = size / 2;
  const grad = g.createRadialGradient(cx, cx, 0, cx, cx, cx);
  grad.addColorStop(0, "rgba(255,255,255,0)");
  grad.addColorStop(0.45, "rgba(255,240,180,0.15)");
  grad.addColorStop(0.7, "rgba(255,255,255,1)");
  grad.addColorStop(0.82, "rgba(255,170,60,1)");
  grad.addColorStop(1, "rgba(255,120,40,0)");
  g.fillStyle = grad;
  g.beginPath();
  g.arc(cx, cx, cx, 0, Math.PI * 2);
  g.fill();
  writeFileSync(join(ART, "burst.png"), c.toBuffer("image/png"));
  console.log(`  ${"burst.png".padEnd(18)} ${size}x${size}  <- radial ring`);
}

// ---------------------------------------------------------------------------

async function main(argv: readonly string[]): Promise<void> {
  const pack = await resolvePack(argv);
  mkdirSync(ART, { recursive: true });
  console.log("cooking art/");
  for (const s of SPRITES) await cookSprite(pack, s);
  for (const o of ORBS) cookOrb(o);
  cookBurst();
  copyFileSync(join(pack, "license.txt"), join(ART, "LICENSE-kenney.txt"));

  const images: Record<string, { psm?: number; linear?: boolean }> = {};
  for (const s of SPRITES) {
    const hint: { psm?: number; linear?: boolean } = {};
    if (s.psm !== undefined) hint.psm = s.psm;
    if (s.linear) hint.linear = true;
    if (Object.keys(hint).length > 0) images[`art/${s.out}`] = hint;
  }
  for (const o of ORBS) images[`art/${o.out}`] = { psm: 2 };
  images["art/burst.png"] = { psm: 2 };
  writeFileSync(join(HERE, "images.json"), JSON.stringify(images, null, 2) + "\n");
  console.log("wrote images.json");
}

await main(Bun.argv.slice(2));
