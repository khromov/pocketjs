<script lang="ts">
  import { applyHostProps, type NodeMirror, type SpriteProps } from "./props.ts";

  let { class: className, sprite, frameStep, style, debugName, nodeRef }: SpriteProps = $props();
</script>

<image
  {@attach (node: NodeMirror) => applyHostProps(node, { class: className, sprite, frameStep, style, debugName })}
  {@attach (node: NodeMirror) => nodeRef?.(node)}
></image>
