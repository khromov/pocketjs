<script lang="ts">
  // The status panel: beside the playfield on a single screen, on the bottom
  // screen of the 3DS. Every value is a whole text run ("LIVES 2", "LOCK ON")
  // so the sim tests can read the game through the tree.
  import { untrack } from "svelte";
  import { Image, Text, View } from "@pocketjs/framework/svelte/components";
  import type { NodeMirror } from "@pocketjs/framework/svelte/components";
  import { MODE_CLEAR, MODE_OVER, MODE_PAUSE } from "./game/constants.ts";
  import { SCORE_DIGITS, hud, refs } from "./hud.svelte.ts";

  let { w, h, aux }: { w: number; h: number; aux: boolean } = $props();

  /** A side panel under 160 px (a 400x240 host with no second screen) drops a size. */
  const narrow = untrack(() => w) < 160;

  const DIGITS = Array.from({ length: SCORE_DIGITS }, (_, i) => i);
  const LIFE_SLOTS = [0, 1, 2];
  const BOMB_SLOTS = [0, 1, 2];

  const livesText = $derived(`LIVES ${hud.lives}`);
  const bombsText = $derived(`BOMBS ${hud.bombs}`);
  const lockText = $derived(hud.lock ? "LOCK ON" : "LOCK OFF");
  const phaseText = $derived(`PHASE ${hud.phase + 1}`);
  const status = $derived(
    hud.mode === MODE_PAUSE
      ? "PAUSED"
      : hud.mode === MODE_OVER
        ? "GAME OVER"
        : hud.mode === MODE_CLEAR
          ? "STAGE CLEAR"
          : hud.boss
            ? "BOSS"
            : "STAGE 1",
  );
</script>

<View debugName="Hud" class="flex-col justify-between p-3 bg-[#120a24]" style={{ width: w, height: h }}>
  <View class="flex-col gap-1">
    <Text class={narrow ? "text-xs text-white font-bold tracking-wide" : "text-base text-white font-bold tracking-wide"}>
      {narrow ? "SHOOTER" : "SVELTE SHOOTER"}
    </Text>
    <Text class="text-xs text-slate-400 tracking-wide">SCORE</Text>
    <View debugName="Score" class="flex-row gap-1">
      {#each DIGITS as i (i)}
        <Image class={narrow ? "w-[12] h-[12]" : "w-[16] h-[16]"} src="art/n0.png" nodeRef={(n: NodeMirror) => (refs.digits[i] = n)} />
      {/each}
    </View>
  </View>

  <View class="flex-col gap-2">
    <View class="flex-row items-center gap-1">
      {#each LIFE_SLOTS as i (i)}
        <Image class={i < hud.lives ? "w-[16] h-[16]" : "w-[16] h-[16] opacity-20"} src="art/life.png" />
      {/each}
      <Text class="text-xs text-slate-300 tracking-wide">{livesText}</Text>
    </View>
    <View class="flex-row items-center gap-1">
      {#each BOMB_SLOTS as i (i)}
        <View class={i < hud.bombs ? "w-[10] h-[10] rounded-full bg-cyan-400" : "w-[10] h-[10] rounded-full bg-slate-700"} />
      {/each}
      <Text class="text-xs text-slate-300 tracking-wide">{bombsText}</Text>
    </View>
    <View
      class={hud.lock
        ? "flex-row items-center gap-2 rounded-md px-2 py-1 bg-emerald-700"
        : "flex-row items-center gap-2 rounded-md px-2 py-1 bg-slate-800"}
    >
      <View class={hud.lock ? "w-[8] h-[8] rounded-full bg-emerald-200" : "w-[8] h-[8] rounded-full bg-slate-600"} />
      <Text class={hud.lock ? "text-xs text-emerald-100 font-bold tracking-wide" : "text-xs text-slate-400 font-bold tracking-wide"}>
        {lockText}
      </Text>
    </View>
  </View>

  <View class="flex-col gap-1">
    <Text class="text-xs text-rose-300 font-bold tracking-wide">{status}</Text>
    {#if hud.boss}
      <Text class="text-xs text-slate-400">{phaseText}</Text>
    {/if}
    <View class="w-full h-[6] rounded-sm bg-slate-800 overflow-hidden">
      <View
        class="w-full h-full bg-rose-500"
        style={{ originX: -0.5, scaleX: 1, opacity: 0 }}
        nodeRef={(n: NodeMirror) => (refs.bossBar = n)}
      />
    </View>
  </View>

  <View class="flex-col">
    <Text class="text-xs text-slate-500">{aux ? "B  FIRE    A  BOMB" : narrow ? "CROSS  FIRE" : "CROSS  FIRE    CIRCLE  BOMB"}</Text>
    <Text class="text-xs text-slate-500">L  SLOW    R  LOCK</Text>
    <Text class="text-xs text-slate-600">ART KENNEY.NL CC0</Text>
  </View>
</View>
