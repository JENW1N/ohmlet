/**
 * Behavioral tests for the chips-A set: 74xx gates, 7474 flip-flop, NE555,
 * LM358 — wired on the board exactly as a user would. Owned by the tests agent.
 *
 * Inputs are driven through 1kΩ resistors to the rails (chip inputs must be
 * high impedance); outputs are read as net voltages: high > 3.5V, low < 1.5V.
 */
import { describe, expect, it } from 'vitest'
import { SimEngine } from '../src/sim/engine'
import type { ComponentInstance, Wire } from '../src/model/types'
import {
  LOGIC_HI,
  LOGIC_LO,
  RailTap,
  dip,
  entryOf,
  funcGen,
  pinHole,
  poweredLayout,
  risingEdges,
  runFor,
  sampleNet,
  tap,
  twoLead,
  wire,
} from './helpers'

/** Build a powered fixture around one DIP chip; inputs via 1k to the rails. */
function chipFixture(type: string, inputLevels: Record<string, boolean>) {
  const entry = entryOf(type)
  const u = dip('U1', type, 'f20')
  const rt = new RailTap()
  const comps: ComponentInstance[] = [u]
  const wires: Wire[] = [
    wire(tap(u, entry, entry.pins.includes('VCC') ? 'VCC' : 'VDD'), rt.plus()),
    wire(tap(u, entry, entry.pins.includes('GND') ? 'GND' : 'VSS'), rt.minus()),
  ]
  let r = 0
  for (const [pin, high] of Object.entries(inputLevels)) {
    r += 1
    comps.push(
      twoLead(`RIN${r}`, 'resistor', tap(u, entry, pin), high ? rt.plus() : rt.minus(), {
        resistance: 1000,
      }),
    )
  }
  const engine = new SimEngine(poweredLayout(comps, wires))
  const out = (pin: string) => engine.netVoltage(pinHole(u, entry, pin))
  return { engine, u, entry, out, rt }
}

/** Output voltage of one gate after the logic settles. */
function gateOut(type: string, inputLevels: Record<string, boolean>, outPin: string): number {
  const { engine, out } = chipFixture(type, inputLevels)
  runFor(engine, 0.002)
  return out(outPin)
}

function expectHigh(v: number, what: string) {
  expect(v, `${what} should be HIGH, got ${v.toFixed(3)}V`).toBeGreaterThan(LOGIC_HI)
}
function expectLow(v: number, what: string) {
  expect(v, `${what} should be LOW, got ${v.toFixed(3)}V`).toBeLessThan(LOGIC_LO)
}

describe('sn7400 quad NAND', () => {
  it('gate 1 truth table', () => {
    for (const [a, b, y] of [
      [false, false, true],
      [false, true, true],
      [true, false, true],
      [true, true, false],
    ] as const) {
      const v = gateOut('sn7400', { '1A': a, '1B': b }, '1Y')
      if (y) expectHigh(v, `NAND(${+a},${+b})`)
      else expectLow(v, `NAND(${+a},${+b})`)
    }
  }, 30000)

  it('gate 4 (e-row pins) maps correctly', () => {
    expectLow(gateOut('sn7400', { '4A': true, '4B': true }, '4Y'), 'NAND4(1,1)')
    expectHigh(gateOut('sn7400', { '4A': false, '4B': true }, '4Y'), 'NAND4(0,1)')
  }, 30000)
})

describe('sn7404 hex inverter', () => {
  it('inverter 1 truth table', () => {
    expectHigh(gateOut('sn7404', { '1A': false }, '1Y'), 'NOT(0)')
    expectLow(gateOut('sn7404', { '1A': true }, '1Y'), 'NOT(1)')
  }, 30000)

  it('inverter 6 (e-row pins) maps correctly', () => {
    expectHigh(gateOut('sn7404', { '6A': false }, '6Y'), 'NOT6(0)')
    expectLow(gateOut('sn7404', { '6A': true }, '6Y'), 'NOT6(1)')
  }, 30000)
})

