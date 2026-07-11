/**
 * Multi-board rigs (BoardConfig = size preset × module count 1..6): raised
 * syntax ceilings, per-config bounds, continuous column/rail numbering,
 * module seams (rigid packages may not straddle them; wires may), validator
 * boardCount + seam rules, store setBoardCount/setBoardSize shrink
 * protection + undo round-trips, netlist continuity across seams, and LLM
 * prompt/schema boardCount plumbing. Owned by the tests agent.
 */
import { beforeEach, describe, expect, it } from 'vitest'
import type { BoardConfig, CircuitLayout } from '../src/model/types'
import {
  asBoardConfig,
  BOARD_SIZES,
  boardConfigOf,
  isBoardCount,
  MAX_BOARD_COUNT,
} from '../src/model/types'
import {
  allHoles,
  boardExtents,
  componentPinHoles,
  dipHoles,
  footprintHoles,
  formatHole,
  isHoleOnBoard,
  moduleOfCol,
  moduleOfRailIndex,
  moduleSeamXs,
  parseHole,
  spansSeam,
} from '../src/model/breadboard'
import { validateLayout } from '../src/model/validate'
import { CATALOG } from '../src/model/catalog'
import { buildNetlist } from '../src/sim/netlist'
import { SimEngine } from '../src/sim/engine'
import { buildSystemPrompt } from '../src/llm/prompt'
import { CIRCUIT_OUTPUT_SCHEMA, emitToLayout, extractEnvelope, layoutToEmit } from '../src/llm/schema'
import { FEW_SHOT_EXAMPLES } from '../src/llm/examples'
import { __resetHistoryForTests, placementValid, useStore } from '../src/state/store'
import { dip, mustParse, poweredLayout, twoLead, wire } from './helpers'

const STD2: BoardConfig = { size: 'standard', count: 2 }
const STD3: BoardConfig = { size: 'standard', count: 3 }

// ------------------------------------------------------------ config basics

describe('BoardConfig / boardConfigOf', () => {
  it('MAX_BOARD_COUNT is 6 and isBoardCount guards integers 1..6', () => {
    expect(MAX_BOARD_COUNT).toBe(6)
    for (const n of [1, 2, 3, 4, 5, 6]) expect(isBoardCount(n), `count ${n}`).toBe(true)
    for (const bad of [0, 7, -1, 1.5, NaN, Infinity, '2', null, undefined]) {
      expect(isBoardCount(bad), `count ${String(bad)}`).toBe(false)
    }
  })

  it('boardConfigOf defaults to standard × 1 × 1 row and hardens malformed counts', () => {
    // boardConfigOf returns an explicit `rows` since the 2-D grid (absent = 1)
    expect(boardConfigOf({})).toEqual({ size: 'standard', count: 1, rows: 1 })
    expect(boardConfigOf({ board: 'half', boardCount: 3 })).toEqual({
      size: 'half',
      count: 3,
      rows: 1,
    })
    expect(boardConfigOf({ boardCount: 99 })).toEqual({ size: 'standard', count: 1, rows: 1 })
    expect(boardConfigOf({ boardCount: 2.5 })).toEqual({ size: 'standard', count: 1, rows: 1 })
  })

  it('asBoardConfig normalizes a bare size id to count 1', () => {
    expect(asBoardConfig('labxl')).toEqual({ size: 'labxl', count: 1 })
    expect(asBoardConfig(STD2)).toBe(STD2)
  })
})

// ------------------------------------------------------- raised syntax ceilings

describe('parseHole multi-board syntax ceilings', () => {
  it('parses columns up to 756 (Lab XL × 6) and rejects 757', () => {
    expect(parseHole('a200')).toEqual({ kind: 'strip', col: 200, row: 'a' })
    expect(parseHole('a756')).toEqual({ kind: 'strip', col: 756, row: 'a' })
    expect(parseHole('a757')).toBeNull()
    expect(parseHole('j999')).toBeNull()
  })

  it('parses rail indices up to 599 (Lab XL × 6) and rejects 600', () => {
    expect(parseHole('top+150')).toEqual({ kind: 'rail', rail: 'top+', index: 150 })
    expect(parseHole('bot-599')).toEqual({ kind: 'rail', rail: 'bot-', index: 599 })
    expect(parseHole('top+600')).toBeNull()
  })
})

// ----------------------------------------------------- per-config bounds

