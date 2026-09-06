// apps/svelte-shooter/game/layout.ts — one playfield on two very different displays.
//
//   PSP / web  480x272: a 288 px vertical playfield on the left, the HUD in
//              the remaining 192 px.
//   3DS        400x240 top screen is all playfield; the HUD moves to the
//              320x240 bottom screen (the auxiliary surface).
//   Anything else without a second screen keeps a side panel of at least
//   HUD_MIN px.

export const PLAY_MAX_W = 288;
export const HUD_MIN = 112;

export interface Layout {
  playW: number;
  playH: number;
  /** 0 when the HUD lives on the auxiliary surface. */
  hudW: number;
}

export function computeLayout(vw: number, vh: number, aux: boolean): Layout {
  if (aux) return { playW: vw, playH: vh, hudW: 0 };
  const playW = Math.min(PLAY_MAX_W, vw - HUD_MIN);
  return { playW, playH: vh, hudW: vw - playW };
}
