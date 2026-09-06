// apps/svelte-shooter/sfx.ts — synthesized blips over the audio module.
//
// Every clip is generated once at start-up (deterministic; no assets), then
// played through three round-robin WavPlayers so a shot, a hit and an
// explosion can overlap — the apps/wolfensvelte shape. Where the host mounts
// no audio module (sim, consoles) createSfx() returns a silent object and
// nothing else in the app changes: sound never feeds back into the game.

import { audioHost, createWavPlayer, type WavPcm, type WavPlayer } from "@pocketjs/framework/svelte/audio";

export const SFX_SHOT = 0;
export const SFX_HIT = 1;
export const SFX_EXPLODE = 2;
export const SFX_BOMB = 3;
export const SFX_DEATH = 4;
export const SFX_PHASE = 5;
export const SFX_CLEAR = 6;

const RATE = 22050;
const VOICES = 3;
const TAU = Math.PI * 2;

export interface Sfx {
  readonly enabled: boolean;
  play(id: number): void;
  /** Once per frame: feeds the rings within the host's credit budget. */
  pump(): void;
  dispose(): void;
}

const SILENT: Sfx = {
  enabled: false,
  play() {},
  pump() {},
  dispose() {},
};

let noiseState = 0x2545f491;
function noise(): number {
  let x = noiseState;
  x ^= x << 13;
  x >>>= 0;
  x ^= x >>> 17;
  x ^= x << 5;
  x >>>= 0;
  noiseState = x;
  return x / 2147483648 - 1;
}

function clip(seconds: number, gen: (t: number) => number): WavPcm {
  const frames = Math.round(RATE * seconds);
  const data = new Int16Array(frames);
  for (let i = 0; i < frames; i++) {
    let v = gen(i / RATE);
    if (v > 1) v = 1;
    else if (v < -1) v = -1;
    data[i] = Math.round(v * 32767);
  }
  return { sampleRate: RATE, channels: 1, frames, data };
}

function shot(): WavPcm {
  let phase = 0;
  return clip(0.07, (t) => {
    phase += (1200 * Math.pow(2, -t * 10)) / RATE;
    return (phase % 1 < 0.5 ? 1 : -1) * Math.exp(-t * 40) * 0.18;
  });
}

function hit(): WavPcm {
  return clip(0.05, (t) => noise() * Math.exp(-t * 70) * 0.3);
}

function explode(): WavPcm {
  let lp = 0;
  return clip(0.35, (t) => {
    lp += (noise() - lp) * 0.2;
    return lp * Math.exp(-t * 9) * 0.9 + Math.sin(t * 55 * TAU) * Math.exp(-t * 7) * 0.5;
  });
}

function bomb(): WavPcm {
  let phase = 0;
  return clip(0.5, (t) => {
    phase += (120 + 780 * (t / 0.5)) / RATE;
    return Math.sin(phase * TAU) * (1 - t / 0.5) * 0.5 + noise() * 0.15 * Math.exp(-t * 4);
  });
}

function death(): WavPcm {
  let phase = 0;
  return clip(0.55, (t) => {
    phase += (500 * Math.pow(2, -t * 4.5)) / RATE;
    return ((phase % 1) * 2 - 1) * (1 - t / 0.55) * 0.45;
  });
}

function phaseChange(): WavPcm {
  let phase = 0;
  return clip(0.35, (t) => {
    phase += (t < 0.15 ? 660 : 990) / RATE;
    return (phase % 1 < 0.5 ? 1 : -1) * (1 - t / 0.35) * 0.28;
  });
}

function stageClear(): WavPcm {
  const notes = [523.25, 659.25, 783.99, 1046.5];
  let phase = 0;
  return clip(0.8, (t) => {
    const n = Math.min(3, Math.floor(t / 0.2));
    phase += notes[n] / RATE;
    return Math.sin(phase * TAU) * Math.exp(-(t - n * 0.2) * 6) * 0.4;
  });
}

export function createSfx(): Sfx {
  if (audioHost() === null) return SILENT;
  const clips = [shot(), hit(), explode(), bomb(), death(), phaseChange(), stageClear()];
  const players: WavPlayer[] = [];
  for (let i = 0; i < VOICES; i++) {
    const p = createWavPlayer();
    p.setVolume(0.6);
    players.push(p);
  }
  let next = 0;
  return {
    enabled: true,
    play(id) {
      const pcm = clips[id];
      if (!pcm) return;
      const p = players[next];
      next = (next + 1) % VOICES;
      if (p.loadPcm(pcm)) p.play();
    },
    pump() {
      for (const p of players) p.pump();
    },
    dispose() {
      for (const p of players) p.dispose();
      players.length = 0;
    },
  };
}
