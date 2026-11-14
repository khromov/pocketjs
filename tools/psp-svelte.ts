// tools/psp-svelte.ts — one command for a Svelte-only PSP launcher EBOOT.
//
//   bun run psp:svelte                     # build + install into PPSSPP's memstick
//   bun run psp:svelte -- --no-install     # build only
//   bun run psp:svelte -- --svelte-shell   # the launcher shell from apps/launcher/app.svelte too
//
// tools/launcher.ts computes its app set from each apps/*/pocket.app.json and
// has no framework override, so a demo's Svelte twin entry (main.svelte.ts) is
// invisible to it: the manifest says framework=solid and entry=main.tsx. This
// script points those manifests at their Svelte entries for the pack step,
// without app.aot and app.model (they select the Solid compile), through
// tools/manifest-rewrites.ts: under the checkout's manifest lock, journaled,
// and restored when the pack step ends, fails or is interrupted. Every app
// with no Svelte entry is excluded, and so are the demos in
// tools/launcher.ts's PSP_STANDALONE_OUTPUTS, which ship as their own EBOOTs.
// The launcher lock is held from the pack step to the native build.
//
// The steps are the ones `tools/launcher.ts build --target psp` runs, with two
// changes after its `pack` step:
//   1. `tools/launcher.ts pack --target psp --force --exclude …` compiles the
//      apps, writes dist/launcher-registry.tsv and the isolated launcher source
//      (dist/launcher/psp/.launcher-source/), and packs dist/packages/*.pocket.
//   2. --svelte-shell: the isolated source gets a Svelte entry that mounts
//      apps/launcher/app.svelte over the same generated registry, and
//      `pocket compile` replaces dist/packages/launcher-main.pocket with it.
//   3. The XMB metadata goes beside the isolated entry (<entry dir>/psp/, where
//      tools/psp.ts reads it): the launcher's Psp.toml and a white plate with
//      the Svelte logo as ICON0 and PIC1. No committed file is rewritten.
//   4. `pocket build --target psp --pocket dist/packages/launcher-main.pocket
//      --out dist/native -- --launcher-registry=dist/launcher-registry.tsv`
//      writes dist/native/launcher-main.pbp. The PSP build executor always
//      builds the cargo release profile, so there is no debug variant.
//
// --force is required: needsLauncherCompile() and renderCovers() in
// tools/launcher.ts reuse an existing dist/<output>.js, so without it the pack
// step packages the previously built Solid bundle under the Svelte plan and
// the EBOOT claims Svelte and runs Solid. For the same reason the files this
// build leaves under Solid output names (twinOutputs: the flipped twins' and
// the gallery launcher's) are removed when the build ends, and the next Solid
// build compiles them again.

import { $ } from "bun";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { bakeSvg } from "../framework/compiler/bake-svg.ts";
import { LAUNCHER_LOCK_HOLDER_ENV, PSP_STANDALONE_OUTPUTS, withLauncherSourceLock } from "./launcher.ts";
import { withManifestRewrites } from "./manifest-rewrites.ts";
import { encodePNG } from "../tests/png.ts";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const APPS = join(ROOT, "apps");
const SHELL_OUTPUT = "launcher-main";
// tools/launcher.ts launcherPaths("psp").
const DIST = join(ROOT, "dist");
const ISOLATED_SOURCE = join(DIST, "launcher/psp/.launcher-source");
const PACKAGES = join(DIST, "packages");
const REGISTRY_TSV = join(DIST, "launcher-registry.tsv");
const LAUNCHER_POCKET = join(PACKAGES, `${SHELL_OUTPUT}.pocket`);
// The PSP build executor writes {outdir}/{output}.pbp (tools/build/programs/psp.ts).
const NATIVE_OUT = join(DIST, "native");
const BUILT_EBOOT = join(NATIVE_OUT, `${SHELL_OUTPUT}.pbp`);

const argv = Bun.argv.slice(2);
for (const arg of argv) {
  if (arg === "--debug") {
    console.error("psp-svelte: --debug was removed; the PSP build executor always builds the release profile");
    process.exit(1);
  }
  if (arg !== "--no-install" && arg !== "--svelte-shell") {
    console.error(`psp-svelte: unknown option ${arg} (expected --no-install, --svelte-shell)`);
    process.exit(1);
  }
}
const install = !argv.includes("--no-install");
const svelteShell = argv.includes("--svelte-shell");

