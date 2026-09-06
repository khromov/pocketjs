<script lang="ts">
  // One shooter, two displays. On a single screen (PSP, Vita, web) the
  // playfield takes 288 px and the HUD the rest; on the 3DS the top screen is
  // all playfield and the HUD moves to the bottom screen. Console hosts
  // publish no viewport, so the spec screen is the fallback; tools/3ds-svelte.ts
  // re-declares the manifest for 400x240 and the runtime reads that back here.
  import { ticksPerFrame } from "@pocketjs/framework/svelte/clock";
  import { AuxiliarySurface, View } from "@pocketjs/framework/svelte/components";
  import { auxiliaryViewport, hasAuxiliarySurface } from "@pocketjs/framework/svelte/display";
  import { getOps, hostViewport } from "@pocketjs/framework/svelte/host";
  import { SEED } from "./game/constants.ts";
  import { computeLayout } from "./game/layout.ts";
  import { createGame } from "./game/state.ts";
  import Hud from "./Hud.svelte";
  import Playfield from "./Playfield.svelte";

  const vp = hostViewport(getOps()) ?? { w: 480, h: 272 };
  // Read once: the surface is mounted before the app and never changes.
  const aux = hasAuxiliarySurface();
  const auxVp = auxiliaryViewport();
  const layout = computeLayout(vp.w, vp.h, aux);
  const game = createGame(layout.playW, layout.playH, ticksPerFrame(), SEED);
</script>

<View debugName="Shooter" class="w-full h-full flex-row bg-black">
  <Playfield {game} w={layout.playW} h={layout.playH} />
  {#if !aux}
    <Hud w={layout.hudW} h={layout.playH} aux={false} />
  {/if}
</View>

{#if aux && auxVp}
  <AuxiliarySurface>
    <Hud w={auxVp.width} h={auxVp.height} aux={true} />
  </AuxiliarySurface>
{/if}
