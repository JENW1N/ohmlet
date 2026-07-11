/**
 * Core shared types for ohmlet.
 * CONTRACT FILE — do not modify without coordinating with the integrator.
 */

export const STRIP_ROWS = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j'] as const
export type StripRow = (typeof STRIP_ROWS)[number]

export type RailId = 'top+' | 'top-' | 'bot+' | 'bot-'
export const RAILS: RailId[] = ['top+', 'top-', 'bot+', 'bot-']

/** Board size presets. */
export type BoardSizeId = 'half' | 'standard' | 'labxl'

/**
 * The board presets: terminal-strip column count, holes per power rail, a
 * human label, and the marketing "point" count (which equals the total hole
 * count: 10 rows × cols + 4 rails × railHoles).
 */
export const BOARD_SIZES: Record<
  BoardSizeId,
  { cols: number; railHoles: number; label: string; points: number }
> = {
  half: { cols: 30, railHoles: 25, label: 'Half', points: 400 },
  standard: { cols: 63, railHoles: 50, label: 'Standard', points: 830 },
  labxl: { cols: 126, railHoles: 100, label: 'Lab XL', points: 1660 },
}

/** Type guard for BoardSizeId. */
export function isBoardSizeId(v: unknown): v is BoardSizeId {
  return v === 'half' || v === 'standard' || v === 'labxl'
}

/**
 * Maximum number of identical board modules that can be ganged side by side
 * into one rig (like bench-mounted lab stations).
 */
export const MAX_BOARD_COUNT = 6

/** Type guard for a valid module count (integer 1..MAX_BOARD_COUNT). */
export function isBoardCount(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v >= 1 && v <= MAX_BOARD_COUNT
}

/**
 * Maximum number of BOARD-ROWS a rig can stack front-to-back (a 2-D grid:
 * up to MAX_BOARD_COUNT modules wide × MAX_BOARD_ROWS board-rows deep).
 */
export const MAX_BOARD_ROWS = 4

/** Type guard for a valid board-row count (integer 1..MAX_BOARD_ROWS). */
export function isBoardRows(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v >= 1 && v <= MAX_BOARD_ROWS
}

/**
 * A full board rig: the size preset of each module, how many identical
 * modules are ganged side by side (1..MAX_BOARD_COUNT), and how many such
 * rig rows are stacked front-to-back (`rows`, 1..MAX_BOARD_ROWS).
 *
 * COLUMN NUMBERING IS CONTINUOUS across modules: module 2 of a 'standard' rig
 * starts at column 64 (total columns = size.cols × count). Rail hole indices
 * continue the same way (total rail holes = size.railHoles × count), and each
 * of the four rails stays ONE continuous bused net along the whole rig — the
 * modules are electrically joined like mounted lab stations.
 *
 * BOARD-ROWS (`rows`, 1..MAX_BOARD_ROWS; absent = 1, full back-compat with
 * the shipped 1-D rig) stack additional full rig rows front-to-back into a
 * 2-D grid: count modules wide × rows board-rows deep. Each board-row is a
 * complete rig row with its OWN four power rails — unlike the side-by-side
 * bus, rails on DIFFERENT board-rows are INDEPENDENT nets (like separate
 * breadboards on a bench): power must be jumpered between rows with wires.
 * Hole refs address rows with an optional 0-indexed prefix: the front row
 * (row 0) is bare ("a12", "top+5"); deeper rows are "1:a12", "2:top+5",
 * "3:j63". Column and rail ranges are identical on every row.
 */
export type BoardConfig = { size: BoardSizeId; count: number; rows?: number }

/**
 * Normalize a bare size id (= a single board) or a full config to a
 * BoardConfig. Lets board-size-aware helpers accept both forms. An absent
 * `rows` means 1 board-row (read it with `boardRowsOf`).
 */
export function asBoardConfig(c: BoardSizeId | BoardConfig): BoardConfig {
  return typeof c === 'string' ? { size: c, count: 1 } : c
}

/** Board-row count of a config (absent or malformed `rows` = 1, hardened). */
export function boardRowsOf(c: BoardSizeId | BoardConfig): number {
  if (typeof c === 'string') return 1
  return isBoardRows(c.rows) ? c.rows : 1
}

