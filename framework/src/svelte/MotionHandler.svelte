<script lang="ts">
  import { untrack } from "svelte";
  import { onMotion } from "../frame.svelte.ts";
  import { MOTION_DEFAULT_MIN_QUALITY } from "../motion.ts";
  import { inputMarker, resolveActive, type MotionHandlerProps, type NodeMirror } from "./props.ts";

  let { value, active, minQuality, onUpdate, children }: MotionHandlerProps = $props();

  // Placed like ActionHandler: motion reaches handlers in document order.
  // `value` and `minQuality` are read once, at registration (an unknown name
  // throws there); `active` and `onUpdate` on each frame.
  const place = (marker: NodeMirror) =>
    untrack(() =>
      onMotion(
        value,
        (...payload: number[]) => (onUpdate as ((...payload: number[]) => void) | undefined)?.(...payload),
        { active: () => resolveActive(active), minQuality: minQuality ?? MOTION_DEFAULT_MIN_QUALITY },
        inputMarker(marker),
      ),
    );
</script>

<view {@attach place}></view>
{@render children?.()}
