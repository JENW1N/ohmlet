/**
 * Structured-output wire format for circuit generation.
 *
 * The installed @anthropic-ai/sdk (0.104.x) supports both strict forced tools
 * and `output_config.format` json_schema. We use `output_config.format`
 * because it is the canonical structured-output surface and—unlike a forced
 * `tool_choice: {type:"tool"}`—composes cleanly with adaptive thinking.
 *
 * Because component params vary by type (and structured-output JSON schemas
 * require `additionalProperties: false` everywhere, which rules out free-form
 * maps), the wire format encodes params as an ARRAY of {key, value} pairs.
 * The converters below translate wire format ⇄ CircuitLayout.
 */

import type {
  BoardConfig,
  BoardSizeId,
  CircuitLayout,
  ComponentInstance,
  ParamValue,
  Wire,
} from '../model/types'
import {
  asBoardConfig,
  BOARD_SIZES,
  isBoardCount,
  isBoardRows,
  isBoardSizeId,
  MAX_BOARD_COUNT,
  MAX_BOARD_ROWS,
} from '../model/types'
import { CATALOG } from '../model/catalog'

// ---------------------------------------------------------------------------
// Wire-format types (what the model emits)
// ---------------------------------------------------------------------------

export interface EmitParam {
  key: string
  value: ParamValue
}

export interface EmitComponent {
  id: string
  type: string
  /** pin-1 hole for dip/footprint placements; null for everything else */
  at: string | null
  /** one hole per pin for leads/probe placements; [] for everything else */
  holes: string[]
  /** catalog params to override; [] keeps all defaults */
  params: EmitParam[]
  /**
   * dip/footprint placements only: in-plane rotation in clockwise quarter
   * turns (0|90|180|270; DIP packages allow only 0|180). null = unrotated;
   * null for every other placement.
   */
  rotation: number | null
}

export interface EmitWire {
  id: string
  from: string
  to: string
  /** cosmetic wire color (red for +, black for -, others for signals); null = default */
  color: string | null
}

export interface EmitCircuit {
  name: string
  /**
   * Board size preset the circuit is laid out for; null = the active board
   * (resolved by emitToLayout's activeBoard argument; when no active board is
   * supplied the field stays absent, which loaders treat as 'standard'). The
   * model may pick a larger preset when the request needs more room than the
   * active board offers.
   */
  board: BoardSizeId | null
  /**
   * Number of ganged board modules (1..6) the circuit is laid out for; null =
   * the active rig's count (resolved like `board`; absent context = 1). The
   * model may pick a larger count when the request needs more width than the
   * active rig offers.
   */
  boardCount: number | null
  /**
   * Number of board-rows (1..4) stacked front-to-back; null = the active
   * rig's rows (resolved like `board`; absent context = 1). Each board-row
   * has its own independent power rails; hole refs on rows beyond the first
   * carry the 0-indexed "1:" / "2:" / "3:" prefix. The model may pick a
   * larger value when the request needs more depth than the active rig
   * offers.
   */
  boardRows: number | null
  components: EmitComponent[]
  wires: EmitWire[]
}

// ---------------------------------------------------------------------------
// Expectations: machine-testable claims about the circuit's observable
// behavior. The generate pipeline builds the circuit in the simulator and
// verifies every declared expectation (src/llm/verify.ts).
// ---------------------------------------------------------------------------

export const EXPECTATION_KINDS = [
  'led_on',
  'led_off',
  'led_blinks',
  'segments_show',
  'net_oscillates',
  'net_in_range',
  'buzzer_sounds',
] as const

export type ExpectationKind = (typeof EXPECTATION_KINDS)[number]

/**
 * Slowest frequency bound (Hz) the verifier can actually measure: it requires
 * at least 2 off→on transitions inside its sampling window, which is capped at
 * 8 sim-seconds, so bounds below 2/8 Hz are mathematically unverifiable.
 * emitToExpectations clamps model-declared bounds up to this floor and the
 * system prompt forbids declaring slower ones.
 */
export const MIN_VERIFIABLE_HZ = 0.25

