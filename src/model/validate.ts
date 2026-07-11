/**
 * Layout validator: schema + placement + electrical sanity checks.
 * Owned by the llm agent. Used both by JSON import and by the LLM
 * generate→validate→repair loop, so error messages are written to be
 * actionable for a model fixing its own output.
 */

import type {
  BoardConfig,
  BoardSizeId,
  CircuitLayout,
  ComponentInstance,
  Hole,
  ParamValue,
  Rotation,
  Wire,
} from './types'
import {
  BOARD_SIZES,
  boardRowsOf,
  isBoardCount,
  isBoardRows,
  isBoardSizeId,
  isRotation,
  MAX_BOARD_COUNT,
  MAX_BOARD_ROWS,
} from './types'
import { occludedHoles } from './occlusion'
import {
  BOARD_ROW_PITCH,
  boardExtents,
  componentPinHoles,
  formatHole,
  isHoleOnBoard,
  moduleOfCol,
  netIdForHole,
  netIdForTerminal,
  offboardBodyRect,
  parseHole,
  parseTerminalRef,
  spansBoardRows,
  spansSeam,
} from './breadboard'
import { CATALOG, CatalogEntry, ParamDef } from './catalog'

export interface ValidationResult {
  ok: boolean
  errors: string[]
  warnings: string[]
  /** The cleaned, typed layout — present only when ok. */
  layout?: CircuitLayout
}

/** ids must start with a letter, then letters/digits/underscores (no ":"!). */
const ID_RE = /^[A-Za-z][A-Za-z0-9_]*$/

const ONE_LEAD_RULE =
  'a breadboard hole takes exactly one lead. All 5 holes of a strip column-half are the same net ' +
  '(e.g. a12–e12 are one net, f12–j12 another), so use a different free hole in the same strip instead'

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

// ---------------------------------------------------------------------------
// Movable off-board instruments ("pos")
// ---------------------------------------------------------------------------

/** Instruments snap to the 0.5 plan-unit grid (half a hole pitch). */
function isHalfStep(v: number): boolean {
  return Number.isInteger(v * 2)
}

/**
 * Keep explicit instrument positions inside a sane bench area: the router's
 * spatial hash uses exact integer cell keys only within ±~1800 plan units, so
 * the validator bounds |x|,|z| well inside that.
 */
const POS_LIMIT = 999

interface PlanRect {
  minX: number
  maxX: number
  minZ: number
  maxZ: number
}

/** Strict overlap — rects that merely touch edges do NOT overlap. */
function rectsOverlap(a: PlanRect, b: PlanRect): boolean {
  return a.minX < b.maxX && a.maxX > b.minX && a.minZ < b.maxZ && a.maxZ > b.minZ
}

function rectStr(r: PlanRect): string {
  return `x ${r.minX}..${r.maxX}, z ${r.minZ}..${r.maxZ}`
}

/**
 * Human label of a rig: the bare preset label for a single board ("Standard",
 * byte-identical to the pre-multi-board messages), "Standard ×3" for a rig.
 */
function rigLabel(config: BoardConfig): string {
  const label = BOARD_SIZES[config.size].label
  return config.count > 1 ? `${label} ×${config.count}` : label
}

/**
 * "…a80 is off the Standard board (63 columns) — use the Lab XL board or move
 * it". `what` is the already-quoted/described ref, e.g. `"a80"`. Bounds are
 * rig-wide (columns/rail indices are continuous across modules). A ref whose
 * BOARD-ROW prefix points past the grid gets a row-specific message instead.
 */
function offBoardError(what: string, h: Hole, config: BoardConfig): string {
  const rows = boardRowsOf(config)
  const boardRow = h.boardRow ?? 0
  if (boardRow < 0 || boardRow >= rows) {
    const have =
      rows === 1
        ? 'only the front board-row (bare refs like "a12", no row prefix)'
        : `board-rows 0..${rows - 1} (front row bare, deeper rows prefixed "1:".."${rows - 1}:")`
    const fix =
      rows < MAX_BOARD_ROWS
        ? `set "boardRows" to at least ${boardRow + 1} (max ${MAX_BOARD_ROWS}) or move it to an existing board-row`
        : 'move it to an existing board-row'
    return `${what} is on board-row ${boardRow}, but the rig has ${have} — ${fix}`
  }
  const size = BOARD_SIZES[config.size]
  const extent =
    h.kind === 'strip'
      ? `${size.cols * config.count} columns`
      : `rail holes 0..${size.railHoles * config.count - 1}`
  const fix =
    config.size === 'labxl'
      ? config.count < MAX_BOARD_COUNT
        ? 'add another board or move it'
        : 'move it onto the board'
      : `use the ${BOARD_SIZES.labxl.label} board or move it`
  return `${what} is off the ${rigLabel(config)} board (${extent}) — ${fix}`
}

