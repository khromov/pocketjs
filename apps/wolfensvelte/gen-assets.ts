// apps/wolfensvelte/gen-assets.ts — cook Wolfensvelte-3D's art, sounds and
// E1M1 data into PocketJS-shaped assets.
//
//   bun apps/wolfensvelte/gen-assets.ts                 # fetch the pinned commit into .cache/
//   bun apps/wolfensvelte/gen-assets.ts --src <checkout> # use a local Wolfensvelte-3D checkout
//
// Outputs (all committed, like apps/gallery's cooked tiles):
//   art/*.png          pow2 textures: the wall and sprite atlases (512x512, 8x8
//                      cells of 64x64), HUD pieces, menu screens, weapon hands,
//                      the E1M1 overview map
//   sfx/*.wav          effects resampled to 11025 Hz s16 mono (contracts/spec/audio.ts)
//   images.json        pixel formats per image (0 = 5650 opaque, 2 = 4444)
//   pak.json           the audio:wav.* raw blobs
//   game/level-e1m1.ts the level as flat arrays (never the 4269-line object literal)
//   game/atlas.ts      texture id -> atlas cell tables shared by the cooker and the game
//
// Source: https://github.com/snuffyDev/Wolfensvelte-3D (public-domain code; the
// art is the Wolfenstein 3D shareware set the original ships).

import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { decodeBmp } from "./cook/bmp.ts";
import { blank, blit, crop, downsample, fillRect, flatten, pad } from "./cook/image.ts";
import { decodePng, encodePng, type Rgba } from "./cook/png.ts";
import { decodeWavAny, encodeWav16Mono, resample } from "./cook/wav.ts";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const ROOT = join(HERE, "..", "..");
const COMMIT = "345b59d875f50a138c18d6aa5740b6822fe58a51";
const TARBALL = `https://codeload.github.com/snuffyDev/Wolfensvelte-3D/tar.gz/${COMMIT}`;

const CELL = 64;
const ATLAS = 512;
const ATLAS_COLS = ATLAS / CELL;
const SFX_RATE = 11025;

// ---------------------------------------------------------------------------
// Source checkout
// ---------------------------------------------------------------------------

async function resolveSource(argv: readonly string[]): Promise<string> {
  const i = argv.indexOf("--src");
  if (i >= 0) {
    const dir = argv[i + 1];
    if (!dir || !existsSync(join(dir, "src/lib/utils/map.ts"))) {
      throw new Error(`--src must point at a Wolfensvelte-3D checkout (got ${dir})`);
    }
    return dir;
  }
  const cache = join(ROOT, ".cache");
  const dir = join(cache, `wolfensvelte-${COMMIT.slice(0, 7)}`);
  if (existsSync(join(dir, "src/lib/utils/map.ts"))) return dir;
  mkdirSync(cache, { recursive: true });
  const tar = join(cache, `wolfensvelte-${COMMIT.slice(0, 7)}.tar.gz`);
  console.log(`fetching ${TARBALL}`);
  const res = await fetch(TARBALL);
  if (!res.ok) throw new Error(`download failed: ${res.status} ${res.statusText}`);
  writeFileSync(tar, new Uint8Array(await res.arrayBuffer()));
  const proc = Bun.spawnSync(["tar", "-xzf", tar, "-C", cache]);
  if (proc.exitCode !== 0) throw new Error(`tar failed: ${proc.stderr.toString()}`);
  const extracted = join(cache, `Wolfensvelte-3D-${COMMIT}`);
  if (existsSync(dir)) rmSync(dir, { recursive: true });
  renameSync(extracted, dir);
  rmSync(tar);
  return dir;
}

function readImage(path: string): Rgba {
  const bytes = new Uint8Array(readFileSync(path));
  return path.toLowerCase().endsWith(".bmp") ? decodeBmp(bytes, path) : decodePng(bytes, path);
}

function texturePath(src: string, id: number): string {
  const png = join(src, "src/lib/textures", `${id}.png`);
  return existsSync(png) ? png : join(src, "src/lib/textures", `${id}.BMP`);
}

