<script lang="ts">
  // Draws a layout made for the PSP's 480x272 screen on a smaller one (the 3DS
  // top screen is 400x240). The children lay out in a `width` x `height` box,
  // which is scaled from its top-left corner by the factor that fits both axes
  // (400/480 = 0.833 on the 3DS) and centred on the other axis. A transform
  // does not change layout, so every flexbox size and baked animation inside
  // keeps its PSP value. At the design size or larger the children render
  // directly, with no extra node, so the PSP frame is unchanged.
  import type { Snippet } from "svelte";
  import { View } from "@pocketjs/framework/svelte/components";
  import { getOps, hostViewport } from "@pocketjs/framework/svelte/host";

  interface Props {
    width?: number;
    height?: number;
    /** Classes of a full-screen View drawn behind the scaled layout, so the
     *  bars it leaves on the other axis take the app's background (a whole
     *  class literal, which the build bakes like any other). */
    backdrop?: string;
    children: Snippet;
  }

  const props: Props = $props();
  const width = props.width ?? 480;
  const height = props.height ?? 272;
  // The host publishes its viewport before the app mounts; a fixed-size
  // console never changes it afterwards.
  const viewport = hostViewport(getOps()) ?? { w: width, h: height };
  const scale = Math.min(1, viewport.w / width, viewport.h / height);
  const style = {
    width,
    height,
    scale,
    originX: -0.5,
    originY: -0.5,
    translateX: (viewport.w - width * scale) / 2,
    translateY: (viewport.h - height * scale) / 2,
  };
</script>

{#if scale < 1}
  {#if props.backdrop}<View debugName="FitBackdrop" class={props.backdrop} />{/if}
  <View debugName="FitScreen" class="absolute left-0 top-0" {style}>{@render props.children()}</View>
{:else}
  {@render props.children()}
{/if}
