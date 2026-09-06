<script lang="ts">
  import { applyHostProps, type ImageProps, type NodeMirror } from "./props.ts";

  let { class: className, src, style, debugName, nodeRef }: ImageProps = $props();
</script>

<image
  {@attach (node: NodeMirror) => applyHostProps(node, { class: className, src, style, debugName })}
  {@attach (node: NodeMirror) => nodeRef?.(node)}
></image>
