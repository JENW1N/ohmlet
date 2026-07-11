/**
 * Contract tests for src/model/breadboard.ts (hole parsing, net ids, DIP and
 * footprint geometry). Owned by the tests agent.
 */
import { describe, expect, it } from 'vitest'
import {
  parseHole,
  formatHole,
  isHoleRef,
  isHoleOnBoard,
  netIdForHole,
  netIdForTerminal,
  dipHoles,
  footprintHoles,
  componentPinHoles,
  allHoles,
} from '../src/model/breadboard'
import { CATALOG } from '../src/model/catalog'
import { dipPinHole, mustParse } from './helpers'

const fmtAll = (holes: ({ kind: string } | null)[] | null) =>
  holes === null ? null : holes.map((h) => (h ? formatHole(h as never) : null))

describe('parseHole / formatHole', () => {
  it('round-trips every hole on the (default standard) board', () => {
    let n = 0
    for (const h of allHoles()) {
      const ref = formatHole(h)
      expect(parseHole(ref), `round-trip of ${ref}`).toEqual(h)
      n++
    }
    // 10 rows × 63 columns + 4 rails × 50 holes
    expect(n).toBe(10 * 63 + 4 * 50)
  })

  it('parses strip refs', () => {
    expect(parseHole('a12')).toEqual({ kind: 'strip', col: 12, row: 'a' })
    expect(parseHole('j63')).toEqual({ kind: 'strip', col: 63, row: 'j' })
    expect(parseHole('f1')).toEqual({ kind: 'strip', col: 1, row: 'f' })
    expect(formatHole({ kind: 'strip', col: 12, row: 'a' })).toBe('a12')
  })

  it('parses rail refs', () => {
    expect(parseHole('top+5')).toEqual({ kind: 'rail', rail: 'top+', index: 5 })
    expect(parseHole('bot-12')).toEqual({ kind: 'rail', rail: 'bot-', index: 12 })
    expect(parseHole('top-0')).toEqual({ kind: 'rail', rail: 'top-', index: 0 })
    expect(parseHole('bot+49')).toEqual({ kind: 'rail', rail: 'bot+', index: 49 })
    expect(formatHole({ kind: 'rail', rail: 'top+', index: 5 })).toBe('top+5')
  })

  it('rejects malformed refs and refs beyond the largest rig', () => {
    const bad = [
      'a0', // column 0 does not exist on any board
      'k5', // row k does not exist
      'a757', // column past 756 (Lab XL × 6 modules, the syntax maximum)
      'top+600', // rail index past 599 (Lab XL × 6 modules)
      'bot-600',
      'a01', // leading zero
      'top+05',
      'A12', // uppercase row
      'top5', // missing rail sign
      'top+',
      'a',
      '12',
      '',
      'a 12',
      'PS1:+', // terminal ref, not a hole
    ]
    for (const ref of bad) expect(parseHole(ref), `parseHole("${ref}")`).toBeNull()
  })

  it('parsing is SYNTAX-level: holes past the standard board parse, bounds are per-board', () => {
    // a64 / top+50 used to be parse errors; they now PARSE (they exist on the
    // Lab XL preset) and the per-board bounds check moved to isHoleOnBoard.
    const a64 = parseHole('a64')
    expect(a64).toEqual({ kind: 'strip', col: 64, row: 'a' })
    expect(isHoleOnBoard(a64!, 'standard')).toBe(false)
    expect(isHoleOnBoard(a64!, 'labxl')).toBe(true)

    // the syntax ceilings cover multi-board rigs: Lab XL × 6 modules
    expect(parseHole('top+599')).toEqual({ kind: 'rail', rail: 'top+', index: 599 })
    expect(parseHole('top+600')).toBeNull()
    expect(parseHole('a756')).toEqual({ kind: 'strip', col: 756, row: 'a' })
    expect(parseHole('a757')).toBeNull()
    // ...so a127 parses too; it is just not on any SINGLE board
    expect(parseHole('a127')).toEqual({ kind: 'strip', col: 127, row: 'a' })
    expect(isHoleOnBoard(parseHole('a127')!, 'labxl')).toBe(false)
  })

  it('isHoleRef distinguishes holes from off-board terminals', () => {
    expect(isHoleRef('a1')).toBe(true)
    expect(isHoleRef('top+0')).toBe(true)
    expect(isHoleRef('PS1:+')).toBe(false)
    expect(isHoleRef('nonsense')).toBe(false)
  })
})

