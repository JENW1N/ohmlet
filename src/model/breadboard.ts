/**
 * Breadboard topology, hole addressing, coordinates and net mapping.
 * CONTRACT FILE — do not modify without coordinating with the integrator.
 *
 * Geometry units: 1 unit = 0.1 inch (one hole pitch). x runs along the board
 * (columns), z runs across it (rows), y is up. The 3D scene uses these units
 * directly.
 *
 * Board layout (z = row coordinate, increasing "downward" in plan view):
 *   z=0   rail 'top+'  (red)
 *   z=1   rail 'top-'  (blue)
 *   z=3..7    strip rows a b c d e   (top block)
 *   (center channel at z=8)
 *   z=9..13   strip rows f g h i j   (bottom block)
 *   z=15  rail 'bot-'  (blue)
 *   z=16  rail 'bot+'  (red)
 *
 * Board SIZES: the board comes in presets (BOARD_SIZES in types.ts —
 * 'half' 30 cols / 25 rail holes, 'standard' 63/50, 'labxl' 126/100). The
 * GEOMETRY formulas below are size-independent: strip column `col` always
 * sits at x = col, and rail hole index i always sits at
 * x = 2.5 + i + floor(i/5) (grouped in 5s) — a bigger board just extends the
 * same lattice to the right. Only the BOUNDS differ per preset; use
 * `isHoleOnBoard(hole, config)` for that. `parseHole` is purely syntactic and
 * accepts the maxima across rigs (columns 1..756, rail index 0..599 — the
 * 'labxl' preset × MAX_BOARD_COUNT modules).
 *
 * MULTI-BOARD rigs: up to MAX_BOARD_COUNT (6) identical modules can be ganged
 * side by side (BoardConfig in types.ts; `boardCount` on the layout). Column
 * numbering is CONTINUOUS across modules — module 2 of a 'standard' rig
 * starts at column 64 — and rail indices continue the same way. Each of the
 * four rails is bused across all modules into ONE continuous net (like
 * mounted lab stations), so netIdForHole needs no module awareness. Every
 * size-aware helper here accepts `BoardConfig | BoardSizeId` (a bare size id
 * means a single board, keeping all existing call sites valid). The only new
 * physical constraint is the SEAM between modules: a dip/footprint package
 * cannot straddle it (`spansSeam`); wires and leaded parts may cross freely.
 *
 * BOARD-ROW grids (2-D): up to MAX_BOARD_ROWS (4) full rig rows stack
 * front-to-back (`rows` on BoardConfig; `boardRows` on the layout). Hole refs
 * carry an optional 0-INDEXED board-row prefix — the front row (row 0) is
 * bare ("a12", "top+5"; full back-compat), deeper rows are "1:a12",
 * "2:top+5", "3:j63" ("0:" parses as a non-canonical alias of bare;
 * formatHole always emits the bare form for row 0). Row r is offset in plan z
 * by r × BOARD_ROW_PITCH (19.5 units = one row's full mesh depth — rows abut
 * at a thin molded seam); x is unchanged.
 * Unlike the side-by-side bus, rails on DIFFERENT board-rows are INDEPENDENT
 * nets (separate breadboards on a bench — jumper power between rows), which
 * netIdForHole encodes by namespacing nets per row. A rigid dip/footprint
 * package can never span board-rows (`spansBoardRows`; the rows are
 * BOARD_ROW_PITCH units apart); wires and flexible leaded parts may.
 *
 * Connectivity (one "net" per strip):
 *  - strip (col,row a..e) → net `S{col}T`
 *  - strip (col,row f..j) → net `S{col}B`
 *  - each rail is one continuous net → `R:top+`, `R:top-`, `R:bot+`, `R:bot-`
 *  - holes on board-row r ≥ 1 prefix their net with the row: `2:S12T`,
 *    `1:R:top+` (row 0 stays unprefixed — rails/strips on different rows are
 *    different nets until wires join them)
 *  - off-board component terminal "ID:PIN" → net `PIN:ID:PIN`
 * Wires and component internal bridges merge nets (union-find in the netlist
 * builder, src/sim/netlist.ts).
 */

