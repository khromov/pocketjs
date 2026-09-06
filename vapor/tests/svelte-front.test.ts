// vapor/tests/svelte-front.test.ts — the Svelte front end: lowering rules,
// subset diagnostics at .svelte locations, and the todo port.

import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { compileVaporApp, VAPOR_TARGETS, VaporCompileError, type VaporTargetName } from "../compiler/compile.ts";
import { compileSvelteApp, lowerSvelte, SvelteFrontError } from "../compiler/svelte.ts";

const ROOT = "/vapor-front-test";
const MAIN = `${ROOT}/Bad.svelte`;
const TODO = join(import.meta.dir, "..", "examples", "todo-svelte", "todo.svelte");

const HOST = `import { Button, onButton } from "../../host/input.ts";`;
const HANDLER = `onButton((b) => { if (b === Button.A) count += 1; });`;

/** A component around one script body and one template, with sibling files. */
function lower(script: string, template: string, files: Record<string, string> = {}) {
  const source = `<script lang="ts">\n${HOST}\n${script}\n</script>\n${template}\n`;
  return {
    source,
    result: lowerSvelte(MAIN, source, { readFile: (p) => readFrom(files, p) }),
  };
}

function readFrom(files: Record<string, string>, p: string): string {
  const name = p.startsWith(`${ROOT}/`) ? p.slice(ROOT.length + 1) : p;
  if (!(name in files)) throw new Error(`no such fixture: ${p}`);
  return files[name];
}

function failure(source: string, files: Record<string, string> = {}): string {
  try {
    lowerSvelte(MAIN, source, { readFile: (p) => readFrom(files, p) });
  } catch (e) {
    expect(e).toBeInstanceOf(SvelteFrontError);
    return (e as Error).message;
  }
  throw new Error("expected a SvelteFrontError");
}

const lineOf = (source: string, marker: string): number => {
  const i = source.split("\n").findIndex((l) => l.includes(marker));
  if (i < 0) throw new Error(`marker not found: ${marker}`);
  return i + 1;
};

describe("svelte front end: runes", () => {
  test("$state and $derived lower to ref and computed, references get .value", () => {
    const { result } = lower(
      `let count = $state(0);
let name: string = $state("A");
interface Item { label: string; done: boolean }
let items = $state<Item[]>([]);
const doubled = $derived(count * 2);
const plusOne = $derived.by(() => count + 1);
function move(d: number) {
  count = count + d;
  count++;
  name += "B";
  items.push({ label: name, done: false });
}
${HANDLER}`,
      `<row y={0}>{count}</row>`,
    );
    const tsx = result.tsx;
    expect(tsx).toContain('import { computed, ref } from "vue";');
    expect(tsx).toContain("const count = ref(0);");
    expect(tsx).toContain('const name = ref<string>("A");');
    expect(tsx).toContain("const items = ref<Item[]>([]);");
    expect(tsx).toContain("const doubled = computed(() => count.value * 2);");
    expect(tsx).toContain("const plusOne = computed(() => count.value + 1);");
    expect(tsx).toContain("function move(d: number) {");
    expect(tsx).toContain("count.value = count.value + d;");
    expect(tsx).toContain("count.value++;");
    expect(tsx).toContain('name.value += "B";');
    expect(tsx).toContain("items.value.push({ label: name.value, done: false });");
    expect(tsx).toContain("if (b === Button.A) count.value += 1;");
    expect(tsx).toContain("<row y={0}>{count.value}</row>");
  });

  test("types, static consts and host imports hoist to module level; keymaps stay in setup", () => {
    const { result } = lower(
      `import { SCREEN } from "../../host/screen.ts";
interface Item { label: string; done: boolean }
type Keymap = Record<number, () => void>;
const LIST_Y = 3;
const NAMES = ["A", "B"];
const NARROW = SCREEN.width < 30;
let count = $state(0);
function move() { count = count + LIST_Y; }
const keys: Keymap = { [Button.A]: move };
${HANDLER}`,
      `<row y={LIST_Y}>{NAMES[count]}</row>`,
    );
    const tsx = result.tsx;
    const at = (s: string) => {
      const i = tsx.indexOf(s);
      expect(i).toBeGreaterThanOrEqual(0);
      return i;
    };
    const setup = at("export default () => {");
    expect(at('import { SCREEN } from "../../host/screen.ts";')).toBeLessThan(setup);
    expect(at("interface Item { label: string; done: boolean }")).toBeLessThan(setup);
    expect(at("type Keymap = Record<number, () => void>;")).toBeLessThan(setup);
    expect(at("const LIST_Y = 3;")).toBeLessThan(setup);
    expect(at('const NAMES = ["A", "B"];')).toBeLessThan(setup);
    expect(at("const NARROW = SCREEN.width < 30;")).toBeLessThan(setup);
    expect(at("const keys: Keymap = { [Button.A]: move };")).toBeGreaterThan(setup);
    expect(at("const count = ref(0);")).toBeGreaterThan(setup);
    expect(tsx).toContain("<row y={LIST_Y}>{NAMES[count.value]}</row>");
  });

  test("a multi-line statement keeps its own indentation, indented once", () => {
    const { result } = lower(
      `let count = $state(0);
  function f() {
    if (count > 1) {
      count = 0;
    }
  }
${HANDLER}`,
      `<row y={0}>{count}</row>`,
    );
    expect(result.tsx).toContain("  function f() {\n    if (count.value > 1) {\n      count.value = 0;\n    }\n  }");
  });

  test("the line map points every generated line at its .svelte line", () => {
    const { source, result } = lower(`let count = $state(0);\n${HANDLER}`, `<row y={0}>{count}</row>`);
    const gen = result.tsx.split("\n");
    const refLine = gen.findIndex((l) => l.includes("const count = ref(0);"));
    expect(result.lines[refLine]).toEqual({ file: MAIN, line: lineOf(source, "$state(0)") });
    const rowLine = gen.findIndex((l) => l.includes("<row y={0}>"));
    expect(result.lines[rowLine]).toEqual({ file: MAIN, line: lineOf(source, "<row y={0}>") });
    expect(result.lines[0]).toBeNull(); // the generated header
  });
});

