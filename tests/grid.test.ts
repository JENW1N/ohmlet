/**
 * 2-D board grid (BoardConfig.rows / CircuitLayout.boardRows, 1..4):
 * board-row hole-ref prefixes ("1:a12" = 0-indexed board-row 1; the front
 * row is bare), per-row geometry (z offset by BOARD_ROW_PITCH), per-row
 * namespaced net ids (rails on different board-rows are INDEPENDENT nets),
 * grid-aware bounds/iteration/extents, remapLayout for grid growth in the
 * negative directions, validator board-row rules, and the LLM
 * prompt/schema/converter plumbing. Owned by the model-layer (llm) agent.
 */
import { describe, expect, it } from 'vitest'
import type { BoardConfig, CircuitLayout, Hole } from '../src/model/types'
import {
  BOARD_SIZES,
  boardConfigOf,
  boardRowsOf,
  isBoardRows,
  MAX_BOARD_ROWS,
} from '../src/model/types'
import {
  allHoles,
  BOARD_ROW_PITCH,
  boardExtents,
  boardRowZs,
  componentPinHoles,
  dipHoles,
  footprintHoles,
  formatHole,
  holePosition,
  isHoleOnBoard,
  moduleSeamXs,
  netIdForHole,
  parseHole,
  remapLayout,
  spansBoardRows,
} from '../src/model/breadboard'
import { validateLayout } from '../src/model/validate'
import { CATALOG } from '../src/model/catalog'
import { buildSystemPrompt } from '../src/llm/prompt'
import {
  CIRCUIT_OUTPUT_SCHEMA,
  emitToLayout,
  extractEnvelope,
  layoutToEmit,
} from '../src/llm/schema'
import { FEW_SHOT_EXAMPLES } from '../src/llm/examples'
import { dip, layout, mustParse, poweredLayout, twoLead, wire } from './helpers'

import blinkyRaw from '../examples/blinky-555.json'
import counterRaw from '../examples/counter.json'
import dateRaw from '../examples/date-display.json'
import nightRaw from '../examples/night-light.json'

const STD_2R: BoardConfig = { size: 'standard', count: 1, rows: 2 }
const STD_4R: BoardConfig = { size: 'standard', count: 1, rows: 4 }
const HALF_2x3: BoardConfig = { size: 'half', count: 2, rows: 3 }

function withRows(l: CircuitLayout, rows: number): CircuitLayout {
  l.boardRows = rows
  return l
}

// ------------------------------------------------------------- config basics

describe('board-row config (types.ts)', () => {
  it('MAX_BOARD_ROWS is 4 and isBoardRows guards integers 1..4', () => {
    expect(MAX_BOARD_ROWS).toBe(4)
    for (const n of [1, 2, 3, 4]) expect(isBoardRows(n), `rows ${n}`).toBe(true)
    for (const bad of [0, 5, -1, 1.5, NaN, Infinity, '2', null, undefined, true]) {
      expect(isBoardRows(bad), `rows ${String(bad)}`).toBe(false)
    }
  })

  it('boardRowsOf defaults to 1 and hardens malformed rows', () => {
    expect(boardRowsOf('standard')).toBe(1)
    expect(boardRowsOf({ size: 'standard', count: 2 })).toBe(1)
    expect(boardRowsOf(STD_2R)).toBe(2)
    expect(boardRowsOf({ size: 'half', count: 1, rows: 99 })).toBe(1)
    expect(boardRowsOf({ size: 'half', count: 1, rows: 2.5 })).toBe(1)
  })

  it('boardConfigOf threads boardRows (absent / malformed = 1)', () => {
    expect(boardConfigOf({})).toEqual({ size: 'standard', count: 1, rows: 1 })
    expect(boardConfigOf({ boardRows: 3 })).toEqual({ size: 'standard', count: 1, rows: 3 })
    expect(boardConfigOf({ board: 'half', boardCount: 2, boardRows: 4 })).toEqual({
      size: 'half',
      count: 2,
      rows: 4,
    })
    expect(boardConfigOf({ boardRows: 0 })).toEqual({ size: 'standard', count: 1, rows: 1 })
    expect(boardConfigOf({ boardRows: 9 })).toEqual({ size: 'standard', count: 1, rows: 1 })
    expect(boardConfigOf({ boardRows: 2.5 })).toEqual({ size: 'standard', count: 1, rows: 1 })
  })
})

// -------------------------------------------------- prefix parsing/formatting