interface Manifest {
  app: { entry: string; output: string; framework?: string; aot?: boolean; model?: string };
}

function manifestPath(app: string): string {
  return join(APPS, app, "pocket.app.json");
}

function readManifest(app: string): Manifest | undefined {
  try {
    return JSON.parse(readFileSync(manifestPath(app), "utf8")) as Manifest;
  } catch {
    return undefined;
  }
}

// An app is Svelte-capable if it ships a Svelte mounting entry, or its manifest
// already declares Svelte (apps/svelte-lab). Everything else is excluded.
const apps = readdirSync(APPS, { withFileTypes: true })
  .filter((e) => e.isDirectory())
  .map((e) => e.name)
  .sort()
  .flatMap((name) => {
    const manifest = readManifest(name);
    if (!manifest?.app?.output) return [];
    const variant = join(APPS, name, "main.svelte.ts");
    return [{
      name,
      output: manifest.app.output,
      manifest,
      variant: existsSync(variant) ? `apps/${name}/main.svelte.ts` : undefined,
      declared: manifest.app.framework === "svelte",
    }];
  });

const demos = apps.filter(
  (a) =>
    a.output !== SHELL_OUTPUT && (a.variant || a.declared) && !PSP_STANDALONE_OUTPUTS.has(a.output),
);
const excluded = apps.filter((a) => a.output !== SHELL_OUTPUT && !demos.includes(a));

if (demos.length === 0) throw new Error("psp-svelte: no Svelte-capable demos found under apps/");
const shellComponent = join(APPS, "launcher/app.svelte");
if (svelteShell && !existsSync(shellComponent)) {
  throw new Error(`psp-svelte: --svelte-shell needs ${relative(ROOT, shellComponent)}`);
}

// Only manifests that need rewriting are touched; a demo already declaring
// Svelte (and pointing at a Svelte entry) is left exactly as it is.
const flip = demos.filter((a) => a.variant && (!a.declared || a.manifest.app.entry !== a.variant));

/** White plate with the Svelte logo centered, alpha composited over it. The
 *  logo's inner mark is white by design, so it reads as cut out of the orange
 *  body — the same way the official logo sits on a light page. */
function logoPlate(width: number, height: number, logo: number): Buffer {
  const source = readFileSync(join(ROOT, "assets/images/svelte-logo.svg"), "utf8")
    .replace(/(<svg\b[^>]*?)width="[^"]*"/, `$1width="${logo}"`)
    .replace(/(<svg\b[^>]*?)height="[^"]*"/, `$1height="${logo}"`);
  const mark = bakeSvg(source, 1);
  const out = new Uint8Array(width * height * 4).fill(255);
  const left = Math.round((width - mark.width) / 2);
  const top = Math.round((height - mark.height) / 2);
  for (let y = 0; y < mark.height; y++) {
    const ty = top + y;
    if (ty < 0 || ty >= height) continue;
    for (let x = 0; x < mark.width; x++) {
      const tx = left + x;
      if (tx < 0 || tx >= width) continue;
      const s = (y * mark.width + x) * 4;
      const d = (ty * width + tx) * 4;
      const alpha = mark.rgba[s + 3] / 255;
      for (let c = 0; c < 3; c++) {
        out[d + c] = Math.round(mark.rgba[s + c] * alpha + out[d + c] * (1 - alpha));
      }
      out[d + 3] = 255;
    }
  }
  return encodePNG(out, width, height);
}

/** The files this build leaves under a Solid output name: a flipped twin's
 *  dist/<output>.{js,worker.js,pak,pocket,styles.ts} and launcher covers, and
 *  the gallery launcher's dist/launcher-main.* (this deck's registry and
 *  order). A later `tools/launcher.ts build` without --force,
 *  `tools/psp.ts <app> --skip-build` or the sim's bootWorld would reuse them
 *  under the committed Solid manifests, so they go once the EBOOT is built,
 *  or when the build fails or is interrupted. The EBOOT embeds
 *  dist/packages/, which keeps its copies. */
