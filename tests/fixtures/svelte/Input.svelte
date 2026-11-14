<script lang="ts">
  import { BTN } from "@pocketjs/framework/svelte/input";
  import { ActionHandler, AxisHandler, MotionHandler, View } from "@pocketjs/framework/svelte/components";
  import type { NodeMirror } from "@pocketjs/framework/svelte/renderer";
  import { input, log } from "./input-state.svelte.ts";

  let { focusable }: { focusable: (node: NodeMirror) => void } = $props();
</script>

<View>
  {#if input.early}
    <ActionHandler button={BTN.CIRCLE} onPress={() => log.push("early")} />
  {/if}
  <ActionHandler button={BTN.CIRCLE} onPress={() => log.push("before")} />
  <View focusable onPress={() => log.push("focused")} nodeRef={focusable} />
  <ActionHandler button={BTN.CIRCLE} active={input.active} onPress={() => log.push("gated")} />
  <AxisHandler axis="primary" active={input.active} onDelta={(delta) => log.push(`axis ${delta}`)} />
  <MotionHandler
    value="inclination"
    minQuality="medium"
    onUpdate={(degrees, quality, timestamp) => log.push(`inclination ${degrees} ${quality} ${timestamp}`)}
  />
</View>