describe('isHoleOnBoard per BoardConfig', () => {
  it('total columns = cols × count, continuous across modules', () => {
    expect(isHoleOnBoard(mustParse('a64'), 'standard')).toBe(false)
    expect(isHoleOnBoard(mustParse('a64'), STD2)).toBe(true) // board 2 starts at col 64
    expect(isHoleOnBoard(mustParse('a126'), STD2)).toBe(true)
    expect(isHoleOnBoard(mustParse('a127'), STD2)).toBe(false)
    expect(isHoleOnBoard(mustParse('a127'), STD3)).toBe(true)
    expect(isHoleOnBoard(mustParse('a60'), { size: 'half', count: 2 })).toBe(true)
    expect(isHoleOnBoard(mustParse('a61'), { size: 'half', count: 2 })).toBe(false)
    expect(isHoleOnBoard(mustParse('a756'), { size: 'labxl', count: 6 })).toBe(true)
  })

  it('total rail holes = railHoles × count, continuous indices', () => {
    expect(isHoleOnBoard(mustParse('top+50'), 'standard')).toBe(false)
    expect(isHoleOnBoard(mustParse('top+50'), STD2)).toBe(true)
    expect(isHoleOnBoard(mustParse('top+99'), STD2)).toBe(true)
    expect(isHoleOnBoard(mustParse('top+100'), STD2)).toBe(false)
    expect(isHoleOnBoard(mustParse('bot-599'), { size: 'labxl', count: 6 })).toBe(true)
  })

  it('a bare size id still means a single board (back-compat)', () => {
    expect(isHoleOnBoard(mustParse('a63'), 'standard')).toBe(true)
    expect(isHoleOnBoard(mustParse('a63'), { size: 'standard', count: 1 })).toBe(true)
  })

  it('allHoles / boardExtents scale with the count', () => {
    let n = 0
    for (const h of allHoles(STD2)) {
      expect(isHoleOnBoard(h, STD2)).toBe(true)
      n++
    }
    expect(n).toBe(BOARD_SIZES.standard.points * 2)
    expect(boardExtents(STD2)).toEqual({ minX: -0.5, maxX: 127.5, minZ: -1.5, maxZ: 18 })
    expect(boardExtents('standard')).toEqual(boardExtents({ size: 'standard', count: 1 }))
  })
})

// ------------------------------------------------------- modules + seams

describe('module arithmetic and seam detection', () => {
  it('moduleOfCol is 1-based with continuous numbering', () => {
    expect(moduleOfCol(1, 'standard')).toBe(1)
    expect(moduleOfCol(63, 'standard')).toBe(1)
    expect(moduleOfCol(64, 'standard')).toBe(2) // standard board 2 starts at col 64
    expect(moduleOfCol(126, 'standard')).toBe(2)
    expect(moduleOfCol(127, 'standard')).toBe(3)
    expect(moduleOfCol(31, 'half')).toBe(2)
  })

  it('moduleOfRailIndex is 1-based with continuous indices', () => {
    expect(moduleOfRailIndex(0, 'standard')).toBe(1)
    expect(moduleOfRailIndex(49, 'standard')).toBe(1)
    expect(moduleOfRailIndex(50, 'standard')).toBe(2)
    expect(moduleOfRailIndex(25, 'half')).toBe(2)
  })

  it('moduleSeamXs yields count−1 boundaries at k·cols + 0.5', () => {
    expect(moduleSeamXs({ size: 'standard', count: 1 })).toEqual([])
    expect(moduleSeamXs(STD2)).toEqual([63.5])
    expect(moduleSeamXs(STD3)).toEqual([63.5, 126.5])
    expect(moduleSeamXs({ size: 'half', count: 4 })).toEqual([30.5, 60.5, 90.5])
  })

  it('a DIP-8 at f61 on standard × 2 fits the bounds but straddles the 63|64 seam', () => {
    const holes = dipHoles(mustParse('f61'), 8, STD2)
    expect(holes).not.toBeNull() // cols 61..64 exist on the rig...
    expect(holes!.map((h) => formatHole(h))).toEqual([
      'f61', 'f62', 'f63', 'f64',
      'e64', 'e63', 'e62', 'e61',
    ])
    expect(spansSeam(holes!, STD2)).toBe(true) // ...but cross the module gap
  })

  it('a DIP-8 at f64 sits entirely on board 2 — no seam', () => {
    const holes = dipHoles(mustParse('f64'), 8, STD2)
    expect(holes).not.toBeNull()
    expect(spansSeam(holes!, STD2)).toBe(false)
    // and at f60 entirely on board 1
    expect(spansSeam(dipHoles(mustParse('f60'), 8, STD2)!, STD2)).toBe(false)
  })

  it('spansSeam is always false on a single board and ignores nulls/rails', () => {
    const holes = dipHoles(mustParse('f61'), 8, STD2)!
    expect(spansSeam(holes, { size: 'standard', count: 1 })).toBe(false)
    expect(spansSeam([null, mustParse('top+5'), null], STD2)).toBe(false)
  })

  it('footprints respect rig bounds and detect seams too', () => {
    const offsets = CATALOG.pushbutton.footprintOffsets!
    const straddling = footprintHoles(mustParse('f62'), offsets, STD2) // cols 62 + 64
    expect(straddling).not.toBeNull()
    expect(spansSeam(straddling!, STD2)).toBe(true)
    const onBoard2 = footprintHoles(mustParse('f64'), offsets, STD2)
    expect(onBoard2).not.toBeNull()
    expect(spansSeam(onBoard2!, STD2)).toBe(false)
  })

  it('componentPinHoles threads the config (leads + dip beyond one module)', () => {
    const r = { id: 'R1', type: 'resistor', holes: ['a100', 'a110'] }
    expect(componentPinHoles(r, CATALOG.resistor, 'standard')).toBeNull()
    expect(componentPinHoles(r, CATALOG.resistor, STD2)).not.toBeNull()
    const u = { id: 'U1', type: 'ne555', at: 'f100' }
    expect(componentPinHoles(u, CATALOG.ne555, STD2)).not.toBeNull()
  })
})

