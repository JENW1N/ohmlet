/**
 * Behavioral tests for the chips-B set: CD4017, CD4040, SN74193, CD4026,
 * CD4511. Owned by the tests agent.
 *
 * Clocking strategy: dcSource() function generators (amplitude 0) toggled
 * with engine.setRuntimeParam(id, 'offset', V) — an ideal, debounce-free
 * logic driver — plus small advance() slices between edges.
 */
import { describe, expect, it } from 'vitest'
import { SimEngine } from '../src/sim/engine'
import type { ComponentInstance, Wire } from '../src/model/types'
import {
  LOGIC_HI,
  LOGIC_LO,
  RailTap,
  dcSource,
  dip,
  entryOf,
  fgPulse,
  pinHole,
  poweredLayout,
  runFor,
  tap,
  wire,
} from './helpers'

function expectHigh(v: number, what: string) {
  expect(v, `${what} should be HIGH, got ${v.toFixed(3)}V`).toBeGreaterThan(LOGIC_HI)
}
function expectLow(v: number, what: string) {
  expect(v, `${what} should be LOW, got ${v.toFixed(3)}V`).toBeLessThan(LOGIC_LO)
}

describe('cd4017 decade counter', () => {
  it('walks a one-hot through Q0..Q9 over 10 clock pulses, RST returns to Q0', () => {
    const entry = entryOf('cd4017')
    const u = dip('U1', 'cd4017', 'f20')
    const rt = new RailTap()
    const engine = new SimEngine(
      poweredLayout(
        [u, dcSource('FGC', 0), dcSource('FGR', 0)],
        [
          wire(tap(u, entry, 'VDD'), rt.plus()),
          wire(tap(u, entry, 'VSS'), rt.minus()),
          wire(tap(u, entry, 'INH'), rt.minus()),
          wire('FGC:out', tap(u, entry, 'CLK')),
          wire('FGC:gnd', rt.minus()),
          wire('FGR:out', tap(u, entry, 'RST')),
          wire('FGR:gnd', rt.minus()),
        ],
      ),
    )
    const q = (n: number) => engine.netVoltage(pinHole(u, entry, `Q${n}`))
    const expectOneHot = (k: number, when: string) => {
      for (let n = 0; n <= 9; n++) {
        const v = q(n)
        if (n === k) expectHigh(v, `Q${n} ${when}`)
        else expectLow(v, `Q${n} ${when}`)
      }
    }

    runFor(engine, 0.002)
    fgPulse(engine, 'FGR', 5, 0) // reset → count 0
    expectOneHot(0, 'after RST')

    for (let p = 1; p <= 10; p++) {
      fgPulse(engine, 'FGC', 5, 0) // one rising clock edge
      expectOneHot(p % 10, `after ${p} clock pulse(s)`) // pulse 10 wraps to Q0
    }

    // RST mid-count snaps back to Q0
    fgPulse(engine, 'FGC', 5, 0)
    fgPulse(engine, 'FGC', 5, 0)
    fgPulse(engine, 'FGR', 5, 0)
    expectOneHot(0, 'after mid-count RST')
  }, 30000)
})

