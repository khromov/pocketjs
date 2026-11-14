// tools/sim-hz.ts — the `pocketjs_sim_hz = <n>` line a console app declares
// beside its packaging metadata (docs/DETERMINISM.md): <entry dir>/psp/Psp.toml
// for the PSP (tools/psp.ts → programs/psp/build.rs), <entry dir>/3ds/host.toml
// for the 3DS (products/3ds/build.ts). The host presents n frames per second
// and runs 60 / n core ticks per frame, so n must divide the 60 Hz core rate.

/** Every `pocketjs_sim_hz` line in a TOML text, with its line break. */
export const SIM_HZ_LINE = /^[ \t]*pocketjs_sim_hz\b.*(?:\r?\n|$)/gm;

/** The rates a host can present at: the divisors of the 60 Hz core rate. */
export const PRESENTATION_RATES: readonly number[] = [1, 2, 3, 4, 5, 6, 10, 12, 15, 20, 30, 60];

/**
 * The declared rate as a decimal string, or "" when `text` declares none (the
 * host then presents at 60). Throws, naming `label`, on a value that is not
 * one of PRESENTATION_RATES.
 */
export function readSimHz(text: string, label: string): string {
  let hz = "";
  for (const line of text.match(SIM_HZ_LINE) ?? []) {
    const match = /^\s*pocketjs_sim_hz\s*=\s*(\d+)\s*(?:#.*)?$/.exec(line.trimEnd());
    const value = match ? Number(match[1]) : Number.NaN;
    if (!PRESENTATION_RATES.includes(value)) {
      throw new Error(
        `${label}: pocketjs_sim_hz must be one of ${PRESENTATION_RATES.join(", ")}, got: ${line.trim()}`,
      );
    }
    hz = String(value);
  }
  return hz;
}
