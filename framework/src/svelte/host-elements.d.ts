// The four host tags (`view`, `text`, `image`, `surface`; contracts/spec/spec.ts
// NODE_TYPE) as the Svelte type checker sees them.
//
// svelte-check and the Svelte language server type a template element through
// svelte2tsx, which knows `view`, `text` and `image` only as SVG elements and
// composes their props as `HTMLProps<tag, svelteHTML.SVGAttributes>`: the DOM
// typing with the members of `svelteHTML.SVGAttributes` layered on top. That
// interface is empty and left open on purpose, so the attributes the renderer
// accepts (framework/src/renderer-svelte.ts setAttribute/addEventListener)
// are declared here and override the SVG ones — `focusable` is a boolean
// prop on a `view`, not the SVG focus hint. `tsc` never parses templates, so
// this file is inert there.

declare namespace svelteHTML {
  interface SVGAttributes<T extends EventTarget = any> {
    focusable?: boolean | undefined;
    debugName?: string | undefined;
    /** svelte2tsx lowercases an element attribute before typing it; the renderer still receives `debugName`. */
    debugname?: string | undefined;
    src?: string | undefined;
    sprite?: string | undefined;
    package?: string | undefined;
    focused?: boolean | undefined;
    onpress?: (() => void) | undefined;
  }
}
