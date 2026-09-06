# Handoff: trimming the Svelte runtime further

## Why this exists

`REPORT.md` measures the built artifact for the same demo across Solid, Vue Vapor,
Octane and Svelte. Svelte's bundle is the largest of the four against Solid, and
nearly all of the difference is the framework runtime.

Two rounds have landed. This document records both, corrects the claims the first
round's handoff made, and says what is left and what it is worth.

## Round 1 (commit `1439db3`): module aliasing

`svelte/internal/client/index.js` is a flat barrel that eagerly re-exports
browser-DOM modules alongside the reactivity core. `framework/src/svelte-dom-stubs.ts`
aliases three of them to throwing stubs, wired in `framework/compiler/jsx-plugin.ts`
under `framework === "svelte"`: `dom/elements/custom-element.js` (pins itself with a
`typeof HTMLElement` block at module scope and drags `legacy/legacy-client.js` in),
`dom/elements/bindings/input.js` and `bindings/size.js`. 11,358 bytes raw per demo.

## Round 2 (this commit): folding build-time constants

### What was found

The first handoff pointed at dead functions inside live modules and estimated the
runtime-flag lever at 1.0%. Empirical coverage over the journey tests (procedure
below) showed a different picture:

- **`if (DEV)` never folded.** Svelte imports `DEV` from `esm-env`; the `production`
  resolve condition maps it to `false.js`, and Bun bundles that as
  `var false_default = false` and keeps every `if (false_default) { … }` block. Bun
  folds literal conditions only. It does **not** inline an imported binding, whether
  the export is `let`, `const` or `default` (tested on a three-module fixture, with
  and without `minify`). 85 guards survived in the `cards` bundle, plus the dev-only
  functions they referenced: stack capture, labels, tracing tags, dev warnings.
- **The same applies to `hydrating` and the `flags/index.js` lets.** They are fixed
  for every PocketJS build: `mount()` never sets `hydrating`; `svelte/renderer`
  enables `custom_renderers_flag` at import; the compiler wrapper runs with
  `runes: true`, `dev: false` and no `experimental.async`, so nothing ever enables
  the legacy, tracing or async flags.
- **The first handoff's static claims were wrong in places.** `create_element` and
  `operations.js#set_attribute` are live: `fragment_from_tree` calls both for every
  template element and its static attributes. `from_html`, `from_svg`, `from_mathml`
  and `with_script` were already shaken out of every bundle. The 1,098-byte flag
  estimate was made by rewriting a built bundle and minifying it; the minifier does
  not remove top-level function declarations inside the IIFE, so it measured the
  emptied blocks and not what they had pinned.

### What was done

`framework/compiler/svelte-fold.ts` holds a table of `{ import source, declaring
module, name → literal }` and one function, `foldSvelteConstants(path, src)`. An
`onLoad` rule in `jsx-plugin.ts` (filter: every `.js` under `node_modules/svelte/src`,
`framework === "svelte"` only) runs each runtime file through it. The transform drops
the folded names from the `import { … } from '<module>'` that carries them and
substitutes the literal for every remaining `\bname\b`. Bun then sees `if (false) { … }`
and drops the block, and the functions only that block referenced fall out with it.

| Constant | From | Value | Why it is fixed |
| --- | --- | --- | --- |
| `DEV`, `BROWSER` | `esm-env` | `false`, `true` | `production` + `browser` conditions |
| `hydrating` | `dom/hydration.js` | `false` | only `hydrate()` sets it |
| `custom_renderers_flag` | `flags/index.js` | `true` | `svelte/renderer` enables it at import |
| `async_mode_flag`, `legacy_mode_flag`, `tracing_mode_flag` | `flags/index.js` | `false` | compiler runs without async, with runes, without dev |

Design notes, each hit while building it:

- **Substitution is textual, not scope-aware, on purpose.** `Bun.Transpiler` with
  `define` does this scope-aware but strips the `@__NO_SIDE_EFFECTS__` and
  `@__PURE__` annotations the bundler uses to shake component templates
  (`var root = from_tree(…)` at module scope). A survey of the runtime found every
  read of these names to be a bare identifier — never a property, string key or
  alias — and the unit tests in `tests/svelte-compile.test.ts` pin the shapes.
  The declaring module is skipped because it assigns the binding; an aliased import
  throws rather than substituting the wrong name.
- **`if (!flag) return x; …` tails survive.** Bun turns it into `if (true) { return x }`
  and keeps the unreachable code after it, so `merge_text_nodes`, `insert_after` and
  `set_hydrate_node` stay pinned through `child`/`first_child`/`sibling`. Small.
- **The server-side `internal/server/hydration.js` shares the file name.** The table
  matches the declaring module by full path and the transform only sees files Bun
  loads, which never include the server build.

### Measured, `cards`, normalised Svelte runtime

| Step | Runtime | Delta |
| --- | ---: | ---: |
| after round 1 | 111.4 KiB | |
| + `DEV`/`BROWSER` | 96.2 KiB | −15.2 KiB |
| + `hydrating` | 92.2 KiB | −4.0 KiB |
| + the four flags | 90.7 KiB | −1.5 KiB |

`REPORT.md` (regenerated): `cards` 275.6 → 248.9 KiB raw, 111.8 → 98.3 KiB min,
39.2 → 34.8 KiB gzip. Over six demos Svelte went from **2.06x to 1.87x Solid** raw and
**1.79x to 1.60x** gzipped. The runtime is now 4.2x Solid's on `cards`, down from 5.2x.

### Measured and rejected

Both were tried as one-line patches to the vendored source, built, and measured
against the folded `cards` bundle, then reverted.

| Candidate | Saving | Why not |
| --- | ---: | --- |
| `render.js#_mount_inner`: fold the `if (!renderer)` DOM event-delegation branch | 938 B | the teardown loop keeps `handle_event_propagation` referenced; a string patch on one upstream file for under 1 KiB |
| `reactivity/async.js#flatten`: drop the async half | 32 B | `async_derived`, `capture`, `restore` are pinned from other live functions' unentered branches, not from `flatten` |

## What is left, and what it is

After the fold, 96 function declarations in the Svelte part of the bundle were never
entered across every demo journey (28.5 KB minified before the fold; most of the
dev, hydration and flag-guarded ones are gone now). What remains falls into shapes
that are **not dead by construction**:

- **Error paths**: `errors.js` factories, `error-handling.js` (`handle_error`,
  `invoke_error_boundary`), `infinite_loop_guard`. Reachable from any app that
  throws in an effect or writes a bad key. Keep.
- **Reachable-in-principle branches** inside live functions: `class_list_toggle`
  (`class:` directives), `clear_text_content` (controlled each blocks), `unmount`,
  `teardown`, `mutable_source`. Keep.
- **Async-mode machinery** pinned by unentered branches of live functions:
  `async_derived` (2.1 KB), `capture`/`restore`/`unset_context`/`increment_pending`
  (~2 KB), `batch.js#mark_effects`/`depends_on`. By construction unreachable without
  `experimental.async`, but there is no constant to fold: `flatten` checks array
  lengths, not the flag. This is an upstream item.

Nothing here is a stub-and-alias job. Module-level stubbing and constant folding are
both exhausted; what remains is the function-level surgery the first handoff
described, on code that a user app can reach.

## How this was chased: empirical coverage

The journey tests eval every built Svelte bundle with indirect `eval` in the Bun
process (`hosts/sim/sim.ts`), so a probe written into the bundle lands on Bun's
`globalThis`. The procedure, reproducible in an afternoon:

1. Build all ten demos into `dist/` (the `svelte journeys` prep commands).
2. Post-process each `dist/*.svelte.js`: split at the `  // <path>` module markers,
   and for every `function name(…) {` inside a `node_modules/svelte/` region insert
   `(globalThis.__svcov ??= new Set()).add("<module>#<name>");` after the brace.
   Walk the parameter list by paren depth (defaults contain `{}` and quotes) and
   skip matches whose next token is not `{`. Record the site list.
