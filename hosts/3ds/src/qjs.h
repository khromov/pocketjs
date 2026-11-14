#ifndef POCKETJS_3DS_QJS_H
#define POCKETJS_3DS_QJS_H

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

/*
 * The presentation rate (docs/DETERMINISM.md). The core steps at exactly
 * 1/60 s (contracts/spec/spec.ts FIXED_DT); the host presents
 * POCKETJS_SIM_HZ frames per second and runs POCKETJS_TICKS_PER_FRAME core
 * ticks per frame. tools/3ds.ts passes the app's `pocketjs_sim_hz` from
 * <entry dir>/3ds/host.toml; without it the host presents at 60. qjs.c
 * publishes the rate as globalThis.__simHz.
 */
#ifndef POCKETJS_SIM_HZ
#define POCKETJS_SIM_HZ 60
#endif
_Static_assert(
  POCKETJS_SIM_HZ >= 1 && 60 % POCKETJS_SIM_HZ == 0,
  "POCKETJS_SIM_HZ must divide the 60 Hz core rate"
);
#define POCKETJS_TICKS_PER_FRAME (60 / POCKETJS_SIM_HZ)

/*
 * QuickJS embedding: `globalThis.ui` over the pocketjs-3ds-core C ABI, plus
 * the frame contract.
 *
 * qjs_boot evaluates the app bundle and looks up `globalThis.frame`; the pack
 * is borrowed for the process lifetime (it is exposed to JS zero-copy as
 * `globalThis.__pak`). qjs_frame calls `frame(buttons, analog)` once and
 * drains QuickJS's pending job queue. Both return false and leave a message
 * in qjs_last_error on failure.
 */
bool qjs_boot(
  const char *source,
  size_t source_length,
  const uint8_t *pack,
  size_t pack_length
);
bool qjs_frame(
  int32_t buttons,
  int32_t analog,
  const uint32_t *touches,
  const int32_t *hits,
  size_t touch_count,
  int32_t right_analog
);
const char *qjs_last_error(void);
void qjs_shutdown(void);

#endif
