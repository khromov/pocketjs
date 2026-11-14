// Shared state for Input.svelte: the test flips it, then flushes. The log is
// a plain array so a handler's push needs no flush to be seen.
export const input = $state({ active: false, early: false });
export const log: string[] = [];

/** One function for every Ticker.svelte's onFrame. */
export function tick(): void {
  log.push("tick");
}
