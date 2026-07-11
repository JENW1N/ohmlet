/**
 * ActionSheet — the iOS action sheet, built on Sheet with a single snap
 * sized to its content. The cards wear the CLEAR Liquid Glass variant
 * (DESIGN.md §1): permanently thinner glass whose baked dimming layer plus
 * the always-on modal scrim carry legibility — and NO backdrop-filter (two
 * cards stack over an already-filtered sheet; the desktop panel override in
 * kit.css keeps its near-opaque fill since panels present without a scrim).
 * Stacked clear action rows (57px, centered, blue), red destructive actions,
 * and a separate bold Cancel card. Selecting an action dismisses the sheet.
 * Modal like iOS: the dimmed background always intercepts, and tapping
 * anywhere outside cancels the sheet.
 *
 * Usage:
 *   <ActionSheet open={open} onDismiss={close} title="R3 · Resistor"
 *     actions={[
 *       { label: 'Properties', onSelect: openProps },
 *       { label: 'Duplicate', onSelect: duplicate },
 *       { label: 'Delete', destructive: true, onSelect: remove },
 *     ]} />
 */
import type { ReactNode } from 'react'
import { Sheet } from './Sheet'
import { readSafeAreaInsets } from './hooks'
import { tick } from './haptics'
import { pressProps } from './PressableButton'

export interface ActionSheetAction {
  label: string
  /** Optional leading icon (kit icon, ~20px). */
  icon?: ReactNode
  destructive?: boolean
  disabled?: boolean
  onSelect: () => void
}

export interface ActionSheetProps {
  open: boolean
  onDismiss: () => void
  actions: readonly ActionSheetAction[]
  /** Small grey heading above the actions. */
  title?: ReactNode
  /** Finer print under the title. */
  message?: ReactNode
  cancelLabel?: string
  /** Render as a desktop floating panel instead (passed through to Sheet). */
  desktop?: boolean
  anchor?: 'left' | 'right'
}

const ROW = 57 // px, matches .lg-asheet-btn

function clamp(v: number, lo: number, hi: number) {
  return Math.min(hi, Math.max(lo, v))
}

export function ActionSheet({
  open,
  onDismiss,
  actions,
  title,
  message,
  cancelLabel = 'Cancel',
  desktop = false,
  anchor = 'right',
}: ActionSheetProps) {
  // single snap sized to the stack (header + actions + gap + cancel + safe area)
  const vh = typeof window !== 'undefined' ? window.innerHeight : 800
  const headerPx = title != null || message != null ? 44 + (message != null ? 20 : 0) : 0
  const contentPx =
    8 + headerPx + actions.length * ROW + 8 + ROW + 16 + readSafeAreaInsets().bottom + 16
  const frac = clamp(contentPx / vh, 0.16, 0.92)

  return (
    <Sheet
      open={open}
      onDismiss={onDismiss}
      snapPoints={[frac]}
      bare
      modal
      desktop={desktop}
      anchor={anchor}
      ariaLabel={typeof title === 'string' ? title : 'Actions'}
    >
      <div className="lg-asheet">
        <div className="lg-surface lg-glass-clear lg-asheet-group">
          {(title != null || message != null) && (
            <div className="lg-asheet-header">
              {title != null && <div className="lg-asheet-title">{title}</div>}
              {message != null && <div className="lg-asheet-message">{message}</div>}
            </div>
          )}
          {actions.map((a, i) => (
            <button
              key={i}
              type="button"
              disabled={a.disabled}
              className={`lg-asheet-btn ${a.destructive ? 'is-destructive' : ''}`}
              {...pressProps}
              onClick={() => {
                tick()
                a.onSelect()
                onDismiss()
              }}
            >
              {a.icon}
              {a.label}
            </button>
          ))}
        </div>
        <div className="lg-surface lg-glass-clear lg-asheet-group">
          <button
            type="button"
            className="lg-asheet-btn is-cancel"
            {...pressProps}
            onClick={onDismiss}
          >
            {cancelLabel}
          </button>
        </div>
      </div>
    </Sheet>
  )
}