describe('cd4040 ripple counter', () => {
  it('Q1..Q4 follow the binary count of falling CLK edges (32 edges)', () => {
    const entry = entryOf('cd4040')
    const u = dip('U1', 'cd4040', 'f20')
    const rt = new RailTap()
    const engine = new SimEngine(
      poweredLayout(
        [u, dcSource('FGC', 0), dcSource('FGR', 0)],
        [
          wire(tap(u, entry, 'VDD'), rt.plus()),
          wire(tap(u, entry, 'VSS'), rt.minus()),
          wire('FGC:out', tap(u, entry, 'CLK')),
          wire('FGC:gnd', rt.minus()),
          wire('FGR:out', tap(u, entry, 'RST')),
          wire('FGR:gnd', rt.minus()),
        ],
      ),
    )
    const qv = (n: number) => engine.netVoltage(pinHole(u, entry, `Q${n}`))

    runFor(engine, 0.002)
    fgPulse(engine, 'FGR', 5, 0) // clear
    for (let b = 1; b <= 4; b++) expectLow(qv(b), `Q${b} after RST`)

    for (let n = 1; n <= 32; n++) {
      // rising edge (ignored) then falling edge (counts): count = n
      fgPulse(engine, 'FGC', 5, 0)
      for (let b = 1; b <= 4; b++) {
        const bit = (n >> (b - 1)) & 1
        const v = qv(b)
        if (bit) expectHigh(v, `Q${b} after ${n} falling edges`)
        else expectLow(v, `Q${b} after ${n} falling edges`)
      }
    }
    // 32 = 0b100000 → Q5 low, Q6 high (divide-by-32 and -64 taps)
    expectLow(qv(5), 'Q5 after 32 falling edges')
    expectHigh(qv(6), 'Q6 after 32 falling edges')
  }, 60000)
})

describe('sn74193 up/down counter', () => {
  it('counts up to 5, down to 3, and LOAD presets 9', () => {
    const entry = entryOf('sn74193')
    const u = dip('U1', 'sn74193', 'f20')
    const rt = new RailTap()
    // data inputs hard-wired to 9 = 0b1001 (A = lsb)
    const comps: ComponentInstance[] = [
      u,
      dcSource('FGUP', 5), // count inputs idle HIGH
      dcSource('FGDN', 5),
      dcSource('FGLD', 5), // LOAD is active low: idle high
      dcSource('FGCLR', 0), // CLR is active high: idle low
    ]
    const wires: Wire[] = [
      wire(tap(u, entry, 'VCC'), rt.plus()),
      wire(tap(u, entry, 'GND'), rt.minus()),
      wire(tap(u, entry, 'A'), rt.plus()),
      wire(tap(u, entry, 'B'), rt.minus()),
      wire(tap(u, entry, 'C'), rt.minus()),
      wire(tap(u, entry, 'D'), rt.plus()),
      wire('FGUP:out', tap(u, entry, 'UP')),
      wire('FGUP:gnd', rt.minus()),
      wire('FGDN:out', tap(u, entry, 'DOWN')),
      wire('FGDN:gnd', rt.minus()),
      wire('FGLD:out', tap(u, entry, 'LOAD')),
      wire('FGLD:gnd', rt.minus()),
      wire('FGCLR:out', tap(u, entry, 'CLR')),
      wire('FGCLR:gnd', rt.minus()),
    ]
    const engine = new SimEngine(poweredLayout(comps, wires))
    const expectCount = (n: number, when: string) => {
      const bits = ['QA', 'QB', 'QC', 'QD']
      bits.forEach((pin, i) => {
        const v = engine.netVoltage(pinHole(u, entry, pin))
        if ((n >> i) & 1) expectHigh(v, `${pin} ${when} (count ${n})`)
        else expectLow(v, `${pin} ${when} (count ${n})`)
      })
    }

    runFor(engine, 0.002)
    fgPulse(engine, 'FGCLR', 5, 0) // CLR high pulse → 0
    expectCount(0, 'after CLR')

    // 5 rising edges on UP (dip low, return high) while DOWN stays high
    for (let i = 0; i < 5; i++) fgPulse(engine, 'FGUP', 0, 5)
    expectCount(5, 'after 5 up pulses')

    // 2 rising edges on DOWN while UP stays high
    for (let i = 0; i < 2; i++) fgPulse(engine, 'FGDN', 0, 5)
    expectCount(3, 'after 2 down pulses')

    // LOAD low pulse presets QA..QD from A..D = 9
    fgPulse(engine, 'FGLD', 0, 5)
    expectCount(9, 'after LOAD')
  }, 30000)
})

