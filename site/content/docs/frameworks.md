# Frameworks

PocketJS supports four app frameworks over the same native tree and Rust
core:

| Framework | Build id | Component transform | Runtime renderer | Output suffix |
|---|---|---|---|---|
| Solid | `solid` | `babel-preset-solid` universal mode | `renderer-solid.ts` | none |
| Vue Vapor | `vue-vapor` | `vue-jsx-vapor` | `renderer-vue-vapor.ts` | `.vue-vapor` |
| Octane | `octane` | Octane universal compiler (host plans + slots) | `renderer-octane.ts` (pocket universal driver over the native tree) | `.octane` |
| Svelte | `svelte` | Svelte's custom-renderer compiler (`experimental.customRenderer`) | `renderer-svelte.ts` | `.svelte` |

Solid is the default so existing apps keep building to `dist/<app>.js` and
`dist/<app>.pak`. The others build next to it:

```sh
bun tools/build.ts hero-main                    # dist/hero-main.js
bun tools/build.ts hero-vue-vapor-main --framework=vue-vapor
# dist/hero-vue-vapor-main.vue-vapor.js
bun tools/build.ts hero-main --framework=octane
# dist/hero-main.octane.js
bun tools/build.ts hero-main --framework=svelte
# dist/hero-main.svelte.js
```

Sibling variant files select on their own: an `app.octane.tsx` (or
`app.vue-vapor.tsx`) next to `app.tsx` is picked up when building with the
matching `--framework`, which is how one demo directory carries all of its
ports. The showcase demos each ship an `app.octane.tsx` and a
`main.octane.tsx` beside the Solid originals; `ls apps/*/app.octane.tsx` names
the current set. **Svelte's variant of a TypeScript module is `<name>.svelte.ts`**,
which is also Svelte's own spelling for a runes module, so a ported demo carries
`app.svelte` and `main.svelte.ts`.

There is no environment-variable switch for framework selection. Product
builds declare it in `pocket.json`; low-level compiler work can still use a
project config or one-command override.

## Manifest selection

```json
{
  "app": {
    "framework": "solid"
  }
}
```

Use `"vue-vapor"` for the Vue adapter, `"octane"` for Octane and `"svelte"`
for Svelte.
`pocket check|compile|build --target …`
resolves this value once and all framework/compiler/native stages consume the same plan.
Do not also put `framework` in `pocket.config.ts` for a manifest build.

## Low-level project config

`pocket.config.ts` is the low-level script default:

```ts
import { definePocketConfig } from "@pocketjs/framework/config";

export default definePocketConfig({
  framework: "solid",
});
```

`framework` takes the same four build ids as the manifest.

The direct framework/compiler/dev scripts read the config by default. Use
`--framework=solid`, `--framework=vue-vapor`, `--framework=octane` or
`--framework=svelte` to override it for one invocation. `--config=<path>` selects a different config
file, and `--no-config` ignores config entirely.

The same flag works through the dev and PSP entry points:

```sh
bun tools/dev.ts --framework=vue-vapor hero-vue-vapor-main
bun tools/dev.ts --framework=octane hero-main
bun tools/dev.ts --framework=svelte hero-main
bun tools/psp.ts hero-vue-vapor --framework=vue-vapor --release
```

## Framework app imports

Apps import state and component lifecycle from the selected framework directly.
PocketJS does not wrap `createSignal`, `ref`, `useState`, `$state`, `onMount`,
`onMounted`, or `useEffect`.

A Solid app:

```tsx
import { mount, frameworkName } from "@pocketjs/framework/solid";
import { View, Text, type NodeMirror } from "@pocketjs/framework/solid/components";
import { createSignal, onMount, Show } from "solid-js";

export default function App() {
  const [count, setCount] = createSignal(0);
  let marker: NodeMirror | undefined;

  onMount(() => {
    console.log(frameworkName(), marker?.id);
  });

  return (
    <View class="p-4 flex-col gap-2">
      <Text class="text-base text-slate-950">Framework: {frameworkName()}</Text>
      <View nodeRef={(node) => (marker = node ?? undefined)} focusable onPress={() => setCount(count() + 1)}>
        <Text class="text-sm text-blue-600">Count: {count()}</Text>
      </View>
      <Show when={count() > 2}>
        <Text class="text-sm text-emerald-600">Solid, native tree.</Text>
      </Show>
    </View>
  );
}

mount(() => <App />);
```

