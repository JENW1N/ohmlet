/**
 * Dock — the floating bottom glass tab bar (49px items + 11px labels). A
 * full lens-tier Liquid Glass surface (the board refracts through its rounded
 * ends) with a specular-lit mini-lens selection bubble that slides behind the
 * active item (transform only, measured from the item's offset box; its
 * glint re-bases the bar's tracked --lg-spec-* props). Selecting a tab also
 * records the tab's rect (setMorphOrigin) so the summoned sheet can condense
 * out of it. Sits above the home indicator via safe-area. With `desktop`,
 * becomes a vertical glass rail on the left.
 *
 * Icons are passed in as ReactNodes (use the kit icons at 26px).
 *
 * Usage:
 *   <Dock activeKey={tab} onSelect={setTab} desktop={isDesktop} items={[
 *     { key: 'parts', icon: <ChipIcon size={26} />, label: 'Parts' },
 *     { key: 'wire', icon: <WireIcon size={26} />, label: 'Wire' },
 *     { key: 'ai', icon: <SparklesIcon size={26} />, label: 'AI' },
 *   ]} />
 */
import { useEffect, useLayoutEffect, useRef, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { tick } from './haptics'
import { attachSpecular, attachToneAdapt, bloomAt, gelRelease, setMorphOrigin } from './glass'

export interface DockItem<K extends string = string> {
  key: K
  icon: ReactNode
  label: string
}

export interface DockProps<K extends string> {
  items: readonly DockItem<K>[]
  activeKey: K
  onSelect: (key: K) => void
  /** Vertical left rail instead of bottom bar. */
  desktop?: boolean
  'aria-label'?: string
  className?: string
}

export function Dock<K extends string>({
  items,
  activeKey,
  onSelect,
  desktop = false,
  className,
  ...aria
}: DockProps<K>) {
  const barRef = useRef<HTMLDivElement | null>(null)
  const bubbleRef = useRef<HTMLDivElement | null>(null)
  const firstPaintRef = useRef(true)

  useLayoutEffect(() => {
    const bar = barRef.current
    const bubble = bubbleRef.current
    if (!bar || !bubble) return
    const measure = () => {
      const active = bar.querySelector<HTMLElement>('[aria-selected="true"]')
      if (!active) {
        bubble.style.opacity = '0'
        return
      }
      bubble.style.opacity = '1'
      bubble.style.width = `${active.offsetWidth}px`
      bubble.style.height = `${active.offsetHeight}px`
      const t = `translate3d(${active.offsetLeft}px, ${active.offsetTop}px, 0)`
      // bar-local bubble offset, so the bubble's own specular glint
      // (kit.css ::after) can re-base the bar's --lg-spec-x/y into bubble
      // space; @property-registered, so it transitions WITH the slide
      bubble.style.setProperty('--lg-dock-bub-x', `${active.offsetLeft}px`)
      bubble.style.setProperty('--lg-dock-bub-y', `${active.offsetTop}px`)
      if (firstPaintRef.current) {
        const prev = bubble.style.transition
        bubble.style.transition = 'none'
        bubble.style.transform = t
        void bubble.offsetWidth
        bubble.style.transition = prev
        firstPaintRef.current = false
      } else {
        bubble.style.transform = t
      }
    }
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(bar)
    return () => ro.disconnect()
  }, [activeKey, items.length, desktop])

  // Liquid Glass: the dock is a lens-tier surface with the shared
  // pointer-tracked specular sheen (singleton listener — DESIGN.md §1)
  // and a tone-adaptive platter — it flips light over bright scene content
  // (glass/adapt.ts writes --lg-lum + .is-tone-light)
  useEffect(() => {
    const bar = barRef.current
    if (!bar) return
    const detachSpec = attachSpecular(bar)
    const detachTone = attachToneAdapt(bar)
    return () => {
      detachSpec()
      detachTone()
    }
  }, [desktop])

  if (typeof document === 'undefined') return null

  // Portaled to <body>: the app shell (.app-root, position:fixed) is a
  // stacking context, so a dock rendered inside it could never z-stack above
  // the body-portaled sheets (it must, at low snaps — DESIGN.md §2 peek).
  return createPortal(
    <div
      ref={barRef}
      role="tablist"
      aria-label={aria['aria-label'] ?? 'Navigation'}
      aria-orientation={desktop ? 'vertical' : 'horizontal'}
      className={[
        'lg-surface',
        'lg-lens',
        'lg-lens-dock',
        'lg-dock',
        desktop ? 'is-rail' : '',
        className ?? '',
      ]
        .filter(Boolean)
        .join(' ')}
    >
      {/* light-glass tone layer (z:-1) — fades in when adapt.ts flips the
          platter light over a bright backdrop */}
      <div className="lg-tone" aria-hidden="true" />
      {/* selection bubble: a specular-lit mini-lens (rim ring via lg-rim,
          tracked glint via the inherited --lg-spec-* props) that slides on
          the house spring. Paint-only — a backdrop-filter here would be a
          4th/5th concurrent filter (DESIGN.md §1 budget). */}
      <div ref={bubbleRef} className="lg-dock-bubble lg-rim" aria-hidden="true" />
      {items.map((item) => (
        <button
          key={item.key}
          type="button"
          role="tab"
          aria-selected={item.key === activeKey}
          className="lg-dock-item lg-pressable lg-gel"
          onPointerDown={(e) => {
            e.currentTarget.dataset.pressed = 'true'
            // flare the dock's specular from the touch point (gel press)
            const bar = barRef.current
            if (bar) bloomAt(bar, e.clientX, e.clientY)
          }}
          onPointerUp={(e) => {
            if (e.currentTarget.dataset.pressed) gelRelease(e.currentTarget)
            delete e.currentTarget.dataset.pressed
          }}
          onPointerCancel={(e) => {
            delete e.currentTarget.dataset.pressed
          }}
          onPointerLeave={(e) => {
            delete e.currentTarget.dataset.pressed
          }}
          onClick={(e) => {
            tick()
            // hand this tab's rect to the sheet it summons — the sheet
            // presentation condenses out of it (glass/morph.ts handoff)
            setMorphOrigin(e.currentTarget)
            onSelect(item.key)
          }}
        >
          {item.icon}
          <span className="lg-dock-label">{item.label}</span>
        </button>
      ))}
    </div>,
    document.body,
  )
}
