// The 3DS HOME Menu icon: products/3ds/build.ts homeMenuIcons() finds an app's
// <entry dir>/3ds/icon.png (48x48) and optional icon-small.png (24x24), and the
// Makefile packs them into the SMDH in place of platforms/3ds/icon.png.

import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HOME_MENU_ICON_SIZE, HOME_MENU_SMALL_ICON_SIZE, homeMenuIcons } from "../products/3ds/build.ts";
import { encodePNG } from "./png.ts";

const ROOT = new URL("..", import.meta.url).pathname;
const png = (width: number, height = width): Buffer => encodePNG(new Uint8Array(width * height * 4), width, height);

function withApp(files: Record<string, Buffer>, run: (entry: string, root: string) => void): void {
  const root = mkdtempSync(join(tmpdir(), "pocketjs-3ds-icon-"));
  try {
    mkdirSync(join(root, "app", "3ds"), { recursive: true });
    for (const [name, bytes] of Object.entries(files)) writeFileSync(join(root, "app", "3ds", name), bytes);
    run("app/main.ts", root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

describe("HOME Menu icon", () => {
  test("falls back to the platform icon when the app ships none", () => {
    withApp({}, (entry, root) => expect(homeMenuIcons(entry, root)).toBeUndefined());
  });

  test("finds <entry dir>/3ds/icon.png and an optional small icon", () => {
    withApp({ "icon.png": png(HOME_MENU_ICON_SIZE) }, (entry, root) => {
      expect(homeMenuIcons(entry, root)).toEqual({ icon: join(root, "app", "3ds", "icon.png") });
    });
    withApp({ "icon.png": png(HOME_MENU_ICON_SIZE), "icon-small.png": png(HOME_MENU_SMALL_ICON_SIZE) }, (entry, root) => {
      expect(homeMenuIcons(entry, root)?.small).toBe(join(root, "app", "3ds", "icon-small.png"));
    });
  });

  test("rejects an icon smdhtool would refuse, before the container starts", () => {
    // The PSP's 144x80 ICON0 is the likeliest wrong file to land here.
    withApp({ "icon.png": png(144, 80) }, (entry, root) => {
      expect(() => homeMenuIcons(entry, root)).toThrow(/must be a 48x48 PNG, found 144x80/);
    });
    withApp({ "icon.png": Buffer.from("not a png") }, (entry, root) => {
      expect(() => homeMenuIcons(entry, root)).toThrow(/found no PNG header/);
    });
    withApp({ "icon.png": png(HOME_MENU_ICON_SIZE), "icon-small.png": png(HOME_MENU_ICON_SIZE) }, (entry, root) => {
      expect(() => homeMenuIcons(entry, root)).toThrow(/must be a 24x24 PNG/);
    });
  });

  test("every app the Svelte 3DS build ships has an icon of its own", () => {
    const apps = ["cards", "chrome", "cursor", "hero", "motions", "svelte-lab", "svelte-shooter", "svelte-snake", "wolfensvelte"];
    const digests = new Set<string>();
    for (const app of apps) {
      const manifest = JSON.parse(readFileSync(join(ROOT, "apps", app, "pocket.app.json"), "utf8"));
      const icons = homeMenuIcons(manifest.app.entry, ROOT);
      expect(icons?.icon).toBe(join(ROOT, "apps", app, "3ds", "icon.png"));
      digests.add(createHash("sha256").update(readFileSync(icons!.icon)).digest("hex"));
    }
    expect(digests.size).toBe(apps.length);
  });

  test("the Makefile takes the icon from the environment and stamps it", () => {
    const makefile = readFileSync(join(ROOT, "products/3ds/Makefile"), "utf8");
    expect(makefile).toContain("ICON ?= $(if $(POCKETJS_ICON),$(POCKETJS_ICON),$(PLATFORM_SOURCE)/icon.png)");
    expect(makefile).toContain("$(if $(POCKETJS_ICON_SMALL),$(POCKETJS_ICON_SMALL),");
    // Switching back to the older platform icon must still rebuild the SMDH.
    expect(makefile).toContain('"$$POCKETJS_SMDH_AUTHOR" "$(ICON)" "$(SMALL_ICON)" > $(SMDH_STAMP).new');
  });
});
