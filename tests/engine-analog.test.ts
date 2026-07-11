/**
 * Analog-domain tests for the SimEngine (src/sim/engine.ts) against the exact
 * public API in ARCHITECTURE.md. Owned by the tests agent.
 */
import { describe, expect, it } from 'vitest'
import { SimEngine, DEFAULT_DT } from '../src/sim/engine'
import type { SimIssue } from '../src/model/types'
import {
  RailTap,
  dip,
  funcGen,
  layout,
  leads,
  poweredLayout,
  runFor,
  sampleNet,
  risingEdges,
  twoLead,
  wire,
} from './helpers'

describe('engine basics', () => {
  it('DEFAULT_DT is 50µs and step()/advance() track time', () => {
    expect(DEFAULT_DT).toBe(5e-5)
    const rt = new RailTap()
    const engine = new SimEngine(
      poweredLayout(
        [
          twoLead('R1', 'resistor', rt.plus(), 'a10', { resistance: 10000 }),
          twoLead('R2', 'resistor', 'b10', rt.minus(), { resistance: 10000 }),
        ],
        [],
      ),
    )
    expect(engine.time).toBe(0)
    engine.step()
    expect(Math.abs(engine.time - DEFAULT_DT)).toBeLessThan(1e-9)
    engine.advance(0.001)
    expect(Math.abs(engine.time - (DEFAULT_DT + 0.001))).toBeLessThanOrEqual(DEFAULT_DT)
  })

  it('netVoltage returns NaN for unknown refs', () => {
    const engine = new SimEngine(poweredLayout([], []))
    engine.step()
    expect(Number.isNaN(engine.netVoltage('zz99'))).toBe(true)
  })
})

describe('1. resistive voltage divider', () => {
  it('10k/10k across 5V puts the middle node at 2.5V ±1%', () => {
    const rt = new RailTap()
    const engine = new SimEngine(
      poweredLayout(
        [
          twoLead('R1', 'resistor', rt.plus(), 'a10', { resistance: 10000 }),
          twoLead('R2', 'resistor', 'b10', rt.minus(), { resistance: 10000 }),
        ],
        [],
      ),
    )
    runFor(engine, 0.005)
    const vmid = engine.netVoltage('c10')
    expect(vmid).toBeGreaterThan(2.5 * 0.99)
    expect(vmid).toBeLessThan(2.5 * 1.01)

    // telemetry reports the branch current of 2-lead devices: 2.5V / 10k
    const tele = engine.telemetry()
    const r1 = tele.components['R1']
    expect(r1).toBeDefined()
    expect(Math.abs(r1.current ?? 0)).toBeGreaterThan(0.25e-3 * 0.95)
    expect(Math.abs(r1.current ?? 0)).toBeLessThan(0.25e-3 * 1.05)
  }, 20000)
})

describe('2. RC charging', () => {
  it('10k + 10µF reaches ~63.2% of the supply after one time constant (0.1s)', () => {
    const rt = new RailTap()
    const engine = new SimEngine(
      poweredLayout(
        [
          twoLead('R1', 'resistor', rt.plus(), 'a10', { resistance: 10000 }),
          twoLead('C1', 'capacitor', 'b10', rt.minus(), { capacitance: 10e-6 }),
        ],
        [],
      ),
    )
    runFor(engine, 0.1) // exactly 1 tau
    const vcap = engine.netVoltage('c10')
    const vsupply = engine.netVoltage('top+40')
    expect(vsupply).toBeGreaterThan(4.9)
    const frac = vcap / vsupply
    const target = 1 - Math.exp(-1) // 0.6321
    expect(frac).toBeGreaterThan(target * 0.95)
    expect(frac).toBeLessThan(target * 1.05)
  }, 20000)
})

describe('3. diode drop', () => {
  it('a silicon diode in series with 1k from 5V drops 0.6–0.8V', () => {
    const rt = new RailTap()
    const engine = new SimEngine(
      poweredLayout(
        [
          twoLead('D1', 'diode', rt.plus(), 'a15'), // anode to +5
          twoLead('R1', 'resistor', 'b15', rt.minus(), { resistance: 1000 }),
        ],
        [],
      ),
    )
    runFor(engine, 0.005)
    const drop = engine.netVoltage('top+40') - engine.netVoltage('c15')
    expect(drop).toBeGreaterThan(0.6)
    expect(drop).toBeLessThan(0.8)
    // and the cathode-side node carries the rest of the supply
    expect(engine.netVoltage('c15')).toBeGreaterThan(4.0)
  }, 20000)
})

