<script lang="ts">
  // The E1M1 overview baked by gen-assets.ts (3 px per tile) with a marker
  // for the player; `update()` moves the marker when the player has moved a
  // map pixel, so a still player costs nothing.
  import { jump } from "@pocketjs/framework/svelte/animation";
  import { Image, View } from "@pocketjs/framework/svelte/components";
  import type { NodeMirror } from "@pocketjs/framework/svelte/renderer";

  const SCALE = 3;
  const SIZE = 192;

  let { x, y }: { x: number; y: number } = $props();

  let marker: NodeMirror | undefined;
  let lastX = -1;
  let lastY = -1;

  export function update(px: number, py: number): void {
    if (!marker) return;
    const mx = Math.round(px * SCALE) - 2;
    const my = Math.round(py * SCALE) - 2;
    if (mx !== lastX) {
      jump(marker, "translateX", mx);
      lastX = mx;
    }
    if (my !== lastY) {
      jump(marker, "translateY", my);
      lastY = my;
    }
  }
</script>

<View
  debugName="LevelMap"
  style={{ posType: 1, insetL: x, insetT: y, width: SIZE, height: SIZE, overflow: 1, bgColor: "#0b1416" }}
>
  <Image src="art/map-e1m1.png" style={{ posType: 1, insetL: 0, insetT: 0, width: 256, height: 256 }} />
  <View nodeRef={(n) => (marker = n)} style={{ posType: 1, insetL: 0, insetT: 0, width: 4, height: 4, bgColor: "#ff5040" }} />
</View>
