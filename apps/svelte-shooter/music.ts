// apps/svelte-shooter/music.ts — the stage theme over the audio module.
//
// One WavPlayer streaming audio:wav.theme from the pak; the fourth of the
// host's four streams beside the three effect voices. The player reports the
// host's "ended" fact, so the loop is a rewind and a play (the wolfensvelte
// shape). Where no audio module is mounted, or the pak carries no theme
// (targets without audio.pcm leave it out), every call is a no-op.

import { audioHost, createWavPlayer, type WavPlayer } from "@pocketjs/framework/svelte/audio";

const THEME = "theme";
const VOLUME = 0.42;

export interface Music {
  readonly enabled: boolean;
  /** Start the theme from the top (idempotent while it plays). */
  play(): void;
  pause(): void;
  resume(): void;
  /** Once per frame: feed the ring, and loop when the track has ended. */
  pump(): void;
  dispose(): void;
}

const SILENT: Music = {
  enabled: false,
  play() {},
  pause() {},
  resume() {},
  pump() {},
  dispose() {},
};

export function createMusic(): Music {
  if (audioHost() === null) return SILENT;
  const player: WavPlayer = createWavPlayer();
  if (!player.load(THEME)) {
    player.dispose();
    return SILENT;
  }
  player.setVolume(VOLUME);
  let started = false;
  let paused = false;
  return {
    enabled: true,
    play() {
      started = true;
      paused = false;
      player.play();
    },
    pause() {
      if (!started) return;
      paused = true;
      player.pause();
    },
    resume() {
      if (!started || !paused) return;
      paused = false;
      player.play();
    },
    pump() {
      player.pump();
      if (started && !paused && !player.playing()) {
        player.stop();
        player.play();
      }
    },
    dispose() {
      player.dispose();
    },
  };
}
