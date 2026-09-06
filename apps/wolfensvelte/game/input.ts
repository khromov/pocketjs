// Buttons and the analog stick -> one PlayerInput per frame, with press edges.
//
//   d-pad up/down, analog Y      move           R trigger or CROSS (3DS B)   fire
//   d-pad left/right, analog X   turn           CIRCLE (3DS A)               use
//   ... while L is held           strafe         TRIANGLE / SQUARE (3DS X/Y)  weapon next/prev
//
// L and R are never read together, so the host's L+R chords stay free.

import { BTN } from "@pocketjs/framework/svelte/input";
import { analogX, analogY } from "@pocketjs/framework/svelte/lifecycle";
import type { PlayerInput } from "./player.ts";

export class InputReader {
  private prev = 0;
  /** A weapon chosen from the touch screen, consumed on the next read. */
  private pendingWeapon = -1;
  readonly input: PlayerInput = {
    forward: 0, strafe: 0, turn: 0, fire: false, use: false, nextWeapon: false, prevWeapon: false, selectWeapon: -1,
  };

  selectWeapon(weapon: number): void {
    this.pendingWeapon = weapon;
  }

  /** Forget held state (after a pause) so a held button does not re-trigger an edge. */
  reset(buttons: number): void {
    this.prev = buttons;
  }

  read(buttons: number): PlayerInput {
    const pressed = buttons & ~this.prev;
    this.prev = buttons;
    const i = this.input;
    let forward = (buttons & BTN.UP ? 1 : 0) - (buttons & BTN.DOWN ? 1 : 0) - analogY();
    let side = (buttons & BTN.RIGHT ? 1 : 0) - (buttons & BTN.LEFT ? 1 : 0) + analogX();
    if (forward > 1) forward = 1;
    else if (forward < -1) forward = -1;
    if (side > 1) side = 1;
    else if (side < -1) side = -1;
    const strafing = (buttons & BTN.LTRIGGER) !== 0;
    i.forward = forward;
    i.strafe = strafing ? side : 0;
    i.turn = strafing ? 0 : side;
    i.fire = (buttons & (BTN.RTRIGGER | BTN.CROSS)) !== 0;
    i.use = (pressed & BTN.CIRCLE) !== 0;
    i.nextWeapon = (pressed & BTN.TRIANGLE) !== 0;
    i.prevWeapon = (pressed & BTN.SQUARE) !== 0;
    i.selectWeapon = this.pendingWeapon;
    this.pendingWeapon = -1;
    return i;
  }
}
