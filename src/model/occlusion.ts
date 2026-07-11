/**
 * Body occlusion: which holes a component's molded BODY covers beyond its own
 * pin holes. A covered hole takes no other component pin and no wire end —
 * the part would physically sit on top of whatever plugs in there (the
 * classic case: a potentiometer's wide body overhanging the row next to its
 * leads while a wire clips straight through it).
 *
 * The plan-rects come from `CatalogEntry.bodyFootprint` (see catalog.ts for
 * the exact per-placement semantics) and mirror the rendered meshes: a hole
 * counts as covered when the body crosses its center in plan view.
 *
 * Used by the validator (src/model/validate.ts — occluded holes are ERRORS)
 * and by the LLM prompt builder (src/llm/prompt.ts — per-part warnings).
 * Rotation-aware: the rect rotates together with the pins.
 */

import {
  asBoardConfig,
  BoardConfig,
  BoardSizeId,
  ComponentInstance,
  HoleRef,
  STRIP_ROWS,
  StripHole,
  StripRow,
} from './types'
import type { BodyFootprint, CatalogEntry } from './catalog'
import {
  componentPinHoles,
  formatHole,
  isHoleOnBoard,
  parseHole,
  rotateOffsetDelta,
} from './breadboard'

/** A candidate covered cell in hole-grid space (rowIdx = index in STRIP_ROWS). */
interface Cell {
  col: number
  rowIdx: number
}

/**
 * Row margins of a leads-part body window: the window is RE-CENTERED on the
 * pins' rows; its extent each side of its middle letter is the overhang
 * (['e','f','g'] → 1 row above, 1 row below).
 */
function rowWindowMargins(rows: StripRow[]): { above: number; below: number } {
  const center = (rows.length - 1) >> 1
  return { above: center, below: rows.length - 1 - center }
}

/**
 * Every cell the body covers, in hole-grid space — may include cells off the
 * strip rows / off the rig (the caller filters). null when the instance is
 * malformed in a way componentPinHoles did not already reject.
 */
function coveredCells(
  spec: BodyFootprint | 'auto',
  entry: CatalogEntry,
  comp: ComponentInstance,
  pins: StripHole[],
): Cell[] | null {
  // ----- free leads parts and 'auto': rect floats with the pin bounding box
  if (spec === 'auto' || entry.placement === 'leads' || entry.placement === 'probe') {
    let minCol = Infinity
    let maxCol = -Infinity
    let minRow = Infinity
    let maxRow = -Infinity
    for (const p of pins) {
      const rowIdx = STRIP_ROWS.indexOf(p.row)
      if (p.col < minCol) minCol = p.col
      if (p.col > maxCol) maxCol = p.col
      if (rowIdx < minRow) minRow = rowIdx
      if (rowIdx > maxRow) maxRow = rowIdx
    }
    let left = 0
    let right = 0
    let above = 0
    let below = 0
    if (spec !== 'auto') {
      left = -spec.dCols[0]
      right = spec.dCols[1]
      const m = rowWindowMargins(spec.rows)
      above = m.above
      below = m.below
    }
    const cells: Cell[] = []
    for (let col = minCol - left; col <= maxCol + right; col++) {
      for (let rowIdx = minRow - above; rowIdx <= maxRow + below; rowIdx++) {
        cells.push({ col, rowIdx })
      }
    }
    return cells
  }

  // ----- anchored parts (dip / footprint): rect relative to the "at" anchor
  if (!comp.at) return null
  const at = parseHole(comp.at)
  if (!at || at.kind !== 'strip') return null
  const atRowIdx = STRIP_ROWS.indexOf(at.row)
  const rotation = comp.rotation ?? 0
  const lastRow = STRIP_ROWS.length - 1

  if (entry.placement === 'dip') {
    if (rotation !== 0 && rotation !== 180) return null // 90/270 are invalid DIPs
    const half = entry.pins.length / 2
    const cells: Cell[] = []
    for (let dc = spec.dCols[0]; dc <= spec.dCols[1]; dc++) {
      for (const row of spec.rows) {
        const rowIdx = STRIP_ROWS.indexOf(row)
        if (rotation === 180) {
          // a DIP at 180 occupies the same holes (see dipHoles): the body rect
          // mirrors about the package center — columns flip within the package
          // span, rows mirror about the e/f channel (a↔j … e↔f)
          cells.push({ col: at.col + (half - 1) - dc, rowIdx: lastRow - rowIdx })
        } else {
          cells.push({ col: at.col + dc, rowIdx })
        }
      }
    }
    return cells
  }

  // footprint: rotate the rect cells around pin 1 exactly like the pin offsets
  const anchorRowIdx = STRIP_ROWS.indexOf(entry.footprintOffsets?.[0]?.row ?? at.row)
  const cells: Cell[] = []
  for (let dc = spec.dCols[0]; dc <= spec.dCols[1]; dc++) {
    for (const row of spec.rows) {
      const d = rotateOffsetDelta(dc, STRIP_ROWS.indexOf(row) - anchorRowIdx, rotation)
      cells.push({ col: at.col + d.dCol, rowIdx: atRowIdx + d.dRow })
    }
  }
  return cells
}