describe('board-row hole-ref prefix (parseHole / formatHole)', () => {
  it('parses 0-indexed row prefixes on strip and rail refs', () => {
    expect(parseHole('1:a12')).toEqual({ kind: 'strip', col: 12, row: 'a', boardRow: 1 })
    expect(parseHole('2:j63')).toEqual({ kind: 'strip', col: 63, row: 'j', boardRow: 2 })
    expect(parseHole('3:f1')).toEqual({ kind: 'strip', col: 1, row: 'f', boardRow: 3 })
    expect(parseHole('1:top+5')).toEqual({ kind: 'rail', rail: 'top+', index: 5, boardRow: 1 })
    expect(parseHole('2:bot-12')).toEqual({ kind: 'rail', rail: 'bot-', index: 12, boardRow: 2 })
    expect(parseHole('3:top-0')).toEqual({ kind: 'rail', rail: 'top-', index: 0, boardRow: 3 })
  })

  it('bare refs stay row 0 with NO boardRow key (full back-compat)', () => {
    expect(parseHole('a12')).toEqual({ kind: 'strip', col: 12, row: 'a' })
    expect(parseHole('top+5')).toEqual({ kind: 'rail', rail: 'top+', index: 5 })
  })

  it('"0:" is a non-canonical alias of bare and is normalized away', () => {
    expect(parseHole('0:a12')).toEqual({ kind: 'strip', col: 12, row: 'a' })
    expect(parseHole('0:top+5')).toEqual({ kind: 'rail', rail: 'top+', index: 5 })
    expect(formatHole(parseHole('0:a12')!)).toBe('a12')
  })

  it('formatHole emits bare for row 0 and the prefix for rows >= 1', () => {
    expect(formatHole({ kind: 'strip', col: 12, row: 'a' })).toBe('a12')
    expect(formatHole({ kind: 'strip', col: 12, row: 'a', boardRow: 0 })).toBe('a12')
    expect(formatHole({ kind: 'strip', col: 12, row: 'a', boardRow: 2 })).toBe('2:a12')
    expect(formatHole({ kind: 'rail', rail: 'bot+', index: 7, boardRow: 3 })).toBe('3:bot+7')
  })

  it('round-trips every hole of a 2-D grid', () => {
    for (const h of allHoles(HALF_2x3)) {
      const ref = formatHole(h)
      expect(parseHole(ref), `round-trip of ${ref}`).toEqual(h)
    }
  })

  it('rejects malformed and out-of-syntax row prefixes', () => {
    const bad = [
      '4:a12', // row past MAX_BOARD_ROWS-1 (prefixes are 0..3)
      '9:a12',
      '-1:a12',
      'x:a12',
      '11:a12', // multi-digit prefix
      '01:a12',
      ':a12',
      '1:', // prefix without a hole
      '1:k5', // bad row letter behind a valid prefix
      '1:a0', // bad column behind a valid prefix
      '1:a757',
      '2:top+600',
      '1:top5',
      '1:PS1:+',
      '1:1:a12', // double prefix
      '1:a12:',
      '1 :a12',
      '1: a12',
    ]
    for (const ref of bad) expect(parseHole(ref), `parseHole("${ref}")`).toBeNull()
  })
})

// ----------------------------------------------------- per-row geometry/nets

