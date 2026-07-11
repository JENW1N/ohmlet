/**
 * useSpecular — the traveling specular highlight of the Liquid Glass
 * material (DESIGN.md §1). One SHARED, rAF-throttled tracker (never a
 * per-component listener) follows the pointer and writes three custom props
 * on every registered surface:
 *
 *   --lg-spec-x / --lg-spec-y   highlight center, surface-local px
 *   --lg-spec-o                 0..1 proximity energy (1 = pointer on it)
 *
 * kit.css turns these into a soft radial sheen on the `.lg-specular::after`
 * layer, moved with transform only (compositor-cheap; the glow's opacity
 * eases via a short CSS transition so it trails organically).
 *
 * Input sources, picked once at first registration:
 *  - hover-capable pointers → window pointermove (+pointerdown so touch
 *    taps flare the nearest surface too)
 *  - phones, permission-free orientation (Android) → deviceorientation
 *    drives a gentle drift (no permission prompt is ever triggered;
 *    iOS requires a user-gesture request, so it falls through to…)
 *  - otherwise → the `is-ambient` class, a slow CSS-keyframe sheen
 *    (gated off under prefers-reduced-motion in kit.css)
 *
 * Usage (hook):       const ref = useSpecular<HTMLDivElement>()
 * Usage (imperative): const detach = attachSpecular(el)   // in an effect
 */
import { useCallback, useEffect, useRef, type RefCallback } from 'react'

/** px beyond a surface's edge where the sheen still receives energy. */
const REACH = 240

const entries = new Set<HTMLElement>()
let raf = 0
let px = NaN
let py = NaN
let listenersAttached = false
let ambient = false

function apply(): void {
  raf = 0
  if (Number.isNaN(px)) return
  for (const el of entries) {
    // rects are read fresh each frame: registered surfaces are few (≤5) and
    // translate during sheet drags, so caching would go stale. With no
    // pending layout dirt this is cheap.
    const r = el.getBoundingClientRect()
    if (r.width === 0 && r.height === 0) continue
    const dx = Math.max(r.left - px, 0, px - r.right)
    const dy = Math.max(r.top - py, 0, py - r.bottom)
    const energy = Math.max(0, 1 - Math.hypot(dx, dy) / REACH)
    el.style.setProperty('--lg-spec-x', `${(px - r.left).toFixed(1)}px`)
    el.style.setProperty('--lg-spec-y', `${(py - r.top).toFixed(1)}px`)
    el.style.setProperty('--lg-spec-o', energy.toFixed(3))
  }
}

function schedule(): void {
  if (!raf && typeof requestAnimationFrame === 'function') {
    raf = requestAnimationFrame(apply)
  }
}

function onPointer(e: PointerEvent): void {
  px = e.clientX
  py = e.clientY
  schedule()
}

function onOrientation(e: DeviceOrientationEvent): void {
  const { beta, gamma } = e
  if (beta == null || gamma == null) return
  // map a comfortable hand-held range (gamma ±35°, beta 20–75°) onto the
  // viewport so tilting the phone sweeps the sheen across the chrome
  const fx = 0.5 + Math.max(-1, Math.min(1, gamma / 35)) * 0.5
  const fy = 0.5 + Math.max(-1, Math.min(1, (beta - 45) / 30)) * 0.5
  px = window.innerWidth * fx
  py = window.innerHeight * fy
  schedule()
}

interface OrientationEventCtor {
  requestPermission?: () => Promise<string>
}

function attachListeners(): void {
  if (listenersAttached || typeof window === 'undefined') return
  listenersAttached = true
  const hoverable = window.matchMedia?.('(hover: hover)').matches ?? false
  if (hoverable) {
    window.addEventListener('pointermove', onPointer, { passive: true })
    window.addEventListener('pointerdown', onPointer, { passive: true })
    return
  }
  // touch-first: taps still flare the surface under the finger…
  window.addEventListener('pointerdown', onPointer, { passive: true })
  // …and tilt drives the drift where it needs no permission prompt (Android)
  const ctor =
    typeof DeviceOrientationEvent !== 'undefined'
      ? (DeviceOrientationEvent as unknown as OrientationEventCtor)
      : null
  if (ctor && typeof ctor.requestPermission !== 'function') {
    window.addEventListener('deviceorientation', onOrientation, { passive: true })
  } else {
    ambient = true // iOS / no sensor: slow CSS ambient sheen instead
  }
}

function detachListeners(): void {
  if (!listenersAttached || typeof window === 'undefined') return
  listenersAttached = false
  window.removeEventListener('pointermove', onPointer)
  window.removeEventListener('pointerdown', onPointer)
  window.removeEventListener('deviceorientation', onOrientation)
  if (raf) {
    cancelAnimationFrame(raf)
    raf = 0
  }
}

/**
 * Register `el` with the shared tracker and give it the specular layer.
 * Returns the detach function (call it on unmount).
 */
export function attachSpecular(el: HTMLElement): () => void {
  attachListeners()
  el.classList.add('lg-specular')
  if (ambient) el.classList.add('is-ambient')
  entries.add(el)
  schedule()
  return () => {
    entries.delete(el)
    el.classList.remove('lg-specular', 'is-ambient')
    el.style.removeProperty('--lg-spec-x')
    el.style.removeProperty('--lg-spec-y')
    el.style.removeProperty('--lg-spec-o')
    if (entries.size === 0) detachListeners()
  }
}

/** Ref-callback hook form of attachSpecular. */
export function useSpecular<T extends HTMLElement = HTMLElement>(): RefCallback<T> {
  const cleanupRef = useRef<(() => void) | null>(null)
  useEffect(
    () => () => {
      cleanupRef.current?.()
      cleanupRef.current = null
    },
    [],
  )
  return useCallback((node: T | null) => {
    cleanupRef.current?.()
    cleanupRef.current = node ? attachSpecular(node) : null
  }, [])
}
