// Music and effects through the sim audio sink (hosts/sim/audio.ts): the
// title plays the menu track, START swaps in the level track, a shot opens an
// effect voice beside it, and a track that runs out restarts.
import { describe, expect, test } from "bun:test";
import { BTN } from "../contracts/spec/spec.ts";
import { createSimAudioSink, type SimAudioSink } from "../hosts/sim/audio.ts";
import { bootWorld, type SimWorld } from "../hosts/sim/sim.ts";

const APP = "wolfensvelte-main.svelte";
const RATE = 11025;
/** Frames of Get Psyched before play begins. */
const PSYCHED = 90;

async function step(world: SimWorld, sink: SimAudioSink, buttons = 0): Promise<void> {
  world.frame(buttons);
  for (let tick = 0; tick < world.ticksPerFrame; tick++) {
    world.tick();
    sink.tick();
  }
  await Promise.resolve();
}

async function boot(): Promise<{ world: SimWorld; sink: SimAudioSink }> {
  const sink = createSimAudioSink();
  const world = await bootWorld(APP, 60, { audio: sink.ns });
  return { world, sink };
}

const count = (sink: SimAudioSink, pattern: RegExp): number => sink.log.filter((l) => pattern.test(l)).length;

describe("Wolfensvelte audio", () => {
  test("the title opens one mono 11025 Hz stream and plays it", async () => {
    const { world, sink } = await boot();
    for (let f = 0; f < 4; f++) await step(world, sink);
    expect(count(sink, /^op createStream 11025 1$/)).toBe(1);
    expect(count(sink, /^op play /)).toBe(1);
    expect(sink.consumedFrames()).toBeGreaterThan(0);
  });

  test("START swaps to the level track and a shot adds an effect voice", async () => {
    const { world, sink } = await boot();
    await step(world, sink);
    await step(world, sink, BTN.START);
    for (let f = 0; f < PSYCHED + 2; f++) await step(world, sink);
    // The menu stream was destroyed and the level stream created in its place.
    expect(count(sink, /^op destroyStream /)).toBe(1);
    expect(count(sink, /^op createStream 11025 1$/)).toBe(2);
    await step(world, sink, BTN.RTRIGGER);
    await step(world, sink);
    // The pistol shot runs on its own voice; the music stream keeps playing.
    expect(count(sink, /^op createStream 11025 1$/)).toBe(3);
    expect(count(sink, /"t":"ended"/)).toBe(0);
  });

  test("a finished track restarts from the top", async () => {
    const { world, sink } = await boot();
    // The menu track is 125 s: run the title for a little over that.
    for (let f = 0; f < 128 * 60; f++) await step(world, sink);
    const log = sink.log;
    const ended = log.findIndex((l) => /"t":"ended"/.test(l));
    expect(ended).toBeGreaterThan(0);
    const replay = log.slice(ended + 1).findIndex((l) => /^op play /.test(l));
    expect(replay).toBeGreaterThanOrEqual(0);
    // More PCM was consumed than one pass of the track holds (125 s of 11025 Hz).
    expect(sink.consumedFrames()).toBeGreaterThan(125 * RATE);
  });
});