// ----------------------------------------------------------- validator

function withConfig(l: CircuitLayout, config: Partial<BoardConfig> & { count?: number }): CircuitLayout {
  if (config.size) l.board = config.size
  if (config.count !== undefined) l.boardCount = config.count
  return l
}

describe('validateLayout multi-board awareness', () => {
  it('accepts boardCount 2 and bounds-checks against the whole rig', () => {
    const l = withConfig(
      poweredLayout([twoLead('R1', 'resistor', 'a100', 'a110', { resistance: 1000 })], []),
      { count: 2 },
    )
    const res = validateLayout(l)
    expect(res.errors, JSON.stringify(res.errors)).toEqual([])
    expect(res.ok).toBe(true)
    expect(res.layout?.boardCount).toBe(2)
    expect(res.layout?.board).toBeUndefined() // size stays implicit standard
  })

  it('rejects holes beyond the rig with a rig-labelled error', () => {
    const l = withConfig(
      poweredLayout([twoLead('R1', 'resistor', 'a130', 'a135', { resistance: 1000 })], []),
      { count: 2 },
    )
    const res = validateLayout(l)
    expect(res.ok).toBe(false)
    expect(res.errors.join('\n')).toContain('off the Standard ×2 board (126 columns)')
  })

  it('rejects non-integer / out-of-range boardCount', () => {
    for (const bad of [0, 7, 2.5, -1, '3', true]) {
      const l = poweredLayout([], []) as unknown as Record<string, unknown>
      l.boardCount = bad
      const res = validateLayout(l)
      expect(res.ok, `boardCount ${JSON.stringify(bad)}`).toBe(false)
      expect(
        res.errors.some((e) => e.includes('"boardCount"') && e.includes('1 to 6')),
        res.errors.join('\n'),
      ).toBe(true)
    }
  })

  it('boardCount 1 is preserved explicitly; absent stays absent', () => {
    const one = validateLayout(withConfig(poweredLayout([], []), { count: 1 }))
    expect(one.ok).toBe(true)
    expect(one.layout?.boardCount).toBe(1)
    const absent = validateLayout(poweredLayout([], []))
    expect(absent.ok).toBe(true)
    expect(absent.layout?.boardCount).toBeUndefined()
  })

  it('a DIP straddling the seam is rejected with an actionable message', () => {
    const l = withConfig(poweredLayout([dip('U3', 'ne555', 'f61')], []), { count: 2 })
    const res = validateLayout(l)
    expect(res.ok).toBe(false)
    const msg = res.errors.join('\n')
    expect(msg).toContain('"U3"')
    expect(msg).toContain('crosses the seam between board 1 and board 2')
    expect(msg).toContain('shift it left or right')
  })

  it('the same DIP shifted onto one module validates', () => {
    for (const at of ['f60', 'f64'] as const) {
      const l = withConfig(poweredLayout([dip('U3', 'ne555', at)], []), { count: 2 })
      const res = validateLayout(l)
      expect(res.errors, `${at}: ${JSON.stringify(res.errors)}`).toEqual([])
    }
  })

  it('a footprint straddling the seam is rejected; shifted it validates', () => {
    const bad = withConfig(poweredLayout([dip('SW1', 'pushbutton', 'f62')], []), { count: 2 })
    const res = validateLayout(bad)
    expect(res.ok).toBe(false)
    expect(res.errors.join('\n')).toContain('crosses the seam between board 1 and board 2')

    const ok = validateLayout(
      withConfig(poweredLayout([dip('SW1', 'pushbutton', 'f64')], []), { count: 2 }),
    )
    expect(ok.errors, JSON.stringify(ok.errors)).toEqual([])
  })

  it('wires and leaded parts may cross seams freely', () => {
    const l = withConfig(
      poweredLayout(
        [twoLead('R1', 'resistor', 'a60', 'a70', { resistance: 1000 })], // lead each side
        [wire('b60', 'b70'), wire('top+49', 'top+50')], // strip + rail wires across the seam
      ),
      { count: 2 },
    )
    const res = validateLayout(l)
    expect(res.errors, JSON.stringify(res.errors)).toEqual([])
    expect(res.ok).toBe(true)
  })

  it('seam errors honor the module size (half seam at 30|31)', () => {
    const l = withConfig(poweredLayout([dip('U1', 'ne555', 'f29')], []), {
      size: 'half',
      count: 2,
    })
    const res = validateLayout(l)
    expect(res.ok).toBe(false)
    expect(res.errors.join('\n')).toContain('crosses the seam between board 1 and board 2')
  })
})