describe('netIdForHole', () => {
  const nid = (ref: string) => netIdForHole(mustParse(ref))

  it('splits each strip column into a top and a bottom net', () => {
    expect(nid('a12')).toBe('S12T')
    expect(nid('e12')).toBe('S12T')
    expect(nid('f12')).toBe('S12B')
    expect(nid('j12')).toBe('S12B')
    expect(nid('e12')).not.toBe(nid('f12'))
    expect(nid('a12')).not.toBe(nid('a13'))
  })

  it('maps each rail to one continuous net', () => {
    expect(nid('top+0')).toBe('R:top+')
    expect(nid('top+49')).toBe('R:top+')
    expect(nid('top-3')).toBe('R:top-')
    expect(nid('bot+7')).toBe('R:bot+')
    expect(nid('bot-7')).toBe('R:bot-')
    const rails = [nid('top+0'), nid('top-0'), nid('bot+0'), nid('bot-0')]
    expect(new Set(rails).size).toBe(4)
  })

  it('netIdForTerminal uses the PIN:id:pin form', () => {
    expect(netIdForTerminal('PS1', '+')).toBe('PIN:PS1:+')
    expect(netIdForTerminal('FG1', 'gnd')).toBe('PIN:FG1:gnd')
  })
})

describe('dipHoles', () => {
  it('DIP-8 anchored at f20 occupies f20..f23 then e23..e20', () => {
    const holes = dipHoles(mustParse('f20'), 8)
    expect(holes).not.toBeNull()
    expect(holes?.map((h) => formatHole(h))).toEqual([
      'f20', 'f21', 'f22', 'f23',
      'e23', 'e22', 'e21', 'e20',
    ])
  })

  it('dipPinHole resolves package pin numbers', () => {
    expect(dipPinHole('f20', 8, 1)).toBe('f20')
    expect(dipPinHole('f20', 8, 4)).toBe('f23')
    expect(dipPinHole('f20', 8, 5)).toBe('e23')
    expect(dipPinHole('f20', 8, 8)).toBe('e20')
    expect(dipPinHole('f10', 16, 16)).toBe('e10')
  })

  it('rejects anchors not in row f', () => {
    expect(dipHoles(mustParse('e20'), 8)).toBeNull()
    expect(dipHoles(mustParse('a20'), 8)).toBeNull()
    expect(dipHoles(mustParse('g20'), 8)).toBeNull()
    expect(dipHoles(mustParse('top+5'), 8)).toBeNull()
  })

  it('rejects packages that run off the board or have odd pin counts', () => {
    expect(dipHoles(mustParse('f57'), 14)).not.toBeNull() // cols 57..63: fits
    expect(dipHoles(mustParse('f58'), 14)).toBeNull() // would need col 64
    expect(dipHoles(mustParse('f61'), 8)).toBeNull()
    expect(dipHoles(mustParse('f20'), 7)).toBeNull()
  })
})

