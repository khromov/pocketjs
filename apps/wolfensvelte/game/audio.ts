// Sound effects over the PocketJS audio module (PSP today; absent on the 3DS,
// where every call is a no-op). Three round-robin voices so a shot, a door and
// a bark can overlap; each effect decodes once from the pak.

import { pakGet } from "@pocketjs/framework/svelte";
import { audioHost, createWavPlayer, decodeWav, type WavPcm, type WavPlayer } from "@pocketjs/framework/svelte/audio";

const VOICES = 3;

export class Sfx {
  readonly enabled: boolean;
  private readonly players: WavPlayer[] = [];
  private readonly cache = new Map<string, WavPcm>();
  private readonly missing = new Set<string>();
  private next = 0;

  constructor() {
    this.enabled = audioHost() !== null;
    if (!this.enabled) return;
    for (let i = 0; i < VOICES; i++) {
      const p = createWavPlayer();
      p.setVolume(0.7);
      this.players.push(p);
    }
  }

  play(name: string): void {
    if (!this.enabled || this.missing.has(name)) return;
    let pcm = this.cache.get(name);
    if (!pcm) {
      try {
        pcm = decodeWav(pakGet(`audio:wav.${name}`));
      } catch {
        this.missing.add(name);
        return;
      }
      this.cache.set(name, pcm);
    }
    const p = this.players[this.next];
    this.next = (this.next + 1) % VOICES;
    if (p.loadPcm(pcm)) p.play();
  }

  /** Once per frame: feeds the rings within the host's credit budget. */
  pump(): void {
    for (const p of this.players) p.pump();
  }

  dispose(): void {
    for (const p of this.players) p.dispose();
    this.players.length = 0;
  }
}
