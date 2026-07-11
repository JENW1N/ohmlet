/**
 * Switch — the 51x31 iOS toggle. Green when on; 27px white knob slides with
 * the house spring; knob fattens slightly while pressed (like iOS). Controlled
 * and label-free: put it in a ListRow's trailing slot and let the row label it.
 *
 * Accessible: role="switch" button, Space/Enter toggles, aria-checked.
 *
 * Usage:
 *   <Switch checked={on} onChange={setOn} aria-label="Power" />
 */
import { tick } from './haptics'

export interface SwitchProps {
  checked: boolean
  onChange: (next: boolean) => void
  disabled?: boolean
  /** Haptic tick on toggle (default true — switches feel mechanical). */
  haptic?: boolean
  'aria-label'?: string
  /** id of the element labelling this switch (e.g. the ListRow title). */
  'aria-labelledby'?: string
}

export function Switch({
  checked,
  onChange,
  disabled = false,
  haptic = true,
  ...aria
}: SwitchProps) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={aria['aria-label']}
      aria-labelledby={aria['aria-labelledby']}
      disabled={disabled}
      className="lg-switch lg-hit"
      onPointerDown={(e) => {
        e.currentTarget.dataset.pressed = 'true'
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
      onClick={() => {
        if (haptic) tick()
        onChange(!checked)
      }}
    >
      <span className="lg-switch-fill" aria-hidden="true" />
      <span className="lg-switch-knob" aria-hidden="true" />
    </button>
  )
}
