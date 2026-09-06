// tools/psp-svelte.ts — one command for a Svelte-only PSP launcher EBOOT.
//
//   bun run psp:svelte                 # build + install into PPSSPP's memstick
//   bun run psp:svelte -- --no-install # build only
//   bun run psp:svelte -- --svelte-shell   # build the launcher shell as Svelte too
//   bun run psp:svelte -- --debug      # cargo debug profile instead of --release
//
// tools/launcher.ts computes its app set from each apps/*/pocket.json and has
// no framework override, so a demo's Svelte variant entry (main.svelte.ts) is
// invisible to it: the manifest says framework=solid and entry=main.tsx. This
// script points the Svelte-capable manifests at their Svelte entries for the
// duration of one build and restores them in a finally block (and on SIGINT),
// then excludes every app that has no Svelte entry at all.
//
// --force is REQUIRED and not optional: tools/launcher.ts:887 reuses an
// existing dist/<output>.js instead of rebuilding it, so without it the pack
// step silently packages the previously built Solid bundle under the Svelte
// plan and you get an EBOOT that claims Svelte and runs Solid.

import { $ } from "bun";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { bakeSvg } from "../framework/compiler/bake-svg.ts";
import { encodePNG } from "../tests/png.ts";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const APPS = join(ROOT, "apps");
const SHELL_OUTPUT = "launcher-main";

const argv = Bun.argv.slice(2);
const install = !argv.includes("--no-install");
const svelteShell = argv.includes("--svelte-shell");
const profile = argv.includes("--debug") ? [] : ["--release"];

interface Manifest {
  app: { entry: string; output: string; framework?: string };
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

const shell = apps.find((a) => a.output === SHELL_OUTPUT);
const demos = apps.filter((a) => a.output !== SHELL_OUTPUT && (a.variant || a.declared));
const excluded = apps.filter((a) => a.output !== SHELL_OUTPUT && !a.variant && !a.declared);

if (demos.length === 0) throw new Error("psp-svelte: no Svelte-capable demos found under apps/");

// Only manifests that need rewriting are touched; a demo already declaring
// Svelte (and pointing at a Svelte entry) is left exactly as it is.
const flip = demos.filter((a) => a.variant && (!a.declared || a.manifest.app.entry !== a.variant));
if (svelteShell && shell?.variant) flip.push(shell);

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

// Both the manifests and apps/launcher/psp/{icon0,pic1}.png are committed
// files this build rewrites in place — cargo-psp reads the XMB art from that
// fixed path — so every one of them is restored when the build ends.
const backups = new Map<string, Buffer>();
function restore(): void {
  for (const [path, original] of backups) writeFileSync(path, original);
  if (backups.size > 0) console.log(`psp-svelte: restored ${backups.size} file(s)`);
  backups.clear();
}
function backup(path: string): void {
  if (existsSync(path)) backups.set(path, readFileSync(path));
}
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    restore();
    process.exit(1);
  });
}

console.log(`psp-svelte: ${demos.length} Svelte demo(s): ${demos.map((a) => a.output).join(", ")}`);
console.log(`psp-svelte: shell ${SHELL_OUTPUT} (${svelteShell && shell?.variant ? "svelte" : "unchanged"})`);
console.log(`psp-svelte: excluding ${excluded.length} non-Svelte app(s)`);

try {
  for (const app of flip) {
    const path = manifestPath(app.name);
    backup(path);
    const next = JSON.parse(readFileSync(path, "utf8")) as Manifest;
    next.app.framework = "svelte";
    next.app.entry = app.variant!;
    writeFileSync(path, JSON.stringify(next, null, 2) + "\n");
    console.log(`  svelte: ${app.output} <- ${app.variant}`);
  }

  const env = { ...process.env };

  // XMB identity for this build: PIC1 is the 480x272 background, ICON0 the
  // 144x80 tile. tools/launcher.ts would otherwise generate a sim render of
  // the deck plus its stage gradient.
  const xmb = join(ROOT, "dist/launcher/psp/xmb-svelte");
  mkdirSync(xmb, { recursive: true });
  for (const asset of ["icon0.png", "pic1.png"]) {
    backup(join(APPS, "launcher/psp", asset));
  }
  writeFileSync(join(xmb, "pic1.png"), logoPlate(480, 272, 150));
  writeFileSync(join(xmb, "icon0.png"), logoPlate(144, 80, 56));
  env.POCKETJS_LAUNCHER_XMB = xmb;
  console.log(`psp-svelte: XMB art -> white + Svelte logo (${xmb})`);

  // The deck is title-sorted; lead with the game when it is present.
  const lead = ["svelte-snake-main"].filter((output) =>
    demos.some((app) => app.output === output)
  );
  if (lead.length > 0) {
    env.POCKETJS_LAUNCHER_FIRST = lead.join(",");
    console.log(`psp-svelte: deck order -> ${lead.join(", ")} first`);
  }

  const excludeArgs = excluded.flatMap((a) => ["--exclude", a.output]);
  await $`bun tools/launcher.ts build --target psp --force ${excludeArgs} -- ${profile}`
    .cwd(ROOT)
    .env(env);
} finally {
  restore();
}

const built = join(
  ROOT,
  `hosts/psp/target/mipsel-sony-psp/${profile.length > 0 ? "release" : "debug"}/EBOOT.PBP`,
);
if (!existsSync(built)) throw new Error(`psp-svelte: no EBOOT at ${built}`);
const bytes = Bun.file(built).size;
console.log(`\npsp-svelte: EBOOT.PBP ${(bytes / 1048576).toFixed(2)} MiB`);

// Staged memory-stick layout, matching tools/psp-all.ts's PSP/GAME/<folder>/.
const staged = join(ROOT, "dist/psp/PSP/GAME/PocketJS-svelte");
mkdirSync(staged, { recursive: true });
copyFileSync(built, join(staged, "EBOOT.PBP"));
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
    copyFileSync(built, join(target, "EBOOT.PBP"));
    console.log(`  install  ${target}/EBOOT.PBP`);
    console.log("\nOpen PPSSPP's \"Homebrew & Demos\" tab. Enter summons the picker.");
  }
}
