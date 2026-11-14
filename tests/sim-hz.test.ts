import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { PRESENTATION_RATES, readSimHz, SIM_HZ_LINE } from "../tools/sim-hz.ts";

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

  test("the shooter and Wolfensvelte present at 30 Hz on the PSP and the 3DS", () => {
    for (const app of ["svelte-shooter", "wolfensvelte"]) {
      for (const file of ["psp/Psp.toml", "3ds/host.toml"]) {
        const path = `apps/${app}/${file}`;
        expect(readSimHz(readFileSync(new URL(`../${path}`, import.meta.url), "utf8"), path)).toBe("30");
      }
    }
  });
});
