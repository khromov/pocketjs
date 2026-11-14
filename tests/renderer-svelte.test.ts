// Svelte renderer contract tests — drive framework/src/renderer-svelte.ts
// against a MOCK HostOps that records every op call, using the real Svelte
// custom-renderer runtime under Bun.
//
// Run: bun test --conditions=browser,custom-renderer,production tests/renderer-svelte.test.ts

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { ANALOG_CENTER, BTN, NODE_TYPE, ROOT_ID, SCREEN_H, SCREEN_W } from "../contracts/spec/spec.ts";
import { TEXT_EVENT_KINDS } from "../contracts/spec/input.ts";
import { installHost, publishViewport, type HostOps } from "../framework/src/host.ts";
import { focusNode, resetInput } from "../framework/src/input.ts";
import { MotionQuality, type MotionState } from "../framework/src/motion.ts";
import { resetPack } from "../framework/src/pak.ts";
import { RelativeAxis, type AxisDelta } from "../framework/src/relative-axis.ts";
import { registerStyles, resetStyles, resolveStyle } from "../framework/src/styles.ts";
import { onTextEvent, type TextEvent, type TextEventRecord } from "../framework/src/text-input.ts";
import {
  flushSync,
  registerSprite,
  render,
  resetRendererState,
  resetSprites,
  resetTextures,
  rootMirror,
  runSweep,
  setStyleResolver,
  type NodeMirror,
} from "../framework/src/renderer-svelte.ts";
import type { Viewport } from "../framework/src/viewport.svelte.ts";
import { installSvelteLoader } from "./svelte-test-runtime.ts";

// Fail fast with a real message if the server build got resolved: mount() does
// not exist there, and svelte/renderer throws on import.
if (!("mount" in (await import("svelte")))) {
  throw new Error(
    "svelte resolved to its server build — mount() is missing. " +
      "Run: bun test --conditions=browser,custom-renderer,production",
  );
}

installSvelteLoader();

const { state } = await import("./fixtures/svelte/store.svelte.ts");
const Basic = (await import("./fixtures/svelte/Basic.svelte")).default;
// The entry and anything reaching frame.svelte.ts load through the loader.
const entry = await import("../framework/src/index-svelte.ts");
const { rightAnalogX, rightAnalogY } = await import("../framework/src/lifecycle-svelte.ts");
const { input, log } = await import("./fixtures/svelte/input-state.svelte.ts");
const Columns = (await import("./fixtures/svelte/Columns.svelte")).default;
const Input = (await import("./fixtures/svelte/Input.svelte")).default;
const Sprite = (await import("../framework/src/svelte/Sprite.svelte")).default;

type Call = [string, ...unknown[]];

interface MockHost {
  ops: HostOps;
  kind: "injected";
  target: string;
  strict: boolean;
  calls: Call[];
  alive: Set<number>;
  of(...names: string[]): Call[];
  clear(): void;
}

function makeMockHost(): MockHost {
  const calls: Call[] = [];
  let nextId = ROOT_ID + 1;
  const alive = new Set<number>([ROOT_ID]);
  const rec =
    (name: string) =>
    (...args: unknown[]) => {
      calls.push([name, ...args]);
    };
  const ops: HostOps = {
    createNode(type: number): number {
      const id = nextId++;
      alive.add(id);
      calls.push(["createNode", type, id]);
      return id;
    },
    destroyNode(id: number): void {
      alive.delete(id);
      calls.push(["destroyNode", id]);
    },
    insertBefore: rec("insertBefore"),
    removeChild: rec("removeChild"),
    setStyle: rec("setStyle"),
    setProp: rec("setProp"),
    setText: rec("setText"),
    replaceText: rec("replaceText"),
    uploadTexture: () => 900,
    setImage: rec("setImage"),
    setSprite: rec("setSprite"),
    animate: () => 1,
    cancelAnim: rec("cancelAnim"),
    setFocus: rec("setFocus"),
    setActive: rec("setActive"),
    loadStyles: rec("loadStyles"),
    loadFontAtlas: rec("loadFontAtlas"),
    measureText: () => 0,
  };
  return {
    ops,
    kind: "injected",
    target: "test",
    strict: false,
    calls,
    alive,
    of(...names) {
      return calls.filter((call) => names.includes(call[0] as string));
    },
    clear() {
      calls.length = 0;
    },
  };
}