import {
  Hole,
  HoleRef,
  EndpointRef,
  StripHole,
  RailHole,
  StripRow,
  STRIP_ROWS,
  RAILS,
  RailId,
  BOARD_SIZES,
  BoardSizeId,
  BoardConfig,
  asBoardConfig,
  boardRowsOf,
  isBoardSizeId,
  MAX_BOARD_COUNT,
  MAX_BOARD_ROWS,
  ComponentInstance,
  CircuitLayout,
} from './types'
import type { CatalogEntry } from './catalog'

export const ROW_Z: Record<StripRow, number> = {
  a: 3, b: 4, c: 5, d: 6, e: 7,
  f: 9, g: 10, h: 11, i: 12, j: 13,
}
export const RAIL_Z: Record<RailId, number> = {
  'top+': 0, 'top-': 1, 'bot-': 15, 'bot+': 16,
}

/**
 * Plan-z distance between consecutive BOARD-ROWS of a 2-D grid: exactly one
 * row's full mesh depth (boardExtents: maxZ 18 − minZ −1.5 = 19.5), so rows
 * ABUT like ganged boards — the thin seam groove lives IN the plastic (the
 * board mesh's edge fillets meet in a shallow V at the joint), matching the
 * module seams along a row. Board-row r offsets every z of row 0 by
 * r × BOARD_ROW_PITCH; x positions are identical on every row.
 */
export const BOARD_ROW_PITCH = 19.5

/**
 * Syntax-level maxima across all rigs: the largest preset ('labxl') times the
 * maximum module count. parseHole accepts up to these; per-rig bounds are
 * isHoleOnBoard's job.
 */
const MAX_PRESET_COLS = Math.max(...Object.values(BOARD_SIZES).map((s) => s.cols)) // 126
const MAX_PRESET_RAIL_HOLES = Math.max(...Object.values(BOARD_SIZES).map((s) => s.railHoles)) // 100
const MAX_COLS = MAX_PRESET_COLS * MAX_BOARD_COUNT // 756
const MAX_RAIL_HOLES = MAX_PRESET_RAIL_HOLES * MAX_BOARD_COUNT // 600

/**
 * Plan-view extents of the board mesh for a given rig, in hole-pitch units.
 * The last rail hole always lies left of maxX for every rig (rail index
 * n·railHoles−1 sits at x = 2.5 + i + floor(i/5) ≤ n·cols + 1.5 for every
 * preset), so total column count alone drives maxX. Board-rows extend maxZ
 * by BOARD_ROW_PITCH per extra row (a single-row rig keeps maxZ 18).
 */
export function boardExtents(config: BoardConfig | BoardSizeId = 'standard'): {
  minX: number
  maxX: number
  minZ: number
  maxZ: number
} {
  const { size, count } = asBoardConfig(config)
  const rows = boardRowsOf(config)
  return {
    minX: -0.5,
    maxX: BOARD_SIZES[size].cols * count + 1.5,
    minZ: -1.5,
    maxZ: 18 + (rows - 1) * BOARD_ROW_PITCH,
  }
}

/**
 * Plan-view extents of the STANDARD board mesh, in hole-pitch units.
 * @deprecated Use `boardExtents(size)` — boards now come in multiple sizes.
 */
export const BOARD_EXTENTS = boardExtents('standard')

// Optional board-row prefix ("1:".."3:"; "0:" = non-canonical front row),
// then 3-digit columns (1..756 after the bounds check) / rail indices (0..599).
const ROW_PREFIX_SRC = `(?:([0-${MAX_BOARD_ROWS - 1}]):)?`
const STRIP_RE = new RegExp(`^${ROW_PREFIX_SRC}([a-j])([1-9][0-9]{0,2})$`)
const RAIL_RE = new RegExp(`^${ROW_PREFIX_SRC}(top|bot)([+-])(0|[1-9][0-9]{0,2})$`)

/**
 * Parse a hole ref string. SYNTAX-level only: accepts columns 1..756 and rail
 * indices 0..599 — the maxima across rigs ('labxl' × 6 modules) — plus an
 * optional 0-indexed board-row prefix 0..MAX_BOARD_ROWS-1 ("2:a12",
 * "1:top+5"). A "0:" prefix is accepted as a non-canonical alias of the bare
 * front-row form and normalized away (the returned Hole omits boardRow for
 * row 0, so formatHole round-trips to the canonical bare ref). Whether the
 * hole exists on a particular rig is a separate check:
 * `isHoleOnBoard(hole, config)`.
 */
