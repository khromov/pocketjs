// @title PocketJS: Launcher
import { mount } from "@pocketjs/framework/svelte";
import Launcher from "./app.svelte";
import { REGISTRY } from "./registry.generated.ts";

// mount() has no props channel under Svelte — index-svelte's render() calls the
// renderer's render(code, root), which mounts with `props: {}`. The root here
// is therefore a one-expression component that hands the generated registry
// down, the Svelte spelling of Solid's mount(() => <Launcher registry={…} />).
type SvelteComponentFn = (anchor: unknown, props: Record<string, unknown>) => void;
const Root: SvelteComponentFn = (anchor, props) =>
  (Launcher as unknown as SvelteComponentFn)(anchor, { ...props, registry: REGISTRY });

mount(Root as never);
