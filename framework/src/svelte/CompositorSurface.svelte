<script lang="ts">
  import { applyHostProps, type CompositorSurfaceProps, type NodeMirror } from "./props.ts";

  let { class: className, package: pkg, focused, style, debugName, nodeRef }:
    CompositorSurfaceProps = $props();
</script>

<surface
  {@attach (node: NodeMirror) =>
    applyHostProps(node, { class: className, package: pkg, focused, style, debugName })}
  {@attach (node: NodeMirror) => nodeRef?.(node)}
></surface>
