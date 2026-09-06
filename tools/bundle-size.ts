#!/usr/bin/env bun
// tools/bundle-size.ts — measure the built artifact for the same demo across
// frameworks and write REPORT.md.
//
//   bun tools/bundle-size.ts [--outdir=<scratch>] [--report=<path>] [--json=<path>]
//
// Builds run SERIALLY and with cwd = repo root. Both matter:
//   * tools/build.ts rewrites framework/src/styles.generated.ts on every build
//     (tools/build.ts:317-322), so two concurrent builds race.
//   * Bun.build gets `root: process.cwd()` (tools/build.ts:531), and the module
//     markers this tool attributes bytes from are emitted relative to that root.
//
// Every build passes --framework explicitly: tools/build.ts:187-191 reads the
// framework from pocket.config.ts (default "solid"), NOT from apps/<app>/pocket.json.
// An omitted flag silently produces a Solid build under a Svelte-looking name,
// which is why dist/ cannot be used as evidence and why assertRuntime() exists.

import { existsSync, mkdirSync, rmSync, statSync } from "node:fs";
import { join, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolvePath(fileURLToPath(new URL("..", import.meta.url)));

type Framework = "solid" | "vue-vapor" | "octane" | "svelte";

const SUFFIX: Record<Framework, string> = {
  solid: "",
  "vue-vapor": ".vue-vapor",
  octane: ".octane",
  svelte: ".svelte",
};
const LABEL: Record<Framework, string> = {
  solid: "Solid",
  "vue-vapor": "Vue Vapor",
  octane: "Octane",
  svelte: "Svelte",
};

/**
 * The npm package each framework's runtime must come from, and a floor its
 * attributed bytes must clear.
 *
 * The floor is the point. `frameworkVariantPath` falls back to the Solid source
 * when a variant file is missing (framework/compiler/jsx-plugin.ts:439) without
 * warning, so a mis-targeted build emits a plausible-looking `<app>.octane.js`
 * built from Solid sources. A presence check alone would not catch it either:
 * `solid-js/dist/solid.js` appears in the Vue Vapor and Octane bundles too,
 * contributing four `Symbol()` declarations — about 200 bytes against ~34 KiB in
 * a real Solid build.
 */
const RUNTIME_FLOOR: Record<Framework, { pkg: string; bytes: number }> = {
  solid: { pkg: "solid-js", bytes: 20_000 },
  "vue-vapor": { pkg: "vue", bytes: 100_000 },
  octane: { pkg: "octane", bytes: 100_000 },
  svelte: { pkg: "svelte", bytes: 50_000 },
};

/** One build per (entry, framework). `entry` is what tools/build.ts resolves. */
const SWEEP: { demo: string; entry: string; frameworks: Framework[] }[] = [
  { demo: "cards", entry: "cards-main", frameworks: ["solid", "vue-vapor", "octane", "svelte"] },
  { demo: "hero", entry: "hero-main", frameworks: ["solid", "vue-vapor", "octane", "svelte"] },
  { demo: "chrome", entry: "chrome-main", frameworks: ["solid", "svelte"] },
  { demo: "cursor", entry: "cursor-main", frameworks: ["solid", "svelte"] },
  { demo: "launcher", entry: "launcher-main", frameworks: ["solid", "svelte"] },
  { demo: "motions", entry: "motions-main", frameworks: ["solid", "svelte"] },
  { demo: "vue-sfc-lab", entry: "vue-sfc-lab-main", frameworks: ["vue-vapor"] },
  { demo: "svelte-lab", entry: "svelte-lab-main", frameworks: ["svelte"] },
];

type Bucket = "runtime" | "pocketjs" | "styles" | "app" | "logo" | "wrapper" | "other";

const RUNTIME_PKG = /^node_modules\/(@[^/]+\/[^/]+|[^/]+)\//;
const RUNTIME_PKGS = new Set(["svelte", "solid-js", "vue", "@vue", "octane", "clsx", "esm-env", "vue-jsx-vapor"]);

function bucketOf(path: string): Bucket {
  const p = path.replace(/\\/g, "/");
  const pkg = RUNTIME_PKG.exec(p);
  if (pkg) return RUNTIME_PKGS.has(pkg[1]) ? "runtime" : "other";
  // Virtual namespaces the framework plugins synthesise (e.g. vue-vapor-helper:).
  if (/^[a-z-]+-helper:/.test(p)) return "runtime";
  if (p === "framework/src/styles.generated.ts") return "styles";
  if (p.startsWith("framework/") || p.startsWith("contracts/")) return "pocketjs";
  if (p === "apps/shared/SvelteLogoScreen.svelte") return "logo";
  if (p.startsWith("apps/")) return "app";
  return "other";
}

interface Attribution {
  raw: Record<Bucket, number>;
  norm: Record<Bucket, number>;
  /** bytes per top-level node_modules package, for the mis-framework guard. */
  packages: Record<string, number>;
  /** buckets whose slice could not be re-parsed; norm falls back to raw. */
  fellBack: Bucket[];
  unclassified: string[];
}

const EMPTY = (): Record<Bucket, number> =>
  ({ runtime: 0, pocketjs: 0, styles: 0, app: 0, logo: 0, wrapper: 0, other: 0 });

const NEWLINE = 0x0a;

/**
 * Split the unminified bundle at its `  // <path>` module markers and total the
 * bytes per bucket.
 *
 * Arithmetic is over Buffer offsets, not string indices: the bundles carry
 * multi-byte content (Svelte's whitespace table alone contributes `﻿`), so a
 * bundle can be 32 bytes longer than it is characters long, and a `String.length`
 * count would silently undercount. The sum reconciles to the file size exactly; a
 * mismatch means the marker format changed and every derived number would be
 * wrong, so it throws.
 */
function attribute(buf: Buffer): Attribution {
  const lines: [number, number][] = [];
  let start = 0;
  for (let i = 0; i < buf.length; i += 1) {
    if (buf[i] === NEWLINE) { lines.push([start, i + 1]); start = i + 1; }
  }
  if (start < buf.length) lines.push([start, buf.length]);

  const raw = EMPTY();
  const packages: Record<string, number> = {};
  const slices: Record<Bucket, Buffer[]> = {
    runtime: [], pocketjs: [], styles: [], app: [], logo: [], wrapper: [], other: [],
  };
  const unclassified = new Set<string>();

  // Bun wraps the bundle in `(() => { ... })();`. Those two lines belong to no
  // module and, left inside a bucket, make that bucket's slice unbalanced — which
  // is exactly what stops it being re-parsed for the normalised figure.
  const OPEN = /^\(\(\) => \{$/;
  const CLOSE = /^\}\)\(\);?$/;
  const last = lines.length - 1;

  let bucket: Bucket = "other";
  let pkg = "";
  let seenMarker = false;
  for (let i = 0; i < lines.length; i += 1) {
    const [s, e] = lines[i];
    const end = buf[e - 1] === NEWLINE ? e - 1 : e;
    const text = buf.toString("utf8", s, end);
    let target: Bucket;
    if ((i === 0 && OPEN.test(text)) || (i === last && CLOSE.test(text))) {
      target = "wrapper";
    } else {
      const marker = /^ {2}\/\/ (\S+)$/.exec(text);
      if (marker) {
        bucket = bucketOf(marker[1]);
        const m = RUNTIME_PKG.exec(marker[1].replace(/\\/g, "/"));
        pkg = m ? m[1] : "";
        if (bucket === "other") unclassified.add(marker[1]);
        seenMarker = true;
      } else if (!seenMarker) {
        bucket = "other"; // anything before the first module marker
        pkg = "";
      }
      target = bucket;
    }
    raw[target] += e - s;
    if (pkg && target === "runtime") packages[pkg] = (packages[pkg] ?? 0) + (e - s);
    slices[target].push(buf.subarray(s, e));
  }

  const total = (Object.values(raw) as number[]).reduce((a, b) => a + b, 0);
  if (total !== buf.length) {
    throw new Error(
      `bundle-size: attribution does not reconcile (${total} attributed vs ${buf.length} bytes). ` +
        "Bun's module marker format has changed; fix bucketOf/attribute before trusting any number.",
    );
  }

  const transpiler = new Bun.Transpiler({ loader: "js", minifyWhitespace: true });
  const norm = EMPTY();
  const fellBack: Bucket[] = [];
  for (const key of Object.keys(slices) as Bucket[]) {
    if (slices[key].length === 0) continue;
    if (key === "wrapper") { norm[key] = raw[key]; continue; }
    try {
      norm[key] = Buffer.byteLength(transpiler.transformSync(Buffer.concat(slices[key]).toString("utf8")));
    } catch {
      norm[key] = raw[key];
      fellBack.push(key);
    }
  }
  return { raw, norm, packages, fellBack, unclassified: [...unclassified].sort() };
}

/** Packages every bundle carries regardless of framework. */
const SHARED_PKGS = new Set(["clsx", "esm-env"]);

/**
 * Bytes from a framework runtime the build did not ask for.
 *
 * A variant entry that pins a framework-specific subpath (\`@pocketjs/framework/solid\`
 * rather than the neutral \`@pocketjs/framework\`) cannot be retargeted by
 * \`packagePath\`, so the other framework's renderer links in alongside the intended
 * one. That inflates the affected row, and it is invisible without this check.
 */
function foreignRuntime(framework: Framework, a: Attribution): Record<string, number> {
  const own = RUNTIME_FLOOR[framework].pkg;
  return Object.fromEntries(
    Object.entries(a.packages).filter(([k, v]) => k !== own && !SHARED_PKGS.has(k) && v > 1024),
  );
}

/** Refuse a bundle whose runtime is not the one the build was asked for. */
function assertRuntime(demo: string, framework: Framework, a: Attribution): void {
  const { pkg, bytes } = RUNTIME_FLOOR[framework];
  const got = a.packages[pkg] ?? 0;
  if (got < bytes) {
    throw new Error(
      `${demo} (${framework}): only ${got} bytes attributed to \`${pkg}\`, below the ${bytes}-byte floor. ` +
        "The build most likely fell back to the Solid sources because no variant file exists.",
    );
  }
}

interface BuildStats {
  pakEntries: number;
  styleRecords: number;
  fontSlots: number;
}

interface Measurement {
  demo: string;
  framework: Framework;
  jsRaw: number;
  jsMin: number;
  jsGzip: number;
  pak: number;
  stats: BuildStats;
  attribution: Attribution;
  foreign: Record<string, number>;
}

async function build(entry: string, framework: Framework, outdir: string): Promise<BuildStats> {
  const proc = Bun.spawn(
    ["bun", "tools/build.ts", entry, `--framework=${framework}`, `--outdir=${outdir}`],
    { cwd: ROOT, stdout: "pipe", stderr: "pipe" },
  );
  const [code, err, out] = await Promise.all([
    proc.exited,
    new Response(proc.stderr).text(),
    new Response(proc.stdout).text(),
  ]);
  if (code !== 0) throw new Error(`build failed for ${entry} (${framework}):\n${err || out}`);
  // The pak turns out to differ between frameworks for explainable reasons, so
  // record what the build says about it rather than leaving the reader to guess.
  return {
    pakEntries: Number(/pak: (\d+) entries/.exec(out)?.[1] ?? 0),
    styleRecords: Number(/tailwind: (\d+) style record/.exec(out)?.[1] ?? 0),
    fontSlots: (out.match(/^ *font: slot /gm) ?? []).length,
  };
}

async function measure(
  demo: string, entry: string, framework: Framework, outdir: string, stats: BuildStats,
): Promise<Measurement> {
  const base = join(outdir, entry + SUFFIX[framework]);
  const jsPath = base + ".js";
  const pakPath = base + ".pak";
  if (!existsSync(jsPath)) throw new Error(`expected ${jsPath} after building ${demo} (${framework})`);

  const buf = Buffer.from(await Bun.file(jsPath).arrayBuffer());
  const attribution = attribute(buf);
  assertRuntime(demo, framework, attribution);

  const minified = await Bun.build({
    entrypoints: [jsPath],
    minify: true,
    target: "browser",
    format: "iife",
    sourcemap: "none",
  });
  if (!minified.success) throw new Error(`could not minify ${jsPath}`);
  const minText = await minified.outputs[0].text();

  return {
    demo,
    framework,
    jsRaw: buf.length,
    jsMin: Buffer.byteLength(minText),
    jsGzip: Bun.gzipSync(Buffer.from(minText), { level: 9 }).length,
    pak: existsSync(pakPath) ? statSync(pakPath).size : 0,
    stats,
    attribution,
    foreign: foreignRuntime(framework, attribution),
  };
}

// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
let scratch = join(ROOT, ".cache/bundle-size");
let reportPath = join(ROOT, "REPORT.md");
let jsonPath = "";
for (const a of args) {
  if (a.startsWith("--outdir=")) scratch = resolvePath(a.slice("--outdir=".length));
  else if (a.startsWith("--report=")) reportPath = resolvePath(a.slice("--report=".length));
  else if (a.startsWith("--json=")) jsonPath = resolvePath(a.slice("--json=".length));
}

rmSync(scratch, { recursive: true, force: true });
mkdirSync(scratch, { recursive: true });

const results: Measurement[] = [];
const failures: { demo: string; framework: Framework; error: string }[] = [];
const jobs = SWEEP.flatMap((s) => s.frameworks.map((f) => ({ ...s, framework: f })));

let n = 0;
for (const job of jobs) {
  n += 1;
  process.stdout.write(`[${n}/${jobs.length}] ${job.demo} (${job.framework}) ... `);
  const outdir = join(scratch, job.framework);
  mkdirSync(outdir, { recursive: true });
  try {
    const stats = await build(job.entry, job.framework, outdir);
    const m = await measure(job.demo, job.entry, job.framework, outdir, stats);
    results.push(m);
    console.log(`${kb(m.jsRaw)} raw, ${kb(m.jsMin)} min, ${kb(m.jsGzip)} gzip`);
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    failures.push({ demo: job.demo, framework: job.framework, error });
    console.log(`FAILED — ${error.split("\n")[0]}`);
  }
}

await Bun.write(reportPath, renderReport(results, failures));
console.log(`\nwrote ${reportPath}`);
if (jsonPath) {
  await Bun.write(jsonPath, JSON.stringify({ generated: new Date().toISOString(), results, failures }, null, 2) + "\n");
  console.log(`wrote ${jsonPath}`);
}
if (failures.length > 0) console.error(`\n${failures.length} build(s) failed; the report records them as gaps.`);

// ---------------------------------------------------------------------------
// rendering
// ---------------------------------------------------------------------------

function kb(bytes: number): string {
  return (bytes / 1024).toFixed(1) + " KiB";
}

function ratio(svelte: number, other: number): string {
  return other === 0 ? "—" : (svelte / other).toFixed(2) + "x";
}

function geomean(values: number[]): number {
  return Math.exp(values.reduce((a, b) => a + Math.log(b), 0) / values.length);
}

function word(r: number): string {
  return r > 1.05 ? "larger" : r < 0.95 ? "smaller" : "about the same";
}

function find(results: Measurement[], demo: string, framework: Framework): Measurement | undefined {
  return results.find((r) => r.demo === demo && r.framework === framework);
}

interface Row { label: string; left?: Measurement; right?: Measurement }
type FullRow = { label: string; left: Measurement; right: Measurement };

function usable(rows: Row[]): FullRow[] {
  return rows.filter((r) => r.left && r.right) as FullRow[];
}

function comparisonTable(rows: Row[], leftLabel: string): string {
  const head =
    `| Demo | ${leftLabel} raw | Svelte raw | ÷ raw | ${leftLabel} min | Svelte min | ${leftLabel} gzip | Svelte gzip | ÷ gzip |\n` +
    "| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |\n";
  const body = rows.map((r) => {
    if (!r.left || !r.right) {
      return `| \`${r.label}\` | — | — | — | — | — | — | — | ${!r.left ? leftLabel : "Svelte"} build failed |`;
    }
    return `| \`${r.label}\` | ${kb(r.left.jsRaw)} | ${kb(r.right.jsRaw)} | **${ratio(r.right.jsRaw, r.left.jsRaw)}** | ` +
      `${kb(r.left.jsMin)} | ${kb(r.right.jsMin)} | ${kb(r.left.jsGzip)} | ${kb(r.right.jsGzip)} | ` +
      `**${ratio(r.right.jsGzip, r.left.jsGzip)}** |`;
  }).join("\n");
  return head + body + "\n";
}

function summarise(rows: Row[], leftLabel: string): string {
  const ok = usable(rows);
  if (ok.length === 0) return `No demo built for both Svelte and ${leftLabel}.\n`;
  const rawG = geomean(ok.map((r) => r.right.jsRaw / r.left.jsRaw));
  const gzG = geomean(ok.map((r) => r.right.jsGzip / r.left.jsGzip));
  const agree = word(rawG) === word(gzG);
  const lead = `Over ${ok.length} demo${ok.length === 1 ? "" : "s"}, Svelte is **${rawG.toFixed(2)}x** ${leftLabel} as shipped ` +
    `and **${gzG.toFixed(2)}x** gzipped`;
  return agree
    ? `${lead} — **${word(gzG)} than ${leftLabel}** on both.\n`
    : `${lead}. The two disagree: as shipped Svelte is ${word(rawG)}, gzipped it is ${word(gzG)}. ` +
      `${leftLabel} vendors a pre-minified runtime and Svelte vendors raw source, so the raw ratio is comparing packaging; ` +
      `the gzip ratio is the one that reflects the runtimes.\n`;
}

function breakdownTable(results: Measurement[], demo: string): string {
  const order: Framework[] = ["solid", "vue-vapor", "octane", "svelte"];
  const head =
    "| Framework | Framework runtime | PocketJS framework | Baked styles | App components | Shared logo screen | Total |\n" +
    "| --- | ---: | ---: | ---: | ---: | ---: | ---: |\n";
  const body = order.flatMap((f) => {
    const m = find(results, demo, f);
    if (!m) return [];
    const a = m.attribution.norm;
    const total = (Object.values(a) as number[]).reduce((x, y) => x + y, 0);
    return [`| ${LABEL[f]} | **${kb(a.runtime)}** | ${kb(a.pocketjs)} | ${kb(a.styles)} | ${kb(a.app)} | ` +
      `${a.logo === 0 ? "—" : kb(a.logo)} | ${kb(total)} |`];
  }).join("\n");
  return head + body + "\n";
}

function runtimeTable(results: Measurement[]): string {
  const order: Framework[] = ["solid", "vue-vapor", "octane", "svelte"];
  const svelte = find(results, "cards", "svelte")?.attribution.norm.runtime ?? 0;
  const head = "| Framework | npm package | Runtime, normalised | Relative to Svelte |\n| --- | --- | ---: | ---: |\n";
  const body = order.flatMap((f) => {
    const m = find(results, "cards", f);
    if (!m) return [];
    const pkgs = Object.entries(m.attribution.packages).sort((a, b) => b[1] - a[1]);
    const named = pkgs.filter(([, v]) => v > 1024).map(([k]) => `\`${k}\``).join(", ");
    const bytes = m.attribution.norm.runtime;
    return [`| ${LABEL[f]} | ${named} | ${kb(bytes)} | ${svelte === 0 ? "—" : (bytes / svelte).toFixed(2) + "x"} |`];
  }).join("\n");
  return head + body + "\n";
}

function runtimeSentence(results: Measurement[]): string {
  const rt = (f: Framework) => find(results, "cards", f)?.attribution.norm.runtime ?? 0;
  const sv = rt("svelte");
  const say = (f: Framework) => {
    const other = rt(f);
    if (!other || !sv) return `${LABEL[f]} — not measured`;
    const r = sv / other;
    if (r >= 1.5 || r <= 0.67) return `**${r.toFixed(1)}x ${LABEL[f]}'s**`;
    const pctDiff = Math.abs(100 * (r - 1));
    if (pctDiff < 2) return `**level with ${LABEL[f]}'s**`;
    return `**${pctDiff.toFixed(0)}% ${r > 1 ? "larger than" : "smaller than"} ${LABEL[f]}'s**`;
  };
  return `Normalised against each other on \`cards\`, Svelte's runtime is ${say("solid")}, ` +
    `${say("vue-vapor")} and ${say("octane")}. Against Solid that runtime is most of the whole\n` +
    `artifact, which is why the Svelte builds land near 2x.`;
}

function pakTable(results: Measurement[]): string {
  const order: Framework[] = ["solid", "vue-vapor", "octane", "svelte"];
  const demos = [...new Set(results.map((r) => r.demo))];
  const head = `| Demo | ${order.map((f) => LABEL[f]).join(" | ")} |\n| --- | ${order.map(() => "---:").join(" | ")} |\n`;
  const body = demos.map((d) => {
    const cells = order.map((f) => {
      const m = find(results, d, f);
      return m ? `${kb(m.pak)}<br><sub>${m.stats.pakEntries} entries · ${m.stats.fontSlots} fonts · ${m.stats.styleRecords} styles</sub>` : "—";
    });
    return `| \`${d}\` | ${cells.join(" | ")} |`;
  }).join("\n");
  return head + body + "\n";
}

function renderReport(results: Measurement[], failures: { demo: string; framework: Framework; error: string }[]): string {
  const git = (a: string[]): string => Bun.spawnSync(["git", ...a], { cwd: ROOT }).stdout.toString().trim();
  const rev = git(["rev-parse", "--short", "HEAD"]);
  // Untracked files are ignored: REPORT.md itself is untracked the first time this
  // runs, and flagging that would make the warning meaningless.
  const dirty = git(["status", "--porcelain", "--untracked-files=no"]).length > 0;

  const octaneRows: Row[] = ["cards", "hero"].map((d) => ({ label: d, left: find(results, d, "octane"), right: find(results, d, "svelte") }));
  const vueRows: Row[] = [
    { label: "cards", left: find(results, "cards", "vue-vapor"), right: find(results, "cards", "svelte") },
    { label: "hero", left: find(results, "hero", "vue-vapor"), right: find(results, "hero", "svelte") },
    { label: "lab (vue-sfc-lab ↔ svelte-lab)", left: find(results, "vue-sfc-lab", "vue-vapor"), right: find(results, "svelte-lab", "svelte") },
  ];
  const solidRows: Row[] = ["cards", "chrome", "cursor", "hero", "launcher", "motions"]
    .map((d) => ({ label: d, left: find(results, d, "solid"), right: find(results, d, "svelte") }));

  const contaminated = results.filter((r) => Object.keys(r.foreign).length > 0);
  const unclassified = [...new Set(results.flatMap((r) => r.attribution.unclassified))];
  const fellBack = results.filter((r) => r.attribution.fellBack.length > 0);

  return `# Bundle size: Svelte against Octane, Vue Vapor and Solid

Generated by \`bun tools/bundle-size.ts\` at ${new Date().toISOString()} from git \`${rev}\`${dirty ? " **with a dirty working tree** — these numbers are not reproducible from the committed tree alone" : ""}.

Each row is **the same demo built twice**, once per framework, from the variant
sources that sit side by side in one app directory (\`app.tsx\`, \`app.vue-vapor.tsx\`,
\`app.octane.tsx\`, \`app.svelte\`). Every number covers the whole JavaScript artifact:
app components, the PocketJS framework, the baked Tailwind style table and **the
framework runtime**, which \`tools/build.ts\` inlines into one IIFE with no externals.

## Answer

${summarise(solidRows, "Solid")}
${summarise(vueRows, "Vue Vapor")}
${summarise(octaneRows, "Octane")}
${runtimeSentence(results)}

## There is no React in this repository

PocketJS supports four frameworks: Solid, Vue Vapor, **Octane** and Svelte. No
\`react\`, \`preact\` or \`inferno\` package is installed and no source file imports one.
Octane (\`octane@0.1.26\`, by the author of Inferno) is the React-shaped member of the
set — \`useState\`, \`useRef\`, \`useLayoutEffect\`, components as plain functions — so it
is what a React comparison maps onto here. The numbers below are Octane's, not React's.

## How this was measured

\`\`\`sh
bun tools/build.ts <demo>-main --framework=<solid|vue-vapor|octane|svelte> --outdir=<scratch>
\`\`\`

Builds run serially into a scratch directory, never \`dist/\`. \`tools/build.ts\`
rewrites \`framework/src/styles.generated.ts\` on every build, so concurrent builds
race; and \`dist/\` on this branch holds artifacts whose names do not match their
contents, because plan-driven builds drop the framework suffix and an omitted
\`--framework\` falls back to Solid. Each bundle is checked after the fact for the
runtime it was supposed to contain, above a byte floor, so a build that fell back to
the Solid sources without erroring is rejected instead of published.

Three sizes per bundle:

| Column | Meaning |
| --- | --- |
| raw | bytes as built. \`Bun.build\` runs with \`minify: false\` (\`tools/build.ts:555\`), nothing downstream minifies or compresses, and the PSP host reads the \`.js\` into the binary (\`hosts/psp/build.rs:98\`) and hands those bytes to \`JS_Eval\` (\`hosts/psp/src/main.rs:570\`) — **this is what ships**, and it is the same \`bundle_bytes\` the device reports in \`docs/bench/\` |
| min | the built IIFE put back through \`Bun.build({ minify: true })\`. No PocketJS target does this today |
| gzip | gzip -9 of the minified bytes. No PocketJS target transfers the bundle compressed either |

**Raw and gzip do not always agree, and neither column alone is the answer.** The
four runtimes are vendored in different states, so raw bytes compare packaging as
much as they compare runtimes:

| Runtime | Vendored as | State on disk |
| --- | --- | --- |
| Vue Vapor | \`vue/dist/vue.runtime-with-vapor.esm-browser.prod.js\` | 218,493 bytes across **11 lines** — already minified |
| Solid | \`solid-js/dist/solid.js\` | prebuilt, **0 bytes of comments** |
| Octane | \`octane/dist/**\` | prebuilt, not minified |
| Svelte | \`svelte/src/internal/client/**\` | **raw source with JSDoc**, nothing stripped |

Raw is the operational number, because raw is what the device parses. Gzip is the
comparable number, because it neutralises how each package happens to be published.
Where the two disagree the report says so rather than picking a winner.

## Octane vs Svelte

Octane is this repository's React-shaped framework, not React.

${comparisonTable(octaneRows, "Octane")}
${summarise(octaneRows, "Octane")}
## Vue Vapor vs Svelte

${comparisonTable(vueRows, "Vue Vapor")}
${summarise(vueRows, "Vue Vapor")}
The \`lab\` row pairs two separate app directories rather than two variants of one
app, and they are not feature-identical by design: \`svelte-lab\` exercises runes,
\`{#each}\` and snippets, \`vue-sfc-lab\` exercises \`defineModel\`, \`v-for\` and slots.
Read that row as directional.

## Solid vs Svelte

${comparisonTable(solidRows, "Solid")}
${summarise(solidRows, "Solid")}
## Where the bytes go

Bytes are attributed to source modules from the \`  // <path>\` markers Bun emits in
unminified output, over Buffer offsets rather than string indices — the bundles
carry multi-byte content and a character count undercounts them by 20 to 30 bytes.
The per-bundle sum reconciles to the file size exactly or the tool refuses to write
a report.

Figures below are **normalised**: comments and whitespace stripped with
\`Bun.Transpiler({ minifyWhitespace: true })\`, which does not rename or tree-shake.
That puts the four runtimes on equal terms despite arriving in different states.

\`cards\` is the anchor — one of the two demos ported to all four frameworks, and
unlike \`hero\` its Solid variant is not inflated by doubling as a typecheck fixture.

${breakdownTable(results, "cards")}
Svelte's figure is **after** the build drops three browser-DOM-only modules that
its client barrel re-exports eagerly. \`svelte/internal/client/index.js\` is a flat
barrel, and \`dom/elements/custom-element.js\` assigns at module scope inside
\`if (typeof HTMLElement === 'function')\` — a bundler cannot prove that inert, so the
module was pinned and dragged \`legacy/legacy-client.js\` in behind it. Aliasing
\`custom-element.js\` and the two DOM binding modules to stubs
(\`framework/src/svelte-dom-stubs.ts\`) removes 11,358 bytes raw, 7.3 KiB of the
normalised runtime, and the last \`typeof HTMLElement\` probe in the artifact. The
stubs themselves shake out to nothing, because no call site survives.

The upstream fix belongs in sveltejs/svelte#18511, the custom-renderer PR this build
is vendored from: the barrel wants a \`custom-renderer\` variant that omits these.

The framework runtime alone, from the same builds:

${runtimeTable(results)}
Normalised, Svelte's runtime is 5% larger than Vue Vapor's. They separate under the
minifier — Svelte's drops much further — because Vue's vendored build is already
minified and has nothing left to rename, while Svelte's is source that both renames
and tree-shakes down. That is the whole of the raw-versus-gzip disagreement above.

## The \`.pak\` sidecar

Each build also emits a \`.pak\` holding baked font atlases, images and style records.
It is kept out of every ratio above, because it is driven by the class literals and
glyphs a variant references rather than by the framework — but it is **not constant
across frameworks**, and the differences are worth naming:

${pakTable(results)}
Two things move it, neither a property of the framework:

- **\`apps/shared/SvelteLogoScreen.svelte\`.** The Svelte \`cards\` pak carries 18 entries
  against Solid's 5, an extra 18px-bold font atlas (42,190 bytes) and 4 extra style
  records. All of it comes from the logo screen and its spinner frames, which only
  the Svelte variants mount.
- **The \`hero\` typecheck fixture.** \`apps/hero/app.tsx\` references more classes and
  glyphs than the other three hero variants, which is why the Solid hero pak is the
  largest number in the table.

\`launcher\` is the control that proves the point: it is the one Solid-to-Svelte port
whose Svelte variant does **not** mount the logo screen, and its two paks are
byte-identical at 4,196,816 bytes across 54 entries. Same content, same pak, whatever
the framework.

## Caveats

- **Octane is not React**, and this repository contains no React. See above.
- **Most Svelte demos carry a screen the others do not.** \`cards\`, \`chrome\`,
  \`cursor\`, \`hero\`, \`motions\` and \`svelte-lab\` mount
  \`apps/shared/SvelteLogoScreen.svelte\`; no Solid, Vue Vapor or Octane variant does,
  and the Svelte \`launcher\` does not either. Its JS bytes are their own column above
  at around 2 KiB — under 2% of the gap to Solid — so it does not move the JS ratios.
  In the \`.pak\` it is the dominant term.
- **\`apps/hero/app.tsx\` is not a like-for-like port.** The Solid hero doubles as the
  \`jsx.d.ts\` typecheck fixture: 189 lines against 85 to 104 for the other three
  variants. Its app-component and pak numbers are inflated for a reason that has
  nothing to do with Solid. \`cards\` (135/114/120/139 lines) is the balanced demo.
- **\`solid-js\` appears in every bundle.** In the Vue Vapor and Octane builds it
  contributes four \`Symbol()\` declarations, 203 bytes against ~32 KiB in a real Solid
  build. That is a shared symbol table, not a second reactive system riding along —
  except where the next caveat applies.
${contaminated.length > 0 ? contaminated.map((r) => `- **\`${r.demo}\` under ${LABEL[r.framework]} links a second runtime.** ` +
  `${Object.entries(r.foreign).map(([k, v]) => `\`${k}\` contributes ${v.toLocaleString()} bytes`).join(", ")}. ` +
  `\`apps/${r.demo}/main.tsx\` imports from \`@pocketjs/framework/solid\` — a framework-pinned ` +
  `subpath the build cannot retarget — and there is no \`main.${r.framework}.tsx\` beside it, so the Solid ` +
  `renderer links in next to ${LABEL[r.framework]}'s. That row overstates ${LABEL[r.framework]} by roughly ` +
  `${Math.round((Object.values(r.foreign).reduce((a, b) => a + b, 0) - 203) / 1024)} KiB raw and it is a fault in the ` +
  `entry file, not in ${LABEL[r.framework]}. \`cards\`, whose entry imports the neutral \`@pocketjs/framework\`, ` +
  `is the clean four-way row.`).join("\n") : ""}
- **Bundle size is one axis.** It says nothing about frame time or node count. For
  runtime cost see \`docs/bench/three-frameworks-ppsspp-2026-07-30.md\`.
- **Build parameters:** no \`--plan\`, so raster density 1 and 60 Hz. \`apps/motions\`
  supplies its own \`pocket.config.ts\`, which wins over the root config for both of
  its variants equally.
${failures.length > 0 ? `- **${failures.length} build(s) failed** and are recorded as gaps in the tables:\n` + failures.map((f) => `  \`${f.demo}\` (${f.framework}): ${f.error.split("\n")[0]}`).join("\n") + "\n" : ""}${unclassified.length > 0 ? `- **Unclassified modules** landed in no bucket: ${unclassified.map((u) => "`" + u + "`").join(", ")}.\n` : ""}${fellBack.length > 0 ? `- **Normalisation fell back to raw bytes** for: ${fellBack.map((r) => `${r.demo}/${r.framework} (${r.attribution.fellBack.join(", ")})`).join("; ")}.\n` : ""}`;
}
