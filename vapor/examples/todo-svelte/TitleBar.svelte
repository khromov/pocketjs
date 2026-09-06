<script lang="ts">
  let { line, text }: { line: number; text: string } = $props();
</script>

<row y={line} class="bg-emerald-500 text-slate-950 align-center">{text}</row>
