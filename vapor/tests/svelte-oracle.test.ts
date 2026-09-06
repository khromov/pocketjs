// vapor/tests/svelte-oracle.test.ts — VAPOR TODO under real Svelte 5.
//
// The .svelte runs unmodified on the vendored Svelte runtime through the
// custom renderer over the micro-DOM (vapor/oracle/renderer-svelte.ts),
// painted to the 30x20 grid. Same behaviors, same expected strings as the
// Vue oracle in oracle.test.ts; svelte-parity.test.ts compares the two
// after every press of the shared tape.

import { join } from "node:path";
import { compileSvelteApp } from "../compiler/svelte.ts";
import { bootOracle } from "../oracle/boot.ts";
import { todoBehaviors } from "./todo-behaviors.ts";

const ENTRY = join(import.meta.dir, "..", "examples", "todo-svelte", "todo.svelte");
const styles = compileSvelteApp(ENTRY, await Bun.file(ENTRY).text(), "VAPOR TODO", "gba").styles;

todoBehaviors("vapor todo under real Svelte", () => bootOracle({ framework: "svelte", styles }));
