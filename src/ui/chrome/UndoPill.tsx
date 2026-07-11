/**
 * UndoPill — small floating glass pill on the left edge above the dock with
 * Undo / Redo icon buttons (44px hits, kit press feedback + haptic tick).
 * Renders only while an undo or redo step exists, springing in/out
 * (transform/opacity only); each button disables when its direction is
 * unavailable. Portaled to <body> like the Dock so it z-stacks predictably
 * over the app shell's stacking context.
 */
import { useEffect, useState, type PointerEvent as ReactPointerEvent } from 'react'
import { createPortal } from 'react-dom'
import { useStore } from '../../state/store'
import { pressProps, tick } from '../kit'
import './UndoPill.css'

/** Matches the exit transition (--lg-dur-control 200ms) with a little slack. */
const UNMOUNT_DELAY_MS = 240

function UndoIcon({ size = 22 }: { size?: number }) {
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
      <path d="M8 5.5 3.5 10 8 14.5" />
      <path d="M3.5 10h10a6.5 6.5 0 0 1 6.5 6.5v1" />
    </svg>
  )
}

function RedoIcon({ size = 22 }: { size?: number }) {
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
      <path d="m16 5.5 4.5 4.5L16 14.5" />
      <path d="M20.5 10h-10A6.5 6.5 0 0 0 4 16.5v1" />
    </svg>
  )
}

export function UndoPill() {
  const canUndo = useStore((s) => s.canUndo)
  const canRedo = useStore((s) => s.canRedo)
  const undo = useStore((s) => s.undo)
  const redo = useStore((s) => s.redo)

  const visible = canUndo || canRedo

  // keep the pill mounted through its exit spring
  const [mounted, setMounted] = useState(visible)
  useEffect(() => {
    if (visible) {
      setMounted(true)
      return
    }
    const t = setTimeout(() => setMounted(false), UNMOUNT_DELAY_MS)
    return () => clearTimeout(t)
  }, [visible])

  if (typeof document === 'undefined' || !mounted) return null

  const onDown = (e: ReactPointerEvent<HTMLElement>) => {
    pressProps.onPointerDown(e)
    tick() // haptic on pointerdown, like the kit buttons
  }

  return createPortal(
    // lg-card = the nested-glass slab (bent-light rim + inset shadows, no
    // backdrop-filter); the pill CSS layers its darker over-scene tint on top
    <div
      className={`app-undo-pill lg-card${visible ? ' is-in' : ''}`}
      role="group"
      aria-label="Undo and redo"
    >
      <button
        type="button"
        className="app-undo-btn lg-pressable lg-specular lg-gel"
        aria-label="Undo"
        disabled={!canUndo}
        {...pressProps}
        onPointerDown={onDown}
        onClick={undo}
      >
        <UndoIcon />
      </button>
      <button
        type="button"
        className="app-undo-btn lg-pressable lg-specular lg-gel"
        aria-label="Redo"
        disabled={!canRedo}
        {...pressProps}
        onPointerDown={onDown}
        onClick={redo}
      >
        <RedoIcon />
      </button>
    </div>,
    document.body,
  )
}
