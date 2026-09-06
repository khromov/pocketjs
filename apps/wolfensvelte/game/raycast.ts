// Column raycaster: one DDA per screen column over the world grid, with
// Wolfenstein-style recessed sliding doors and moving pushwall blocks. Pure
// arithmetic over typed arrays so QuickJS keeps it cheap: no allocation, no
// closures, no sqrt per column.

import { MAX_DDA_STEPS, MIN_DEPTH } from "./constants.ts";
import type { World } from "./world.ts";

export interface Camera {
  x: number;
  y: number;
  dirX: number;
  dirY: number;
  planeX: number;
  planeY: number;
}

export class RayBuffers {
  readonly count: number;
  /** Projected wall height in pixels per column (0 = nothing hit). */
  readonly wallH: Float32Array;
  /** Wall-atlas cell per column (light or dark face already chosen). */
  readonly cell: Uint8Array;
  /** Texture column 0..63 per column. */
  readonly texU: Uint8Array;
  /** Perpendicular depth per column, for sprite occlusion. */
  readonly zbuf: Float32Array;
  /** Camera-plane offset per column (-1..1), precomputed once. */
  readonly camX: Float32Array;

  constructor(count: number) {
    this.count = count;
    this.wallH = new Float32Array(count);
    this.cell = new Uint8Array(count);
    this.texU = new Uint8Array(count);
    this.zbuf = new Float32Array(count);
    this.camX = new Float32Array(count);
    for (let i = 0; i < count; i++) this.camX[i] = (2 * (i + 0.5)) / count - 1;
  }
}

/**
 * Cast every column. `projDist` is the projection-plane distance in pixels
 * (viewW/2 / tan(fov/2)); a wall at perpendicular depth d is projDist/d tall.
 */
