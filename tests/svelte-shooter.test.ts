import { describe, expect, test } from "bun:test";
import { BTN } from "../contracts/spec/spec.ts";
import { createSimAudioSink } from "../hosts/sim/audio.ts";
import { bootWorld, fnv1a, treeHasText, type SimWorld } from "../hosts/sim/sim.ts";

const APP = "svelte-shooter-main.svelte";

async function step(world: SimWorld, buttons = 0): Promise<void> {
  world.frame(buttons);
  for (let tick = 0; tick < world.ticksPerFrame; tick++) world.tick();
  await Promise.resolve();
}

async function run(world: SimWorld, frames: number, buttons = 0): Promise<void> {
  for (let f = 0; f < frames; f++) await step(world, buttons);
}

/** One frame down, one frame up: a clean press edge. */
async function press(world: SimWorld, buttons: number): Promise<void> {
  await step(world, buttons);
  await step(world, 0);
}

/** getTree() itself advances a frame, so probe on a fixed cadence. */
async function framesUntil(world: SimWorld, text: string, cap: number, every = 10): Promise<number> {
  for (let f = 0; f < cap; f += every) {
    if (treeHasText(world.getTree(), text)) return f;
    await run(world, every - 1);
  }
  return -1;
}

describe("Svelte shooter", () => {
  test("boots with the HUD zeroed and the lock off", async () => {
    const world = await bootWorld(APP, 60);
    await run(world, 4);
    const tree = world.getTree();
    for (const text of ["SVELTE SHOOTER", "SCORE", "LIVES 3", "BOMBS 3", "LOCK OFF", "STAGE 1"]) {
      expect(treeHasText(tree, text)).toBe(true);
    }
    // The score is a row of digit images (the tree carries no image sources).
    expect(JSON.stringify(tree)).toContain('"n":"Score"');
    expect(treeHasText(tree, "GAME OVER")).toBe(false);
  });

  test("RTRIGGER toggles the autofire lock indicator", async () => {
    const world = await bootWorld(APP, 60);
    await run(world, 2);
    await press(world, BTN.RTRIGGER);
    let tree = world.getTree();
    expect(treeHasText(tree, "LOCK ON")).toBe(true);
    expect(treeHasText(tree, "LOCK OFF")).toBe(false);
    await press(world, BTN.RTRIGGER);
    tree = world.getTree();
    expect(treeHasText(tree, "LOCK OFF")).toBe(true);
  });

  test("CIRCLE spends bombs down to zero", async () => {
    const world = await bootWorld(APP, 60);
    await run(world, 2);
    await press(world, BTN.CIRCLE);
    expect(treeHasText(world.getTree(), "BOMBS 2")).toBe(true);
    await press(world, BTN.CIRCLE);
    await press(world, BTN.CIRCLE);
    expect(treeHasText(world.getTree(), "BOMBS 0")).toBe(true);
    await press(world, BTN.CIRCLE);
    expect(treeHasText(world.getTree(), "BOMBS 0")).toBe(true);
  });

  test("an idle ship loses a life on a fixed frame, identically every run", async () => {
    const a = await bootWorld(APP, 60);
    await run(a, 150);
    expect(treeHasText(a.getTree(), "LIVES 3")).toBe(true);
    const lost = await framesUntil(a, "LIVES 2", 400);
    expect(lost).toBeGreaterThan(0);

    const b = await bootWorld(APP, 60);
    await run(b, 150);
    b.getTree();
    expect(await framesUntil(b, "LIVES 2", 400)).toBe(lost);
    expect(fnv1a(b.render())).toBe(fnv1a(a.render()));
  });

  test("game over arrives, and START restarts the run", async () => {
    const world = await bootWorld(APP, 60);
    expect(await framesUntil(world, "GAME OVER", 1500, 30)).toBeGreaterThan(0);
    expect(treeHasText(world.getTree(), "LIVES 0")).toBe(true);
    await press(world, BTN.START);
    await run(world, 8);
    const tree = world.getTree();
    expect(treeHasText(tree, "GAME OVER")).toBe(false);
    expect(treeHasText(tree, "LIVES 3")).toBe(true);
    expect(treeHasText(tree, "BOMBS 3")).toBe(true);
  });

  test("START pauses and resumes", async () => {
    const world = await bootWorld(APP, 60);
    await run(world, 2);
    await press(world, BTN.START);
    expect(treeHasText(world.getTree(), "PAUSED")).toBe(true);
    await press(world, BTN.START);
    expect(treeHasText(world.getTree(), "PAUSED")).toBe(false);
  });

  test("a host with an auxiliary surface gets the HUD on the second screen", async () => {
    // The 3DS shape: a 400x240 primary and a host-created 320x240 auxiliary
    // root, published the way hosts/3ds does. The DevTools tree carries both
    // roots, so the bottom-screen legend proves which branch mounted.
    const world = await bootWorld(
      APP,
      60,
      undefined,
      (ops) => {
        const host = ops as { createNode: (type: number) => number; __auxiliarySurface?: unknown };
        host.__auxiliarySurface = { root: host.createNode(0), w: 320, h: 240 };
      },
      { width: 400, height: 240 },
    );
    await run(world, 4);
    await press(world, BTN.RTRIGGER);
    await run(world, 60, BTN.CROSS);
    const tree = world.getTree();
    expect(treeHasText(tree, "B  FIRE")).toBe(true);
    expect(treeHasText(tree, "CROSS  FIRE")).toBe(false);
    expect(treeHasText(tree, "LOCK ON")).toBe(true);
    expect(treeHasText(tree, "LIVES 3")).toBe(true);
  });

  test("the theme streams on a host with the audio module, and never changes a pixel", async () => {
    // One world at a time: a boot replaces the shared host globals, and the
    // player reads `globalThis.audio` live (tests/audio-sim.test.ts does the same).
    const journey = async (sink: ReturnType<typeof createSimAudioSink> | null): Promise<string> => {
      const world = await bootWorld(APP, 60, sink ? { audio: sink.ns } : undefined);
      for (let f = 0; f < 90; f++) {
        world.frame(f === 2 ? BTN.RTRIGGER : 0);
        for (let t = 0; t < world.ticksPerFrame; t++) {
          world.tick();
          sink?.tick(); // the virtual audio clock advances with the core clock
        }
      }
      return fnv1a(world.render());
    };
    const sink = createSimAudioSink();
    const withAudio = await journey(sink);
    const silent = await journey(null);
    // The theme really fed the sink from the first frames, without starving it.
    expect(sink.log[0]).toBe("op createStream 22050 1");
    expect(sink.consumedFrames()).toBeGreaterThan(22050);
    expect(sink.log.some((l) => l.includes('"underrun"'))).toBe(false);
    // Sound never feeds back into the game (docs/AUDIO.md).
    expect(withAudio).toBe(silent);
  });

  test("a 400x240 host without a second screen keeps the HUD beside the field", async () => {
    const world = await bootWorld(APP, 60, undefined, undefined, { width: 400, height: 240 });
    await run(world, 4);
    const tree = world.getTree();
    expect(treeHasText(tree, "LIVES 3")).toBe(true);
    expect(treeHasText(tree, "LOCK OFF")).toBe(true);
  });
});
