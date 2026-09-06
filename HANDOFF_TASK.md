# Handoff: trimming the Svelte runtime further

## Why this exists

`REPORT.md` measures the built artifact for the same demo across Solid, Vue Vapor,
Octane and Svelte. Svelte's bundle is the largest of the four against Solid, and
nearly all of the difference is the framework runtime.

Four rounds have landed. This document records all four, corrects the claims the
first round's handoff made, and says what is left and what it is worth.

## Round 1 (commit `1439db3`): module aliasing

`svelte/internal/client/index.js` is a flat barrel that eagerly re-exports
browser-DOM modules alongside the reactivity core. `framework/src/svelte-dom-stubs.ts`
aliases three of them to throwing stubs, wired in `framework/compiler/jsx-plugin.ts`
under `framework === "svelte"`: `dom/elements/custom-element.js` (pins itself with a
`typeof HTMLElement` block at module scope and drags `legacy/legacy-client.js` in),
`dom/elements/bindings/input.js` and `bindings/size.js`. 11,358 bytes raw per demo.

## Round 2 (commit `c25d18b`): folding build-time constants

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

## Round 3 (commit `798c44d`): function-body stubs

### What was found

After the fold, 67 functions in the Svelte part of the `cards` bundle were still
never entered across every demo journey. Reading each call site sorted them into
two kinds: closed by a fact PocketJS controls, or merely not exercised. Only the
first kind is safe to remove, and it is small: the callers test something no
constant expresses (`flatten` checks `async.length`, `mount()`'s DOM delegation
checks `!renderer`, the hydration tails sit after an early `return` Bun keeps), so
the fold could not reach them and Bun cannot drop a declaration with a live
reference.

**Correction to the sizes quoted while chasing this.** The per-function ranking
measured whitespace-stripped bytes, not renamed-minified ones. The 7 KB estimate
for this lever was normalised; minified it is 1.7 KiB.

### What was done

`SVELTE_STUBBED_FUNCTIONS` in `framework/compiler/svelte-fold.ts` names seven
top-level functions in four files. `stubSvelteFunctions` replaces each body with a
throw and keeps the signature; `transformSvelteRuntime` runs the fold and then the
stubs, and is what the plugin's onLoad rule calls. A listed name that is not
declared exactly once at column 0 fails the build, so a vendor refresh that moves
or renames one cannot ship a stale table. `tests/svelte-compile.test.ts` also
checks every entry against the vendored source.

| Function | File | Why every caller is closed |
| --- | --- | --- |
| `async_derived` | `reactivity/deriveds.js` | compiler runs without `experimental.async` |
| `capture`, `increment_pending`, `unset_context` | `reactivity/async.js` | only `flatten`'s async path and `async_derived` call them |
| `handle_event_propagation` | `dom/elements/events.js` | DOM root delegation; `mount()` always has a renderer, `create_event` bypasses it under one |
| `merge_text_nodes`, `insert_after` | `dom/operations.js` | hydration tails of `child`, `first_child`, `sibling`, `text` |

Left out on purpose:

- **`add_event_listener`, `remove_event_listener`.** Dead in the demos, but `$.event()`
  reaches them for an `onpress` written on a raw `<view>`, which the renderer
  supports. Not closed by construction.
- **`run`, `finish`.** Nested inside `flatten`; the matcher takes top-level
  declarations only, and `Batch.prototype.capture` shows why that matters.
- **`get_label`, `tag`, `tag_proxy`.** Dev-only, pinned by `update_path`, a nested
  declaration inside `proxy()` that Bun cannot remove. Under 300 bytes net.
- **Everything reachable by a user app**: `move_effect` (keyed reorder),
  `class_list_toggle` (`class:` directives), `invoke_error_boundary`,
  `infinite_loop_guard`, `unmount`, `flush_eager_effects`, the `Batch` merge helpers.

### Measured, `cards`, Svelte runtime slice

| | raw | normalised | minified | gzip |
| --- | ---: | ---: | ---: | ---: |
| after round 2 | 129.8 KiB | 90.7 KiB | 45.0 KiB | 17.3 KiB |
| after round 3 | 123.3 KiB | 86.3 KiB | 43.3 KiB | 16.6 KiB |
| Solid, same demo | 31.7 KiB | 21.6 KiB | 12.6 KiB | 4.9 KiB |