describe('per-row geometry and net ids', () => {
  it('BOARD_ROW_PITCH is 19.5 (one full mesh depth — rows abut at a molded seam)', () => {
    // = boardExtents depth of a single row (maxZ 18 − minZ −1.5): consecutive
    // board-rows TOUCH like ganged boards, the seam groove lives in the plastic
    expect(BOARD_ROW_PITCH).toBe(19.5)
    const one = boardExtents({ size: 'standard', count: 1, rows: 1 })
    expect(BOARD_ROW_PITCH).toBe(one.maxZ - one.minZ)
  })

  it('holePosition offsets z by row × BOARD_ROW_PITCH, x unchanged', () => {
    expect(holePosition(mustParse('a12'))).toEqual({ x: 12, z: 3 })
    expect(holePosition(mustParse('1:a12'))).toEqual({ x: 12, z: 3 + 19.5 })
    expect(holePosition(mustParse('3:j40'))).toEqual({ x: 40, z: 13 + 3 * 19.5 })
    expect(holePosition(mustParse('top+5'))).toEqual({ x: 8.5, z: 0 })
    expect(holePosition(mustParse('2:top+5'))).toEqual({ x: 8.5, z: 39 })
    expect(holePosition(mustParse('1:bot+0'))).toEqual({ x: 2.5, z: 16 + 19.5 })
  })

  it('netIdForHole namespaces strips and rails per board-row', () => {
    expect(netIdForHole(mustParse('a12'))).toBe('S12T')
    expect(netIdForHole(mustParse('2:a12'))).toBe('2:S12T')
    expect(netIdForHole(mustParse('2:f12'))).toBe('2:S12B')
    expect(netIdForHole(mustParse('top+3'))).toBe('R:top+')
    expect(netIdForHole(mustParse('1:top+3'))).toBe('1:R:top+')
    expect(netIdForHole(mustParse('2:bot-9'))).toBe('2:R:bot-')
  })

  it('rails on different board-rows are independent nets (the bench rule)', () => {
    const ids = [0, 1, 2, 3].map((r) =>
      netIdForHole(r === 0 ? mustParse('top+5') : mustParse(`${r}:top+5`)),
    )
    expect(new Set(ids).size).toBe(4)
    // ...while within one row the rail is still one bused net across modules
    expect(netIdForHole(mustParse('1:top+0'))).toBe(netIdForHole(mustParse('1:top+99')))
  })

  it('isHoleOnBoard bounds the board-row against config.rows', () => {
    expect(isHoleOnBoard(mustParse('1:a12'), 'standard')).toBe(false)
    expect(isHoleOnBoard(mustParse('1:a12'), { size: 'standard', count: 1 })).toBe(false)
    expect(isHoleOnBoard(mustParse('1:a12'), STD_2R)).toBe(true)
    expect(isHoleOnBoard(mustParse('2:a12'), STD_2R)).toBe(false)
    expect(isHoleOnBoard(mustParse('3:a12'), STD_4R)).toBe(true)
    expect(isHoleOnBoard(mustParse('1:top+49'), STD_2R)).toBe(true)
    expect(isHoleOnBoard(mustParse('1:top+50'), STD_2R)).toBe(false) // col bound still applies
    const manual: Hole = { kind: 'strip', col: 5, row: 'a', boardRow: -1 }
    expect(isHoleOnBoard(manual, STD_4R)).toBe(false)
  })

  it('allHoles iterates the whole grid, front row first and canonical', () => {
    const holes = [...allHoles(STD_2R)]
    expect(holes.length).toBe(BOARD_SIZES.standard.points * 2)
    expect(holes.every((h) => isHoleOnBoard(h, STD_2R))).toBe(true)
    // front row holes are canonical (no boardRow key → bare refs)
    expect(formatHole(holes[0])).toBe('a1')
    expect(holes.slice(0, BOARD_SIZES.standard.points).every((h) => h.boardRow === undefined)).toBe(
      true,
    )
    const refs = holes.map(formatHole)
    expect(refs).toContain('1:a1')
    expect(refs).toContain('1:bot+49')
    expect(new Set(refs).size).toBe(holes.length) // no duplicates across rows
    // grid = count wide × rows deep
    expect([...allHoles(HALF_2x3)].length).toBe(BOARD_SIZES.half.points * 2 * 3)
  })

  it('boardExtents grows maxZ by BOARD_ROW_PITCH per extra row', () => {
    expect(boardExtents(STD_2R)).toEqual({ minX: -0.5, maxX: 64.5, minZ: -1.5, maxZ: 37.5 })
    expect(boardExtents(STD_4R).maxZ).toBe(18 + 3 * 19.5)
    // single-row rigs are byte-compatible with the shipped extents
    expect(boardExtents({ size: 'standard', count: 1, rows: 1 })).toEqual(boardExtents('standard'))
    expect(boardExtents('standard').maxZ).toBe(18)
  })

  it('boardRowZs lists the z offset of every board-row', () => {
    expect(boardRowZs('standard')).toEqual([0])
    expect(boardRowZs(STD_2R)).toEqual([0, 19.5])
    expect(boardRowZs(HALF_2x3)).toEqual([0, 19.5, 39])
  })

  it('moduleSeamXs is unchanged per row (same x seams on every board-row)', () => {
    expect(moduleSeamXs(HALF_2x3)).toEqual(moduleSeamXs({ size: 'half', count: 2 }))
    expect(moduleSeamXs(STD_2R)).toEqual([])
  })
})

// ------------------------------------------------- packages on board-rows