describe('sn7408 quad AND', () => {
  it('gate 1 truth table', () => {
    for (const [a, b, y] of [
      [false, false, false],
      [false, true, false],
      [true, false, false],
      [true, true, true],
    ] as const) {
      const v = gateOut('sn7408', { '1A': a, '1B': b }, '1Y')
      if (y) expectHigh(v, `AND(${+a},${+b})`)
      else expectLow(v, `AND(${+a},${+b})`)
    }
  }, 30000)
})

describe('sn7432 quad OR', () => {
  it('gate 1 truth table', () => {
    for (const [a, b, y] of [
      [false, false, false],
      [false, true, true],
      [true, false, true],
      [true, true, true],
    ] as const) {
      const v = gateOut('sn7432', { '1A': a, '1B': b }, '1Y')
      if (y) expectHigh(v, `OR(${+a},${+b})`)
      else expectLow(v, `OR(${+a},${+b})`)
    }
  }, 30000)
})

describe('sn7486 quad XOR', () => {
  it('gate 1 truth table', () => {
    for (const [a, b, y] of [
      [false, false, false],
      [false, true, true],
      [true, false, true],
      [true, true, false],
    ] as const) {
      const v = gateOut('sn7486', { '1A': a, '1B': b }, '1Y')
      if (y) expectHigh(v, `XOR(${+a},${+b})`)
      else expectLow(v, `XOR(${+a},${+b})`)
    }
  }, 30000)
})

describe('sn7474 dual D flip-flop', () => {
  it('with QN fed back to D it divides the clock by 2', () => {
    const entry = entryOf('sn7474')
    const u = dip('U1', 'sn7474', 'f20')
    const rt = new RailTap()
    const engine = new SimEngine(
      poweredLayout(
        [u, funcGen('FG1', { waveform: 'square', frequency: 100, amplitude: 2.5, offset: 2.5 })],
        [
          wire(tap(u, entry, 'VCC'), rt.plus()),
          wire(tap(u, entry, 'GND'), rt.minus()),
          // async controls are active-low: tie high
          wire(tap(u, entry, '1PRE'), rt.plus()),
          wire(tap(u, entry, '1CLR'), rt.plus()),
          // toggle configuration
          wire(tap(u, entry, '1QN'), tap(u, entry, '1D')),
          wire('FG1:out', tap(u, entry, '1CLK')),
          wire('FG1:gnd', rt.minus()),
        ],
      ),
    )
    runFor(engine, 0.005) // settle
    // 0.1s window: 10 clock rising edges → ~5 Q rising edges (50Hz at Q)
    const q = sampleNet(engine, pinHole(u, entry, '1Q'), 0.1, 0.00025)
    const qEdges = risingEdges(q)
    expect(qEdges, `Q rising edges in 0.1s of 100Hz clock: ${qEdges}`).toBeGreaterThanOrEqual(4)
    expect(qEdges).toBeLessThanOrEqual(6)
    // Q swings rail-ish both ways
    expect(Math.max(...q)).toBeGreaterThan(LOGIC_HI)
    expect(Math.min(...q)).toBeLessThan(LOGIC_LO)
  }, 30000)
})

