<script lang="ts">
  // The auxiliary (3DS bottom) screen every Svelte demo shares: the Svelte
  // mark, turning, over the app's own caption.
  //
  // Guarded rather than unconditional. AuxiliarySurface calls
  // getAuxiliarySurfaceRoots() from onMount, which throws when the host
  // publishes no auxiliary surface — the Solid component behaves the same —
  // so one shell that also builds for the PSP has to ask first. Where
  // ui.__auxiliarySurface is absent (PSP, Vita, web) this renders nothing and
  // the demo is exactly the app it was.
  //
  // The spin is pre-baked frames, not an animated `rotate`. engine/core/src/
  // draw.rs conservatively CULLS rotated IMAGE quads on every host, so a
  // rotate tween would make the mark vanish instead of turn. This is the same
  // shape as the spinner-00..07 frames apps/hero cycles.
  import {
    AuxiliarySurface,
    Image,
    Text,
    View,
  } from "@pocketjs/framework/svelte/components";
  import { hasAuxiliarySurface } from "@pocketjs/framework/svelte/display";
  import { createSpriteAnimation } from "@pocketjs/framework/svelte/lifecycle";

  let { caption = "" }: { caption?: string } = $props();

  const FRAMES = [
    "svelte-spin-00.png",
    "svelte-spin-01.png",
    "svelte-spin-02.png",
    "svelte-spin-03.png",
    "svelte-spin-04.png",
    "svelte-spin-05.png",
    "svelte-spin-06.png",
    "svelte-spin-07.png",
    "svelte-spin-08.png",
    "svelte-spin-09.png",
    "svelte-spin-10.png",
    "svelte-spin-11.png",
  ];

  // 12 frames held 4 vblanks each: one revolution in 48 frames, 0.8 s at 60 Hz.
  const spin = createSpriteAnimation(FRAMES, { frameStep: 4 });

  // Read once. The surface is mounted by installHost() before the app mounts
  // and is never added or removed afterwards, so this needs no reactivity.
  const auxiliary = hasAuxiliarySurface();
</script>

{#if auxiliary}
  <AuxiliarySurface>
    <View class="w-full h-full flex-col items-center justify-center gap-3 bg-gradient-to-b from-slate-50 to-slate-200">
      <Image class="w-[64] h-[64]" src={spin.current} />
      <Text class="text-lg text-slate-900 font-bold tracking-wide">Svelte</Text>
      {#if caption}
        <Text class="text-xs text-slate-500 tracking-wide">{caption}</Text>
      {/if}
    </View>
  </AuxiliarySurface>
{/if}