describe("svelte front end: template", () => {
  test("text follows Svelte's whitespace rules and becomes string expressions", () => {
    const { result } = lower(
      `let count = $state(0);\n${HANDLER}`,
      `<row y={0}> hi {count} there </row>
<row y={1}>
  {count} LEFT
</row>
<row y={2} x={1} class="bg-emerald-500 text-slate-950">A [{count}] B</row>`,
    );
    expect(result.tsx).toContain('<row y={0}>{"hi "}{count.value}{" there"}</row>');
    expect(result.tsx).toContain('<row y={1}>{count.value}{" LEFT"}</row>');
    expect(result.tsx).toContain('<row y={2} x={1} class="bg-emerald-500 text-slate-950">{"A ["}{count.value}{"] B"}</row>');
  });

  test("{#each} becomes .map over the list, with a synthesized index and a fallback", () => {
    const { result } = lower(
      `interface Item { label: string; done: boolean }
let items = $state<Item[]>([]);
let count = $state(0);
${HANDLER}`,
      `{#each items as it, i}
  <row y={1 + i} class={it.done ? "text-slate-500" : ""}>{it.label}</row>
{:else}
  <row y={1}>NONE</row>
{/each}
{#each items as it}<row y={0}>{it.label}</row>{/each}`,
    );
    expect(result.tsx).toContain("{items.value.map((it, i) => (");
    expect(result.tsx).toContain('<row y={1 + i} class={it.done ? "text-slate-500" : ""}>{it.label}</row>');
    expect(result.tsx).toContain('{items.value.length === 0 ? <row y={1}>{"NONE"}</row> : null}');
    expect(result.tsx).toContain("{items.value.map((it, _i) => (");
  });

  test("{#if}/{:else if}/{:else} become one null-ternary per child", () => {
    const { result } = lower(
      `let first = $state(false);
let second = $state(false);
let count = $state(0);
${HANDLER}`,
      `{#if first}
  <row y={0}>A</row>
  <row y={1}>AA</row>
{:else if second}
  <row y={2}>B</row>
{:else}
  <row y={3}>C</row>
{/if}
{#if count > 1}<row y={4}>MANY</row>{/if}`,
    );
    const tsx = result.tsx;
    expect(tsx).toContain('{first.value ? <row y={0}>{"A"}</row> : null}');
    expect(tsx).toContain('{first.value ? <row y={1}>{"AA"}</row> : null}');
    expect(tsx).toContain('{!(first.value) && second.value ? <row y={2}>{"B"}</row> : null}');
    expect(tsx).toContain('{!(first.value) && !(second.value) ? <row y={3}>{"C"}</row> : null}');
    expect(tsx).toContain('{count.value > 1 ? <row y={4}>{"MANY"}</row> : null}');
  });

  test("a child .svelte becomes a module-level function of props", () => {
    const files = {
      "Child.svelte": `<script lang="ts">
  import type { Item } from "./types.ts";
  let { line, item, on }: { line: number; item: Item; on: boolean } = $props();
</script>

<row y={line} x={1} class={on ? "text-emerald-400" : ""}>[{item.done ? "X" : " "}] {item.label}</row>
`,
      "Typed.svelte": `<script lang="ts">
  interface Props {
    line: number;
    text: string;
  }
  let { line, text }: Props = $props();
</script>
<row y={line}>{text}</row>
`,
      "types.ts": `export interface Item {\n  label: string;\n  done: boolean;\n}\n`,
    };
    const { result } = lower(
      `import type { Item } from "./types.ts";
import Child from "./Child.svelte";
import Typed from "./Typed.svelte";
let items = $state<Item[]>([]);
let count = $state(0);
${HANDLER}`,
      `{#each items as it, i}
  <Child line={i} item={it} on={i === count} />
{/each}
<Typed line={0} text="hi" />`,
      files,
    );
    const tsx = result.tsx;
    expect(tsx).toContain("interface Item {\n  label: string;\n  done: boolean;\n}");
    expect(tsx).not.toContain("import type");
    expect(tsx).not.toContain('.svelte"');
    expect(tsx).toContain("function Child(props: { line: number; item: Item; on: boolean }) {");
    expect(tsx).toContain(
      '<row y={props.line} x={1} class={props.on ? "text-emerald-400" : ""}>{"["}{props.item.done ? "X" : " "}{"] "}{props.item.label}</row>',
    );
    expect(tsx).toContain("function Typed(props: {\n  line: number;\n  text: string;\n}) {");
    expect(tsx).not.toContain("interface Props");
    expect(tsx).toContain("<Child line={i} item={it} on={i === count.value} />");
    expect(tsx).toContain('<Typed line={0} text="hi" />');
    expect(result.children).toEqual([`${ROOT}/Child.svelte`, `${ROOT}/Typed.svelte`]);
    // the generated program is a valid Pocket Vapor component
    const app = compileVaporApp(`${ROOT}/Bad.vapor.tsx`, tsx, "T", "gba");
    expect(app.c).not.toContain("Child(");
  });
});

