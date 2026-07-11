/**
 * End-to-end tests for the curated example circuits in examples/*.json.
 * Owned by the demos agent (together with the example files themselves).
 *
 * For every example: (a) validateLayout accepts it with zero errors, and
 * (b) a SimEngine built from it actually behaves: the blinky blinks at
 * ~1.5Hz, the date display spells "0611", the counter counts one digit per
 * 555 period and resets on the button, and the night light follows the
 * photoresistor's light slider.
 */
import { describe, expect, it } from 'vitest'
import { validateLayout } from '../src/model/validate'
import { SimEngine } from '../src/sim/engine'
import type { CircuitLayout } from '../src/model/types'

import blinkyRaw from '../examples/blinky-555.json'
import dateRaw from '../examples/date-display.json'
import counterRaw from '../examples/counter.json'
import nightRaw from '../examples/night-light.json'

const LONG = { timeout: 120_000 }

const EXAMPLES: [string, unknown][] = [
  ['blinky-555', blinkyRaw],
  ['date-display', dateRaw],
  ['counter', counterRaw],
  ['night-light', nightRaw],
]

// ------------------------------------------------------------------ helpers

function load(raw: unknown): CircuitLayout {
  const res = validateLayout(raw)
  expect(res.errors, `validation errors:\n${res.errors.join('\n')}`).toEqual([])
  expect(res.ok).toBe(true)
  if (!res.layout) throw new Error('validateLayout reported ok but returned no layout')
  return res.layout
}

function engineFor(raw: unknown): SimEngine {
  return new SimEngine(load(raw))
}

function expectNoEngineErrors(engine: SimEngine): void {
  const errors = engine.issues.filter((i) => i.level === 'error')
  expect(errors, `engine errors:\n${errors.map((e) => e.message).join('\n')}`).toEqual([])
}

/** Count low->high transitions with hysteresis (below `lo`, then above `hi`). */
function risingEdges(samples: number[], lo = 1.5, hi = 3.5): number {
  let armed = false
  let count = 0
  for (const v of samples) {
    if (v < lo) armed = true
    else if (v > hi && armed) {
      count += 1
      armed = false
    }
  }
  return count
}

/** Advance in `sliceDt` slices for `seconds`, recording the net voltage at `ref`. */
function sampleNet(engine: SimEngine, ref: string, seconds: number, sliceDt: number): number[] {
  const out: number[] = []
  const n = Math.max(1, Math.round(seconds / sliceDt))
  for (let i = 0; i < n; i++) {
    engine.advance(sliceDt)
    out.push(engine.netVoltage(ref))
  }
  return out
}

const SEG_KEYS = ['a', 'b', 'c', 'd', 'e', 'f', 'g'] as const

/** Segment fonts, bit0=a .. bit6=g (matching the chip models / datasheets). */
const CD4026_FONT = [0x3f, 0x06, 0x5b, 0x4f, 0x66, 0x6d, 0x7d, 0x07, 0x7f, 0x6f]
const CD4511_FONT = [0x3f, 0x06, 0x5b, 0x4f, 0x66, 0x6d, 0x7c, 0x07, 0x7f, 0x67]

function segmentBits(engine: SimEngine, displayId: string): number {
  const seg = engine.telemetry().components[displayId]?.segments
  expect(seg, `display ${displayId} should report segments telemetry`).toBeDefined()
  let bits = 0
  for (let i = 0; i < SEG_KEYS.length; i++) {
    if (seg![SEG_KEYS[i]]) bits |= 1 << i
  }
  return bits
}

/** The digit a display shows according to `font`, or -1 for an unknown pattern. */
function displayedDigit(engine: SimEngine, displayId: string, font: number[]): number {
  return font.indexOf(segmentBits(engine, displayId))
}

function ledBrightness(engine: SimEngine, ledId: string): number {
  const tele = engine.telemetry().components[ledId]
  expect(tele, `LED ${ledId} should have telemetry`).toBeDefined()
  return tele!.ledBrightness ?? 0
}

// --------------------------------------------------------------- validation

describe('example layouts validate', () => {
  for (const [name, raw] of EXAMPLES) {
    it(`${name}.json passes validateLayout with zero errors`, () => {
      const layout = load(raw)
      expect(layout.version).toBe(1)
      expect(layout.name).toBeTruthy()
      expect(layout.description).toBeTruthy()
      expect(layout.components.length).toBeGreaterThan(0)
    })
  }
})

// --------------------------------------------------------------- blinky-555