describe('dip/footprint on board-rows', () => {
  it('dipHoles inherits the anchor board-row into every pin hole', () => {
    const holes = dipHoles(mustParse('1:f20'), 8, STD_2R)
    expect(holes).not.toBeNull()
    expect(holes!.map(formatHole)).toEqual([
      '1:f20', '1:f21', '1:f22', '1:f23',
      '1:e23', '1:e22', '1:e21', '1:e20',
    ])
    expect(spansBoardRows(holes!)).toBe(false)
  })

  it('dipHoles/footprintHoles reject anchors on missing board-rows', () => {
    expect(dipHoles(mustParse('1:f20'), 8, 'standard')).toBeNull()
    expect(dipHoles(mustParse('2:f20'), 8, STD_2R)).toBeNull()
    expect(dipHoles(mustParse('1:f20'), 8, STD_2R)).not.toBeNull()
    const offsets = CATALOG.pushbutton.footprintOffsets!
    expect(footprintHoles(mustParse('1:f10'), offsets, 'standard')).toBeNull()
    expect(footprintHoles(mustParse('1:f10'), offsets, STD_2R)).not.toBeNull()
    expect(footprintHoles(mustParse('1:f10'), offsets, STD_2R)!.map(formatHole)).toEqual([
      '1:f10', '1:e10', '1:f12', '1:e12',
    ])
  })

  it('componentPinHoles threads board-rows for leads, dip and probe', () => {
    const r = { id: 'R1', type: 'resistor', holes: ['1:a10', '1:a20'] }
    expect(componentPinHoles(r, CATALOG.resistor, 'standard')).toBeNull()
    expect(componentPinHoles(r, CATALOG.resistor, STD_2R)).not.toBeNull()
    const u = { id: 'U1', type: 'ne555', at: '1:f20' }
    expect(componentPinHoles(u, CATALOG.ne555, STD_2R)).not.toBeNull()
    const p = { id: 'P1', type: 'scope_probe', holes: ['1:c30'] }
    expect(componentPinHoles(p, CATALOG.scope_probe, STD_2R)![0]).toEqual({
      kind: 'strip', col: 30, row: 'c', boardRow: 1,
    })
  })

  it('spansBoardRows detects mixed rows and tolerates nulls/empty', () => {
    expect(spansBoardRows([mustParse('a12'), mustParse('1:a13')])).toBe(true)
    expect(spansBoardRows([mustParse('1:a12'), mustParse('2:a12')])).toBe(true)
    expect(spansBoardRows([mustParse('a12'), mustParse('e12')])).toBe(false)
    expect(spansBoardRows([mustParse('1:a12'), mustParse('1:top+5')])).toBe(false)
    expect(spansBoardRows([null, mustParse('2:a12'), null])).toBe(false)
    expect(spansBoardRows([])).toBe(false)
    // absent boardRow and explicit 0 are the same row
    expect(
      spansBoardRows([{ kind: 'strip', col: 1, row: 'a', boardRow: 0 }, mustParse('b1')]),
    ).toBe(false)
  })
})

// --------------------------------------------------------------- remapLayout

/** A layout exercising every ref shape: leads, dip, probe, rails, terminals. */
function remapFixture(): CircuitLayout {
  return {
    version: 1,
    name: 'remap fixture',
    components: [
      { id: 'PS1', type: 'power_supply', params: { voltage: 5 } },
      { id: 'U1', type: 'ne555', at: 'f20' },
      { id: 'R1', type: 'resistor', params: { resistance: 470 }, holes: ['j12', 'top+5'] },
      { id: 'P1', type: 'scope_probe', holes: ['c30'] },
      { id: 'D1', type: 'led', params: { color: 'red' }, holes: ['1:i26', '1:i30'] },
    ],
    wires: [
      { id: 'w1', from: 'PS1:+', to: 'top+0', color: 'red' },
      { id: 'w2', from: 'bot-7', to: 'a10', color: 'black' },
      { id: 'w3', from: '1:top+3', to: '2:a5', color: 'yellow' },
    ],
  }
}

