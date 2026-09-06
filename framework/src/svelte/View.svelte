<script lang="ts">
  import { applyHostProps, type NodeMirror, type ViewProps } from "./props.ts";

  let { class: className, style, onPress, focusable, debugName, nodeRef, children }: ViewProps =
    $props();
</script>

<view
  {@attach (node: NodeMirror) =>
    applyHostProps(node, { class: className, style, onPress, focusable, debugName })}
  {@attach (node: NodeMirror) => nodeRef?.(node)}
>{@render children?.()}</view>