const DIST_OUTPUT_EXTENSIONS = [".js", ".worker.js", ".pak", ".pocket", ".styles.ts"];
const twinOutputs = [
  ...flip.flatMap((app) => [
    ...DIST_OUTPUT_EXTENSIONS.map((ext) => join(DIST, `${app.output}${ext}`)),
    ...["png", "placeholder"].map((ext) => join(APPS, `launcher/covers/cover-${app.output}.${ext}`)),
    join(APPS, `launcher/covers/refl-${app.output}.png`),
  ]),
  ...DIST_OUTPUT_EXTENSIONS.map((ext) => join(DIST, `${SHELL_OUTPUT}${ext}`)),
];
function dropTwinOutputs(): void {
  for (const file of twinOutputs) rmSync(file, { force: true });
}

/** Replace the packed Solid launcher with one that mounts app.svelte over the
 *  registry tools/launcher.ts generated for this build. */
async function packSvelteShell(): Promise<void> {
  const manifestFile = join(ISOLATED_SOURCE, "pocket.app.json");
  if (!existsSync(manifestFile)) throw new Error(`psp-svelte: the pack step left no ${relative(ROOT, manifestFile)}`);
  const entry = join(ISOLATED_SOURCE, "main.svelte.ts");
  let component = relative(ISOLATED_SOURCE, shellComponent).replaceAll("\\", "/");
  if (!component.startsWith(".")) component = `./${component}`;
  writeFileSync(
    entry,
    [
      "// GENERATED by tools/psp-svelte.ts — isolated Svelte launcher entry.",
      "// @title PocketJS: Launcher",
      'import { mount } from "@pocketjs/framework/svelte";',
      `import Launcher from ${JSON.stringify(component)};`,
      'import { REGISTRY } from "./registry.generated.ts";',
      "",
      "mount(Launcher, { props: { registry: REGISTRY } });",
      "",
    ].join("\n"),
  );
  const manifest = JSON.parse(readFileSync(manifestFile, "utf8")) as Manifest;
  manifest.app.framework = "svelte";
  manifest.app.entry = relative(ROOT, entry).replaceAll("\\", "/");
  delete manifest.app.aot;
  delete manifest.app.model;
  writeFileSync(manifestFile, JSON.stringify(manifest, null, 2) + "\n");
  console.log(`psp-svelte: shell ${SHELL_OUTPUT} <- ${relative(ROOT, shellComponent)}`);
  await $`bun tools/pocket.ts compile --target psp --manifest ${manifestFile} --project-root ${ROOT} --outdir ${DIST} --output ${LAUNCHER_POCKET}`
    .cwd(ROOT);
}

/** XMB identity for this build: PIC1 is the 480x272 background, ICON0 the
 *  144x80 tile, under the launcher's title. */
function writeXmbMetadata(): void {
  const xmb = join(ISOLATED_SOURCE, "psp");
  mkdirSync(xmb, { recursive: true });
  copyFileSync(join(APPS, "launcher/psp/Psp.toml"), join(xmb, "Psp.toml"));
  writeFileSync(join(xmb, "pic1.png"), logoPlate(480, 272, 150));
  writeFileSync(join(xmb, "icon0.png"), logoPlate(144, 80, 56));
  console.log(`psp-svelte: XMB art -> white + Svelte logo (${relative(ROOT, xmb)})`);
}

console.log(`psp-svelte: ${demos.length} Svelte demo(s): ${demos.map((a) => a.output).join(", ")}`);
console.log(`psp-svelte: shell ${SHELL_OUTPUT} (${svelteShell ? "svelte" : "solid"})`);
console.log(
  `psp-svelte: excluding ${excluded.length} app(s)` +
    ` (${excluded.filter((a) => PSP_STANDALONE_OUTPUTS.has(a.output)).length} standalone, the rest non-Svelte)`,
);

const env: Record<string, string | undefined> = { ...process.env };
const SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"] as const;
// The deck is title-sorted; lead with the games when they are present.
const lead = ["svelte-shooter-main", "svelte-snake-main"].filter((output) =>
  demos.some((app) => app.output === output)
);
if (lead.length > 0) {
  env.POCKETJS_LAUNCHER_FIRST = lead.join(",");
  console.log(`psp-svelte: deck order -> ${lead.join(", ")} first`);
}

