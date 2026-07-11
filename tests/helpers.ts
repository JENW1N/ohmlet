/**
 * Shared test builders + measurement helpers. Owned by the tests agent.
 *
 * These helpers are written strictly against the CONTRACT files
 * (src/model/types.ts, src/model/breadboard.ts, src/model/catalog.ts) and the
 * SimEngine public API documented in ARCHITECTURE.md. They never re-derive
 * hole math — everything goes through the breadboard.ts helpers.
 */
import type {
  CircuitLayout,
  ComponentInstance,
  Wire,
  Hole,
  HoleRef,
  ParamValue,
  SimIssue,
  SimTelemetry,
  StripRow,
} from '../src/model/types'
import { parseHole, formatHole, dipHoles, componentPinHoles } from '../src/model/breadboard'
import { CATALOG, type CatalogEntry } from '../src/model/catalog'

/** Structural view of the SimEngine contract (ARCHITECTURE.md, "Engine"). */
export interface EngineLike {
  readonly issues: SimIssue[]
  time: number
  step(dt?: number): void
  advance(seconds: number, dt?: number): void
  telemetry(): SimTelemetry
  setRuntimeParam(componentId: string, key: string, value: ParamValue): void
  netVoltage(ref: string): number
}

/** Logic-level thresholds used across the chip tests (5V supply). */
export const LOGIC_HI = 3.5
export const LOGIC_LO = 1.5

// --------------------------------------------------------------- builders

let wireSeq = 0

export function wire(from: string, to: string, color?: string): Wire {
  wireSeq += 1
  return color ? { id: `w${wireSeq}`, from, to, color } : { id: `w${wireSeq}`, from, to }
}

export function layout(
  components: ComponentInstance[],
  wires: Wire[] = [],
  name = 'test circuit',
): CircuitLayout {
  return { version: 1, name, components, wires }
}

/** Generic free-lead part (resistor, pot, transistor, probe...). */
export function leads(
  id: string,
  type: string,
  holes: HoleRef[],
  params?: Record<string, ParamValue>,
): ComponentInstance {
  return params ? { id, type, holes, params } : { id, type, holes }
}

export function twoLead(
  id: string,
  type: string,
  h1: HoleRef,
  h2: HoleRef,
  params?: Record<string, ParamValue>,
): ComponentInstance {
  return leads(id, type, [h1, h2], params)
}

/** Anchored part (works for 'dip' and 'footprint' placements alike). */
export function dip(id: string, type: string, at: HoleRef): ComponentInstance {
  return { id, type, at }
}

export function supply5(id = 'PS1'): ComponentInstance {
  return { id, type: 'power_supply', params: { voltage: 5 } }
}

export function funcGen(id: string, params: Record<string, ParamValue>): ComponentInstance {
  return { id, type: 'function_generator', params }
}

/**
 * A function generator used as an ideal settable DC level (amplitude 0, so
 * out = offset). Toggle with engine.setRuntimeParam(id, 'offset', volts) —
 * a debounce-free logic driver for clocking chips in tests.
 */
export function dcSource(id: string, volts = 0): ComponentInstance {
  return funcGen(id, { waveform: 'square', frequency: 1, amplitude: 0, offset: volts })
}

/**
 * Layout pre-wired with a 5V bench supply: PS1:+ → top+0, PS1:- → top-0.
 * Use a RailTap (below) for further rail connections (indices 1+).
 */
export function poweredLayout(
  components: ComponentInstance[],
  wires: Wire[] = [],
  psId = 'PS1',
): CircuitLayout {
  return layout(
    [supply5(psId), ...components],
    [wire(`${psId}:+`, 'top+0'), wire(`${psId}:-`, 'top-0'), ...wires],
  )
}

/** Allocates fresh top-rail holes so no two leads/wires share a rail hole. */
export class RailTap {
  private pos = 1
  private neg = 1
  plus(): HoleRef {
    return `top+${this.pos++}`
  }
  minus(): HoleRef {
    return `top-${this.neg++}`
  }
}

// ------------------------------------------------------------ hole lookup

export function entryOf(type: string): CatalogEntry {
  const e = CATALOG[type]
  if (!e) throw new Error(`helpers.entryOf: unknown catalog type "${type}"`)
  return e
}

export function mustParse(ref: HoleRef): Hole {
  const h = parseHole(ref)
  if (!h) throw new Error(`helpers.mustParse: bad hole ref "${ref}"`)
  return h
}

/**
 * Hole of a given package pin NUMBER (1-based) for a DIP anchored at `at`.
 * Thin wrapper over dipHoles() from src/model/breadboard.ts.
 */
