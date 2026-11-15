// platforms/3ds/audio.c on the host: the module compiles against a fake NDSP
// (tests/fixtures/3ds-audio) with ASan and UBSan, as tests/3ds-soc.test.ts
// does for soc.c. The harness checks the behaviour streams.rs defines for
// the PSP; this file adds what only the spec can say: the constants, and the
// exact poll() lines.
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  AUDIO_EVENT,
  AUDIO_MAX_CHANNELS,
  AUDIO_MAX_STREAMS,
  AUDIO_RATES,
  AUDIO_RING_FRAMES,
} from "../contracts/spec/audio.ts";

const root = resolve(import.meta.dir, "..");
const scratch = mkdtempSync(join(tmpdir(), "pocket-3ds-audio-"));
const binary = join(scratch, "audio");
let compiled = false;

function harness(): string {
  if (compiled) return binary;
  const compile = Bun.spawnSync([
    "cc", "-std=c11", "-Wall", "-Wextra", "-Werror", "-g", "-O1",
    "-fsanitize=address,undefined", "-fno-sanitize-recover=all",
    `-I${root}/tests/fixtures/3ds-audio`,
    `-DSPEC_RING_FRAMES=${AUDIO_RING_FRAMES}`,
    `-DSPEC_MAX_STREAMS=${AUDIO_MAX_STREAMS}`,
    `-DSPEC_MAX_CHANNELS=${AUDIO_MAX_CHANNELS}`,
    `-DSPEC_RATES=${AUDIO_RATES.join(",")}`,
    `${root}/tests/fixtures/3ds-audio/harness.c`,
    `${root}/platforms/3ds/audio.c`,
    "-o", binary,
  ]);
  expect(compile.exitCode, compile.stderr.toString()).toBe(0);
  compiled = true;
  return binary;
}

function run(mode: string): string {
  const result = Bun.spawnSync([harness(), mode], { timeout: 30000 });
  expect(result.exitCode, result.stderr.toString() + result.stdout.toString()).toBe(0);
  return result.stdout.toString();
}

afterAll(() => rmSync(scratch, { recursive: true, force: true }));

describe("3DS audio module", () => {
  test("handles, writes, credit, edges, wave buffers, the guest pump and teardown", () => {
    const out = run("suite");
    for (const step of [
      "ok lifecycle",
      "ok rates and format",
      "ok handles and refusals",
      "ok partial writes",
      "ok credit",
      "ok event order",
      "ok underrun",
      "ok ended",
      "ok stop and pause",
      "ok ring bounds",
      "ok coalescing",
      "ok sub-grain tail",
      "ok tiny writes",
      "ok volume",
      "ok destroy and reset",
      "ok guest pump 11025 Hz x1",
      "ok guest pump 22050 Hz x1",
      "ok guest pump 44100 Hz x2",
      "ok shutdown, channel 0 untouched",
    ]) expect(out).toContain(step);
    expect(out).toContain("3DS audio module verified");
  }, 60000);

  test("poll() returns the spec's events, one a call, in slot then ended/underrun/credit order", () => {
    const lines = run("transcript").trimEnd().split("\n");
    expect(lines).toEqual([
      '{"t":"ended","h":8}',
      '{"t":"credit","h":8,"free":16384}',
      '{"t":"credit","h":9,"free":15360}',
      "-",
      '{"t":"underrun","h":9}',
      '{"t":"credit","h":9,"free":16384}',
      "-",
      "-",
      "-",
      '{"t":"underrun","h":9}',
      '{"t":"credit","h":9,"free":16384}',
      "-",
      "-",
      '{"t":"ended","h":16}',
      '{"t":"credit","h":16,"free":16384}',
      "-",
    ]);
    const names = new Set<string>(Object.values(AUDIO_EVENT));
    for (const line of lines.filter((l) => l !== "-")) {
      const event = JSON.parse(line) as { t: string; h: number; free?: number };
      expect(names.has(event.t)).toBe(true);
      expect(Number.isInteger(event.h) && event.h > 0).toBe(true);
      expect(Object.keys(event)).toEqual(event.t === AUDIO_EVENT.credit ? ["t", "h", "free"] : ["t", "h"]);
    }
  }, 60000);

  test("without DSP firmware the module stays unmounted: no retry, no channel touched", () => {
    expect(run("nofirmware")).toContain(
      "ok start failure: audio: DSP firmware missing (sdmc:/3ds/dspfirm.cdc); dump it in Rosalina and restart",
    );
    expect(run("initfail")).toContain("ok start failure: audio: ndspInit failed (0xffffffff)");
  }, 60000);

  test("a bind whose rings do not fit is refused, and the next bind allocates the rest", () => {
    expect(run("nomemory")).toContain("ok ring allocation failure");
  }, 60000);

  test("the header's constants are contracts/spec/audio.ts's", () => {
    const header = readFileSync(join(root, "platforms/3ds/audio.h"), "utf8");
    const value = (name: string) => Number(header.match(new RegExp(`#define ${name} (\\d+)u`))?.[1]);
    expect(value("POCKET_3DS_AUDIO_RING_FRAMES")).toBe(AUDIO_RING_FRAMES);
    expect(value("POCKET_3DS_AUDIO_MAX_STREAMS")).toBe(AUDIO_MAX_STREAMS);
    expect(value("POCKET_3DS_AUDIO_MAX_CHANNELS")).toBe(AUDIO_MAX_CHANNELS);
    // The stream channels stay inside NDSP's 24 and clear of media.c's.
    const first = value("POCKET_3DS_AUDIO_FIRST_CHANNEL");
    expect(first + AUDIO_MAX_STREAMS).toBeLessThanOrEqual(24);
    const media = readFileSync(join(root, "platforms/3ds/media.c"), "utf8");
    const mediaChannel = Number(media.match(/AUDIO_CHANNEL=(\d+)/)?.[1]);
    expect(Number.isInteger(mediaChannel)).toBe(true);
    expect(mediaChannel < first || mediaChannel >= first + AUDIO_MAX_STREAMS).toBe(true);
    const source = readFileSync(join(root, "platforms/3ds/audio.c"), "utf8");
    const accepted = [...source.matchAll(/sample_rate != (\d+)u/g)].map((m) => Number(m[1]));
    expect(accepted).toEqual([...AUDIO_RATES]);
  });
});

// A CIA runs under its own exheader: ndspInit writes the DSP's shared memory
// at 0x1FF50000 and up, so products/3ds/app.rsf must map 0x1FF00000-0x1FF7FFFF.
// Without it every CIA took a data abort inside ndspInitialize at boot, which
// the host harness and the .3dsx in Azahar (the Homebrew Launcher's exheader
// maps the range) never showed.
test("the 3DS CIA exheader maps DSP memory for the NDSP the runtime starts", () => {
  const audio = readFileSync(join(root, "platforms/3ds/audio.c"), "utf8");
  expect(audio).toMatch(/\bndspInit\(\)/);
  const rsf = readFileSync(join(root, "products/3ds/app.rsf"), "utf8");
  expect(rsf).toMatch(/^  IORegisterMapping:\n(?:\s*#.*\n)*\s+- 1ff00000-1ff7ffff\b/m);
});
