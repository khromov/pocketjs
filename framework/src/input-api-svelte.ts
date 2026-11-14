// Svelte lifecycle owns subscriptions; the host-facing delta contract is shared.
// Named with a hyphen, not `input-api.svelte.ts`: the Svelte build redirects
// `./X.ts` to a sibling `X.svelte.ts`, and every framework-neutral importer
// of input-api.ts must keep the shared module.
export * from "./input-api.ts";
export {
  onAxisDelta,
  onMotion,
  type AxisDeltaOptions,
  type MotionOptions,
} from "./frame.svelte.ts";
