// Animation public API.

export { createCaretBlink, type CaretBlinkOptions } from "./caret-blink.ts";

export {
  animate,
  spring,
  cancelAnim,
  jump,
  createJumpBatch,
  createPropBatchWriter,
  type AnimateOptions,
  type EasingName,
  type JumpBatch,
  type PropBatchWriter,
} from "./anim.ts";
