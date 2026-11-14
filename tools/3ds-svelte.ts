// tools/3ds-svelte.ts — Svelte demos as Nintendo 3DS .3dsx artifacts.
//
//   bun run 3ds:svelte                  # every Svelte-capable demo -> dist/3ds/
//   bun run 3ds:svelte -- hero cards    # only the named apps
//   bun run 3ds:svelte -- --cia         # also write installable .cia titles
//   bun run 3ds:svelte -- --keep-going  # build the rest when one app fails
//
// tools/3ds.ts (products/3ds/build.ts) builds one app from its
// apps/<app>/pocket.app.json, and three parts of a demo manifest describe the
// PSP rather than the 3DS:
//
//   1. framework/entry. A demo's Svelte variant lives at main.svelte.ts while
//      the manifest says framework=solid and entry=main.tsx, so the Svelte
//      code is invisible to any build driven by the committed manifest. This
//      is the same blind spot tools/psp-svelte.ts works around. The Solid
//      compiler settings `app.aot` and `app.model` go with the Solid entry.
//   2. viewport. The demos declare the PSP's 480x272 under `integer-fit`.
//      The 3ds-dev profile (tools/3ds-profile.ts) publishes one logical
//      viewport, 400x240, and one presentation, `native`, so an unmodified
//      demo manifest is rejected by admission before anything is compiled:
//      "target does not support logical viewport 480x272".
//   3. the auxiliary surface. The bottom-screen UIs (Wolfensvelte's
//      BottomScreen, the shooter's HUD, AuxiliarySurface in
//      @pocketjs/framework/svelte) draw into `ui.__auxiliarySurface`. Each
//      build declares the profile's 320x240 auxiliary surface, and
//      `display.auxiliary` with it (the resolver rejects either one on its
//      own), so the resolved plan names the bottom screen as the app's and
//      the runtime sizes `ui.__auxiliarySurface` from the plan. A plan
//      without the surface still gets the whole bottom screen from
//      products/3ds and the profile's 320x240 surface from engine/runtime,
//      but nothing in its package says the app draws there.
//
// The demos' own capability set needs no help: they require text.glyphs.baked
// and input.buttons, both of which 3ds-dev has. An app that presents below
// 60 Hz declares it in <entry dir>/3ds/host.toml (`pocketjs_sim_hz`), which
// products/3ds/build.ts reads; the build log line `presents at N Hz` is
// repeated here.
//
// Manifests are committed files. tools/build.ts reads the manifest next to the
// entry to check the plan's compiler settings, so the rewrite has to be the
// file at apps/<app>/pocket.app.json. This script rewrites it for the duration
// of one build through tools/manifest-rewrites.ts: under the checkout's
// manifest lock, journaled, and restored when the build ends, fails or is
// interrupted (SIGINT, SIGTERM, SIGHUP).

import { $ } from "bun";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { THREE_DS_AUXILIARY_VIEWPORT, THREE_DS_VIEWPORT } from "./3ds-profile.ts";
import { withManifestRewrites } from "./manifest-rewrites.ts";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const APPS = join(ROOT, "apps");
/** The manifest file tools/3ds.ts reads for an app name. */
export const MANIFEST_FILE = "pocket.app.json";
/** Lines of a failed build's output repeated under its FAILED line. */
const FAILURE_TAIL_LINES = 40;

// tools/launcher.ts only knows psp, vita and symbian, so there is no
// multi-app 3DS package for a shell to front. The launcher is a deck over
// other apps rather than a demo, so a standalone .3dsx of it would ship an
// empty one; it is excluded until launcher.ts grows a 3ds target.
export const SHELL_OUTPUT = "launcher-main";

export interface Manifest {
  engine?: { capabilities?: { requires?: string[] } };
  app: {
    entry: string;
    output: string;
    framework?: string;
    viewport?: unknown;
    surfaces?: unknown;
    aot?: boolean;
    model?: string;
  };
}

export interface SvelteApp {
  readonly name: string;
  readonly output: string;
  /** Repository-relative Svelte entry, absent when the manifest declares Svelte. */
  readonly variant?: string;
  readonly declared: boolean;
}

/** The 3ds-dev profile's one logical viewport and its auxiliary surface. */
export const THREE_DS_MANIFEST_VIEWPORT = {
  fixed: { logical: [THREE_DS_VIEWPORT[0], THREE_DS_VIEWPORT[1]], presentation: "native" },
};
export const THREE_DS_MANIFEST_SURFACES = {
  auxiliary: {
    fixed: {
      logical: [THREE_DS_AUXILIARY_VIEWPORT[0], THREE_DS_AUXILIARY_VIEWPORT[1]],
      presentation: "native",
    },
  },
};
export const AUXILIARY_CAPABILITY = "display.auxiliary";

/**
 * The manifest one 3DS build sees: the app's own, pointed at its Svelte entry
 * and re-declared for the 3ds-dev display. Pure — the caller owns the file.
 */
export function threeDsSvelteManifest(manifest: Manifest, variant?: string): Manifest {
  const next = JSON.parse(JSON.stringify(manifest)) as Manifest;
  if (variant) {
    next.app.framework = "svelte";
    next.app.entry = variant;
    // Solid AOT settings: tools/build.ts would lower the Svelte entry through
    // the Solid compiler model.
    delete next.app.aot;
    delete next.app.model;
  }
  next.app.viewport = THREE_DS_MANIFEST_VIEWPORT;
  next.app.surfaces = THREE_DS_MANIFEST_SURFACES;
  const capabilities = ((next.engine ??= {}).capabilities ??= {});
  capabilities.requires = [
    ...new Set([...(capabilities.requires ?? []), AUXILIARY_CAPABILITY]),
  ];
  return next;
}