/**
 * Columns on the terminal strip area of the STANDARD board: 1..NUM_COLS.
 * @deprecated Use `BOARD_SIZES[boardOf(layout)].cols` — boards now come in
 * multiple sizes. Kept as the standard-board value for back-compat.
 */
export const NUM_COLS = BOARD_SIZES.standard.cols
/**
 * Holes per power rail on the STANDARD board: index 0..RAIL_HOLES-1 (grouped
 * in 5s visually).
 * @deprecated Use `BOARD_SIZES[boardOf(layout)].railHoles` — boards now come
 * in multiple sizes. Kept as the standard-board value for back-compat.
 */
export const RAIL_HOLES = BOARD_SIZES.standard.railHoles

export interface StripHole {
  kind: 'strip'
  col: number // 1..cols of the board preset (max 126 on 'labxl')
  row: StripRow
  /**
   * 0-indexed board-row of a 2-D grid (0 = front row). OPTIONAL — absent
   * means 0, the canonical form for the front row; every helper treats
   * absent and 0 identically. Bounds against a rig: 0..rows-1.
   */
  boardRow?: number
}
export interface RailHole {
  kind: 'rail'
  rail: RailId
  index: number // 0..railHoles-1 of the board preset (max 0..99 on 'labxl')
  /** 0-indexed board-row (absent = 0, the front row) — see StripHole.boardRow. */
  boardRow?: number
}
export type Hole = StripHole | RailHole

/**
 * Textual hole reference, the format used in the DSL / LLM output:
 *   strip holes:  "a12", "j63"  (row letter + column)
 *   rail holes:   "top+5", "bot-12" (rail id + index)
 *   board-row prefix (2-D grids): "1:a12", "2:top+5" — the prefix is the
 *     0-INDEXED board-row; the front row (row 0) is written bare. formatHole
 *     always emits the bare form for row 0 ("0:a12" parses but is
 *     non-canonical).
 * Syntax allows the maxima across board presets (columns 1..126, rail index
 * 0..99); whether a ref actually exists on a given board is a separate,
 * board-size-aware check (`isHoleOnBoard` in breadboard.ts).
 */
export type HoleRef = string

/**
 * A wire endpoint: either a HoleRef, or "<COMPONENT_ID>:<PIN_NAME>" for the
 * terminal of an off-board component (power supply, function generator).
 * Example: "PS1:+", "FG1:out".
 */
export type EndpointRef = string

export type ParamValue = number | string | boolean

/**
 * In-plane package rotation in quarter turns, CLOCKWISE in plan view
 * (columns increasing rightward, strip rows a→j increasing downward). Only
 * 'dip' and 'footprint' placements rotate; DIP packages allow only 0 | 180
 * (90/270 would fold both pin rows of the package into single strip columns,
 * shorting every opposite pin pair).
 */
export type Rotation = 0 | 90 | 180 | 270

/** Type guard for a Rotation value. */
export function isRotation(v: unknown): v is Rotation {
  return v === 0 || v === 90 || v === 180 || v === 270
}

export interface ComponentInstance {
  /** Unique id within the layout, e.g. "R1", "U2", "LED3". */
  id: string
  /** Catalog type key, e.g. "resistor", "ne555". */
  type: string
  params?: Record<string, ParamValue>
  /**
   * For placement 'leads' and 'probe': one HoleRef per lead, in catalog pin
   * order. (e.g. resistor: [hole of p1, hole of p2])
   */
  holes?: HoleRef[]
  /**
   * For placement 'dip' and 'footprint': the hole of PIN 1. For DIP packages
   * this MUST be in row 'f' (pins 1..N/2 run left→right along row f, pins
   * N/2+1..N run right→left along row e, straddling the center channel).
   */
  at?: HoleRef
  /**
   * For placement 'dip' and 'footprint' ONLY: in-plane rotation in quarter
   * turns, clockwise in plan view (absent = 0). DIP packages (including the
   * DIP-style seven_segment) allow only 0 | 180. At 180 a DIP occupies the
   * SAME holes — `at` still names the row-f hole at the LEFT end of the
   * package — but the pin walk reverses (pin 1 ends at the row-e right end).
   * A footprint part keeps pin 1 at `at` and rotates the remaining pin
   * offsets around it. Leads/probe/offboard parts reject the field.
   */
  rotation?: Rotation
  /**
   * For placement 'offboard' ONLY: explicit plan position of the instrument's
   * body anchor (hole-pitch units, snapped to the 0.5 grid). Absent = the
   * legacy slot-shelf formula (`offboardBodyPosition(slot)` — a pure function
   * of the unit's index among off-board components), so existing layouts
   * render identically. Validated by validateLayout (0.5-grid snap; the body
   * rect must not intersect the active rig's board extents nor another
   * instrument's body rect); round-trips export/import.
   */
  pos?: { x: number; z: number }
}

