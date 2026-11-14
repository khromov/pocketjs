// App-facing lifecycle callbacks for Svelte.
//
// The registry and the frame's dispatch order are shared with the Solid and
// Vue Vapor pumps (frame-dispatch.ts): gesture recognition, then frame
// callbacks in registration order, then every deferred press (placed
// handlers and the focused node's CIRCLE) in the live tree's document order.
// This module owns the Svelte component scope those registrations live in.

import { onDestroy } from "svelte";
import { __resetAnalog } from "./analog.ts";
import {
  __axisDelta,
  __beginAxisFrame,
  __endAxisFrame,
  __resetAxisInput,
  RelativeAxis,
  type AxisDelta,
  type RelativeAxisId,
} from "./relative-axis.ts";
import {
  __beginMotionFrame,
  __endMotionFrame,
  __motionReader,
  __resetMotionInput,
  type MotionMinQualityName,
  type MotionPayload,
  type MotionState,
  type MotionValueName,
} from "./motion.ts";
import type { NodeMirror } from "./native-tree.ts";
import type { DeferredPress } from "./input.ts";
import { dispatchFrame, FrameRegistry, type FrameCallback, type RunPress } from "./frame-dispatch.ts";

export {
  __setAnalog,
  analogRaw,
  analogX,
  analogY,
  rightAnalogRaw,
  rightAnalogX,
  rightAnalogY,
} from "./analog.ts";

const registry = new FrameRegistry();
let buttonHandlerBlockDepth = 0;

// Svelte has no per-row reactive scope to restore around a press.
const runPress: RunPress = (_node, invoke) => invoke();

export function resetFrameHooks(): void {
  registry.clear();
  buttonHandlerBlockDepth = 0;
  __resetAnalog();
  __resetAxisInput();
  __resetMotionInput();
}

export function runFrameHooks(
  buttons: number,
  axisDeltas?: readonly AxisDelta[],
  resolveInput?: (defer: DeferredPress) => void,
  beforeHooks?: (defer: DeferredPress) => void,
  motion?: MotionState | null,
): void {
  __beginAxisFrame(axisDeltas);
  try {
    __beginMotionFrame(motion);
    dispatchFrame(registry.freeze(), buttons, runPress, beforeHooks, resolveInput);
  } finally {
    __endAxisFrame();
    __endMotionFrame();
  }
}

/**
 * Svelte's onDestroy throws only outside a component, which is where the entry's
 * installTouchActivation() registers from; there, disposal falls to
 * resetFrameHooks() at the next mount. Anything else is a real error and is
 * rethrown rather than swallowed. (Inside onMount or an attachment it does NOT
 * throw — effects restore the component context — so a hook registered there
 * is torn down with that effect.)
 */
function onTeardown(dispose: () => void): void {
  try {
    onDestroy(dispose);
  } catch (error) {
    const outsideComponent =
      error instanceof Error && error.message.includes("lifecycle_outside_component");
    if (!outsideComponent) throw error;
  }
}

/** Register `callback` for the calling component's lifetime. With `placement`
 *  it runs in the frame's document-ordered press queue at that node. Without
 *  one it is wrapped, as framework/src/frame.ts does: the registry is a set,
 *  so one function registered twice still runs twice and each registration
 *  is disposed on its own. */
function registerFrame(callback: FrameCallback, placement?: NodeMirror): () => void {
  const wrapped: FrameCallback = placement ? callback : (buttons) => callback(buttons);
  const dispose = registry.add(wrapped, placement);
  onTeardown(dispose);
  return dispose;
}

function isActive(active: boolean | (() => boolean) | undefined): boolean {
  return typeof active === "function" ? active() : active ?? true;
}

export function onFrame(callback: FrameCallback): void {
  registerFrame(callback);
}

export interface ButtonPressOptions {
  allowWhenBlocked?: boolean;
  active?: boolean | (() => boolean);
  /** See framework/src/frame.ts: arm only after the button is seen up for one frame. */
  latched?: boolean;
}

export interface AxisDeltaOptions {
  active?: boolean | (() => boolean);
}

/** Fires once per frame whose `axis` moved, with the frame's summed delta. */
export function onAxisDelta(
  axis: RelativeAxisId,
  callback: (delta: number) => void,
  options: AxisDeltaOptions = {},
  placement?: NodeMirror,
): () => void {
  if (axis !== RelativeAxis.Primary && axis !== RelativeAxis.Secondary) {
    throw new Error(`Unknown relative axis ${axis}`);
  }
  return registerFrame(() => {
    const delta = __axisDelta(axis);
    if (delta === 0) return;
    if (isActive(options.active)) callback(delta);
  }, placement);
}

export interface MotionOptions {
  active?: boolean | (() => boolean);
  minQuality?: MotionMinQualityName;
}

/** See framework/src/frame.ts: fires on frames carrying `value` at `minQuality` or better. */
export function onMotion<V extends MotionValueName>(
  value: V,
  callback: (...payload: MotionPayload<V>) => void,
  options: MotionOptions = {},
  placement?: NodeMirror,
): () => void {
  const read = __motionReader(value, options.minQuality);
  return registerFrame(() => {
    const payload = read();
    if (!payload) return;
    if (isActive(options.active)) (callback as (...payload: number[]) => void)(...payload);
  }, placement);
}

export function pushButtonHandlerBlock(): () => void {
  buttonHandlerBlockDepth++;
  let disposed = false;
  return () => {
    if (disposed) return;
    disposed = true;
    buttonHandlerBlockDepth = Math.max(0, buttonHandlerBlockDepth - 1);
  };
}

export function onButtonPress(
  mask: number,
  callback: (pressed: number, buttons: number) => void,
  opts: ButtonPressOptions = {},
  placement?: NodeMirror,
): () => void {
  let prevButtons = opts.latched ? ~0 : 0; // latched: "everything held" until released
  return registerFrame((buttons) => {
    const pressed = buttons & ~prevButtons;
    prevButtons = buttons;
    if (!isActive(opts.active)) return;
    if (buttonHandlerBlockDepth > 0 && !opts.allowWhenBlocked) return;
    if (pressed & mask) callback(pressed, buttons);
  }, placement);
}

export interface SpriteAnimationOptions {
  frameStep?: number;
}

export interface SpriteAnimation {
  /** The frame's image name, as `svelte/reactivity` spells a reactive read. */
  readonly current: string;
}

export function createSpriteAnimation(
  frames: readonly string[],
  opts: SpriteAnimationOptions = {},
): SpriteAnimation {
  if (frames.length === 0) {
    throw new Error("PocketJS: createSpriteAnimation() requires at least one frame");
  }
  const frameStep = Math.max(1, Math.floor(opts.frameStep ?? 1));
  let tick = $state(0);
  onFrame(() => {
    tick = (tick + 1) % (frames.length * frameStep);
  });
  return {
    get current() {
      return frames[Math.floor(tick / frameStep) % frames.length];
    },
  };
}