let host: MockHost;
let root: NodeMirror;
let dispose: () => void;
let disposed = false;

function teardown(): void {
  if (disposed) return;
  disposed = true;
  dispose();
}

/** Text runs the native tree is actually carrying, in tree order. */
function texts(node: NodeMirror = root): string[] {
  const out: string[] = [];
  const walk = (n: NodeMirror): void => {
    if (n.type === NODE_TYPE.text && n.text) out.push(n.text);
    for (const child of n.children) walk(child);
  };
  walk(node);
  return out;
}

function find(predicate: (node: NodeMirror) => boolean): NodeMirror | undefined {
  const walk = (n: NodeMirror): NodeMirror | undefined => {
    if (predicate(n)) return n;
    for (const child of n.children) {
      const hit = walk(child);
      if (hit) return hit;
    }
    return undefined;
  };
  return walk(root);
}

beforeEach(() => {
  host = makeMockHost();
  installHost(host);
  resetRendererState();
  resetStyles();
  resetTextures();
  resetPack();
  resetInput();
  setStyleResolver(resolveStyle);
  // The fixture's one class literal, as the Tailwind pass would have compiled it.
  registerStyles({ "p-2 flex-col": 7 });
  state.label = "hi";
  state.on = false;
  state.items = [
    { id: "a", n: "A" },
    { id: "b", n: "B" },
    { id: "c", n: "C" },
  ];
  state.presses = 0;
  root = { id: ROOT_ID, type: NODE_TYPE.view, parent: null, children: [] };
  disposed = false;
  dispose = render(Basic, root);
});

// The fixture's state is one module instance shared by every mount, so a
// surviving component from an earlier test would answer the next test's writes.
afterEach(() => {
  teardown();
  runSweep();
});

describe("mount", () => {
  test("projects the component onto native nodes", () => {
    expect(texts()).toEqual(["hi", "A", "B", "C", "press"]);
    expect(host.of("createNode").length).toBeGreaterThan(0);
  });

  test("comment anchors are empty native text, so they take no layout slot", () => {
    // {#if} and {#each} each contribute one anchor, plus render()'s own.
    const anchors: NodeMirror[] = [];
    const walk = (n: NodeMirror): void => {
      if (n.domNodeType === 8) anchors.push(n);
      for (const child of n.children) walk(child);
    };
    walk(root);
    expect(anchors.length).toBeGreaterThanOrEqual(3);
    for (const anchor of anchors) expect(anchor.text).toBe("");
  });

  test("a class attribute resolves through the style table", () => {
    expect(host.of("setStyle").length).toBeGreaterThan(0);
  });
});

describe("updates", () => {
  test("text edits replace in place rather than rebuilding the node", () => {
    const before = host.of("createNode").length;
    host.clear();

    state.label = "bye";
    flushSync();

    expect(texts()[0]).toBe("bye");
    expect(host.of("replaceText")).toHaveLength(1);
    expect(host.of("createNode")).toHaveLength(0);
    expect(before).toBeGreaterThan(0);
  });

  test("an {#if} builds on entry and the sweep destroys it on exit", () => {
    state.on = true;
    flushSync();
    expect(texts()).toContain("shown");

    host.clear();
    state.on = false;
    flushSync();
    // Removal detaches; nothing is destroyed until the frame's sweep runs.
    expect(host.of("destroyNode")).toHaveLength(0);
    expect(host.of("removeChild").length).toBeGreaterThan(0);

    runSweep();
    expect(host.of("destroyNode").length).toBeGreaterThan(0);
    expect(texts()).not.toContain("shown");
  });

  test("a keyed {#each} reorders by moving nodes, never destroying them", () => {
    host.clear();
    state.items = [
      { id: "c", n: "C" },
      { id: "a", n: "A" },
      { id: "b", n: "B" },
    ];
    flushSync();
    runSweep();

    expect(texts()).toEqual(["hi", "C", "A", "B", "press"]);
    expect(host.of("createNode")).toHaveLength(0);
    expect(host.of("destroyNode")).toHaveLength(0);
    expect(host.of("insertBefore").length).toBeGreaterThan(0);
  });
});

