/**
 * Contract tests for src/sim/netlist.ts (union-find net building).
 * Spec: buildNetlist(layout) → { netOf(ref): string|null, nets: string[],
 * ground: string|null, warnings }. Owned by the tests agent.
 */
import { describe, expect, it } from 'vitest'
import { buildNetlist } from '../src/sim/netlist'
import { dip, funcGen, layout, poweredLayout, supply5, twoLead, wire } from './helpers'

describe('static board topology', () => {
  // Touch the strips under test with component leads so they are part of the
  // circuit regardless of whether the builder seeds all holes or only used
  // ones. Resistor leads must NOT merge nets (only wires/bridges do).
  const nl = buildNetlist(
    layout(
      [
        twoLead('RT1', 'resistor', 'b12', 'g12'),
        twoLead('RT2', 'resistor', 'b13', 'g13'),
        twoLead('RT3', 'resistor', 'b1', 'g1'),
        twoLead('RT4', 'resistor', 'b63', 'g63'),
      ],
      [],
    ),
  )

  it('holes in the same column and block share a net', () => {
    expect(nl.netOf('a12')).toBeTruthy()
    expect(nl.netOf('a12')).toBe(nl.netOf('b12'))
    expect(nl.netOf('a12')).toBe(nl.netOf('e12'))
    expect(nl.netOf('f12')).toBe(nl.netOf('j12'))
  })

  it('row e and row f of the same column are different nets', () => {
    expect(nl.netOf('e12')).toBeTruthy()
    expect(nl.netOf('e12')).not.toBe(nl.netOf('f12'))
    expect(nl.netOf('e1')).not.toBe(nl.netOf('f1'))
    expect(nl.netOf('e63')).not.toBe(nl.netOf('f63'))
  })

  it('different columns are different nets (a component is not a bridge)', () => {
    expect(nl.netOf('a12')).toBeTruthy()
    expect(nl.netOf('a13')).toBeTruthy()
    expect(nl.netOf('a12')).not.toBe(nl.netOf('a13'))
    expect(nl.netOf('j12')).not.toBe(nl.netOf('j13'))
  })

  it('each rail is one continuous net, distinct from the others', () => {
    expect(nl.netOf('top+0')).toBe(nl.netOf('top+49'))
    expect(nl.netOf('top-5')).toBe(nl.netOf('top-44'))
    expect(nl.netOf('bot+1')).toBe(nl.netOf('bot+48'))
    const rails = [nl.netOf('top+0'), nl.netOf('top-0'), nl.netOf('bot+0'), nl.netOf('bot-0')]
    expect(rails.every((r) => typeof r === 'string')).toBe(true)
    expect(new Set(rails).size).toBe(4)
  })

  it('exposes a nets list and returns null for garbage refs', () => {
    expect(Array.isArray(nl.nets)).toBe(true)
    expect(nl.netOf('k99')).toBeNull()
    expect(nl.netOf('a0')).toBeNull()
  })
})

describe('wires merge nets', () => {
  it('a single wire joins two strips', () => {
    const nl = buildNetlist(layout([], [wire('b3', 'h7'), wire('b4', 'h8')]))
    expect(nl.netOf('a3')).toBeTruthy()
    expect(nl.netOf('a3')).toBe(nl.netOf('j7'))
    expect(nl.netOf('a4')).toBeTruthy()
    expect(nl.netOf('a3')).not.toBe(nl.netOf('a4'))
  })

  it('merging is transitive across a chain of wires', () => {
    const nl = buildNetlist(layout([], [wire('b3', 'h7'), wire('i7', 'top+0'), wire('top+9', 'c40')]))
    expect(nl.netOf('a3')).toBe(nl.netOf('top+49'))
    expect(nl.netOf('a3')).toBe(nl.netOf('e40'))
  })

  it('wires to off-board terminals join the terminal net to the hole net', () => {
    const nl = buildNetlist(poweredLayout([], []))
    expect(nl.netOf('PS1:+')).toBe(nl.netOf('top+33'))
    expect(nl.netOf('PS1:-')).toBe(nl.netOf('top-33'))
    expect(nl.netOf('PS1:+')).not.toBe(nl.netOf('PS1:-'))
  })
})

