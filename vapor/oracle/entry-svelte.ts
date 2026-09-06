// vapor/oracle/entry-svelte.ts — bundle entry for the Svelte oracle build.
//
// Bundled by boot.ts with the .svelte loader: components compile against the
// custom renderer in renderer-svelte.ts and `svelte` resolves to its client
// build. Executing the bundle installs the same hooks entry.ts installs for
// Vue; the test side owns the micro-DOM and drives boot/press/tick through
// them.

import { mount, tick, unmount } from "svelte";
import App from "vapor:app";
import {
  __dispatchAxisDelta,
  __dispatchButton,
  __resetButtons,
} from "../host/input.ts";
import renderer from "./renderer-svelte.ts";

const hooks = globalThis as Record<string, unknown>;

hooks.__vaporBoot = (container: unknown): { unmount(): void } => {
  __resetButtons();
  // `renderer` is not in the public MountOptions type yet; the same cast the
  // framework's renderer-svelte.ts makes.
  const instance = mount(App as never, { target: container, renderer } as never);
  return {
    unmount: () => {
      void unmount(instance);
    },
  };
};

hooks.__vaporPress = (button: number): void => {
  __dispatchButton(button);
};

hooks.__vaporAxisDelta = (axis: number, delta: number): void => {
  __dispatchAxisDelta(axis as 0 | 1, delta);
};

// Svelte's tick awaits a microtask and then flushes synchronously — the
// counterpart of Vue's nextTick for the oracle's press/settle protocol.
hooks.__vaporTick = (): Promise<void> => tick();