describe("events", () => {
  test("onpress reaches the node as the native press handler", () => {
    const button = find((node) => typeof node.onPress === "function");
    expect(button).toBeDefined();

    button!.onPress!();
    flushSync();

    expect(state.presses).toBe(1);
  });

  test("only the element that declared a handler carries one", () => {
    const handlers: NodeMirror[] = [];
    const walk = (n: NodeMirror): void => {
      if (n.onPress) handlers.push(n);
      for (const child of n.children) walk(child);
    };
    walk(root);
    // A press wrapper on every view would swallow the CIRCLE bubble that
    // input.ts walks to the nearest ancestor with a handler.
    expect(handlers).toHaveLength(1);
  });
});

describe("prop ordering", () => {
  test("nodeRef fires after style and press are on the node", async () => {
    // Solid's order is create, props, then ref, and an animate()/spring() call
    // made from a ref must not be undone by the initial style write.
    const Ordered = (await import("./fixtures/svelte/Ordered.svelte")).default;
    const calls: Array<[unknown, unknown]> = [];

    const host = { id: ROOT_ID, type: NODE_TYPE.view, parent: null, children: [] } as NodeMirror;
    const stop = render(Ordered, host, {
      seen: (style: unknown, press: unknown) => calls.push([style, press]),
    });
    flushSync();

    expect(calls).toHaveLength(1);
    expect(calls[0][0]).toEqual({ translateX: 7 });
    expect(typeof calls[0][1]).toBe("function");

    stop();
    runSweep();
  });
});

describe("teardown", () => {
  test("unmount leaves nothing behind once the sweep runs", () => {
    teardown();
    runSweep();

    expect(root.children).toHaveLength(0);
    expect(rootMirror.children).toHaveLength(0);
  });
});

describe("Sprite", () => {
  test("frameStep overrides the atlas step on the host's sprite binding", () => {
    registerSprite("spin.svg", { handle: 3, frames: 8, cols: 4, step: 3 });
    const host2 = { id: ROOT_ID, type: NODE_TYPE.view, parent: null, children: [] } as NodeMirror;
    host.clear();
    const stop = render(Sprite, host2, { sprite: "spin.svg", frameStep: 6 });

    // setSprite(node, handle, frames, cols, step): the prop wins over the manifest's 3.
    expect(host.of("setSprite").at(-1)!.slice(2)).toEqual([3, 8, 4, 6]);

    stop();
    runSweep();
    resetSprites();
  });
});

// The rest mount through index-svelte's render(), which owns the frame
// handler, the viewport layers and the input roots, then drive it the way a
// host does: one globalThis.frame(...) call per frame.
type FrameHandler = (
  buttons: number,
  analog?: number,
  touches?: readonly number[],
  hits?: readonly number[],
  touchSurfaces?: readonly number[],
  rightAnalog?: number,
  axisDeltas?: readonly AxisDelta[],
  motion?: MotionState | null,
  text?: readonly TextEventRecord[],
) => void;

function frame(buttons: number, extra: {
  rightAnalog?: number;
  axisDeltas?: readonly AxisDelta[];
  motion?: MotionState | null;
  text?: readonly TextEventRecord[];
} = {}): void {
  (globalThis as unknown as { frame: FrameHandler }).frame(
    buttons,
    ANALOG_CENTER,
    undefined,
    undefined,
    undefined,
    extra.rightAnalog,
    extra.axisDeltas,
    extra.motion,
    extra.text,
  );
}

