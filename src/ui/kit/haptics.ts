/**
 * haptics.ts — one-liner haptic tick.
 *
 * Per DESIGN.md §1: vibrate(8) on placement commit, wire complete, Run/Pause,
 * delete, sheet snap. Silently no-ops where unsupported (iOS Safari has no
 * navigator.vibrate — that's fine, this must never throw).
 *
 * Usage: tick()        // default 8ms
 *        tick(16)      // a slightly heavier moment (delete, reset)
 */
export function tick(ms = 8): void {
  try {
    if (typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function') {
      navigator.vibrate(ms)
    }
  } catch {
    /* never let haptics break an interaction */
  }
}