describe("svelte front end: diagnostics", () => {
  const base = (script: string, template: string) => `<script lang="ts">\n${HOST}\nlet count = $state(0);\n${script}\n${HANDLER}\n</script>\n${template}\n`;
  const ok = `<row y={0}>{count}</row>`;

  // Object rows: bun's test.each treats an extra callback parameter as a
  // `done` callback, so a positional table with an optional column stalls.
  interface Rejection {
    name: string;
    source: string;
    marker: string;
    code: string;
    files?: Record<string, string>;
  }
  const row = (name: string, source: string, marker: string, code: string, files?: Record<string, string>): Rejection => ({
    name,
    source,
    marker,
    code,
    files,
  });
  const cases: Rejection[] = [
    row("$effect", base(`$effect(() => { count; });`, ok), "$effect", "VSV101"),
    row("$inspect", base(`$inspect(count);`, ok), "$inspect", "VSV101"),
    row("$state.raw", base(`let raw = $state.raw(0);`, ok), "$state.raw", "VSV101"),
    row("$bindable", base(`let b = $bindable(0);`, ok), "$bindable", "VSV101"),
    row("a rune inside a function", base(`function f() { let x = $state(0); return x; }`, ok), "let x = $state", "VSV102"),
    row("plain let", base(`let plain = 0;`, ok), "let plain", "VSV103"),
    row("a svelte import", base(`import { onMount } from "svelte";`, ok), "onMount", "VSV104"),
    row("a runes-module store", base(`import { store } from "./store.svelte.ts";`, ok), "store.svelte.ts", "VSV104"),
    row("a value import of a .ts file", base(`import { helper } from "./helper.ts";`, ok), "helper.ts", "VSV104"),
    row("a lowercase component import", base(`import child from "./child.svelte";`, ok), "child.svelte", "VSV104"),
    row("an export", base(`export const x = 1;`, ok), "export const", "VSV105"),
    row("a top-level call", base(`console.log(count);`, ok), "console.log", "VSV105"),
    row("a class", base(`function f() { class K {} }`, ok), "class K", "VSV105"),
    row("$props on the root", base(`let { a } = $props();`, ok), "$props", "VSV110"),
    row("{#await}", base(``, `{#await Promise.resolve(1)}<row y={0}>x</row>{/await}`), "{#await", "VSV105"),
    row("{#key}", base(``, `{#key count}<row y={0}>x</row>{/key}`), "{#key", "VSV105"),
    row("{#snippet}", base(``, `{#snippet s()}<row y={0}>x</row>{/snippet}`), "{#snippet", "VSV105"),
    row("{@render}", base(``, `{@render s()}`), "{@render", "VSV105"),
    row("{@html} in a row", base(``, `<row y={0}>{@html "<b>x</b>"}</row>`), "{@html", "VSV107"),
    row("{@const} in a block", base(``, `{#if count}{@const two = 2}<row y={0}>{two}</row>{/if}`), "{@const", "VSV107"),
    row("a <div>", base(``, `<div>{count}</div>`), "<div>", "VSV105"),
    row("<svelte:window>", base(``, `<svelte:window onkeydown={() => {}} />`), "svelte:window", "VSV105"),
    row("text at the root", base(``, `hello\n<row y={0}>{count}</row>`), "hello", "VSV107"),
    row("a row spanning lines", base(``, `<row y={0}>A\n  B</row>`), "<row y={0}>A", "VSV107"),
    row("a component inside a row", base(``, `<row y={0}><b>x</b></row>`), "<b>", "VSV107"),
    row("a DOM event", base(``, `<row y={0} onclick={() => {}}>{count}</row>`), "onclick", "VSV106"),
    row("an on: directive", base(``, `<row y={0} on:click={() => {}}>{count}</row>`), "on:click", "VSV106"),
    row("bind:", base(``, `<row y={0} bind:this={count}>{count}</row>`), "bind:this", "VSV106"),
    row("class:", base(``, `<row y={0} class:done={count}>{count}</row>`), "class:done", "VSV106"),
    row("style:", base(``, `<row y={0} style:color="red">{count}</row>`), "style:color", "VSV106"),
    row("a spread", base(``, `<row y={0} {...{}}>{count}</row>`), "{...", "VSV106"),
    row("the pal attribute", base(``, `<row y={0} pal={1}>{count}</row>`), "pal={1}", "VSV106"),
    row("a boolean attribute", base(``, `<row y={0} x>{count}</row>`), "<row y={0} x>", "VSV106"),
    row("a mixed class", base(``, `<row y={0} class="a {count}">{count}</row>`), 'class="a', "VSV106"),
    row("an each item that is not a name", base(``, `{#each [] as { a }}<row y={0}>{a}</row>{/each}`), "{#each", "VSV108"),
    row("an each body with two rows", base(``, `{#each [] as it}<row y={0}>a</row><row y={1}>b</row>{/each}`), "{#each", "VSV105"),
    row("a param shadowing a rune", base(`function f(count: number) { return count; }`, ok), "function f(count", "VSV109"),
    row("a local shadowing a rune", base(`function f() { const count = 1; return count; }`, ok), "const count = 1", "VSV109"),
    row("an each variable shadowing a rune", base(``, `{#each [] as count}<row y={0}>{count}</row>{/each}`), "{#each", "VSV109"),
    row("a <style> block", `${base(``, ok)}<style>row { color: red; }</style>\n`, "<style>", "VSV111"),
    row("<svelte:options>", `<svelte:options runes={true} />\n${base(``, ok)}`, "svelte:options", "VSV111"),
    row("no onButton", `<script lang="ts">\n${HOST}\nlet count = $state(0);\n</script>\n${ok}\n`, "<script", "VSV112"),
    row("an unknown component", base(``, `<Foo line={0} />`), "<Foo", "VSV113"),
    row("a component with children", base(`import Child from "./Child.svelte";`, `<Child line={0}>x</Child>`), ">x<", "VSV105", {
      "Child.svelte": `<script lang="ts">\n  let { line }: { line: number } = $props();\n</script>\n<row y={line}>a</row>\n`,
    }),
    row("a child with two rows", base(`import Child from "./Child.svelte";`, `<Child line={0} />`), "SECOND", "VSV105", {
      "Child.svelte": `<script lang="ts">\n  let { line }: { line: number } = $props();\n</script>\n<row y={line}>a</row>\n<row y={1}>SECOND</row>\n`,
    }),
    row("a child without a props type", base(`import Child from "./Child.svelte";`, `<Child line={0} />`), "$props()", "VSV110", {
      "Child.svelte": `<script lang="ts">\n  let { line } = $props();\n</script>\n<row y={line}>a</row>\n`,
    }),
    row("a child with a prop default", base(`import Child from "./Child.svelte";`, `<Child />`), "$props()", "VSV110", {
      "Child.svelte": `<script lang="ts">\n  let { line = 0 }: { line?: number } = $props();\n</script>\n<row y={line}>a</row>\n`,
    }),
    row("a child with state", base(`import Child from "./Child.svelte";`, `<Child line={0} />`), "let n = $state", "VSV105", {
      "Child.svelte": `<script lang="ts">\n  let { line }: { line: number } = $props();\n  let n = $state(0);\n</script>\n<row y={line}>{n}</row>\n`,
    }),
  ];

  test.each(cases)("rejects $name", ({ source, marker, code, files }) => {
    const message = failure(source, files);
    const isChild = files !== undefined && Object.values(files).some((f) => f.includes(marker)) && !source.includes(marker);
    const file = isChild ? `${ROOT}/Child.svelte` : MAIN;
    const line = isChild ? lineOf(files!["Child.svelte"], marker) : lineOf(source, marker);
    expect(message).toMatch(new RegExp(`^${file}:${line}:\\d+ — ${code}:`));
  });

  test("a Svelte parse error carries the .svelte location", () => {
    const message = failure(`<script lang="ts">\n${HOST}\nlet count = $state(0);\n${HANDLER}\n</script>\n<row y={0}>{count}\n`);
    expect(message).toMatch(new RegExp(`^${MAIN}:\\d+:\\d+ — VSV100:`));
  });

  test("back-end errors are reported at the .svelte line", () => {
    const source = base(``, `<row y={0}>{count}</row>\n<row y={1}>{nope}</row>`);
    try {
      compileSvelteApp(MAIN, source, "T", "gba");
    } catch (e) {
      expect(e).toBeInstanceOf(VaporCompileError);
      expect((e as Error).message).toMatch(new RegExp(`^${MAIN}:${lineOf(source, "{nope}")}:\\d+ — unknown identifier: nope`));
      return;
    }
    throw new Error("expected a VaporCompileError");
  });

  test("style warnings and target admission name the .svelte file", async () => {
    const source = await Bun.file(TODO).text();
    const gb = compileSvelteApp(TODO, source, "VAPOR TODO", "gb");
    expect(gb.diagnostics.length).toBeGreaterThan(0);
    for (const d of gb.diagnostics) expect(d.startsWith(`${TODO} — VS104`)).toBe(true);
    expect(() => compileSvelteApp(TODO, source, "VAPOR TODO", "playdate")).toThrow(
      new RegExp(`^${TODO} — VT101: playdate has no physical input for Select, Start, R`),
    );
  });
});