/**
 * The holes the component's body covers MINUS the part's own pin holes —
 * the holes nothing else may plug into. Empty set when the catalog entry has
 * no bodyFootprint, when the body covers exactly its pins, or when the
 * instance is malformed (the validator reports that separately). Respects
 * `comp.rotation` and clips to the rig's bounds (only real strip holes can be
 * occluded; rail holes and the channel are never in a body rect).
 */
export function occludedHoles(
  comp: ComponentInstance,
  entry: CatalogEntry,
  config: BoardConfig | BoardSizeId = 'standard',
): Set<HoleRef> {
  const out = new Set<HoleRef>()
  const spec = entry.bodyFootprint
  if (!spec) return out
  const pinHoles = componentPinHoles(comp, entry, config)
  if (!pinHoles) return out

  // strip pins only; a rigid body sits on ONE board-row of the grid
  const pins: StripHole[] = []
  for (const h of pinHoles) {
    if (h && h.kind === 'strip') pins.push(h)
  }
  if (pins.length === 0) return out
  const boardRow = pins[0].boardRow ?? 0
  if (pins.some((p) => (p.boardRow ?? 0) !== boardRow)) return out

  const cells = coveredCells(spec, entry, comp, pins)
  if (!cells) return out

  const pinRefs = new Set(pins.map((p) => formatHole(p)))
  for (const cell of cells) {
    if (cell.rowIdx < 0 || cell.rowIdx >= STRIP_ROWS.length) continue
    const hole: StripHole =
      boardRow !== 0
        ? { kind: 'strip', col: cell.col, row: STRIP_ROWS[cell.rowIdx], boardRow }
        : { kind: 'strip', col: cell.col, row: STRIP_ROWS[cell.rowIdx] }
    if (!isHoleOnBoard(hole, asBoardConfig(config))) continue
    const ref = formatHole(hole)
    if (!pinRefs.has(ref)) out.add(ref)
  }
  return out
}

/**
 * For ANCHORED parts (dip/footprint) with an explicit body rect: the cells
 * the body covers BEYOND its own pins, relative to the pin-1 anchor at
 * rotation 0 (same {dCol, row} shape as footprintOffsets, deterministic
 * order). [] when the explicit rect covers nothing beyond the pins; null for
 * 'auto'/absent rects and for non-anchored placements. Used to generate the
 * per-part occlusion warnings in the LLM system prompt.
 */
export function occludedOffsetsForEntry(
  entry: CatalogEntry,
): { dCol: number; row: StripRow }[] | null {
  const spec = entry.bodyFootprint
  if (!spec || spec === 'auto') return null
  if (entry.placement !== 'dip' && entry.placement !== 'footprint') return null
  // synthesize a placement far from every edge and diff against its own pins
  const anchorRow: StripRow =
    entry.placement === 'dip' ? 'f' : (entry.footprintOffsets?.[0]?.row ?? 'f')
  const col = 30
  const comp: ComponentInstance = { id: '_occ', type: entry.type, at: `${anchorRow}${col}` }
  const offsets: { dCol: number; row: StripRow }[] = []
  for (const ref of occludedHoles(comp, entry, 'labxl')) {
    const h = parseHole(ref)
    if (h && h.kind === 'strip') offsets.push({ dCol: h.col - col, row: h.row })
  }
  return offsets
}

/**
 * For LEADS parts with an explicit body rect: how far the body overhangs the
 * pin bounding box, in holes. null for anchored parts and 'auto'/absent
 * rects. Used for the per-part occlusion warnings in the LLM system prompt.
 */
export function leadsBodyOverhang(
  entry: CatalogEntry,
): { left: number; right: number; above: number; below: number } | null {
  const spec = entry.bodyFootprint
  if (!spec || spec === 'auto') return null
  if (entry.placement !== 'leads' && entry.placement !== 'probe') return null
  const m = rowWindowMargins(spec.rows)
  return { left: -spec.dCols[0], right: spec.dCols[1], above: m.above, below: m.below }
}
