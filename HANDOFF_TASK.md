# Handoff: trimming the Svelte runtime further

## Why this exists

`REPORT.md` measures the built artifact for the same demo across Solid, Vue Vapor,
Octane and Svelte. Svelte's bundle is about **2x Solid's**, and nearly all of the
difference is the framework runtime: **111.4 KiB normalised** against Solid's
21.6 KiB on `cards`.

One round of trimming already landed (commit `1439db3`). This document is for the
next round, and it is aimed at one specific class of waste: **code that the import
graph says is reachable, but that nothing on a PocketJS host will ever call.**

## What has already been done

`svelte/internal/client/index.js` is a flat barrel. Compiled component output
imports from it, and it eagerly re-exports browser-DOM modules alongside the
reactivity core.

`framework/src/svelte-dom-stubs.ts` aliases three of them to stubs, wired in
`framework/compiler/jsx-plugin.ts` under `framework === "svelte"`:

| Removed | Why it could not be shaken out |
| --- | --- |
| `dom/elements/custom-element.js` | assigns at module scope inside `if (typeof HTMLElement === 'function')`, which no bundler can prove inert |
| `legacy/legacy-client.js` | line-1 import of the above |
| `dom/elements/bindings/input.js`, `bindings/size.js` | reachable from the barrel, never called |

**11,358 bytes raw per demo, 7.3 KiB of normalised runtime, and the last
`typeof HTMLElement` probe in the artifact.** The stubs shake out to nothing
because no call site survives.

**Module-level stubbing is now exhausted.** Everything still in the bundle is
either live, or dead code sitting *inside* a live module. That is why the next
round is harder.

## What is left, measured

`dom/*` in the Svelte `cards` bundle totals **38.3 KiB normalised**:

| Module | Size | Status |
| --- | ---: | --- |
| `dom/blocks/each.js` | 9.3 KiB | **live** — keyed each blocks |
| `dom/operations.js` | 7.1 KiB | **mixed** — node walking is live, element/attribute creation is not |
| `dom/blocks/boundary.js` | 7.1 KiB | **live** — error boundaries |
| `dom/template.js` | 2.9 KiB | **mixed** — `append`/`text`/`comment` live, `from_html`/`from_svg`/`from_mathml` not |
| `dom/blocks/branches.js` | 2.8 KiB | **live** |
| `dom/elements/attributes.js` | 2.6 KiB | **candidate** |
| `dom/elements/events.js` | 1.9 KiB | **candidate** |
| `dom/hydration.js` | 1.1 KiB | **candidate** — nothing hydrates on a device |
| `dom/blocks/snippet.js` | 1.0 KiB | **live** |
| `dom/elements/class.js` | 0.7 KiB | **live** — see below |
| `dom/blocks/if.js`, `key.js`, `task.js`, `reconciler.js` | 1.3 KiB | **live** |
| `dom/elements/bindings/shared.js`, `attachments.js` | 0.5 KiB | **live** — see below |

### Do not touch these

The compiled output of `framework/src/svelte/View.svelte`, `Text.svelte` and
`Image.svelte` calls **`set_class`** (from `dom/elements/class.js`) and
**`attach`** (from `dom/elements/attachments.js`). Svelte's compiler lowers
`class={…}` and `{@attach …}` to those primitives, and PocketJS drives them
against the native tree. They look DOM-shaped and are not.

Compiled app components call **`append`, `first_child`, `sibling`, `text`,
`comment`, `next`** — the node-walking half of `operations.js` and `template.js`.
The custom renderer supplies the nodes; the walking API is shared.

## The two shapes of dead-but-reachable code

### 1. Dead branches behind mutable runtime flags

`svelte/src/internal/flags/index.js` declares its flags as **mutable `let`
bindings** set by `enable_*_flag()` at runtime:

```js
export let custom_renderers_flag = false;
export function enable_custom_renderers_flag() { custom_renderers_flag = true; }
```

So every `if (custom_renderers_flag)` and `if (hydrating)` is a runtime branch no
bundler can fold, even though the value is fixed for every PocketJS build. Reads
surviving in the `cards` bundle: `hydrating` 33, `custom_renderers_flag` 22,
`async_mode_flag` 9, `tracing_mode_flag` 8, `legacy_mode_flag` 6.

**Measured, and this is the point: folding all of them saves 1,098 bytes — 1.0% of
the minified artifact.** The guarded blocks are small. To reproduce: take a built
bundle, rewrite `if (hydrating)` → `if (false)` and
`if (custom_renderers_flag)` → `if (true)`, minify both copies, diff the sizes.

**Do not start here.** It is the most visible lever and close to the smallest.

### 2. Dead functions inside live modules

This is where the remaining bytes are. `operations.js` and `template.js` each hold
a live half and a dead half. `set_attribute` is called only from `template.js`,
`class.js` and `attributes.js` — all Svelte-internal DOM code, none of it entered
under a custom renderer. `create_element` is called only from `template.js`.

