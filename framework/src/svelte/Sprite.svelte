<script lang="ts">
  import { applyHostProps, type NodeMirror, type SpriteProps } from "./props.ts";

  let { class: className, sprite, style, debugName, nodeRef }: SpriteProps = $props();
</script>

<image
  {@attach (node: NodeMirror) => applyHostProps(node, { class: className, sprite, style, debugName })}
  {@attach (node: NodeMirror) => nodeRef?.(node)}
></image>
