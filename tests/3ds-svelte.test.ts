// The manifest rewrite tools/3ds-svelte.ts performs before each 3DS build.
// The rewrite is the whole reason the script exists, and its failure mode is
// quiet: a manifest that does not resolve stops the build with a diagnostic,
// but one that resolves while still naming main.tsx produces a plausible
// .3dsx running Solid under a Svelte build.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  AUXILIARY_CAPABILITY,
  SHELL_OUTPUT,
  svelteCapableApps,
  threeDsSvelteManifest,
  type Manifest,
} from "../tools/3ds-svelte.ts";
import {
  THREE_DS_AUXILIARY_VIEWPORT,
  THREE_DS_VIEWPORT,
  resolve3dsBuildPlan,
} from "../tools/3ds-profile.ts";

const ROOT = join(import.meta.dir, "..");

function manifestFor(app: string): Manifest {
  return JSON.parse(readFileSync(join(ROOT, "apps", app, "pocket.json"), "utf8")) as Manifest;
}

describe("3DS Svelte build manifests", () => {
  const apps = svelteCapableApps();

  test("finds the Svelte demo corpus", () => {
    expect(apps.map((a) => a.name).sort()).toEqual([
      "cards",
      "chrome",
      "cursor",
      "hero",
      "launcher",
      "motions",
      "svelte-lab",
      "svelte-snake",
    ]);
    // Six carry a Svelte variant beside a Solid manifest; two declare Svelte.
    expect(apps.filter((a) => a.variant).map((a) => a.name)).toEqual([
      "cards",
      "chrome",
      "cursor",
      "hero",
      "launcher",
      "motions",
    ]);
    expect(apps.filter((a) => !a.variant && a.declared).map((a) => a.name)).toEqual([
      "svelte-lab",
      "svelte-snake",
    ]);
  });

  test("every demo the script builds admits 3ds-dev after the rewrite", () => {
    const demos = apps.filter((a) => a.output !== SHELL_OUTPUT);
    expect(demos.length).toBe(7);
    for (const app of demos) {
      const rewritten = threeDsSvelteManifest(manifestFor(app.name), app.variant);
      // Throws with the resolver's diagnostics when the manifest is rejected.
      expect(() => resolve3dsBuildPlan(rewritten)).not.toThrow();
    }
  });

  test("the committed manifests do not admit 3ds-dev on their own", () => {
    // The rewrite is load-bearing, not defensive: 480x272 integer-fit is not a
    // viewport this target publishes.
    for (const app of apps) {
      expect(() => resolve3dsBuildPlan(manifestFor(app.name))).toThrow(/480x272/);
    }
  });

  test("points a variant app at its Svelte entry and declares the framework", () => {
    const rewritten = threeDsSvelteManifest(manifestFor("hero"), "apps/hero/main.svelte.ts");
    expect(rewritten.app.framework).toBe("svelte");
    expect(rewritten.app.entry).toBe("apps/hero/main.svelte.ts");
  });

  test("leaves framework and entry alone for a manifest that already declares Svelte", () => {
    const original = manifestFor("svelte-snake");
    const rewritten = threeDsSvelteManifest(original, undefined);
    expect(rewritten.app.framework).toBe("svelte");
    expect(rewritten.app.entry).toBe(original.app.entry);
  });

  test("re-declares the display for the 3ds-dev profile", () => {
    const plan = resolve3dsBuildPlan(
      threeDsSvelteManifest(manifestFor("hero"), "apps/hero/main.svelte.ts"),
    ) as unknown as {
      viewport: { logical: readonly number[] };
      surfaces: { auxiliary: { logical: readonly number[] } };
    };
    expect(plan.viewport.logical).toEqual([...THREE_DS_VIEWPORT]);
    // hosts/3ds/src/main.c takes the auxiliary size as a mandatory -D, so a
    // plan without surfaces reaches the C compiler as an empty define.
    expect(plan.surfaces.auxiliary.logical).toEqual([...THREE_DS_AUXILIARY_VIEWPORT]);
  });

  test("declares display.auxiliary exactly once alongside the surface", () => {
    const rewritten = threeDsSvelteManifest(manifestFor("cursor"), "apps/cursor/main.svelte.ts");
    const requires = rewritten.engine?.capabilities?.requires ?? [];
    expect(requires.filter((c) => c === AUXILIARY_CAPABILITY)).toEqual([AUXILIARY_CAPABILITY]);
    // The app's own requirements survive the rewrite.
    expect(requires).toContain("text.glyphs.baked");
    expect(requires).toContain("input.buttons");
  });

  test("does not mutate the manifest it is given", () => {
    const original = manifestFor("hero");
    const before = JSON.stringify(original);
    threeDsSvelteManifest(original, "apps/hero/main.svelte.ts");
    expect(JSON.stringify(original)).toBe(before);
  });
});