Module aliasing cannot express this. The unit of work is the function.

## How to chase it

### Recommended: empirical coverage over the existing journey tests

The repo already renders every Svelte demo frame by frame — `bun tools/test.ts
--stage=svelte` runs 25 unit and 42 journey tests. Use that as the driver rather
than trusting static analysis:

1. Build a Svelte demo with each suspect function instrumented to record entry
   (a module-scope `Set` plus a `globalThis` drain hook).
2. Run the journey tests and the launcher/3ds sims.
3. Anything never entered across every demo is dead in practice.
4. Alias or patch it out, re-run, confirm identical frames.

The journeys assert frame hashes, so a wrongly removed path shows up as a diff
rather than a silent visual regression.

### Static analysis, if you prefer it

Build a scope-aware call graph over the built bundle with roots at the compiled app
entry and `framework/src/renderer-svelte.ts`, then mark unreachable function
declarations. Do **not** do this by name matching — see the pitfalls.

### Making the fix

Follow the existing pattern: a stub module plus an `onResolve` rule in
`framework/compiler/jsx-plugin.ts` under `framework === "svelte"`, as
`framework/src/svelte-dom-stubs.ts` and `framework/src/octane-profiling-stub.ts`
already do. Keep stubs **throwing**, not silent: a wrong removal then fails loudly
in the journey tests instead of rendering the wrong thing.

For dead code inside a live module, module aliasing will not work. Options, in
increasing order of commitment: a targeted `onLoad` transform for that one file, a
patch carried in `tools/vendor-svelte.ts`, or a change upstream.

## Pitfalls, all of them hit during the first round

- **The bundler renames on collision.** `text` → `text2`, `mount` → `mount2`,
  `sibling` → `sibling2`, and so on. Grepping a source-level name against the
  bundle under-reports call sites, with no error to tell you. Every name-based liveness check in this
  investigation had to be thrown away.
- **One-level reachability is misleading.** "Something calls `set_attribute`" does
  not make it live; the callers may themselves be dead. Reachability has to be
  computed transitively from real roots.
- **`sideEffects` is a red herring.** Adding `"sideEffects": false` to svelte's
  `package.json` saves **180 bytes**. Bun's shaking is already working; the code is
  genuinely reachable. Do not spend time here.
- **`bun test` needs the resolve conditions.** Without
  `--conditions=custom-renderer --conditions=production` you get
  `custom_renderer_unavailable_on_server` from `svelte/renderer`, which looks like
  a real failure and is not. `bun tools/test.ts --stage=svelte` sets them.
- **`dist/` filenames do not match their contents.** Plan-driven builds drop the
  framework suffix, and `tools/build.ts` defaults to Solid when `--framework` is
  omitted. Always build to a scratch `--outdir`.
- **Do not redirect stderr when regenerating `REPORT.md`.** An unescaped backtick in
  the report template threw a syntax error, the run left the previous report in
  place, and the stale numbers looked plausible.
- **`tests/idf-incremental.test.ts` fails locally** with
  `Executable not found in $PATH: "cmake"`. Pre-existing and environmental.

## Verification bar

A change is done when all of these pass:

```sh
bun tools/test.ts --stage=svelte     # 25 unit + 42 journeys, frame hashes
bunx tsc --noEmit
bun run bundle-size                  # regenerates REPORT.md; diff the numbers
```

The other stages (`vue-sfc journeys`, `octane smoke`, `clear journeys`, the sims)
should stay green — the plugin rule is scoped to `framework === "svelte"`, so a
regression there means the scoping broke.

Device e2e (`bun run e2e`, `bun run e2e:3ds`) is the strongest check and needs a PSP
toolchain plus PPSSPP headless, which is not installed on this machine.

## Upstream

The vendored Svelte is a build of **sveltejs/svelte#18511**, the unreleased
custom-renderer PR, pinned as `vendor/svelte-5.57.0-6be4ab9.tgz` and refreshed by
`tools/vendor-svelte.ts`. Every local workaround has to survive that refresh, so
prefer fixing things upstream where it is reasonable:

1. **A `custom-renderer` variant of `internal/client/index.js`** that omits the DOM
   re-exports. `package.json` already resolves `.`, `./legacy`, `./reactivity`,
   `./renderer` and `./store` per condition; the internal barrel does not.
2. **`dom/elements/custom-element.js` wants its top-level block made DCE-friendly**
   so it does not pin itself and drag `legacy-client.js` along.
3. **Build-time flags.** If `custom_renderers_flag` and friends were `define`-able
   constants rather than mutable `let`s, custom-renderer builds could fold the DOM
   branches. Worth raising for correctness and clarity, but size-wise it is the
   1.0% lever — say so honestly when filing.