The Svelte port writes the same tree as a `.svelte` component:

```svelte
<script lang="ts">
  import { frameworkName } from "@pocketjs/framework/svelte";
  import { Text, View, type NodeMirror } from "@pocketjs/framework/svelte/components";
  import { onMount } from "svelte";

  let count = $state(0);
  let marker: NodeMirror | undefined;

  onMount(() => console.log(frameworkName(), marker?.id));
</script>

<View class="p-4 flex-col gap-2">
  <Text class="text-base text-slate-950">Framework: {frameworkName()}</Text>
  <View nodeRef={(node: NodeMirror) => (marker = node)} focusable onPress={() => count++}>
    <Text class="text-sm text-blue-600">Count: {count}</Text>
  </View>
  {#if count > 2}
    <Text class="text-sm text-emerald-600">Svelte, native tree.</Text>
  {/if}
</View>
```

Its entry is an ordinary TypeScript module, because a manifest's `app.entry`
takes `.ts`/`.tsx` only:

```ts
import { mount } from "@pocketjs/framework/svelte";
import App from "./app.svelte";

mount(App);
```

The Vue Vapor, Octane and Svelte ports of that app render the same tree from the
same `View`/`Text` components. What changes is the state syntax and where it is
imported from:

| | Solid | Vue Vapor | Octane | Svelte |
|---|---|---|---|---|
| State | `const [c, setC] = createSignal(0)` | `const c = ref(0)` | `const [c, setC] = useState(0)` | `let c = $state(0)` |
| Read in markup | `{c()}` | `{c.value}` | `` {`${c}`} `` — mixed static + dynamic text is one template literal | `{c}` |
| Mount hook | `onMount` | `onMounted` | `useLayoutEffect(fn, [])` | `onMount` |
| State import | `solid-js` | `vue` | `octane` | none — `$state` is a compiler rune |
| Runtime import | `@pocketjs/framework/solid` | `@pocketjs/framework/vue-vapor` | `@pocketjs/framework/octane` | `@pocketjs/framework/svelte` |
| Entry call | `mount(() => <App />)` | `mount(App)` | `mount(App)` | `mount(App)` |

`nodeRef` takes a callback on all four. Solid also supports `ref`; `nodeRef`
avoids framework-specific ref semantics in examples meant to read the same way
across frameworks.

The generic public subpaths remain Solid-first defaults. Use explicit framework
subpaths when an example or app is tied to a framework:

| Import | Solid build | Vue Vapor build | Octane build | Svelte build |
|---|---|---|---|---|
| `@pocketjs/framework` | `framework/src/index.ts` | `framework/src/index-vue-vapor.ts` | `framework/src/index-octane.ts` | `framework/src/index-svelte.ts` |
| `@pocketjs/framework/components` | `framework/src/components.ts` | `framework/src/components-vue-vapor.ts` | `framework/src/components-octane.tsx` | `framework/src/components-svelte.ts` |
| `@pocketjs/framework/lifecycle` | Solid lifecycle hooks | Vue Vapor lifecycle hooks | Octane lifecycle hooks (`useFrame`, `useButtonPress`, `useSpriteAnimation`) | Svelte lifecycle hooks |

Not every subpath resolves under every framework. `framework/compiler/subpaths.ts`
is the registry, and it declares:

- **`gesture` and `kinetics` resolve under Solid, Vue Vapor and Svelte.** The
  recognizer and scroller machinery lives in framework-neutral core modules;
  each of the three frameworks gets a thin shim that binds disposal to its own
  lifecycle.
- **`osk` and `virtual-list` resolve under Solid only.** Nothing else is
  meant to reach their Solid-flavored implementations.
