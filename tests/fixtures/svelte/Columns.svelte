<script lang="ts">
  import { onMount } from "svelte";
  import { Text, useViewport, type Viewport } from "@pocketjs/framework/svelte/components";

  let { expose }: { expose?: (viewport: Viewport) => void } = $props();

  // Three columns of 200 px with a 20 px gap need 640; the count follows the width.
  const viewport = useViewport();
  onMount(() => expose?.(viewport));
  const columns = $derived(Math.max(1, Math.floor((viewport.current.w + 20) / 220)));
</script>

<Text>{columns} columns at {viewport.current.w}x{viewport.current.h}</Text>