/** App-side expectation (unused fields omitted instead of null). */
export interface Expectation {
  kind: ExpectationKind
  /** component id (led/display/buzzer kinds) or hole ref (net_* kinds) */
  target: string
  /** segments_show only: the digit '0'..'9' the display must show */
  digit?: string
  /** led_blinks / net_oscillates: frequency bounds (Hz) */
  minHz?: number
  maxHz?: number
  /** net_in_range: voltage bounds (V) */
  minV?: number
  maxV?: number
}

/** Wire-format expectation (every unused field present but null). */
export interface EmitExpectation {
  kind: ExpectationKind
  target: string
  digit: string | null
  minHz: number | null
  maxHz: number | null
  minV: number | null
  maxV: number | null
}

/** Top-level structured output: a human explanation plus the circuit. */
export interface EmitEnvelope {
  explanation: string
  circuit: EmitCircuit
  /** REQUIRED testable claims (may be [] only when the circuit has no LED/display/buzzer) */
  expectations: EmitExpectation[]
}

// ---------------------------------------------------------------------------
// JSON schema (structured outputs require additionalProperties:false on every
// object and forbid numeric/string constraints, so we keep it purely
// structural; deep validation happens in validateLayout()).
// ---------------------------------------------------------------------------

const COMPONENT_TYPES: string[] = Object.keys(CATALOG)

const PARAM_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['key', 'value'],
  properties: {
    key: { type: 'string', description: 'param key from the catalog (e.g. "resistance")' },
    value: {
      anyOf: [{ type: 'number' }, { type: 'string' }, { type: 'boolean' }],
      description: 'param value; numbers are plain SI units (ohms, farads, volts, hertz)',
    },
  },
} as const

const COMPONENT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['id', 'type', 'at', 'holes', 'params', 'rotation'],
  properties: {
    id: {
      type: 'string',
      description: 'unique id, letter then letters/digits/underscores (R1, U2, D3, PS1, SW1...)',
    },
    type: { type: 'string', enum: COMPONENT_TYPES, description: 'catalog component type' },
    at: {
      anyOf: [{ type: 'string' }, { type: 'null' }],
      description:
        'dip/footprint placements only: the hole of pin 1 (DIP pin 1 must be in row "f"). null for all other placements.',
    },
    holes: {
      type: 'array',
      items: { type: 'string' },
      description:
        'leads/probe placements only: exactly one hole ref per pin, in catalog pin order. [] for all other placements.',
    },
    params: {
      type: 'array',
      items: PARAM_SCHEMA,
      description: 'param overrides as {key,value} pairs; [] keeps catalog defaults',
    },
    rotation: {
      anyOf: [{ type: 'integer' }, { type: 'null' }],
      description:
        'dip/footprint placements only: in-plane rotation in clockwise quarter turns — 0|90|180|270 for footprint parts, 0|180 ONLY for DIP packages (90/270 would short every pin pair into one strip column). null for all other placements and for unrotated parts.',
    },
  },
} as const

const WIRE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['id', 'from', 'to', 'color'],
  properties: {
    id: { type: 'string', description: 'unique wire id (w1, w2...)' },
    from: {
      type: 'string',
      description: 'hole ref ("c12", "top+3") or off-board terminal ("PS1:+")',
    },
    to: {
      type: 'string',
      description: 'hole ref ("c12", "top+3") or off-board terminal ("PS1:+")',
    },
    color: {
      anyOf: [{ type: 'string' }, { type: 'null' }],
      description: 'red for +, black for -/ground, other colors for signals; null = default',
    },
  },
} as const

