/**
 * Stepper — iOS −/+ stepper with press-and-hold repeat (500ms delay, then
 * ~9 steps/sec). Controlled; clamps to min/max; optional inline value
 * readout (tabular numerals) between the buttons.
 *
 * Usage:
 *   <Stepper value={n} min={1} max={64} onChange={setN} showValue />
 */
import { useEffect, useRef, type PointerEvent as ReactPointerEvent } from 'react'
import { tick } from './haptics'
import { MinusIcon, PlusIcon } from './icons'

export interface StepperProps {
  value: number
  onChange: (value: number) => void
  min?: number
  max?: number
  step?: number
  /** Render the current value between the buttons. */
  showValue?: boolean
  formatValue?: (value: number) => string
  disabled?: boolean
  /** Haptic tick per increment (default true). */
  haptic?: boolean
  'aria-label'?: string
  className?: string
}

const HOLD_DELAY = 500 // ms before auto-repeat kicks in
const HOLD_INTERVAL = 110 // ms between repeats

function clamp(v: number, lo: number, hi: number) {
  return Math.min(hi, Math.max(lo, v))
}

export function Stepper({
  value,
  onChange,
  min = -Infinity,
  max = Infinity,
  step = 1,
  showValue = false,
  formatValue,
  disabled = false,
  haptic = true,
  className,
  ...aria
}: StepperProps) {
  const valueRef = useRef(value)
  valueRef.current = value
  const delayRef = useRef<number | null>(null)
  const repeatRef = useRef<number | null>(null)

  const stopHold = () => {
    if (delayRef.current != null) window.clearTimeout(delayRef.current)
    if (repeatRef.current != null) window.clearInterval(repeatRef.current)
    delayRef.current = null
    repeatRef.current = null
  }
  useEffect(() => stopHold, [])

  const fire = (dir: 1 | -1) => {
    const next = clamp(parseFloat((valueRef.current + dir * step).toPrecision(12)), min, max)
    if (next !== valueRef.current) {
      valueRef.current = next
      if (haptic) tick()
      onChange(next)
    }
  }

  const startHold = (dir: 1 | -1) => (e: ReactPointerEvent<HTMLButtonElement>) => {
    if (disabled) return
    e.currentTarget.dataset.pressed = 'true'
    e.currentTarget.setPointerCapture(e.pointerId)
    fire(dir)
    stopHold()
    delayRef.current = window.setTimeout(() => {
      repeatRef.current = window.setInterval(() => fire(dir), HOLD_INTERVAL)
    }, HOLD_DELAY)
  }
  const endHold = (e: ReactPointerEvent<HTMLButtonElement>) => {
    delete e.currentTarget.dataset.pressed
    stopHold()
  }

  const btnProps = (dir: 1 | -1, atLimit: boolean) => ({
    type: 'button' as const,
    disabled: disabled || atLimit,
    className: 'lg-stepper-btn lg-hit',
    onPointerDown: startHold(dir),
    onPointerUp: endHold,
    onPointerCancel: endHold,
    onPointerLeave: endHold,
    onContextMenu: (e: React.MouseEvent) => e.preventDefault(),
    // keyboard activation arrives as a click with detail === 0
    onClick: (e: React.MouseEvent) => {
      if (e.detail === 0) fire(dir)
    },
  })

  const format = (v: number) => (formatValue ? formatValue(v) : String(v))

  return (
    <div
      className={`lg-stepper ${className ?? ''}`}
      role="group"
      aria-label={aria['aria-label']}
    >
      <button {...btnProps(-1, value <= min)} aria-label="Decrease">
        <MinusIcon size={18} />
      </button>
      {showValue && (
        <>
          <span className="lg-stepper-sep" aria-hidden="true" />
          <span className="lg-stepper-value" aria-live="polite">
            {format(value)}
          </span>
        </>
      )}
      <span className="lg-stepper-sep" aria-hidden="true" />
      <button {...btnProps(1, value >= max)} aria-label="Increase">
        <PlusIcon size={18} />
      </button>
    </div>
  )
}