describe('cd4026 counting 7-segment driver', () => {
  it('shows 0 after RST and digit 3 (a b c d g on; e f off) after 3 pulses', () => {
    const entry = entryOf('cd4026')
    const u = dip('U1', 'cd4026', 'f20')
    const rt = new RailTap()
    const engine = new SimEngine(
      poweredLayout(
        [u, dcSource('FGC', 0), dcSource('FGR', 0)],
        [
          wire(tap(u, entry, 'VDD'), rt.plus()),
          wire(tap(u, entry, 'VSS'), rt.minus()),
          wire(tap(u, entry, 'DEI'), rt.plus()), // display enable
          wire(tap(u, entry, 'INH'), rt.minus()),
          wire('FGC:out', tap(u, entry, 'CLK')),
          wire('FGC:gnd', rt.minus()),
          wire('FGR:out', tap(u, entry, 'RST')),
          wire('FGR:gnd', rt.minus()),
        ],
      ),
    )
    const seg = (name: 'A' | 'B' | 'C' | 'D' | 'E' | 'F' | 'G') =>
      engine.netVoltage(pinHole(u, entry, name))

    runFor(engine, 0.002)
    fgPulse(engine, 'FGR', 5, 0) // → digit 0: a b c d e f on, g off
    for (const s of ['A', 'B', 'C', 'D', 'E', 'F'] as const) expectHigh(seg(s), `segment ${s} @0`)
    expectLow(seg('G'), 'segment G @0')

    fgPulse(engine, 'FGC', 5, 0)
    fgPulse(engine, 'FGC', 5, 0)
    fgPulse(engine, 'FGC', 5, 0)
    // digit 3: a b c d g on; e f off
    for (const s of ['A', 'B', 'C', 'D', 'G'] as const) expectHigh(seg(s), `segment ${s} @3`)
    for (const s of ['E', 'F'] as const) expectLow(seg(s), `segment ${s} @3`)
  }, 30000)
})

describe('cd4511 BCD → 7-segment decoder', () => {
  // CD4511 datasheet segment patterns (note the tail-less 6 and 9)
  const PATTERNS: Record<number, string> = {
    0: 'abcdef',
    1: 'bc',
    2: 'abdeg',
    3: 'abcdg',
    4: 'bcfg',
    5: 'acdfg',
    6: 'cdefg',
    7: 'abc',
    8: 'abcdefg',
    9: 'abcfg',
  }

  for (let digit = 0; digit <= 9; digit++) {
    it(`decodes BCD ${digit} → segments "${PATTERNS[digit]}"`, () => {
      const entry = entryOf('cd4511')
      const u = dip('U1', 'cd4511', 'f20')
      const rt = new RailTap()
      const wires: Wire[] = [
        wire(tap(u, entry, 'VDD'), rt.plus()),
        wire(tap(u, entry, 'VSS'), rt.minus()),
        wire(tap(u, entry, 'LT'), rt.plus()), // lamp test off (active low)
        wire(tap(u, entry, 'BL'), rt.plus()), // blanking off (active low)
        wire(tap(u, entry, 'LE'), rt.minus()), // latch transparent
      ]
      // BCD in on A(lsb) B C D(msb), hard-wired to the rails
      const bcdPins = ['A', 'B', 'C', 'D'] as const
      bcdPins.forEach((pin, bit) => {
        wires.push(wire(tap(u, entry, pin), (digit >> bit) & 1 ? rt.plus() : rt.minus()))
      })
      const engine = new SimEngine(poweredLayout([u], wires))
      runFor(engine, 0.002)

      for (const s of ['a', 'b', 'c', 'd', 'e', 'f', 'g']) {
        const v = engine.netVoltage(pinHole(u, entry, `${s.toUpperCase()}_SEG`))
        if (PATTERNS[digit].includes(s)) expectHigh(v, `digit ${digit} segment ${s}`)
        else expectLow(v, `digit ${digit} segment ${s}`)
      }
    }, 30000)
  }
})
