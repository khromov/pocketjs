<script lang="ts">
  // Registers the module-level tick(): every mounted Ticker shares one function.
  import { onFrame } from "@pocketjs/framework/svelte/lifecycle";
  import { tick } from "./input-state.svelte.ts";

  onFrame(tick);
</script>