const EXPECTATION_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['kind', 'target', 'digit', 'minHz', 'maxHz', 'minV', 'maxV'],
  properties: {
    kind: {
      type: 'string',
      enum: EXPECTATION_KINDS,
      description:
        'testable behavior kind: led_on | led_off | led_blinks | segments_show | net_oscillates | net_in_range | buzzer_sounds',
    },
    target: {
      type: 'string',
      description:
        'component id for led_*/segments_show/buzzer_sounds (segments_show targets a seven_segment id); a hole ref (e.g. "f12") for net_* kinds',
    },
    digit: {
      anyOf: [{ type: 'string' }, { type: 'null' }],
      description: 'segments_show only: the digit "0".."9" the display must show; null otherwise',
    },
    minHz: {
      anyOf: [{ type: 'number' }, { type: 'null' }],
      description: 'led_blinks / net_oscillates: lower frequency bound in Hz; null otherwise',
    },
    maxHz: {
      anyOf: [{ type: 'number' }, { type: 'null' }],
      description: 'led_blinks / net_oscillates: upper frequency bound in Hz; null otherwise',
    },
    minV: {
      anyOf: [{ type: 'number' }, { type: 'null' }],
      description: 'net_in_range only: lower voltage bound in volts; null otherwise',
    },
    maxV: {
      anyOf: [{ type: 'number' }, { type: 'null' }],
      description: 'net_in_range only: upper voltage bound in volts; null otherwise',
    },
  },
} as const

/** JSON schema handed to the API via output_config.format (json_schema). */
export const CIRCUIT_OUTPUT_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  required: ['explanation', 'circuit', 'expectations'],
  properties: {
    explanation: {
      type: 'string',
      description:
        'Short, friendly explanation of how the circuit works and how to interact with it (2-6 sentences).',
    },
    circuit: {
      type: 'object',
      additionalProperties: false,
      required: ['name', 'board', 'boardCount', 'boardRows', 'components', 'wires'],
      properties: {
        name: { type: 'string', description: 'short circuit title' },
        board: {
          anyOf: [{ type: 'string', enum: Object.keys(BOARD_SIZES) }, { type: 'null' }],
          description:
            'board size preset the circuit is laid out for ("half" | "standard" | "labxl"); null = the active board. Pick a larger preset only when the circuit needs more columns/rail holes than the active board has.',
        },
        boardCount: {
          anyOf: [{ type: 'integer' }, { type: 'null' }],
          description:
            `number of identical board modules ganged side by side (1..${MAX_BOARD_COUNT}); null = the active rig's count. Column numbering is continuous across modules and the power rails are bused into single nets. Pick a larger count only when the circuit needs more width than the active rig has.`,
        },
        boardRows: {
          anyOf: [{ type: 'integer' }, { type: 'null' }],
          description:
            `number of board-rows stacked front-to-back (1..${MAX_BOARD_ROWS}); null = the active rig's rows. Holes on board-row r >= 1 use the 0-indexed prefix "r:" ("1:a12", "2:top+5"); the front row is bare. Rails on different board-rows are INDEPENDENT nets — jumper power between rows. Pick a larger value only when the circuit needs more depth than the active rig has.`,
        },
        components: { type: 'array', items: COMPONENT_SCHEMA },
        wires: { type: 'array', items: WIRE_SCHEMA },
      },
    },
    expectations: {
      type: 'array',
      items: EXPECTATION_SCHEMA,
      description:
        '1-4 machine-testable claims about the observable behavior; the circuit is simulated and verified against them. [] only for circuits with no LED, display or buzzer.',
    },
  },
}

// ---------------------------------------------------------------------------
// Converters: wire format ⇄ CircuitLayout
// ---------------------------------------------------------------------------

/** CircuitLayout → wire format (used to embed worked examples in the prompt). */
export function layoutToEmit(layout: CircuitLayout): EmitCircuit {
  return {
    name: layout.name ?? '',
    board: layout.board ?? null,
    boardCount: layout.boardCount ?? null,
    boardRows: layout.boardRows ?? null,
    components: layout.components.map((c): EmitComponent => ({
      id: c.id,
      type: c.type,
      at: c.at ?? null,
      holes: c.holes ? [...c.holes] : [],
      params: c.params
        ? Object.entries(c.params).map(([key, value]): EmitParam => ({ key, value }))
        : [],
      rotation: c.rotation ?? null,
    })),
    wires: layout.wires.map((w): EmitWire => ({
      id: w.id,
      from: w.from,
      to: w.to,
      color: w.color ?? null,
    })),
  }
}

