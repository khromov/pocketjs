<script lang="ts">
  let { line, text }: { line: number; text: string } = $props();
</script>

<row y={line} x={1} class="text-slate-500">{text}</row>