describe('internal bridges', () => {
  it('pushbutton A1/A2 (and B1/B2) are joined across the channel', () => {
    const nl = buildNetlist(layout([dip('BTN1', 'pushbutton', 'f10')], []))
    // A side: f10 (S10B) bridged to e10 (S10T)
    expect(nl.netOf('j10')).toBe(nl.netOf('a10'))
    // B side: f12 bridged to e12
    expect(nl.netOf('j12')).toBe(nl.netOf('a12'))
    // but A side and B side stay separate (button not pressed in the netlist)
    expect(nl.netOf('a10')).not.toBe(nl.netOf('a12'))
  })

  it('seven_segment COM1/COM2 are joined', () => {
    // DIP-10 at f30: COM1 = pin 3 = f32, COM2 = pin 8 = e32
    const nl = buildNetlist(layout([dip('DSP1', 'seven_segment', 'f30')], []))
    expect(nl.netOf('j32')).toBe(nl.netOf('a32'))
    // neighbouring segment pins are NOT bridged
    expect(nl.netOf('j31')).not.toBe(nl.netOf('a31'))
  })
})

describe('ground selection', () => {
  it('ground is the net of the first power supply minus terminal', () => {
    const nl = buildNetlist(poweredLayout([], []))
    expect(nl.ground).toBeTruthy()
    expect(nl.ground).toBe(nl.netOf('PS1:-'))
    expect(nl.ground).toBe(nl.netOf('top-12'))
    expect(nl.ground).not.toBe(nl.netOf('PS1:+'))
  })

  it('falls back to the first function generator gnd when no supply exists', () => {
    const nl = buildNetlist(
      layout([funcGen('FG1', { frequency: 50 })], [wire('FG1:gnd', 'bot-0'), wire('FG1:out', 'a5')]),
    )
    expect(nl.ground).toBeTruthy()
    expect(nl.ground).toBe(nl.netOf('FG1:gnd'))
    expect(nl.ground).toBe(nl.netOf('bot-49'))
  })

  it('warns when there is no power source at all', () => {
    const nl = buildNetlist(layout([twoLead('R1', 'resistor', 'a1', 'a5')], []))
    expect(nl.ground).toBeTruthy()
    expect(nl.warnings.length).toBeGreaterThanOrEqual(1)
  })
})

describe('2-D grid board-rows (Phase-C verification fix)', () => {
  it('component pins on board-row >= 1 resolve to real nets', () => {
    const l = {
      ...layout(
        [twoLead('R1', 'resistor', '1:b12', '1:g12')],
        // jumper row-0 → row-1 strip; touch the row-1 rail so it is seeded
        [wire('b12', '1:b12'), wire('1:top+0', '1:j20')],
      ),
      boardRows: 2,
    }
    const nl = buildNetlist(l)
    // the grid-row pin resolves (pre-fix: null — the engine dropped the part)
    expect(nl.netOf('1:b12')).toBeTruthy()
    expect(nl.netOf('1:a12')).toBe(nl.netOf('1:b12'))
    // board-rows are independent boards: same column, different row ≠ same net
    expect(nl.netOf('b12')).toBeTruthy()
    // ...but the jumper wire merges them
    expect(nl.netOf('b12')).toBe(nl.netOf('1:b12'))
    // rails on different board-rows stay independent (no wire between them)
    expect(nl.netOf('top+0')).toBeTruthy()
    expect(nl.netOf('1:top+0')).toBeTruthy()
    expect(nl.netOf('top+0')).not.toBe(nl.netOf('1:top+0'))
  })
})
