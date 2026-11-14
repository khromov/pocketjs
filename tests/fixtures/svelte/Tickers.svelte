<script lang="ts">
  import Ticker from "./Ticker.svelte";
  import { input } from "./input-state.svelte.ts";
</script>

<Ticker />
{#if input.early}
  <Ticker />
{/if}
