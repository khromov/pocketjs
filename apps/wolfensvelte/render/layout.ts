// Screen layout for the one app on two very different displays.
//
//   PSP / web  480x272: the 3D view fills the top 480x212; the status bar is the
//              original 320x40 art scaled x1.5 across the bottom.
//   3DS        400x240 top screen is all view; the status bar, the level map and
//              the weapon buttons live on the 320x240 bottom screen.

import { getOps, hostViewport } from "@pocketjs/framework/svelte/host";
import { hasAuxiliarySurface } from "@pocketjs/framework/svelte/display";
import { FOV_DEG, STRIP_W } from "../game/constants.ts";

export const HUD_BAR_W = 320;
export const HUD_BAR_H = 40;

export interface Layout {
  screenW: number;
  screenH: number;
  viewW: number;
  viewH: number;
  /** Status bar on the auxiliary (3DS bottom) screen instead of over the view. */
  hudOnAux: boolean;
  /** Scale applied to the 320x40 status bar when it overlays the view. */
  hudScale: number;
  stripW: number;
  columns: number;
  projDist: number;
  halfFovTan: number;
  /** Scale of the 128 px weapon-hand frames. */
  handScale: number;
}

export function computeLayout(): Layout {
  // Console hosts publish no viewport (the spec screen is the viewport); the
  // 3DS and browser hosts do.
  const vp = hostViewport(getOps()) ?? { w: 480, h: 272 };
  const hudOnAux = hasAuxiliarySurface();
  const hudScale = vp.w / HUD_BAR_W;
  const viewW = vp.w;
  const viewH = hudOnAux ? vp.h : vp.h - Math.round(HUD_BAR_H * hudScale);
  const halfFovTan = Math.tan((FOV_DEG / 2) * (Math.PI / 180));
  return {
    screenW: vp.w,
    screenH: vp.h,
    viewW,
    viewH,
    hudOnAux,
    hudScale,
    stripW: STRIP_W,
    columns: Math.ceil(viewW / STRIP_W),
    projDist: viewW / 2 / halfFovTan,
    halfFovTan,
    handScale: viewH / 170,
  };
}