export function parseHole(ref: string): Hole | null {
  const s = STRIP_RE.exec(ref)
  if (s) {
    const col = parseInt(s[3], 10)
    if (col < 1 || col > MAX_COLS) return null
    const boardRow = s[1] === undefined ? 0 : parseInt(s[1], 10)
    const row = s[2] as StripRow
    return boardRow !== 0 ? { kind: 'strip', col, row, boardRow } : { kind: 'strip', col, row }
  }
  const r = RAIL_RE.exec(ref)
  if (r) {
    const index = parseInt(r[4], 10)
    if (index < 0 || index >= MAX_RAIL_HOLES) return null
    const boardRow = r[1] === undefined ? 0 : parseInt(r[1], 10)
    const rail = `${r[2]}${r[3]}` as RailId
    return boardRow !== 0 ? { kind: 'rail', rail, index, boardRow } : { kind: 'rail', rail, index }
  }
  return null
}

/**
 * True if the (syntactically valid) hole exists on the given rig. Accepts a
 * bare size id (= a single board, back-compat) or a full BoardConfig: total
 * columns = cols × count, total rail holes = railHoles × count (continuous
 * numbering across modules), board-rows 0..rows-1 (absent boardRow = row 0).
 */
export function isHoleOnBoard(hole: Hole, config: BoardConfig | BoardSizeId): boolean {
  const { size, count } = asBoardConfig(config)
  const s = BOARD_SIZES[size]
  const boardRow = hole.boardRow ?? 0
  if (boardRow < 0 || boardRow >= boardRowsOf(config)) return false
  return hole.kind === 'strip'
    ? hole.col >= 1 && hole.col <= s.cols * count
    : hole.index >= 0 && hole.index < s.railHoles * count
}

/**
 * Canonical ref of a hole: bare for the front board-row ("a12", "top+5"),
 * "r:" prefixed for rows ≥ 1 ("2:a12") — the prefix is the 0-indexed row.
 */
export function formatHole(h: Hole): HoleRef {
  const base = h.kind === 'strip' ? `${h.row}${h.col}` : `${h.rail}${h.index}`
  const boardRow = h.boardRow ?? 0
  return boardRow === 0 ? base : `${boardRow}:${base}`
}

/** True if the string parses as a board hole (vs an off-board "ID:PIN" endpoint). */
export function isHoleRef(ref: EndpointRef): boolean {
  return parseHole(ref) !== null
}

/** Off-board endpoint "ID:PIN" → {componentId, pin} or null. */
export function parseTerminalRef(ref: EndpointRef): { componentId: string; pin: string } | null {
  const i = ref.indexOf(':')
  if (i <= 0) return null
  return { componentId: ref.slice(0, i), pin: ref.slice(i + 1) }
}

/**
 * Plan position of a hole in hole-pitch units. SIZE-INDEPENDENT: the same
 * formulas hold on every board preset (strip x = col; rail x grouped in 5s,
 * x = 2.5 + index + floor(index/5)) — larger boards just extend the lattice.
 * Board-row r adds r × BOARD_ROW_PITCH to z; x is identical on every row.
 */
export function holePosition(h: Hole): { x: number; z: number } {
  const dz = (h.boardRow ?? 0) * BOARD_ROW_PITCH
  if (h.kind === 'strip') return { x: h.col, z: ROW_Z[h.row] + dz }
  return { x: 2.5 + h.index + Math.floor(h.index / 5), z: RAIL_Z[h.rail] + dz }
}

/**
 * Static net id of a hole (before wires merge nets). Namespaced per
 * board-row: row 0 keeps the shipped ids ("S12T", "R:top+"); rows ≥ 1 prefix
 * the 0-indexed row ("2:S12T", "1:R:top+") — rails and strips on different
 * board-rows are INDEPENDENT nets until wires join them.
 */
export function netIdForHole(h: Hole): string {
  const prefix = (h.boardRow ?? 0) === 0 ? '' : `${h.boardRow}:`
  if (h.kind === 'rail') return `${prefix}R:${h.rail}`
  const half = ROW_Z[h.row] < 8 ? 'T' : 'B'
  return `${prefix}S${h.col}${half}`
}

/** Net id of an off-board terminal endpoint. */
export function netIdForTerminal(componentId: string, pin: string): string {
  return `PIN:${componentId}:${pin}`
}

