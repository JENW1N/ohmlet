/**
 * PropertiesSheet — iOS-grade component/wire inspector (DESIGN.md §2/§3).
 *
 * Self-contained: renders the kit <Sheet> itself (snaps half 0.55 / full
 * 0.92; desktop = floating glass panel anchored right). Ports the old
 * PropertiesPanel semantics onto kit controls:
 *
 *   ParamDef editors    — Switch (booleans), Segmented (selects ≤4 options,
 *                         + scope channel), dropdown row (larger selects),
 *                         SliderIOS (fully-ranged numbers), Stepper + numeric
 *                         field (precise numbers), E12 chip-scroller for the
 *                         resistor, giant circular HOLD button (pushbutton,
 *                         pointer capture + haptics), 8-switch bank for the
 *                         DIP switch. Runtime params carry a green LIVE badge
 *                         and flow through store.setParam mid-sim.
 *   Pins                — pin → hole table with live voltages.
 *   Live                — telemetry readouts (current/power/brightness/…)
 *                         and the burned-LED banner.
 *   Remove              — red destructive row, confirmed via ActionSheet.
 *   Multi-select        — 2+ selected ids render the group view instead:
 *                         count header + one destructive group-delete row.
 *
 * Usage:
 *   <PropertiesSheet open={selection != null} onDismiss={() => select(null)}
 *     desktop={isDesktop} />
 */
