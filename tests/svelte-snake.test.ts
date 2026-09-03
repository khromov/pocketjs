import { describe, expect, test } from "bun:test";
import { bootWorld, treeHasText, type SimWorld } from "../hosts/sim/sim.ts";
import { BTN } from "../contracts/spec/spec.ts";

async function step(world: SimWorld, buttons = 0): Promise<void> {
  world.frame(buttons);
  for (let tick = 0; tick < world.ticksPerFrame; tick++) world.tick();
  await Promise.resolve();
}

/** The two stat numbers, in tree order: score then best. */
function stats(world: SimWorld): { score: number; best: number; run: number } {
  const json = JSON.stringify(world.getTree());
  const numbers = (json.match(/"x":"(\d+)"/g) ?? []).map((run) => Number(run.match(/\d+/)![0]));
  return {
    score: numbers[0] ?? -1,
    best: numbers[1] ?? -1,
    run: Number((json.match(/RUN (\d+)/) ?? [])[1] ?? -1),
  };
}

/** One snake move is STEP_FRAMES host frames. */
async function moves(world: SimWorld, count: number, buttons = 0): Promise<void> {
  for (let frame = 0; frame < count * 8; frame++) await step(world, buttons);
}

describe("Svelte snake", () => {
  test("boots with the board, the logo panel and a zeroed score", async () => {
    const world = await bootWorld("svelte-snake-main.svelte", 60);
    await moves(world, 0);
    await step(world);

    const tree = world.getTree();
    expect(treeHasText(tree, "SVELTE SNAKE")).toBe(true);
    expect(treeHasText(tree, "D-PAD STEERS")).toBe(true);
    expect(treeHasText(tree, "SCORE")).toBe(true);
    expect(treeHasText(tree, "BEST")).toBe(true);
    expect(stats(world)).toMatchObject({ score: 0, best: 0, run: 1 });
  });

  test("eating food raises the score", async () => {
    const world = await bootWorld("svelte-snake-main.svelte", 60);
    await step(world);
    // The snake starts heading right at x=5 with food at x=9.
    await moves(world, 4);

    expect(stats(world).score).toBe(1);
  });

  test("the d-pad steers, and turning away from the wall keeps the run alive", async () => {
    const world = await bootWorld("svelte-snake-main.svelte", 60);
    await step(world);
    await moves(world, 4);
    await step(world, BTN.DOWN);
    await moves(world, 3);

    // Still run 1: without the turn the snake would have hit the right wall.
    expect(stats(world)).toMatchObject({ score: 1, run: 1 });
  });

  test("running into a wall restarts the game and records the best score", async () => {
    const world = await bootWorld("svelte-snake-main.svelte", 60);
    await step(world);
    await moves(world, 9); // straight into the right wall

    const after = stats(world);
    expect(after.run).toBe(2);
    expect(after.score).toBe(0);
    // The score reached before dying survives as `best`.
    expect(after.best).toBe(1);
  });

  test("reversing onto its own neck is ignored rather than fatal", async () => {
    const world = await bootWorld("svelte-snake-main.svelte", 60);
    await step(world);
    await step(world, BTN.LEFT); // heading right; a reversal must be dropped
    await moves(world, 2);

    expect(stats(world).run).toBe(1);
  });
});