/**
 * Wire format → CircuitLayout (validate the result with validateLayout).
 *
 * `activeBoard` resolves the schema contract "board / boardCount: null = the
 * active rig": when the model leaves them null, the layout is pinned to the
 * caller's active size/count so validation runs against the right bounds and
 * applying the circuit never silently switches the user's rig. Accepts a bare
 * BoardSizeId (= count 1, back-compat) or a full BoardConfig. When omitted
 * (e.g. importers with no board context) null fields stay absent, which
 * loaders treat as 'standard' × 1.
 */
export function emitToLayout(
  circuit: EmitCircuit,
  activeBoard?: BoardSizeId | BoardConfig,
): CircuitLayout {
  const components: ComponentInstance[] = circuit.components.map((c) => {
    const comp: ComponentInstance = { id: c.id, type: c.type }
    if (typeof c.at === 'string' && c.at.length > 0) comp.at = c.at
    // rotation: only real quarter turns survive; 0/null stay absent (the
    // canonical unrotated form — validateLayout rejects misuse per placement)
    if (c.rotation === 90 || c.rotation === 180 || c.rotation === 270) {
      comp.rotation = c.rotation
    }
    if (Array.isArray(c.holes) && c.holes.length > 0) comp.holes = [...c.holes]
    if (Array.isArray(c.params) && c.params.length > 0) {
      const params: Record<string, ParamValue> = {}
      for (const p of c.params) params[p.key] = p.value
      comp.params = params
    }
    return comp
  })
  const wires: Wire[] = circuit.wires.map((w) => {
    const wire: Wire = { id: w.id, from: w.from, to: w.to }
    if (typeof w.color === 'string' && w.color.length > 0) wire.color = w.color
    return wire
  })
  const layout: CircuitLayout = { version: 1, components, wires }
  const active = activeBoard === undefined ? undefined : asBoardConfig(activeBoard)
  const board =
    circuit.board !== null && isBoardSizeId(circuit.board) ? circuit.board : active?.size
  if (board !== undefined) layout.board = board
  // an explicit valid count wins; null falls back to the active rig's count;
  // count 1 stays absent (the canonical single-board form)
  const count = isBoardCount(circuit.boardCount) ? circuit.boardCount : active?.count
  if (count !== undefined && count > 1) layout.boardCount = count
  // board-rows resolve the same way; rows 1 stays absent (canonical 1-D rig)
  const rows = isBoardRows(circuit.boardRows) ? circuit.boardRows : active?.rows
  if (rows !== undefined && rows > 1) layout.boardRows = rows
  if (circuit.name) layout.name = circuit.name
  return layout
}

/** Expectation[] → wire format (used to embed worked examples in the prompt). */
export function expectationsToEmit(expectations: Expectation[]): EmitExpectation[] {
  return expectations.map((e): EmitExpectation => ({
    kind: e.kind,
    target: e.target,
    digit: e.digit ?? null,
    minHz: e.minHz ?? null,
    maxHz: e.maxHz ?? null,
    minV: e.minV ?? null,
    maxV: e.maxV ?? null,
  }))
}

/**
 * Wire format → Expectation[] (drops null fields; verify.ts checks deeper).
 * Frequency bounds are clamped up to MIN_VERIFIABLE_HZ — anything slower
 * cannot produce the 2 transitions the verifier needs inside its capped
 * window, so a sub-floor bound would be a guaranteed false failure.
 */
export function emitToExpectations(items: EmitExpectation[]): Expectation[] {
  return items.map((item) => {
    const e: Expectation = { kind: item.kind, target: item.target }
    if (typeof item.digit === 'string' && item.digit.length > 0) e.digit = item.digit
    if (typeof item.minHz === 'number' && Number.isFinite(item.minHz)) {
      e.minHz = Math.max(item.minHz, MIN_VERIFIABLE_HZ)
    }
    if (typeof item.maxHz === 'number' && Number.isFinite(item.maxHz)) {
      e.maxHz = Math.max(item.maxHz, MIN_VERIFIABLE_HZ)
    }
    if (typeof item.minV === 'number' && Number.isFinite(item.minV)) e.minV = item.minV
    if (typeof item.maxV === 'number' && Number.isFinite(item.maxV)) e.maxV = item.maxV
    return e
  })
}