// ----------------------------------------------------------- netlist

describe('netlist continuity across seams', () => {
  it('a wire from a60 to a70 on standard × 2 merges the two strip nets', () => {
    const l = withConfig(poweredLayout([], [wire('a60', 'a70')]), { count: 2 })
    expect(validateLayout(l).ok).toBe(true)
    const nl = buildNetlist(l)
    expect(nl.netOf('a60')).toBeTruthy()
    expect(nl.netOf('a60')).toBe(nl.netOf('a70'))
    expect(nl.netOf('e60')).toBe(nl.netOf('e70')) // whole column-halves merged
    expect(nl.netOf('a60')).not.toBe(nl.netOf('f60')) // blocks still split
  })

  it('rails are one bused net across modules (continuous indices)', () => {
    const l = withConfig(poweredLayout([], [wire('top+99', 'a70')]), { count: 2 })
    expect(validateLayout(l).ok).toBe(true)
    const nl = buildNetlist(l)
    // top+0 (module 1, fed by PS1) and top+99 (module 2) are the same net
    expect(nl.netOf('top+0')).toBe(nl.netOf('top+99'))
    expect(nl.netOf('a70')).toBe(nl.netOf('top+0'))
  })
})

// ----------------------------------------------------------- sim engine

describe('sim engine on module 2+', () => {
  it('a resistor placed entirely on module 2 simulates (not "malformed")', () => {
    // standard × 2: columns 64..126 are module 2. R1 lives wholly there,
    // fed from the bused rails across the seam.
    const l = withConfig(
      poweredLayout(
        [twoLead('R1', 'resistor', 'a70', 'a75', { resistance: 1000 })],
        [wire('top+1', 'b70'), wire('top-1', 'b75')],
      ),
      { count: 2 },
    )
    expect(validateLayout(l).ok).toBe(true)
    const engine = new SimEngine(l)
    engine.advance(0.001)
    expect(engine.issues.map((i) => i.message).join('\n')).not.toMatch(/malformed|invalid/i)
    const r1 = engine.telemetry().components['R1']
    expect(r1).toBeDefined()
    expect(Math.abs(r1.current ?? 0)).toBeGreaterThan((5 / 1000) * 0.95)
    expect(Math.abs(r1.current ?? 0)).toBeLessThan((5 / 1000) * 1.05)
  })
})

// ----------------------------------------------------------- store

