<script lang="ts">
  let { line, count, label }: { line: number; count: number; label: string } = $props();
</script>

<row y={line} x={1} class="text-emerald-400">{count} LEFT / {label}</row>