export interface Wire {
  id: string
  from: EndpointRef
  to: EndpointRef
  /** css-ish color name or hex; purely cosmetic */
  color?: string
}

export interface CircuitLayout {
  version: 1
  name?: string
  description?: string
  /** Board size preset. Absent = 'standard' (full backward compatibility). */
  board?: BoardSizeId
  /**
   * Number of identical board modules ganged side by side (integer
   * 1..MAX_BOARD_COUNT). Absent = 1 — a single board, full backward
   * compatibility. Column numbering and rail indices run CONTINUOUSLY across
   * modules and the rails are bused into single nets (see BoardConfig).
   */
  boardCount?: number
  /**
   * Number of board-rows stacked front-to-back (integer 1..MAX_BOARD_ROWS).
   * Absent = 1 — the shipped single-row rig, full backward compatibility.
   * Each board-row is a full rig row with its own four power rails; rails on
   * different board-rows are INDEPENDENT nets (jumper power between rows).
   * Hole refs on rows beyond the first carry the "1:" / "2:" / "3:" prefix
   * (0-indexed board-row; the front row is bare). See BoardConfig.
   */
  boardRows?: number
  components: ComponentInstance[]
  wires: Wire[]
}

/** The board size a layout is laid out for (absent board = 'standard'). */
export function boardOf(layout: Pick<CircuitLayout, 'board'>): BoardSizeId {
  return layout.board ?? 'standard'
}

/**
 * The full board rig a layout is laid out for: size preset (absent =
 * 'standard') + module count + board-row count (absent or out-of-range = 1;
 * hardened so a malformed count can never produce a bogus rig downstream).
 * Always returns an explicit `rows`.
 */
export function boardConfigOf(
  layout: Pick<CircuitLayout, 'board' | 'boardCount' | 'boardRows'>,
): Required<BoardConfig> {
  return {
    size: layout.board ?? 'standard',
    count: isBoardCount(layout.boardCount) ? layout.boardCount : 1,
    rows: isBoardRows(layout.boardRows) ? layout.boardRows : 1,
  }
}

// ---------------------------------------------------------------------------
// Simulation telemetry (engine → UI / 3D)
// ---------------------------------------------------------------------------

export interface ComponentTelemetry {
  /** pin name → node voltage (V) */
  pinVoltages: Record<string, number>
  /** main branch current (A) where meaningful (2-lead devices) */
  current?: number
  power?: number
  /** 0..1 visual brightness for LEDs */
  ledBrightness?: number
  /** latched true when an LED exceeded its max current */
  burned?: boolean
  /** 7-segment display: segment name (a..g, dp) → lit */
  segments?: Record<string, boolean>
  /** chip logic outputs: pin name → high/low (for visualization) */
  outputs?: Record<string, boolean>
  /** pushbutton runtime state echo */
  pressed?: boolean
  /** buzzer is audibly driven */
  sounding?: boolean
}

export interface SimIssue {
  level: 'error' | 'warning'
  message: string
  componentId?: string
}

export interface SimTelemetry {
  time: number
  /** net id → voltage (V) */
  netVoltages: Record<string, number>
  components: Record<string, ComponentTelemetry>
  issues: SimIssue[]
}

/** One oscilloscope sample: time + voltage per channel (1..4 → index 0..3). NaN = channel unattached. */
export interface ScopeSample {
  t: number
  v: [number, number, number, number]
}