import {
  useEffect,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from 'react'
import {
  ActionSheet,
  ListGroup,
  ListRow,
  Segmented,
  Sheet,
  SliderIOS,
  Stepper,
  Switch,
  TrashIcon,
  pressProps,
  tick,
} from '../kit'
import { useStore } from '../../state/store'
import { getEntry, paramOf, type CatalogEntry, type ParamDef } from '../../model/catalog'
import { componentPinHoles, formatHole } from '../../model/breadboard'
import { boardConfigOf } from '../../model/types'
import type { ComponentInstance, ComponentTelemetry, Wire } from '../../model/types'
import { clamp, fmtEng, fmtVolts, toNumber } from '../format'
import { wireColorHex } from '../wire-colors'
import './PropertiesSheet.css'

// ---------------------------------------------------------------------------
// Sheet root
// ---------------------------------------------------------------------------

/** half (auto-present) / full (scroll + edit everything) */
const SNAPS = [0.55, 0.92] as const

/**
 * Contract bridge — the concurrent store work widens `AppState.selection`
 * to a multi-select. Normalize either shape (id | id[] | null) to a list so
 * this sheet renders correctly before and after the contract lands.
 */
function selectionList(sel: unknown): readonly string[] {
  if (Array.isArray(sel)) return sel.filter((x): x is string => typeof x === 'string')
  return typeof sel === 'string' ? [sel] : []
}

export interface PropertiesSheetProps {
  open: boolean
  /** Called when the user dismisses the sheet (swipe down / scrim / Esc). */
  onDismiss: () => void
  /** Render as the desktop floating panel (anchored right) instead. */
  desktop?: boolean
}

export function PropertiesSheet({ open, onDismiss, desktop = false }: PropertiesSheetProps) {
  const selection = useStore((s) => s.selection)
  const components = useStore((s) => s.layout.components)
  const wires = useStore((s) => s.layout.wires)

  const [snap, setSnap] = useState(0)
  useEffect(() => {
    if (open) setSnap(0) // re-present at half each time
  }, [open])

  // group view for a 2+ multi-select; the single-selection editors below
  // are unchanged
  const selected = selectionList(selection)
  const single = selected.length === 1 ? selected[0] : null
  const comp = single ? components.find((c) => c.id === single) : undefined
  const wire = !comp && single ? wires.find((w) => w.id === single) : undefined

  return (
    <Sheet
      open={open}
      onDismiss={onDismiss}
      snapPoints={SNAPS}
      activeSnap={snap}
      onSnapChange={setSnap}
      desktop={desktop}
      anchor="right"
      ariaLabel="Properties"
      className="prs"
    >
      <div className="prs-body">
        {selected.length > 1 ? (
          <MultiEditor
            ids={selected}
            components={components}
            wires={wires}
            desktop={desktop}
            onDone={onDismiss}
          />
        ) : comp ? (
          <ComponentEditor comp={comp} desktop={desktop} onDone={onDismiss} />
        ) : wire ? (
          <WireEditor wire={wire} desktop={desktop} onDone={onDismiss} />
        ) : (
          <EmptyEditor />
        )}
      </div>
    </Sheet>
  )
}

// ---------------------------------------------------------------------------
// Shared bits
// ---------------------------------------------------------------------------

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

function LiveBadge() {
  return (
    <span className="prs-live" title="Adjustable while the simulation runs">
      live
    </span>
  )
}

function Label({ def }: { def: ParamDef }) {
  return (
    <span className="prs-label-wrap">
      {def.label}
      {def.runtime && <LiveBadge />}
    </span>
  )
}

/** Big title header: component label + monospace id + type subtitle. */
function SheetHeader({
  title,
  id,
  subtitle,
  trailing,
}: {
  title: string
  id: string
  subtitle: string
  trailing?: ReactNode
}) {
  return (
    <header className="prs-head">
      <div className="prs-head-main">
        <span className="prs-head-title lg-title">{title}</span>
        <span className="prs-head-id">{id}</span>
        {trailing != null && <span className="prs-head-trailing">{trailing}</span>}
      </div>
      <div className="prs-head-sub lg-caption">{subtitle}</div>
    </header>
  )
}

/**
 * Stacked parameter row inside a ListGroup: label line (with optional
 * right-aligned value readout) + a full-width control line. Reuses the
 * kit's .lg-row class so the inset hairline separators come for free.
 */
function StackRow({
  def,
  value,
  children,
}: {
  def: ParamDef
  value?: ReactNode
  children: ReactNode
}) {
  return (
    <div className="lg-row prs-stack" role="listitem">
      <div className="prs-stack-top">
        <Label def={def} />
        {value != null && <span className="prs-stack-value lg-tabular">{value}</span>}
      </div>
      <div className="prs-stack-ctl">{children}</div>
    </div>
  )
}

/** Stops the Sheet from hijacking drags aimed at capturing controls
 *  (slider knob, stepper hold-repeat, HOLD button). */
const stopSheetDrag = {
  onPointerDown: (e: ReactPointerEvent<HTMLElement>) => e.stopPropagation(),
}

// ---------------------------------------------------------------------------
// Empty state
// ---------------------------------------------------------------------------

function EmptyEditor() {
  return (
    <div className="prs-empty">
      <div className="lg-headline">Nothing selected</div>
      <p className="lg-caption">Tap a component or wire on the board to edit it here.</p>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Component editor
// ---------------------------------------------------------------------------

function ComponentEditor({
  comp,
  desktop,
  onDone,
}: {
  comp: ComponentInstance
  desktop: boolean
  onDone: () => void
}) {
  const telemetry = useStore((s) => s.telemetry)
  const entry = getEntry(comp.type)

  if (!entry) {
    return (
      <>
        <SheetHeader title="Unknown component" id={comp.id} subtitle={comp.type} />
        <ListGroup footer="This type is not in the catalog — it cannot be edited.">
          <ListRow title="Type" trailing={<span className="prs-mono">{comp.type}</span>} />
        </ListGroup>
        <RemoveGroup
          label={`Remove ${comp.id}`}
          confirmTitle={comp.id}
          desktop={desktop}
          onDone={onDone}
        />
      </>
    )
  }

  const tele = telemetry?.components[comp.id]
  const isPushbutton = comp.type === 'pushbutton'
  const isDip = comp.type === 'dip_switch_8'
  const generalParams = (entry.params ?? []).filter(
    (p) => !(isPushbutton && p.key === 'pressed') && !(isDip && p.key === 'on'),
  )

  return (
    <>
      <SheetHeader
        title={entry.label}
        id={comp.id}
        subtitle={`${comp.type} · ${placementMeta(entry)}`}
      />

      {isPushbutton && <HoldGroup comp={comp} />}
      {isDip && <DipSwitchGroup comp={comp} entry={entry} />}

      {generalParams.length > 0 && (
        <ListGroup header="Parameters">
          {generalParams.map((def) => (
            <ParamControl key={def.key} comp={comp} entry={entry} def={def} />
          ))}
        </ListGroup>
      )}

      <PinsGroup comp={comp} entry={entry} tele={tele} />
      {tele && <LiveGroup tele={tele} />}

      <RemoveGroup
        label={`Remove ${comp.id}`}
        confirmTitle={`${comp.id} · ${entry.label}`}
        desktop={desktop}
        onDone={onDone}
      />
    </>
  )
}

// ---------------------------------------------------------------------------
// Multi-select group view: count header + one destructive group-delete row
// (the single-selection editors above/below are untouched)
// ---------------------------------------------------------------------------

function MultiEditor({
  ids,
  components,
  wires,
  desktop,
  onDone,
}: {
  ids: readonly string[]
  components: readonly ComponentInstance[]
  wires: readonly Wire[]
  desktop: boolean
  onDone: () => void
}) {
  const nComp = ids.reduce((n, id) => (components.some((c) => c.id === id) ? n + 1 : n), 0)
  const nWire = ids.reduce((n, id) => (wires.some((w) => w.id === id) ? n + 1 : n), 0)
  const kinds: string[] = []
  if (nComp > 0) kinds.push(`${nComp} ${nComp === 1 ? 'component' : 'components'}`)
  if (nWire > 0) kinds.push(`${nWire} ${nWire === 1 ? 'wire' : 'wires'}`)
  const idLine =
    ids.length > 5 ? `${ids.slice(0, 5).join(' · ')} +${ids.length - 5}` : ids.join(' · ')
  return (
    <>
      <SheetHeader
        title={`${ids.length} selected`}
        id={idLine}
        subtitle={kinds.join(' · ') || 'group selection'}
      />
      <RemoveGroup
        label={`Delete ${ids.length} parts`}
        confirmTitle={`${ids.length} selected`}
        message="Removes every selected part and disconnects them from the circuit."
        desktop={desktop}
        onDone={onDone}
      />
    </>
  )
}

// ---------------------------------------------------------------------------
// Param dispatch
// ---------------------------------------------------------------------------

interface ParamRowProps {
  comp: ComponentInstance
  entry: CatalogEntry
  def: ParamDef
}

function ParamControl({ comp, entry, def }: ParamRowProps) {
  if (comp.type === 'resistor' && def.key === 'resistance') {
    return <ResistanceRow comp={comp} entry={entry} def={def} />
  }
  if (comp.type === 'scope_probe' && def.key === 'channel') {
    return <ChannelRow comp={comp} entry={entry} def={def} />
  }
  switch (def.kind) {
    case 'boolean':
      return <BooleanRow comp={comp} entry={entry} def={def} />
    case 'select': {
      const options = def.options ?? []
      return options.length <= 4 ? (
        <SegmentedRow comp={comp} entry={entry} def={def} />
      ) : (
        <DropdownRow comp={comp} entry={entry} def={def} />
      )
    }
    case 'text':
      return <TextRow comp={comp} entry={entry} def={def} />
    case 'number': {
      const ranged = def.min !== undefined && def.max !== undefined && def.step !== undefined
      return ranged ? (
        <SliderRow comp={comp} entry={entry} def={def} />
      ) : (
        <PreciseNumberRow comp={comp} entry={entry} def={def} />
      )
    }
  }
}

// ---------------------------------------------------------------------------
// Generic editors
// ---------------------------------------------------------------------------

function BooleanRow({ comp, entry, def }: ParamRowProps) {
  const setParam = useStore((s) => s.setParam)
  const value = paramOf(comp.params, entry, def.key) === true
  return (
    <ListRow
      title={<Label def={def} />}
      trailing={
        <Switch
          checked={value}
          onChange={(next) => setParam(comp.id, def.key, next)}
          aria-label={def.label}
        />
      }
    />
  )
}

function SegmentedRow({ comp, entry, def }: ParamRowProps) {
  const setParam = useStore((s) => s.setParam)
  const value = String(paramOf(comp.params, entry, def.key) ?? def.default)
  const options = (def.options ?? []).map((o) => ({ value: o, label: o }))
  return (
    <StackRow def={def}>
      <Segmented
        options={options}
        value={value}
        onChange={(v) => setParam(comp.id, def.key, v)}
        aria-label={def.label}
      />
    </StackRow>
  )
}

/** Scope probe channel 1–4 as a segmented control (number-valued). */
function ChannelRow({ comp, entry, def }: ParamRowProps) {
  const setParam = useStore((s) => s.setParam)
  const value = String(toNumber(paramOf(comp.params, entry, def.key), 1))
  const options = ['1', '2', '3', '4'].map((v) => ({ value: v, label: `CH ${v}` }))
  return (
    <StackRow def={def}>
      <Segmented
        options={options}
        value={value}
        onChange={(v) => setParam(comp.id, def.key, Number(v))}
        aria-label={def.label}
      />
    </StackRow>
  )
}

/** Selects with >4 options: an iOS detail row driving the native picker. */
function DropdownRow({ comp, entry, def }: ParamRowProps) {
  const setParam = useStore((s) => s.setParam)
  const value = String(paramOf(comp.params, entry, def.key) ?? def.default)
  return (
    <div className="lg-row prs-selectrow" role="listitem">
      <Label def={def} />
      <span className="prs-select-value" aria-hidden="true">
        {comp.type === 'led' && def.key === 'color' && (
          <span className="prs-swatch" style={{ background: wireColorHex(value) }} />
        )}
        {value}
        <svg
          width="13"
          height="13"
          viewBox="0 0 13 13"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.7"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M3.5 5 6.5 2l3 3M3.5 8l3 3 3-3" />
        </svg>
      </span>
      <select
        className="prs-select-cover"
        value={value}
        aria-label={def.label}
        onChange={(e) => {
          tick()
          setParam(comp.id, def.key, e.target.value)
        }}
      >
        {(def.options ?? []).map((o) => (
          <option key={o} value={o}>
            {o}
          </option>
        ))}
      </select>
    </div>
  )
}

function TextRow({ comp, entry, def }: ParamRowProps) {
  const setParam = useStore((s) => s.setParam)
  const value = String(paramOf(comp.params, entry, def.key) ?? def.default)
  return (
    <StackRow def={def}>
      <input
        className="prs-input prs-input-text prs-mono"
        type="text"
        value={value}
        spellCheck={false}
        autoComplete="off"
        autoCapitalize="none"
        aria-label={def.label}
        onChange={(e) => setParam(comp.id, def.key, e.target.value)}
      />
    </StackRow>
  )
}

/** Fully-ranged numbers (min+max+step): the iOS slider with value bubble. */
function SliderRow({ comp, entry, def }: ParamRowProps) {
  const setParam = useStore((s) => s.setParam)
  const value = toNumber(paramOf(comp.params, entry, def.key), toNumber(def.default, 0))
  const min = def.min ?? 0
  const max = def.max ?? 1
  const fmt = (v: number) => {
    if (min === 0 && max === 1) return `${Math.round(v * 100)}%`
    const s = parseFloat(v.toFixed(3))
    return def.unit ? `${s} ${def.unit}` : String(s)
  }
  return (
    <StackRow def={def} value={fmt(value)}>
      <div className="prs-nodrag" {...stopSheetDrag}>
        <SliderIOS
          value={clamp(value, min, max)}
          min={min}
          max={max}
          step={def.step}
          onChange={(v) => setParam(comp.id, def.key, v)}
          formatValue={fmt}
          aria-label={def.label}
        />
      </div>
    </StackRow>
  )
}

/** Number input that keeps the user's text while typing, commits live. */
function NumberField({
  value,
  onCommit,
  step,
  ariaLabel,
}: {
  value: number
  onCommit: (n: number) => void
  step?: number
  ariaLabel?: string
}) {
  const [text, setText] = useState(String(value))
  const [focused, setFocused] = useState(false)

  useEffect(() => {
    if (!focused) setText(String(value))
  }, [value, focused])

  return (
    <input
      className="prs-input prs-mono"
      type="number"
      inputMode="decimal"
      step={step ?? 'any'}
      value={text}
      aria-label={ariaLabel}
      onFocus={() => setFocused(true)}
      onBlur={() => setFocused(false)}
      onChange={(e) => {
        setText(e.target.value)
        const n = Number(e.target.value)
        if (e.target.value.trim() !== '' && Number.isFinite(n)) onCommit(n)
      }}
      onKeyDown={(e: ReactKeyboardEvent<HTMLInputElement>) => {
        if (e.key === 'Enter') e.currentTarget.blur()
      }}
    />
  )
}

/** A decade-aware increment so the stepper is useful at any magnitude
 *  (1000 Ω steps by 100; 10 µF steps by 1 µF; 1 Hz steps by 0.1). */
function decadeStep(value: number): number {
  const mag = Math.abs(value)
  if (!Number.isFinite(mag) || mag === 0) return 1
  return Math.pow(10, Math.floor(Math.log10(mag)) - 1)
}

/** Precise numbers (open-ended ranges): numeric field + unit + stepper. */
function PreciseNumberRow({
  comp,
  entry,
  def,
  children,
}: ParamRowProps & { children?: ReactNode }) {
  const setParam = useStore((s) => s.setParam)
  const value = toNumber(paramOf(comp.params, entry, def.key), toNumber(def.default, 0))
  const commit = (n: number) => setParam(comp.id, def.key, clamp(n, def.min, def.max))
  return (
    <StackRow def={def} value={def.unit ? fmtEng(value, def.unit) : undefined}>
      <div className="prs-numline">
        <NumberField value={value} onCommit={commit} step={def.step} ariaLabel={def.label} />
        {def.unit && <span className="prs-unit lg-caption">{def.unit}</span>}
        <span className="prs-nodrag prs-numline-stepper" {...stopSheetDrag}>
          <Stepper
            value={value}
            onChange={commit}
            min={def.min ?? -Infinity}
            max={def.max ?? Infinity}
            step={def.step ?? decadeStep(value)}
            aria-label={def.label}
          />
        </span>
      </div>
      {children}
    </StackRow>
  )
}

// ---------------------------------------------------------------------------
// Special editors
// ---------------------------------------------------------------------------

const E12_QUICK = [
  100, 220, 330, 470, 680, 1000, 2200, 3300, 4700, 10000, 22000, 47000, 100000, 220000, 470000,
  1000000,
]

/** Resistor: precise number row + the E12 horizontal chip-scroller. */
function ResistanceRow({ comp, entry, def }: ParamRowProps) {
  const setParam = useStore((s) => s.setParam)
  const value = toNumber(paramOf(comp.params, entry, def.key), 1000)
  const commit = (n: number) => setParam(comp.id, def.key, clamp(n, def.min, def.max))
  return (
    <PreciseNumberRow comp={comp} entry={entry} def={def}>
      <div className="prs-chips" role="group" aria-label="E12 quick picks">
        {E12_QUICK.map((v) => (
          <button
            key={v}
            type="button"
            className="prs-chip lg-gel lg-tabular"
            aria-pressed={value === v}
            {...pressProps}
            onClick={() => {
              tick()
              commit(v)
            }}
          >
            {fmtEng(v, 'Ω')}
          </button>
        ))}
      </div>
    </PreciseNumberRow>
  )
}

/** Pushbutton: the giant circular HOLD button (pointer capture + haptics). */
function HoldGroup({ comp }: { comp: ComponentInstance }) {
  const setParam = useStore((s) => s.setParam)
  const pressed = comp.params?.pressed === true
  const press = (down: boolean) => setParam(comp.id, 'pressed', down)

  return (
    <ListGroup
      header={
        <>
          Button
          <LiveBadge />
        </>
      }
      footer="The contacts stay closed while you hold the button."
    >
      <div className="lg-row prs-holdrow" role="listitem">
        <button
          type="button"
          className={`prs-hold lg-card ${pressed ? 'is-down' : ''}`}
          aria-pressed={pressed}
          aria-label="Press and hold the pushbutton"
          onPointerDown={(e) => {
            e.stopPropagation() // the sheet must not steal this gesture
            e.currentTarget.setPointerCapture(e.pointerId)
            tick()
            press(true)
          }}
          onPointerUp={() => {
            tick()
            press(false)
          }}
          onPointerCancel={() => press(false)}
          onKeyDown={(e) => {
            if ((e.key === ' ' || e.key === 'Enter') && !e.repeat) {
              e.preventDefault()
              tick()
              press(true)
            }
          }}
          onKeyUp={(e) => {
            if (e.key === ' ' || e.key === 'Enter') {
              tick()
              press(false)
            }
          }}
          onContextMenu={(e) => e.preventDefault()}
        >
          {pressed ? 'PRESSED' : 'HOLD'}
        </button>
      </div>
    </ListGroup>
  )
}

/** DIP switch ×8: a bank of eight iOS switches. */
function DipSwitchGroup({ comp, entry }: { comp: ComponentInstance; entry: CatalogEntry }) {
  const setParam = useStore((s) => s.setParam)
  const raw = String(paramOf(comp.params, entry, 'on') ?? '00000000')
  const bits = (raw + '00000000').slice(0, 8)
  const flip = (i: number) => {
    let next = ''
    for (let j = 0; j < 8; j++) {
      const on = bits[j] === '1'
      next += (j === i ? !on : on) ? '1' : '0'
    }
    setParam(comp.id, 'on', next)
  }
  return (
    <ListGroup
      header={
        <>
          Switches
          <LiveBadge />
        </>
      }
      footer="Switch n connects pin nA to pin nB while on."
    >
      {Array.from({ length: 8 }, (_, i) => (
        <ListRow
          key={i}
          title={`Switch ${i + 1}`}
          trailing={
            <Switch
              checked={bits[i] === '1'}
              onChange={() => flip(i)}
              aria-label={`Switch ${i + 1}`}
            />
          }
        />
      ))}
    </ListGroup>
  )
}

// ---------------------------------------------------------------------------
// Pins + telemetry
// ---------------------------------------------------------------------------

function PinsGroup({
  comp,
  entry,
  tele,
}: {
  comp: ComponentInstance
  entry: CatalogEntry
  tele: ComponentTelemetry | undefined
}) {
  // board-aware: far-column Lab XL / module-2+ parts must still resolve
  const board = useStore((s) => s.layout.board)
  const boardCount = useStore((s) => s.layout.boardCount)
  const holes = componentPinHoles(comp, entry, boardConfigOf({ board, boardCount }))
  const showNum = entry.placement === 'dip' || entry.placement === 'footprint'
  const incomplete = holes === null && entry.placement !== 'offboard'
  return (
    <ListGroup
      header="Pins"
      footer={incomplete ? 'Placement is incomplete or invalid for this part.' : undefined}
    >
      {entry.pins.map((pin, i) => {
        const hole = holes?.[i] ?? null
        const where =
          entry.placement === 'offboard' ? `${comp.id}:${pin}` : hole ? formatHole(hole) : '—'
        const v = tele?.pinVoltages?.[pin]
        return (
          <div key={pin} className="prs-pin" role="listitem">
            {showNum && <span className="prs-pin-num lg-tabular">{i + 1}</span>}
            <span className="prs-pin-name prs-mono">{pin}</span>
            <span className="prs-pin-hole prs-mono">{where}</span>
            <span className="prs-pin-v lg-tabular">{v !== undefined ? fmtVolts(v) : ''}</span>
          </div>
        )
      })}
    </ListGroup>
  )
}

function LiveGroup({ tele }: { tele: ComponentTelemetry }) {
  const rows: [string, string][] = []
  if (tele.current !== undefined) rows.push(['Current', fmtEng(tele.current, 'A')])
  if (tele.power !== undefined) rows.push(['Power', fmtEng(tele.power, 'W')])
  if (tele.ledBrightness !== undefined)
    rows.push(['Brightness', `${Math.round(Math.max(0, Math.min(1, tele.ledBrightness)) * 100)}%`])
  if (tele.sounding !== undefined) rows.push(['Sounding', tele.sounding ? 'Yes' : 'No'])
  if (rows.length === 0 && !tele.burned) return null
  return (
    <>
      {tele.burned && (
        <div className="prs-burned" role="alert">
          Burned out — replace this LED and add a series resistor.
        </div>
      )}
      {rows.length > 0 && (
        <ListGroup header="Live">
          {rows.map(([k, v]) => (
            <ListRow key={k} title={k} trailing={<span className="prs-mono lg-tabular">{v}</span>} />
          ))}
        </ListGroup>
      )}
    </>
  )
}

// ---------------------------------------------------------------------------
// Remove (confirmed via ActionSheet)
// ---------------------------------------------------------------------------

function RemoveGroup({
  label,
  confirmTitle,
  message = 'This also disconnects it from the circuit.',
  desktop,
  onDone,
}: {
  label: string
  confirmTitle: string
  /** ActionSheet fine print (defaults to the single-part copy). */
  message?: string
  desktop: boolean
  onDone: () => void
}) {
  const removeSelected = useStore((s) => s.removeSelected)
  const [confirm, setConfirm] = useState(false)
  return (
    <>
      <ListGroup>
        <ListRow
          destructive
          leading={<TrashIcon size={20} />}
          title={label}
          onPress={() => setConfirm(true)}
        />
      </ListGroup>
      <ActionSheet
        open={confirm}
        onDismiss={() => setConfirm(false)}
        title={confirmTitle}
        message={message}
        desktop={desktop}
        anchor="right"
        actions={[
          {
            label,
            destructive: true,
            onSelect: () => {
              removeSelected()
              tick(16)
              onDone()
            },
          },
        ]}
      />
    </>
  )
}

// ---------------------------------------------------------------------------
// Wire editor
// ---------------------------------------------------------------------------

function WireEditor({
  wire,
  desktop,
  onDone,
}: {
  wire: Wire
  desktop: boolean
  onDone: () => void
}) {
  return (
    <>
      <SheetHeader
        title="Wire"
        id={wire.id}
        subtitle={wire.color ?? 'default color'}
        trailing={
          <span
            className="prs-swatch prs-swatch-lg"
            style={{ background: wireColorHex(wire.color) }}
            title={wire.color ?? 'default'}
          />
        }
      />
      <ListGroup header="Endpoints">
        <ListRow title="From" trailing={<span className="prs-mono">{wire.from}</span>} />
        <ListRow title="To" trailing={<span className="prs-mono">{wire.to}</span>} />
      </ListGroup>
      <RemoveGroup
        label="Remove wire"
        confirmTitle={`${wire.id} · Wire`}
        desktop={desktop}
        onDone={onDone}
      />
    </>
  )
}
