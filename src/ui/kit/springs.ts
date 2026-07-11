/**
 * springs.ts — the one spring curve + duration constants + a tiny WAAPI
 * helper. Every animated kit component (and every redesign agent) uses these
 * so the whole app moves with a single voice.
 *
 * Usage:
 *   runSpring(el, 'translateY(640px)', 'translateY(0px)', DURATION.sheet)
 */

/** THE spring (DESIGN.md §1 Motion). Use for every transition/animation. */
export const SPRING = 'cubic-bezier(0.32, 0.72, 0, 1)'

/** Canonical durations (ms). Sheets/dock 380-450; controls 160-220; press 120. */
export const DURATION = {
  /** press feedback (scale 0.96 + dim) */
  press: 120,
  /** small controls: switch knob, segmented thumb, slider bubble */
  control: 200,
  /** dock selection bubble / panel slide-in */
  dock: 380,
  /** sheet present/snap/dismiss */
  sheet: 420,
} as const

/** True when the user asked for reduced motion. Check before any WAAPI run. */
export function prefersReducedMotion(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  )
}

/**
 * Animate `el` from one transform to another with the house spring, using the
 * Web Animations API. The final transform is committed to inline style first
 * (so the element never flashes at the wrong position), then the animation
 * plays on top. Returns the Animation, or null when reduced motion / no WAAPI
 * support (the element simply lands on `transformTo`).
 */
export function runSpring(
  el: HTMLElement,
  transformFrom: string,
  transformTo: string,
  ms: number = DURATION.sheet,
): Animation | null {
  el.style.transform = transformTo
  if (prefersReducedMotion() || typeof el.animate !== 'function') return null
  return el.animate(
    [{ transform: transformFrom }, { transform: transformTo }],
    { duration: ms, easing: SPRING },
  )
}
