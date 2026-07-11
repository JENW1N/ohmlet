/**
 * RotateButton — small circular glass button in the placement-hint-toast band
 * (right edge, above the dock) that rotates the armed anchored part. It
 * renders ONLY while a dip/footprint part is armed in place mode and calls
 * the store's `rotateArmed()` action.
 *
 * Touch-only chrome: desktop pointers have the R key, so the button hides
 * behind the hover media query (`@media (hover: hover) and (pointer: fine)`,
 * DESIGN.md §4 — hover affordances are progressive enhancement, and this is
 * the inverse: a touch affordance the desktop doesn't need). 44px hit,
 * haptic tick on pointerdown, springs in/out on the house spring
 * (transform/opacity only; reduced motion collapses via the kit duration
 * tokens), safe-area aware. Portaled to <body> like the UndoPill/Dock so it
 * z-stacks predictably over the app shell.
 */
import { useEffect, useState, type PointerEvent as ReactPointerEvent } from 'react'
import { createPortal } from 'react-dom'
import { useStore } from '../../state/store'
import { getEntry } from '../../model/catalog'
import { pressProps, tick } from '../kit'
import './RotateButton.css'

/** Matches the exit transition (--lg-dur-control 200ms) with a little slack. */
const UNMOUNT_DELAY_MS = 240

/**
 * Contract bridge — `rotateArmed()` is landing on the AppState contract
 * (src/state/types.ts) from the concurrent store work. Read structurally and
 * guarded so this file compiles today and binds to the real action the
 * moment the contract lands (until then the button safely no-ops).
 */
function rotateArmedOf(s: unknown): (() => void) | undefined {
  const fn = (s as { rotateArmed?: unknown }).rotateArmed
  return typeof fn === 'function' ? (fn as () => void) : undefined
}

/** Clockwise circular-arrow rotate glyph (stroke style matches the kit). */
function RotateGlyph({ size = 22 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8" />
      <path d="M21 3v5h-5" />
    </svg>
  )
}

export function RotateButton() {
  // armed = place mode with an anchored (rigid dip/footprint) package
  const armed = useStore((s) => {
    if (s.mode.kind !== 'place') return false
    const placement = getEntry(s.mode.type)?.placement
    return placement === 'dip' || placement === 'footprint'
  })
  const rotateArmed = useStore(rotateArmedOf)

  // keep the button mounted through its exit spring (UndoPill pattern)
  const [mounted, setMounted] = useState(armed)
  useEffect(() => {
    if (armed) {
      setMounted(true)
      return
    }
    const t = setTimeout(() => setMounted(false), UNMOUNT_DELAY_MS)
    return () => clearTimeout(t)
  }, [armed])

  if (typeof document === 'undefined' || !mounted) return null

  const onDown = (e: ReactPointerEvent<HTMLElement>) => {
    pressProps.onPointerDown(e)
    tick() // haptic on pointerdown, like the kit buttons
  }

  return createPortal(
    // lg-card = the nested-glass slab (rim + insets, no backdrop-filter)
    <div className={`app-rotate-pill lg-card${armed ? ' is-in' : ''}`}>
      <button
        type="button"
        className="app-rotate-btn lg-pressable lg-specular lg-gel"
        aria-label="Rotate part"
        {...pressProps}
        onPointerDown={onDown}
        onClick={() => rotateArmed?.()}
      >
        <RotateGlyph />
      </button>
    </div>,
    document.body,
  )
}
