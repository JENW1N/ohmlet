/**
 * PartsSheet — the iOS-grade component browser (DESIGN.md §2 "Parts").
 *
 * Self-contained: renders the kit <Sheet> itself (snaps peek/half/full —
 * 0.28 / 0.55 / 0.92; desktop = floating glass panel anchored left).
 * Search filters by label/type, horizontally scrollable category chips,
 * 2-column grid of part cards with schematic-style SVG glyphs. Tapping a
 * card arms placement mode (store.setMode place) with a haptic and drops
 * the sheet to the peek snap so the canvas is free for placing while the
 * sheet stays reachable. The armed card shows a blue "Placing" state while
 * its type is the active placement mode. Placement hint text is the shell's
 * job (toasts) — not duplicated here.
 *
 * Usage:
 *   <PartsSheet open={partsOpen} onDismiss={() => setPartsOpen(false)}
 *     desktop={isDesktop} />
 */
import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { Sheet, pressProps, tick, CloseIcon } from '../kit'
import { useStore } from '../../state/store'
import { CATALOG, type CatalogEntry, type ComponentCategory } from '../../model/catalog'
import './PartsSheet.css'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** peek (place-on-canvas) / half (browse) / full (search + scroll) */
const SNAPS = [0.28, 0.55, 0.92] as const
const HALF = 1
const PEEK = 0
const FULL = 2

const CATEGORY_ORDER: ComponentCategory[] = [
  'passive',
  'semiconductor',
  'switch',
  'display',
  'ic',
  'power',
  'instrument',
]

const CATEGORY_LABELS: Record<ComponentCategory, string> = {
  passive: 'Passives',
  semiconductor: 'Semis',
  switch: 'Switches',
  display: 'Displays',
  ic: 'ICs',
  power: 'Power',
  instrument: 'Instruments',
}

function placementMeta(entry: CatalogEntry): string {
  switch (entry.placement) {
    case 'leads':
      return `${entry.pins.length} leads`
    case 'dip':
      return `DIP-${entry.pins.length}`
    case 'footprint':
      return `${entry.pins.length}-pin`
    case 'offboard':
      return 'off-board'
    case 'probe':
      return 'probe'
  }
}

// ---------------------------------------------------------------------------
// Schematic glyphs — 48x28 grid, stroke = currentColor (tinted per category)
// ---------------------------------------------------------------------------

function G({ children }: { children: ReactNode }) {
  return (
    <svg
      width="54"
      height="31"
      viewBox="0 0 48 28"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {children}
    </svg>
  )
}

const ZIGZAG = 'M2 14h6l3-7 5 14 5-14 5 14 5-14 5 14 3-7h7'