export function manifestPath(app: string): string {
  return join(APPS, app, MANIFEST_FILE);
}

function readManifest(app: string): Manifest | undefined {
  try {
    return JSON.parse(readFileSync(manifestPath(app), "utf8")) as Manifest;
  } catch {
    return undefined;
  }
}

/**
 * An app is Svelte-capable if it ships a Svelte mounting entry, or its
 * manifest already declares Svelte (apps/svelte-lab, apps/svelte-snake).
 */
export function svelteCapableApps(): SvelteApp[] {
  return readdirSync(APPS, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort()
    .flatMap((name) => {
      const manifest = readManifest(name);
      if (!manifest?.app?.output) return [];
      const variant = join(APPS, name, "main.svelte.ts");
      const app: SvelteApp = {
        name,
        output: manifest.app.output,
        variant: existsSync(variant) ? `apps/${name}/main.svelte.ts` : undefined,
        declared: manifest.app.framework === "svelte",
      };
      return app.variant || app.declared ? [app] : [];
    });
}

/** The text of a failed tools/3ds.ts run: Bun's ShellError keeps both streams. */
function failureOutput(error: unknown): string {
  const streams = error as { stdout?: Uint8Array; stderr?: Uint8Array };
  const decoder = new TextDecoder();
  const text = [streams.stdout, streams.stderr]
    .filter((s): s is Uint8Array => s instanceof Uint8Array)
    .map((s) => decoder.decode(s))
    .join("\n")
    .trimEnd();
  return text || (error instanceof Error ? error.message : String(error));
}

async function main(argv: readonly string[]): Promise<void> {
  const cia = argv.includes("--cia");
  const keepGoing = argv.includes("--keep-going");
  const selected = new Set(argv.filter((a) => !a.startsWith("-")));

  const candidates = svelteCapableApps();
  let demos = candidates.filter((a) => a.output !== SHELL_OUTPUT);
  const shell = candidates.filter((a) => a.output === SHELL_OUTPUT);

  if (selected.size > 0) {
    const known = new Set(candidates.map((a) => a.name));
    const unknown = [...selected].filter((n) => !known.has(n));
    if (unknown.length > 0) {
      throw new Error(
        `3ds-svelte: not a Svelte-capable app: ${unknown.join(", ")}\n` +
          `  available: ${candidates.map((a) => a.name).join(", ")}`,
      );
    }
    demos = candidates.filter((a) => selected.has(a.name));
  }
  if (demos.length === 0) throw new Error("3ds-svelte: no Svelte-capable demos found under apps/");

  console.log(`3ds-svelte: ${demos.length} demo(s): ${demos.map((a) => a.name).join(", ")}`);
  if (selected.size === 0 && shell.length > 0) {
    console.log(`3ds-svelte: excluding ${SHELL_OUTPUT} (no 3ds target in tools/launcher.ts)`);
  }

  const built: string[] = [];
  const failed: { name: string; error: string }[] = [];
  await withManifestRewrites("3ds-svelte", async (rewrites) => {
    for (const app of demos) {
      const path = manifestPath(app.name);
      const next = threeDsSvelteManifest(JSON.parse(readFileSync(path, "utf8")) as Manifest, app.variant);
      rewrites.rewrite(path, JSON.stringify(next, null, 2) + "\n");

      console.log(
        `\n3ds-svelte: ${app.name} (${next.app.entry}) -> ` +
          `${THREE_DS_VIEWPORT.join("x")} native`,
      );
      let log = "";
      try {
        const result = await $`bun tools/3ds.ts ${app.name} ${cia ? ["--cia"] : []}`
          .cwd(ROOT)
          .quiet();
        log = result.stdout.toString();
      } catch (error) {
        const output = failureOutput(error);
        const lines = output.split("\n");
        console.log(`  FAILED ${app.name}; the last lines of tools/3ds.ts:`);
        for (const line of lines.slice(-FAILURE_TAIL_LINES)) console.log(`    ${line}`);
        if (!keepGoing) throw new Error(`3ds-svelte: ${app.name} failed`);
        failed.push({ name: app.name, error: lines.findLast((l) => l.trim() !== "") ?? "" });
        continue;
      } finally {
        rewrites.restore(path);
      }
      for (const line of log.split("\n")) {
        if (line.includes("presents at")) console.log(`  ${line.trim()}`);
      }

      const artifacts = [
        join(ROOT, `dist/3ds/${app.output}.3dsx`),
        ...(cia ? [join(ROOT, `dist/3ds/${app.output}.cia`)] : []),
      ].filter((p) => existsSync(p));
      if (artifacts.length === 0) {
        throw new Error(`3ds-svelte: ${app.name} produced no artifact in dist/3ds/`);
      }
      for (const artifact of artifacts) {
        console.log(
          `  ${artifact.slice(ROOT.length)}  ` +
            `${(statSync(artifact).size / 1048576).toFixed(2)} MiB`,
        );
      }
      built.push(`${app.name} -> dist/3ds/${app.output}.3dsx`);
    }
  });

  console.log(`\n3ds-svelte: built ${built.length}/${demos.length}`);
  for (const line of built) console.log(`  ${line}`);
  if (failed.length > 0) {
    console.log(`3ds-svelte: ${failed.length} failed`);
    for (const app of failed) console.log(`  ${app.name}: ${app.error}`);
    process.exit(1);
  }
}

if (import.meta.main) {
  try {
    await main(Bun.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
