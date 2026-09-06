import { describe, expect, test } from "bun:test";
import { levelFromAscii } from "../apps/wolfensvelte/game/level.ts";
import { castColumns, RayBuffers, setCamera, type Camera } from "../apps/wolfensvelte/game/raycast.ts";
import { DOOR_OPENING, World } from "../apps/wolfensvelte/game/world.ts";

const PROJ = 100;
const HALF_FOV_TAN = Math.tan(Math.PI / 6);

function camera(x: number, y: number, angle: number): Camera {
  const cam: Camera = { x: 0, y: 0, dirX: 1, dirY: 0, planeX: 0, planeY: 0 };
  setCamera(cam, x, y, angle, HALF_FOV_TAN);
  return cam;
}

/** A single centre ray: one column with camX forced to 0. */
function centreRay(world: World, x: number, y: number, angle: number): RayBuffers {
  const out = new RayBuffers(1);
  out.camX[0] = 0;
  castColumns(world, camera(x, y, angle), out, PROJ);
  return out;
}

const ROOM = [
  "#########",
  "#.......#",
  "#.......#",
  "#.......#",
  "#.......#",
  "#########",
];

describe("wolfensvelte raycast", () => {
  test("a wall straight ahead projects as projDist / depth", () => {
    const world = new World(levelFromAscii(ROOM));
    const out = centreRay(world, 1.5, 2.5, 0);
    expect(out.zbuf[0]).toBeCloseTo(6.5, 5);
    expect(out.wallH[0]).toBeCloseTo(PROJ / 6.5, 4);
    // An x-crossing shows the dark face (light cell + 1) of atlas cell 0.
    expect(out.cell[0]).toBe(1);
  });

  test("a y-crossing shows the light face and flips the texture column", () => {
    const world = new World(levelFromAscii(ROOM));
    const down = centreRay(world, 3.25, 1.5, Math.PI / 2);
    expect(down.zbuf[0]).toBeCloseTo(3.5, 5);
    expect(down.cell[0]).toBe(0);
    expect(down.texU[0]).toBe(16); // wallX = 0.25 -> 16, ray moving +y keeps it
    const up = centreRay(world, 3.25, 1.5, -Math.PI / 2);
    expect(up.zbuf[0]).toBeCloseTo(0.5, 5);
    expect(up.texU[0]).toBe(63 - 16); // ray moving -y mirrors the column
  });

  test("every column of a full sweep hits something in a closed room", () => {
    const world = new World(levelFromAscii(ROOM));
    const out = new RayBuffers(120);
    castColumns(world, camera(4.5, 2.5, 0.7), out, PROJ);
    for (let i = 0; i < out.count; i++) {
      expect(out.wallH[i]).toBeGreaterThan(0);
      expect(out.zbuf[i]).toBeGreaterThan(0.5);
      expect(out.zbuf[i]).toBeLessThan(10);
    }
    // Perpendicular depth: the two centre columns see the same wall depth.
    expect(Math.abs(out.zbuf[59] - out.zbuf[60])).toBeLessThan(0.05);
  });

  test("a shut door in an east-west wall is hit on the cell's mid-plane", () => {
    const world = new World(
      levelFromAscii([
        "#########",
        "#.......#",
        "#.......#",
        "####D####",
        "#.......#",
        "#########",
      ]),
    );
    const out = centreRay(world, 4.5, 1.5, Math.PI / 2);
    expect(out.zbuf[0]).toBeCloseTo(2.0, 5); // plane at y = 3.5
    expect(out.cell[0]).toBe(0);
    const door = world.doors[0];
    expect(door.vertical).toBe(false);
    // Half retracted: the panel covers u >= 0.5 and the ray at u = 0.5 still hits it.
    door.open = 0.5;
    expect(centreRay(world, 4.5, 1.5, Math.PI / 2).zbuf[0]).toBeCloseTo(2.0, 5);
    // Retracted past the ray: it passes through to the far wall at y = 5.
    door.open = 0.6;
    expect(centreRay(world, 4.5, 1.5, Math.PI / 2).zbuf[0]).toBeCloseTo(3.5, 5);
    // The panel texture scrolls with the slide.
    door.open = 0.25;
    expect(centreRay(world, 4.5, 1.5, Math.PI / 2).texU[0]).toBe(Math.floor((0.5 - 0.25) * 64));
  });

  test("a door in a north-south wall uses the x mid-plane and the dark face", () => {
    const world = new World(
      levelFromAscii([
        "#######",
        "#..#..#",
        "#..|..#",
        "#..#..#",
        "#######",
      ]),
    );
    expect(world.doors[0].vertical).toBe(true);
    const out = centreRay(world, 1.5, 2.5, 0);
    expect(out.zbuf[0]).toBeCloseTo(2.0, 5); // plane at x = 3.5
    expect(out.cell[0]).toBe(1);
    world.doors[0].open = 1;
    expect(centreRay(world, 1.5, 2.5, 0).zbuf[0]).toBeCloseTo(4.5, 5);
  });

  test("a moving pushwall is hit at its slid position from both sides", () => {
    const world = new World(
      levelFromAscii([
        "#########",
        "#.......#",
        "#...P...#",
        "#.......#",
        "#########",
      ]),
    );
    const occupied = () => false;
    // Push it toward +x from the tile to its west.
    expect(world.use(3, 2, 1, 0, occupied)).toBe("pushwall");
    const p = world.pushwalls[0];
    for (let f = 0; f < 30; f++) world.update(occupied);
    expect(p.moving).toBe(true);
    expect(p.t).toBeCloseTo(0.5, 5);
    // From the west the near face is at x = 4.5.
    expect(centreRay(world, 1.5, 2.5, 0).zbuf[0]).toBeCloseTo(3.0, 4);
    // From the east the near face is at x = 5.5.
    expect(centreRay(world, 7.5, 2.5, Math.PI).zbuf[0]).toBeCloseTo(2.0, 4);
    // Pushwall.svelte keeps sliding while the next tile is open: it stops
    // against the east wall three tiles over and becomes a plain wall again.
    for (let f = 0; f < 200; f++) world.update(occupied);
    expect(p.moving).toBe(false);
    expect(world.isWall(7, 2)).toBe(true);
    expect(world.isWall(4, 2)).toBe(false);
    expect(world.isWall(5, 2)).toBe(false);
    expect(centreRay(world, 1.5, 2.5, 0).zbuf[0]).toBeCloseTo(5.5, 5);
  });

  test("doors open, hold and close on their timers", () => {
    const world = new World(levelFromAscii(["#####", "#...#", "##D##", "#...#", "#####"]));
    const door = world.doors[0];
    expect(world.isSolid(2, 2, false)).toBe(true);
    world.use(2, 1, 0, 1, () => false);
    expect(door.state).toBe(DOOR_OPENING);
    for (let f = 0; f < 30; f++) world.update(() => false);
    expect(door.open).toBe(1);
    expect(world.isSolid(2, 2, false)).toBe(false);
    for (let f = 0; f < 330; f++) world.update(() => false);
    expect(door.open).toBe(0);
    expect(world.sfx).toEqual(["door-open", "door-close"]);
  });

  test("line of sight stops at walls and shut doors", () => {
    const world = new World(levelFromAscii(["#######", "#.....#", "###D###", "#.....#", "#######"]));
    expect(world.lineOfSight(1, 1, 5, 1)).toBe(true);
    expect(world.lineOfSight(3, 1, 3, 3)).toBe(false);
    world.doors[0].open = 1;
    expect(world.lineOfSight(3, 1, 3, 3)).toBe(true);
  });
});
