import { describe, expect, test } from "bun:test";
import { transformFile } from "../framework/compiler/jsx-plugin.ts";
import { compileSvelte, compileSvelteModule } from "../framework/compiler/svelte-compile.ts";
import { foldSvelteConstants } from "../framework/compiler/svelte-fold.ts";

const COUNTER = `
<script lang="ts">
  import { Text, View } from "@pocketjs/framework/svelte/components";
  let count = $state(0);
</script>

<View class="flex-row gap-3" onPress={() => count++}>
  <Text class="text-base text-white">Count: {count}</Text>
</View>
`;

const compileFails = (source: string): string => {
  try {
    compileSvelte(source, "/virtual/Bad.svelte");
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error("expected compileSvelte to throw");
};

describe("Svelte custom-renderer compilation", () => {
  test("emits the PocketJS renderer as the component's $renderer", () => {
    const result = compileSvelte(COUNTER, "/virtual/Counter.svelte");

    expect(result.code).toContain(
      `import $renderer from '@pocketjs/framework/svelte/renderer'`,
    );
    expect(result.code).toContain("svelte/internal/flags/custom-renderer");
    // init-operations grabs window/document/navigator eagerly; a custom
    // renderer must never pull it in.
    expect(result.code).not.toContain("svelte/internal/init-operations");
    expect(result.code).not.toContain("disclose-version");
  });

  test("keeps static classes and text as string literals for pass-1 collection", () => {
    const result = compileSvelte(COUNTER, "/virtual/Counter.svelte");

    expect(result.code).toContain("flex-row gap-3");
    expect(result.code).toContain("text-base text-white");
    expect(result.code).toContain("Count: ");
  });

  test("runs the compiled component through PocketJS collection", async () => {
    const result = await transformFile("/virtual/Counter.svelte", COUNTER, "svelte");

    expect(result.classStrings).toContain("flex-row gap-3");
    expect(result.classStrings).toContain("text-base text-white");
    expect(result.textCodepoints.has("C".codePointAt(0)!)).toBe(true);
  });

  test("compiles a .svelte.ts runes module and strips its types", () => {
    const result = compileSvelteModule(
      `export const store = $state<{ n: number }>({ n: 0 });`,
      "/virtual/store.svelte.ts",
    );

    expect(result.code).not.toContain("<{ n: number }>");
    expect(result.code).toContain("$.proxy");
  });

  test("a Svelte module demands framework=svelte", async () => {
    await expect(
      transformFile("/virtual/Counter.svelte", COUNTER, "solid"),
    ).rejects.toThrow(/requires framework "svelte"/);
  });
});

describe("PocketJS authoring rules", () => {
  test("<style> blocks are refused", () => {
    expect(compileFails(`<style>.a { color: red }</style><view></view>`)).toContain(
      "<style> blocks aren't supported",
    );
  });

  test("class: and style: directives are refused", () => {
    expect(compileFails(`<view class:on={true}></view>`)).toContain("`class:` directives");
    expect(compileFails(`<view style:color="red"></view>`)).toContain("`style:` directives");
  });

  test("a style attribute names the style prop instead", () => {
    expect(compileFails(`<view style="width: 2px"></view>`)).toContain(
      "<View style={{ width: 10 }} />",
    );
  });

  test("interpolated and clsx-shaped class values are refused", () => {
    expect(compileFails("<view class={`p-${n}`}></view>")).toContain("FULL literals");
    expect(compileFails(`<view class="a {b}"></view>`)).toContain("FULL literals");
    expect(compileFails(`<view class={{ on: true }}></view>`)).toContain("FULL class literals");
    expect(compileFails(`<view class={["a", "b"]}></view>`)).toContain("FULL class literals");
  });

  test("ternaries of full class literals are allowed", () => {
    const result = compileSvelte(
      `<script>let on = $state(true);</script><view class={on ? "p-2 bg-red-500" : "p-2 bg-slate-700"}></view>`,
      "/virtual/Ok.svelte",
    );

    expect(result.code).toContain("p-2 bg-red-500");
    expect(result.code).toContain("p-2 bg-slate-700");
  });

  test("motion and transition imports are refused with the native alternative", () => {
    const message = compileFails(
      `<script>import { spring } from "svelte/motion";</script><view></view>`,
    );

    expect(message).toContain("svelte/motion");
    expect(message).toContain("animate()");
  });

  test("Svelte's own custom-renderer refusals still apply", () => {
    expect(compileFails(`<view bind:this={node}></view>`)).toContain("customRenderer");
    expect(compileFails(`<svelte:window onresize={() => {}} />`)).toContain("customRenderer");
    expect(compileFails(`<view transition:fade></view>`)).toContain("customRenderer");
  });

  // Apps write <View>, never <view>, so a check that only walks host elements
  // never sees the code it governs.
  test("the class and style rules apply to components too", () => {
    const component = (body: string) =>
      `<script>import { View } from "@pocketjs/framework/svelte/components";` +
      ` let n = $state(1); let on = $state(true);</script>${body}`;

    expect(compileFails(component(`<View class="w-1 {n}" />`))).toContain("FULL literals");
    expect(compileFails(component(`<View class={{ on }} />`))).toContain("FULL class literals");
    expect(compileFails(component(`<View class={["a", "b"]} />`))).toContain("FULL class literals");
    expect(compileFails(component(`<View style="width: 10px" />`))).toContain(
      "<View style={{ width: 10 }} />",
    );
  });

  test("the supported spellings still compile on a component", () => {
    const result = compileSvelte(
      `<script>import { View } from "@pocketjs/framework/svelte/components";` +
        ` let on = $state(true);</script>` +
        `<View class={on ? "p-2 bg-red-500" : "p-2 bg-slate-700"} style={{ width: 10 }} />`,
      "/virtual/Ok.svelte",
    );

    expect(result.code).toContain("p-2 bg-red-500");
    expect(result.code).toContain("p-2 bg-slate-700");
  });

  test("errors name the file and line", () => {
    expect(compileFails(`<view></view>\n<view style="x"></view>`)).toContain("Bad.svelte:2:");
  });
});

describe("build-time constants in the Svelte runtime", () => {
  const CLIENT = "/repo/node_modules/svelte/src/internal/client/";

  test("drops DEV from the esm-env import and folds every read to false", () => {
    const src = [
      `import { DEV } from 'esm-env';`,
      `import { get } from './runtime.js';`,
      `export function f(x) { if (DEV) { check(x); } return get(x); }`,
      `export const label = DEV ? name(x) : null;`,
    ].join("\n");
    const out = foldSvelteConstants(CLIENT + "proxy.js", src);

    expect(out).toBeDefined();
    expect(out).not.toContain("esm-env");
    expect(out).not.toMatch(/\bDEV\b/);
    expect(out).toContain("if (false) { check(x); }");
    expect(out).toContain("false ? name(x) : null");
    expect(out).toContain(`import { get } from './runtime.js';`);
  });

  test("removes one specifier from a multi-line import and keeps the rest", () => {
    const src = [
      `import {`,
      `\thydrate_next,`,
      `\thydrate_node,`,
      `\thydrating,`,
      `\tset_hydrating`,
      `} from '../hydration.js';`,
      `export function next() { return hydrating ? hydrate_node : null; }`,
    ].join("\n");
    const out = foldSvelteConstants(CLIENT + "dom/blocks/each.js", src);

    expect(out).toContain(
      `import { hydrate_next, hydrate_node, set_hydrating } from '../hydration.js';`,
    );
    expect(out).toContain("return false ? hydrate_node : null;");
  });

  test("leaves identifiers that only contain a folded name alone", () => {
    const src = [
      `import { hydrating, set_hydrating } from '../hydration.js';`,
      `var was_hydrating = hydrating;`,
      `if (was_hydrating) set_hydrating(false);`,
    ].join("\n");
    const out = foldSvelteConstants(CLIENT + "dom/elements/attributes.js", src);

    expect(out).toContain("var was_hydrating = false;");
    expect(out).toContain("if (was_hydrating) set_hydrating(false);");
  });

  test("never rewrites the module that declares a binding", () => {
    const flags = [
      `export let custom_renderers_flag = false;`,
      `export function enable_custom_renderers_flag() { custom_renderers_flag = true; }`,
    ].join("\n");
    expect(foldSvelteConstants("/repo/node_modules/svelte/src/internal/flags/index.js", flags)).toBeUndefined();

    const hydration = [
      `export let hydrating = false;`,
      `export function set_hydrating(value) { hydrating = value; }`,
    ].join("\n");
    expect(foldSvelteConstants(CLIENT + "dom/hydration.js", hydration)).toBeUndefined();
  });

  test("does not touch the server-side hydration module of the same name", () => {
    const src = `import { BLOCK_OPEN } from './hydration.js';\nexport const open = BLOCK_OPEN;`;
    expect(foldSvelteConstants("/repo/node_modules/svelte/src/internal/server/index.js", src)).toBeUndefined();
  });

  test("returns undefined for a file that imports none of the constants", () => {
    const src = `import { get } from './runtime.js';\nexport const x = get(1);`;
    expect(foldSvelteConstants(CLIENT + "dom/task.js", src)).toBeUndefined();
  });

  test("refuses an aliased import instead of substituting the wrong name", () => {
    const src = `import { DEV as dev } from 'esm-env';\nif (dev) {}`;
    expect(() => foldSvelteConstants(CLIENT + "x.js", src)).toThrow(/imports DEV as dev/);
  });

  test("fixes the flags to the values a PocketJS build establishes", () => {
    const src = [
      `import { async_mode_flag, custom_renderers_flag, legacy_mode_flag, tracing_mode_flag } from '../flags/index.js';`,
      `export const v = [async_mode_flag, custom_renderers_flag, legacy_mode_flag, tracing_mode_flag];`,
    ].join("\n");
    const out = foldSvelteConstants(CLIENT + "runtime.js", src);

    expect(out).not.toContain("flags/index.js");
    expect(out).toContain("export const v = [false, true, false, false];");
  });
});