describe('remapLayout (grid growth toward the top-left origin)', () => {
  it('shifts strip columns and rail indices proportionally (one standard module)', () => {
    const out = remapLayout(remapFixture(), 63, 0)
    expect(out.components.find((c) => c.id === 'U1')!.at).toBe('f83')
    expect(out.components.find((c) => c.id === 'R1')!.holes).toEqual(['j75', 'top+55'])
    expect(out.components.find((c) => c.id === 'P1')!.holes).toEqual(['c93'])
    expect(out.wires.find((w) => w.id === 'w2')!.from).toBe('bot-57')
    expect(out.wires.find((w) => w.id === 'w2')!.to).toBe('a73')
    // row-prefixed refs keep their row while shifting columns/rails
    expect(out.wires.find((w) => w.id === 'w3')!.from).toBe('1:top+53')
    expect(out.wires.find((w) => w.id === 'w3')!.to).toBe('2:a68')
  })

  it('rail shift follows the layout size preset (half: 30 cols = 25 rail holes)', () => {
    const l = remapFixture()
    l.board = 'half'
    const out = remapLayout(l, 30, 0)
    expect(out.components.find((c) => c.id === 'R1')!.holes).toEqual(['j42', 'top+30'])
    expect(out.wires.find((w) => w.id === 'w2')!.from).toBe('bot-32')
  })

  it('shifts board-rows: bare refs gain a prefix, prefixed refs deepen', () => {
    const out = remapLayout(remapFixture(), 0, 1)
    expect(out.components.find((c) => c.id === 'U1')!.at).toBe('1:f20')
    expect(out.components.find((c) => c.id === 'R1')!.holes).toEqual(['1:j12', '1:top+5'])
    expect(out.components.find((c) => c.id === 'D1')!.holes).toEqual(['2:i26', '2:i30'])
    expect(out.wires.find((w) => w.id === 'w2')!.from).toBe('1:bot-7')
    expect(out.wires.find((w) => w.id === 'w3')!.from).toBe('2:top+3')
    expect(out.wires.find((w) => w.id === 'w3')!.to).toBe('3:a5')
  })

  it('shifts both axes at once and skips terminal refs', () => {
    const out = remapLayout(remapFixture(), 63, 1)
    expect(out.components.find((c) => c.id === 'U1')!.at).toBe('1:f83')
    expect(out.wires.find((w) => w.id === 'w1')!.from).toBe('PS1:+') // terminal untouched
    expect(out.wires.find((w) => w.id === 'w1')!.to).toBe('1:top+50')
  })

  it('is pure: the input layout is untouched; ids/params/colors are preserved', () => {
    const input = remapFixture()
    const snapshot = JSON.parse(JSON.stringify(input))
    const out = remapLayout(input, 63, 1)
    expect(input).toEqual(snapshot)
    expect(out).not.toBe(input)
    expect(out.name).toBe('remap fixture')
    expect(out.components.map((c) => c.id)).toEqual(['PS1', 'U1', 'R1', 'P1', 'D1'])
    expect(out.components.find((c) => c.id === 'R1')!.params).toEqual({ resistance: 470 })
    expect(out.wires.find((w) => w.id === 'w3')!.color).toBe('yellow')
    // off-board components stay hole-free
    expect(out.components.find((c) => c.id === 'PS1')!.holes).toBeUndefined()
  })

  it('zero deltas are an identity (modulo object copies)', () => {
    const input = remapFixture()
    expect(remapLayout(input, 0, 0)).toEqual(input)
  })

  it('negative deltas undo positive ones exactly (while refs stay in syntax range)', () => {
    const input = remapFixture()
    expect(remapLayout(remapLayout(input, 63, 1), -63, -1)).toEqual(input)
    expect(remapLayout(remapLayout(input, 126, 1), -126, -1)).toEqual(input)
    // the fixture's deepest ref is on board-row 2, so rowDelta +1 is the most
    // that stays inside the "3:" prefix ceiling — beyond it, refs become
    // unparseable on purpose (loud failure, never silent clamping)
    expect(parseHole(remapLayout(input, 0, 2).wires.find((w) => w.id === 'w3')!.to)).toBeNull()
  })

  it('never throws and never silently clamps: out-of-range shifts fail loudly downstream', () => {
    const out = remapLayout(remapFixture(), -10, -1)
    const r1 = out.components.find((c) => c.id === 'R1')!
    // j12 shifted to column 2 stays valid; the bare row shifted to -1 must NOT
    // collapse back onto an existing hole — it becomes an unparseable ref that
    // validation rejects loudly
    for (const ref of [r1.holes![0], r1.holes![1], out.components.find((c) => c.id === 'U1')!.at!]) {
      expect(parseHole(ref), `"${ref}" must not silently re-enter the grid`).toBeNull()
    }
    // unparseable refs (already-corrupt layouts) pass through verbatim
    const weird: CircuitLayout = {
      version: 1,
      components: [],
      wires: [{ id: 'w1', from: 'garbage!!', to: 'PS9:zap' }],
    }
    const shifted = remapLayout(weird, 63, 1)
    expect(shifted.wires[0]).toEqual({ id: 'w1', from: 'garbage!!', to: 'PS9:zap' })
    // even a malformed board field never throws (rail delta falls back to standard)
    const corrupt = { ...remapFixture(), board: 'mega' as never }
    expect(() => remapLayout(corrupt, 63, 0)).not.toThrow()
    expect(remapLayout(corrupt, 63, 0).components.find((c) => c.id === 'R1')!.holes).toEqual([
      'j75', 'top+55',
    ])
  })
})

