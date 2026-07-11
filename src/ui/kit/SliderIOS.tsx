/**
 * SliderIOS — iOS slider with a 28px knob and a value bubble that floats
 * above the knob while dragging. Pointer events + setPointerCapture; during
 * a drag the knob/fill/bubble are written directly to the DOM (no per-move
 * React renders needed even if the parent throttles onChange).
 *
 * Controlled. `formatValue` renders the bubble (and aria-valuetext).
 *
 * Usage:
 *   <SliderIOS value={pos} min={0} max={1} step={0.01}
 *     onChange={setPos} formatValue={(v) => `${Math.round(v * 100)}%`} />
 */
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react'
import { attachSpecular, bloomAt } from './glass'

export interface SliderIOSProps {
  value: number
  min: number
  max: number
  step?: number
  onChange: (value: number) => void
  /** Called once on release with the final value (commit point). */
  onCommit?: (value: number) => void
  formatValue?: (value: number) => string
  disabled?: boolean
  'aria-label'?: string
  className?: string
}

const KNOB = 28 // px, matches .lg-slider-knob

function clamp(v: number, lo: number, hi: number) {
  return Math.min(hi, Math.max(lo, v))
}

export function SliderIOS({
  value,
  min,
  max,
  step,
  onChange,
  onCommit,
  formatValue,
  disabled = false,
  className,
  ...aria
}: SliderIOSProps) {
  const rootRef = useRef<HTMLDivElement | null>(null)
  const fillRef = useRef<HTMLDivElement | null>(null)
  const knobRef = useRef<HTMLDivElement | null>(null)
  const bubbleRef = useRef<HTMLDivElement | null>(null)
  const specRef = useRef<HTMLDivElement | null>(null)
  const lastRef = useRef(value)
  const [dragging, setDragging] = useState(false)
  const [trackW, setTrackW] = useState(0)

  // the knob's tiny specular (DESIGN.md §1): register the glint layer with
  // the shared pointer tracker; touch drags refresh it via bloomAt below
  useEffect(() => {
    const el = specRef.current
    if (!el) return
    return attachSpecular(el)
  }, [])

  const span = max - min || 1
  const quantize = (raw: number) => {
    let v = clamp(raw, min, max)
    if (step && step > 0) {
      v = min + Math.round((v - min) / step) * step
      // kill float noise (e.g. 0.30000000000000004)
      const decimals = Math.min(10, Math.max(0, -Math.floor(Math.log10(step)) + 2))
      v = parseFloat(v.toFixed(decimals))
      v = clamp(v, min, max)
    }
    return v
  }
  const format = (v: number) => (formatValue ? formatValue(v) : String(v))

  const paint = (v: number) => {
    const frac = clamp((v - min) / span, 0, 1)
    const w = rootRef.current ? rootRef.current.clientWidth - KNOB : trackW
    if (knobRef.current) knobRef.current.style.transform = `translate3d(${frac * w}px, 0, 0)`
    if (fillRef.current) fillRef.current.style.transform = `scaleX(${frac})`
    if (bubbleRef.current) bubbleRef.current.textContent = format(v)
  }

  // keep visuals in sync with the controlled value + container size
  useLayoutEffect(() => {
    const root = rootRef.current
    if (!root) return
    const measure = () => setTrackW(root.clientWidth - KNOB)
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(root)
    return () => ro.disconnect()
  }, [])
  useLayoutEffect(() => {
    lastRef.current = value
    paint(value)
  })

  const handleAt = (clientX: number, clientY?: number) => {
    const root = rootRef.current
    if (!root) return
    const rect = root.getBoundingClientRect()
    const frac = clamp((clientX - rect.left - KNOB / 2) / Math.max(rect.width - KNOB, 1), 0, 1)
    const v = quantize(min + frac * span)
    paint(v)
    // keep the knob glint under the finger while dragging (the shared
    // tracker covers hover pointers; touch only reports pointerdown there)
    if (clientY != null && specRef.current) bloomAt(specRef.current, clientX, clientY)
    if (v !== lastRef.current) {
      lastRef.current = v
      onChange(v)
    }
  }

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (disabled) return
    e.currentTarget.setPointerCapture(e.pointerId)
    setDragging(true)
    handleAt(e.clientX, e.clientY)
  }
  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!dragging) return
    handleAt(e.clientX, e.clientY)
  }
  const endDrag = () => {
    if (!dragging) return
    setDragging(false)
    onCommit?.(lastRef.current)
  }

  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    const kStep = step && step > 0 ? step : span / 100
    let v: number | null = null
    if (e.key === 'ArrowRight' || e.key === 'ArrowUp') v = quantize(value + kStep)
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') v = quantize(value - kStep)
    else if (e.key === 'Home') v = min
    else if (e.key === 'End') v = max
    if (v != null) {
      e.preventDefault()
      if (v !== value) {
        onChange(v)
        onCommit?.(v)
      }
    }
  }

  return (
    <div
      ref={rootRef}
      className={`lg-slider ${dragging ? 'is-dragging' : ''} ${disabled ? 'is-disabled' : ''} ${className ?? ''}`}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
    >
      <div className="lg-slider-track" aria-hidden="true">
        <div ref={fillRef} className="lg-slider-fill" />
      </div>
      <div
        ref={knobRef}
        className="lg-slider-knob"
        role="slider"
        tabIndex={disabled ? -1 : 0}
        aria-label={aria['aria-label']}
        aria-valuemin={min}
        aria-valuemax={max}
        aria-valuenow={value}
        aria-valuetext={format(value)}
        aria-disabled={disabled || undefined}
        onKeyDown={onKeyDown}
      >
        {/* tiny tracked specular (clipped to the knob; bubble stays outside) */}
        <div ref={specRef} className="lg-slider-knob-spec" aria-hidden="true" />
        <div ref={bubbleRef} className="lg-slider-bubble" aria-hidden="true">
          {format(value)}
        </div>
      </div>
    </div>
  )
}
