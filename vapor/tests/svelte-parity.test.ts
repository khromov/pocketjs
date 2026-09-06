// vapor/tests/svelte-parity.test.ts — the Svelte front end's claim, in Bun.
//
// Two assertions, no toolchain needed:
//   1. todo.svelte lowers to the same program as the hand-written todo.tsx —
//      the reactive graph, the memory plan and the generated C are equal on
//      every console target, and Playdate admission fails the same way.
//   2. Real Svelte running todo.svelte and real Vue running the generated
//      TSX paint the same cell grid (chars + palettes) at boot and after
//      every press of the shared tape, at every target geometry.
// With (2) the existing ROM parity suite (parity.test.ts, toolchain-gated)
// covers the compiled output of both front ends transitively.

import { beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { compileVaporApp, VAPOR_TARGETS, type VaporTargetName } from "../compiler/compile.ts";
import type { StyleTable } from "../compiler/styles.ts";
import { compileSvelteApp, lowerSvelte } from "../compiler/svelte.ts";
import { bootOracle } from "../oracle/boot.ts";
import { TODO_TAPE } from "./todo-tape.ts";

const HERE = import.meta.dir;
const TSX = join(HERE, "..", "examples", "todo", "todo.tsx");
const SVELTE = join(HERE, "..", "examples", "todo-svelte", "todo.svelte");
const OUT = join(HERE, "..", "..", "dist", "vapor", "svelte");
const GENERATED = join(OUT, "todo.vapor.tsx");

const tsxSource = await Bun.file(TSX).text();
const svelteSource = await Bun.file(SVELTE).text();
const CONSOLES: VaporTargetName[] = ["gba", "gb", "nes", "esp32"];

describe("todo.svelte lowers to the todo.tsx program", () => {
  for (const target of CONSOLES) {
    test(`${target}: same reactive graph, memory plan and C`, () => {
      const vue = compileVaporApp(TSX, tsxSource, "VAPOR TODO", target);
      const svelte = compileSvelteApp(SVELTE, svelteSource, "VAPOR TODO", target);
      expect(svelte.graph).toBe(vue.graph);
      expect(svelte.plan).toBe(vue.plan);
      expect(svelte.c).toBe(vue.c);
      expect(svelte.buttonsUsed).toEqual(vue.buttonsUsed);
      expect(svelte.styles.pairs).toEqual(vue.styles.pairs);
    });
  }

  test("playdate: the same admission verdict", () => {
    expect(() => compileVaporApp(TSX, tsxSource, "VAPOR TODO", "playdate")).toThrow(/VT101/);
    expect(() => compileSvelteApp(SVELTE, svelteSource, "VAPOR TODO", "playdate")).toThrow(/VT101/);
  });
});

describe("real Svelte == real Vue on the generated program, every press", () => {
  let styles: StyleTable;

  beforeAll(async () => {
    const { tsx } = lowerSvelte(SVELTE, svelteSource, { importBase: OUT });
    await Bun.write(GENERATED, tsx);
    styles = compileSvelteApp(SVELTE, svelteSource, "VAPOR TODO", "gba").styles;
  });

  for (const target of Object.keys(VAPOR_TARGETS) as VaporTargetName[]) {
    const t = VAPOR_TARGETS[target];
    test(`${target} (${t.width}x${t.height}): every step of the tape renders identically`, async () => {
      const geometry = { width: t.width, height: t.height, styles };
      const svelte = await bootOracle({ framework: "svelte", ...geometry });
      const vue = await bootOracle({ app: GENERATED, ...geometry });
      const compare = (label: string) => {
        const want = vue.grid();
        const got = svelte.grid();
        for (let y = 0; y < t.height; y++) {
          expect(`${label} y=${y}: ${got.chars[y]}`).toBe(`${label} y=${y}: ${want.chars[y]}`);
          expect(`${label} y=${y} pal: ${got.pals[y].join(",")}`).toBe(`${label} y=${y} pal: ${want.pals[y].join(",")}`);
        }
      };
      compare(`${target} boot`);
      for (let i = 0; i < TODO_TAPE.length; i++) {
        await svelte.press(TODO_TAPE[i]);
        await vue.press(TODO_TAPE[i]);
        compare(`${target} step ${i} (btn ${TODO_TAPE[i]})`);
      }
      svelte.unmount();
      vue.unmount();
    });
  }
});
