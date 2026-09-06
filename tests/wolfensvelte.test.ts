import { describe, expect, test } from "bun:test";
import { BTN } from "../contracts/spec/spec.ts";
import { bootWorld, treeHasText, type SimWorld } from "../hosts/sim/sim.ts";

const APP = "wolfensvelte-main.svelte";
/** GetPsyched shows for PSYCHED_FRAMES (90) host frames before play begins. */
const PSYCHED = 90;

async function step(world: SimWorld, buttons = 0): Promise<void> {
  world.frame(buttons);
  for (let tick = 0; tick < world.ticksPerFrame; tick++) world.tick();
  await Promise.resolve();
}

async function hold(world: SimWorld, buttons: number, frames: number): Promise<void> {
  for (let f = 0; f < frames; f++) await step(world, buttons);
}

function fnv1a(bytes: Uint8Array): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < bytes.length; i++) h = Math.imul(h ^ bytes[i], 0x01000193);
  return h >>> 0;
}

const hash = (world: SimWorld): number => fnv1a(world.render());

/** "PRESS START" blinks on a 30-frame cycle, so give it one full cycle to show. */
async function seesText(world: SimWorld, text: string, within = 32): Promise<boolean> {
  for (let f = 0; f < within; f++) {
    if (treeHasText(world.getTree(), text)) return true;
    await step(world);
  }
  return false;
}

/** Boot, pass the title and the Get Psyched splash: the first playable frame. */
async function bootIntoLevel(): Promise<SimWorld> {
  const world = await bootWorld(APP, 60);
  await step(world);
  await step(world, BTN.START);
  await hold(world, 0, PSYCHED + 2);
  return world;
}

describe("Wolfensvelte 3D", () => {
  test("boots to the title screen", async () => {
    const world = await bootWorld(APP, 60);
    await step(world);
    expect(await seesText(world, "PRESS START")).toBe(true);
  });

  test("START enters the level and walking changes the view", async () => {
    const world = await bootIntoLevel();
    const standing = hash(world);
    await hold(world, BTN.UP, 30);
    expect(hash(world)).not.toBe(standing);
    // Turning in place changes it again.
    const walked = hash(world);
    await hold(world, BTN.LEFT, 20);
    expect(hash(world)).not.toBe(walked);
  });

  test("the first door blocks until it is used", async () => {
    const world = await bootIntoLevel();
    await hold(world, BTN.UP, 200); // parked against the shut door
    const blocked = hash(world);
    await hold(world, BTN.UP, 10);
    expect(hash(world)).toBe(blocked); // still parked: nothing moves
    await step(world, BTN.CIRCLE);
    await hold(world, BTN.UP, 90); // the door slides open and the player walks through
    expect(hash(world)).not.toBe(blocked);
  });

  test("START pauses and SELECT quits to the title", async () => {
    const world = await bootIntoLevel();
    await step(world, BTN.START);
    await step(world);
    expect(treeHasText(world.getTree(), "PAUSED")).toBe(true);
    await step(world, BTN.SELECT);
    expect(await seesText(world, "PRESS START")).toBe(true);
  });

  test("the same inputs replay to the same pixels", async () => {
    const run = async (): Promise<number[]> => {
      const world = await bootIntoLevel();
      const out: number[] = [];
      for (let f = 0; f < 90; f++) {
        await step(world, f < 40 ? BTN.UP : f < 70 ? BTN.RIGHT : BTN.RTRIGGER);
        if (f % 15 === 0) out.push(hash(world));
      }
      return out;
    };
    expect(await run()).toEqual(await run());
  });
});