// ----------------------------------------------------------------- validator

describe('validateLayout board-row awareness', () => {
  it('accepts boardRows 2 and bounds-checks refs per row', () => {
    const l = withRows(
      poweredLayout(
        [twoLead('R1', 'resistor', '1:a10', '1:a20', { resistance: 1000 })],
        [wire('top+1', '1:top+0', 'red'), wire('top-1', '1:top-0', 'black')],
      ),
      2,
    )
    const res = validateLayout(l)
    expect(res.errors, JSON.stringify(res.errors)).toEqual([])
    expect(res.ok).toBe(true)
    expect(res.layout?.boardRows).toBe(2)
  })

  it('boardRows 1 is preserved explicitly; absent stays absent', () => {
    const one = validateLayout(withRows(poweredLayout([], []), 1))
    expect(one.ok).toBe(true)
    expect(one.layout?.boardRows).toBe(1)
    const absent = validateLayout(poweredLayout([], []))
    expect(absent.ok).toBe(true)
    expect(absent.layout?.boardRows).toBeUndefined()
  })

  it('rejects non-integer / out-of-range boardRows', () => {
    for (const bad of [0, 5, 2.5, -1, '2', true]) {
      const l = poweredLayout([], []) as unknown as Record<string, unknown>
      l.boardRows = bad
      const res = validateLayout(l)
      expect(res.ok, `boardRows ${JSON.stringify(bad)}`).toBe(false)
      expect(
        res.errors.some((e) => e.includes('"boardRows"') && e.includes('1 to 4')),
        res.errors.join('\n'),
      ).toBe(true)
    }
  })

  it('a ref on a missing board-row gets an actionable row error', () => {
    const l = poweredLayout([twoLead('R1', 'resistor', '1:a10', '1:a20')], [])
    const res = validateLayout(l)
    expect(res.ok).toBe(false)
    const msg = res.errors.join('\n')
    expect(msg).toContain('"1:a10" is on board-row 1')
    expect(msg).toContain('"boardRows"')

    const l2 = withRows(poweredLayout([], [wire('3:top+5', 'a10')]), 2)
    const res2 = validateLayout(l2)
    expect(res2.ok).toBe(false)
    expect(res2.errors.join('\n')).toContain('is on board-row 3')
    expect(res2.errors.join('\n')).toContain('board-rows 0..1')
  })

  it('DIP/footprint anchors are row-bounded with a row-specific error', () => {
    const bad = validateLayout(poweredLayout([dip('U1', 'ne555', '1:f20')], []))
    expect(bad.ok).toBe(false)
    const msg = bad.errors.join('\n')
    expect(msg).toContain('"U1"')
    expect(msg).toContain('board-row 1')
    expect(msg).not.toContain('columns') // the row, not the width, is the problem

    const ok = validateLayout(withRows(poweredLayout([dip('U1', 'ne555', '1:f20')], []), 2))
    expect(ok.errors, JSON.stringify(ok.errors)).toEqual([])

    const btn = validateLayout(withRows(poweredLayout([dip('SW1', 'pushbutton', '2:f10')], []), 2))
    expect(btn.ok).toBe(false)
    expect(btn.errors.join('\n')).toContain('board-row 2')
  })

  it('a DIP on one board-row never trips the mixed-row error (pins inherit the anchor row)', () => {
    const res = validateLayout(withRows(poweredLayout([dip('U1', 'ne555', '3:f20')], []), 4))
    expect(res.errors, JSON.stringify(res.errors)).toEqual([])
    // the geometric-impossibility guard exists for mixed-row pin sets
    expect(spansBoardRows([mustParse('e20'), mustParse('3:f20')])).toBe(true)
  })

  it('wires and flexible leaded parts may span board-rows', () => {
    const l = withRows(
      poweredLayout(
        [twoLead('R1', 'resistor', 'j12', '1:a12', { resistance: 1000 })],
        [wire('a12', '1:j12', 'green'), wire('top+1', '1:top+0', 'red')],
      ),
      2,
    )
    const res = validateLayout(l)
    expect(res.errors, JSON.stringify(res.errors)).toEqual([])
  })

  it('occupancy is per-row: "a12" and "1:a12" are different holes', () => {
    const l = withRows(
      poweredLayout([
        twoLead('R1', 'resistor', 'a12', 'a20', { resistance: 1000 }),
        twoLead('R2', 'resistor', '1:a12', '1:a20', { resistance: 1000 }),
      ], []),
      2,
    )
    expect(validateLayout(l).errors).toEqual([])

    const clash = withRows(
      poweredLayout([
        twoLead('R1', 'resistor', '1:a12', '1:a20', { resistance: 1000 }),
        twoLead('R2', 'resistor', '1:a12', '1:a25', { resistance: 1000 }),
      ], []),
      2,
    )
    const res = validateLayout(clash)
    expect(res.ok).toBe(false)
    expect(res.errors.join('\n')).toContain('"1:a12"')
  })

  it('rails are independent per row: an unjumpered deep row leaves chips unpowered', () => {
    // U1 lives on board-row 1 and is wired to row 1's rails; PS1 feeds row 0.
    const chipOnRow1 = (jumpered: boolean): CircuitLayout =>
      withRows(
        poweredLayout(
          [dip('U1', 'ne555', '1:f20')],
          [
            wire('1:a20', '1:top+3', 'red'), // VCC strip → row-1 + rail
            wire('1:j20', '1:top-3', 'black'), // GND strip → row-1 - rail
            ...(jumpered
              ? [wire('top+1', '1:top+0', 'red'), wire('top-1', '1:top-0', 'black')]
              : []),
          ],
        ),
        2,
      )

    const unpowered = validateLayout(chipOnRow1(false))
    expect(unpowered.ok).toBe(true) // electrically dead, not invalid
    const warnings = unpowered.warnings.join('\n')
    expect(warnings).toContain('supply pin VCC (hole 1:e20)')
    expect(warnings).toContain('supply pin GND (hole 1:f20)')

    const powered = validateLayout(chipOnRow1(true))
    expect(powered.ok).toBe(true)
    expect(powered.warnings.filter((w) => w.includes('"U1"'))).toEqual([])
  })
})