/** Rig-specific hint of the valid hole-ref ranges, for error messages. */
function holeRangeHint(config: BoardConfig): string {
  const size = BOARD_SIZES[config.size]
  const base = `use "a1".."j${size.cols * config.count}" or "top+0".."bot-${size.railHoles * config.count - 1}"`
  const rows = boardRowsOf(config)
  return rows > 1
    ? `${base}; holes on board-rows behind the front row take a 0-indexed "row:" prefix, "1:".."${rows - 1}:" (e.g. "1:a12", "${rows - 1}:top+5")`
    : base
}

function describeParamKind(def: ParamDef): string {
  switch (def.kind) {
    case 'number':
      return 'a number'
    case 'boolean':
      return 'a boolean'
    case 'select':
      return `one of ${def.options?.map((o) => `"${o}"`).join(', ') ?? 'its options'}`
    case 'text':
      return 'a string'
  }
}

function checkParamValue(def: ParamDef, value: unknown): string | null {
  switch (def.kind) {
    case 'number':
      if (typeof value !== 'number' || !Number.isFinite(value)) return describeParamKind(def)
      return null
    case 'boolean':
      if (typeof value !== 'boolean') return describeParamKind(def)
      return null
    case 'select':
      if (typeof value !== 'string') return describeParamKind(def)
      if (def.options && !def.options.includes(value)) return describeParamKind(def)
      return null
    case 'text':
      if (typeof value !== 'string') return describeParamKind(def)
      return null
  }
}

// ---------------------------------------------------------------------------
// Minimal union-find for the electrical warnings (kept local so this module
// works even before/without src/sim/netlist.ts).
// ---------------------------------------------------------------------------

class UnionFind {
  private parent = new Map<string, string>()

  find(x: string): string {
    let root = x
    while (true) {
      const p = this.parent.get(root)
      if (p === undefined || p === root) break
      root = p
    }
    // path compression
    let cur = x
    while (cur !== root) {
      const next = this.parent.get(cur)!
      this.parent.set(cur, root)
      cur = next
    }
    return root
  }

  union(a: string, b: string): void {
    const ra = this.find(a)
    const rb = this.find(b)
    if (ra !== rb) this.parent.set(ra, rb)
  }
}

interface ValidComponent {
  comp: ComponentInstance
  entry: CatalogEntry
  /** per-pin holes for on-board parts; null entries for off-board terminals */
  pinHoles: (Hole | null)[] | null
}