`REPORT.md`: `cards` 248.9 → 242.4 KiB raw, 98.3 → 96.6 KiB min, 34.8 → 34.1 KiB
gzip. Six demos, Svelte against Solid: **1.87x → 1.82x** raw, **1.60x → 1.56x**
gzipped. Runtime against runtime, minified, geometric mean over the six: 3.54x →
3.40x.

## Round 4 (this commit): the library primitives write props themselves

`View`, `Text`, `Image`, `Sprite` and `CompositorSurface` carried `class`,
`focusable`, `debugName`, `src`, `sprite`, `package` and `focused` as element
attributes, so the compiler emitted a `template_effect` calling `set_class` and
`set_attribute` per instance, and those pulled `dom/elements/class.js`,
`dom/elements/attributes.js`, `shared/attributes.js` and `clsx` into every bundle
for work `setProp` already does. Each primitive now writes every host prop from
one attachment through `applyHostProps` (`framework/src/svelte/props.ts`); the
`nodeRef` attachment stays separate so it still fires once, after the props.
No app touches a raw host element, so nothing else referenced that machinery and
it shook out.

Measured, `cards`, Svelte runtime slice: 86.3 → 83.1 KiB normalised, 43.3 → 41.7
KiB minified. Each primitive instance creates two effects instead of three.
`REPORT.md`: `cards` 242.4 → 237.1 KiB raw; six demos against Solid **1.82x →
1.78x** raw, **1.56x → 1.53x** gzipped. `TABLE.md` holds the per-framework
comparison with the compiled components included.

What is left in the adapter is not adapter fat: `index-svelte.ts` is the same
size as Solid's entry, and `renderer-svelte.ts` is the fragment and comment
plumbing Svelte's renderer contract requires, which Solid keeps inside
`universal.js` instead.

## What is left, and what it is

Before round 2, 96 function declarations in the Svelte part of the bundle were never
entered across every demo journey, 28.5 KB normalised. Rounds 2 and 3 took the ones
closed by construction. What remains falls into shapes that are **not dead by
construction**:

- **Error paths**: `errors.js` factories, `error-handling.js` (`handle_error`,
  `invoke_error_boundary`), `infinite_loop_guard`. Reachable from any app that
  throws in an effect or writes a bad key. Keep.
- **Reachable-in-principle branches** inside live functions: `class_list_toggle`
  (`class:` directives), `clear_text_content` (controlled each blocks), `unmount`,
  `teardown`, `mutable_source`. Keep.
- **Async-mode plumbing inside live functions**: the async path of `flatten`, the
  fork, merge and skip paths of `Batch`, `mark_effects`, `depends_on`. Round 3 emptied
  the helpers they call; the branches themselves stay because no constant closes
  them. This is an upstream item.

Module-level stubbing, constant folding and function-body stubbing are all
exhausted. What remains is code a user app can reach, or branches inside `Batch`,
`Boundary` and `operations.js` that only upstream can restructure. On `cards` the
Svelte runtime is 3.4x Solid's minified; the gap is the scheduler, the blocks and the
root boundary, which are what Svelte 5 is.

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
bun tools/test.ts --stage=svelte     # 39 unit + 42 journeys, frame hashes
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
long as the six folded names stay bare identifiers imported from the same three
modules and the seven stubbed functions stay top-level declarations in the same four
files; the build, the unit tests and the journeys each catch a change.

Worth raising:

1. **A `custom-renderer` variant of `internal/client/index.js`** that omits the DOM
   re-exports (round 1's stubs go away).
2. **`dom/elements/custom-element.js` wants its top-level block made DCE-friendly.**
3. **Build-time flags.** `DEV` cannot be folded by any bundler as an imported binding;
   Svelte's own build could inline it or expose the flags as `define`-able globals.
   Measured here at 15 KiB of runtime on `cards` for `DEV` alone. That is the number
   to lead with.
4. **`flatten` and `Batch`** could check `async_mode_flag` before their async paths,
   which would let a non-async build drop them and make round 3's async rows
   unnecessary. About 4 KB normalised of branches beyond what round 3 removed.
