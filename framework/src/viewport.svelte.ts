// The logical viewport as Svelte state: the size the host published at mount
// (the spec screen on a host that publishes none), then each size the host
// resizes to through display.viewport.live.

import { onDestroy } from "svelte";
import { SCREEN_H, SCREEN_W } from "../../contracts/spec/spec.ts";
import { getOps, hostViewport, onViewport } from "./host.ts";

/** The logical viewport an app lays out in, in logical pixels. */
export interface ViewportSize {
  w: number;
  h: number;
}

export interface Viewport {
  /** The current size; reading it in a template or `$derived` subscribes. */
  readonly current: ViewportSize;
}

/**
 * Read `useViewport().current` in a component to choose a layout from the
 * width: the columns of a grid, a row that becomes a column. A resize to the
 * size already held is not a change. The listener is removed when the
 * calling component is destroyed.
 */
export function useViewport(): Viewport {
  const now = hostViewport(getOps());
  let size = $state.raw<ViewportSize>({ w: now?.w ?? SCREEN_W, h: now?.h ?? SCREEN_H });
  const remove = onViewport((w, h) => {
    if (w !== size.w || h !== size.h) size = { w, h };
  });
  onDestroy(remove);
  return {
    get current() {
      return size;
    },
  };
}
