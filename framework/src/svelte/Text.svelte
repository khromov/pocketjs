<script lang="ts">
  import { applyHostProps, type NodeMirror, type TextProps } from "./props.ts";

  let { class: className, style, debugName, nodeRef, children }: TextProps = $props();
</script>

<text
  {@attach (node: NodeMirror) => applyHostProps(node, { class: className, style, debugName })}
  {@attach (node: NodeMirror) => nodeRef?.(node)}
>{@render children?.()}</text>
