<script lang="ts">
  // A right-aligned number in the status bar's 8x16 digit font (UI.svelte's
  // `.font-N` cells). Leading cells stay blank, as on the original bar.
  import { Image } from "@pocketjs/framework/svelte/components";

  const DIGITS = [
    "art/digit-0.png",
    "art/digit-1.png",
    "art/digit-2.png",
    "art/digit-3.png",
    "art/digit-4.png",
    "art/digit-5.png",
    "art/digit-6.png",
    "art/digit-7.png",
    "art/digit-8.png",
    "art/digit-9.png",
  ];

  let { value, digits, x, y = 16 }: { value: number; digits: number; x: number; y?: number } = $props();

  const cells = $derived.by(() => {
    const max = 10 ** digits - 1;
    const text = String(Math.max(0, Math.min(max, Math.floor(value)))).padStart(digits, " ");
    const out: number[] = [];
    for (let i = 0; i < digits; i++) {
      const c = text.charCodeAt(i);
      out.push(c >= 48 && c <= 57 ? c - 48 : -1);
    }
    return out;
  });
</script>

{#each cells as d, i (i)}
  {#if d >= 0}
    <Image src={DIGITS[d]} style={{ posType: 1, insetL: x + i * 8, insetT: y, width: 8, height: 16 }} />
  {/if}
{/each}