describe('ne555 astable', () => {
  it('Ra=10k Rb=10k C=1µF oscillates near 48Hz (±25% by edge count over 0.25s)', () => {
    const entry = entryOf('ne555')
    const u = dip('U1', 'ne555', 'f20')
    const rt = new RailTap()
    const engine = new SimEngine(
      poweredLayout(
        [
          u,
          twoLead('RA', 'resistor', rt.plus(), tap(u, entry, 'DISCH'), { resistance: 10000 }),
          twoLead('RB', 'resistor', tap(u, entry, 'DISCH', 1), tap(u, entry, 'THRES'), {
            resistance: 10000,
          }),
          twoLead('C1', 'capacitor', tap(u, entry, 'THRES', 1), rt.minus(), {
            capacitance: 1e-6,
          }),
        ],
        [
          wire(tap(u, entry, 'VCC'), rt.plus()),
          wire(tap(u, entry, 'GND'), rt.minus()),
          wire(tap(u, entry, 'RESET'), rt.plus()),
          wire(tap(u, entry, 'TRIG'), tap(u, entry, 'THRES', 2)),
        ],
      ),
    )
    // f ≈ 1.44 / ((Ra + 2·Rb)·C) = 48Hz → 12 cycles in 0.25s, ±25% → 9..15
    const out = sampleNet(engine, pinHole(u, entry, 'OUT'), 0.25, 0.0005)
    const edges = risingEdges(out)
    expect(edges, `555 OUT rising edges over 0.25s: ${edges}`).toBeGreaterThanOrEqual(9)
    expect(edges).toBeLessThanOrEqual(15)
    expect(Math.max(...out)).toBeGreaterThan(LOGIC_HI)
    expect(Math.min(...out)).toBeLessThan(LOGIC_LO)
  }, 30000)
})

describe('lm358 op-amp', () => {
  function comparatorFixture(plusHigher: boolean) {
    const entry = entryOf('lm358')
    const u = dip('U1', 'lm358', 'f30')
    const rt = new RailTap()
    // divider at col 40 → 3.0V; divider at col 44 → 2.5V
    const comps: ComponentInstance[] = [
      u,
      twoLead('R1', 'resistor', rt.plus(), 'a40', { resistance: 20000 }),
      twoLead('R2', 'resistor', 'b40', rt.minus(), { resistance: 30000 }),
      twoLead('R3', 'resistor', rt.plus(), 'a44', { resistance: 10000 }),
      twoLead('R4', 'resistor', 'b44', rt.minus(), { resistance: 10000 }),
    ]
    const wires: Wire[] = [
      wire(tap(u, entry, 'VCC'), rt.plus()),
      wire(tap(u, entry, 'GND'), rt.minus()),
      wire('c40', tap(u, entry, plusHigher ? 'IN1+' : 'IN1-')),
      wire('c44', tap(u, entry, plusHigher ? 'IN1-' : 'IN1+')),
    ]
    const engine = new SimEngine(poweredLayout(comps, wires))
    runFor(engine, 0.01)
    return engine.netVoltage(pinHole(u, entry, 'OUT1'))
  }

  it('comparator: IN+ at 3.0V, IN- at 2.5V → output high (≈ VCC−1.2)', () => {
    expect(comparatorFixture(true)).toBeGreaterThan(3.0)
  }, 30000)

  it('comparator: IN+ at 2.5V, IN- at 3.0V → output low', () => {
    expect(comparatorFixture(false)).toBeLessThan(1.0)
  }, 30000)

  it('unity follower on amp 2 tracks IN2+ = 2.0V within ±0.15V', () => {
    const entry = entryOf('lm358')
    const u = dip('U1', 'lm358', 'f30')
    const rt = new RailTap()
    const engine = new SimEngine(
      poweredLayout(
        [
          u,
          // 15k / 10k divider → 5 · 10/25 = 2.0V
          twoLead('R1', 'resistor', rt.plus(), 'a40', { resistance: 15000 }),
          twoLead('R2', 'resistor', 'b40', rt.minus(), { resistance: 10000 }),
        ],
        [
          wire(tap(u, entry, 'VCC'), rt.plus()),
          wire(tap(u, entry, 'GND'), rt.minus()),
          wire('c40', tap(u, entry, 'IN2+')),
          wire(tap(u, entry, 'OUT2'), tap(u, entry, 'IN2-')),
        ],
      ),
    )
    runFor(engine, 0.02) // settle
    // it must SETTLE, not oscillate: min and max of the tail both in band
    const tail = sampleNet(engine, pinHole(u, entry, 'OUT2'), 0.005, 0.0001)
    expect(Math.min(...tail)).toBeGreaterThan(2.0 - 0.15)
    expect(Math.max(...tail)).toBeLessThan(2.0 + 0.15)
  }, 30000)
})
