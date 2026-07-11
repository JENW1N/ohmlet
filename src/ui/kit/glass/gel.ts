/**
 * gel.ts — the gel press response of the Liquid Glass material
 * (DESIGN.md §1). Press = the existing .lg-pressable scale(0.96) plus a
 * specular BLOOM from the touch point (set here as surface-local custom
 * props, rendered by the .lg-specular::after layer in kit.css); release =
 * a springy 0.96 → 1.015 → 1 overshoot on the house curve.
 *
 * Components opt in with the `lg-gel` class (PressableButton md/lg, dock
 * items, the status capsule). `pressProps` in PressableButton.tsx calls
 * these automatically for any .lg-gel element.
 */
import { SPRING, prefersReducedMotion } from '../springs'

/** Move the specular bloom origin to the press point (surface-local px). */
export function bloomAt(el: HTMLElement, clientX: number, clientY: number): void {
  const r = el.getBoundingClientRect()
  if (r.width === 0 && r.height === 0) return
  el.style.setProperty('--lg-spec-x', `${(clientX - r.left).toFixed(1)}px`)
  el.style.setProperty('--lg-spec-y', `${(clientY - r.top).toFixed(1)}px`)
}

/**
 * Springy release: 0.96 → 1.015 overshoot → 1. Runs as a WAAPI animation on
 * top of the element's resting transform (which .lg-pressable has already
 * returned to scale(1) underneath). No-op under reduced motion.
 */
export function gelRelease(el: HTMLElement): void {
  if (prefersReducedMotion() || typeof el.animate !== 'function') return
  el.animate(
    [
      { transform: 'scale(0.96)' },
      { transform: 'scale(1.015)', offset: 0.62 },
      { transform: 'scale(1)' },
    ],
    { duration: 280, easing: SPRING },
  )
}
