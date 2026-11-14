// tools/manifest-rewrites.ts: the lock, journal and signal handling that keep
// a committed pocket.app.json's bytes across psp-svelte, 3ds-svelte and the
// Azahar E2E, which rewrite it in place for one build.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withManifestRewrites } from "../tools/manifest-rewrites.ts";

const HELPER = new URL("../tools/manifest-rewrites.ts", import.meta.url).pathname;
const ORIGINAL = '{ "app": { "entry": "apps/demo/main.tsx" } }\n';
const REWRITTEN = '{ "app": { "entry": "apps/demo/main.svelte.ts" } }\n';

let root: string;
let manifest: string;
const journal = () => join(root, ".pocket-build", "manifest-rewrites");
const entries = () => (existsSync(journal()) ? readdirSync(journal()) : []);

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "pocket-manifest-rewrites-"));
  mkdirSync(join(root, "apps/demo"), { recursive: true });
  manifest = join(root, "apps/demo/pocket.app.json");
  writeFileSync(manifest, ORIGINAL);
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

/** A child that rewrites the manifest, then kills itself with `signal`. */
function interruptedChild(signal: "SIGKILL" | "SIGHUP"): number | null {
  const script = `
    import { withManifestRewrites } from ${JSON.stringify(HELPER)};
    await withManifestRewrites("child", async (rewrites) => {
      rewrites.rewrite(${JSON.stringify(manifest)}, ${JSON.stringify(REWRITTEN)});
      process.kill(process.pid, ${JSON.stringify(signal)});
      await Bun.sleep(5000);
    }, { root: ${JSON.stringify(root)} });
  `;
  const child = Bun.spawnSync([process.execPath, "-e", script], { cwd: root, timeout: 20000 });
  return child.exitCode;
}

describe("manifest rewrites", () => {
  test("a rewrite lasts for the operation and is journaled until restored", async () => {
    await withManifestRewrites("test", async (rewrites) => {
      rewrites.rewrite(manifest, REWRITTEN);
      expect(readFileSync(manifest, "utf8")).toBe(REWRITTEN);
      expect(entries()).toEqual(["apps__demo__pocket.app.json.json"]);
      rewrites.rewrite(manifest, REWRITTEN + " ");
      rewrites.restore(manifest);
      expect(readFileSync(manifest, "utf8")).toBe(ORIGINAL);
      expect(entries()).toEqual([]);
      rewrites.rewrite(manifest, REWRITTEN);
    }, { root });
    expect(readFileSync(manifest, "utf8")).toBe(ORIGINAL);
    expect(entries()).toEqual([]);
  });

  test("a failing operation restores the original bytes", async () => {
    await expect(withManifestRewrites("test", async (rewrites) => {
      rewrites.rewrite(manifest, REWRITTEN);
      throw new Error("build failed");
    }, { root })).rejects.toThrow("build failed");
    expect(readFileSync(manifest, "utf8")).toBe(ORIGINAL);
  });

  test("SIGHUP restores the manifest before the process exits", () => {
    expect(interruptedChild("SIGHUP")).toBe(1);
    expect(readFileSync(manifest, "utf8")).toBe(ORIGINAL);
    expect(entries()).toEqual([]);
  });

  test("the next rewriting build restores what a killed build left rewritten", async () => {
    expect(interruptedChild("SIGKILL")).not.toBe(0);
    expect(readFileSync(manifest, "utf8")).toBe(REWRITTEN);
    // The dead build's lock is recovered and its journal replayed first, so
    // this build reads the committed bytes as the original.
    let seen = "";
    await withManifestRewrites("test", async () => {
      seen = readFileSync(manifest, "utf8");
    }, { root, timeoutMs: 10000 });
    expect(seen).toBe(ORIGINAL);
    expect(entries()).toEqual([]);
  });

  test("a file edited after an interrupted rewrite is left as it is", async () => {
    expect(interruptedChild("SIGKILL")).not.toBe(0);
    writeFileSync(manifest, '{ "edited": true }\n');
    await withManifestRewrites("test", async () => {}, { root, timeoutMs: 10000 });
    expect(readFileSync(manifest, "utf8")).toBe('{ "edited": true }\n');
    expect(entries()).toEqual([]);
  });

  test("rewriting builds in one checkout run one at a time", async () => {
    let active = 0;
    let most = 0;
    const originals: string[] = [];
    const build = () => withManifestRewrites("test", async (rewrites) => {
      active += 1;
      most = Math.max(most, active);
      originals.push(readFileSync(manifest, "utf8"));
      rewrites.rewrite(manifest, REWRITTEN);
      await Bun.sleep(30);
      active -= 1;
    }, { root });
    await Promise.all([build(), build(), build()]);
    expect(most).toBe(1);
    expect(originals).toEqual([ORIGINAL, ORIGINAL, ORIGINAL]);
    expect(readFileSync(manifest, "utf8")).toBe(ORIGINAL);
  });
});