- **What a framework does not resolve is not walked in pass 1**, so class
  strings from another framework's module never enter this build's
  `styles.bin`. The bare specifier still carries an npm export pointing at
  the Solid file, so an Octane build importing `@pocketjs/framework/gesture`
  compiles against the Solid module — which the Octane entry never pumps (see
  [What stays shared](#what-stays-shared)).

## Reactivity on PocketJS

PocketJS wraps no reactive system: each framework brings its own, and the
runtime adds four rules on top — when a handler's write commits, which imports
the Solid lint rejects, the scheduler globals QuickJS lacks, and why continuous
motion does not come from per-frame state.
[Reactivity](/docs/reactivity/) puts the four side by side and states all four.

## Octane notes

Octane is React's programming model, compiled: hooks and JSX, no VDOM. Hooks
(`useState`, `useEffect`, `useMemo`, `useRef`, `useLayoutEffect`,
`useEffectEvent`, …) import from `octane`. Dependency arrays may be omitted —
the compiler infers them from captures. Hooks are tracked by call site, so a
hook inside an `if` block is fine, but hooks in loops are not. PocketJS's
per-frame hooks follow the same rule: they are `useFrame`, `useButtonPress`,
and `useSpriteAnimation` (from `@pocketjs/framework/octane/lifecycle` or the
generic `lifecycle` subpath), use-prefixed because the Octane compiler
slot-keys custom hooks by the `use[A-Z]` naming convention.
(`pushButtonHandlerBlock` is not a hook and keeps its name.)

At build time, Octane's universal compiler lowers JSX to static host plans
plus dynamic slots against the "pocket" renderer; at runtime the compiled
imports retarget to `@pocketjs/framework/octane/renderer`, whose driver maps
host command batches onto the native `ui.*` tree. Vue Vapor gets a micro-DOM
shim; Octane gets none.

Authoring rules specific to Octane apps:

- **The entry passes the component itself.** `main.octane.tsx` must call
  `mount(App)` — JSX inside a call-argument arrow (`mount(() => <App />)`) is
  a universal-target compile error.
- **Mixed static + dynamic text is one template literal.** Write
  ``<Text>{`Count: ${count}`}</Text>``, not `<Text>Count: {count}</Text>` —
  the compiler drops trailing whitespace on a static segment that precedes an
  expression.
- **`class` stays full literals or ternaries of full literals**, as in
  the other frameworks.
- **Counters driven from `useFrame` use functional updates**
  (`setX((v) => v + 1)`): a same-frame handler's state write would otherwise
  be clobbered by a stale read.
- **Keep natively `animate()`d properties out of a `style` object whose value
  changes across re-renders.** Re-applying a changed style value cancels the
  running tween (unchanged values are diffed away and are safe); drive such
  properties from an effect with `animate()`/`jump()` and a `nodeRef` instead.
- **An Octane state commit replays the whole root**, which is where the
  no-per-frame-state rule bites hardest. The replay costs the same whether the
  state lives in the root or in a one-node leaf — leaf state changes *how
  often* you replay, not what a replay costs, and on the PSP one replay is a
  multi-frame stall. The showcase demos put every continuous visual on a native
  channel instead: `<Sprite>` atlases for the hero/gallery/library spinners
  (`sprites.json`), a baked keyframe timeline for the music equalizer
  (`apps/music/pocket.config.ts`), `animate()`/`jump()` for the stats bars and
  notification rows, and `setTextContent` for count-ups and percentages
  (`StatTiles`, `ProgressLine`).
- **Frame counters that only time a phase live in refs**, committing state
  once at the boundary they're waiting for (the notifications
  dismiss/rise timers, the library loading screen). Counting in state
  replays the root every frame of the phase for pixels that never change.
- **Each replay retains a residue the collector cannot reclaim** on the pinned
  QuickJS revision, and the slab allocator amplifies it on the fixed arena
  (the host's arena-pressure GC absorbs the churn). Keeping continuous motion
  on native channels holds replays down to interaction rate — button presses,
  track changes — which bounds the residue.

## Svelte notes

Svelte compiles against its **custom-renderer API**
([sveltejs/svelte#18511](https://github.com/sveltejs/svelte/pull/18511)), which
replaces the DOM with a renderer object. PocketJS supplies that object in
`framework/src/renderer-svelte.ts`, a thin adapter over the same native mirror
tree the other three frameworks write to. The build is unreleased, so the
framework **vendors a tarball of the pull request head** in `vendor/` and ships
it inside the npm package; `bun tools/vendor-svelte.ts` moves the pin.

Svelte's own reactivity comes from `svelte` (`$state`, `$derived`, `$effect`,
`onMount`, snippets); PocketJS supplies the host components, lifecycle, input
and animation APIs.

Authoring rules specific to Svelte apps:

- **Component files are `.svelte`, shared reactive state lives in `.svelte.ts`
  runes modules.** A runes module is one instance per program, so state in one
  outlives anything that remounts the tree.
- **The entry is a `.ts` file that imports the component**, because a manifest's
  `app.entry` accepts `.ts`/`.tsx` only. `mount(App)` takes the component
  itself, never a thunk.
- **`class` stays full literals or ternaries of full literals**, as in the other
  frameworks. `class:` directives, interpolated class strings and the `clsx`
  object/array forms are **compile errors** — the class table is built at build
  time.
- **Style objects are a component prop, not an attribute.** A `style` attribute
  in Svelte is CSS text, which the native tree has no parser for, so
  `<View style={{ width: 10 }} />` is the supported spelling and a raw
  `style="…"` is refused at compile time. `style:` directives are refused too.
- **`<style>` blocks are refused.** Styling is the Tailwind subset.
- **`onPress` is the only event.** Host elements expose the native press
  channel; everything else about input comes from `onFrame`/`onButtonPress` in
  `@pocketjs/framework/svelte/lifecycle`.
- **`nodeRef` hands you the `NodeMirror`** for `animate()`, `jump()` and
  `setTextContent()`. `{@attach}` and `use:` receive the same node.
- **`svelte/motion`, `svelte/transition` and `svelte/animate` are refused**:
  they reach for `requestAnimationFrame` and `performance.now`, which the
  QuickJS guest does not have. Use `animate()` and baked keyframe timelines.
- **`bind:` on a host element is refused** by Svelte under a custom renderer;
  `bind:` on a component is ordinary prop plumbing and works.
  `<svelte:window>`, `<svelte:document>`, `<svelte:body>`, `<svelte:head>` and
  `{@html}` are refused for the same reason.
- **A state write in a press handler lands in that frame.** The frame handler
  calls Svelte's `flushSync()` after input handling and before the end-of-frame
  sweep, so effects commit before detached subtrees are destroyed.
- **Continuous motion rides the native channels** — sprite atlases, baked
  keyframe timelines, `animate()`/`jump()` and `setTextContent()` — rather than
  per-frame state, the same rule the other frameworks follow.
- **A style object re-applies whenever anything it reads changes.** It is applied
  from an attachment, and `setStyleObject` diffs per key, so unchanged keys never
  stomp a running tween. But a property under `animate()` must not also be a
  reactive value in that object, or the re-apply fights the animation. Snapshot
  it at init, which is Svelte's equivalent of Solid's `untrack`.
- **`nodeRef` fires after `class`, `style` and `onPress` are on the node**, so an
  `animate()` or `spring()` started from it sees the element's initial style.
- **Root props go through `mount`**: `mount(App, { props: { registry } })` is the
  Svelte spelling of Solid's `mount(() => <App registry={…} />)`.
- **Input APIs that hand back a disposer** are torn down with Svelte's own
  lifecycle: `onDestroy(enableCursor({ dpadSpeed: 60 }))`.
- **A snippet that takes another snippet** needs `import type { Snippet } from
  "svelte"`. Snippets live in the template, not in `<script>`, so a Solid table of
  component thunks becomes an `{#if}` ladder or a `{#key}` block. That remount is
  also how you restart a subtree's baked timelines.
- **The same runes-and-components model has an ahead-of-time path.** Pocket
  Vapor's Svelte front end (`vapor/compiler/svelte.ts`) compiles a `$state`/
  `$derived` + `<row>` subset to C for the Game Boy Advance, Game Boy, NES,
  ESP32 and Playdate, with no JS engine on the device: `bun run vapor:svelte`
  builds the Todo in `vapor/examples/todo-svelte/`, and `vapor/DESIGN.md` §6.5
  states the subset, the lowering and the parity claim against real Svelte.

## What stays shared

All four frameworks use the same Tailwind-subset compiler, generated style
table, font atlas baker, `.pak` asset container, host detection, button/focus
input, overlay layer, animation API, and every native build and capture path a
target registers in `contracts/spec/platforms.ts`. Switching frameworks changes
the JS component/reactivity layer and the renderer adapter.

One exception: **touch under Octane is raw contacts only.** The Solid, Vue
Vapor and Svelte entries call `installTouchActivation()` and run the gesture
pump each frame; `framework/src/index-octane.ts` does neither, so an Octane app gets no
tap-to-press on `onPress` and no recognizers — it reads `touches()` itself.
