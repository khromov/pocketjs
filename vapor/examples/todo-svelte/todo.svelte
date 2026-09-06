<!--
  VAPOR TODO — TodoMVC for Pocket hardware, written as Svelte 5.

  This file has two execution paths. Under the oracle it runs unmodified on
  the real Svelte runtime (custom renderer over the micro-DOM) — $state and
  $derived are the real thing and the child components are genuine Svelte
  components. Under the Pocket Vapor compiler the front end
  (vapor/compiler/svelte.ts) lowers it to the Vue-subset TSX of
  ../todo/todo.tsx and the back end compiles that to C: runes become
  state-struct slots and cached recompute functions, rows become paint
  effects with compile-time dependency masks, keymaps become ROM
  function-pointer tables, child components inline to zero-cost paint code,
  and the todo list becomes a fixed-capacity arena pool. Same semantics, no
  JavaScript engine.

  Controls — list mode: Up/Down cursor, A toggle done, B delete, R cycle
  filter, Select clear completed, Start new todo. Edit mode: Left/Right
  scrub glyph, A put glyph, B backspace, Start save, Select cancel.
-->
<script lang="ts">
  import { Button, onButton } from "../../host/input.ts";
  import { SCREEN } from "../../host/screen.ts";
  import type { Keymap, Todo } from "./types.ts";
  import TitleBar from "./TitleBar.svelte";
  import StatusBar from "./StatusBar.svelte";
  import TodoRow from "./TodoRow.svelte";
  import Notice from "./Notice.svelte";
  import EditorBar from "./EditorBar.svelte";
  import HelpBar from "./HelpBar.svelte";

  const FILTERS = ["ALL", "ACTIVE", "DONE"];
  const GLYPHS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ 0123456789";
  const LIST_Y = 3;
  const WINDOW = SCREEN.height - 8;
  const EDIT_Y = SCREEN.height - 3;
  const HELP_Y = SCREEN.height - 1;
  const TEXT_MAX = 20;
  const NARROW = SCREEN.width < 30;

  let todos = $state<Todo[]>([
    { text: "SHIP POCKET VAPOR", done: false },
    { text: "WRITE THE COMPILER", done: true },
    { text: "RUN ON DEVICE", done: false },
  ]);
  let cursor = $state(0);
  let filter = $state(0);
  let editing = $state(false);
  let draft = $state("");
  let glyph = $state(0);

  const filtered = $derived(
    filter === 0 ? todos : filter === 1 ? todos.filter((t) => !t.done) : todos.filter((t) => t.done),
  );
  const remaining = $derived(todos.filter((t) => !t.done).length);
  const current = $derived(filtered[cursor]);
  const scroll = $derived(Math.max(0, Math.min(cursor - WINDOW + 1, filtered.length - WINDOW)));
  const visible = $derived(filtered.slice(scroll, scroll + WINDOW));

  function moveCursor(d: number) {
    cursor = Math.max(0, Math.min(cursor + d, filtered.length - 1));
  }
  function scrubGlyph(d: number) {
    glyph = (glyph + d + GLYPHS.length) % GLYPHS.length;
  }
  function toggleDone() {
    const t = current;
    if (t) t.done = !t.done;
    moveCursor(0);
  }
  function deleteCurrent() {
    const t = current;
    if (t) todos = todos.filter((x) => x !== t);
    moveCursor(0);
  }
  function clearDone() {
    todos = todos.filter((t) => !t.done);
    moveCursor(0);
  }
  function cycleFilter() {
    filter = (filter + 1) % FILTERS.length;
    moveCursor(0);
  }
  function openEditor() {
    editing = true;
    glyph = 0;
  }
  function closeEditor() {
    draft = "";
    editing = false;
  }
  function putGlyph() {
    if (draft.length < TEXT_MAX) draft += GLYPHS[glyph];
  }
  function saveDraft() {
    if (draft.length > 0) {
      todos.push({ text: draft, done: false });
      closeEditor();
    }
  }

  const listKeys: Keymap = {
    [Button.Up]: () => moveCursor(-1),
    [Button.Down]: () => moveCursor(1),
    [Button.A]: toggleDone,
    [Button.B]: deleteCurrent,
    [Button.R]: cycleFilter,
    [Button.Right]: cycleFilter,
    [Button.Select]: clearDone,
    [Button.Start]: openEditor,
  };

  const editKeys: Keymap = {
    [Button.Left]: () => scrubGlyph(-1),
    [Button.Right]: () => scrubGlyph(1),
    [Button.A]: putGlyph,
    [Button.B]: () => {
      draft = draft.slice(0, -1);
    },
    [Button.Start]: saveDraft,
    [Button.Select]: closeEditor,
  };

  onButton((b) => (editing ? editKeys : listKeys)[b]?.());
</script>

<TitleBar line={0} text="POCKET VAPOR TODO" />
<StatusBar line={1} count={remaining} label={FILTERS[filter]} />
{#each visible as t, i}
  <TodoRow line={LIST_Y + i} todo={t} selected={t === current} />
{/each}
{#if filtered.length === 0}
  <Notice line={LIST_Y} text="NOTHING HERE" />
{/if}
{#if editing}
  <EditorBar line={EDIT_Y} draft={draft} glyph={GLYPHS[glyph]} />
{/if}
<HelpBar
  line={HELP_Y}
  text={editing
    ? NARROW
      ? "A:+ B:- ST:OK SE:Q"
      : "A:PUT B:DEL ST:SAVE SE:QUIT"
    : NARROW
      ? "A:OK B:X >:F ST:NEW"
      : "A:DONE B:DEL R:FILT ST:NEW"}
/>
