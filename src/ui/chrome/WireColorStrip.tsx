/**
 * WireColorStrip — six glass-mounted color swatches floating above the dock
 * while wire mode is armed (DESIGN.md §2 Dock/Wire). Tapping a swatch changes
 * the color of the wire being drawn (preserving an in-progress first end).
 * Every swatch has a ≥44px hit target via .lg-hit.
 */
import type { CSSProperties } from 'react'
import { useStore } from '../../state/store'
import { WIRE_COLORS } from '../wire-colors'
import { pressProps, tick } from '../kit'
import './WireColorStrip.css'

export function WireColorStrip() {
  const mode = useStore((s) => s.mode)
  if (mode.kind !== 'wire') return null

  return (
    // CLEAR-variant glass (HIG: media-rich backdrop + bold foreground —
    // the swatches): thinner material with its own dimming layer, still
    // no backdrop-filter (Tier S; the blur budget stays with dock+capsule)
    <div
      className="lg-surface lg-glass-clear app-wire-strip"
      role="radiogroup"
      aria-label="Wire color"
    >
      {WIRE_COLORS.map((c) => {
        const active = mode.color === c.name
        return (
          <button
            key={c.name}
            type="button"
            role="radio"
            aria-checked={active}
            aria-label={`${c.name} wire`}
            className={`app-swatch lg-pressable lg-hit lg-gel ${active ? 'is-active' : ''}`}
            style={{ '--swatch': c.hex } as CSSProperties}
            {...pressProps}
            onClick={() => {
              tick()
              const st = useStore.getState()
              if (st.mode.kind !== 'wire') return
              st.setMode({ kind: 'wire', from: st.mode.from, color: c.name })
            }}
          />
        )
      })}
    </div>
  )
}
