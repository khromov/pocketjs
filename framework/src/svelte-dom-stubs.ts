// Stand-ins for the browser-DOM-only modules Svelte's client barrel re-exports,
// aliased in by the build for framework=svelte bundles
// (framework/compiler/jsx-plugin.ts).
//
// `svelte/internal/client/index.js` is a flat barrel: compiled component output
// imports from it, and it eagerly re-exports the custom-element and DOM-binding
// modules alongside the reactivity core. None of those can run here — PocketJS
// renders into the native tree, there is no `HTMLElement`, no `ResizeObserver`
// and no form element to bind against — but two things keep them in the bundle:
//
// 1. `dom/elements/custom-element.js` assigns at module scope, inside
//    `if (typeof HTMLElement === 'function')`. A bundler cannot prove that inert,
//    so the module is pinned and its line-1 import pulls `legacy/legacy-client.js`
//    in behind it.
// 2. The rest are reachable from the barrel and simply never called.
//
// Measured on `cards`: nothing in the bundle calls `create_custom_element`,
// `bind_checked`, `bind_files`, `bind_group`, `bind_value`, `bind_element_size`
// or `bind_resize_observer`. Aliasing those three modules drops them plus
// `legacy/legacy-client.js` — 11,358 bytes raw on `cards`, and the stubs
// themselves shake out to nothing because no call site survives.
//
// `internal/client/legacy.js` is deliberately NOT aliased: the barrel's
// `invalidate_inner_signals` is legacy-API-only, but `runtime.js` imports
// `captured_signals` from the same module, so it stays in the bundle either way
// and stubbing it would buy nothing while risking a live call.
//
// The upstream fix belongs in sveltejs/svelte#18511 (the custom-renderer PR this
// build is vendored from): the barrel wants a `custom-renderer` variant that
// omits these, or `custom-element.js` wants its top-level block made
// DCE-friendly. Until then this keeps them out of the artifact.
//
// Keep the export surface in sync with the re-exports in
// `svelte/src/internal/client/index.js`.

function unreachable(name: string): never {
  throw new Error(`svelte: ${name}() is browser-DOM only and is not available on a PocketJS host`);
}

export function create_custom_element(..._args: unknown[]): never {
  return unreachable("create_custom_element");
}
export function bind_checked(..._args: unknown[]): never {
  return unreachable("bind_checked");
}
export function bind_files(..._args: unknown[]): never {
  return unreachable("bind_files");
}
export function bind_group(..._args: unknown[]): never {
  return unreachable("bind_group");
}
export function bind_value(..._args: unknown[]): never {
  return unreachable("bind_value");
}
export function bind_element_size(..._args: unknown[]): never {
  return unreachable("bind_element_size");
}
export function bind_resize_observer(..._args: unknown[]): never {
  return unreachable("bind_resize_observer");
}
