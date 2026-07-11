/**
 * Real application store (glue agent): implements the AppState contract from
 * src/state/types.ts with zustand, and owns the simulation loop.
 *
 * Layout edits are immutable; the live SimEngine is kept OUTSIDE the store
 * (module-level) and rebuilt whenever the layout structurally changes.
 * Runtime params (knobs, buttons, switches…) are forwarded to the live engine
 * via setRuntimeParam without a rebuild.
 *
 * Sim loop: requestAnimationFrame. Each frame the engine is advanced by
 * (wall dt × simSpeed) sim-seconds with a wall-clock budget of 8 ms — when the
 * budget is exceeded, sim time falls behind instead of freezing the UI.
 * Telemetry is pushed to the 3D scene every frame (via the telemetry sink);
 * React state (telemetry / simTime / issues / scope) is throttled to ~10 Hz.
 * Scope channels are sampled every 1 ms of sim time from scope_probe
 * components and ring-buffered to the scope time window.
 */
import { create } from 'zustand'
import type { AppState, InteractionMode, MoveTarget } from './types'
import type {
  CircuitLayout,
  ComponentInstance,
  EndpointRef,
  HoleRef,
  ParamValue,
  Rotation,
  ScopeSample,
  SimTelemetry,
  Wire,
} from '../model/types'
import type { BoardConfig } from '../model/types'
import {
  BOARD_SIZES,
  boardConfigOf,
  boardOf,
  isBoardCount,
  isBoardRows,
  MAX_BOARD_COUNT,
  MAX_BOARD_ROWS,
  STRIP_ROWS,
} from '../model/types'
import { getEntry, paramOf } from '../model/catalog'
import {
  boardExtents,
  componentPinHoles,
  formatHole,
  isHoleOnBoard,
  offboardBodyRect,
  parseHole,
  parseTerminalRef,
  remapLayout,
  spansSeam,
} from '../model/breadboard'
import { occludedHoles } from '../model/occlusion'
import { validateLayout } from '../model/validate'
import {
  RENDER_MODE_IDS,
  RENDER_MODE_STORAGE_KEY,
  type RenderModeId,
} from '../three/render-modes/capability'
import { DEFAULT_DT, SimEngine } from '../sim/engine'
import '../sim/chips/all' // side-effect: register every behavioral chip model
import { generateCircuit } from '../llm/generate'
import { LayoutHistory } from './history'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const LS_LAYOUT = 'bb.layout'
const LS_API_KEY = 'bb.apiKey'
const AUTOSAVE_DEBOUNCE_MS = 500
const FRAME_BUDGET_MS = 8
const REACT_PUSH_MS = 100 // ~10 Hz React state updates
const SCOPE_SAMPLE_DT = 1e-3 // one scope sample per simulated millisecond
const MAX_FRAME_WALL_DT = 0.25 // clamp huge frame gaps (tab was hidden)

const EMPTY_LAYOUT: CircuitLayout = { version: 1, components: [], wires: [] }

/** Sensible id prefixes per catalog type (fallback: 'U' for ICs, 'X' else). */
const ID_PREFIX: Record<string, string> = {
  resistor: 'R',
  capacitor: 'C',
  inductor: 'L',
  potentiometer: 'RV',
  photoresistor: 'LDR',
  diode: 'D',
  led: 'LED',
  npn: 'Q',
  pnp: 'Q',
  nmos: 'Q',
  pushbutton: 'PB',
  slide_switch: 'SW',
  dip_switch_8: 'SW',
  power_supply: 'PS',
  function_generator: 'FG',
  seven_segment: 'DISP',
  buzzer: 'BZ',
  scope_probe: 'PRB',
}

// ---------------------------------------------------------------------------
// Pure layout helpers (exported for App.tsx ghost validity / click handling)
// ---------------------------------------------------------------------------

/** Canonical form of a hole ref, or null when it does not parse. */
export function normalizeHoleRef(ref: HoleRef): string | null {
  const h = parseHole(ref)
  return h ? formatHole(h) : null
}

/** Every hole occupied by a component lead or a wire endpoint (canonical refs). */
export function occupiedHoles(layout: CircuitLayout): Set<string> {
  const config = boardConfigOf(layout) // rig-aware: far columns exist on bigger rigs
  const used = new Set<string>()
  for (const comp of layout.components) {
    const entry = getEntry(comp.type)
    if (!entry) continue
    const holes = componentPinHoles(comp, entry, config)
    if (!holes) continue
    for (const h of holes) if (h) used.add(formatHole(h))
  }
  for (const w of layout.wires) {
    const f = normalizeHoleRef(w.from)
    if (f) used.add(f)
    const t = normalizeHoleRef(w.to)
    if (t) used.add(t)
  }
  return used
}

/** True when `ref` parses as a hole and no lead / wire end sits in it. */
export function holeIsFree(layout: CircuitLayout, ref: HoleRef): boolean {
  const n = normalizeHoleRef(ref)
  if (!n) return false
  return !occupiedHoles(layout).has(n)
}

/**
 * Every hole covered by some component's molded BODY beyond its own pins
 * (canonical refs). Nothing may plug into a covered hole — no component pin,
 * no wire end (the potentiometer-overhang bug). Consulted by placementValid,
 * addComponent and addWire so the store can never commit a layout the
 * validator's occlusion pass would reject.
 */
export function occludedHolesOf(layout: CircuitLayout): Set<string> {
  const config = boardConfigOf(layout)
  const out = new Set<string>()
  for (const comp of layout.components) {
    const entry = getEntry(comp.type)
    if (!entry) continue
    for (const ref of occludedHoles(comp, entry, config)) out.add(ref)
  }
  return out
}

/**
 * Would placing `type` succeed right now? For dip/footprint parts `at` is the
 * anchor under the cursor (with the armed `rotation`, absent = 0); for
 * leads/probe parts it is the next hole to pick (already-picked holes go in
 * `picked`). Used for the red/green ghost — green here must imply
 * addComponent succeeds, so occupancy AND body occlusion are both consulted
 * (the target holes must be clear of every body overhang, and the new part's
 * own body must not cover an occupied hole).
 */
