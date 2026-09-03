// Svelte playground runtime bundle. Import-map entries for
// @pocketjs/framework/svelte/* point here; the Svelte runtime itself stays
// external so it resolves to the single pg/svelte.js instance.

export {
  frameworkName,
  mount,
  registerTexture,
  render,
} from "../../framework/src/index-svelte.ts";
export {
  View,
  Text,
  Image,
  Sprite,
  Screen,
  Focusable,
  FocusScope,
  FocusGrid,
  ActionHandler,
  Portal,
  Modal,
  ActionBar,
  Grid,
  Lazy,
  Gallery,
} from "../../framework/src/components-svelte.ts";
export {
  animate,
  spring,
  cancelAnim,
  jump,
  createJumpBatch,
} from "../../framework/src/animation.ts";
export {
  onFrame,
  onButtonPress,
  createSpriteAnimation,
  pushButtonHandlerBlock,
} from "../../framework/src/lifecycle-svelte.ts";
export {
  BTN,
  enableCursor,
  focusNode,
  getFocused,
  pushFocusGrid,
  pushFocusScope,
  touches,
} from "../../framework/src/input-api.ts";
export { createWavPlayer } from "../../framework/src/audio-api.ts";
export { TICKS_PER_SECOND, ticksPerFrame } from "../../framework/src/clock.ts";
export { getOps, hostViewport } from "../../framework/src/host.ts";
export { appTable, frozenShot, launchApp } from "../../framework/src/launcher.ts";

// Compiled components import the renderer as a default: the specifier
// framework/compiler/svelte-compile.ts bakes in maps to this bundle.
export { default } from "../../framework/src/renderer-svelte.ts";

import {
  resetRendererState,
  resetSprites,
  resetTextures,
} from "../../framework/src/renderer-svelte.ts";
import { resetStyles } from "../../framework/src/styles.ts";
import { resetPack } from "../../framework/src/pak.ts";

export function __resetAll(): void {
  resetRendererState();
  resetTextures();
  resetSprites();
  resetStyles();
  resetPack();
  (globalThis as { frame?: unknown }).frame = undefined;
}
