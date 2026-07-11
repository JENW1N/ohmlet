/**
 * PressableButton — the kit's pill button.
 *
 * Variants: filled (blue, primary), tinted (blue wash), plain (text only),
 * destructive (red wash). Sizes sm/md/lg (md = 44px, the default). Press
 * feedback lands on pointerdown — within one frame — via a direct
 * data-pressed DOM write (no React state round-trip).
 *
 * Usage:
 *   <PressableButton variant="filled" icon={<SparklesIcon size={18} />}
 *     haptic onClick={generate}>Generate</PressableButton>
 */
import {
  forwardRef,
  type ButtonHTMLAttributes,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from 'react'
import { tick } from './haptics'
import { bloomAt, gelRelease } from './glass'

/**
 * Reusable pointer handlers that flip `data-pressed` on the element itself
 * (styled by .lg-pressable and friends). Spread onto any interactive element:
 *   <button {...pressProps} className="lg-pressable" />
 *
 * Elements carrying the `lg-gel` class additionally get the Liquid Glass
 * gel response: the specular blooms from the touch point on press and the
 * release springs back with a 1.015 overshoot (glass/gel.ts).
 */
export const pressProps = {
  onPointerDown: (e: ReactPointerEvent<HTMLElement>) => {
    const el = e.currentTarget
    el.dataset.pressed = 'true'
    if (el.classList.contains('lg-gel')) bloomAt(el, e.clientX, e.clientY)
  },
  onPointerUp: (e: ReactPointerEvent<HTMLElement>) => {
    const el = e.currentTarget
    if (el.dataset.pressed && el.classList.contains('lg-gel')) gelRelease(el)
    delete el.dataset.pressed
  },
  onPointerCancel: (e: ReactPointerEvent<HTMLElement>) => {
    delete e.currentTarget.dataset.pressed
  },
  onPointerLeave: (e: ReactPointerEvent<HTMLElement>) => {
    delete e.currentTarget.dataset.pressed
  },
} as const

export interface PressableButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'filled' | 'tinted' | 'plain' | 'destructive'
  size?: 'sm' | 'md' | 'lg'
  /** Leading icon slot (a kit icon, sized by the caller). */
  icon?: ReactNode
  /** Fire a haptic tick on pointerdown. */
  haptic?: boolean
}

export const PressableButton = forwardRef<HTMLButtonElement, PressableButtonProps>(
  function PressableButton(
    { variant = 'tinted', size = 'md', icon, haptic = false, className, children, ...rest },
    ref,
  ) {
    return (
      <button
        ref={ref}
        type="button"
        {...rest}
        className={[
          'lg-btn',
          `lg-btn-${variant}`,
          `lg-btn-${size}`,
          'lg-pressable',
          // gel press (specular bloom + springy release) for md/lg; sm keeps
          // its ::after for the 44px hit expansion instead of the bloom layer
          // but still gets the springy gel release (lg-gel without the layer)
          size === 'sm' ? 'lg-hit lg-gel' : 'lg-specular lg-gel',
          className ?? '',
        ]
          .filter(Boolean)
          .join(' ')}
        onPointerDown={(e) => {
          const el = e.currentTarget
          el.dataset.pressed = 'true'
          if (el.classList.contains('lg-gel')) bloomAt(el, e.clientX, e.clientY)
          if (haptic) tick()
          rest.onPointerDown?.(e)
        }}
        onPointerUp={(e) => {
          const el = e.currentTarget
          if (el.dataset.pressed && el.classList.contains('lg-gel')) gelRelease(el)
          delete el.dataset.pressed
          rest.onPointerUp?.(e)
        }}
        onPointerCancel={(e) => {
          delete e.currentTarget.dataset.pressed
          rest.onPointerCancel?.(e)
        }}
        onPointerLeave={(e) => {
          delete e.currentTarget.dataset.pressed
          rest.onPointerLeave?.(e)
        }}
      >
        {icon}
        {children}
      </button>
    )
  },
)