// -------------------------------------------------------------- back-compat

describe('board-row back-compat', () => {
  it('every curated example still validates unchanged (no boardRows field)', () => {
    for (const [name, raw] of [
      ['blinky-555', blinkyRaw],
      ['counter', counterRaw],
      ['date-display', dateRaw],
      ['night-light', nightRaw],
    ] as [string, unknown][]) {
      const res = validateLayout(raw)
      expect(res.errors, `${name}: ${JSON.stringify(res.errors)}`).toEqual([])
      expect(res.ok).toBe(true)
      expect(res.layout?.boardRows).toBeUndefined()
    }
  })

  it('FEW_SHOT examples are unchanged: no boardRows, zero errors, stable refs', () => {
    for (const ex of FEW_SHOT_EXAMPLES) {
      expect(ex.boardRows).toBeUndefined()
      const res = validateLayout(ex)
      expect(res.errors, `${ex.name}: ${JSON.stringify(res.errors)}`).toEqual([])
      // none of the shipped examples use row prefixes
      for (const c of ex.components) {
        for (const ref of [...(c.holes ?? []), ...(c.at ? [c.at] : [])]) {
          expect(ref).not.toContain(':')
        }
      }
    }
  })
})

// ------------------------------------------------------------- LLM plumbing

describe('LLM board-row plumbing', () => {
  it('the prompt documents the grid: prefix syntax, independent rails, growth', () => {
    const p = buildSystemPrompt({ size: 'standard', count: 1, rows: 1 })
    expect(p).toContain('"boardRows"')
    expect(p).toContain('"1:a12"')
    expect(p).toContain('INDEPENDENT')
    expect(p.toLowerCase()).toContain('jumper')
    expect(p).toContain('0-INDEXED')
    expect(p).toContain('must sit entirely on ONE board-row')
  })

  it('the prompt names the active grid depth when rows > 1', () => {
    const p = buildSystemPrompt({ size: 'standard', count: 1, rows: 3 })
    expect(p).toContain('3 board-rows deep ("boardRows": 3)')
    expect(p).toContain('"2:a12"')
    // single-row prompts keep the shipped active line
    expect(buildSystemPrompt('standard')).toContain('ACTIVE board is the Standard 830-point')
  })

  it('stays deterministic per config; rows changes the prompt, rows 1 ≡ absent', () => {
    const cfg: BoardConfig = { size: 'half', count: 2, rows: 2 }
    expect(buildSystemPrompt(cfg)).toBe(buildSystemPrompt({ size: 'half', count: 2, rows: 2 }))
    expect(buildSystemPrompt({ size: 'half', count: 2, rows: 2 })).not.toBe(
      buildSystemPrompt({ size: 'half', count: 2 }),
    )
    expect(buildSystemPrompt({ size: 'half', count: 1, rows: 1 })).toBe(buildSystemPrompt('half'))
  })

  it('worked examples in the prompt pin an explicit boardRows', () => {
    expect(buildSystemPrompt('half')).toContain('"boardRows": 1')
  })

  it('the output schema requires boardRows on the circuit', () => {
    const props = (CIRCUIT_OUTPUT_SCHEMA as { properties: Record<string, unknown> }).properties
    const circuit = props.circuit as {
      required: string[]
      properties: { boardRows: { anyOf: { type: string }[] } }
    }
    expect(circuit.required).toContain('boardRows')
    expect(circuit.properties.boardRows.anyOf.map((b) => b.type)).toEqual(['integer', 'null'])
  })

  it('converters round-trip boardRows; null resolves to the active rig', () => {
    const l = withRows(poweredLayout([], []), 3)
    const emitted = layoutToEmit(l)
    expect(emitted.boardRows).toBe(3)
    expect(emitToLayout(emitted).boardRows).toBe(3)

    const single = layoutToEmit(poweredLayout([], []))
    expect(single.boardRows).toBeNull()
    expect(emitToLayout(single, { size: 'standard', count: 1, rows: 2 }).boardRows).toBe(2)
    expect(emitToLayout(single, 'standard').boardRows).toBeUndefined()
    expect(emitToLayout(single, { size: 'standard', count: 2 }).boardRows).toBeUndefined()
    expect(emitToLayout(single).boardRows).toBeUndefined()
    // an explicit value wins over the active one; rows 1 stays canonical-absent
    expect(
      emitToLayout({ ...single, boardRows: 4 }, { size: 'standard', count: 1, rows: 2 }).boardRows,
    ).toBe(4)
    expect(
      emitToLayout({ ...single, boardRows: 1 }, { size: 'standard', count: 1, rows: 2 }).boardRows,
    ).toBeUndefined()
  })

  it('extractEnvelope tolerates a missing or bogus boardRows', () => {
    const env = extractEnvelope({
      explanation: 'x',
      circuit: { name: 'c', board: null, boardCount: null, boardRows: 99, components: [], wires: [] },
    })
    expect(env.circuit.boardRows).toBeNull()
    const env2 = extractEnvelope({
      explanation: 'x',
      circuit: { name: 'c', board: null, boardCount: null, boardRows: 2, components: [], wires: [] },
    })
    expect(env2.circuit.boardRows).toBe(2)
    const env3 = extractEnvelope({
      explanation: 'x',
      circuit: { name: 'c', board: null, boardCount: null, components: [], wires: [] },
    })
    expect(env3.circuit.boardRows).toBeNull()
  })

  it('a full envelope → layout → validator pipeline accepts a 2-row circuit', () => {
    const env = extractEnvelope({
      explanation: 'two rows',
      circuit: {
        name: 'rows',
        board: null,
        boardCount: null,
        boardRows: 2,
        components: [
          { id: 'PS1', type: 'power_supply', at: null, holes: [], params: [] },
          {
            id: 'R1', type: 'resistor', at: null, holes: ['1:a10', '1:a20'],
            params: [{ key: 'resistance', value: 1000 }],
          },
        ],
        wires: [
          { id: 'w1', from: 'PS1:+', to: 'top+0', color: 'red' },
          { id: 'w2', from: 'PS1:-', to: 'top-0', color: 'black' },
          { id: 'w3', from: 'top+1', to: '1:top+0', color: 'red' },
        ],
      },
      expectations: [],
    })
    const candidate = emitToLayout(env.circuit, { size: 'standard', count: 1, rows: 1 })
    expect(candidate.boardRows).toBe(2) // explicit beats the active 1-row rig
    const res = validateLayout(candidate)
    expect(res.errors, JSON.stringify(res.errors)).toEqual([])
    expect(res.ok).toBe(true)
  })
})