function resetStore(layout?: CircuitLayout): void {
  useStore.getState().resetSim()
  __resetHistoryForTests()
  useStore.setState({
    layout: layout ?? { version: 1, components: [], wires: [] },
    selection: [],
    mode: { kind: 'select' },
    canUndo: false,
    canRedo: false,
  })
}

describe('store setBoardCount', () => {
  beforeEach(() => resetStore())

  it('growing always succeeds and is one undoable step', () => {
    useStore.getState().addComponent('resistor', { holes: ['a1', 'a5'] })
    const res = useStore.getState().setBoardCount(3)
    expect(res).toEqual({ ok: true })
    expect(useStore.getState().layout.boardCount).toBe(3)

    useStore.getState().undo()
    expect(useStore.getState().layout.boardCount).toBeUndefined()
    expect(useStore.getState().layout.components).toHaveLength(1) // parts untouched

    useStore.getState().redo()
    expect(useStore.getState().layout.boardCount).toBe(3)
  })

  it('selecting the current count is an ok no-op (nothing recorded)', () => {
    const res = useStore.getState().setBoardCount(1)
    expect(res).toEqual({ ok: true })
    expect(useStore.getState().canUndo).toBe(false)
    expect(useStore.getState().layout.boardCount).toBeUndefined()
  })

  it('rejects counts outside 1..6 without touching the layout', () => {
    for (const bad of [0, 7, 2.5, NaN]) {
      const res = useStore.getState().setBoardCount(bad)
      expect(res.ok, `count ${bad}`).toBe(false)
      expect(res.error).toBeTruthy()
    }
    expect(useStore.getState().canUndo).toBe(false)
  })

  it('placement works on board 2 once the count grows', () => {
    expect(placementValid(useStore.getState().layout, 'resistor', 'a100')).toBe(false)
    useStore.getState().setBoardCount(2)
    const layout = useStore.getState().layout
    expect(placementValid(layout, 'resistor', 'a100')).toBe(true)
    useStore.getState().addComponent('resistor', { holes: ['a100', 'a105'] })
    expect(useStore.getState().layout.components).toHaveLength(1)
  })

  it('placement refuses a DIP straddling the seam (ghost agrees with add)', () => {
    useStore.getState().setBoardCount(2)
    const layout = useStore.getState().layout
    expect(placementValid(layout, 'ne555', 'f61')).toBe(false) // straddles 63|64
    expect(placementValid(layout, 'ne555', 'f64')).toBe(true)
    useStore.getState().addComponent('ne555', { at: 'f61' })
    expect(useStore.getState().layout.components).toHaveLength(0) // refused
    useStore.getState().addComponent('ne555', { at: 'f64' })
    expect(useStore.getState().layout.components).toHaveLength(1)
  })

  it('shrinking with stranded parts is refused with a counted error', () => {
    useStore.getState().setBoardCount(2)
    useStore.getState().addComponent('resistor', { holes: ['a100', 'a105'] })
    useStore.getState().addWire('b100', 'b110', 'green')
    const before = useStore.getState().layout

    const res = useStore.getState().setBoardCount(1)
    expect(res.ok).toBe(false)
    expect(res.error).toBe('2 parts would fall off the Standard board')
    expect(useStore.getState().layout).toBe(before) // untouched

    const single = useStore.getState().setBoardCount(1)
    expect(single.ok).toBe(false) // still refused — same offenders
  })

  it('uses singular phrasing and the ×N rig name on partial shrinks', () => {
    useStore.getState().setBoardCount(3)
    useStore.getState().addComponent('resistor', { holes: ['a130', 'a135'] }) // module 3
    const res = useStore.getState().setBoardCount(2)
    expect(res.ok).toBe(false)
    expect(res.error).toBe('1 part would fall off the Standard ×2 rig')
  })

  it('shrinking succeeds when everything fits, returning to canonical absent-=1', () => {
    useStore.getState().setBoardCount(2)
    useStore.getState().addComponent('resistor', { holes: ['a1', 'a5'] })
    const res = useStore.getState().setBoardCount(1)
    expect(res).toEqual({ ok: true })
    expect(useStore.getState().layout.boardCount).toBeUndefined()
  })

  it('boardCount round-trips through export + import', () => {
    useStore.getState().setBoardCount(2)
    useStore.getState().addComponent('resistor', { holes: ['a100', 'a105'] })
    const json = useStore.getState().exportJson()
    expect(JSON.parse(json).boardCount).toBe(2)

    resetStore()
    const res = useStore.getState().loadLayout(JSON.parse(json) as CircuitLayout)
    expect(res.ok, res.errors.join('\n')).toBe(true)
    expect(useStore.getState().layout.boardCount).toBe(2)
    expect(useStore.getState().layout.components).toHaveLength(1)
  })

  it('setBoardSize validates against (newSize, current count)', () => {
    useStore.getState().setBoardCount(2)
    useStore.getState().addComponent('resistor', { holes: ['a100', 'a105'] }) // on standard module 2
    // half × 2 has only 60 columns → stranded
    const shrink = useStore.getState().setBoardSize('half')
    expect(shrink.ok).toBe(false)
    expect(shrink.error).toBe('1 part would fall off the Half ×2 rig')
    // labxl × 2 nests the holes → fine, count preserved
    const grow = useStore.getState().setBoardSize('labxl')
    expect(grow).toEqual({ ok: true })
    expect(useStore.getState().layout.board).toBe('labxl')
    expect(useStore.getState().layout.boardCount).toBe(2)
  })

  it('setBoardSize shrink protection counts packages landing on moved seams', () => {
    useStore.getState().setBoardCount(2)
    // fits bounds on half × 2 (cols 29..32 ≤ 60) but straddles half's 30|31 seam
    useStore.getState().addComponent('ne555', { at: 'f29' })
    const res = useStore.getState().setBoardSize('half')
    expect(res.ok).toBe(false)
    expect(res.error).toBe('1 part would fall off the Half ×2 rig')
  })

  it('clearBoard resets the count in one undoable step', () => {
    useStore.getState().setBoardCount(4)
    useStore.getState().clearBoard()
    expect(useStore.getState().layout.boardCount).toBeUndefined()
    useStore.getState().undo()
    expect(useStore.getState().layout.boardCount).toBe(4)
  })
})

