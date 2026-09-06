<script lang="ts">
  import type { Todo } from "./types.ts";

  let { line, todo, selected }: { line: number; todo: Todo; selected: boolean } = $props();
</script>

<row y={line} x={1} class={selected ? "bg-slate-100 text-slate-950" : todo.done ? "text-slate-500" : ""}>{selected ? ">" : " "}[{todo.done ? "X" : " "}] {todo.text}</row>
