/**
 * morph.ts — FLIP-style morph primitives for Liquid Glass transitions
 * (DESIGN.md §1). The material doesn't pop surfaces in and out — controls
 * MORPH: a button grows into the menu it opens, a sheet emerges from the
 * control that summoned it. These helpers animate scale/translate only
 * (compositor-cheap) on the house spring; apply agents use them for
 * sheet-present and button→menu transitions.
 *
 * Pattern:
 *   const from = captureRect(buttonEl)        // before the React commit
 *   …mount the menu…
 *   morphFromRect(menuEl, from, { fade: true })   // in a layout effect
 *
 * Reduced motion: a 160ms crossfade when `fade` is set, otherwise nothing
 * (the element simply appears in place).
 */
import { DURATION, SPRING, prefersReducedMotion } from '../springs'

export interface MorphRect {
  left: number
  top: number
  width: number
  height: number
}

export interface MorphOptions {
  /** Duration ms (default DURATION.sheet = 420). */
  duration?: number
  /** Also fade 0.35 → 1 while morphing (and crossfade under reduced motion). */
  fade?: boolean
  /** WAAPI composite mode. Use 'add' when the element keeps a base inline
   *  transform (e.g. the Sheet's snap translate3d) that the morph must ride
   *  on top of instead of replacing. */
  composite?: CompositeOperation
}

/** Snapshot an element's viewport rect before a layout change. */
export function captureRect(el: HTMLElement): MorphRect {
  const r = el.getBoundingClientRect()
  return { left: r.left, top: r.top, width: r.width, height: r.height }
}

/**
 * FLIP: animate `el` from where `from` was to where `el` now is — center
 * translate + non-uniform scale, transform only. Returns the Animation
 * (or null when there is nothing to run).
 */
export function morphFromRect(
  el: HTMLElement,
  from: MorphRect,
  opts: MorphOptions = {},
): Animation | null {
  if (typeof el.animate !== 'function') return null
  const to = el.getBoundingClientRect()
  if (to.width === 0 || to.height === 0) return null
  if (prefersReducedMotion()) {
    return opts.fade
      ? el.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 160, easing: 'linear' })
      : null
  }
  const sx = Math.max(from.width, 1) / to.width
  const sy = Math.max(from.height, 1) / to.height
  const dx = from.left + from.width / 2 - (to.left + to.width / 2)
  const dy = from.top + from.height / 2 - (to.top + to.height / 2)
  const start: Keyframe = {
    transformOrigin: '50% 50%',
    transform: `translate(${dx.toFixed(1)}px, ${dy.toFixed(1)}px) scale(${sx.toFixed(4)}, ${sy.toFixed(4)})`,
  }
  const end: Keyframe = { transformOrigin: '50% 50%', transform: 'translate(0px, 0px) scale(1, 1)' }
  if (opts.fade) {
    start.opacity = 0.35
    end.opacity = 1
  }
  return el.animate([start, end], {
    duration: opts.duration ?? DURATION.sheet,
    easing: SPRING,
    composite: opts.composite,
  })
}

/* ----- morph-origin handoff (control → surface) ---------------------------
   The summoning control (a dock tab) and the surface it summons (a Sheet)
   live in different components; this tiny one-slot store hands the control's
   rect across the React commit. Dock.tsx records the tapped tab's rect via
   setMorphOrigin(); the Sheet presentation consumes it with takeMorphOrigin()
   and condenses out of it. Entries expire (default 600ms) so a stale tap
   (e.g. arming Wire mode, which opens no sheet) never warps an unrelated
   presentation like the auto-presenting Properties sheet. */

let originRect: MorphRect | null = null
let originAt = 0

const nowMs = () =>
  typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? performance.now()
    : Date.now()

/** Record the control rect a soon-to-present surface should morph out of. */
export function setMorphOrigin(source: HTMLElement | MorphRect): void {
  originRect = source instanceof HTMLElement ? captureRect(source) : source
  originAt = nowMs()
}

/** Consume the pending morph origin (one shot; null when absent or stale). */
export function takeMorphOrigin(maxAgeMs = 600): MorphRect | null {
  const r = originRect
  originRect = null
  if (!r || nowMs() - originAt > maxAgeMs) return null
  return r
}

/** Sugar: morph `target` out of `source`'s current rect (button → menu). */
export function morphFromElement(
  target: HTMLElement,
  source: HTMLElement,
  opts?: MorphOptions,
): Animation | null {
  return morphFromRect(target, captureRect(source), opts)
}

/**
 * Reverse FLIP for dismissal: animate `el` from its place INTO `to`'s rect,
 * fading out. The element should be unmounted when the animation finishes.
 */
export function morphToRect(
  el: HTMLElement,
  to: MorphRect,
  opts: MorphOptions = {},
): Animation | null {
  if (typeof el.animate !== 'function') return null
  const fromRect = el.getBoundingClientRect()
  if (fromRect.width === 0 || fromRect.height === 0) return null
  if (prefersReducedMotion()) {
    return el.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 140, easing: 'linear' })
  }
  const sx = Math.max(to.width, 1) / fromRect.width
  const sy = Math.max(to.height, 1) / fromRect.height
  const dx = to.left + to.width / 2 - (fromRect.left + fromRect.width / 2)
  const dy = to.top + to.height / 2 - (fromRect.top + fromRect.height / 2)
  return el.animate(
    [
      { transformOrigin: '50% 50%', transform: 'translate(0px, 0px) scale(1, 1)', opacity: 1 },
      {
        transformOrigin: '50% 50%',
        transform: `translate(${dx.toFixed(1)}px, ${dy.toFixed(1)}px) scale(${sx.toFixed(4)}, ${sy.toFixed(4)})`,
        opacity: opts.fade === false ? 1 : 0,
      },
    ],
    { duration: opts.duration ?? 320, easing: SPRING },
  )
}