export function castColumns(world: World, cam: Camera, out: RayBuffers, projDist: number): void {
  const grid = world.grid;
  const doorAt = world.doorAt;
  const slabAt = world.slabAt;
  const doors = world.doors;
  const pushwalls = world.pushwalls;
  const w = world.w;
  const h = world.h;
  const px = cam.x;
  const py = cam.y;
  const startX = Math.floor(px);
  const startY = Math.floor(py);
  const camX = out.camX;
  const wallH = out.wallH;
  const cellOut = out.cell;
  const texOut = out.texU;
  const zbuf = out.zbuf;

  for (let col = 0; col < out.count; col++) {
    const cx = camX[col];
    const rayDirX = cam.dirX + cam.planeX * cx;
    const rayDirY = cam.dirY + cam.planeY * cx;
    let mapX = startX;
    let mapY = startY;
    const deltaDistX = rayDirX === 0 ? 1e30 : Math.abs(1 / rayDirX);
    const deltaDistY = rayDirY === 0 ? 1e30 : Math.abs(1 / rayDirY);
    let stepX: number;
    let stepY: number;
    let sideDistX: number;
    let sideDistY: number;
    if (rayDirX < 0) {
      stepX = -1;
      sideDistX = (px - mapX) * deltaDistX;
    } else {
      stepX = 1;
      sideDistX = (mapX + 1 - px) * deltaDistX;
    }
    if (rayDirY < 0) {
      stepY = -1;
      sideDistY = (py - mapY) * deltaDistY;
    } else {
      stepY = 1;
      sideDistY = (mapY + 1 - py) * deltaDistY;
    }

    let perp = 0;
    let cell = 0;
    let texU = 0;
    let hit = false;
    for (let step = 0; step < MAX_DDA_STEPS; step++) {
      let side: number;
      if (sideDistX < sideDistY) {
        sideDistX += deltaDistX;
        mapX += stepX;
        side = 0;
      } else {
        sideDistY += deltaDistY;
        mapY += stepY;
        side = 1;
      }
      if (mapX < 0 || mapY < 0 || mapX >= w || mapY >= h) break;
      const i = mapY * w + mapX;
      const g = grid[i];
      if (g !== 0) {
        // Solid wall: the classic perpendicular distance and texture column.
        perp = side === 0 ? sideDistX - deltaDistX : sideDistY - deltaDistY;
        let wallX = side === 0 ? py + perp * rayDirY : px + perp * rayDirX;
        wallX -= Math.floor(wallX);
        texU = (wallX * 64) | 0;
        if (side === 0 && rayDirX > 0) texU = 63 - texU;
        if (side === 1 && rayDirY < 0) texU = 63 - texU;
        cell = side === 0 ? g : g - 1; // dark face on x-crossings
        hit = true;
        break;
      }
      const dIdx = doorAt[i];
      if (dIdx >= 0) {
        // Recessed door: the panel is the cell's mid-plane, retracted by
        // `open` along the slide axis (Door.svelte slides toward +x / +y).
        const d = doors[dIdx];
        if (d.vertical) {
          if (rayDirX !== 0) {
            const t = (mapX + 0.5 - px) / rayDirX;
            const hy = py + t * rayDirY;
            if (hy >= mapY && hy < mapY + 1) {
              const u = hy - mapY;
              if (u >= d.open) {
                perp = t;
                texU = ((u - d.open) * 64) | 0;
                if (rayDirX > 0) texU = 63 - texU;
                cell = d.cell + 1;
                hit = true;
                break;
              }
            }
          }
        } else if (rayDirY !== 0) {
          const t = (mapY + 0.5 - py) / rayDirY;
          const hx = px + t * rayDirX;
          if (hx >= mapX && hx < mapX + 1) {
            const u = hx - mapX;
            if (u >= d.open) {
              perp = t;
              texU = ((u - d.open) * 64) | 0;
              if (rayDirY < 0) texU = 63 - texU;
              cell = d.cell;
              hit = true;
              break;
            }
          }
        }
        continue;
      }
      const sIdx = slabAt[i];
      if (sIdx >= 0) {
        // Moving pushwall: a unit box slid `t` tiles along its direction.
        const p = pushwalls[sIdx];
        const bx0 = p.x + (p.dx > 0 ? p.t : p.dx < 0 ? -p.t : 0);
        const by0 = p.y + (p.dy > 0 ? p.t : p.dy < 0 ? -p.t : 0);
        const bx1 = bx0 + 1;
        const by1 = by0 + 1;
        let txMin: number;
        let txMax: number;
        if (rayDirX === 0) {
          if (px < bx0 || px >= bx1) continue;
          txMin = -1e30;
          txMax = 1e30;
        } else {
          const a = (bx0 - px) / rayDirX;
          const b = (bx1 - px) / rayDirX;
          txMin = a < b ? a : b;
          txMax = a < b ? b : a;
        }
        let tyMin: number;
        let tyMax: number;
        if (rayDirY === 0) {
          if (py < by0 || py >= by1) continue;
          tyMin = -1e30;
          tyMax = 1e30;
        } else {
          const a = (by0 - py) / rayDirY;
          const b = (by1 - py) / rayDirY;
          tyMin = a < b ? a : b;
          tyMax = a < b ? b : a;
        }
        const tEnter = txMin > tyMin ? txMin : tyMin;
        const tExit = txMax < tyMax ? txMax : tyMax;
        if (tEnter > tExit || tEnter <= 0) continue;
        const hx = px + tEnter * rayDirX;
        const hy = py + tEnter * rayDirY;
        // The box spans two tiles; only accept the hit inside this one so
        // the other tile's walk reports it at the right point.
        if (hx < mapX - 1e-4 || hx > mapX + 1 + 1e-4 || hy < mapY - 1e-4 || hy > mapY + 1 + 1e-4) continue;
        const side = txMin > tyMin ? 0 : 1;
        let wallX = side === 0 ? hy - by0 : hx - bx0;
        if (wallX < 0) wallX = 0;
        if (wallX > 0.9999) wallX = 0.9999;
        texU = (wallX * 64) | 0;
        if (side === 0 && rayDirX > 0) texU = 63 - texU;
        if (side === 1 && rayDirY < 0) texU = 63 - texU;
        perp = tEnter;
        cell = side === 0 ? p.cell + 1 : p.cell;
        hit = true;
        break;
      }
    }

    if (!hit) {
      wallH[col] = 0;
      zbuf[col] = 1e30;
      cellOut[col] = 0;
      texOut[col] = 0;
      continue;
    }
    if (perp < MIN_DEPTH) perp = MIN_DEPTH;
    wallH[col] = projDist / perp;
    zbuf[col] = perp;
    cellOut[col] = cell;
    texOut[col] = texU;
  }
}

/** Camera basis for a heading: `dir` unit vector, `plane` scaled by tan(fov/2). */
export function setCamera(cam: Camera, x: number, y: number, angle: number, halfFovTan: number): void {
  const dirX = Math.cos(angle);
  const dirY = Math.sin(angle);
  cam.x = x;
  cam.y = y;
  cam.dirX = dirX;
  cam.dirY = dirY;
  cam.planeX = -dirY * halfFovTan;
  cam.planeY = dirX * halfFovTan;
}
