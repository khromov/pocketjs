import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = new URL("..", import.meta.url).pathname;

function packedFiles(cwd: string): string[] {
  const result = Bun.spawnSync({
    cmd: ["npm", "pack", "--dry-run", "--json"],
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(result.exitCode, result.stderr.toString()).toBe(0);
  // npm <= 11 reports an array of packs; npm >= 12 keys packs by package name.
  const parsed = JSON.parse(result.stdout.toString()) as unknown;
  const report = (
    Array.isArray(parsed) ? parsed[0] : Object.values(parsed as object)[0]
  ) as { files: Array<{ path: string }> } | undefined;
  expect(report?.files, result.stdout.toString().slice(0, 200)).toBeDefined();
  return report!.files.map((file) => file.path);
}

function packArchive(cwd: string, destination: string): string {
  const result = Bun.spawnSync({
    cmd: ["npm", "pack", "--json", "--pack-destination", destination],
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(result.exitCode, result.stderr.toString()).toBe(0);
  const parsed = JSON.parse(result.stdout.toString()) as unknown;
  const report = (
    Array.isArray(parsed) ? parsed[0] : Object.values(parsed as object)[0]
  ) as { filename: string } | undefined;
  expect(report?.filename).toBeDefined();
  return join(destination, report!.filename);
}

describe("published npm artifacts", () => {

  test("extracted framework resolves profiles and generic recipes without Cargo sources", async () => {
    const scratch = mkdtempSync(join(tmpdir(), "pocketjs-npm-consumer-"));
    try {
      const archive = packArchive(root, scratch);
      const extract = Bun.spawnSync(["tar", "-xf", archive, "-C", scratch], { stdout: "pipe", stderr: "pipe" });
      expect(extract.success, extract.stderr.toString()).toBe(true);
      const directory = join(scratch, "package");
      // bundleDependencies ships svelte under package/node_modules; the consumer
      // resolves the rest of its dependencies through the repo's node_modules.
      expect(existsSync(join(directory, "node_modules/svelte/package.json"))).toBe(true);
      rmSync(join(directory, "node_modules"), { recursive: true, force: true });
      symlinkSync(join(root, "node_modules"), join(directory, "node_modules"), "dir");
      writeFileSync(join(directory, "consumer.ts"), `
import { parsePocketProfile } from "@pocketjs/framework/profile";
import psp from "@pocketjs/framework/hosts/psp" with { type: "json" };
import { resolveRuntimeProgram } from "./tools/build/programs.ts";
import { sdkCommand } from "./tools/sdk.ts";
const external = parsePocketProfile({ ...psp, id: "external-product-with-a-long-id" });
if (external.id !== "external-product-with-a-long-id") throw Error("host contract not parsed");
const selected = await resolveRuntimeProgram({ from: ${JSON.stringify(scratch)}, target: "psp", generic: true });
if (!selected.config.value.build.genericRuntime.repack) throw Error("missing repack adapter");
if (await sdkCommand(["export", "--cargo", "--out", ${JSON.stringify(join(scratch, "program"))}])) throw Error("template failed");
console.log("npm consumer passed");
`);
      const consumer = Bun.spawnSync([process.execPath, "consumer.ts"], { cwd: directory, stdout: "pipe", stderr: "pipe" });
      expect(consumer.success, consumer.stderr.toString()).toBe(true);
      expect(consumer.stdout.toString()).toContain("npm consumer passed");
      const version = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;
      expect(readFileSync(join(scratch, "program/Cargo.toml"), "utf8")).toContain(`pocket-archive = { git = "https://github.com/pocket-nexus/pocketjs", tag = "v${version}", default-features = false, features = ["physics","software-renderer"] }`);
    } finally { rmSync(scratch, { recursive: true, force: true }); }
  }, 60_000);

  // Svelte's custom-renderer build is unreleased, so the tarball has to carry
  // it: the framework pins a vendored tarball and bundles it, and a consumer
  // never installs svelte themselves.
  test("bundles the vendored custom-renderer svelte build", async () => {
    const manifest = await Bun.file(`${root}package.json`).json();
    expect(manifest.bundleDependencies).toEqual(["svelte"]);
    expect(manifest.dependencies.svelte).toMatch(/^file:vendor\/svelte-.*\.tgz$/);

    const files = packedFiles(root);
    expect(files).toContain("node_modules/svelte/package.json");
    expect(files).toContain("node_modules/svelte/src/renderer/index.js");
    expect(files.some((file) => file.startsWith("framework/src/svelte/"))).toBe(true);
    // The vendored tarball itself stays git-only; the bundled copy is what ships.
    expect(files.some((file) => file.startsWith("vendor/"))).toBe(false);
  }, 30_000);

  // Bun resolves a bundled dependency's spec before honouring the bundle, so a
  // published `file:vendor/…` would break every consumer's install.
  test("the published manifest carries a resolvable svelte spec", () => {
    const result = Bun.spawnSync({
      cmd: ["bun", "tools/publish-manifest.ts", "node", "-p", "require('./package.json').dependencies.svelte"],
      cwd: root,
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(result.exitCode, result.stderr.toString()).toBe(0);
    expect(result.stdout.toString().trim()).not.toStartWith("file:");

    const after = JSON.parse(readFileSync(`${root}package.json`, "utf8")) as {
      dependencies: Record<string, string>;
    };
    expect(after.dependencies.svelte).toStartWith("file:vendor/");
  }, 30_000);
});
