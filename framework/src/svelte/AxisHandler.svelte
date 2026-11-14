<script lang="ts">
  import { untrack } from "svelte";
  import { onAxisDelta } from "../frame.svelte.ts";
  import { RelativeAxis } from "../relative-axis.ts";
  import { inputMarker, resolveActive, type AxisHandlerProps, type NodeMirror } from "./props.ts";

  let { axis, active, onDelta, children }: AxisHandlerProps = $props();

  // Placed like ActionHandler: the delta reaches handlers in document order.
  // `axis` is read once, at registration; `active` and `onDelta` on each frame.
  const place = (marker: NodeMirror) =>
    untrack(() => {
      if (axis !== "primary" && axis !== "secondary") throw new Error(`Unknown relative axis ${axis}`);
      return onAxisDelta(
        axis === "primary" ? RelativeAxis.Primary : RelativeAxis.Secondary,
        (delta) => onDelta(delta),
        { active: () => resolveActive(active) },
        inputMarker(marker),
      );
    });
</script>

<view {@attach place}></view>
{@render children?.()}
