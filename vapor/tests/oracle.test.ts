// vapor/test/oracle.test.ts — VAPOR TODO under real Vue Vapor (the oracle).
//
// These tests pin the app's semantics on the reference implementation:
// vue 3.6 runtime-with-vapor over the micro-DOM, painted to the 30x20 grid.
// The ROM parity suite replays the same button tapes against the compiled
// .gba and compares grids cell-for-cell. The behaviors live in
// todo-behaviors.ts so the Svelte oracle (svelte-oracle.test.ts) pins the
// same strings.

import { join } from "node:path";
import { compileVaporApp } from "../compiler/compile.ts";
import { bootOracle } from "../oracle/boot.ts";
import { todoBehaviors } from "./todo-behaviors.ts";

const ENTRY = join(import.meta.dir, "..", "examples", "todo", "todo.tsx");
const styles = compileVaporApp(ENTRY, await Bun.file(ENTRY).text(), "VAPOR TODO", "gba").styles;

todoBehaviors("vapor todo oracle", () => bootOracle({ styles }));
