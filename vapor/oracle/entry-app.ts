// vapor/oracle/entry-app.ts — the Vue oracle entry for a caller-chosen app.
//
// entry.ts pins the todo example; this twin imports the component through the
// `vapor:app` specifier that boot.ts resolves to the requested file, so a
// generated .vapor.tsx (the Svelte front end's output) runs under real Vue.

import { createVaporApp, nextTick } from "vue";
import TodoApp from "vapor:app";
import {
  __dispatchAxisDelta,
  __dispatchButton,
  __resetButtons,
} from "../host/input.ts";

type AnyApp = { mount(container: unknown): void; unmount(): void };

const hooks = globalThis as Record<string, unknown>;

hooks.__vaporBoot = (container: unknown): AnyApp => {
  __resetButtons();
  const app = (createVaporApp as unknown as (comp: unknown) => AnyApp)({
    setup: () => (TodoApp as () => unknown)(),
  });
  app.mount(container);
  return app;
};

hooks.__vaporPress = (button: number): void => {
  __dispatchButton(button);
};

hooks.__vaporAxisDelta = (axis: number, delta: number): void => {
  __dispatchAxisDelta(axis as 0 | 1, delta);
};

hooks.__vaporTick = (): Promise<void> => nextTick();
