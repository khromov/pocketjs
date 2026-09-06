// Load-time treatment of Svelte's client runtime for a PocketJS host, applied
// by framework/compiler/jsx-plugin.ts as an onLoad transform over
// node_modules/svelte/src/**/*.js in framework=svelte bundles. Two tables:
// build-time constants to fold (this half of the file) and function bodies to
// replace with a throw (the second half).
//
// Svelte gates its dev-only, hydration and DOM-only code behind module-level
// bindings that every PocketJS build resolves the same way but no bundler can
// fold:
//
//   * `DEV` / `BROWSER` come from `esm-env`, which the `production` resolve
//     condition maps to `false.js` / `true.js`. Bun bundles those as
//     `var false_default = false` and keeps every `if (false_default) { … }`
//     block: it folds literal conditions, not imported bindings, `const` or
//     otherwise. Measured on `cards`: 85 such guards survived.
//   * `hydrating` is a mutable `let` in `dom/hydration.js`, set only by
//     `hydrate()`. PocketJS mounts with `mount()`; it is `false` for the life
//     of the process.
//   * The `flags/index.js` lets are set by `enable_*_flag()` at import time.
//     `svelte/renderer` enables `custom_renderers_flag` before anything
//     renders; nothing in a PocketJS bundle enables the other three
//     (`legacy-client.js` is stubbed out, the compiler runs without
//     `experimental.async`, tracing is dev-only).
//
// The transform drops each name from the `import { … } from '<module>'` that
// carries it and substitutes the literal for every remaining occurrence, so
// Bun sees `if (false) { … }` and drops the block, and whatever only that
// block referenced falls out of the bundle with it. Substitution is textual
// (`\bname\b`): the survey behind this file found every read to be a bare
// identifier — never a property, string key or alias — and the declaring
// module is skipped because it assigns the binding. Bun's transpiler could do
// the same scope-aware, but it strips the `@__NO_SIDE_EFFECTS__` and
// `@__PURE__` annotations the bundler needs to shake component templates.
//
// The compiled component code is not touched: only files under the svelte
// package go through this, and only the modules named in the table.

interface FoldedModule {
  /** Import specifier, as written in the importing file. */
  readonly source: RegExp;
  /** The module that declares (and may assign) the binding: never rewritten. */
  readonly declaredIn?: RegExp;
  /** Binding name -> literal source text. */
  readonly values: Readonly<Record<string, string>>;
}

export const SVELTE_FOLDED_MODULES: readonly FoldedModule[] = [
  {
    source: /^esm-env$/,
    values: { DEV: "false", BROWSER: "true" },
  },
  {
    source: /(?:^|\/)hydration\.js$/,
    declaredIn: /[\\/]internal[\\/]client[\\/]dom[\\/]hydration\.js$/,
    values: { hydrating: "false" },
  },
  {
    source: /(?:^|\/)flags\/index\.js$/,
    declaredIn: /[\\/]internal[\\/]flags[\\/]index\.js$/,
    values: {
      custom_renderers_flag: "true",
      async_mode_flag: "false",
      legacy_mode_flag: "false",
      tracing_mode_flag: "false",
    },
  },
];