describe("svelte front end: the todo port", () => {
  test("lowers deterministically and compiles for every console", async () => {
    const source = await Bun.file(TODO).text();
    const a = lowerSvelte(TODO, source);
    const b = lowerSvelte(TODO, source);
    expect(a.tsx).toBe(b.tsx);
    expect(a.children.map((c) => c.split("/").pop())).toEqual([
      "TitleBar.svelte",
      "StatusBar.svelte",
      "TodoRow.svelte",
      "Notice.svelte",
      "EditorBar.svelte",
      "HelpBar.svelte",
    ]);
    for (const target of Object.keys(VAPOR_TARGETS) as VaporTargetName[]) {
      if (target === "playdate") continue; // VT101, as for todo.tsx
      const app = compileSvelteApp(TODO, source, "VAPOR TODO", target);
      expect(app.c).toContain("vp_mark");
      expect(app.graph).toContain("visible: view(maxLen");
      expect(app.tsx).toBe(a.tsx);
    }
  });

  test("re-relativizes host imports for a written program", async () => {
    const source = await Bun.file(TODO).text();
    const out = join(import.meta.dir, "..", "..", "dist", "vapor", "svelte");
    const { tsx } = lowerSvelte(TODO, source, { importBase: out });
    expect(tsx).toContain('from "../../../vapor/host/input.ts"');
    expect(tsx).toContain('from "../../../vapor/host/screen.ts"');
  });
});
