/**
 * Board size presets ('half' | 'standard' | 'labxl'): preset table, syntax vs
 * per-board bounds, size-aware footprint helpers, validator board-awareness,
 * LLM prompt/schema board plumbing. Owned by the tests agent.
 */
import { describe, expect, it } from 'vitest'
import {
  BOARD_SIZES,
  BoardSizeId,
  boardOf,
  isBoardSizeId,
  NUM_COLS,
  RAIL_HOLES,
  type CircuitLayout,
} from '../src/model/types'
import {
  allHoles,
  BOARD_EXTENTS,
  boardExtents,
  componentPinHoles,
  dipHoles,
  footprintHoles,
  holePosition,
  isHoleOnBoard,
  parseHole,
} from '../src/model/breadboard'
import { validateLayout } from '../src/model/validate'
import { CATALOG } from '../src/model/catalog'
import { buildSystemPrompt } from '../src/llm/prompt'
import {
  CIRCUIT_OUTPUT_SCHEMA,
  extractEnvelope,
  emitToLayout,
  layoutToEmit,
} from '../src/llm/schema'
import { FEW_SHOT_EXAMPLES } from '../src/llm/examples'
import { buildNetlist } from '../src/sim/netlist'
import { SimEngine } from '../src/sim/engine'
import { dip, layout, mustParse, poweredLayout, supply5, twoLead, wire } from './helpers'

const ALL_SIZES: BoardSizeId[] = ['half', 'standard', 'labxl']

// ---------------------------------------------------------------- presets

describe('BOARD_SIZES presets', () => {
  it('defines the three locked presets', () => {
    expect(BOARD_SIZES.half).toEqual({ cols: 30, railHoles: 25, label: 'Half', points: 400 })
    expect(BOARD_SIZES.standard).toEqual({
      cols: 63,
      railHoles: 50,
      label: 'Standard',
      points: 830,
    })
    expect(BOARD_SIZES.labxl).toEqual({
      cols: 126,
      railHoles: 100,
      label: 'Lab XL',
      points: 1660,
    })
  })

  it('points = total hole count (10 rows × cols + 4 rails × railHoles)', () => {
    for (const size of ALL_SIZES) {
      let n = 0
      for (const h of allHoles(size)) {
        expect(isHoleOnBoard(h, size), `allHoles(${size}) yields on-board holes`).toBe(true)
        n++
      }
      expect(n, `hole count of ${size}`).toBe(BOARD_SIZES[size].points)
    }
  })

  it('deprecated NUM_COLS / RAIL_HOLES stay the standard values', () => {
    expect(NUM_COLS).toBe(BOARD_SIZES.standard.cols)
    expect(RAIL_HOLES).toBe(BOARD_SIZES.standard.railHoles)
  })

  it('boardOf defaults absent board to standard', () => {
    expect(boardOf({})).toBe('standard')
    expect(boardOf({ board: 'half' })).toBe('half')
    expect(boardOf({ board: 'labxl' })).toBe('labxl')
  })

  it('isBoardSizeId guards the three preset ids', () => {
    for (const size of ALL_SIZES) expect(isBoardSizeId(size)).toBe(true)
    expect(isBoardSizeId('mega')).toBe(false)
    expect(isBoardSizeId(63)).toBe(false)
    expect(isBoardSizeId(undefined)).toBe(false)
  })
})

// ------------------------------------------------- bounds per preset

