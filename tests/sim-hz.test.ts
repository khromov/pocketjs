import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { PRESENTATION_RATES, readSimHz, SIM_HZ_LINE, simHzMismatch } from "../tools/sim-hz.ts";

describe("pocketjs_sim_hz host policy", () => {
  test("reads the declared rate, and nothing when the line is absent", () => {
    expect(readSimHz('title = "x"\npocketjs_sim_hz = 30\n', "Psp.toml")).toBe("30");
    expect(readSimHz("pocketjs_sim_hz=20 # launcher pace", "host.toml")).toBe("20");
    expect(readSimHz('title = "x"\n', "Psp.toml")).toBe("");
  });

  test("rejects a rate that does not divide the 60 Hz core rate", () => {
    for (const bad of ["pocketjs_sim_hz = 25", "pocketjs_sim_hz = 0", "pocketjs_sim_hz = 120", 'pocketjs_sim_hz = "30"']) {
      expect(() => readSimHz(bad, "host.toml")).toThrow("host.toml: pocketjs_sim_hz must be one of");
    }
    for (const hz of PRESENTATION_RATES) expect(60 % hz).toBe(0);
  });

  test("the PSP fragment loses only the policy line before cargo-psp reads it", () => {
    const fragment = 'title = "x"\npocketjs_sim_hz = 30\nxmb_icon_png = "icon0.png"\n';
    expect(fragment.replace(SIM_HZ_LINE, "")).toBe('title = "x"\nxmb_icon_png = "icon0.png"\n');
  });

  test("a rate applies only when it divides the package rate within 60 ticks a frame", () => {
    expect(simHzMismatch(30, 60)).toBeUndefined();
    expect(simHzMismatch(30, 240)).toBeUndefined();
    expect(simHzMismatch(20, 30)).toContain("does not divide the package rate (app.tickHz 30)");
    expect(simHzMismatch(1, 120)).toContain("would run 120 core ticks a frame");
  });

  test("every committed app's declared rate applies to its package rate", () => {
    const apps = new URL("../apps/", import.meta.url);
    for (const app of readdirSync(apps)) {
      const manifest = new URL(`${app}/pocket.app.json`, apps);
      if (!existsSync(manifest)) continue;
      const tickHz = (JSON.parse(readFileSync(manifest, "utf8")) as { app: { tickHz?: number } }).app.tickHz ?? 60;
      for (const file of ["psp/Psp.toml", "3ds/host.toml"]) {
        const policy = new URL(`${app}/${file}`, apps);
        if (!existsSync(policy)) continue;
        const hz = readSimHz(readFileSync(policy, "utf8"), `apps/${app}/${file}`);
        if (hz) expect([`apps/${app}/${file}`, simHzMismatch(Number(hz), tickHz)]).toEqual([`apps/${app}/${file}`, undefined]);
      }
    }
  });

  test("the shooter and Wolfensvelte present at 30 Hz on the PSP and the 3DS", () => {
    for (const app of ["svelte-shooter", "wolfensvelte"]) {
      for (const file of ["psp/Psp.toml", "3ds/host.toml"]) {
        const path = `apps/${app}/${file}`;
        expect(readSimHz(readFileSync(new URL(`../${path}`, import.meta.url), "utf8"), path)).toBe("30");
      }
    }
  });
});
