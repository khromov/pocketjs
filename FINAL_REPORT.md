# Svelte on PocketJS: what five parallel demo ports found

Five agents ported `cards`, `chrome`, `cursor`, `launcher` and `motions` to Svelte
from their Solid originals, each with fresh context and no knowledge of the
others' findings. This is what the exercise established about the integration.

## Verdict

The integration works. All five ports render **identically to the Solid builds**:

| Demo | Parity evidence |
| --- | --- |
| cards | 180 frames, 0 differing framebuffer hashes |
| chrome | 30 frames identical across all four visual states, including the pressed bevel |
| cursor | trees byte-identical after anchor normalisation; same 12 style records and a byte-identical pak |
| launcher | 263-frame journey, one shared hash chain; frozen-shot frame matches, so `registerTexture` is proven |
| motions | 840 frames, 0 differing; **143 of 143 baked timelines** and 222 style records on both |

Three agents needed no workarounds at all and built green on the first try. The
component surface (`View`/`Text`/`Image`, `class`, `style`, `focusable`,
`debugName`, `nodeRef`, `onPress`) mapped one-to-one from Solid with no renames,
and `animate`, `spring`, `createJumpBatch`, `onFrame` and `onButtonPress` behaved
exactly as under Solid.

## Bugs the ports found, and what was done

**1. `nodeRef` fired before `style` and `onPress` were applied.** Solid's order is
create, props, then ref. The Svelte primitives registered the `nodeRef` attachment
first, so an `animate()`/`spring()` started from a ref was overwritten by the
initial style write. The cards agent measured it: 60 of 180 frames diverged,
starting exactly at the reveal. *Fixed* by reordering the attachments in all five
primitives, with a regression test that asserts the node already carries its style
and press handler when `nodeRef` fires.

**2. The class and style lints never fired on real app code.** `walkFragment` only
visited `RegularElement`, but apps write `<View>`, which parses as a `Component`.
Every rule the docs advertise as a compile error compiled clean. All four agents
found this independently. It was worse than a late error: on a native host
`setClass` does not throw for an unknown class, it bumps a miss counter and renders
the node **unstyled**, so the failure was a silent visual regression on device.
*Fixed* by walking component nodes too, keeping `style={{…}}` legal while refusing
`style="…"`, with tests in both directions.

**3. `mount()` could not pass props to the root component.** `mountInto` already
accepted props; `render` dropped the channel. The launcher agent had to hand-write
a Svelte calling-convention wrapper with two casts. *Fixed*: `mount(App, { props })`
now works, and the launcher entry is four lines.

**4. Neutral subpaths resolved to the wrong module instance in the playground.**
`launcher` and `host` had no framework aliases, so `@pocketjs/framework/svelte/launcher`
did not exist and the bare form mapped to the Solid bundle, whose host is never
installed under a Svelte demo. `appTable()` threw "host not installed" on mount.
*Fixed* by aliasing those rows, regenerating the exports, extending the playground
import map and completing the Svelte runtime facade, which was also missing
`registerTexture`, `createJumpBatch`, `touches` and `enableCursor`. The Svelte
launcher now runs in the playground.

**5. The teardown catch was too broad.** `onFrame`'s `try { onDestroy }` swallowed
every error, not just the out-of-component case, and would have hidden a real
mis-registration. The launcher agent also established that `onDestroy` inside
`onMount` does *not* throw. *Fixed*: only `lifecycle_outside_component` is caught.

## Known costs, not fixed

**Node inflation is real and systemic.** Svelte's block anchors and the whitespace
between sibling component tags each become an allocated native node:

| Demo | Solid | Svelte |
| --- | --- | --- |
| cursor | 17 | 27 |
| chrome | 32 | 55 |
| launcher | 76 | 126 |
| motions (page 1) | 107 | 200 |

Pixels are identical because the renderer blanks whitespace runs and the core
excludes empty text from layout, so the cost is arena slots, not layout or draw.
Removing it means keeping anchors as virtual nodes outside the native tree and
walking siblings in a shadow structure, which trades JS memory for native slots.
That is a design change, not a patch, and it is the main follow-up for the 8 MB
budget. Bundle size is a related cost: roughly 2x the Solid bundle for the same UI.

**Svelte's constant folder hides an illegal class until it becomes reactive.** The
chrome agent found that `class="w-[{n}]"` folds to a literal when `n` is constant,
lands in the style table and renders correctly. Add an unrelated write to `n` and
the fold stops, the table silently loses a record, and the app throws on first
paint of that branch. The lint now catches the syntax, but "it built and rendered"
is still not proof a class was authored legally. A build-time check that every
static class reaching a host component resolves in `STYLE_IDS` would close this.

**Snippets cannot be values in `<script>`.** They exist only in the template, so
Solid's table of component thunks indexed by a signal has no direct translation;
the motions port became a four-branch `{#if}` ladder. It works and is arguably more
explicit, but it does not scale to a demo with many pages. Otherwise snippets were
a better-than-expected substitute for local components: typed parameters worked,
snippet-taking-snippet worked first try, and class literals passed as snippet
arguments still reach the style table.

**`framework/src/styles.generated.ts` is racy.** Every build rewrites it, so
concurrent builds corrupt each other's table for anything importing it at runtime.
Two agents hit this. Writing it per output, or into a build-scoped temp path, would
fix it.

## Documented as a result

The Svelte notes in `site/content/docs/frameworks.md` gained the style-object
reactivity rule (a property under `animate()` must not also be reactive in that
object, Svelte's equivalent of Solid's `untrack`), the `nodeRef` ordering guarantee,
`mount(App, { props })`, `onDestroy(enableCursor(...))` for disposer-returning APIs,
and the `Snippet` import plus the `{#if}`/`{#key}` remount pattern for restarting
baked timelines.

## Smaller things worth knowing

- Bun ignores comma-joined `--conditions`; they must be repeated flags. The failure
  surfaces as an opaque Svelte SSR error naming none of them.
- Svelte trims leading and trailing whitespace inside an element, so multi-line
  `<Text>` bodies do not produce stray text children.
- `onMount` runs after child attachments, so refs collected by children are
  populated by the time a parent's `onMount` runs.
- `class:` and `style:` on a component are refused by Svelte itself with a generic
  "not valid on components" rather than the PocketJS message.