describe('componentPinHoles', () => {
  it('leads: returns one hole per pin in catalog order', () => {
    const holes = componentPinHoles(
      { id: 'R1', type: 'resistor', holes: ['a5', 'j63'] },
      CATALOG.resistor,
    )
    expect(fmtAll(holes)).toEqual(['a5', 'j63'])
  })

  it('leads: accepts rail holes', () => {
    const holes = componentPinHoles(
      { id: 'R1', type: 'resistor', holes: ['top+1', 'b10'] },
      CATALOG.resistor,
    )
    expect(fmtAll(holes)).toEqual(['top+1', 'b10'])
  })

  it('leads: null on wrong hole count or bad refs', () => {
    expect(
      componentPinHoles({ id: 'R1', type: 'resistor', holes: ['a5'] }, CATALOG.resistor),
    ).toBeNull()
    expect(
      componentPinHoles(
        { id: 'R1', type: 'resistor', holes: ['a5', 'b6', 'c7'] },
        CATALOG.resistor,
      ),
    ).toBeNull()
    expect(
      componentPinHoles({ id: 'R1', type: 'resistor', holes: ['a5', 'q9'] }, CATALOG.resistor),
    ).toBeNull()
    expect(componentPinHoles({ id: 'R1', type: 'resistor' }, CATALOG.resistor)).toBeNull()
  })

  it('dip: maps the ne555 (DIP-8) at f20', () => {
    const holes = componentPinHoles({ id: 'U1', type: 'ne555', at: 'f20' }, CATALOG.ne555)
    expect(fmtAll(holes)).toEqual([
      'f20', 'f21', 'f22', 'f23',
      'e23', 'e22', 'e21', 'e20',
    ])
  })

  it('dip: null without a valid row-f anchor', () => {
    expect(componentPinHoles({ id: 'U1', type: 'ne555', at: 'e20' }, CATALOG.ne555)).toBeNull()
    expect(componentPinHoles({ id: 'U1', type: 'ne555' }, CATALOG.ne555)).toBeNull()
    expect(componentPinHoles({ id: 'U1', type: 'ne555', at: 'zz9' }, CATALOG.ne555)).toBeNull()
  })

  it('footprint: pushbutton at f10 occupies f10, e10, f12, e12 (A1 A2 B1 B2)', () => {
    const holes = componentPinHoles(
      { id: 'BTN1', type: 'pushbutton', at: 'f10' },
      CATALOG.pushbutton,
    )
    expect(fmtAll(holes)).toEqual(['f10', 'e10', 'f12', 'e12'])
  })

  it('footprint: anchor row must match the catalog offsets, and must fit', () => {
    expect(
      componentPinHoles({ id: 'BTN1', type: 'pushbutton', at: 'e10' }, CATALOG.pushbutton),
    ).toBeNull()
    expect(
      componentPinHoles({ id: 'BTN1', type: 'pushbutton', at: 'f62' }, CATALOG.pushbutton),
    ).toBeNull() // B-side would land on col 64
  })

  it('offboard: all pins map to null (terminals, not holes)', () => {
    expect(
      componentPinHoles({ id: 'PS1', type: 'power_supply' }, CATALOG.power_supply),
    ).toEqual([null, null])
  })

  it('probe: single hole', () => {
    const holes = componentPinHoles(
      { id: 'SC1', type: 'scope_probe', holes: ['c30'] },
      CATALOG.scope_probe,
    )
    expect(fmtAll(holes)).toEqual(['c30'])
  })
})

describe('pushbutton footprint occupancy', () => {
  it('catalog offsets span columns at/at+2 in rows f and e', () => {
    const offsets = CATALOG.pushbutton.footprintOffsets
    if (!offsets) throw new Error('pushbutton must define footprintOffsets')
    expect(offsets).toEqual([
      { dCol: 0, row: 'f' },
      { dCol: 0, row: 'e' },
      { dCol: 2, row: 'f' },
      { dCol: 2, row: 'e' },
    ])
    const holes = footprintHoles(mustParse('f30'), offsets)
    expect(holes?.map((h) => formatHole(h))).toEqual(['f30', 'e30', 'f32', 'e32'])
    // straddles the channel: two distinct nets per side before pressing
    expect(footprintHoles(mustParse('e30'), offsets)).toBeNull()
  })
})
