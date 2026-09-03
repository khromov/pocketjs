// tools/dev-svelte.ts — the browser host on :8130 with ONLY the Svelte demos.
//
//   bun run dev:svelte              # wasm + every Svelte demo + serve
//   bun run dev:svelte -- --no-build   # serve what is already in dist/
//   PORT=9000 bun run dev:svelte
//
// tools/build.ts --framework=svelte names its output <app>.svelte, so the
// Svelte bundles are already distinguishable inside a dist/ shared with Solid,
// Vue Vapor and Octane builds. This serves the same hosts/web dev server with
// POCKETJS_DEMO_FILTER pinned to that suffix, so the picker lists the Svelte
// demos and nothing else.
//
// An app qualifies exactly as it does for tools/psp-svelte.ts: it ships a
// Svelte mounting entry (main.svelte.ts), or its manifest already declares
// Svelte. Nothing is hardcoded, so a new Svelte demo shows up on its own.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const APPS = join(ROOT, "apps");

const argv = Bun.argv.slice(2);
const build = !argv.includes("--no-build");

const demos = readdirSync(APPS, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort()
  .flatMap((name) => {
    let manifest: { app?: { output?: string; framework?: string } };
    try {
      manifest = JSON.parse(readFileSync(join(APPS, name, "pocket.json"), "utf8"));
    } catch {
      return [];
    }
    const output = manifest.app?.output;
    if (!output) return [];
    const svelte = existsSync(join(APPS, name, "main.svelte.ts")) ||
      manifest.app?.framework === "svelte";
    return svelte ? [output] : [];
  });

if (demos.length === 0) throw new Error("dev-svelte: no Svelte demos found under apps/");
console.log(`dev-svelte: ${demos.length} demo(s): ${demos.join(", ")}`);

function run(cmd: string[]): void {
  console.log(`dev-svelte: ${cmd.join(" ")}`);
  const p = Bun.spawnSync(cmd, { cwd: ROOT, stdout: "inherit", stderr: "inherit" });
  if (p.exitCode !== 0) process.exit(p.exitCode ?? 1);
}

if (build) {
  run([process.execPath, "tools/wasm.ts"]);
  for (const demo of demos) {
    run([process.execPath, "tools/build.ts", demo, "--framework=svelte"]);
  }
}

// Set before importing serve.ts — demoManifest() reads it per request, but the
// startup banner is printed at import time.
process.env.POCKETJS_DEMO_FILTER = "\\.svelte$";
await import("../hosts/web/serve.ts");