3. Run the journeys with a `--preload` file that calls `afterAll` from `bun:test`
   and appends the set to a file. **`process.on("exit")` never fires under `bun
   test`; `afterAll` in the preload does.** Flags as the stage uses them:
   `bun test --conditions=browser --preload <drain> tests/svelte-*.test.ts
   tests/wolfensvelte.test.ts`, then the same for `tests/audio-sim.test.ts` and
   `tests/wolfensvelte-audio.test.ts`.
4. Sites minus covered, per module. Size each dead function by extracting its body
   from the unminified bundle and passing it through
   `new Bun.Transpiler({ minifyWhitespace: true })`.

The instrumented bundles pass every journey, so the probes are behaviour-neutral, and
`hosts/sim/sim.ts` only checks that a bundle exists, so it does not rebuild over them.

## Pitfalls, all of them hit

- **The bundler renames on collision.** `text` → `text2`, `set_attribute` →
  `set_attribute2`, `import_node` → `import_node2`. Name-based liveness checks
  against the bundle under-report with no error.
- **One-level reachability is misleading.** A dead caller keeps its callees in the
  bundle; reachability is transitive from real roots.
- **`sideEffects: false` on svelte's `package.json` saves 180 bytes.** Bun's shaking
  already works; the code is reachable.
- **Post-hoc minification does not shake.** Rewriting a built IIFE and minifying it
  measures emptied blocks, not what they pinned. Measure through the build.
- **`bun test` needs the resolve conditions.** Without
  `--conditions=custom-renderer --conditions=production` you get
  `custom_renderer_unavailable_on_server` from `svelte/renderer`.
  `bun tools/test.ts --stage=svelte` sets them.
- **`dist/` filenames do not match their contents.** `tools/build.ts` defaults to
  Solid when `--framework` is omitted. Build to a scratch `--outdir` when measuring.
- **Builds race on `framework/src/styles.generated.ts`.** Never run two concurrently.
- **Do not redirect stderr when regenerating `REPORT.md`.** A template error leaves
  the previous report in place with plausible stale numbers.
- **`tests/idf-incremental.test.ts` fails locally** with
  `Executable not found in $PATH: "cmake"`. Pre-existing and environmental.

## Verification bar

```sh
bun tools/test.ts --stage=svelte     # 33 unit + 42 journeys, frame hashes
bunx tsc --noEmit
bun run bundle-size                  # regenerates REPORT.md; diff the numbers
```

The other stages (`compiler smoke`, `vue-sfc journeys`, `clear journeys`, `octane
smoke`, the sims) stay green; the plugin rules are scoped to `framework === "svelte"`,
so a regression there means the scoping broke.

Device e2e (`bun run e2e`, `bun run e2e:3ds`) is the strongest check and needs a PSP
toolchain plus PPSSPP headless, which is not installed on this machine.

## Upstream

The vendored Svelte is a build of **sveltejs/svelte#18511**, pinned as
`vendor/svelte-5.57.0-6be4ab9.tgz` and refreshed by `tools/vendor-svelte.ts`. Every
local workaround has to survive that refresh. `svelte-fold.ts` survives a refresh as
long as the six names stay bare identifiers imported from the same three modules; the
unit tests and the journeys catch a change to either.

Worth raising:

1. **A `custom-renderer` variant of `internal/client/index.js`** that omits the DOM
   re-exports (round 1's stubs go away).
2. **`dom/elements/custom-element.js` wants its top-level block made DCE-friendly.**
3. **Build-time flags.** `DEV` cannot be folded by any bundler as an imported binding;
   Svelte's own build could inline it or expose the flags as `define`-able globals.
   Measured here at 15 KiB of runtime on `cards` for `DEV` alone. That is the number
   to lead with.
4. **`flatten`'s async path** could check `async_mode_flag` before the array lengths,
   which would let a non-async build drop `async_derived` and the async helpers
   (~4 KB minified).