/**
 * Every hole on a rig of the given size/config (default 'standard' × 1),
 * iterating the whole 2-D grid board-row by board-row (front row first; its
 * holes omit boardRow, the canonical row-0 form).
 */
export function* allHoles(config: BoardConfig | BoardSizeId = 'standard'): Generator<Hole> {
  const { size, count } = asBoardConfig(config)
  const rows = boardRowsOf(config)
  const cols = BOARD_SIZES[size].cols * count
  const railHoles = BOARD_SIZES[size].railHoles * count
  for (let boardRow = 0; boardRow < rows; boardRow++) {
    for (const row of STRIP_ROWS) {
      for (let col = 1; col <= cols; col++) {
        yield boardRow !== 0 ? { kind: 'strip', col, row, boardRow } : { kind: 'strip', col, row }
      }
    }
    for (const rail of RAILS) {
      for (let index = 0; index < railHoles; index++) {
        yield boardRow !== 0 ? { kind: 'rail', rail, index, boardRow } : { kind: 'rail', rail, index }
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Multi-board modules: continuous numbering, seams
// ---------------------------------------------------------------------------

/**
 * 1-based module number a strip column belongs to (column numbering is
 * continuous across modules: on 'standard' modules, cols 1..63 → module 1,
 * col 64 starts module 2, ...). Purely arithmetic — does not bounds-check
 * against any particular count.
 */
export function moduleOfCol(col: number, size: BoardSizeId): number {
  return Math.floor((col - 1) / BOARD_SIZES[size].cols) + 1
}

/**
 * 1-based module number a rail hole index belongs to (indices are continuous:
 * on 'standard' modules, 0..49 → module 1, 50 starts module 2, ...). The rail
 * NET is still one bused net along the whole rig — the module only matters
 * for geometry/rendering.
 */
export function moduleOfRailIndex(index: number, size: BoardSizeId): number {
  return Math.floor(index / BOARD_SIZES[size].railHoles) + 1
}

/**
 * Plan-view x positions of the module boundaries (seams) of a rig, for the
 * scene: count−1 seams, seam k sitting halfway between the last column of
 * module k and the first column of module k+1 (x = k·cols + 0.5). Empty for a
 * single board.
 */
export function moduleSeamXs(config: BoardConfig): number[] {
  const { size, count } = config
  const cols = BOARD_SIZES[size].cols
  const xs: number[] = []
  for (let k = 1; k < count; k++) xs.push(k * cols + 0.5)
  return xs
}

/**
 * Plan-view z offset of each board-row of a rig (for the scene): row r sits
 * at z = r × BOARD_ROW_PITCH, so a single-row rig is `[0]`. The per-row
 * geometry (ROW_Z / RAIL_Z, moduleSeamXs) is identical on every row — just
 * add the row's offset to z.
 */
export function boardRowZs(config: BoardConfig | BoardSizeId = 'standard'): number[] {
  const rows = boardRowsOf(config)
  const zs: number[] = []
  for (let r = 0; r < rows; r++) zs.push(r * BOARD_ROW_PITCH)
  return zs
}

/**
 * True when a dip/footprint hole set crosses a module boundary — a rigid
 * package cannot physically straddle the gap between two boards. Considers
 * strip holes only (packages never sit in rails) and ignores nulls, so it
 * accepts `componentPinHoles` output directly. Wires and leaded parts may
 * cross seams freely — never call this for those.
 */
export function spansSeam(
  holes: readonly (Hole | null)[],
  config: BoardConfig,
): boolean {
  if (config.count <= 1) return false
  let module: number | null = null
  for (const h of holes) {
    if (!h || h.kind !== 'strip') continue
    const m = moduleOfCol(h.col, config.size)
    if (module === null) module = m
    else if (m !== module) return true
  }
  return false
}

/**
 * True when a hole set resolves to more than one BOARD-ROW. Board-rows are
 * BOARD_ROW_PITCH (19.5 units) apart in z, so a rigid dip/footprint package
 * can never physically span two of them — the validator rejects such refs
 * with a clear error. Ignores nulls (accepts `componentPinHoles` output
 * directly); absent boardRow = row 0. Wires and flexible leaded parts may
 * cross board-rows freely — never call this for those.
 */
export function spansBoardRows(holes: readonly (Hole | null)[]): boolean {
  let boardRow: number | null = null
  for (const h of holes) {
    if (!h) continue
    const r = h.boardRow ?? 0
    if (boardRow === null) boardRow = r
    else if (r !== boardRow) return true
  }
  return false
}

/**
 * Holes occupied by a DIP package of `pinCount` pins anchored with pin 1 at
 * `at` (must be a strip hole in row 'f'). Pins 1..N/2 run left→right along
 * row f; pins N/2+1..N run right→left along row e. Returns null if invalid
 * (bad anchor row, or package would run off the rig — default 'standard' × 1).
 * NOTE: bounds only — whether the package straddles a module seam is the
 * separate `spansSeam` check (the validator owns that error).
 *
 * ROTATION: only 0 | 180 (90/270 return null — they would fold both pin rows
 * of the package into single strip columns, shorting every opposite pin
 * pair). Rotating 180 in-plane swaps the rows AND reverses the column order,
 * so the package occupies the SAME holes — `at` still names the row-f hole at
 * the LEFT end of the package — but the pin walk reverses: pin 1 ends at the
 * row-e RIGHT end (pin i swaps holes with pin i+N/2).
 */
export function dipHoles(
  at: Hole,
  pinCount: number,
  config: BoardConfig | BoardSizeId = 'standard',
  rotation: 0 | 90 | 180 | 270 = 0,
): StripHole[] | null {
  const { size, count } = asBoardConfig(config)
  if (at.kind !== 'strip' || at.row !== 'f') return null
  if (rotation === 90 || rotation === 270) return null
  const boardRow = at.boardRow ?? 0
  if (boardRow < 0 || boardRow >= boardRowsOf(config)) return null
  const half = pinCount / 2
  if (!Number.isInteger(half)) return null
  if (at.col + half - 1 > BOARD_SIZES[size].cols * count) return null
  // every pin inherits the anchor's board-row (a rigid package sits on ONE row)
  const mk = (col: number, row: StripRow): StripHole =>
    boardRow !== 0 ? { kind: 'strip', col, row, boardRow } : { kind: 'strip', col, row }
  const holes: StripHole[] = []
  for (let i = 0; i < half; i++) holes.push(mk(at.col + i, 'f'))
  for (let i = 0; i < half; i++) holes.push(mk(at.col + half - 1 - i, 'e'))
  // 180 = same occupied holes, pin walk rotated: pin i ↔ pin i+half
  if (rotation === 180) return [...holes.slice(half), ...holes.slice(0, half)]
  return holes
}

/**
 * Quarter-turn rotation of a footprint offset delta. Deltas are in hole-grid
 * space: `dCol` along the columns (rightward positive) and `dRow` in STRIP
 * ROW INDICES ('a'=0 .. 'j'=9, downward positive in plan view — note the
 * center channel is NOT counted: e→f is one row index). Rotation is CLOCKWISE
 * in plan view, so 90 maps (dc, dr) → (−dr, dc). Shared by `footprintHoles`
 * and the occlusion model (src/model/occlusion.ts) so they can never drift.
 */
export function rotateOffsetDelta(
  dCol: number,
  dRow: number,
  rotation: 0 | 90 | 180 | 270,
): { dCol: number; dRow: number } {
  switch (rotation) {
    case 0:
      return { dCol, dRow }
    case 90:
      return { dCol: -dRow || 0, dRow: dCol } // `|| 0` normalizes -0
    case 180:
      return { dCol: -dCol || 0, dRow: -dRow || 0 }
    case 270:
      return { dCol: dRow, dRow: -dCol || 0 }
  }
}

/**
 * Holes occupied by a fixed-footprint component (e.g. pushbutton) anchored at
 * `at` = the hole of pin 1. Offsets come from the catalog entry. Returns null
 * if any hole falls off the rig (default 'standard' × 1). Bounds only — seam
 * straddling is the separate `spansSeam` check.
 *
 * ROTATION (0|90|180|270): pin 1 stays at `at`; every other pin offset is
 * rotated around it in quarter turns via `rotateOffsetDelta` (row deltas in
 * STRIP_ROWS indices). At rotation 0 the anchor must sit in the part's
 * designed anchor row (offsets[0].row — byte-compatible with the unrotated
 * behavior); rotated placements may anchor in any row their rotated offsets
 * fit (the structure no longer matches the designed rows anyway). Returns
 * null when a rotated offset runs off the strip rows or off the rig columns.
 */
export function footprintHoles(
  at: Hole,
  offsets: { dCol: number; row: StripRow }[],
  config: BoardConfig | BoardSizeId = 'standard',
  rotation: 0 | 90 | 180 | 270 = 0,
): StripHole[] | null {
  const { size, count } = asBoardConfig(config)
  if (at.kind !== 'strip') return null
  const boardRow = at.boardRow ?? 0
  if (boardRow < 0 || boardRow >= boardRowsOf(config)) return null
  if (offsets.length === 0 || offsets[0].dCol !== 0) return null
  if (rotation === 0 && offsets[0].row !== at.row) return null
  const atRowIdx = STRIP_ROWS.indexOf(at.row)
  const anchorRowIdx = STRIP_ROWS.indexOf(offsets[0].row)
  const holes: StripHole[] = []
  for (const o of offsets) {
    const d = rotateOffsetDelta(o.dCol, STRIP_ROWS.indexOf(o.row) - anchorRowIdx, rotation)
    const col = at.col + d.dCol
    const rowIdx = atRowIdx + d.dRow
    if (col < 1 || col > BOARD_SIZES[size].cols * count) return null
    if (rowIdx < 0 || rowIdx >= STRIP_ROWS.length) return null
    // every pin inherits the anchor's board-row (rigid package, one row)
    holes.push(
      boardRow !== 0
        ? { kind: 'strip', col, row: STRIP_ROWS[rowIdx], boardRow }
        : { kind: 'strip', col, row: STRIP_ROWS[rowIdx] },
    )
  }
  return holes
}

/**
 * comp.rotation normalized for the package-hole helpers: absent → 0; any
 * value that is not a quarter turn → null (malformed instance).
 */
function rotationOf(comp: ComponentInstance): 0 | 90 | 180 | 270 | null {
  const r: unknown = comp.rotation ?? 0
  return r === 0 || r === 90 || r === 180 || r === 270 ? r : null
}

/**
 * Central helper: the board hole of each pin of a component, in catalog pin
 * order. Off-board components return all-null (their pins are terminals, not
 * holes). Returns null when the instance is malformed (wrong hole count, bad
 * anchor, hole off the rig — default 'standard' × 1...). Dip/footprint
 * instances may carry `rotation` (absent = 0; see dipHoles/footprintHoles);
 * a non-quarter-turn rotation value is malformed → null. Leads/probe/offboard
 * placements ignore the field (the validator rejects it there).
 */
export function componentPinHoles(
  comp: ComponentInstance,
  entry: CatalogEntry,
  config: BoardConfig | BoardSizeId = 'standard',
): (Hole | null)[] | null {
  switch (entry.placement) {
    case 'offboard':
      return entry.pins.map(() => null)
    case 'leads':
    case 'probe': {
      if (!comp.holes || comp.holes.length !== entry.pins.length) return null
      const out: Hole[] = []
      for (const ref of comp.holes) {
        const h = parseHole(ref)
        if (!h || !isHoleOnBoard(h, config)) return null
        out.push(h)
      }
      return out
    }
    case 'dip': {
      if (!comp.at) return null
      const at = parseHole(comp.at)
      if (!at) return null
      const rotation = rotationOf(comp)
      if (rotation === null) return null
      return dipHoles(at, entry.pins.length, config, rotation)
    }
    case 'footprint': {
      if (!comp.at || !entry.footprintOffsets) return null
      const at = parseHole(comp.at)
      if (!at) return null
      const rotation = rotationOf(comp)
      if (rotation === null) return null
      return footprintHoles(at, entry.footprintOffsets, config, rotation)
    }
  }
}

// ---------------------------------------------------------------------------
// Grid growth: remapping hole refs when the grid grows left / up
// ---------------------------------------------------------------------------

/**
 * Return a copy of the layout with EVERY hole ref in components (`holes`,
 * `at`) and wires (`from`, `to`) shifted by `colDelta` strip columns and
 * `rowDelta` board-rows — used by the store when the grid grows in the
 * NEGATIVE directions (left / up): grow the rig, then shift the existing
 * content right/down so the origin stays the top-left board.
 *
 * - Rail hole indices shift PROPORTIONALLY: by colDelta × railHoles / cols of
 *   the layout's own size preset, rounded. Call with colDelta a whole number
 *   of modules (k × cols) so the rail lattice lines up exactly (one standard
 *   module = 63 columns = 50 rail holes).
 * - PURE and throws nothing: the input layout is untouched; off-board
 *   terminal refs ("PS1:+") and unparseable refs pass through verbatim.
 * - No bounds clamping: a shift that pushes a ref outside the syntax range
 *   (column < 1, board-row < 0 or ≥ MAX_BOARD_ROWS...) produces a ref that
 *   no longer parses, which validateLayout / the store then reject loudly —
 *   refs are never silently dropped or clamped.
 */
export function remapLayout(
  layout: CircuitLayout,
  colDelta: number,
  rowDelta: number,
): CircuitLayout {
  // hardened: a malformed board field never throws (throws-nothing contract)
  const size = BOARD_SIZES[isBoardSizeId(layout.board) ? layout.board : 'standard']
  const railDelta = Math.round((colDelta * size.railHoles) / size.cols)
  const shift = (ref: HoleRef): HoleRef => {
    const h = parseHole(ref)
    if (!h) return ref // terminal ref or garbage — pass through verbatim
    const boardRow = (h.boardRow ?? 0) + rowDelta
    if (h.kind === 'strip') {
      const col = h.col + colDelta
      return formatHole(
        boardRow !== 0 ? { kind: 'strip', col, row: h.row, boardRow } : { kind: 'strip', col, row: h.row },
      )
    }
    const index = h.index + railDelta
    return formatHole(
      boardRow !== 0
        ? { kind: 'rail', rail: h.rail, index, boardRow }
        : { kind: 'rail', rail: h.rail, index },
    )
  }
  return {
    ...layout,
    components: layout.components.map((c) => {
      const comp: ComponentInstance = { ...c }
      if (comp.holes) comp.holes = comp.holes.map(shift)
      if (comp.at !== undefined) comp.at = shift(comp.at)
      return comp
    }),
    wires: layout.wires.map((w) => ({ ...w, from: shift(w.from), to: shift(w.to) })),
  }
}

/**
 * Plan position for the terminals of off-board components (power supply,
 * function generator). Off-board units default to an instrument shelf to the
 * LEFT of the board; `slot` is the unit's index among off-board components in
 * the layout (0, 1, 2...). An explicit `pos` (the instrument's body anchor —
 * `ComponentInstance.pos`, movable instruments) overrides the slot formula;
 * the terminal posts keep the same fixed offset from the anchor either way
 * (pin i sits at anchor + (2 + 2.5·i, 2), on the unit's front face), so a
 * unit without `pos` renders byte-identically to the pre-movable layouts.
 */
export function offboardTerminalPosition(
  slot: number,
  pinIndex: number,
  pos?: { x: number; z: number },
): { x: number; z: number } {
  const a = offboardBodyPosition(slot, pos)
  return { x: a.x + 2 + pinIndex * 2.5, z: a.z + 2 }
}

/**
 * Anchor (top-left) plan position for an off-board unit's body. An explicit
 * `pos` overrides the legacy slot-shelf formula (x = −10, z = slot·7).
 */
export function offboardBodyPosition(
  slot: number,
  pos?: { x: number; z: number },
): { x: number; z: number } {
  return pos ?? { x: -10, z: 0 + slot * 7 }
}

/** Default obstacle-box height of an off-board instrument unit (plan units). */
export const OFFBOARD_BODY_HEIGHT = 4

/**
 * Plan-view footprint rect of an off-board unit: the 6.5-wide instrument
 * enclosure (z anchor−2 .. anchor+1.2 — mesh-exact for the 2-terminal bench
 * instruments in meshes/instruments.ts) plus the terminal-post apron on the
 * front face (posts at z = anchor+2, apron to anchor+2.5). Used by the
 * validator (instrument↔board and instrument↔instrument overlap rules) and
 * by the scene to derive the router's instrument obstacle boxes.
 */
export function offboardBodyRect(
  slot: number,
  pos?: { x: number; z: number },
): { minX: number; maxX: number; minZ: number; maxZ: number } {
  const a = offboardBodyPosition(slot, pos)
  return { minX: a.x, maxX: a.x + 6.5, minZ: a.z - 2, maxZ: a.z + 2.5 }
}