export function dipPinHole(at: HoleRef, pinCount: number, pinNumber: number): HoleRef {
  const holes = dipHoles(mustParse(at), pinCount)
  if (!holes) throw new Error(`helpers.dipPinHole: invalid DIP anchor "${at}" (${pinCount} pins)`)
  if (pinNumber < 1 || pinNumber > pinCount) {
    throw new Error(`helpers.dipPinHole: pin ${pinNumber} out of range 1..${pinCount}`)
  }
  return formatHole(holes[pinNumber - 1])
}

/**
 * Hole of a component pin by NAME, via the catalog pin order +
 * componentPinHoles(). Lets chip tests wire pins symbolically.
 */
export function pinHole(comp: ComponentInstance, entry: CatalogEntry, pinName: string): HoleRef {
  const idx = entry.pins.indexOf(pinName)
  if (idx < 0) throw new Error(`helpers.pinHole: ${entry.type} has no pin "${pinName}"`)
  const holes = componentPinHoles(comp, entry)
  const h = holes ? holes[idx] : null
  if (!h) throw new Error(`helpers.pinHole: no board hole for ${comp.id}.${pinName}`)
  return formatHole(h)
}

const TOP_ROWS: StripRow[] = ['a', 'b', 'c', 'd', 'e']
const BOT_ROWS: StripRow[] = ['f', 'g', 'h', 'i', 'j']

/**
 * The k-th OTHER hole on the same strip net (same column + block, different
 * row) — used to attach wires/leads next to an occupied pin hole.
 */
export function altHole(ref: HoleRef, k = 0): HoleRef {
  const h = mustParse(ref)
  if (h.kind !== 'strip') throw new Error(`helpers.altHole: not a strip hole: "${ref}"`)
  const block = TOP_ROWS.includes(h.row) ? TOP_ROWS : BOT_ROWS
  const others = block.filter((r) => r !== h.row)
  if (k < 0 || k >= others.length) throw new Error(`helpers.altHole: k=${k} out of range`)
  return formatHole({ kind: 'strip', col: h.col, row: others[k] })
}

/** altHole of a named pin: a free hole electrically tied to that pin. */
export function tap(comp: ComponentInstance, entry: CatalogEntry, pinName: string, k = 0): HoleRef {
  return altHole(pinHole(comp, entry, pinName), k)
}

// ------------------------------------------------------------- run + measure

export function runFor(engine: EngineLike, seconds: number, dt?: number): void {
  engine.advance(seconds, dt)
}

/**
 * Advance the engine in sampleDt slices for `seconds`, recording each ref's
 * net voltage after every slice. Returns one sample array per ref.
 */
export function sampleNets(
  engine: EngineLike,
  refs: string[],
  seconds: number,
  sampleDt: number,
): number[][] {
  const out: number[][] = refs.map(() => [])
  const n = Math.max(1, Math.round(seconds / sampleDt))
  for (let i = 0; i < n; i++) {
    engine.advance(sampleDt)
    for (let j = 0; j < refs.length; j++) out[j].push(engine.netVoltage(refs[j]))
  }
  return out
}

export function sampleNet(
  engine: EngineLike,
  ref: string,
  seconds: number,
  sampleDt: number,
): number[] {
  return sampleNets(engine, [ref], seconds, sampleDt)[0]
}

/** Count low→high transitions with hysteresis (must dip below lo, then exceed hi). */
export function risingEdges(samples: number[], lo = LOGIC_LO, hi = LOGIC_HI): number {
  let armed = false
  let count = 0
  for (const v of samples) {
    if (v < lo) armed = true
    else if (v > hi && armed) {
      count += 1
      armed = false
    }
  }
  return count
}

// ------------------------------------------------------------ chip clocking

/** Press + release a pushbutton `count` times (ideal, debounce-free). */
export function pulseButton(
  engine: EngineLike,
  buttonId: string,
  count = 1,
  tHigh = 1e-3,
  tLow = 1e-3,
): void {
  for (let i = 0; i < count; i++) {
    engine.setRuntimeParam(buttonId, 'pressed', true)
    engine.advance(tHigh)
    engine.setRuntimeParam(buttonId, 'pressed', false)
    engine.advance(tLow)
  }
}

/** Set a dcSource() function generator to a DC level. */
export function fgLevel(engine: EngineLike, fgId: string, volts: number): void {
  engine.setRuntimeParam(fgId, 'offset', volts)
}

/**
 * Drive a dcSource() to `level` for `t` seconds, then back to `idle` for `t`
 * seconds. One call = exactly one edge to `level` and one back to `idle`.
 */
export function fgPulse(
  engine: EngineLike,
  fgId: string,
  level: number,
  idle: number,
  t = 1e-3,
): void {
  fgLevel(engine, fgId, level)
  engine.advance(t)
  fgLevel(engine, fgId, idle)
  engine.advance(t)
}