/** A 64x64 cell from a source texture (the 65-px sources carry a transparent edge). */
function textureCell(src: string, id: number): Rgba {
  return crop(readImage(texturePath(src, id)), 0, 0, CELL, CELL);
}

// ---------------------------------------------------------------------------
// Level model (from src/lib/utils/map.ts)
// ---------------------------------------------------------------------------

interface SourceCell {
  surfaces: number | null;
  model?: { component: string; texture?: number };
  rotation?: { x: number; y: number; z: number };
  secret?: boolean;
  pushwall?: boolean;
}

interface SourceLevel {
  spawn: { x: number; z: number };
  data: SourceCell[][];
}

interface Door {
  x: number;
  y: number;
  tex: number;
  /** True when the door sits in a north-south wall (plane x = cx + 0.5, slides along y). */
  vertical: boolean;
}

interface LevelModel {
  w: number;
  h: number;
  /** Light-face wall texture id per tile, 0 = no wall. Doors are 0 here. */
  walls: Uint16Array;
  doors: Door[];
  objects: { x: number; y: number; tex: number }[];
  enemies: { x: number; y: number; kind: number }[];
  pushwalls: { x: number; y: number }[];
  elevators: { x: number; y: number }[];
  spawn: { x: number; y: number; angle: number };
}

const ELEVATOR_OFF = 107;
const ELEVATOR_ON = 109;
const ENEMY_KIND: Record<string, number> = { Guard: 0, Dog: 1 };

function loadLevels(src: string): Record<string, SourceLevel> {
  let text = readFileSync(join(src, "src/lib/utils/map.ts"), "utf8");
  text = text
    .replace(/^import[^\n]*\n/gm, "")
    .replace(/export const /g, "levels.")
    .replace(/ as WorldState/g, "")
    .replace(/ satisfies WorldState/g, "");
  const levels: Record<string, SourceLevel> = {};
  new Function("levels", text)(levels);
  return levels;
}

function buildLevel(level: SourceLevel): LevelModel {
  const h = level.data.length;
  const w = level.data[0].length;
  const walls = new Uint16Array(w * h);
  const model: LevelModel = {
    w, h, walls, doors: [], objects: [], enemies: [], pushwalls: [], elevators: [],
    spawn: { x: 0, y: 0, angle: 0 },
  };
  const isWallSource = (x: number, y: number): boolean => {
    const c = level.data[y]?.[x];
    return !!c && c.surfaces !== null && c.model?.component !== "Door";
  };
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const c = level.data[y][x];
      const component = c.model?.component;
      if (component === "Door") {
        // Door.svelte derives the orientation from the wall neighbours; the
        // map's rotation is the fallback (y: 90 = north-south wall).
        const leftRight = isWallSource(x - 1, y) && isWallSource(x + 1, y);
        const upDown = isWallSource(x, y - 1) && isWallSource(x, y + 1);
        const vertical = upDown && !leftRight ? true : leftRight && !upDown ? false : c.rotation?.y === 90;
        model.doors.push({ x, y, tex: c.model!.texture ?? 99, vertical });
        continue;
      }
      if (component === "Elevator") {
        // Elevator.svelte paints every face 107 and swaps to 109 when used.
        walls[y * w + x] = ELEVATOR_OFF;
        model.elevators.push({ x, y });
        continue;
      }
      if (component === "Object" && typeof c.model?.texture === "number") {
        model.objects.push({ x, y, tex: c.model.texture });
        continue;
      }
      if (component && component in ENEMY_KIND) {
        model.enemies.push({ x, y, kind: ENEMY_KIND[component] });
        continue;
      }
      if (c.surfaces !== null) {
        walls[y * w + x] = c.surfaces;
        if (c.pushwall) model.pushwalls.push({ x, y });
      }
    }
  }
  // Wolfensvelte's "real" spawn is in 64-unit space with its own tile rounding
  // (utils/position.ts getLocalPositionFromRealPosition); the tile centre is
  // where the player stands. rotation.y = 270 faces +x (Player.svelte "left").
  const tx = Math.ceil(level.spawn.x / 64);
  const ty = Math.ceil((level.spawn.z - 32) / 64);
  model.spawn = { x: tx + 0.5, y: ty + 0.5, angle: 0 };
  return model;
}

