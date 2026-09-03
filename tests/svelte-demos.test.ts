// Parity journeys for the ported demos: each Svelte variant must render the
// same text as the Solid original it was ported from.

import { describe, expect, test } from "bun:test";
import { bootWorld, treeHasText, type SimWorld } from "../hosts/sim/sim.ts";
import { BTN } from "../contracts/spec/spec.ts";

async function step(world: SimWorld, buttons: number): Promise<void> {
  world.frame(buttons);
  for (let tick = 0; tick < world.ticksPerFrame; tick++) world.tick();
  await Promise.resolve();
}

async function boot(app: string, frames = 4): Promise<SimWorld> {
  const world = await bootWorld(app, 60);
  for (let frame = 0; frame < frames; frame++) await step(world, 0);
  return world;
}

/** Every text run the native tree is carrying, in tree order. */
function texts(tree: unknown): string[] {
  const out: string[] = [];
  const walk = (node: { x?: string; k?: unknown[] }): void => {
    if (typeof node.x === "string" && node.x !== "") out.push(node.x);
    for (const child of (node.k ?? []) as { x?: string; k?: unknown[] }[]) walk(child);
  };
  walk(tree as { x?: string; k?: unknown[] });
  return out;
}

const PORTS: ReadonlyArray<{ demo: string; probes: readonly string[] }> = [
  { demo: "cards", probes: ["POCKETJS SHOWCASE"] },
  { demo: "chrome", probes: ["OK", "CANCEL", "READY"] },
  { demo: "cursor", probes: ["hover a row, press CIRCLE"] },
  { demo: "motions", probes: ["MENU", "KEYPAD"] },
];

describe("ported Svelte demos", () => {
  for (const { demo, probes } of PORTS) {
    test(`${demo} renders the same text as the Solid original`, async () => {
      const solid = await boot(`${demo}-main`);
      const svelte = await boot(`${demo}-main.svelte`);

      for (const probe of probes) {
        expect(treeHasText(svelte.getTree(), probe)).toBe(true);
      }
      // Blank anchors carry no text, so the visible runs must match exactly.
      expect(texts(svelte.getTree())).toEqual(texts(solid.getTree()));
    });
  }

  test("the launcher receives its registry through mount()'s props", async () => {
    const world = await boot("launcher-main.svelte");
    const runs = texts(world.getTree());

    // "1 / 21 · <id>" only renders when the registry prop arrived populated.
    expect(runs.some((run) => /^1 \/ \d+ · /.test(run))).toBe(true);
    expect(runs.some((run) => run.includes("No apps embedded"))).toBe(false);
  });

  test("cards reveals its detail panel on CIRCLE, as the Solid build does", async () => {
    const svelte = await boot("cards-main.svelte");
    const solid = await boot("cards-main");

    for (const world of [svelte, solid]) {
      await step(world, BTN.RIGHT);
      await step(world, 0);
      await step(world, BTN.CIRCLE);
      await step(world, 0);
    }
    expect(texts(svelte.getTree())).toEqual(texts(solid.getTree()));
  });
});
