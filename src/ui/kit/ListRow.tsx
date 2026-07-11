/**
 * ListRow — a 44px+ row inside a ListGroup. Slots: leading (icon), title +
 * optional subtitle, trailing (detail text or a control like <Switch/>),
 * optional disclosure chevron. With onPress it becomes a button with an
 * iOS press highlight (background fill on pointerdown, same frame).
 *
 * Usage:
 *   <ListRow leading={<GearIcon size={20} />} title="Settings" chevron
 *     onPress={openSettings} />
 *   <ListRow title="Sound" trailing={<Switch checked={s} onChange={setS}
 *     aria-label="Sound" />} />
 */
import type { ReactNode } from 'react'
import { tick } from './haptics'
import { ChevronRightIcon } from './icons'

export interface ListRowProps {
  title: ReactNode
  subtitle?: ReactNode
  /** Leading icon slot (tinted blue; red when destructive). */
  leading?: ReactNode
  /** Trailing slot: detail text or an inline control. */
  trailing?: ReactNode
  /** Show a disclosure chevron after the trailing slot. */
  chevron?: boolean
  /** Red title (Remove, Delete, Clear…). */
  destructive?: boolean
  /** Makes the row a pressable button. */
  onPress?: () => void
  disabled?: boolean
  /** Haptic tick on press (default false; reserve for destructive commits). */
  haptic?: boolean
  className?: string
}

export function ListRow({
  title,
  subtitle,
  leading,
  trailing,
  chevron = false,
  destructive = false,
  onPress,
  disabled = false,
  haptic = false,
  className,
}: ListRowProps) {
  const body = (
    <>
      {leading != null && <span className="lg-row-leading">{leading}</span>}
      <span className="lg-row-body">
        <span className="lg-row-title">{title}</span>
        {subtitle != null && <span className="lg-row-sub lg-subhead">{subtitle}</span>}
      </span>
      {(trailing != null || chevron) && (
        <span className="lg-row-trailing">
          {trailing}
          {chevron && (
            <span className="lg-row-chevron" aria-hidden="true">
              <ChevronRightIcon size={16} />
            </span>
          )}
        </span>
      )}
    </>
  )

  const cls = `lg-row ${destructive ? 'is-destructive' : ''} ${className ?? ''}`

  if (!onPress) {
    return (
      <div className={cls} role="listitem">
        {body}
      </div>
    )
  }
  return (
    <button
      type="button"
      role="listitem"
      className={cls}
      disabled={disabled}
      onPointerDown={(e) => {
        e.currentTarget.dataset.pressed = 'true'
        if (haptic) tick()
      }}
      onPointerUp={(e) => {
        delete e.currentTarget.dataset.pressed
      }}
      onPointerCancel={(e) => {
        delete e.currentTarget.dataset.pressed
      }}
      onPointerLeave={(e) => {
        delete e.currentTarget.dataset.pressed
      }}
      onClick={onPress}
    >
      {body}
    </button>
  )
}
