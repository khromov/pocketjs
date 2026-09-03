<script lang="ts">
  import { View } from "@pocketjs/framework/svelte/components";
  import type { NodeMirror } from "@pocketjs/framework/svelte/renderer";

  // Records what the node already carried when nodeRef fired: an animation
  // started here must not be overwritten by a later initial style write.
  let { seen }: { seen: (style: unknown, press: unknown) => void } = $props();
</script>

<View
  class="p-2"
  style={{ translateX: 7 }}
  onPress={() => {}}
  nodeRef={(node: NodeMirror) => seen(node.domAttrs?.style, node.onPress)}
/>