export function placementValid(
  layout: CircuitLayout,
  type: string,
  at: HoleRef,
  picked: HoleRef[] = [],
  rotation: Rotation = 0,
): boolean {
  const entry = getEntry(type)
  if (!entry) return false
  const config = boardConfigOf(layout) // rig-aware: must agree with addComponent
  const used = occupiedHoles(layout)
  const blocked = occludedHolesOf(layout)
  if (entry.placement === 'dip' || entry.placement === 'footprint') {
    const probe: ComponentInstance =
      rotation !== 0 ? { id: '__ghost__', type, at, rotation } : { id: '__ghost__', type, at }
    const holes = componentPinHoles(probe, entry, config)
    if (!holes) return false
    if (spansSeam(holes, config)) return false // packages cannot straddle a module seam
    for (const h of holes) {
      if (!h) continue
      const key = formatHole(h)
      if (used.has(key) || blocked.has(key)) return false
    }
    // the package's own body must not cover an already-occupied hole
    for (const ref of occludedHoles(probe, entry, config)) {
      if (used.has(ref)) return false
    }
    return true
  }
  if (entry.placement === 'leads' || entry.placement === 'probe') {
    const h = parseHole(at)
    if (!h || !isHoleOnBoard(h, config)) return false
    const n = formatHole(h)
    if (used.has(n) || blocked.has(n)) return false
    for (const p of picked) if (normalizeHoleRef(p) === n) return false
    // last pin of the part: its own body rect is now known — it must not
    // overhang an occupied hole (e.g. a potentiometer body over a wire end)
    if (picked.length + 1 === entry.pins.length) {
      const holes: string[] = []
      for (const p of picked) {
        const np = normalizeHoleRef(p)
        if (!np) return false
        holes.push(np)
      }
      holes.push(n)
      const probe: ComponentInstance = { id: '__ghost__', type, holes }
      for (const ref of occludedHoles(probe, entry, config)) {
        if (used.has(ref)) return false
      }
    }
    return true
  }
  return false // offboard parts are placed without a hole
}

// ---------------------------------------------------------------------------
// Moving placed parts (previewMove / commitMove / moveSelection)
// ---------------------------------------------------------------------------

/**
 * One hole shifted on the board lattice: strip holes move by `dCol` columns
 * and `dRowLattice` strip-row indices ('a'..'j'; the e→f channel hop is ONE
 * step), rail holes move by `dCol` rail indices and refuse any vertical
 * component. The board-row prefix is preserved. Null = the shift is
 * meaningless (off the lattice); shifts landing OFF THE RIG still format and
 * are rejected later by validateLayout — never silently clamped.
 */
function shiftLatticeHole(ref: HoleRef, dCol: number, dRowLattice: number): HoleRef | null {
  const h = parseHole(ref)
  if (!h) return null
  if (h.kind === 'rail') {
    if (dRowLattice !== 0) return null // rails have no row lattice to move along
    const index = h.index + dCol
    if (index < 0) return null
    return formatHole({ ...h, index })
  }
  const rowIdx = STRIP_ROWS.indexOf(h.row) + dRowLattice
  if (rowIdx < 0 || rowIdx >= STRIP_ROWS.length) return null
  const col = h.col + dCol
  if (col < 1) return null
  return formatHole({ ...h, col, row: STRIP_ROWS[rowIdx] })
}

/**
 * The layout with the components in `ids` moved to `target` (see MoveTarget
 * in state/types.ts), or null when the move is structurally meaningless
 * (unknown id, anchor-form on a non-package or a group, vertical shift of a
 * package/rail hole, zero delta...). Wires STAY PUT — wire ids in the set
 * are ignored. Pure; electrical/physical validity (bounds, seams, occupancy,
 * occlusion) is the caller's validateLayout pass.
 */
function movedLayout(
  layout: CircuitLayout,
  ids: readonly string[],
  target: MoveTarget,
): CircuitLayout | null {
  const compIds = new Set<string>()
  for (const id of ids) {
    if (layout.components.some((c) => c.id === id)) compIds.add(id)
    else if (!layout.wires.some((w) => w.id === id)) return null // unknown id
    // wire ids: ignored — wires stay put (v1 move semantics)
  }
  if (compIds.size === 0) return null

  if ('anchor' in target) {
    // single dip/footprint package re-anchor (free drag re-anchor)
    if (compIds.size !== 1) return null
    const id = compIds.values().next().value as string
    const comp = layout.components.find((c) => c.id === id)
    const entry = comp ? getEntry(comp.type) : undefined
    if (!entry || (entry.placement !== 'dip' && entry.placement !== 'footprint')) return null
    const n = normalizeHoleRef(target.anchor)
    if (!n) return null
    return {
      ...layout,
      components: layout.components.map((c) => (c.id === id ? { ...c, at: n } : c)),
    }
  }

  const { dCol, dRowLattice } = target
  if (!Number.isInteger(dCol) || !Number.isInteger(dRowLattice)) return null
  if (dCol === 0 && dRowLattice === 0) return null // a no-op move is not a move
  const components: ComponentInstance[] = []
  for (const c of layout.components) {
    if (!compIds.has(c.id)) {
      components.push(c)
      continue
    }
    const entry = getEntry(c.type)
    if (!entry) return null
    switch (entry.placement) {
      case 'offboard':
        return null // instruments move via setInstrumentPos, not the hole lattice
      case 'leads':
      case 'probe': {
        if (!c.holes) return null
        const holes: string[] = []
        for (const ref of c.holes) {
          const s = shiftLatticeHole(ref, dCol, dRowLattice)
          if (!s) return null
          holes.push(s)
        }
        components.push({ ...c, holes })
        break
      }
      case 'dip':
      case 'footprint': {
        if (dRowLattice !== 0) return null // packages stay pinned to their anchor row
        if (!c.at) return null
        const s = shiftLatticeHole(c.at, dCol, 0)
        if (!s) return null
        components.push({ ...c, at: s })
        break
      }
    }
  }
  return { ...layout, components }
}

// ---------------------------------------------------------------------------
// Grid growth: instrument auto-nudge
// ---------------------------------------------------------------------------

interface PlanRect {
  minX: number
  maxX: number
  minZ: number
  maxZ: number
}

/** Strict overlap — rects that merely touch edges do NOT overlap (matches the validator). */
function rectsOverlap(a: PlanRect, b: PlanRect): boolean {
  return a.minX < b.maxX && a.maxX > b.minX && a.minZ < b.maxZ && a.maxZ > b.minZ
}

/**
 * Instruments keep their ABSOLUTE `pos` when the grid grows — but a grown
 * board can now overlap an explicitly-positioned instrument body, which the
 * model validator (rightly) rejects. Auto-nudge any such instrument to a
 * deterministic clear bench spot: keep its x, drop it to the bench row just
 * past the board's far edge, then walk right in 7-unit steps (one shelf
 * pitch) until it clears every other instrument. Default-shelf units (no
 * `pos`) sit left of the board and are never affected. Returns the SAME
 * layout reference when nothing needed nudging.
 */