describe('4. LEDs', () => {
  it('LED + 330Ω on 5V lights up without burning', () => {
    const rt = new RailTap()
    const engine = new SimEngine(
      poweredLayout(
        [
          twoLead('R1', 'resistor', rt.plus(), 'a15', { resistance: 330 }),
          twoLead('D1', 'led', 'b15', rt.minus(), { color: 'red' }),
        ],
        [],
      ),
    )
    runFor(engine, 0.01)
    const led = engine.telemetry().components['D1']
    expect(led).toBeDefined()
    expect(led.ledBrightness ?? 0).toBeGreaterThan(0.3)
    expect(led.ledBrightness ?? 0).toBeLessThanOrEqual(1)
    expect(led.burned ?? false).toBe(false)
  }, 20000)

  it('LED wired directly across the supply burns out, latches, and raises an issue', () => {
    const rt = new RailTap()
    const engine = new SimEngine(
      poweredLayout([twoLead('D1', 'led', rt.plus(), rt.minus(), { color: 'red' })], []),
    )
    runFor(engine, 0.02) // well past the >1ms sustained-overcurrent threshold
    const led = engine.telemetry().components['D1']
    expect(led).toBeDefined()
    expect(led.burned).toBe(true)
    // burned LEDs stop emitting light
    expect(led.ledBrightness ?? 0).toBeLessThanOrEqual(0.01)
    // an issue mentions the LED
    expect(
      engine.issues.some((i: SimIssue) => i.componentId === 'D1' || i.message.includes('D1')),
      `issues: ${JSON.stringify(engine.issues)}`,
    ).toBe(true)

    // burned state LATCHES: removing power does not heal it
    engine.setRuntimeParam('PS1', 'voltage', 0)
    runFor(engine, 0.01)
    expect(engine.telemetry().components['D1'].burned).toBe(true)
  }, 20000)
})

describe('5. pushbutton', () => {
  it('LED is dark until pressed=true, bright on the next steps, dark again on release', () => {
    const rt = new RailTap()
    const engine = new SimEngine(
      poweredLayout(
        [
          dip('BTN1', 'pushbutton', 'f10'), // A side col 10, B side col 12
          twoLead('R1', 'resistor', 'g12', 'a30', { resistance: 330 }),
          twoLead('D1', 'led', 'b30', rt.minus(), { color: 'red' }),
        ],
        [wire(rt.plus(), 'j10')],
      ),
    )
    runFor(engine, 0.005)
    expect(engine.telemetry().components['D1'].ledBrightness ?? 0).toBeLessThan(0.05)

    engine.setRuntimeParam('BTN1', 'pressed', true)
    runFor(engine, 0.005)
    expect(engine.telemetry().components['D1'].ledBrightness ?? 0).toBeGreaterThan(0.3)

    engine.setRuntimeParam('BTN1', 'pressed', false)
    runFor(engine, 0.005)
    expect(engine.telemetry().components['D1'].ledBrightness ?? 0).toBeLessThan(0.05)
  }, 20000)
})

describe('6. potentiometer', () => {
  it('wiper voltage tracks position (0.25 → ~1.25V of 5V, ±5%)', () => {
    const rt = new RailTap()
    const engine = new SimEngine(
      poweredLayout(
        [
          leads('POT1', 'potentiometer', [rt.minus(), 'a25', rt.plus()], {
            resistance: 10000,
            position: 0.25,
          }),
        ],
        [],
      ),
    )
    runFor(engine, 0.005)
    const v25 = engine.netVoltage('b25')
    expect(v25).toBeGreaterThan(1.25 * 0.95)
    expect(v25).toBeLessThan(1.25 * 1.05)

    // live knob turn through setRuntimeParam
    engine.setRuntimeParam('POT1', 'position', 0.75)
    runFor(engine, 0.005)
    const v75 = engine.netVoltage('b25')
    expect(v75).toBeGreaterThan(3.75 * 0.95)
    expect(v75).toBeLessThan(3.75 * 1.05)
  }, 20000)
})

describe('7. function generator', () => {
  it('50Hz square (0..5V) toggles the probed net over a cycle', () => {
    const engine = new SimEngine(
      layout(
        [
          funcGen('FG1', { waveform: 'square', frequency: 50, amplitude: 2.5, offset: 2.5 }),
        ],
        [wire('FG1:out', 'a30'), wire('FG1:gnd', 'bot-0')],
      ),
    )
    // 2 full periods, sampled every 0.5ms via engine.netVoltage
    const samples = sampleNet(engine, 'c30', 0.04, 0.0005)
    const max = Math.max(...samples)
    const min = Math.min(...samples)
    expect(max).toBeGreaterThan(4.5)
    expect(min).toBeLessThan(0.5)
    // roughly half the time high, half low
    const n = samples.length
    expect(samples.filter((v) => v > 4).length).toBeGreaterThan(n * 0.25)
    expect(samples.filter((v) => v < 1).length).toBeGreaterThan(n * 0.25)
    // it actually toggles: 2 periods → about 2 rising edges
    const edges = risingEdges(samples, 1, 4)
    expect(edges).toBeGreaterThanOrEqual(1)
    expect(edges).toBeLessThanOrEqual(3)
  }, 20000)
})
