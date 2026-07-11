/**
 * Toast.tsx — <ToastHost/>: mounts once near the app root and renders the
 * showToast() queue (toasts.ts) as small glass pills centered above the dock.
 * Material: the rim+specular tier (DESIGN.md §1) — each pill wears the
 * bent-light rim ring (lg-rim) and registers with the shared specular
 * tracker, but takes NO backdrop-filter (toasts stack 2-3 deep and would
 * otherwise blow the ≤4 concurrent-filter budget, §7). Pills spring in
 * (transform/opacity keyframes), auto-dismiss after their duration, and fade
 * out through a short leave transition. The host is pointer-transparent —
 * toasts never block the canvas.
 *
 * Usage:
 *   <ToastHost />            // once, in App
 *   showToast('Saved')       // anywhere
 */
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { useSpecular } from './glass'
import { dismissToast, getToasts, subscribeToasts, type ToastItem } from './toasts'

const LEAVE_MS = 220 // matches .lg-toast transition

/** One glass pill: bent-light rim + tracked specular sheen (no blur). */
function ToastPill({ leaving, children }: { leaving: boolean; children: ReactNode }) {
  const specRef = useSpecular<HTMLDivElement>()
  return (
    <div ref={specRef} className={`lg-toast lg-rim ${leaving ? 'is-leaving' : ''}`}>
      {children}
    </div>
  )
}

export function ToastHost() {
  const [items, setItems] = useState<readonly ToastItem[]>(getToasts)
  const [leaving, setLeaving] = useState<readonly ToastItem[]>([])
  const prevRef = useRef<readonly ToastItem[]>(getToasts())
  const timersRef = useRef(new Map<number, number>())

  // mirror the store; keep removed toasts around briefly for the fade-out
  useEffect(() => {
    const unsub = subscribeToasts((next) => {
      const prev = prevRef.current
      prevRef.current = next
      const gone = prev.filter((p) => !next.some((n) => n.id === p.id))
      if (gone.length > 0) {
        setLeaving((l) => [...l, ...gone.filter((g) => !l.some((x) => x.id === g.id))])
        for (const g of gone) {
          window.setTimeout(() => {
            setLeaving((l) => l.filter((x) => x.id !== g.id))
          }, LEAVE_MS)
        }
      }
      setItems(next)
    })
    return unsub
  }, [])

  // one auto-dismiss timer per live toast
  useEffect(() => {
    const timers = timersRef.current
    for (const t of items) {
      if (!timers.has(t.id)) {
        timers.set(
          t.id,
          window.setTimeout(() => {
            timers.delete(t.id)
            dismissToast(t.id)
          }, t.duration),
        )
      }
    }
  }, [items])
  useEffect(() => {
    const timers = timersRef.current
    return () => {
      for (const id of timers.values()) window.clearTimeout(id)
      timers.clear()
    }
  }, [])

  if (typeof document === 'undefined') return null
  const visible = [...items, ...leaving].sort((a, b) => a.id - b.id)
  if (visible.length === 0) return null

  return createPortal(
    <div className="lg-toast-host" role="status" aria-live="polite">
      {visible.map((t) => (
        <ToastPill key={t.id} leaving={leaving.some((l) => l.id === t.id)}>
          {t.icon}
          <span>{t.text}</span>
        </ToastPill>
      ))}
    </div>,
    document.body,
  )
}