function nudgeInstrumentsClear(layout: CircuitLayout): CircuitLayout {
  const config = boardConfigOf(layout)
  const ext = boardExtents(config)
  const units: { compIndex: number; slot: number; pos?: { x: number; z: number } }[] = []
  let slot = 0
  layout.components.forEach((c, compIndex) => {
    const entry = getEntry(c.type)
    if (entry?.placement === 'offboard') units.push({ compIndex, slot: slot++, pos: c.pos })
  })
  const rects = units.map((u) => offboardBodyRect(u.slot, u.pos))
  const moved = new Map<number, { x: number; z: number }>() // unit index → new pos
  for (let i = 0; i < units.length; i++) {
    const pos = units[i].pos
    if (!pos) continue // the default shelf (left of the board) is always clear
    const blocked = (r: PlanRect): boolean =>
      rectsOverlap(r, ext) || rects.some((o, j) => j !== i && rectsOverlap(r, o))
    if (!blocked(rects[i])) continue
    let x = pos.x
    const z = ext.maxZ + 2.5 // body rect minZ = z−2 → strictly past the board edge
    let r = offboardBodyRect(units[i].slot, { x, z })
    let guard = 4 * units.length + 8 // every unit blocks ≤2 shelf steps; always terminates
    while (blocked(r) && guard-- > 0) {
      x += 7
      r = offboardBodyRect(units[i].slot, { x, z })
    }
    moved.set(i, { x, z })
    rects[i] = r
  }
  if (moved.size === 0) return layout
  const components = layout.components.slice()
  units.forEach((u, i) => {
    const pos = moved.get(i)
    if (pos) components[u.compIndex] = { ...components[u.compIndex], pos }
  })
  return { ...layout, components }
}

/**
 * Shrink protection shared by setBoardSize / setBoardCount: how many parts
 * (components or wires) would be stranded on the `target` rig — any lead or
 * wire endpoint off the target bounds, or a dip/footprint package that would
 * straddle one of the target's module seams (seams move when the module SIZE
 * changes). Pin holes resolve against the CURRENT rig so far-column parts are
 * seen at all.
 */
function strandedParts(layout: CircuitLayout, target: BoardConfig): number {
  const current = boardConfigOf(layout)
  let offenders = 0
  for (const comp of layout.components) {
    const entry = getEntry(comp.type)
    if (!entry || entry.placement === 'offboard') continue
    const holes = componentPinHoles(comp, entry, current)
    const fits =
      holes !== null &&
      holes.every((h) => h === null || isHoleOnBoard(h, target)) &&
      !((entry.placement === 'dip' || entry.placement === 'footprint') && spansSeam(holes, target))
    if (!fits) offenders++
  }
  for (const w of layout.wires) {
    const fits = [w.from, w.to].every((end) => {
      const h = parseHole(end)
      return !h || isHoleOnBoard(h, target)
    })
    if (!fits) offenders++
  }
  return offenders
}

/** "the Half board" / "the Standard ×3 rig" — for shrink-refusal messages. */
function rigName(config: BoardConfig): string {
  const label = BOARD_SIZES[config.size].label
  return config.count > 1 ? `${label} ×${config.count} rig` : `${label} board`
}

function nextFreeId(layout: CircuitLayout, prefix: string): string {
  const taken = new Set<string>()
  for (const c of layout.components) taken.add(c.id)
  for (const w of layout.wires) taken.add(w.id)
  for (let n = 1; ; n++) {
    const id = `${prefix}${n}`
    if (!taken.has(id)) return id
  }
}

function idPrefixFor(type: string): string {
  const p = ID_PREFIX[type]
  if (p) return p
  const entry = getEntry(type)
  return entry?.category === 'ic' ? 'U' : 'X'
}

/**
 * Endpoint is a hole that exists on the ACTIVE rig, or a terminal of an
 * existing off-board component. parseHole alone is only syntax (it accepts
 * the maxima across rigs) — without the isHoleOnBoard bounds check, a stale
 * wire-mode `from` surviving a board shrink could commit an off-rig wire,
 * which the autosave persists and validateLayout then rejects on next boot
 * (silently wiping the circuit back to empty).
 */
function endpointValid(layout: CircuitLayout, ref: EndpointRef): boolean {
  const h = parseHole(ref)
  if (h) return isHoleOnBoard(h, boardConfigOf(layout))
  const t = parseTerminalRef(ref)
  if (!t) return false
  const comp = layout.components.find((c) => c.id === t.componentId)
  if (!comp) return false
  const entry = getEntry(comp.type)
  return !!entry && entry.placement === 'offboard' && entry.pins.includes(t.pin)
}

function canonicalEndpoint(ref: EndpointRef): string {
  return normalizeHoleRef(ref) ?? ref
}

/**
 * Wire mode survives document swaps (undo/redo, board resize), but a pending
 * first endpoint must still exist on the new document — a rig shrink or an
 * undone board-grow can strand `mode.from` off the board, leaving a floating
 * wire preview and a dead wire mode (every second click would be refused by
 * endpointValid). Drop just the endpoint; the armed mode + color survive.
 */
function reconcileWireMode(mode: InteractionMode, layout: CircuitLayout): InteractionMode {
  if (mode.kind !== 'wire' || !mode.from || endpointValid(layout, mode.from)) return mode
  return { kind: 'wire', from: null, color: mode.color }
}

/**
 * Transient runtime-only params that must never persist: the pushbutton's
 * momentary 'pressed' (HOLD) lives in the in-memory document so the UI can
 * render it, but a history snapshot / autosave / export carrying
 * pressed:true would resurrect a stuck-held button (undo restores it and the
 * engine rebuild reads it; a reload boots with the button held).
 */
const TRANSIENT_PARAM_KEYS = ['pressed'] as const

/**
 * `layout` with transient params stripped from every component. Returns the
 * SAME reference when there is nothing to strip, preserving the store's
 * layout reference-identity semantics (history entries are plain references).
 */
export function stripTransientParams(layout: CircuitLayout): CircuitLayout {
  let changed = false
  const components = layout.components.map((c) => {
    const params = c.params
    if (!params || !TRANSIENT_PARAM_KEYS.some((k) => k in params)) return c
    changed = true
    const rest: Record<string, ParamValue> = { ...params }
    for (const k of TRANSIENT_PARAM_KEYS) delete rest[k]
    if (Object.keys(rest).length === 0) {
      const { params: _omit, ...bare } = c
      return bare
    }
    return { ...c, params: rest }
  })
  return changed ? { ...layout, components } : layout
}

// ---------------------------------------------------------------------------
// localStorage boot / autosave
// ---------------------------------------------------------------------------

function loadSavedApiKey(): string {
  try {
    return window.localStorage.getItem(LS_API_KEY) ?? ''
  } catch {
    return ''
  }
}