function PartGlyph({ entry }: { entry: CatalogEntry }) {
  switch (entry.type) {
    case 'resistor':
      return (
        <G>
          <path d={ZIGZAG} />
        </G>
      )
    case 'capacitor':
      return (
        <G>
          <path d="M2 14h17M29 14h17M19 5v18M29 5v18" />
        </G>
      )
    case 'inductor':
      return (
        <G>
          <path d="M2 14h6a4 4 0 0 1 8 0 4 4 0 0 1 8 0 4 4 0 0 1 8 0 4 4 0 0 1 8 0h6" />
        </G>
      )
    case 'potentiometer':
      return (
        <G>
          <path d={ZIGZAG} />
          <path d="M14 26 33 5M28 5.6l5-.6-.6 5" strokeWidth={1.6} />
        </G>
      )
    case 'photoresistor':
      return (
        <G>
          <path d={ZIGZAG} />
          <path d="M4 2l5 4M7 6.4 9 6l-.4-2M11 1l5 4M13.8 5.4l2.2-.4-.4-2.2" strokeWidth={1.4} />
        </G>
      )
    case 'led':
      return (
        <G>
          <path d="M2 14h12M34 14h12M14 6l20 8-20 8zM34 6v16" />
          <path d="M31 8l5-5M33 3h3v3M36 13l5-5M38 8h3v3" strokeWidth={1.4} />
        </G>
      )
    case 'pushbutton':
      return (
        <G>
          <path d="M2 18h12M34 18h12M14 8h20M24 8V3" />
          <circle cx="16" cy="18" r="2" fill="currentColor" stroke="none" />
          <circle cx="32" cy="18" r="2" fill="currentColor" stroke="none" />
        </G>
      )
    case 'seven_segment':
      return (
        <G>
          <rect x="14" y="2" width="20" height="24" rx="3" />
          <path d="M20 7h8M20 14h8M20 21h8M20 7v14M28 7v14" strokeWidth={1.6} />
        </G>
      )
    case 'buzzer':
      return (
        <G>
          <path d="M12 11h5l7-6v18l-7-6h-5z" />
          <path d="M29 10a6 6 0 0 1 0 8M33.5 7a11 11 0 0 1 0 14" strokeWidth={1.6} />
        </G>
      )
    case 'function_generator':
      return (
        <G>
          <rect x="10" y="4" width="28" height="20" rx="4" />
          <path d="M15 14c2.5-7 6.5-7 9 0s6.5 7 9 0" strokeWidth={1.6} />
        </G>
      )
    default:
      break
  }
  switch (entry.category) {
    case 'semiconductor':
      // diode triangle + bar; BJTs/MOSFETs get the TO-92 half-moon
      if (entry.type === 'diode') {
        return (
          <G>
            <path d="M2 14h12M34 14h12M14 6l20 8-20 8zM34 6v16" />
          </G>
        )
      }
      return (
        <G>
          <path d="M14 18a10 10 0 0 1 20 0z" />
          <path d="M18 18v8M24 18v8M30 18v8" />
        </G>
      )
    case 'switch':
      return (
        <G>
          <path d="M2 14h10M36 14h10M16 13 32 4" />
          <circle cx="14" cy="14" r="2" fill="currentColor" stroke="none" />
          <circle cx="34" cy="14" r="2" fill="currentColor" stroke="none" />
        </G>
      )
    case 'display':
      return (
        <G>
          <rect x="14" y="2" width="20" height="24" rx="3" />
          <path d="M20 7h8M20 14h8M20 21h8M20 7v14M28 7v14" strokeWidth={1.6} />
        </G>
      )
    case 'ic':
      return (
        <G>
          <rect x="12" y="6" width="24" height="16" rx="2" />
          <path d="M16 6V2M24 6V2M32 6V2M16 22v4M24 22v4M32 22v4" />
          <path d="M21.5 6a2.5 2.5 0 0 0 5 0" strokeWidth={1.4} />
        </G>
      )
    case 'power':
      return (
        <G>
          <path d="M2 14h18M28 14h18M20 4v20M28 9v10" />
          <path d="M8 5h5M10.5 2.5v5" strokeWidth={1.4} />
        </G>
      )
    case 'instrument':
      return (
        <G>
          <circle cx="20" cy="11" r="7.5" />
          <path d="M25.5 16.5 35 26M20 11l3.5-3.5" strokeWidth={1.6} />
        </G>
      )
    case 'passive':
    default:
      return (
        <G>
          <path d={ZIGZAG} />
        </G>
      )
  }
}

// ---------------------------------------------------------------------------
// Search field — iOS search bar (magnifier, clear button, no-zoom 17px text)
// ---------------------------------------------------------------------------