describe('parseHole syntax vs isHoleOnBoard bounds', () => {
  it('parses up to the cross-rig maxima (largest preset × 6 modules) and no further', () => {
    // a127 / top+100 used to be the parse ceiling; multi-board rigs raised
    // the SYNTAX maxima to Lab XL × 6 (columns 756, rail indices 599).
    expect(parseHole('a126')).toEqual({ kind: 'strip', col: 126, row: 'a' })
    expect(parseHole('a756')).toEqual({ kind: 'strip', col: 756, row: 'a' })
    expect(parseHole('a757')).toBeNull()
    expect(parseHole('top+99')).toEqual({ kind: 'rail', rail: 'top+', index: 99 })
    expect(parseHole('top+599')).toEqual({ kind: 'rail', rail: 'top+', index: 599 })
    expect(parseHole('top+600')).toBeNull()
    expect(parseHole('bot-599')).toEqual({ kind: 'rail', rail: 'bot-', index: 599 })
  })

  it('strip bounds at each preset edge', () => {
    const edges: Record<BoardSizeId, number> = { half: 30, standard: 63, labxl: 126 }
    for (const size of ALL_SIZES) {
      const last = edges[size]
      expect(isHoleOnBoard(mustParse(`j${last}`), size), `j${last} on ${size}`).toBe(true)
      // col+1 parses on every preset now (multi-board syntax ceiling) but is
      // off every SINGLE board of that preset
      expect(isHoleOnBoard(mustParse(`j${last + 1}`), size), `j${last + 1} on ${size}`).toBe(false)
    }
  })

  it('rail bounds at each preset edge', () => {
    const edges: Record<BoardSizeId, number> = { half: 25, standard: 50, labxl: 100 }
    for (const size of ALL_SIZES) {
      const last = edges[size] - 1
      expect(isHoleOnBoard(mustParse(`top+${last}`), size), `top+${last} on ${size}`).toBe(true)
      expect(
        isHoleOnBoard(mustParse(`bot-${last + 1}`), size),
        `bot-${last + 1} on ${size}`,
      ).toBe(false)
    }
  })

  it('every half hole is on standard, every standard hole is on labxl', () => {
    for (const h of allHoles('half')) expect(isHoleOnBoard(h, 'standard')).toBe(true)
    for (const h of allHoles('standard')) expect(isHoleOnBoard(h, 'labxl')).toBe(true)
  })
})

// --------------------------------------------- geometry is size-independent

describe('geometry formulas are size-independent', () => {
  it('strip x = col and rail x = 2.5 + i + floor(i/5) hold beyond the standard board', () => {
    expect(holePosition(mustParse('a126'))).toEqual({ x: 126, z: 3 })
    expect(holePosition(mustParse('top+99'))).toEqual({ x: 2.5 + 99 + 19, z: 0 })
    // grouping in 5s: gap of 2 between groups, 1 within
    expect(holePosition(mustParse('top+5')).x - holePosition(mustParse('top+4')).x).toBe(2)
    expect(holePosition(mustParse('top+96')).x - holePosition(mustParse('top+95')).x).toBe(1)
  })

  it('boardExtents scale with columns; rails always fit inside', () => {
    for (const size of ALL_SIZES) {
      const ext = boardExtents(size)
      expect(ext).toEqual({
        minX: -0.5,
        maxX: BOARD_SIZES[size].cols + 1.5,
        minZ: -1.5,
        maxZ: 18,
      })
      const lastRail = holePosition({
        kind: 'rail',
        rail: 'top+',
        index: BOARD_SIZES[size].railHoles - 1,
      })
      expect(lastRail.x, `last rail hole of ${size} inside the board`).toBeLessThan(ext.maxX)
    }
  })

  it('BOARD_EXTENTS (deprecated) equals boardExtents("standard") and the default', () => {
    expect(BOARD_EXTENTS).toEqual(boardExtents('standard'))
    expect(boardExtents()).toEqual(boardExtents('standard'))
  })
})

// ------------------------------------------------ size-aware footprints