/** Persisted render-mode pref; null when unset/unknown (device auto-default). */
function loadSavedRenderMode(): RenderModeId | null {
  try {
    const raw = window.localStorage.getItem(RENDER_MODE_STORAGE_KEY)
    return raw !== null && (RENDER_MODE_IDS as readonly string[]).includes(raw)
      ? (raw as RenderModeId)
      : null
  } catch {
    return null
  }
}

function loadSavedLayout(): CircuitLayout {
  try {
    const raw = window.localStorage.getItem(LS_LAYOUT)
    if (!raw) return EMPTY_LAYOUT
    const parsed: unknown = JSON.parse(raw)
    const res = validateLayout(parsed)
    if (res.ok && res.layout) return res.layout
  } catch {
    /* corrupted save / no storage: start empty */
  }
  return EMPTY_LAYOUT
}

let autosaveTimer: ReturnType<typeof setTimeout> | null = null
function scheduleAutosave(layout: CircuitLayout): void {
  if (autosaveTimer !== null) clearTimeout(autosaveTimer)
  autosaveTimer = setTimeout(() => {
    autosaveTimer = null
    try {
      // never persist a mid-hold 'pressed' — a reload must not boot held
      window.localStorage.setItem(LS_LAYOUT, JSON.stringify(stripTransientParams(layout)))
    } catch {
      /* storage full / unavailable */
    }
  }, AUTOSAVE_DEBOUNCE_MS)
}

// ---------------------------------------------------------------------------
// Undo/redo history (module level — layouts are immutable references; the
// stacks never persist, so every boot starts with empty history)
// ---------------------------------------------------------------------------

const history = new LayoutHistory()

/** TEST-ONLY: empty the undo/redo stacks and resync the store flags. */
export function __resetHistoryForTests(): void {
  history.clear()
  useStore.setState({ canUndo: false, canRedo: false })
}

// ---------------------------------------------------------------------------
// Engine + sim-loop runtime (module level — never inside React state)
// ---------------------------------------------------------------------------

let engine: SimEngine | null = null
let rafId: number | null = null
let lastFrameMs: number | null = null
let lastReactPushMs = 0

/** Scope ring buffer (mutated in place; a fresh wrapper object is pushed to state). */
let scopeBuf: ScopeSample[] = []
let nextSampleT = 0

interface ProbeBinding {
  channel: number // 0..3
  ref: HoleRef
}
let probes: ProbeBinding[] = []

/**
 * Per-frame telemetry consumer (the 3D scene). Registered by App.tsx so live
 * telemetry reaches the scene at full frame rate, bypassing React.
 */
let telemetrySink: ((t: SimTelemetry | null) => void) | null = null
export function setTelemetrySink(sink: ((t: SimTelemetry | null) => void) | null): void {
  telemetrySink = sink
  sink?.(useStore.getState().telemetry)
}

/**
 * Fired after a wholesale layout load succeeds (example, JSON import, AI
 * apply). Registered by App.tsx to re-frame the 3D camera onto the loaded
 * circuit — loaded circuits can sit anywhere on the board, outside the fixed
 * home framing of a phone viewport. Module-level like the telemetry sink:
 * scene concerns never live in React/store state.
 */
let layoutLoadedSink: (() => void) | null = null
export function setLayoutLoadedSink(sink: (() => void) | null): void {
  layoutLoadedSink = sink
}

/**
 * Abort controller for the in-flight LLM generation (module level, like the
 * engine — never inside React state). Non-null exactly while a generation is
 * running. Cancellation is exposed as the `cancelGeneration` store action.
 */
let generateAbort: AbortController | null = null

function refreshProbes(layout: CircuitLayout): void {
  probes = []
  for (const comp of layout.components) {
    if (comp.type !== 'scope_probe') continue
    const entry = getEntry(comp.type)
    if (!entry) continue
    const ref = comp.holes?.[0]
    if (!ref) continue
    const raw = Number(paramOf(comp.params, entry, 'channel') ?? 1)
    if (!Number.isFinite(raw)) continue
    const channel = Math.min(4, Math.max(1, Math.round(raw))) - 1
    probes.push({ channel, ref })
  }
}

function takeScopeSample(t: number): void {
  if (!engine) return
  const v: [number, number, number, number] = [NaN, NaN, NaN, NaN]
  for (const p of probes) v[p.channel] = engine.netVoltage(p.ref)
  scopeBuf.push({ t, v })
}

function trimScope(now: number, timeWindow: number): void {
  const cutoff = now - timeWindow
  let drop = 0
  while (drop < scopeBuf.length && scopeBuf[drop].t < cutoff) drop++
  if (drop > 0) scopeBuf.splice(0, drop)
}

/** (Re)build the engine from `layout`, preserving the running clock. */
function rebuildEngine(layout: CircuitLayout): void {
  const prevTime = engine?.time ?? 0
  try {
    engine = new SimEngine(layout)
    engine.time = prevTime
  } catch (err) {
    engine = null
    useStore.setState({
      running: false,
      issues: [{ level: 'error', message: `simulation failed to start: ${String(err)}` }],
    })
    stopLoop()
    return
  }
  refreshProbes(layout)
  if (nextSampleT < engine.time) nextSampleT = engine.time
  useStore.setState({ issues: engine.issues.slice() })
}

function startLoop(): void {
  if (rafId !== null) return
  if (typeof requestAnimationFrame !== 'function') return
  lastFrameMs = null
  rafId = requestAnimationFrame(frame)
}

