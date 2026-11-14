#ifndef POCKETJS_3DS_QJS_H
#define POCKETJS_3DS_QJS_H
#include "runtime.h"
/* The presentation rate of the build's own app (docs/DETERMINISM.md). The
 * core steps at exactly 1/60 s (contracts/spec/spec.ts FIXED_DT).
 * products/3ds/build.ts reads the app's `pocketjs_sim_hz` from
 * <entry dir>/3ds/host.toml and the Makefile passes it as -DPOCKETJS_SIM_HZ;
 * without it every guest presents at 60. A guest from the embedded app's
 * slot (qjs_set_rate_slot) presents POCKETJS_SIM_HZ frames per second, runs
 * tick_hz / POCKETJS_SIM_HZ core ticks per frame and reads the rate as
 * globalThis.__simHz; begin_frame_wait in main.c begins its frames
 * POCKETJS_TICKS_PER_FRAME vblanks apart. */
#ifndef POCKETJS_SIM_HZ
#define POCKETJS_SIM_HZ 60
#endif
_Static_assert(POCKETJS_SIM_HZ >= 1 && 60 % POCKETJS_SIM_HZ == 0,
               "POCKETJS_SIM_HZ must divide the 60 Hz core rate");
#define POCKETJS_TICKS_PER_FRAME (60 / POCKETJS_SIM_HZ)
/* QuickJS's stack limit for the guest, and for a compile of its bundle on
 * another thread (bundle_compile.h). QuickJS recurses; the 3DS main thread's
 * stack is set in main.c. A QuickJS call frame is expensive and mounting a
 * UI descends the tree, so this budget is spent on JSX NESTING DEPTH rather
 * than node count. 192 KiB was not enough for an ordinary windowed app:
 * opening one Pocket Shell applet whose rows carried a wrapper view
 * overflowed it mid-frame, and the runtime rolled the whole guest back to
 * last-good. Svelte reaches the same ceiling sooner than Solid, because its
 * mount walks deeper per component: at 192 KiB a Svelte demo died with
 * "InternalError: stack overflow" before its first frame. The main thread's
 * own stack is 1 MiB (main.c) and this limit costs nothing until it is used. */
#define QJS_STACK_BYTES (384 * 1024)
/* One canonical Runtime; generated QuickJS Ui bindings share its state.
 * The caller retains the package until qjs_shutdown has completed.
 *
 * qjs_boot admits the package and runs the bundle without presenting it;
 * the first qjs_frame presents the mounted tree and later ones advance it.
 * With `bytecode`, the bundle runs from that compiled form in place of the
 * package's source. Otherwise, with `compiled`, qjs_boot hands back the
 * bytecode it compiled (malloc'd, NULL when it could not be written) for
 * bytecode.c to keep for the next boot of the same package. */
bool qjs_boot(PocketRuntimePackage *package, const uint8_t *bytecode, size_t bytecode_length, uint8_t **compiled, size_t *compiled_length);
bool qjs_frame(int32_t buttons,int32_t analog,const uint32_t *touches,size_t count,int32_t right_analog);
/* The runtime slot (PocketGuestPackage.slot) whose packages present at
 * POCKETJS_SIM_HZ: the embedded app's, set once before the first boot. A
 * guest from any other slot, an installed app the launcher switches to,
 * presents at 60. */
void qjs_set_rate_slot(const char *slot);
/* Vblanks from one presented frame of the booted guest to the next:
 * POCKETJS_TICKS_PER_FRAME while it presents at POCKETJS_SIM_HZ, else 1. */
uint32_t qjs_frame_vblanks(void);
/* The retained tree again, without running the guest: the leaving frames of
 * an app switch, drawn under the transition. */
bool qjs_present(void);
const char *qjs_last_error(void);
void qjs_shutdown(void);
/* Called from QuickJS's interrupt handler while the guest's code runs (a
 * boot or a frame), every few thousand bytecode steps. Returning true ends
 * that code with an uncatchable error: the boot or the frame returns false
 * and qjs_interrupted is true until the next one starts. */
typedef bool (*QjsInterrupt)(void);
void qjs_set_interrupt(QjsInterrupt hook);
bool qjs_interrupted(void);
#endif