describe("entry", () => {
  let stop: (() => void) | undefined;

  function mountApp(
    code: Parameters<typeof entry.render>[0],
    opts: { viewport?: { w: number; h: number }; props?: Record<string, unknown> } = {},
  ): void {
    if (opts.viewport) (host.ops as HostOps & { __viewport?: unknown }).__viewport = opts.viewport;
    stop = entry.render(code, { ops: host.ops, styles: {}, props: opts.props });
  }

  beforeEach(() => {
    // Drop the renderer fixture the file-wide setup mounted.
    teardown();
    runSweep();
    resetRendererState();
    input.active = false;
    input.early = false;
    log.length = 0;
  });

  afterEach(() => {
    stop?.();
    stop = undefined;
  });

  describe("viewport", () => {
    test("useViewport starts at the size the host published and follows each resize", () => {
      mountApp(Columns, { viewport: { w: 900, h: 600 } });
      expect(texts(rootMirror)).toEqual(["4 columns at 900x600"]);

      // resizeViewport commits the listeners' writes before it returns.
      entry.resizeViewport(640, 480);
      expect(texts(rootMirror)).toEqual(["3 columns at 640x480"]);
      entry.resizeViewport(300, 480);
      expect(texts(rootMirror)).toEqual(["1 columns at 300x480"]);
    });

    test("a host that publishes no viewport gives the spec screen", () => {
      mountApp(Columns);
      const columns = Math.max(1, Math.floor((SCREEN_W + 20) / 220));
      expect(texts(rootMirror)).toEqual([`${columns} columns at ${SCREEN_W}x${SCREEN_H}`]);
    });

    test("onViewport hears each resize until it is removed, and a destroyed component stops listening", () => {
      let viewport: Viewport | undefined;
      mountApp(Columns, { viewport: { w: 800, h: 600 }, props: { expose: (v: Viewport) => (viewport = v) } });
      const seen: string[] = [];
      const remove = entry.onViewport((w, h) => seen.push(`${w}x${h}`));

      entry.resizeViewport(700, 500);
      entry.resizeViewport(700, 500);
      remove();
      entry.resizeViewport(600, 400);

      expect(seen).toEqual(["700x500", "700x500"]);
      expect(texts(rootMirror)).toEqual(["2 columns at 600x400"]);

      stop!();
      stop = undefined;
      publishViewport(500, 300);
      expect(viewport!.current).toEqual({ w: 600, h: 400 });
    });
  });

  describe("input", () => {
    test("presses run in document order, not registration order", () => {
      let target: NodeMirror | undefined;
      mountApp(Input, { props: { focusable: (node: NodeMirror) => (target = node) } });
      // Mounted after "before", placed ahead of it in the tree.
      input.early = true;
      flushSync();
      focusNode(target!);

      frame(0);
      frame(BTN.CIRCLE);

      // The focused node's CIRCLE joins the placed ActionHandlers' queue.
      expect(log).toEqual(["early", "before", "focused"]);
    });

    test("ActionHandler and AxisHandler read active on each frame", () => {
      mountApp(Input, { props: { focusable: () => {} } });
      const primary = (delta: number): AxisDelta[] => [{ axis: RelativeAxis.Primary, delta }];

      frame(0);
      frame(BTN.CIRCLE, { axisDeltas: primary(12_000) });
      expect(log).toEqual(["before"]);

      input.active = true;
      flushSync();
      log.length = 0;
      frame(0);
      frame(BTN.CIRCLE, { axisDeltas: primary(-15_000) });
      frame(0, { axisDeltas: [] });

      expect(log).toEqual(["before", "gated", "axis -15000"]);
    });

    test("MotionHandler delivers a value at its minimum quality, with its metadata", () => {
      mountApp(Input, { props: { focusable: () => {} } });
      const at = (timestamp: number, quality: number): MotionState =>
        ({ timestamp, inclination: { value: 45, quality } }) as MotionState;

      frame(0, { motion: at(1, MotionQuality.Low) });
      frame(0, { motion: at(2, MotionQuality.High) });
      frame(0);

      expect(log).toEqual([`inclination 45 ${MotionQuality.High} 2`]);
    });

    test("the frame handler latches the right stick", () => {
      mountApp(Columns);
      frame(0, { rightAnalog: 0xff80 });
      expect([rightAnalogX(), rightAnalogY()]).toEqual([1, 0]);
    });

    test("the frame's text events reach onTextEvent, and unmount drops the handlers", () => {
      mountApp(Columns);
      const seen: TextEvent[] = [];
      onTextEvent((event) => {
        seen.push(event);
      });
      frame(0, { text: [{ kind: TEXT_EVENT_KINDS.COMMIT, text: "hi" }] });
      expect(seen).toEqual([{ kind: "commit", text: "hi" }]);

      stop!();
      mountApp(Columns);
      frame(0, { text: [{ kind: TEXT_EVENT_KINDS.COMMIT, text: "again" }] });
      expect(seen).toHaveLength(1);
    });
  });
});
