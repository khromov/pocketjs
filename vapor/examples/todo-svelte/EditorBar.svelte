<script lang="ts">
  let { line, draft, glyph }: { line: number; draft: string; glyph: string } = $props();
</script>

<row y={line} x={1} class="bg-amber-300 text-slate-950">NEW: {draft}[{glyph}]</row>