// ---------------------------------------------------------------------------
// Atlases
// ---------------------------------------------------------------------------

function cellOrigin(index: number): { x: number; y: number } {
  return { x: (index % ATLAS_COLS) * CELL, y: Math.floor(index / ATLAS_COLS) * CELL };
}

/** Wall atlas: consecutive [light, dark] cells per texture id (dark = id + 1). */
function buildWallAtlas(src: string, ids: number[]): { atlas: Rgba; cell: Map<number, number> } {
  const atlas = blank(ATLAS, ATLAS, [0, 0, 0, 255]);
  const cell = new Map<number, number>();
  let next = 0;
  for (const id of ids) {
    if (next + 2 > ATLAS_COLS * ATLAS_COLS) throw new Error("wall atlas: more than 64 cells");
    for (const variant of [id, id + 1]) {
      const o = cellOrigin(next);
      blit(atlas, o.x, o.y, flatten(textureCell(src, variant)));
      next++;
    }
    cell.set(id, next - 2);
  }
  console.log(`  wall atlas: ${ids.length} textures, ${next} cells`);
  return { atlas, cell };
}

interface SpriteAtlas {
  atlas: Rgba;
  objectCell: Map<number, number>;
  guardCell0: number;
  dogCell0: number;
  cells: number;
}

/** Sprite atlas: object textures, then the 13 guard frames, then the 12 dog cells. */
function buildSpriteAtlas(src: string, objectIds: number[]): SpriteAtlas {
  const atlas = blank(ATLAS, ATLAS);
  const objectCell = new Map<number, number>();
  let next = 0;
  const put = (img: Rgba): number => {
    if (next >= ATLAS_COLS * ATLAS_COLS) throw new Error("sprite atlas: more than 64 cells");
    const o = cellOrigin(next);
    blit(atlas, o.x, o.y, img);
    return next++;
  };
  for (const id of objectIds) objectCell.set(id, put(textureCell(src, id)));
  const guard = readImage(join(src, "src/lib/components/Guard/guard.png"));
  const guardFrames = Math.floor(guard.width / CELL);
  const guardCell0 = next;
  for (let f = 0; f < guardFrames; f++) put(crop(guard, f * CELL, 0, CELL, CELL));
  const dog = readImage(join(src, "src/lib/sprites/guard_dog/spritesheet.png"));
  const dogCols = Math.floor(dog.width / CELL);
  const dogRows = Math.floor(dog.height / CELL);
  const dogCell0 = next;
  for (let r = 0; r < dogRows; r++) {
    for (let c = 0; c < dogCols; c++) put(crop(dog, c * CELL, r * CELL, CELL, CELL));
  }
  console.log(`  sprite atlas: ${objectIds.length} objects, ${guardFrames} guard frames, ${dogCols * dogRows} dog cells = ${next} cells`);
  return { atlas, objectCell, guardCell0, dogCell0, cells: next };
}

// ---------------------------------------------------------------------------
// Overview map (3DS bottom screen)
// ---------------------------------------------------------------------------

const MAP_SCALE = 3;

function buildMapImage(level: LevelModel): Rgba {
  const img = blank(256, 256);
  const { w, h, walls } = level;
  const doorAt = new Set(level.doors.map((d) => d.y * w + d.x));
  const elevatorAt = new Set(level.elevators.map((e) => e.y * w + e.x));
  // Flood the reachable interior from the spawn so only the level's own floor
  // is painted; doors are passable, walls are not.
  const inside = new Uint8Array(w * h);
  const stack = [Math.floor(level.spawn.y) * w + Math.floor(level.spawn.x)];
  while (stack.length) {
    const i = stack.pop()!;
    if (inside[i] || walls[i] !== 0) continue;
    inside[i] = 1;
    const x = i % w;
    const y = (i - x) / w;
    if (x > 0) stack.push(i - 1);
    if (x < w - 1) stack.push(i + 1);
    if (y > 0) stack.push(i - w);
    if (y < h - 1) stack.push(i + w);
  }
  const touchesInside = (x: number, y: number): boolean =>
    [[x - 1, y], [x + 1, y], [x, y - 1], [x, y + 1]].some(
      ([nx, ny]) => nx >= 0 && ny >= 0 && nx < w && ny < h && inside[ny * w + nx] === 1,
    );
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      let colour: readonly number[] | null = null;
      if (inside[i]) colour = doorAt.has(i) ? [216, 176, 48, 255] : [44, 44, 52, 255];
      else if (walls[i] !== 0 && touchesInside(x, y)) colour = elevatorAt.has(i) ? [96, 160, 224, 255] : [140, 140, 148, 255];
      if (colour) fillRect(img, x * MAP_SCALE, y * MAP_SCALE, MAP_SCALE, MAP_SCALE, colour);
    }
  }
  return img;
}

