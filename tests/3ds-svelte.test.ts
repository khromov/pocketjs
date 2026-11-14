// The manifest rewrite tools/3ds-svelte.ts performs before each 3DS build,
// and the presentation rate products/3ds/build.ts reads beside it.
// The rewrite is the whole reason the script exists, and its failure mode is
// quiet: a manifest that does not resolve stops the build with a diagnostic,
// but one that resolves while still naming main.tsx produces a plausible
// .3dsx running Solid under a Svelte build.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pocketManifestV2Schema } from "../contracts/spec/pocket-manifest.ts";
import { readPocketManifest } from "../framework/src/manifest/load.ts";
import { validateSchema, type ContractDiagnostic } from "../framework/src/manifest/validate.ts";
import { threeDsSimHz } from "../products/3ds/build.ts";
import {
  AUXILIARY_CAPABILITY,
  MANIFEST_FILE,
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

/** The committed pocket.app.json as authored: app.theme is still a path. */
function manifestFor(app: string): Manifest {
  return JSON.parse(readFileSync(join(ROOT, "apps", app, MANIFEST_FILE), "utf8")) as Manifest;
}

/** The manifest as tools/3ds.ts resolves it: readPocketManifest has loaded
 *  app.theme (apps/motions), which the rewrite does not touch. */
function loadedFor(app: string): Manifest {
  return readPocketManifest(join(ROOT, "apps", app, MANIFEST_FILE)).manifest as unknown as Manifest;
}

interface ThreeDsPlan {
  app: { entry: string; framework: string };
  viewport: { logical: readonly number[] };
  surfaces?: { auxiliary?: { logical: readonly number[] } };
  features: Record<string, boolean>;
}

function planFor(app: string, variant?: string): ThreeDsPlan {
  return resolve3dsBuildPlan(threeDsSvelteManifest(loadedFor(app), variant)) as unknown as ThreeDsPlan;
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
      "svelte-shooter",
      "svelte-snake",
      "wolfensvelte",
    ]);
    // Six carry a Svelte variant beside a Solid manifest; four declare Svelte.
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
      "svelte-shooter",
      "svelte-snake",
      "wolfensvelte",
    ]);
  });

  test("every demo the script builds admits 3ds-dev after the rewrite", () => {
    const demos = apps.filter((a) => a.output !== SHELL_OUTPUT);
    expect(demos.length).toBe(9);
    for (const app of demos) {
      const rewritten = threeDsSvelteManifest(loadedFor(app.name), app.variant);
      // Throws with the resolver's diagnostics when the manifest is rejected.
      expect(() => resolve3dsBuildPlan(rewritten)).not.toThrow();
    }
  });

  test("every rewritten manifest is a valid authored pocket.app.json", () => {
    // tools/3ds.ts loads the rewritten file through readPocketManifest; a
    // field the strict schema does not know would fail there, after the
    // rewrite and before any build output names the cause.
    for (const app of apps) {
      const diagnostics: ContractDiagnostic[] = [];
      validateSchema(
        threeDsSvelteManifest(manifestFor(app.name), app.variant),
        pocketManifestV2Schema,
        "",
        diagnostics,
      );
      expect({ app: app.name, diagnostics }).toEqual({ app: app.name, diagnostics: [] });
    }
  });

  test("the committed manifests do not admit 3ds-dev on their own", () => {
    // The rewrite is load-bearing, not defensive: 480x272 integer-fit is not a
    // viewport this target publishes.
    for (const app of apps) {
      expect(() => resolve3dsBuildPlan(loadedFor(app.name))).toThrow(/480x272/);
    }
  });

  test("points a variant app at its Svelte entry and declares the framework", () => {
    const rewritten = threeDsSvelteManifest(manifestFor("hero"), "apps/hero/main.svelte.ts");
    expect(rewritten.app.framework).toBe("svelte");
    expect(rewritten.app.entry).toBe("apps/hero/main.svelte.ts");
  });

  test("drops the Solid compiler settings with the Solid entry", () => {
    const original = manifestFor("hero");
    expect(original.app.aot).toBe(true);
    expect(original.app.model).toBe("compiled");
    const rewritten = threeDsSvelteManifest(original, "apps/hero/main.svelte.ts");
    expect("aot" in rewritten.app).toBe(false);
    expect("model" in rewritten.app).toBe(false);
  });

  test("leaves framework and entry alone for a manifest that already declares Svelte", () => {
    const original = manifestFor("svelte-snake");
    const rewritten = threeDsSvelteManifest(original, undefined);
    expect(rewritten.app.framework).toBe("svelte");
    expect(rewritten.app.entry).toBe(original.app.entry);
  });

  test("re-declares the display for the 3ds-dev profile", () => {
    const plan = planFor("hero", "apps/hero/main.svelte.ts");
    expect(plan.viewport.logical).toEqual([...THREE_DS_VIEWPORT]);
    // The plan names the bottom screen as the app's: the runtime sizes
    // ui.__auxiliarySurface from it.
    expect(plan.surfaces?.auxiliary?.logical).toEqual([...THREE_DS_AUXILIARY_VIEWPORT]);
  });

  test("the bottom-screen games keep their auxiliary surface on the two-screen product", () => {
    // products/3ds turns the top screen over to the agent stage (single
    // display mode) only for a guest whose plan declares system.agent.
    for (const app of ["svelte-shooter", "wolfensvelte"]) {
      const plan = planFor(app);
      expect(plan.app.framework).toBe("svelte");
      expect(plan.surfaces?.auxiliary?.logical).toEqual([...THREE_DS_AUXILIARY_VIEWPORT]);
      expect(plan.features[AUXILIARY_CAPABILITY]).toBe(true);
      expect(plan.features["system.agent"]).toBeUndefined();
    }
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

describe("3DS presentation rate", () => {
  test("the shooter and Wolfensvelte present at 30 Hz from their 3ds/host.toml", () => {
    for (const app of ["svelte-shooter", "wolfensvelte"]) {
      expect(threeDsSimHz(planFor(app).app.entry, ROOT)).toBe("30");
    }
  });

  test("an app without 3ds/host.toml presents at 60", () => {
    expect(threeDsSimHz(planFor("hero", "apps/hero/main.svelte.ts").app.entry, ROOT)).toBe("");
    expect(threeDsSimHz(planFor("svelte-snake").app.entry, ROOT)).toBe("");
  });
});