describe('blinky-555 example', () => {
  it('toggles OUT at 1.5Hz +-30% and the LED blinks with it', LONG, () => {
    const engine = engineFor(blinkyRaw)

    // let the first (longer) astable cycle pass
    engine.advance(1.0)
    expectNoEngineErrors(engine)

    // the scope probe tip (i12) sits on the same net as 555 OUT (pin 3, f12)
    expect(Math.abs(engine.netVoltage('i12') - engine.netVoltage('f12'))).toBeLessThan(1e-9)

    // sample OUT for 4s and track LED brightness along the way
    const window = 4.0
    const slice = 0.002
    const samples: number[] = []
    let minB = Infinity
    let maxB = -Infinity
    const n = Math.round(window / slice)
    for (let i = 0; i < n; i++) {
      engine.advance(slice)
      samples.push(engine.netVoltage('f12'))
      const b = ledBrightness(engine, 'D1')
      if (b < minB) minB = b
      if (b > maxB) maxB = b
    }

    const freq = risingEdges(samples) / window
    expect(freq, `measured ${freq.toFixed(3)}Hz, want 1.5Hz +-30%`).toBeGreaterThanOrEqual(1.05)
    expect(freq, `measured ${freq.toFixed(3)}Hz, want 1.5Hz +-30%`).toBeLessThanOrEqual(1.95)

    // LED brightness alternates between clearly-on and clearly-off
    expect(maxB, 'LED should turn visibly on each cycle').toBeGreaterThan(0.2)
    expect(minB, 'LED should turn off each cycle').toBeLessThan(0.05)
    expect(engine.telemetry().components.D1?.burned).not.toBe(true)
    expectNoEngineErrors(engine)
  })
})

// -------------------------------------------------------------- date-display

describe('date-display example', () => {
  it('spells "0611" (June 11) on the four 7-segment displays', LONG, () => {
    const engine = engineFor(dateRaw)
    engine.advance(0.01)
    expectNoEngineErrors(engine)

    const expected: [string, number][] = [
      ['DS1', 0],
      ['DS2', 6],
      ['DS3', 1],
      ['DS4', 1],
    ]
    for (const [id, digit] of expected) {
      // exact segment pattern of the CD4511 font for that digit
      expect(
        segmentBits(engine, id),
        `${id} should show the CD4511 pattern for digit ${digit}`,
      ).toBe(CD4511_FONT[digit])
      // and no decimal point anywhere
      expect(engine.telemetry().components[id]?.segments?.dp).toBe(false)
    }
  })
})

// ------------------------------------------------------------------ counter

describe('counter example', () => {
  it('advances one digit per 555 period and resets via the pushbutton', LONG, () => {
    const engine = engineFor(counterRaw)

    // settle: rails up, 555 starts its first cycle
    engine.advance(0.05)
    expectNoEngineErrors(engine)
    const d0 = displayedDigit(engine, 'DS1', CD4026_FONT)
    expect(d0, 'display should show a valid CD4026 digit').toBeGreaterThanOrEqual(0)

    // count actual 555 periods on OUT (pin 3 of U1 at f5 -> hole f7) and
    // require the displayed digit to advance by exactly that many (mod 10)
    const clockSamples = sampleNet(engine, 'f7', 2.6, 0.002)
    const periods = risingEdges(clockSamples)
    expect(periods, '~2Hz clock should tick several times in 2.6s').toBeGreaterThanOrEqual(3)
    expect(periods).toBeLessThanOrEqual(8)
    const d1 = displayedDigit(engine, 'DS1', CD4026_FONT)
    expect(d1, `digit should advance by ${periods} (mod 10) from ${d0}`).toBe(
      (d0 + periods) % 10,
    )

    // hold the reset button: count snaps to 0 and stays there across clocks
    engine.setRuntimeParam('SW1', 'pressed', true)
    engine.advance(0.8)
    expect(displayedDigit(engine, 'DS1', CD4026_FONT), 'held reset should show 0').toBe(0)

    // release: counting resumes from 0, again one digit per period
    engine.setRuntimeParam('SW1', 'pressed', false)
    const afterReset = sampleNet(engine, 'f7', 1.2, 0.002)
    const periods2 = risingEdges(afterReset)
    expect(periods2).toBeGreaterThanOrEqual(1)
    expect(displayedDigit(engine, 'DS1', CD4026_FONT)).toBe(periods2 % 10)
    expectNoEngineErrors(engine)
  })
})

// --------------------------------------------------------------- night-light

describe('night-light example', () => {
  it('LED is dark in bright light and lights up in the dark', LONG, () => {
    const engine = engineFor(nightRaw)

    // bright environment: divider node low, comparator output low, LED off
    engine.setRuntimeParam('LDR1', 'light', 0.9)
    engine.advance(0.05)
    expectNoEngineErrors(engine)
    expect(ledBrightness(engine, 'D1'), 'LED must be off in bright light').toBeLessThan(0.05)

    // darkness: LDR resistance soars, divider node rises above the pot
    // threshold, comparator output goes high, LED lights
    engine.setRuntimeParam('LDR1', 'light', 0.05)
    engine.advance(0.05)
    expect(ledBrightness(engine, 'D1'), 'LED must light up in the dark').toBeGreaterThan(0.3)

    // and back to bright: it switches off again
    engine.setRuntimeParam('LDR1', 'light', 0.9)
    engine.advance(0.05)
    expect(ledBrightness(engine, 'D1')).toBeLessThan(0.05)
    expect(engine.telemetry().components.D1?.burned).not.toBe(true)
    expectNoEngineErrors(engine)
  })
})