// ---------------------------------------------------------------------------
// Generated TypeScript
// ---------------------------------------------------------------------------

const GENERATED = "// Generated by apps/wolfensvelte/gen-assets.ts — do not edit.\n";

function levelSource(level: LevelModel, wallCell: Map<number, number>): string {
  // Wall grid as printable ASCII: char - 32 = atlas cell + 1 of the light
  // face (0 = open floor). Dark faces are the next cell by construction.
  let grid = "";
  for (let i = 0; i < level.walls.length; i++) {
    const id = level.walls[i];
    const v = id === 0 ? 0 : wallCell.get(id)! + 1;
    if (v > 94) throw new Error("grid encoding overflow");
    grid += String.fromCharCode(32 + v);
  }
  const rows: string[] = [];
  for (let y = 0; y < level.h; y++) rows.push(JSON.stringify(grid.slice(y * level.w, (y + 1) * level.w)));
  const flat = (rows: number[][]) => `[\n  ${rows.map((r) => r.join(", ")).join(",\n  ")},\n]`;
  return (
    GENERATED +
    `// E1M1 from Wolfensvelte-3D src/lib/utils/map.ts (${COMMIT.slice(0, 7)}).\n\n` +
    `export const LEVEL_W = ${level.w};\nexport const LEVEL_H = ${level.h};\n\n` +
    `/** Row-major wall grid, one char per tile: charCode - 32 = light-face atlas cell + 1, 0 = floor. */\n` +
    `export const LEVEL_GRID =\n  ${rows.join(" +\n  ")};\n\n` +
    `/** [x, y, atlasCell, vertical] per door (vertical = plane x + 0.5, slides along y). */\n` +
    `export const LEVEL_DOORS: readonly number[] = ${flat(level.doors.map((d) => [d.x, d.y, wallCell.get(d.tex)!, d.vertical ? 1 : 0]))};\n\n` +
    `/** [x, y, textureId] per decoration or pickup. */\n` +
    `export const LEVEL_OBJECTS: readonly number[] = ${flat(level.objects.map((o) => [o.x, o.y, o.tex]))};\n\n` +
    `/** [x, y, kind] per enemy (0 = guard, 1 = dog). */\n` +
    `export const LEVEL_ENEMIES: readonly number[] = ${flat(level.enemies.map((e) => [e.x, e.y, e.kind]))};\n\n` +
    `/** [x, y] per secret pushwall. */\n` +
    `export const LEVEL_PUSHWALLS: readonly number[] = ${flat(level.pushwalls.map((p) => [p.x, p.y]))};\n\n` +
    `/** [x, y] per elevator switch tile. */\n` +
    `export const LEVEL_ELEVATORS: readonly number[] = ${flat(level.elevators.map((e) => [e.x, e.y]))};\n\n` +
    `export const LEVEL_SPAWN = { x: ${level.spawn.x}, y: ${level.spawn.y}, angle: ${level.spawn.angle} } as const;\n`
  );
}