const IMPORT = /import\s*\{([^}]*)\}\s*from\s*(['"])([^'"]+)\2\s*;?[ \t]*\n?/g;

/**
 * Fold the constants a PocketJS build fixes into `src`, a Svelte runtime
 * module at `path`. Returns undefined when the file imports none of them, so
 * the caller can let Bun load it untouched.
 */
export function foldSvelteConstants(
  path: string,
  src: string,
  modules: readonly FoldedModule[] = SVELTE_FOLDED_MODULES,
): string | undefined {
  const normalized = path.replace(/\\/g, "/");
  const folded: Record<string, string> = {};

  const rewritten = src.replace(IMPORT, (statement, list: string, _q, source: string) => {
    const table = modules.find(
      (m) => m.source.test(source) && !(m.declaredIn && m.declaredIn.test(normalized)),
    );
    if (!table) return statement;
    const kept: string[] = [];
    for (const raw of list.split(",")) {
      const spec = raw.trim();
      if (spec === "") continue;
      const [imported, alias] = spec.split(/\s+as\s+/);
      if (Object.hasOwn(table.values, imported)) {
        if (alias !== undefined) {
          throw new Error(
            `svelte-fold: ${path} imports ${imported} as ${alias}; the fold only substitutes bare bindings`,
          );
        }
        folded[imported] = table.values[imported];
      } else {
        kept.push(spec);
      }
    }
    if (kept.length === list.split(",").filter((s) => s.trim() !== "").length) return statement;
    return kept.length === 0 ? "" : `import { ${kept.join(", ")} } from '${source}';\n`;
  });

  const names = Object.keys(folded);
  if (names.length === 0) return undefined;
  const pattern = new RegExp(`\\b(?:${names.join("|")})\\b`, "g");
  return rewritten.replace(pattern, (name) => folded[name]);
}

// ---------------------------------------------------------------------------
// Function-body stubs
//
// What the fold cannot reach: functions that are unreachable on a PocketJS
// host for one of the reasons above, but whose callers test something other
// than a foldable binding — `flatten` checks `async.length`, `mount()`'s DOM
// delegation checks `!renderer`, and the hydration tails sit after an early
// `return` that Bun keeps. Bun cannot drop a declaration with a live
// reference, so the body goes instead: each function below keeps its
// signature and throws. Measured never entered across every demo journey; a
// wrong entry surfaces as a thrown error in those journeys, not as a wrong
// frame.
//
// Only top-level declarations are matched (column 0, closing brace at column
// 0, as Prettier formats the vendored source). `Batch.prototype.capture` is a
// different function from `reactivity/async.js#capture` and is not touched.

interface StubbedFunctions {
  /** The declaring module. */
  readonly module: RegExp;
  readonly names: readonly string[];
  /** The fact that closes every caller. */
  readonly why: string;
}

export const SVELTE_STUBBED_FUNCTIONS: readonly StubbedFunctions[] = [
  {
    module: /[\\/]internal[\\/]client[\\/]reactivity[\\/]deriveds\.js$/,
    names: ["async_derived"],
    why: "the compiler runs without experimental.async, so no component emits an await expression",
  },
  {
    module: /[\\/]internal[\\/]client[\\/]reactivity[\\/]async\.js$/,
    names: ["capture", "increment_pending", "unset_context"],
    why: "only flatten()'s async path and async_derived() call these, and neither runs without experimental.async",
  },
  {
    module: /[\\/]internal[\\/]client[\\/]dom[\\/]elements[\\/]events\.js$/,
    names: ["handle_event_propagation"],
    why: "DOM root event delegation; mount() always receives a renderer and create_event() bypasses it under one",
  },
  {
    module: /[\\/]internal[\\/]client[\\/]dom[\\/]operations\.js$/,
    names: ["merge_text_nodes", "insert_after"],
    why: "called only from the hydration tails of child(), first_child(), sibling() and text()",
  },
];

/**
 * Replace the bodies of the functions listed for `path` with a throw. Returns
 * undefined when `path` is not a listed module. Throws when a listed name is
 * not declared exactly once at the top level, so a vendor refresh that moves
 * or renames one fails the build instead of shipping a stale table.
 */
export function stubSvelteFunctions(path: string, src: string): string | undefined {
  const normalized = path.replace(/\\/g, "/");
  const table = SVELTE_STUBBED_FUNCTIONS.find((t) => t.module.test(normalized));
  if (!table) return undefined;
  let out = src;
  for (const name of table.names) {
    const head = `^((?:export )?(?:async )?function ${name}\\([^)]*\\)\\s*\\{)`;
    const declarations = out.match(new RegExp(head, "gm")) ?? [];
    if (declarations.length !== 1) {
      throw new Error(
        `svelte-fold: expected one top-level declaration of ${name}() in ${path}, found ${declarations.length}`,
      );
    }
    // A multi-line body ends at the first closing brace in column 0; a body
    // Prettier kept on one line ends at the last brace of that line.
    const whole = new RegExp(`${head}(?:\\n[\\s\\S]*?\\n\\}|[^\\n]*\\})(?=\\n|$)`, "m").exec(out);
    if (!whole) throw new Error(`svelte-fold: no closing brace for ${name}() in ${path}`);
    const stub = `${whole[1]}\n\tthrow new Error('svelte: ${name}() is unreachable on a PocketJS host');\n}`;
    out = out.slice(0, whole.index) + stub + out.slice(whole.index + whole[0].length);
  }
  return out;
}

/** The whole load-time treatment of one Svelte runtime file: fold, then stub. */
export function transformSvelteRuntime(path: string, src: string): string | undefined {
  const folded = foldSvelteConstants(path, src);
  const stubbed = stubSvelteFunctions(path, folded ?? src);
  return stubbed ?? folded;
}