// The launcher lock is held from the pack step to the native build, so a
// concurrent `tools/launcher.ts` run cannot replace dist/packages, the
// registry or the isolated source in between; the pack child runs under this
// hold (LAUNCHER_LOCK_HOLDER_ENV). The flipped manifests are rewritten through
// tools/manifest-rewrites.ts and restored when the pack step ends.
await withLauncherSourceLock(async () => {
  env[LAUNCHER_LOCK_HOLDER_ENV] = String(process.pid);
  const interrupted = (): void => {
    dropTwinOutputs();
    process.exit(1);
  };
  try {
    await withManifestRewrites("psp-svelte", async (rewrites) => {
      for (const app of flip) {
        const path = manifestPath(app.name);
        const next = JSON.parse(readFileSync(path, "utf8")) as Manifest;
        next.app.framework = "svelte";
        next.app.entry = app.variant!;
        delete next.app.aot;
        delete next.app.model;
        rewrites.rewrite(path, JSON.stringify(next, null, 2) + "\n");
        console.log(`  svelte: ${app.output} <- ${app.variant}`);
      }
      const excludeArgs = excluded.flatMap((a) => ["--exclude", a.output]);
      await $`bun tools/launcher.ts pack --target psp --force ${excludeArgs}`.cwd(ROOT).env(env);
    }, { onInterrupt: dropTwinOutputs });
    for (const signal of SIGNALS) process.on(signal, interrupted);

    if (!existsSync(REGISTRY_TSV) || !existsSync(LAUNCHER_POCKET)) {
      throw new Error("psp-svelte: the pack step left no launcher registry or launcher package");
    }
    const gallery = readFileSync(REGISTRY_TSV, "utf8")
      .split(/\r?\n/)
      .filter((line) => line.trim())
      .map((line) => line.split("\t")[0]!);
    console.log(`psp-svelte: gallery (${gallery.length}): ${gallery.join(", ")}`);
    const missing = demos.filter((a) => !gallery.includes(a.output));
    if (missing.length > 0) {
      console.warn(`psp-svelte: not admitted for psp, so not in the gallery: ${missing.map((a) => a.output).join(", ")}`);
    }

    if (svelteShell) await packSvelteShell();
    writeXmbMetadata();
    await $`bun tools/pocket.ts build --target psp --pocket ${LAUNCHER_POCKET} --out ${NATIVE_OUT} -- --launcher-registry=${REGISTRY_TSV}`
      .cwd(ROOT)
      .env(env);
    if (!existsSync(BUILT_EBOOT)) throw new Error(`psp-svelte: no EBOOT at ${BUILT_EBOOT}`);
  } finally {
    for (const signal of SIGNALS) process.off(signal, interrupted);
    dropTwinOutputs();
  }
});
const bytes = Bun.file(BUILT_EBOOT).size;
console.log(`\npsp-svelte: EBOOT.PBP ${(bytes / 1048576).toFixed(2)} MiB (${relative(ROOT, BUILT_EBOOT)})`);

// Staged memory-stick layout, matching tools/psp-all.ts's PSP/GAME/<folder>/.
const staged = join(DIST, "psp/PSP/GAME/PocketJS-svelte");
mkdirSync(staged, { recursive: true });
copyFileSync(BUILT_EBOOT, join(staged, "EBOOT.PBP"));
console.log(`  staged   dist/psp/PSP/GAME/PocketJS-svelte/EBOOT.PBP`);

// PPSSPP's memstick root varies by platform and install; PPSSPP_MEMSTICK wins.
if (install) {
  const roots = [
    process.env.PPSSPP_MEMSTICK?.trim(),
    join(homedir(), ".config/ppsspp/PSP"),
    join(homedir(), "Library/Application Support/PPSSPP/PSP"),
    join(homedir(), ".ppsspp/PSP"),
    join(homedir(), "Documents/PPSSPP/PSP"),
  ].filter((path): path is string => !!path);
  const root = roots.find((path) => existsSync(join(path, "GAME")) || existsSync(path));
  if (!root) {
    console.log("  install  skipped — no PPSSPP memstick found (set PPSSPP_MEMSTICK)");
  } else {
    const target = join(root, "GAME/PocketJS-svelte");
    mkdirSync(target, { recursive: true });
    copyFileSync(BUILT_EBOOT, join(target, "EBOOT.PBP"));
    console.log(`  install  ${target}/EBOOT.PBP`);
    console.log("\nOpen PPSSPP's \"Homebrew & Demos\" tab. Enter summons the picker.");
  }
}