describe('store setBoardSize / setBoardCount on multi-row grids (rows carry into the shrink target)', () => {
  beforeEach(() => resetStore())

  it('setBoardSize GROWTH succeeds with content on board-row 1 (rows preserved)', () => {
    useStore.getState().setBoardSize('half')
    useStore.getState().setBoardRows(2)
    useStore.getState().addComponent('resistor', { holes: ['1:a5', '1:a10'] })
    expect(useStore.getState().layout.components).toHaveLength(1)

    // pure growth: half → standard nests every hole; rows must not be dropped
    // from the stranded-parts target (dropping it falsely strands row-1 parts)
    const res = useStore.getState().setBoardSize('standard')
    expect(res).toEqual({ ok: true })
    expect(useStore.getState().layout.board).toBe('standard')
    expect(useStore.getState().layout.boardRows).toBe(2)
    expect(useStore.getState().layout.components).toHaveLength(1)
  })

  it('setBoardSize shrink succeeds when row-1 content fits the smaller preset', () => {
    useStore.getState().setBoardRows(2)
    useStore.getState().addComponent('resistor', { holes: ['1:a5', '1:a10'] }) // cols 5/10 fit half
    const res = useStore.getState().setBoardSize('half')
    expect(res).toEqual({ ok: true })
    expect(useStore.getState().layout.board).toBe('half')
    expect(useStore.getState().layout.boardRows).toBe(2)
  })

  it('setBoardSize shrink still refuses genuinely stranded row-1 columns', () => {
    useStore.getState().setBoardRows(2)
    useStore.getState().addComponent('resistor', { holes: ['1:a40', '1:a45'] }) // past half's col 30
    const res = useStore.getState().setBoardSize('half')
    expect(res.ok).toBe(false)
    expect(res.error).toBe('1 part would fall off the Half board')
  })

  it('setBoardCount shrink succeeds when row-1 content fits the smaller rig', () => {
    useStore.getState().setBoardSize('half')
    useStore.getState().setBoardCount(2)
    useStore.getState().setBoardRows(2)
    useStore.getState().addComponent('resistor', { holes: ['1:a5', '1:a10'] }) // wholly module 1
    const res = useStore.getState().setBoardCount(1)
    expect(res).toEqual({ ok: true })
    expect(useStore.getState().layout.boardCount).toBeUndefined()
    expect(useStore.getState().layout.boardRows).toBe(2)
  })

  it('setBoardCount shrink still refuses genuinely stranded row-1 columns', () => {
    useStore.getState().setBoardSize('half')
    useStore.getState().setBoardCount(2)
    useStore.getState().setBoardRows(2)
    useStore.getState().addComponent('resistor', { holes: ['1:a35', '1:a40'] }) // module 2 cols
    const res = useStore.getState().setBoardCount(1)
    expect(res.ok).toBe(false)
    expect(res.error).toBe('1 part would fall off the Half board')
  })
})

