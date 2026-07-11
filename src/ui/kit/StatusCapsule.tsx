/**
 * StatusCapsule — the top-center floating glass pill (Dynamic-Island-like),
 * a full lens-tier Liquid Glass surface (lg-lens-capsule).
 * Left slot for a status dot, center content (sim clock, etc.). `expanded`
 * reveals a second detail line as a fluid GROW: the incoming fixed-size pill
 * layer FLIP-morphs (glass/morph.ts) from the outgoing layer's rect while
 * the two crossfade (transform/opacity only — no width/height animation, so
 * it stays on the compositor).
 *
 * Tap (`onTap`, e.g. Run/Pause) and 500ms long-press (`onLongPress`, e.g.
 * Reset) with a 10px movement tolerance, pointer-events based.
 *
 * Usage:
 *   <StatusCapsule dot={<span className="run-dot" />} expanded={!!issue}
 *     expandedContent={issue} onTap={toggleRun} onLongPress={reset}>
 *     {clock}
 *   </StatusCapsule>
 */
import {
  useEffect,
  useLayoutEffect,
  useRef,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from 'react'
import { createPortal } from 'react-dom'
import { tick } from './haptics'
import { DURATION } from './springs'
import {
  attachSpecular,
  attachToneAdapt,
  bloomAt,
  captureRect,
  gelRelease,
  morphFromRect,
} from './glass'

export interface StatusCapsuleProps {
  /** Status dot / small leading element. */
  dot?: ReactNode
  /** Always-visible primary line (clock, run state). */
  children: ReactNode
  /** When true, the two-line layer is shown (crossfade + translate). */
  expanded?: boolean
  /** Second line shown while expanded. */
  expandedContent?: ReactNode
  onTap?: () => void
  onLongPress?: () => void
  'aria-label'?: string
  className?: string
}

const LONG_PRESS_MS = 500
const MOVE_TOLERANCE = 10

export function StatusCapsule({
  dot,
  children,
  expanded = false,
  expandedContent,
  onTap,
  onLongPress,
  className,
  ...aria
}: StatusCapsuleProps) {
  const timerRef = useRef<number | null>(null)
  const pressRef = useRef<{ id: number; x: number; y: number; fired: boolean; moved: boolean } | null>(null)
  const hitRef = useRef<HTMLDivElement | null>(null)

  // Liquid Glass: both pill layers carry the tracked specular sheen
  // (shared singleton listener; the hidden layer paints nothing anyway).
  // Tone adaptation registers ONCE on the hit wrap — the inherited
  // --lg-lum / .is-tone-light flip both layers together, so the
  // expand/collapse crossfade can never mix tones.
  useEffect(() => {
    const hit = hitRef.current
    if (!hit) return
    const detachers = Array.from(hit.querySelectorAll<HTMLElement>('.lg-capsule')).map((el) =>
      attachSpecular(el),
    )
    detachers.push(attachToneAdapt(hit))
    return () => detachers.forEach((d) => d())
  }, [])

  /** The visible pill layer (bloom target for the gel press). */
  const visiblePill = () =>
    hitRef.current?.querySelector<HTMLElement>('.lg-capsule:not(.is-hidden)') ?? null

  /* Liquid Glass morph (DESIGN.md §1 behavior 5): the expand/collapse is a
     fluid GROW — the incoming pill layer FLIPs from the outgoing layer's
     rect while the existing CSS crossfade swaps their opacity. Both layers
     keep their fixed layout (is-hidden is visibility-only), so the rects are
     always measurable. Reduced motion: morphFromRect no-ops and the
     (duration-collapsed) crossfade stands alone. */
  const expandedWasRef = useRef(expanded)
  useLayoutEffect(() => {
    if (expandedWasRef.current === expanded) return
    expandedWasRef.current = expanded
    const hit = hitRef.current
    if (!hit) return
    const layers = hit.querySelectorAll<HTMLElement>('.lg-capsule')
    const collapsedEl = layers[0]
    const expandedEl = layers[1]
    if (!collapsedEl || !expandedEl) return
    const incoming = expanded ? expandedEl : collapsedEl
    const outgoing = expanded ? collapsedEl : expandedEl
    morphFromRect(incoming, captureRect(outgoing), { duration: DURATION.control + 80 })
  }, [expanded])

  const clearTimer = () => {
    if (timerRef.current != null) {
      window.clearTimeout(timerRef.current)
      timerRef.current = null
    }
  }
  useEffect(() => clearTimer, [])

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return
    e.currentTarget.setPointerCapture(e.pointerId)
    e.currentTarget.dataset.pressed = 'true'
    const pill = visiblePill()
    if (pill) bloomAt(pill, e.clientX, e.clientY) // gel press bloom
    pressRef.current = { id: e.pointerId, x: e.clientX, y: e.clientY, fired: false, moved: false }
    clearTimer()
    timerRef.current = window.setTimeout(() => {
      const p = pressRef.current
      if (p && !p.moved) {
        p.fired = true
        tick(16)
        onLongPress?.()
      }
    }, LONG_PRESS_MS)
  }
  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const p = pressRef.current
    if (!p || e.pointerId !== p.id || p.moved) return
    if (Math.hypot(e.clientX - p.x, e.clientY - p.y) > MOVE_TOLERANCE) {
      p.moved = true
      clearTimer()
      delete e.currentTarget.dataset.pressed
    }
  }
  const onPointerUp = (e: ReactPointerEvent<HTMLDivElement>) => {
    const p = pressRef.current
    if (!p || e.pointerId !== p.id) return
    pressRef.current = null
    clearTimer()
    if (e.currentTarget.dataset.pressed) gelRelease(e.currentTarget) // springy 1.015 overshoot
    delete e.currentTarget.dataset.pressed
    if (!p.fired && !p.moved) {
      tick()
      onTap?.()
    }
  }
  const onPointerCancel = (e: ReactPointerEvent<HTMLDivElement>) => {
    pressRef.current = null
    clearTimer()
    delete e.currentTarget.dataset.pressed
  }
  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      onTap?.()
    }
  }

  if (typeof document === 'undefined') return null

  // Portaled to <body>: like iOS's Dynamic Island the capsule floats above
  // sheets and their scrims (Run/Pause stays reachable while a sheet is
  // half-open); inside the .app-root stacking context it could not.
  return createPortal(
    <div className={`lg-capsule-wrap ${className ?? ''}`}>
      <div
        ref={hitRef}
        role="button"
        tabIndex={0}
        aria-label={aria['aria-label']}
        className="lg-capsule-hit"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerCancel}
        onKeyDown={onKeyDown}
        onContextMenu={(e) => e.preventDefault()}
      >
        {/* collapsed layer */}
        <div
          className={`lg-surface lg-lens lg-lens-capsule lg-capsule ${expanded ? 'is-hidden' : ''}`}
          aria-hidden={expanded}
        >
          <div className="lg-tone" aria-hidden="true" />
          {dot != null && <span className="lg-capsule-dot">{dot}</span>}
          <span className="lg-capsule-main">{children}</span>
        </div>
        {/* expanded layer (own fixed layout; crossfades in) */}
        <div
          className={`lg-surface lg-lens lg-lens-capsule lg-capsule is-expanded ${expanded ? '' : 'is-hidden'}`}
          aria-hidden={!expanded}
        >
          <div className="lg-tone" aria-hidden="true" />
          <div className="lg-capsule-line">
            {dot != null && <span className="lg-capsule-dot">{dot}</span>}
            <span className="lg-capsule-main">{children}</span>
          </div>
          <div className="lg-capsule-detail">{expandedContent}</div>
        </div>
      </div>
    </div>,
    document.body,
  )
}