describe('dipHoles / footprintHoles / componentPinHoles per board size', () => {
  it('DIP-8 overflow at each board edge', () => {
    expect(dipHoles(mustParse('f27'), 8, 'half')).not.toBeNull() // cols 27..30
    expect(dipHoles(mustParse('f28'), 8, 'half')).toBeNull() // needs col 31
    expect(dipHoles(mustParse('f60'), 8, 'standard')).not.toBeNull() // cols 60..63
    expect(dipHoles(mustParse('f61'), 8, 'standard')).toBeNull() // needs col 64
    expect(dipHoles(mustParse('f123'), 8, 'labxl')).not.toBeNull() // cols 123..126
    expect(dipHoles(mustParse('f124'), 8, 'labxl')).toBeNull() // needs col 127
  })

  it('dipHoles defaults to the standard board', () => {
    expect(dipHoles(mustParse('f61'), 8)).toBeNull()
    expect(dipHoles(mustParse('f61'), 8, 'labxl')).not.toBeNull()
  })

  it('footprintHoles respects the board size', () => {
    const offsets = CATALOG.pushbutton.footprintOffsets
    if (!offsets) throw new Error('pushbutton must define footprintOffsets')
    expect(footprintHoles(mustParse('f28'), offsets, 'half')).not.toBeNull() // cols 28 + 30
    expect(footprintHoles(mustParse('f29'), offsets, 'half')).toBeNull() // B side at col 31
    expect(footprintHoles(mustParse('f29'), offsets, 'standard')).not.toBeNull()
    expect(footprintHoles(mustParse('f124'), offsets, 'labxl')).not.toBeNull() // cols 124+126
    expect(footprintHoles(mustParse('f125'), offsets, 'labxl')).toBeNull()
  })

  it('componentPinHoles threads the size (leads, dip) and defaults to standard', () => {
    const r = { id: 'R1', type: 'resistor', holes: ['a100', 'a110'] }
    expect(componentPinHoles(r, CATALOG.resistor)).toBeNull() // off the standard board
    expect(componentPinHoles(r, CATALOG.resistor, 'labxl')).not.toBeNull()

    const u = { id: 'U1', type: 'ne555', at: 'f100' }
    expect(componentPinHoles(u, CATALOG.ne555)).toBeNull()
    expect(componentPinHoles(u, CATALOG.ne555, 'labxl')).not.toBeNull()
  })
})

// ----------------------------------------------------- validator awareness

/** 5V supply + a 1k resistor with one lead at the given hole. */
function circuitAt(hole: string, board?: BoardSizeId): CircuitLayout {
  const l = poweredLayout([twoLead('R1', 'resistor', hole, 'b5', { resistance: 1000 })], [])
  if (board) l.board = board
  return l
}

describe('validateLayout board awareness', () => {
  it('accepts a126 on labxl, rejects it on standard and half', () => {
    const ok = validateLayout(circuitAt('a126', 'labxl'))
    expect(ok.errors, JSON.stringify(ok.errors)).toEqual([])
    expect(ok.ok).toBe(true)
    expect(ok.layout?.board).toBe('labxl')

    for (const board of ['standard', 'half'] as const) {
      const bad = validateLayout(circuitAt('a126', board === 'standard' ? undefined : board))
      expect(bad.ok).toBe(false)
      expect(bad.errors.length).toBeGreaterThanOrEqual(1)
    }
  })

  it('missing board defaults to standard (full back-compat)', () => {
    const ok = validateLayout(circuitAt('a63'))
    expect(ok.errors, JSON.stringify(ok.errors)).toEqual([])
    expect(ok.layout?.board).toBeUndefined()

    const bad = validateLayout(circuitAt('a64'))
    expect(bad.ok).toBe(false)
  })

  it('an explicit "standard" board is preserved in the cleaned layout', () => {
    const ok = validateLayout(circuitAt('a63', 'standard'))
    expect(ok.ok).toBe(true)
    expect(ok.layout?.board).toBe('standard')
  })

  it('unknown board value is an error', () => {
    const l = circuitAt('a10') as unknown as Record<string, unknown>
    l.board = 'mega'
    const res = validateLayout(l)
    expect(res.ok).toBe(false)
    expect(res.errors.some((e) => e.includes('"board"') && e.includes('mega'))).toBe(true)
  })

  it('off-board component errors name the declared board and suggest Lab XL', () => {
    const res = validateLayout(circuitAt('a80'))
    expect(res.ok).toBe(false)
    const msg = res.errors.join('\n')
    expect(msg).toContain('"a80" is off the Standard board (63 columns)')
    expect(msg).toContain('use the Lab XL board or move it')
  })

  it('wire endpoints are bounds-checked against the declared board', () => {
    const half = poweredLayout([], [wire('a5', 'a31')])
    half.board = 'half'
    const res = validateLayout(half)
    expect(res.ok).toBe(false)
    expect(res.errors.join('\n')).toContain('is off the Half board (30 columns)')

    const labxl = poweredLayout([], [wire('a5', 'a31'), wire('top+60', 'bot-99')])
    labxl.board = 'labxl'
    const ok = validateLayout(labxl)
    expect(ok.errors, JSON.stringify(ok.errors)).toEqual([])
  })

  it('DIP overflow errors are board-specific', () => {
    const std = poweredLayout([dip('U1', 'ne555', 'f100')], [])
    const res = validateLayout(std)
    expect(res.ok).toBe(false)
    expect(res.errors.join('\n')).toContain('Standard board only has 63 columns')

    const xl = poweredLayout([dip('U1', 'ne555', 'f100')], [])
    xl.board = 'labxl'
    const ok = validateLayout(xl)
    expect(ok.errors, JSON.stringify(ok.errors)).toEqual([])
  })

  it('rail holes past the declared board are rejected', () => {
    const l = circuitAt('top+30', 'half') // half rails are 0..24
    const res = validateLayout(l)
    expect(res.ok).toBe(false)
    expect(res.errors.join('\n')).toContain('rail holes 0..24')
  })

  it('FEW_SHOT_EXAMPLES (no board field) still validate with zero errors', () => {
    expect(FEW_SHOT_EXAMPLES.length).toBeGreaterThanOrEqual(1)
    for (const ex of FEW_SHOT_EXAMPLES) {
      expect(ex.board).toBeUndefined()
      const res = validateLayout(ex)
      expect(res.errors, `${ex.name}: ${JSON.stringify(res.errors)}`).toEqual([])
      expect(res.ok).toBe(true)
    }
  })
})

