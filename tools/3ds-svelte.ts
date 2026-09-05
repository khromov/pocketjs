// tools/3ds-svelte.ts — Svelte demos as Nintendo 3DS .3dsx artifacts.
//
//   bun run 3ds:svelte                  # every Svelte-capable demo -> dist/3ds/
//   bun run 3ds:svelte -- hero cards    # only the named apps
//   bun run 3ds:svelte -- --cia         # also write installable .cia titles
//   bun run 3ds:svelte -- --keep-going  # build the rest when one app fails
//
// tools/3ds.ts builds one app from its apps/<app>/pocket.json, and three parts
// of a demo manifest describe the PSP rather than the 3DS:
//
//   1. framework/entry. A demo's Svelte variant lives at main.svelte.ts while
//      the manifest says framework=solid and entry=main.tsx, so the Svelte
//      code is invisible to any build driven by the committed manifest. This
//      is the same blind spot tools/psp-svelte.ts works around.
//   2. viewport. The demos declare the PSP's 480x272 under `integer-fit`.
//      The 3ds-dev profile (tools/3ds-profile.ts) publishes one logical
//      viewport, 400x240, and one presentation, `native`, so an unmodified
//      demo manifest is rejected by admission before anything is compiled:
//      "target does not support logical viewport 480x272".
//   3. the auxiliary surface, which is the host's requirement rather than the
//      app's. hosts/3ds/src/main.c takes POCKETJS_AUX_VIEW_W/H as mandatory
//      `#define`s and drives the bottom screen on every frame, so a
//      single-surface guest reaches the compiler as `-DPOCKETJS_AUX_VIEW_W=`
//      and fails inside main.c rather than at admission. Each build therefore
//      declares the profile's 320x240 auxiliary surface, and `display.auxiliary`
//      with it — the resolver rejects either one on its own. The demos paint
//      nothing there, so the bottom screen stays empty.
//
// The demos' own capability set needs no help: they require text.glyphs.baked
// and input.buttons, both of which 3ds-dev has.
//
// Manifests are committed files. This script rewrites one for the duration of
// one build and restores it in a finally block (and on SIGINT/SIGTERM), so
// nothing here may outlive the process.

import { $ } from "bun";
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { THREE_DS_AUXILIARY_VIEWPORT, THREE_DS_VIEWPORT } from "./3ds-profile.ts";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const APPS = join(ROOT, "apps");

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
  }
  next.app.viewport = THREE_DS_MANIFEST_VIEWPORT;
  next.app.surfaces = THREE_DS_MANIFEST_SURFACES;
  const capabilities = ((next.engine ??= {}).capabilities ??= {});
  capabilities.requires = [
    ...new Set([...(capabilities.requires ?? []), AUXILIARY_CAPABILITY]),
  ];
  return next;
}

function manifestPath(app: string): string {
  return join(APPS, app, "pocket.json");
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

  const backups = new Map<string, string>();
  const restore = (): void => {
    for (const [path, original] of backups) writeFileSync(path, original);
    if (backups.size > 0) console.log(`3ds-svelte: restored ${backups.size} manifest(s)`);
    backups.clear();
  };
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => {
      restore();
      process.exit(1);
    });
  }

  console.log(`3ds-svelte: ${demos.length} demo(s): ${demos.map((a) => a.name).join(", ")}`);
  if (selected.size === 0 && shell.length > 0) {
    console.log(`3ds-svelte: excluding ${SHELL_OUTPUT} (no 3ds target in tools/launcher.ts)`);
  }

  const built: string[] = [];
  const failed: { name: string; error: string }[] = [];
  try {
    for (const app of demos) {
      const path = manifestPath(app.name);
      const original = readFileSync(path, "utf8");
      backups.set(path, original);
      const next = threeDsSvelteManifest(JSON.parse(original) as Manifest, app.variant);
      writeFileSync(path, JSON.stringify(next, null, 2) + "\n");

      console.log(
        `\n3ds-svelte: ${app.name} (${next.app.entry}) -> ` +
          `${THREE_DS_VIEWPORT.join("x")} native`,
      );
      try {
        await $`bun tools/3ds.ts ${app.name} ${cia ? ["--cia"] : []}`.cwd(ROOT).quiet();
      } catch (error) {
        if (!keepGoing) throw error;
        const message = (error instanceof Error ? error.message : String(error)).split("\n")[0]!;
        console.log(`  FAILED ${app.name}: ${message}`);
        failed.push({ name: app.name, error: message });
        continue;
      } finally {
        writeFileSync(path, original);
        backups.delete(path);
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
  } finally {
    restore();
  }

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