// ----------------------------------------------------------- LLM plumbing

describe('LLM multi-board plumbing', () => {
  it('the prompt documents modules, continuous numbering, bused rails and the seam rule', () => {
    const p = buildSystemPrompt({ size: 'standard', count: 3 })
    expect(p).toContain('ACTIVE rig is 3 Standard 830-point')
    expect(p).toContain('columns 1..189, rail holes 0..149')
    expect(p).toContain('"boardCount"')
    expect(p).toContain('board 2 starts at column 64')
    expect(p).toContain('BUSED across all modules')
    expect(p).toMatch(/seam/i)
    expect(p).toContain('never straddle a module boundary')
  })

  it('stays deterministic per config and back-compatible with bare size ids', () => {
    expect(buildSystemPrompt({ size: 'half', count: 2 })).toBe(
      buildSystemPrompt({ size: 'half', count: 2 }),
    )
    expect(buildSystemPrompt('half')).toBe(buildSystemPrompt({ size: 'half', count: 1 }))
    expect(buildSystemPrompt('half')).not.toBe(buildSystemPrompt({ size: 'half', count: 2 }))
    // the single-board prompt still names the active board the old way
    expect(buildSystemPrompt('half')).toContain('ACTIVE board is the Half 400-point')
  })

  it('the output schema requires boardCount on the circuit', () => {
    const props = (CIRCUIT_OUTPUT_SCHEMA as { properties: Record<string, unknown> }).properties
    const circuit = props.circuit as {
      required: string[]
      properties: { boardCount: { anyOf: { type: string }[] } }
    }
    expect(circuit.required).toContain('boardCount')
    expect(circuit.properties.boardCount.anyOf.map((b) => b.type)).toEqual(['integer', 'null'])
  })

  it('converters round-trip boardCount; null resolves to the active rig', () => {
    const l = withConfig(poweredLayout([], []), { count: 3 })
    const emitted = layoutToEmit(l)
    expect(emitted.boardCount).toBe(3)
    expect(emitToLayout(emitted).boardCount).toBe(3)

    const single = layoutToEmit(poweredLayout([], []))
    expect(single.boardCount).toBeNull()
    // null = the active rig's count (count 1 stays canonical-absent)
    expect(emitToLayout(single, STD2).boardCount).toBe(2)
    expect(emitToLayout(single, 'standard').boardCount).toBeUndefined()
    expect(emitToLayout(single).boardCount).toBeUndefined()
    // an explicit count wins over the active one
    expect(emitToLayout({ ...single, boardCount: 4 }, STD2).boardCount).toBe(4)
    expect(emitToLayout({ ...single, boardCount: 1 }, STD2).boardCount).toBeUndefined()
  })

  it('extractEnvelope tolerates a missing or bogus boardCount', () => {
    const env = extractEnvelope({
      explanation: 'x',
      circuit: { name: 'c', board: null, boardCount: 99, components: [], wires: [] },
    })
    expect(env.circuit.boardCount).toBeNull()
    const env2 = extractEnvelope({
      explanation: 'x',
      circuit: { name: 'c', board: null, boardCount: 2, components: [], wires: [] },
    })
    expect(env2.circuit.boardCount).toBe(2)
  })

  it('FEW_SHOT examples still validate and emit with boardCount intact', () => {
    expect(FEW_SHOT_EXAMPLES.length).toBeGreaterThanOrEqual(1)
    for (const ex of FEW_SHOT_EXAMPLES) {
      expect(ex.boardCount).toBeUndefined()
      const res = validateLayout(ex)
      expect(res.errors, `${ex.name}: ${JSON.stringify(res.errors)}`).toEqual([])
      expect(res.ok).toBe(true)
      // round-trip through the wire format keeps them valid
      const round = validateLayout(emitToLayout(layoutToEmit(ex)))
      expect(round.ok, round.errors.join('\n')).toBe(true)
    }
  })
})