// ------------------------------------------------- simulator awareness

/**
 * 5V → 330Ω → red LED → GND living ENTIRELY in the Lab XL extension
 * (strip columns > 63, rail indices > 49). Standard-board bounds would
 * reject every component hole here.
 */
function labxlLedCircuit(): CircuitLayout {
  const l = layout(
    [
      supply5(),
      twoLead('R1', 'resistor', 'b100', 'b106', { resistance: 330 }),
      twoLead('D1', 'led', 'c106', 'c108', { color: 'red' }),
    ],
    [
      wire('PS1:+', 'top+60'),
      wire('PS1:-', 'top-60'),
      wire('top+55', 'a100'),
      wire('a108', 'top-55'),
    ],
  )
  l.board = 'labxl'
  return l
}

describe('simulator board awareness (netlist + engine)', () => {
  it('the labxl LED circuit is a valid layout (sim must agree with the validator)', () => {
    const res = validateLayout(labxlLedCircuit())
    expect(res.errors, JSON.stringify(res.errors)).toEqual([])
    expect(res.ok).toBe(true)
  })

  it('buildNetlist seeds component pins beyond the standard board on labxl', () => {
    const nl = buildNetlist(labxlLedCircuit())
    // strip 106T is touched ONLY by component leads (R1.p2 + D1.anode):
    // without board threading those components are dropped and this is null.
    expect(nl.netOf('a106')).toBeTruthy()
    expect(nl.netOf('a106')).toBe(nl.netOf('e106'))
    // R1's lead and D1's anode share that strip net; D1's cathode does not
    expect(nl.netOf('b106')).toBe(nl.netOf('c106'))
    expect(nl.netOf('c108')).not.toBe(nl.netOf('c106'))
  })

  it('SimEngine simulates leads components past column 63 / rail 50 on labxl', () => {
    const engine = new SimEngine(labxlLedCircuit())
    const malformed = engine.issues.filter((i) => i.message.includes('malformed'))
    expect(malformed, JSON.stringify(malformed)).toEqual([])
    engine.advance(0.005)
    // wire-fed rail voltage AND the component-fed strips agree
    expect(engine.netVoltage('a100')).toBeCloseTo(5, 1)
    const tele = engine.telemetry()
    const d1 = tele.components.D1
    expect(d1).toBeDefined()
    // ~(5 − Vf)/330Ω ≈ 9–10mA through the LED → clearly lit
    expect(d1.pinVoltages.anode - d1.pinVoltages.cathode).toBeGreaterThan(1.5)
    expect(d1.ledBrightness ?? 0).toBeGreaterThan(0.5)
    const r1 = tele.components.R1
    expect(Math.abs(r1.current ?? 0)).toBeGreaterThan(5e-3)
  })

  it('SimEngine resolves DIP anchors past column 63 on labxl', () => {
    const l = poweredLayout([dip('U1', 'ne555', 'f100')], [])
    l.board = 'labxl'
    const engine = new SimEngine(l)
    expect(engine.issues.filter((i) => i.message.includes('malformed'))).toEqual([])
  })

  it('a component off the declared half board is excluded (consistent with the validator)', () => {
    const half = poweredLayout([twoLead('R1', 'resistor', 'a40', 'a45', { resistance: 1000 })], [])
    half.board = 'half'
    const engine = new SimEngine(half)
    expect(
      engine.issues.some((i) => i.componentId === 'R1' && i.message.includes('malformed')),
    ).toBe(true)

    // ...but the same holes are fine when the board is (default) standard
    const std = poweredLayout([twoLead('R1', 'resistor', 'a40', 'a45', { resistance: 1000 })], [])
    const ok = new SimEngine(std)
    expect(ok.issues.filter((i) => i.message.includes('malformed'))).toEqual([])
  })
})