function atlasSource(wallCell: Map<number, number>, sprites: SpriteAtlas, objectIds: number[]): string {
  const wall = [...wallCell.entries()].map(([id, c]) => `  ${id}: ${c},`).join("\n");
  const objects = objectIds.map((id) => `  ${id}: ${sprites.objectCell.get(id)},`).join("\n");
  return (
    GENERATED +
    `\n/** Both atlases are ${ATLAS}x${ATLAS}: ${ATLAS_COLS}x${ATLAS_COLS} cells of ${CELL}x${CELL}. */\n` +
    `export const ATLAS_SIZE = ${ATLAS};\nexport const ATLAS_COLS = ${ATLAS_COLS};\nexport const CELL_SIZE = ${CELL};\n\n` +
    `export const WALL_ATLAS = "art/wall-atlas.png";\nexport const SPRITE_ATLAS = "art/sprite-atlas.png";\n\n` +
    `/** Wall texture id -> light-face cell; the dark face is the next cell. */\n` +
    `export const WALL_CELL: Readonly<Record<number, number>> = {\n${wall}\n};\n\n` +
    `export const ELEVATOR_OFF_CELL = ${wallCell.get(ELEVATOR_OFF)};\nexport const ELEVATOR_ON_CELL = ${wallCell.get(ELEVATOR_ON)};\n\n` +
    `/** Object texture id -> sprite atlas cell. */\n` +
    `export const OBJECT_CELL: Readonly<Record<number, number>> = {\n${objects}\n};\n\n` +
    `/** First of the 13 guard frames (Enemy.svelte keyframes: 0 idle, 1-4 walk, 5-8 dying, 9 hurt, 10 corpse, 11-12 attack). */\n` +
    `export const GUARD_CELL0 = ${sprites.guardCell0};\n` +
    `/** First of the 12 dog cells, row-major over the 3-wide sheet: cell = DOG_CELL0 + row * 3 + col. */\n` +
    `export const DOG_CELL0 = ${sprites.dogCell0};\nexport const DOG_SHEET_COLS = 3;\n`
  );
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const FACE_BANDS = ["full", "beat_up", "hurt", "low_hp", "dying", "near_death", "dead"] as const;
const FACE_FILES: Record<string, string[]> = {
  full: ["FULL", "FULL_01", "FULL_02"],
  beat_up: ["BEAT_UP", "BEAT_UP_01", "BEAT_UP_02"],
  hurt: ["HURT", "HURT_01", "HURT_02"],
  low_hp: ["LOW_HP", "LOW_HP_01", "LOW_HP_02"],
  dying: ["DYING", "DYING_01", "DYING_02"],
  near_death: ["NEAR_DEATH", "NEAR_DEATH_01", "NEAR_DEATH_02"],
  dead: ["DEAD"],
};

const SOUNDS: Record<string, string> = {
  pistol: "sounds/pistol.WAV",
  smg: "sounds/smg.WAV",
  "door-open": "sounds/objects/door/door.WAV",
  "door-close": "sounds/objects/door/door_close.WAV",
  "guard-halt": "sounds/guard/halt.WAV",
  "guard-shoot": "sounds/guard/shoot.WAV",
  "guard-death-1": "sounds/guard/death_1.WAV",
  "guard-death-2": "sounds/guard/death_2.WAV",
  "guard-death-3": "sounds/guard/death_3.WAV",
  "dog-bark": "sounds/dog/bark.WAV",
  "dog-death": "sounds/dog/death.WAV",
};

async function main(): Promise<void> {
  const src = await resolveSource(Bun.argv.slice(2));
  console.log(`source: ${src}`);
  const art = join(HERE, "art");
  const sfx = join(HERE, "sfx");
  const game = join(HERE, "game");
  for (const d of [art, sfx, game]) mkdirSync(d, { recursive: true });

  const images: Record<string, { psm: number }> = {};
  let pakBytes = 0;
  const writeArt = (name: string, img: Rgba, psm: number): void => {
    if ((img.width & (img.width - 1)) || (img.height & (img.height - 1)) || img.width > 512 || img.height > 512) {
      throw new Error(`${name}: ${img.width}x${img.height} is not pow2 <= 512`);
    }
    writeFileSync(join(art, name), encodePng(img));
    images[`art/${name}`] = { psm };
    pakBytes += img.width * img.height * (psm === 3 ? 4 : 2);
  };

  // -- level ----------------------------------------------------------------
  const levels = loadLevels(src);
  const level = buildLevel(levels.E1M1);
  console.log(
    `  E1M1: ${level.doors.length} doors, ${level.objects.length} objects, ${level.enemies.length} enemies, ` +
      `${level.pushwalls.length} pushwalls, ${level.elevators.length} elevators, spawn (${level.spawn.x}, ${level.spawn.y})`,
  );

  // -- atlases --------------------------------------------------------------
  const wallIds = new Set<number>([ELEVATOR_OFF, ELEVATOR_ON]);
  for (const id of level.walls) if (id !== 0) wallIds.add(id);
  for (const d of level.doors) wallIds.add(d.tex);
  const wallList = [...wallIds].sort((a, b) => a - b);
  const walls = buildWallAtlas(src, wallList);
  writeArt("wall-atlas.png", walls.atlas, 0);

  const objectIds = [...new Set(level.objects.map((o) => o.tex))].sort((a, b) => a - b);
  const sprites = buildSpriteAtlas(src, objectIds);
  writeArt("sprite-atlas.png", sprites.atlas, 2);

  // -- HUD --------------------------------------------------------------------
  const hud = join(src, "src/lib/sprites/hud");
  writeArt("hud-bar.png", pad(readImage(join(hud, "main.BMP")), 512, 64), 2);
  for (let d = 0; d <= 9; d++) writeArt(`digit-${d}.png`, readImage(join(hud, `${d}.BMP`)), 2);
  for (const weapon of ["knife", "pistol", "smg"]) {
    writeArt(`hud-weapon-${weapon}.png`, pad(readImage(join(hud, `${weapon}.BMP`)), 64, 32), 2);
  }
  for (const band of FACE_BANDS) {
    FACE_FILES[band].forEach((file, n) => {
      writeArt(`face-${band}-${n}.png`, pad(readImage(join(src, "src/lib/sprites/face", `${file}.BMP`)), 32, 32), 2);
    });
  }

  // -- menus ------------------------------------------------------------------
  const menu = join(src, "src/lib/sprites/menu");
  writeArt("menu-title.png", pad(readImage(join(menu, "wolf_menu.BMP")), 512, 256), 2);
  writeArt("menu-psyched.png", pad(readImage(join(menu, "get_psyched.BMP")), 256, 64), 2);
  writeArt("menu-end.png", pad(readImage(join(menu, "EndScreen.BMP")), 128, 128), 2);

  // -- weapon hands (512-px frames -> 128 px) ----------------------------------
  const pistol = readImage(join(src, "src/lib/sprites/PISTOL.png"));
  for (let f = 0; f < 4; f++) {
    writeArt(`hand-pistol-${f}.png`, downsample(crop(pistol, f * 512, 0, 512, 512), 4), 2);
  }
  const smg = readImage(join(src, "src/lib/sprites/SMG.png"));
  for (let f = 0; f < 5; f++) {
    writeArt(`hand-smg-${f}.png`, downsample(crop(smg, f * 512, 0, 512, 512), 4), 2);
  }

  // -- overview map -------------------------------------------------------------
  writeArt("map-e1m1.png", buildMapImage(level), 2);

  // -- sounds -------------------------------------------------------------------
  const pak: { key: string; file: string }[] = [];
  for (const [name, rel] of Object.entries(SOUNDS)) {
    const pcm = resample(decodeWavAny(new Uint8Array(readFileSync(join(src, "src/lib", rel))), rel), SFX_RATE);
    const wav = encodeWav16Mono(pcm);
    writeFileSync(join(sfx, `${name}.wav`), wav);
    pak.push({ key: `audio:wav.${name}`, file: `sfx/${name}.wav` });
    pakBytes += wav.length;
  }

  // -- manifests + generated code -----------------------------------------------
  writeFileSync(join(HERE, "images.json"), JSON.stringify(images, null, 2) + "\n");
  writeFileSync(join(HERE, "pak.json"), JSON.stringify(pak, null, 2) + "\n");
  writeFileSync(join(game, "level-e1m1.ts"), levelSource(level, walls.cell));
  writeFileSync(join(game, "atlas.ts"), atlasSource(walls.cell, sprites, objectIds));
  console.log(`  ${Object.keys(images).length} images, ${pak.length} sounds, ~${(pakBytes / 1024).toFixed(0)} KB of pak payload`);
}

await main();