function SearchField({
  value,
  onChange,
  onFocus,
}: {
  value: string
  onChange: (v: string) => void
  onFocus?: () => void
}) {
  return (
    <div className="psh-search">
      <span className="psh-search-icon" aria-hidden="true">
        <svg width="17" height="17" viewBox="0 0 17 17" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
          <circle cx="7.2" cy="7.2" r="5.2" />
          <path d="M11.2 11.2 15 15" />
        </svg>
      </span>
      <input
        className="psh-search-input"
        type="search"
        inputMode="search"
        enterKeyHint="search"
        placeholder="Search parts"
        aria-label="Search parts"
        autoComplete="off"
        autoCorrect="off"
        autoCapitalize="none"
        spellCheck={false}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onFocus={onFocus}
      />
      {value !== '' && (
        <button
          type="button"
          className="psh-search-clear lg-pressable"
          aria-label="Clear search"
          {...pressProps}
          onClick={() => onChange('')}
        >
          <CloseIcon size={13} />
        </button>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Sheet
// ---------------------------------------------------------------------------

export interface PartsSheetProps {
  open: boolean
  /** Called when the user dismisses the sheet (swipe down / scrim / Esc). */
  onDismiss: () => void
  /** Render as the desktop floating panel (anchored left) instead. */
  desktop?: boolean
}

type CatFilter = 'all' | ComponentCategory

export function PartsSheet({ open, onDismiss, desktop = false }: PartsSheetProps) {
  const mode = useStore((s) => s.mode)
  const setMode = useStore((s) => s.setMode)

  const [snap, setSnap] = useState<number>(HALF)
  const [query, setQuery] = useState('')
  const [cat, setCat] = useState<CatFilter>('all')

  // fresh presentation each time the sheet opens
  useEffect(() => {
    if (open) setSnap(HALF)
  }, [open])

  const armedType = mode.kind === 'place' ? mode.type : null

  const parts = useMemo(() => {
    const entries = Object.values(CATALOG)
    const ordered = CATEGORY_ORDER.flatMap((c) => entries.filter((e) => e.category === c))
    const q = query.trim().toLowerCase()
    return ordered.filter(
      (e) =>
        (cat === 'all' || e.category === cat) &&
        (q === '' || e.label.toLowerCase().includes(q) || e.type.toLowerCase().includes(q)),
    )
  }, [query, cat])

  const onCard = (entry: CatalogEntry) => {
    tick()
    if (armedType === entry.type) {
      // tapping the armed card cancels placement
      setMode({ kind: 'select' })
      return
    }
    setMode({ kind: 'place', type: entry.type, pickedHoles: [] })
    // drop to peek so the canvas is free to place on — NOT a full dismiss
    if (!desktop) setSnap(PEEK)
  }

  return (
    <Sheet
      open={open}
      onDismiss={onDismiss}
      snapPoints={SNAPS}
      activeSnap={snap}
      onSnapChange={setSnap}
      desktop={desktop}
      anchor="left"
      ariaLabel="Parts"
      className="psh"
    >
      <div className="psh-body">
        <div className="psh-title lg-headline">Parts</div>

        <SearchField
          value={query}
          onChange={setQuery}
          // searching needs the keyboard + room for results: spring to full
          onFocus={() => {
            if (!desktop) setSnap(FULL)
          }}
        />

        <div className="psh-chips" role="group" aria-label="Filter by category">
          <CategoryChip label="All" active={cat === 'all'} onSelect={() => setCat('all')} />
          {CATEGORY_ORDER.map((c) => (
            <CategoryChip
              key={c}
              label={CATEGORY_LABELS[c]}
              active={cat === c}
              onSelect={() => setCat(c)}
            />
          ))}
        </div>

        {parts.length === 0 ? (
          <div className="psh-empty lg-caption">No parts match “{query.trim()}”</div>
        ) : (
          <div className="psh-grid">
            {parts.map((entry) => {
              const armed = armedType === entry.type
              return (
                <button
                  key={entry.type}
                  type="button"
                  className={
                    // nested glass card (rim + slab via lg-card) with the gel
                    // press: the specular blooms from the touch point
                    `psh-card lg-card lg-pressable lg-specular lg-gel cat-${entry.category}`
                  }
                  aria-pressed={armed}
                  aria-label={`${entry.label}, ${placementMeta(entry)}${armed ? ', placing' : ''}`}
                  {...pressProps}
                  onClick={() => onCard(entry)}
                >
                  <span className="psh-card-glyph" aria-hidden="true">
                    <PartGlyph entry={entry} />
                  </span>
                  <span className="psh-card-label">{entry.label}</span>
                  <span className="psh-card-meta lg-tabular">{placementMeta(entry)}</span>
                  {armed && <span className="psh-card-armed">Placing</span>}
                </button>
              )
            })}
          </div>
        )}
      </div>
    </Sheet>
  )
}

function CategoryChip({
  label,
  active,
  onSelect,
}: {
  label: string
  active: boolean
  onSelect: () => void
}) {
  return (
    <button
      type="button"
      className="psh-chip lg-gel"
      aria-pressed={active}
      {...pressProps}
      onClick={() => {
        if (!active) {
          tick()
          onSelect()
        }
      }}
    >
      {label}
    </button>
  )
}