// ----------------------------------------------------------- LLM plumbing

describe('LLM board plumbing', () => {
  it('buildSystemPrompt is deterministic per (catalog, boardSize)', () => {
    for (const size of ALL_SIZES) {
      expect(buildSystemPrompt(size)).toBe(buildSystemPrompt(size))
    }
    expect(buildSystemPrompt()).toBe(buildSystemPrompt('standard'))
    expect(buildSystemPrompt('half')).not.toBe(buildSystemPrompt('labxl'))
  })

  it('the prompt names the active board, its ranges, and the full preset table', () => {
    const p = buildSystemPrompt('half')
    expect(p).toContain('ACTIVE board is the Half 400-point')
    expect(p).toContain('columns 1..30, rail holes 0..24')
    // the preset table mentions every preset, including bigger ones
    expect(p).toContain('"standard" — Standard (830 points): columns 1..63, rail holes 0..49')
    expect(p).toContain('"labxl" — Lab XL (1660 points): columns 1..126, rail holes 0..99')
    // and tells the model it may pick a larger board via the "board" field
    expect(p).toContain('"board"')
    expect(p.toLowerCase()).toContain('larger')
  })

  it('worked examples in the prompt carry an explicit board', () => {
    const p = buildSystemPrompt('half')
    expect(p).toContain('"board": "standard"')
  })

  it('the output schema requires a board enum on the circuit', () => {
    const props = (CIRCUIT_OUTPUT_SCHEMA as { properties: Record<string, unknown> }).properties
    const circuit = props.circuit as {
      required: string[]
      properties: { board: { anyOf: { enum?: string[]; type: string }[] } }
    }
    expect(circuit.required).toContain('board')
    const enumBranch = circuit.properties.board.anyOf.find((b) => b.enum)
    expect(enumBranch?.enum).toEqual(['half', 'standard', 'labxl'])
  })

  it('converters round-trip the board field', () => {
    const base = circuitAt('a10')
    expect(layoutToEmit(base).board).toBeNull()
    base.board = 'labxl'
    const emitted = layoutToEmit(base)
    expect(emitted.board).toBe('labxl')
    expect(emitToLayout(emitted).board).toBe('labxl')
    expect(emitToLayout({ ...emitted, board: null }).board).toBeUndefined()
  })

  it('emitToLayout resolves "board": null to the active board (schema contract)', () => {
    const emitted = layoutToEmit(circuitAt('a10')) // board: null
    expect(emitted.board).toBeNull()
    // null = the active board: the user's preset is preserved end-to-end
    expect(emitToLayout(emitted, 'labxl').board).toBe('labxl')
    expect(emitToLayout(emitted, 'half').board).toBe('half')
    expect(emitToLayout(emitted, 'standard').board).toBe('standard')
    // an explicit board always wins over the active one
    expect(emitToLayout({ ...emitted, board: 'labxl' }, 'half').board).toBe('labxl')
    // a far-column circuit with a null board validates when the user IS on labxl
    const res = validateLayout(emitToLayout(layoutToEmit(circuitAt('a126')), 'labxl'))
    expect(res.ok, res.errors.join('\n')).toBe(true)
  })

  it('extractEnvelope tolerates a missing or bogus board', () => {
    const env = extractEnvelope({
      explanation: 'x',
      circuit: { name: 'c', board: 'mega', components: [], wires: [] },
    })
    expect(env.circuit.board).toBeNull()
    const env2 = extractEnvelope({
      explanation: 'x',
      circuit: { name: 'c', board: 'labxl', components: [], wires: [] },
    })
    expect(env2.circuit.board).toBe('labxl')
  })
})