function stopLoop(): void {
  if (rafId !== null && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(rafId)
  rafId = null
  lastFrameMs = null
}

function frame(nowMs: number): void {
  rafId = requestAnimationFrame(frame)
  const s = useStore.getState()
  if (!engine || !s.running) return

  const prevMs = lastFrameMs ?? nowMs - 1000 / 60
  lastFrameMs = nowMs
  const wallDt = Math.min(Math.max((nowMs - prevMs) / 1000, 0), MAX_FRAME_WALL_DT)
  const targetT = engine.time + wallDt * s.simSpeed
  const deadline = performance.now() + FRAME_BUDGET_MS

  // Advance in scope-sample slices (≈1 ms of sim time = 20 default steps),
  // checking the wall-clock budget between slices. If the budget runs out,
  // sim time simply falls behind the wall clock.
  while (engine.time < targetT - DEFAULT_DT * 0.5) {
    const before = engine.time
    const sliceEnd = Math.min(targetT, nextSampleT)
    if (sliceEnd > before) engine.advance(sliceEnd - before, DEFAULT_DT)
    if (engine.time >= nextSampleT - DEFAULT_DT * 0.5) {
      takeScopeSample(engine.time)
      nextSampleT = engine.time + SCOPE_SAMPLE_DT
    }
    if (engine.time <= before && sliceEnd > before) break // safety: no progress
    if (performance.now() >= deadline) break
  }
  trimScope(engine.time, s.scope.timeWindow)

  // telemetry → 3D scene every frame
  const tele = engine.telemetry()
  telemetrySink?.(tele)

  // React state at ~10 Hz
  if (nowMs - lastReactPushMs >= REACT_PUSH_MS) {
    lastReactPushMs = nowMs
    useStore.setState({
      telemetry: tele,
      simTime: engine.time,
      issues: engine.issues.slice(),
      scope: { samples: scopeBuf, timeWindow: s.scope.timeWindow },
    })
  }
}

/** Push the engine's current outputs to both React state and the scene. */
function publishNow(): void {
  const tele = engine ? engine.telemetry() : null
  useStore.setState({
    telemetry: tele,
    simTime: engine?.time ?? 0,
    issues: engine ? engine.issues.slice() : [],
    scope: { samples: scopeBuf, timeWindow: useStore.getState().scope.timeWindow },
  })
  telemetrySink?.(tele)
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export const useStore = create<AppState>()((set, get) => {
  /** Commit an immutable layout update (+ autosave + live-engine rebuild). */
  const commitLayout = (layout: CircuitLayout, rebuild = true): void => {
    set({ layout })
    scheduleAutosave(layout)
    if (engine && rebuild) rebuildEngine(layout)
  }

  /**
   * Record the PRE-mutation layout right before a mutation commits.
   * Snapshots are stripped of transient params: a push taken while a
   * pushbutton is held must not let undo restore a stuck-pressed document.
   */
  const pushHistory = (tag?: string): void => {
    history.push(stripTransientParams(get().layout), tag)
    set({ canUndo: history.canUndo, canRedo: history.canRedo })
  }

  /**
   * Land an undo/redo snapshot: swap the document, sync the can* flags, drop
   * selected ids that no longer exist, autosave, and rebuild the live
   * engine (rebuildEngine preserves the running clock + reposts issues).
   */
  const restoreSnapshot = (layout: CircuitLayout): void => {
    const sel = get().selection
    const alive = sel.filter(
      (id) => layout.components.some((c) => c.id === id) || layout.wires.some((w) => w.id === id),
    )
    set({
      layout,
      selection: alive.length === sel.length ? sel : alive, // keep identity when unchanged
      mode: reconcileWireMode(get().mode, layout), // drop a `from` stranded off the restored rig
      canUndo: history.canUndo,
      canRedo: history.canRedo,
    })
    scheduleAutosave(layout)
    if (engine) rebuildEngine(layout)
  }

  return {
    // --- document -----------------------------------------------------------
    layout: loadSavedLayout(),
    selection: [],
    mode: { kind: 'select' } as InteractionMode,
    hoverHole: null,
    canUndo: false,
    canRedo: false,

    // --- preferences ----------------------------------------------------------
    renderMode: loadSavedRenderMode(),

    // --- simulation ---------------------------------------------------------
    running: false,
    simSpeed: 1,
    simTime: 0,
    telemetry: null,
    issues: [],
    scope: { samples: [], timeWindow: 5 },

    // --- llm ----------------------------------------------------------------
    llm: {
      apiKey: loadSavedApiKey(),
      busy: false,
      status: '',
      explanation: null,
      pending: null,
      error: null,
    },

    // --- actions: document --------------------------------------------------

    addComponent(type, opts) {
      const entry = getEntry(type)
      if (!entry) return
      const layout = get().layout
      const comp: ComponentInstance = { id: nextFreeId(layout, idPrefixFor(type)), type }

      switch (entry.placement) {
        case 'leads':
        case 'probe': {
          if (!opts.holes || opts.holes.length !== entry.pins.length) return
          const normalized: string[] = []
          for (const ref of opts.holes) {
            const n = normalizeHoleRef(ref)
            if (!n) return
            normalized.push(n)
          }
          comp.holes = normalized
          break
        }
        case 'dip':
        case 'footprint': {
          if (!opts.at) return
          const n = normalizeHoleRef(opts.at)
          if (!n) return
          comp.at = n
          // armed in-plane rotation (canonical: 0 stays absent). A rotation a
          // package cannot take (90/270 on a DIP) makes componentPinHoles
          // return null below — the add is refused, never silently coerced.
          const rot = opts.rotation ?? 0
          if (rot !== 0) comp.rotation = rot
          break
        }
        case 'offboard':
          break
      }

      // placement validation: pin holes resolvable on THIS rig + occupancy
      // + body occlusion (must agree with placementValid — the green ghost)
      const config = boardConfigOf(layout)
      const pinHoles = componentPinHoles(comp, entry, config)
      if (!pinHoles) return // bad anchor / off the board — silently refuse
      if (
        (entry.placement === 'dip' || entry.placement === 'footprint') &&
        spansSeam(pinHoles, config)
      ) {
        return // a rigid package cannot straddle the gap between board modules
      }
      const used = occupiedHoles(layout)
      const blocked = occludedHolesOf(layout)
      const mine = new Set<string>()
      for (const h of pinHoles) {
        if (!h) continue
        const key = formatHole(h)
        if (used.has(key) || blocked.has(key) || mine.has(key)) return // taken / under a body
        mine.add(key)
      }
      // the new part's own body must not cover an already-occupied hole
      for (const ref of occludedHoles(comp, entry, config)) {
        if (used.has(ref)) return
      }

      pushHistory(`add:${type}`)
      commitLayout({ ...layout, components: [...layout.components, comp] })
    },

    removeSelected() {
      // EVERY selected component and wire goes in ONE undo step (multi-select
      // group delete; a single selection behaves exactly like before)
      const { selection, layout } = get()
      if (selection.length === 0) return
      const ids = new Set(selection)
      const goneComps = new Set(
        layout.components.filter((c) => ids.has(c.id)).map((c) => c.id),
      )
      const components = layout.components.filter((c) => !goneComps.has(c.id))
      const wires = layout.wires.filter((w) => {
        if (ids.has(w.id)) return false
        // wires to a removed instrument's off-board terminals go with it
        const f = parseTerminalRef(w.from)
        if (f && goneComps.has(f.componentId)) return false
        const t = parseTerminalRef(w.to)
        return !(t && goneComps.has(t.componentId))
      })
      if (
        components.length === layout.components.length &&
        wires.length === layout.wires.length
      ) {
        set({ selection: [] }) // stale ids only — nothing to record
        return
      }
      set({ selection: [] })
      pushHistory(`remove:${selection.join('+')}`)
      commitLayout({ ...layout, components, wires })
    },

    removeComponent(id) {
      const layout = get().layout
      if (!layout.components.some((c) => c.id === id)) return
      const components = layout.components.filter((c) => c.id !== id)
      // wires to this component's off-board terminals go with it
      const wires = layout.wires.filter((w) => {
        const f = parseTerminalRef(w.from)
        const t = parseTerminalRef(w.to)
        return f?.componentId !== id && t?.componentId !== id
      })
      const sel = get().selection
      if (sel.includes(id)) set({ selection: sel.filter((s) => s !== id) })
      pushHistory(`remove:${id}`)
      commitLayout({ ...layout, components, wires })
    },

    removeWire(id) {
      const layout = get().layout
      if (!layout.wires.some((w) => w.id === id)) return
      const sel = get().selection
      if (sel.includes(id)) set({ selection: sel.filter((s) => s !== id) })
      pushHistory(`remove:${id}`)
      commitLayout({ ...layout, wires: layout.wires.filter((w) => w.id !== id) })
    },

    addWire(from, to, color) {
      const layout = get().layout
      if (!endpointValid(layout, from) || !endpointValid(layout, to)) return
      const cFrom = canonicalEndpoint(from)
      const cTo = canonicalEndpoint(to)
      if (cFrom === cTo) return // self-wire
      // duplicate (either direction)
      for (const w of layout.wires) {
        const wf = canonicalEndpoint(w.from)
        const wt = canonicalEndpoint(w.to)
        if ((wf === cFrom && wt === cTo) || (wf === cTo && wt === cFrom)) return
      }
      // hole endpoints must be unoccupied (one lead per hole) AND not sit
      // under a component body's overhang (occlusion — validator parity)
      const used = occupiedHoles(layout)
      const blocked = occludedHolesOf(layout)
      for (const end of [cFrom, cTo]) {
        if (parseHole(end) && (used.has(end) || blocked.has(end))) return
      }
      const wire: Wire = {
        id: nextFreeId(layout, 'W'),
        from: cFrom,
        to: cTo,
        color: color ?? 'red',
      }
      pushHistory('wire')
      commitLayout({ ...layout, wires: [...layout.wires, wire] })
    },

    setParam(componentId, key, value) {
      const layout = get().layout
      const comp = layout.components.find((c) => c.id === componentId)
      if (!comp) return
      const entry = getEntry(comp.type)
      if (!entry) return
      const def = entry.params?.find((p) => p.key === key)
      if (!def) return

      const components = layout.components.map((c) =>
        c.id === componentId ? { ...c, params: { ...c.params, [key]: value } } : c,
      )
      const isRuntime = def.runtime === true
      // Undoable like any document edit — except the momentary 'pressed'
      // (pushbutton HOLD), which is transient by nature. The param tag makes
      // rapid same-knob updates (slider drags) coalesce into ONE undo step.
      if (key !== 'pressed') pushHistory(`param:${componentId}:${key}`)
      // runtime params go straight to the live engine — no rebuild;
      // structural params (resistance, capacitance…) require a rebuild.
      commitLayout({ ...layout, components }, !isRuntime)
      if (isRuntime && engine) engine.setRuntimeParam(componentId, key, value)
      if (comp.type === 'scope_probe') refreshProbes(get().layout)
    },

    select(id) {
      const sel = get().selection
      // keep the array identity stable for repeat-clicks (the scene resyncs
      // highlight overlays on every selection identity change)
      if (id === null ? sel.length === 0 : sel.length === 1 && sel[0] === id) return
      set({ selection: id === null ? [] : [id] })
    },

    toggleSelect(id) {
      const sel = get().selection
      set({ selection: sel.includes(id) ? sel.filter((s) => s !== id) : [...sel, id] })
    },

    clearSelection() {
      if (get().selection.length > 0) set({ selection: [] })
    },

    marqueeSelect(ids) {
      set({ selection: [...new Set(ids)] })
    },

    setMode(mode) {
      if (mode.kind === 'place') {
        const entry = getEntry(mode.type)
        if (!entry) return
        if (entry.placement === 'offboard') {
          // off-board instruments are placed immediately — no hole to pick
          const before = get().layout.components.length
          get().addComponent(mode.type, {})
          const comps = get().layout.components
          set({
            mode: { kind: 'select' },
            selection: comps.length > before ? [comps[comps.length - 1].id] : get().selection,
          })
          return
        }
      }
      set({ mode })
    },

    setHoverHole(h) {
      if (get().hoverHole === h) return
      set({ hoverHole: h })
    },

    clearBoard() {
      get().resetSim()
      const cur = get().layout
      // one undo step restores the whole board (skip when already empty)
      if (
        cur.components.length > 0 ||
        cur.wires.length > 0 ||
        cur.board !== undefined ||
        cur.boardCount !== undefined ||
        cur.boardRows !== undefined
      ) {
        pushHistory('clear')
      }
      set({ layout: EMPTY_LAYOUT, selection: [], mode: { kind: 'select' } })
      scheduleAutosave(EMPTY_LAYOUT)
    },

    loadLayout(layout) {
      const res = validateLayout(layout)
      if (!res.ok || !res.layout) return { ok: false, errors: res.errors }
      get().resetSim()
      pushHistory('load') // import / example / AI apply = one undo step
      set({
        layout: res.layout,
        selection: [],
        mode: { kind: 'select' },
        issues: res.warnings.map((message) => ({ level: 'warning' as const, message })),
      })
      scheduleAutosave(res.layout)
      layoutLoadedSink?.() // after set(): scene subscribers already saw the new layout
      return { ok: true, errors: [] }
    },

    exportJson() {
      // exports must not carry the momentary 'pressed' of a held button
      return JSON.stringify(stripTransientParams(get().layout), null, 2)
    },

    undo() {
      // strip the stashed current document too — redo must not restore a
      // snapshot taken while a pushbutton was held
      const restored = history.undo(stripTransientParams(get().layout))
      if (!restored) return
      restoreSnapshot(restored)
    },

    redo() {
      const restored = history.redo(stripTransientParams(get().layout))
      if (!restored) return
      restoreSnapshot(restored)
    },

    // --- actions: move / rotate ----------------------------------------------

    previewMove(ids, target) {
      // pure: same movedLayout + full-validator pass commitMove uses, so the
      // drag hologram's tint can never disagree with the commit
      const moved = movedLayout(get().layout, ids, target)
      return { valid: moved !== null && validateLayout(moved).ok }
    },

    commitMove(ids, target) {
      const layout = get().layout
      const moved = movedLayout(layout, ids, target)
      // ALL-OR-NOTHING: the full validator re-checks bounds, seams, occupancy
      // and occlusion with the moving parts' old holes vacated (they are
      // simply absent from the candidate). Wires stay put (v1 semantics).
      if (!moved || !validateLayout(moved).ok) return { ok: false }
      pushHistory('move')
      commitLayout(moved)
      return { ok: true }
    },

    moveSelection(dCol, dRowLattice = 0) {
      const { selection, layout } = get()
      // wires stay put — nudge only the selected components
      const ids = selection.filter((id) => layout.components.some((c) => c.id === id))
      if (ids.length === 0) return
      get().commitMove(ids, { dCol, dRowLattice })
    },

    rotateArmed() {
      const mode = get().mode
      if (mode.kind !== 'place') return
      const entry = getEntry(mode.type)
      if (!entry || (entry.placement !== 'dip' && entry.placement !== 'footprint')) return
      const cur = mode.rotation ?? 0
      // DIPs only ever take 0|180 (90/270 would short opposite pin pairs)
      const next: Rotation =
        entry.placement === 'dip' ? (cur === 0 ? 180 : 0) : (((cur + 90) % 360) as Rotation)
      set({ mode: { ...mode, rotation: next } })
    },

    rotatePlaced(id) {
      const layout = get().layout
      const comp = layout.components.find((c) => c.id === id)
      const entry = comp ? getEntry(comp.type) : undefined
      if (!comp || !entry || (entry.placement !== 'dip' && entry.placement !== 'footprint')) {
        return { ok: false }
      }
      const cur: Rotation = comp.rotation ?? 0
      // candidate quarter turns in cycling order; DIPs toggle 0↔180 in place
      const steps: number[] = entry.placement === 'dip' ? [180] : [90, 180, 270]
      for (const step of steps) {
        const rot = ((cur + step) % 360) as Rotation
        const components = layout.components.map((c) => {
          if (c.id !== id) return c
          const next: ComponentInstance = { ...c }
          if (rot === 0) delete next.rotation // canonical: rotation 0 stays absent
          else next.rotation = rot
          return next
        })
        const candidate: CircuitLayout = { ...layout, components }
        // re-validate holes incl. occupancy, occlusion and seams
        if (validateLayout(candidate).ok) {
          pushHistory(`rotate:${id}`)
          commitLayout(candidate)
          return { ok: true }
        }
      }
      return { ok: false } // no other rotation fits — leave the part untouched
    },

    // --- actions: instruments -------------------------------------------------

    setInstrumentPos(id, pos) {
      const layout = get().layout
      const comp = layout.components.find((c) => c.id === id)
      const entry = comp ? getEntry(comp.type) : undefined
      if (!comp || !entry) return { ok: false, error: `no component "${id}"` }
      if (entry.placement !== 'offboard') {
        return { ok: false, error: `"${id}" sits on the board — only instruments take a bench position` }
      }
      if (comp.pos && comp.pos.x === pos.x && comp.pos.z === pos.z) return { ok: true }
      const components = layout.components.map((c) =>
        c.id === id ? { ...c, pos: { x: pos.x, z: pos.z } } : c,
      )
      const candidate: CircuitLayout = { ...layout, components }
      // model rules: 0.5-grid snap, body clear of the board + other instruments
      const res = validateLayout(candidate)
      if (!res.ok) return { ok: false, error: res.errors[0] }
      // the param-style tag coalesces a continuous drag into ONE undo step
      pushHistory(`param:${id}:pos`)
      // visual-only: no engine rebuild, but the fresh layout identity makes
      // the scene replan wire routes around the moved instrument box
      commitLayout(candidate, false)
      return { ok: true }
    },

    setBoardSize(size) {
      const layout = get().layout
      if (size === boardOf(layout)) return { ok: true }

      // Shrink safety against (newSize, CURRENT count + rows): every component
      // lead and wire endpoint must exist on the target rig, and no package
      // may land on one of its (moved) seams. (Growing passes trivially — the
      // hole lattices nest.) `rows` MUST carry over: omitting it would make
      // isHoleOnBoard treat the target as a 1-row grid and falsely strand
      // every part on board-rows >= 1, even on pure growth.
      const current = boardConfigOf(layout)
      const target: BoardConfig = { size, count: current.count, rows: current.rows }
      const offenders = strandedParts(layout, target)
      if (offenders > 0) {
        const noun = offenders === 1 ? 'part' : 'parts'
        return { ok: false, error: `${offenders} ${noun} would fall off the ${rigName(target)}` }
      }

      pushHistory('board')
      // a bigger board can swallow an explicitly-positioned instrument; keep
      // the store's invariant (committed layouts always validate) by nudging
      // it clear — no-op (same reference) when nothing overlaps
      const next: CircuitLayout = nudgeInstrumentsClear({ ...layout, board: size })
      commitLayout(next)
      // a pending wire-mode `from` is not a committed part: strandedParts
      // never saw it, so drop it here if the new rig no longer has its hole
      set({ mode: reconcileWireMode(get().mode, next) })
      return { ok: true }
    },

    setBoardCount(n) {
      if (!isBoardCount(n)) {
        return {
          ok: false,
          error: `Board count must be a whole number from 1 to ${MAX_BOARD_COUNT}`,
        }
      }
      const layout = get().layout
      const current = boardConfigOf(layout)
      if (n === current.count) return { ok: true }

      // Shrink safety: every lead and wire endpoint must exist on the smaller
      // rig (count growth passes trivially — columns/rail indices just extend
      // rightward and existing seams stay put). `rows` carries over so parts
      // on board-rows >= 1 are bounds-checked against the real grid depth.
      const target: BoardConfig = { size: current.size, count: n, rows: current.rows }
      if (n < current.count) {
        const offenders = strandedParts(layout, target)
        if (offenders > 0) {
          const noun = offenders === 1 ? 'part' : 'parts'
          return { ok: false, error: `${offenders} ${noun} would fall off the ${rigName(target)}` }
        }
      }

      pushHistory('boards')
      // absent = 1 is the canonical single-board form (back-compat exports)
      let next: CircuitLayout = { ...layout, boardCount: n }
      if (n === 1) delete next.boardCount
      // a wider rig can swallow an explicitly-positioned instrument (e.g. the
      // scene's plus paddle growing rightward) — auto-nudge it clear so the
      // committed document always validates (shrinks are a no-op here)
      next = nudgeInstrumentsClear(next)
      commitLayout(next)
      // a pending wire-mode `from` is not a committed part: strandedParts
      // never saw it, so drop it here if the new rig no longer has its hole
      set({ mode: reconcileWireMode(get().mode, next) })
      return { ok: true }
    },

    setBoardRows(n) {
      if (!isBoardRows(n)) {
        return {
          ok: false,
          error: `Board rows must be a whole number from 1 to ${MAX_BOARD_ROWS}`,
        }
      }
      const layout = get().layout
      const current = boardConfigOf(layout)
      if (n === current.rows) return { ok: true }

      // Shrink safety: every lead and wire endpoint must exist on the
      // shallower grid (isHoleOnBoard bounds the board-row prefix).
      const target: BoardConfig = { size: current.size, count: current.count, rows: n }
      if (n < current.rows) {
        const offenders = strandedParts(layout, target)
        if (offenders > 0) {
          const noun = offenders === 1 ? 'part' : 'parts'
          return {
            ok: false,
            error: `${offenders} ${noun} would fall off the ${n}-row grid`,
          }
        }
      }

      pushHistory('rows')
      // absent = 1 is the canonical single-row form (back-compat exports)
      let next: CircuitLayout = { ...layout, boardRows: n }
      if (n === 1) delete next.boardRows
      // a deeper board can swallow an explicitly-positioned instrument —
      // keep its absolute pos when clear, auto-nudge it when not
      if (n > current.rows) next = nudgeInstrumentsClear(next)
      commitLayout(next)
      set({ mode: reconcileWireMode(get().mode, next) })
      return { ok: true }
    },

    growGrid(direction) {
      const layout = get().layout
      const cfg = boardConfigOf(layout)
      let next: CircuitLayout
      if (direction === 'right' || direction === 'left') {
        if (cfg.count >= MAX_BOARD_COUNT) {
          return { ok: false, error: `The rig is already ${MAX_BOARD_COUNT} modules wide` }
        }
        // growing LEFT shifts the content one module of columns rightward
        // (rail indices proportionally) so the origin stays the top-left board
        const base =
          direction === 'left' ? remapLayout(layout, BOARD_SIZES[cfg.size].cols, 0) : layout
        next = { ...base, boardCount: cfg.count + 1 }
      } else {
        if (cfg.rows >= MAX_BOARD_ROWS) {
          return { ok: false, error: `The grid is already ${MAX_BOARD_ROWS} board-rows deep` }
        }
        // growing UP shifts the content one board-row deeper ("1:" prefixes)
        const base = direction === 'up' ? remapLayout(layout, 0, 1) : layout
        next = { ...base, boardRows: cfg.rows + 1 }
      }
      // instruments keep their ABSOLUTE pos; any the grown board now overlaps
      // is auto-nudged to clear bench space (validator rules)
      next = nudgeInstrumentsClear(next)
      // defensive gate (grid-model contract): a remap can never silently
      // clamp — anything off the rails fails validation loudly, and we refuse
      // rather than commit a document the next boot would reject
      const res = validateLayout(next)
      if (!res.ok) {
        return { ok: false, error: `growing the grid failed validation: ${res.errors[0]}` }
      }
      pushHistory(`grow:${direction}`) // ONE undo step restores refs + rig together
      commitLayout(next)
      set({ mode: reconcileWireMode(get().mode, next) })
      return { ok: true }
    },

    // --- actions: preferences --------------------------------------------------

    setRenderMode(mode) {
      set({ renderMode: mode })
      try {
        if (mode === null) window.localStorage.removeItem(RENDER_MODE_STORAGE_KEY)
        else window.localStorage.setItem(RENDER_MODE_STORAGE_KEY, mode)
      } catch {
        /* storage unavailable — the choice just won't persist */
      }
    },

    // --- actions: simulation -------------------------------------------------

    startSim() {
      if (get().running) return
      if (!engine) {
        scopeBuf = []
        nextSampleT = 0
        rebuildEngine(get().layout)
        if (!engine) return // engine construction failed; issue already posted
      }
      set({ running: true })
      lastReactPushMs = 0
      publishNow()
      startLoop()
    },

    stopSim() {
      if (!get().running) return
      stopLoop()
      set({ running: false })
      publishNow() // leave the final state on screen
    },

    resetSim() {
      stopLoop()
      engine = null
      scopeBuf = []
      nextSampleT = 0
      set({
        running: false,
        simTime: 0,
        telemetry: null,
        issues: [],
        scope: { samples: scopeBuf, timeWindow: get().scope.timeWindow },
      })
      telemetrySink?.(null)
    },

    setSimSpeed(x) {
      if (!Number.isFinite(x) || x <= 0) return
      set({ simSpeed: x })
    },

    setScopeWindow(seconds) {
      if (!Number.isFinite(seconds) || seconds <= 0) return
      if (engine) trimScope(engine.time, seconds)
      set({ scope: { samples: scopeBuf, timeWindow: seconds } })
    },

    // --- actions: llm --------------------------------------------------------

    setApiKey(k) {
      set({ llm: { ...get().llm, apiKey: k } })
      try {
        window.localStorage.setItem(LS_API_KEY, k)
      } catch {
        /* storage unavailable */
      }
    },

    cancelGeneration() {
      if (!generateAbort) return
      generateAbort.abort()
      // don't let in-flight progress overwrite the terminal status
      if (get().llm.busy) set({ llm: { ...get().llm, status: 'cancelling…' } })
    },

    async generateFromPrompt(prompt) {
      if (get().llm.busy) return
      const controller = new AbortController()
      generateAbort = controller
      set({
        llm: {
          ...get().llm,
          busy: true,
          status: 'starting…',
          error: null,
          pending: null,
          explanation: null,
        },
      })
      try {
        const res = await generateCircuit({
          apiKey: get().llm.apiKey,
          prompt,
          boardConfig: boardConfigOf(get().layout),
          onStatus: (status) => {
            // don't let in-flight progress overwrite the 'cancelling…' status
            if (!controller.signal.aborted) set({ llm: { ...get().llm, status } })
          },
          signal: controller.signal,
        })
        set({
          llm: {
            ...get().llm,
            busy: false,
            status: '',
            pending: res.layout,
            explanation: res.explanation,
            error: null,
          },
        })
      } catch (err) {
        // user-initiated cancel returns the panel to idle without an error
        const cancelled = controller.signal.aborted
        set({
          llm: {
            ...get().llm,
            busy: false,
            status: '',
            error: cancelled ? null : err instanceof Error ? err.message : String(err),
          },
        })
      } finally {
        if (generateAbort === controller) generateAbort = null
      }
    },

    applyPending() {
      const pending = get().llm.pending
      if (!pending) return
      const res = get().loadLayout(pending)
      if (res.ok) {
        set({ llm: { ...get().llm, pending: null, explanation: null, error: null } })
      } else {
        set({
          llm: {
            ...get().llm,
            error: `Generated circuit failed validation: ${res.errors.join('; ')}`,
          },
        })
      }
    },

    discardPending() {
      set({ llm: { ...get().llm, pending: null, explanation: null } })
    },
  }
})