// ---------------------------------------------------------------------------
// Tolerant extraction of the envelope from parsed JSON. The API guarantees
// schema conformance via output_config, but the repair loop and importers can
// feed us anything — so be forgiving here and let validateLayout produce the
// precise, actionable errors.
// ---------------------------------------------------------------------------

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function coerceParams(value: unknown): EmitParam[] {
  if (!Array.isArray(value)) return []
  const out: EmitParam[] = []
  for (const item of value) {
    if (!isObject(item)) continue
    const key = typeof item.key === 'string' ? item.key : ''
    const v = item.value
    if (typeof v === 'number' || typeof v === 'string' || typeof v === 'boolean') {
      out.push({ key, value: v })
    }
  }
  return out
}

function coerceCircuit(value: Record<string, unknown>): EmitCircuit {
  const components: EmitComponent[] = Array.isArray(value.components)
    ? value.components.map((raw): EmitComponent => {
        const c = isObject(raw) ? raw : {}
        return {
          id: typeof c.id === 'string' ? c.id : '',
          type: typeof c.type === 'string' ? c.type : '',
          at: typeof c.at === 'string' ? c.at : null,
          holes: Array.isArray(c.holes) ? c.holes.filter((h): h is string => typeof h === 'string') : [],
          params: coerceParams(c.params),
          rotation: typeof c.rotation === 'number' ? c.rotation : null,
        }
      })
    : []
  const wires: EmitWire[] = Array.isArray(value.wires)
    ? value.wires.map((raw): EmitWire => {
        const w = isObject(raw) ? raw : {}
        return {
          id: typeof w.id === 'string' ? w.id : '',
          from: typeof w.from === 'string' ? w.from : '',
          to: typeof w.to === 'string' ? w.to : '',
          color: typeof w.color === 'string' ? w.color : null,
        }
      })
    : []
  return {
    name: typeof value.name === 'string' ? value.name : '',
    board: isBoardSizeId(value.board) ? value.board : null,
    boardCount: isBoardCount(value.boardCount) ? value.boardCount : null,
    boardRows: isBoardRows(value.boardRows) ? value.boardRows : null,
    components,
    wires,
  }
}

function coerceExpectations(value: unknown): EmitExpectation[] {
  if (!Array.isArray(value)) return []
  const out: EmitExpectation[] = []
  for (const raw of value) {
    if (!isObject(raw)) continue
    const kind = raw.kind
    if (typeof kind !== 'string' || !(EXPECTATION_KINDS as readonly string[]).includes(kind)) {
      continue
    }
    out.push({
      kind: kind as ExpectationKind,
      target: typeof raw.target === 'string' ? raw.target : '',
      digit: typeof raw.digit === 'string' ? raw.digit : null,
      minHz: typeof raw.minHz === 'number' ? raw.minHz : null,
      maxHz: typeof raw.maxHz === 'number' ? raw.maxHz : null,
      minV: typeof raw.minV === 'number' ? raw.minV : null,
      maxV: typeof raw.maxV === 'number' ? raw.maxV : null,
    })
  }
  return out
}

/**
 * Parse the structured output (already JSON.parse'd) into an envelope.
 * Accepts either the full {explanation, circuit, expectations} envelope or a
 * bare circuit. Throws a descriptive Error when the value is not an object at
 * all.
 */
export function extractEnvelope(value: unknown): EmitEnvelope {
  if (!isObject(value)) {
    throw new Error('structured output was not a JSON object')
  }
  const explanation = typeof value.explanation === 'string' ? value.explanation : ''
  const circuitRaw = isObject(value.circuit) ? value.circuit : value
  return {
    explanation,
    circuit: coerceCircuit(circuitRaw),
    expectations: coerceExpectations(value.expectations),
  }
}