export function validateLayout(input: unknown): ValidationResult {
  const errors: string[] = []
  const warnings: string[] = []

  // ---- top level shape -----------------------------------------------------
  if (!isPlainObject(input)) {
    return {
      ok: false,
      errors: ['layout must be a JSON object with "version", "components" and "wires"'],
      warnings,
    }
  }
  if (input.version !== 1) {
    errors.push(`"version" must be the number 1 (got ${JSON.stringify(input.version ?? null)})`)
  }
  if (!Array.isArray(input.components)) errors.push('"components" must be an array')
  if (!Array.isArray(input.wires)) errors.push('"wires" must be an array')
  if (errors.length > 0) return { ok: false, errors, warnings }

  // board size preset (absent = 'standard'; unknown value = error)
  let board: BoardSizeId = 'standard'
  if (input.board !== undefined) {
    if (isBoardSizeId(input.board)) {
      board = input.board
    } else {
      errors.push(
        `"board" must be one of ${Object.keys(BOARD_SIZES)
          .map((k) => `"${k}"`)
          .join(', ')} (got ${JSON.stringify(input.board)}) — or omit it for the standard board`,
      )
    }
  }
  // module count (absent = 1 board; non-integer / out-of-range = error)
  let boardCount = 1
  if (input.boardCount !== undefined) {
    if (isBoardCount(input.boardCount)) {
      boardCount = input.boardCount
    } else {
      errors.push(
        `"boardCount" must be an integer from 1 to ${MAX_BOARD_COUNT} (got ${JSON.stringify(
          input.boardCount,
        )}) — or omit it for a single board`,
      )
    }
  }
  // board-row count (absent = 1 row of boards; non-integer / out-of-range = error)
  let boardRows = 1
  if (input.boardRows !== undefined) {
    if (isBoardRows(input.boardRows)) {
      boardRows = input.boardRows
    } else {
      errors.push(
        `"boardRows" must be an integer from 1 to ${MAX_BOARD_ROWS} (got ${JSON.stringify(
          input.boardRows,
        )}) — or omit it for a single row of boards`,
      )
    }
  }
  const config: BoardConfig = { size: board, count: boardCount, rows: boardRows }
  const boardSize = BOARD_SIZES[board]
  const totalCols = boardSize.cols * boardCount

  const rawComponents = input.components as unknown[]
  const rawWires = input.wires as unknown[]

  // ---- components ----------------------------------------------------------
  const components: ComponentInstance[] = []
  const byId = new Map<string, ValidComponent>()
  const seenComponentIds = new Set<string>()
  /** hole ref → human description of what already occupies it */
  const occupancy = new Map<string, string>()
  /** instrument body rects placed so far (default-shelf or explicit pos) */
  const offboardUnits: { id: string; rect: PlanRect }[] = []
  /** index among off-board components in layout order — the render slot */
  let offboardSlot = 0

  const claimHole = (h: Hole, desc: string) => {
    const ref = formatHole(h)
    const prev = occupancy.get(ref)
    if (prev !== undefined) {
      errors.push(`hole "${ref}" is used by both ${prev} and ${desc} — ${ONE_LEAD_RULE}`)
    } else {
      occupancy.set(ref, desc)
    }
  }

  for (let i = 0; i < rawComponents.length; i++) {
    const raw = rawComponents[i]
    if (!isPlainObject(raw)) {
      errors.push(`components[${i}] must be an object`)
      continue
    }

    // id
    const idOk = typeof raw.id === 'string' && ID_RE.test(raw.id)
    const id = typeof raw.id === 'string' ? raw.id : `components[${i}]`
    if (typeof raw.id !== 'string' || raw.id.length === 0) {
      errors.push(`components[${i}] is missing a string "id"`)
    } else if (!ID_RE.test(raw.id)) {
      errors.push(
        `component id "${raw.id}" is invalid — ids must start with a letter and contain only letters, digits and underscores`,
      )
    } else if (seenComponentIds.has(raw.id)) {
      errors.push(`duplicate component id "${raw.id}" — every component needs a unique id`)
      continue
    }
    if (typeof raw.id === 'string') seenComponentIds.add(raw.id)

    // type
    if (typeof raw.type !== 'string' || raw.type.length === 0) {
      errors.push(`component "${id}" is missing a string "type"`)
      continue
    }
    const entry = CATALOG[raw.type]
    if (!entry) {
      errors.push(`component "${id}" has unknown type "${raw.type}" — use only catalog types`)
      continue
    }

    // params
    let params: Record<string, ParamValue> | undefined
    if (raw.params !== undefined) {
      if (!isPlainObject(raw.params)) {
        errors.push(`component "${id}": "params" must be an object of key → value`)
      } else {
        params = {}
        for (const [key, value] of Object.entries(raw.params)) {
          const def = entry.params?.find((p) => p.key === key)
          if (!def) {
            const valid = entry.params?.map((p) => p.key)
            errors.push(
              `component "${id}" (${entry.type}) has unknown param "${key}"` +
                (valid && valid.length > 0 ? ` — valid params: ${valid.join(', ')}` : ' — this type has no params'),
            )
            continue
          }
          const wanted = checkParamValue(def, value)
          if (wanted !== null) {
            errors.push(
              `component "${id}" param "${key}" must be ${wanted} (got ${JSON.stringify(value)})`,
            )
            continue
          }
          params[key] = value as ParamValue
        }
        if (Object.keys(params).length === 0) params = undefined
      }
    }

    // rotation (dip/footprint packages only; absent = 0)
    let rotation: Rotation = 0
    if (raw.rotation !== undefined) {
      if (
        entry.placement === 'leads' ||
        entry.placement === 'probe' ||
        entry.placement === 'offboard'
      ) {
        errors.push(
          `component "${id}" (${entry.type}) does not take "rotation" — only dip and footprint packages rotate; leaded parts orient by their hole placement and off-board instruments have no orientation. Remove the field`,
        )
      } else if (!isRotation(raw.rotation)) {
        errors.push(
          `component "${id}" "rotation" must be 0, 90, 180 or 270 (got ${JSON.stringify(raw.rotation)}) — or omit it for no rotation`,
        )
      } else if (entry.placement === 'dip' && (raw.rotation === 90 || raw.rotation === 270)) {
        errors.push(
          `component "${id}" (${entry.type}) cannot use rotation ${raw.rotation} — rotating a DIP 90 would put every pin in one strip column, shorting them; use 0 or 180 (180 spins the package in place: same holes, pin 1 moves to the row-e right end)`,
        )
      } else {
        rotation = raw.rotation
      }
    }

    // placement
    let pinHoles: (Hole | null)[] | null = null
    let placementOk = true
    /** explicit instrument position (off-board only), validated below */
    let pos: { x: number; z: number } | undefined
    if (raw.pos !== undefined && entry.placement !== 'offboard') {
      const anchor =
        entry.placement === 'dip' || entry.placement === 'footprint' ? '"at"' : '"holes"'
      errors.push(
        `component "${id}" (${entry.type}) sits ON the board — "pos" is only for off-board instruments (power supply, function generator); place it with ${anchor} instead`,
      )
    }
    switch (entry.placement) {
      case 'offboard': {
        if (raw.holes !== undefined || raw.at !== undefined) {
          errors.push(
            `component "${id}" (${entry.type}) is an off-board instrument — it has no "holes" or "at"; wire its terminals like "${id}:${entry.pins[0]}" instead`,
          )
          placementOk = false
        }
        // explicit position (movable instruments): 0.5-grid plan coordinates
        let posOk = true
        if (raw.pos !== undefined) {
          const p = raw.pos
          if (
            !isPlainObject(p) ||
            typeof p.x !== 'number' ||
            !Number.isFinite(p.x) ||
            typeof p.z !== 'number' ||
            !Number.isFinite(p.z)
          ) {
            errors.push(
              `component "${id}" (${entry.type}) "pos" must be an object {"x": <number>, "z": <number>} in plan units (got ${JSON.stringify(raw.pos)}) — or omit it for the default instrument shelf left of the board`,
            )
            posOk = false
          } else if (
            !isHalfStep(p.x) ||
            !isHalfStep(p.z) ||
            Math.abs(p.x) > POS_LIMIT ||
            Math.abs(p.z) > POS_LIMIT
          ) {
            errors.push(
              `component "${id}" "pos" (${p.x}, ${p.z}) is off the placement grid — instrument positions snap to 0.5 plan units (and |x|, |z| ≤ ${POS_LIMIT})`,
            )
            posOk = false
          } else {
            pos = { x: p.x, z: p.z }
          }
        }
        // body-rect rules: the unit (default shelf slot or explicit pos) must
        // sit clear of the active rig's board AND of every other instrument
        const slot = offboardSlot++
        if (posOk) {
          const rect = offboardBodyRect(slot, pos)
          const ext = boardExtents(config)
          if (rectsOverlap(rect, ext)) {
            errors.push(
              `instrument "${id}" body (${rectStr(rect)}) overlaps the ${rigLabel(config)} board (${rectStr(ext)}) — move its "pos" clear of the board (the default shelf to the left is always free)`,
            )
          }
          for (const u of offboardUnits) {
            if (rectsOverlap(rect, u.rect)) {
              errors.push(
                `instrument "${id}" body (${rectStr(rect)}) overlaps instrument "${u.id}" (${rectStr(u.rect)}) — instrument boxes need clear bench space; move one of them`,
              )
            }
          }
          offboardUnits.push({ id, rect })
        } else {
          placementOk = false
        }
        pinHoles = entry.pins.map(() => null)
        break
      }
      case 'leads':
      case 'probe': {
        const n = entry.pins.length
        if (!Array.isArray(raw.holes)) {
          errors.push(
            `component "${id}" (${entry.type}) needs "holes": an array of ${n} hole ref${n === 1 ? '' : 's'} (one per pin: ${entry.pins.join(', ')})`,
          )
          placementOk = false
          break
        }
        if (raw.holes.length !== n) {
          errors.push(
            `component "${id}" (${entry.type}) has ${raw.holes.length} holes but needs exactly ${n} (pin order: ${entry.pins.join(', ')})`,
          )
          placementOk = false
          break
        }
        const holes: Hole[] = []
        for (let j = 0; j < raw.holes.length; j++) {
          const ref = raw.holes[j]
          const h = typeof ref === 'string' ? parseHole(ref) : null
          if (!h) {
            errors.push(
              `component "${id}" holes[${j}] (${JSON.stringify(ref)}) is not a valid hole ref — ${holeRangeHint(config)}`,
            )
            placementOk = false
            continue
          }
          if (!isHoleOnBoard(h, config)) {
            errors.push(
              `component "${id}" holes[${j}]: ` + offBoardError(`"${formatHole(h)}"`, h, config),
            )
            placementOk = false
            continue
          }
          holes.push(h)
        }
        if (placementOk) pinHoles = holes
        break
      }
      case 'dip':
      case 'footprint': {
        if (typeof raw.at !== 'string' || raw.at.length === 0) {
          errors.push(
            `component "${id}" (${entry.type}) needs "at": the hole of pin 1${entry.placement === 'dip' ? ' (must be in row "f")' : ''}`,
          )
          placementOk = false
          break
        }
        const at = parseHole(raw.at)
        if (!at) {
          errors.push(
            `component "${id}" "at" (${JSON.stringify(raw.at)}) is not a valid hole ref — ${holeRangeHint(config)}`,
          )
          placementOk = false
          break
        }
        const candidate: ComponentInstance = { id, type: entry.type, at: raw.at }
        if (rotation !== 0) candidate.rotation = rotation
        pinHoles = componentPinHoles(candidate, entry, config)
        if (pinHoles === null) {
          const fix = board === 'labxl' ? 'move it left' : `use the ${BOARD_SIZES.labxl.label} board or move it left`
          const anchorRow = at.boardRow ?? 0
          if (entry.placement === 'dip' && (at.kind !== 'strip' || at.row !== 'f')) {
            errors.push(
              rotation === 180
                ? `component "${id}" (${entry.type}) DIP anchor "${raw.at}" is invalid — even at rotation 180 "at" names the row-f hole at the LEFT end of the package (a DIP at 180 occupies the same holes; only the pin walk reverses, putting pin 1 at the row-e right end)`
                : `component "${id}" (${entry.type}) DIP anchor "${raw.at}" is invalid — pin 1 must sit in row "f" (pins 1..${entry.pins.length / 2} run along row f, the rest back along row e)`,
            )
          } else if (anchorRow < 0 || anchorRow >= boardRows) {
            // the anchor's board-row prefix points past the grid
            errors.push(
              `component "${id}" (${entry.type}) "at": ` +
                offBoardError(`"${raw.at}"`, at, config),
            )
          } else if (entry.placement === 'footprint' && rotation !== 0) {
            errors.push(
              `component "${id}" (${entry.type}) footprint rotated ${rotation} does not fit with pin 1 at "${raw.at}" — the rotated pin offsets run off the board (rows a..j, ${totalCols} columns); choose another rotation or move the anchor`,
            )
          } else if (entry.placement === 'dip' && at.kind === 'strip') {
            errors.push(
              `component "${id}" (${entry.type}) at "${raw.at}" runs off the ${rigLabel(config)} board — a ${entry.pins.length}-pin DIP needs columns ${at.col}..${at.col + entry.pins.length / 2 - 1}, but the ${rigLabel(config)} board only has ${totalCols} columns — ${fix}`,
            )
          } else {
            errors.push(
              `component "${id}" (${entry.type}) footprint does not fit with pin 1 at "${raw.at}" — the package would run off the ${rigLabel(config)} board (${totalCols} columns) — ${fix}`,
            )
          }
          placementOk = false
        } else if (spansBoardRows(pinHoles)) {
          // pins resolving to different board-rows is a geometric impossibility
          // for a rigid package (rows are BOARD_ROW_PITCH apart) — validated
          // defensively with a clear error
          errors.push(
            `component "${id}" (${entry.type}) at "${raw.at}" has pins on more than one board-row — board-rows sit ${BOARD_ROW_PITCH} hole-pitches apart, so a rigid package must sit entirely on ONE board-row; anchor every pin on the same row`,
          )
          placementOk = false
          pinHoles = null
        } else if (spansSeam(pinHoles, config)) {
          // a rigid dip/footprint package cannot straddle the physical gap
          // between two ganged board modules (wires and leaded parts may)
          const leftCol = Math.min(
            ...pinHoles.flatMap((h) => (h && h.kind === 'strip' ? [h.col] : [])),
          )
          const m = moduleOfCol(leftCol, board)
          errors.push(
            `component "${id}" (${entry.type}) at "${raw.at}" crosses the seam between board ${m} and board ${m + 1} — a rigid package cannot straddle the gap between modules; shift it left or right`,
          )
          placementOk = false
          pinHoles = null
        }
        break
      }
    }

    // occupancy
    if (placementOk && pinHoles && entry.placement !== 'offboard') {
      for (let j = 0; j < pinHoles.length; j++) {
        const h = pinHoles[j]
        if (h) claimHole(h, `pin ${entry.pins[j]} of "${id}"`)
      }
    }

    const comp: ComponentInstance = { id, type: entry.type }
    if (params) comp.params = params
    if (entry.placement === 'leads' || entry.placement === 'probe') {
      if (Array.isArray(raw.holes)) comp.holes = raw.holes.filter((h): h is string => typeof h === 'string')
    }
    if ((entry.placement === 'dip' || entry.placement === 'footprint') && typeof raw.at === 'string') {
      comp.at = raw.at
      // canonical form: rotation 0 stays absent (back-compat round-trips)
      if (rotation !== 0) comp.rotation = rotation
    }
    if (entry.placement === 'offboard' && pos) comp.pos = pos // round-trips export/import
    components.push(comp)
    if (idOk && !byId.has(id)) byId.set(id, { comp, entry, pinHoles: placementOk ? pinHoles : null })
  }

  // ---- wires ---------------------------------------------------------------
  const wires: Wire[] = []
  const seenWireIds = new Set<string>()

  for (let i = 0; i < rawWires.length; i++) {
    const raw = rawWires[i]
    if (!isPlainObject(raw)) {
      errors.push(`wires[${i}] must be an object`)
      continue
    }
    const id = typeof raw.id === 'string' ? raw.id : `wires[${i}]`
    if (typeof raw.id !== 'string' || raw.id.length === 0) {
      errors.push(`wires[${i}] is missing a string "id"`)
    } else if (!ID_RE.test(raw.id)) {
      errors.push(
        `wire id "${raw.id}" is invalid — ids must start with a letter and contain only letters, digits and underscores`,
      )
    } else if (seenWireIds.has(raw.id)) {
      errors.push(`duplicate wire id "${raw.id}" — every wire needs a unique id`)
    } else {
      seenWireIds.add(raw.id)
    }

    let endpointsOk = true
    for (const endName of ['from', 'to'] as const) {
      const value = raw[endName]
      if (typeof value !== 'string' || value.length === 0) {
        errors.push(`wire "${id}" is missing a string "${endName}" endpoint`)
        endpointsOk = false
        continue
      }
      const hole = parseHole(value)
      if (hole) {
        // bounds only — wires MAY cross module seams freely
        if (!isHoleOnBoard(hole, config)) {
          errors.push(`wire "${id}" ${endName}: ` + offBoardError(`"${value}"`, hole, config))
          endpointsOk = false
          continue
        }
        claimHole(hole, `the "${endName}" end of wire "${id}"`)
        continue
      }
      const term = parseTerminalRef(value)
      if (!term) {
        errors.push(
          `wire "${id}" ${endName} (${JSON.stringify(value)}) is neither a hole ref (like "c12" or "top+3") nor an off-board terminal (like "PS1:+")`,
        )
        endpointsOk = false
        continue
      }
      const target = byId.get(term.componentId)
      if (!target) {
        errors.push(
          `wire "${id}" ${endName} ("${value}") references unknown component "${term.componentId}"`,
        )
        endpointsOk = false
        continue
      }
      if (target.entry.placement !== 'offboard') {
        errors.push(
          `wire "${id}" ${endName} ("${value}") targets "${term.componentId}" which sits ON the board — only off-board instruments have "ID:PIN" terminals; connect the wire to a free hole in the same strip column as that pin instead`,
        )
        endpointsOk = false
        continue
      }
      if (!target.entry.pins.includes(term.pin)) {
        errors.push(
          `wire "${id}" ${endName} ("${value}"): "${term.componentId}" (${target.entry.type}) has no terminal "${term.pin}" — terminals: ${target.entry.pins.map((p) => `"${term.componentId}:${p}"`).join(', ')}`,
        )
        endpointsOk = false
        continue
      }
    }

    if (typeof raw.from === 'string' && typeof raw.to === 'string' && endpointsOk) {
      const wire: Wire = { id, from: raw.from, to: raw.to }
      if (typeof raw.color === 'string' && raw.color.length > 0) wire.color = raw.color
      wires.push(wire)
    }
  }

  // ---- body occlusion --------------------------------------------------------
  // A part's molded body can cover holes beyond its own pins (potentiometer
  // overhang, pushbutton middle column — bodyFootprint in the catalog).
  // Nothing may plug into a covered hole: not another component's pin, not a
  // wire end. The occupancy map already knows every claimed hole, and
  // occludedHoles() never reports the part's own pins.
  for (const vc of byId.values()) {
    if (!vc.pinHoles) continue
    for (const ref of occludedHoles(vc.comp, vc.entry, config)) {
      const victim = occupancy.get(ref)
      if (victim !== undefined) {
        errors.push(
          `hole "${ref}" (${victim}) is covered by ${vc.comp.id}'s body — pick a hole clear of the overhang`,
        )
      }
    }
  }

  // ---- warnings (static electrical checks) ----------------------------------
  const supplies = [...byId.values()].filter((c) => c.entry.type === 'power_supply')
  if (supplies.length === 0) {
    warnings.push(
      'no power_supply in the layout — add one and wire its "+" and "-" terminals to the power rails',
    )
  }

  if (errors.length === 0) {
    // Local union-find netlist: seed static nets, merge across wires and
    // internal bridges, then check chip supply pins against supply terminals.
    const uf = new UnionFind()
    const netOfEndpoint = (ref: string): string | null => {
      const h = parseHole(ref)
      if (h) return netIdForHole(h)
      const t = parseTerminalRef(ref)
      if (t) return netIdForTerminal(t.componentId, t.pin)
      return null
    }
    for (const w of wires) {
      const a = netOfEndpoint(w.from)
      const b = netOfEndpoint(w.to)
      if (a && b) uf.union(a, b)
    }
    const netOfPin = (vc: ValidComponent, pinName: string): string | null => {
      const idx = vc.entry.pins.indexOf(pinName)
      if (idx < 0) return null
      if (vc.entry.placement === 'offboard') return netIdForTerminal(vc.comp.id, pinName)
      const h = vc.pinHoles?.[idx]
      return h ? netIdForHole(h) : null
    }
    for (const vc of byId.values()) {
      for (const [a, b] of vc.entry.internalBridges ?? []) {
        const na = netOfPin(vc, a)
        const nb = netOfPin(vc, b)
        if (na && nb) uf.union(na, nb)
      }
    }

    if (supplies.length > 0) {
      const plusRoots = new Set(supplies.map((s) => uf.find(netIdForTerminal(s.comp.id, '+'))))
      const minusRoots = new Set(supplies.map((s) => uf.find(netIdForTerminal(s.comp.id, '-'))))
      for (const vc of byId.values()) {
        if (vc.entry.sim.kind !== 'chip') continue
        for (let j = 0; j < vc.entry.pins.length; j++) {
          const pin = vc.entry.pins[j]
          const h = vc.pinHoles?.[j]
          if (!h) continue
          const root = uf.find(netIdForHole(h))
          if ((pin === 'VCC' || pin === 'VDD') && !plusRoots.has(root)) {
            warnings.push(
              `chip "${vc.comp.id}" (${vc.entry.type}) supply pin ${pin} (hole ${formatHole(h)}) is not connected to any power supply "+" — wire its strip to the + rail`,
            )
          }
          if ((pin === 'GND' || pin === 'VSS') && !minusRoots.has(root)) {
            warnings.push(
              `chip "${vc.comp.id}" (${vc.entry.type}) supply pin ${pin} (hole ${formatHole(h)}) is not connected to any power supply "-" — wire its strip to the - (ground) rail`,
            )
          }
        }
      }
    }
  }

  if (errors.length > 0) return { ok: false, errors, warnings }

  const layout: CircuitLayout = { version: 1, components, wires }
  if (input.board !== undefined) layout.board = board // validated above
  if (input.boardCount !== undefined) layout.boardCount = boardCount // validated above
  if (input.boardRows !== undefined) layout.boardRows = boardRows // validated above
  if (typeof input.name === 'string' && input.name.length > 0) layout.name = input.name
  if (typeof input.description === 'string' && input.description.length > 0) {
    layout.description = input.description
  }
  return { ok: true, errors, warnings, layout }
}
