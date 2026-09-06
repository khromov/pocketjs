// vapor/oracle/boot.ts — build the oracle bundle and drive it.
//
// Two oracles, one protocol. The Vue bundle is produced with the repo's own
// vue-vapor jsx pipeline (framework/compiler/jsx-plugin.ts), so the todo
// component goes through the exact vue-jsx-vapor transform any PocketJS vapor
// app does — the oracle is not a reimplementation of Vue, it IS Vue 3.6
// vapor. The Svelte bundle compiles each .svelte file with Svelte's own
// compiler against the custom renderer in renderer-svelte.ts and resolves
// `svelte` to its client build — real Svelte 5 over the same micro-DOM.

import { join } from "node:path";
import type { BunPlugin } from "bun";
import { jsxPlugin } from "../../framework/compiler/jsx-plugin.ts";
import type { StyleTable } from "../compiler/styles.ts";
import { createRootElement, installOracleDom, type VaporElement } from "./dom.ts";
import { paintGrid, type CellGrid } from "./paint.ts";

const ENTRY = join(import.meta.dir, "entry.ts");
const ENTRY_APP = join(import.meta.dir, "entry-app.ts");
const ENTRY_SVELTE = join(import.meta.dir, "entry-svelte.ts");
const RENDERER_SVELTE = join(import.meta.dir, "renderer-svelte.ts");
const TODO_SVELTE = join(import.meta.dir, "..", "examples", "todo-svelte", "todo.svelte");

export type OracleFramework = "vue-vapor" | "svelte";

const bundleTexts = new Map<string, string>();

/** Resolve the `vapor:app` specifier the parametrized entries import. */
function appAlias(app: string): BunPlugin {
  return {
    name: "vapor-oracle-app",
    setup(build) {
      build.onResolve({ filter: /^vapor:app$/ }, () => ({ path: app }));
    },
  };
}

/**
 * Compile .svelte files the way framework/compiler/svelte-compile.ts does,
 * with the renderer pointed at the oracle's micro-DOM adapter. The absolute
 * path is baked in so the compiled `$renderer` import and entry-svelte.ts
 * resolve to one module (Svelte compares renderers by identity).
 */
function svelteLoader(): BunPlugin {
  return {
    name: "vapor-oracle-svelte",
    setup(build) {
      build.onLoad({ filter: /\.svelte$/ }, async (args) => {
        const { compile } = await import("svelte/compiler");
        const source = await Bun.file(args.path).text();
        const compiled = compile(source, {
          filename: args.path,
          generate: "client",
          runes: true,
          css: "external",
          dev: false,
          discloseVersion: false,
          experimental: { customRenderer: RENDERER_SVELTE },
        });
        return { contents: compiled.js.code, loader: "js" };
      });
    },
  };
}

async function buildOracleBundle(framework: OracleFramework, entry: string, app: string | undefined): Promise<string> {
  const key = `${framework}\0${entry}\0${app ?? ""}`;
  const cached = bundleTexts.get(key);
  if (cached) return cached;
  const result =
    framework === "svelte"
      ? await Bun.build({
          entrypoints: [entry],
          format: "iife",
          target: "browser",
          // custom-renderer selects svelte/renderer and the client runtime;
          // production turns esm-env's DEV off (tools/build.ts does the same)
          conditions: ["browser", "custom-renderer", "production"],
          define: { "process.env.NODE_ENV": '"production"' },
          plugins: [appAlias(app ?? TODO_SVELTE), svelteLoader()],
        })
      : await Bun.build({
          entrypoints: [entry],
          format: "iife",
          target: "browser",
          conditions: ["browser"],
          define: {
            document: "globalThis.__vaporDocument",
            "process.env.NODE_ENV": '"production"',
            __DEV__: "false",
          },
          plugins: [...(app ? [appAlias(app)] : []), jsxPlugin("vue-vapor")],
        });
  if (!result.success) {
    throw new Error(`oracle bundle failed:\n${result.logs.join("\n")}`);
  }
  const bundleText = await result.outputs[0].text();
  bundleTexts.set(key, bundleText);
  return bundleText;
}

export interface Oracle {
  root: VaporElement;
  /** Deliver one button edge and settle the framework's scheduler. */
  press(button: number): Promise<void>;
  /** Deliver one relative-axis delta and settle the framework's scheduler. */
  axisDelta(axis: number, delta: number): Promise<void>;
  /** Current rendered grid. */
  grid(): CellGrid;
  unmount(): void;
}

export interface OracleOptions {
  width?: number;
  height?: number;
  /** compile-produced style table: class -> pair id/align for the painter */
  styles?: StyleTable;
  /** bundle entry installing the hooks; defaults per framework */
  entry?: string;
  /** which real runtime executes the component; defaults to Vue Vapor */
  framework?: OracleFramework;
  /**
   * component module for the parametrized entries: a .tsx for Vue (e.g. the
   * Svelte front end's generated program) or a .svelte for Svelte; defaults
   * to the todo example of that framework
   */
  app?: string;
}

export async function bootOracle(opts: OracleOptions = {}): Promise<Oracle> {
  const framework = opts.framework ?? "vue-vapor";
  const entry = opts.entry ?? (framework === "svelte" ? ENTRY_SVELTE : opts.app ? ENTRY_APP : ENTRY);
  const bundle = await buildOracleBundle(framework, entry, opts.app);
  installOracleDom();
  const g = globalThis as Record<string, unknown>;
  g.__vaporScreenW = opts.width ?? 30;
  g.__vaporScreenH = opts.height ?? 20;
  (0, eval)(bundle);

  const hooks = globalThis as Record<string, unknown>;
  const boot = hooks.__vaporBoot as (container: unknown) => { unmount(): void };
  const pressHook = hooks.__vaporPress as (button: number) => void;
  const axisDeltaHook = hooks.__vaporAxisDelta as (axis: number, delta: number) => void;
  const tick = hooks.__vaporTick as () => Promise<void>;

  const root = createRootElement();
  const app = boot(root);
  await tick();

  return {
    root,
    async press(button: number) {
      pressHook(button);
      await tick();
    },
    async axisDelta(axis: number, delta: number) {
      axisDeltaHook(axis, delta);
      await tick();
    },
    grid: () => paintGrid(root, opts.width ?? 30, opts.height ?? 20, opts.styles),
    unmount: () => app.unmount(),
  };
}
