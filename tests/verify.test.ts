/**
 * Tests for the self-verification layer (src/llm/verify.ts) and the
 * expectations wire format (src/llm/schema.ts additions).
 *
 * Strategy: real example circuits from examples/*.json are machine-tested
 * against honest expectations (they must pass), then deliberately broken
 * variants must fail with failure strings that embed the MEASURED data the
 * repair turn needs.
 */
import { describe, expect, it } from 'vitest'
import { validateLayout } from '../src/model/validate'
import { describeExpectation, runVerification, verifyCircuit } from '../src/llm/verify'
import {
  CIRCUIT_OUTPUT_SCHEMA,
  emitToExpectations,
  expectationsToEmit,
  extractEnvelope,
  MIN_VERIFIABLE_HZ,
} from '../src/llm/schema'
import type { Expectation } from '../src/llm/schema'
import type { CircuitLayout } from '../src/model/types'

import blinkyRaw from '../examples/blinky-555.json'
import dateRaw from '../examples/date-display.json'
import nightRaw from '../examples/night-light.json'

const LONG = { timeout: 60_000 }

function load(raw: unknown): CircuitLayout {
  const res = validateLayout(raw)
  expect(res.errors, `validation errors:\n${res.errors.join('\n')}`).toEqual([])
  if (!res.ok || !res.layout) throw new Error('validateLayout rejected the layout')
  return res.layout
}

/** 5V supply driving a red LED straight across the rails — burns instantly. */
const BURNED_LED_LAYOUT: CircuitLayout = {
  version: 1,
  name: 'LED with no series resistor',
  components: [
    { id: 'PS1', type: 'power_supply', params: { voltage: 5 } },
    { id: 'D1', type: 'led', params: { color: 'red' }, holes: ['top+1', 'top-1'] },
  ],
  wires: [
    { id: 'w1', from: 'PS1:+', to: 'top+0', color: 'red' },
    { id: 'w2', from: 'PS1:-', to: 'top-0', color: 'black' },
  ],
}

// --------------------------------------------------------------- verifyCircuit

describe('verifyCircuit — expectations', () => {
  it('blinky-555 passes led_blinks 0.5-3Hz', LONG, () => {
    const res = verifyCircuit(load(blinkyRaw), [
      { kind: 'led_blinks', target: 'D1', minHz: 0.5, maxHz: 3 },
    ])
    expect(res.failures, res.failures.join('\n')).toEqual([])
    expect(res.health, res.health.join('\n')).toEqual([])
    expect(res.pass).toBe(true)
  })

  it('blinky-555 passes led_blinks with OMITTED frequency bounds (~1Hz, default floor)', LONG, () => {
    // The schema allows minHz/maxHz to be null. The window must then be sized
    // for the default floor the pass check uses, not stay at 1s — otherwise
    // every honest blinker under 2Hz fails the >=2-transitions requirement.
    const res = verifyCircuit(load(blinkyRaw), [{ kind: 'led_blinks', target: 'D1' }])
    expect(res.failures, res.failures.join('\n')).toEqual([])
    expect(res.health, res.health.join('\n')).toEqual([])
    expect(res.pass).toBe(true)
  })

  it('blinky-555 without the LED series resistor fails with measured data', LONG, () => {
    const raw = JSON.parse(JSON.stringify(blinkyRaw)) as { components: { id: string }[] }
    raw.components = raw.components.filter((c) => c.id !== 'R3')
    const res = verifyCircuit(load(raw), [
      { kind: 'led_blinks', target: 'D1', minHz: 0.5, maxHz: 3 },
    ])
    expect(res.pass).toBe(false)
    expect(res.failures).toHaveLength(1)
    const msg = res.failures[0]
    // the failure embeds the target, the expected band and the measurements
    expect(msg).toContain('LED D1')
    expect(msg).toContain('0.5-3Hz')
    expect(msg).toContain('measured 0 off→on transitions in 6.0s')
    expect(msg).toContain('brightness stayed 0.00')
    expect(msg).toContain('anode net at')
  })

  it('date-display passes segments_show 0,6,1,1', LONG, () => {
    const res = verifyCircuit(load(dateRaw), [
      { kind: 'segments_show', target: 'DS1', digit: '0' },
      { kind: 'segments_show', target: 'DS2', digit: '6' },
      { kind: 'segments_show', target: 'DS3', digit: '1' },
      { kind: 'segments_show', target: 'DS4', digit: '1' },
    ])
    expect(res.failures, res.failures.join('\n')).toEqual([])
    expect(res.health, res.health.join('\n')).toEqual([])
    expect(res.pass).toBe(true)
  })

  it('date-display fails a wrong segments_show digit with the measured pattern', LONG, () => {
    const res = verifyCircuit(load(dateRaw), [{ kind: 'segments_show', target: 'DS1', digit: '7' }])
    expect(res.pass).toBe(false)
    expect(res.failures).toHaveLength(1)
    const msg = res.failures[0]
    expect(msg).toContain('display DS1')
    expect(msg).toContain('expected digit 7')
    expect(msg).toContain('measured lit segments "abcdef"') // the 0 pattern
    expect(msg).toContain('reads as digit 0')
  })

  it('night-light honestly passes led_off in its shipped bright state (light=0.9)', LONG, () => {
    // The example ships with the photoresistor at light 0.9 (bright), so the
    // honest no-interaction expectation is: the night-light LED stays off.
    const res = verifyCircuit(load(nightRaw), [{ kind: 'led_off', target: 'D1' }])
    expect(res.failures, res.failures.join('\n')).toEqual([])
    expect(res.health, res.health.join('\n')).toEqual([])
    expect(res.pass).toBe(true)
  })

  it('rejects expectations whose target is not the right component kind', LONG, () => {
    const res = verifyCircuit(load(nightRaw), [
      { kind: 'led_blinks', target: 'U1', minHz: 1 }, // U1 is the op-amp
      { kind: 'segments_show', target: 'D1', digit: '3' }, // D1 is an LED
      { kind: 'buzzer_sounds', target: 'BZ9' }, // does not exist
    ])
    expect(res.pass).toBe(false)
    expect(res.failures).toHaveLength(3)
    expect(res.failures[0]).toContain('not an led component')
    expect(res.failures[1]).toContain('not a seven_segment component')
    expect(res.failures[2]).toContain('not a buzzer component')
  })

  it('measures net oscillation on the 555 OUT strip', LONG, () => {
    // blinky-555: scope probe and OUT share strip column 12 (bottom block)
    const res = verifyCircuit(load(blinkyRaw), [
      { kind: 'net_oscillates', target: 'f12', minHz: 1, maxHz: 2 },
      { kind: 'net_in_range', target: 'top+1', minV: 4.5, maxV: 5.5 },
    ])
    expect(res.failures, res.failures.join('\n')).toEqual([])
    expect(res.pass).toBe(true)
  })
})

describe('verifyCircuit — health checks', () => {
  it('a deliberately burned LED fails health even with no expectations', LONG, () => {
    const res = verifyCircuit(BURNED_LED_LAYOUT, [])
    expect(res.pass).toBe(false)
    expect(res.failures).toEqual([])
    expect(res.health.length).toBeGreaterThan(0)
    expect(res.health.join('\n')).toMatch(/burned out/)
  })

  it('an unpowered chip fails health', LONG, () => {
    // 555 with both supply wires removed: VCC pin floats -> unpowered warning
    const raw = JSON.parse(JSON.stringify(blinkyRaw)) as { wires: { id: string }[] }
    raw.wires = raw.wires.filter((w) => w.id !== 'w3' && w.id !== 'w4')
    const res = verifyCircuit(load(raw), [])
    expect(res.pass).toBe(false)
    expect(res.health.join('\n')).toMatch(/not connected to a powered net/)
  })
})

// -------------------------------------------------------------- runVerification

describe('runVerification (async wrapper)', () => {
  it('falls back to a direct call when Worker is unavailable (node)', LONG, async () => {
    expect(typeof Worker).toBe('undefined')
    const res = await runVerification(BURNED_LED_LAYOUT, [])
    expect(res.pass).toBe(false)
    expect(res.health.join('\n')).toMatch(/burned out/)
  })

  it('rejects immediately on an already-aborted signal', async () => {
    const ctrl = new AbortController()
    ctrl.abort()
    await expect(
      runVerification(BURNED_LED_LAYOUT, [], { signal: ctrl.signal }),
    ).rejects.toThrow(/cancelled/i)
  })
})

// ------------------------------------------------------- expectations wire format

describe('expectations wire format (schema.ts)', () => {
  const APP_SIDE: Expectation[] = [
    { kind: 'led_blinks', target: 'D1', minHz: 0.5, maxHz: 3 },
    { kind: 'segments_show', target: 'DS1', digit: '0' },
    { kind: 'buzzer_sounds', target: 'BZ1' },
  ]

  it('round-trips through expectationsToEmit / emitToExpectations', () => {
    const emitted = expectationsToEmit(APP_SIDE)
    expect(emitted[0]).toEqual({
      kind: 'led_blinks',
      target: 'D1',
      digit: null,
      minHz: 0.5,
      maxHz: 3,
      minV: null,
      maxV: null,
    })
    expect(emitted[2]).toEqual({
      kind: 'buzzer_sounds',
      target: 'BZ1',
      digit: null,
      minHz: null,
      maxHz: null,
      minV: null,
      maxV: null,
    })
    expect(emitToExpectations(emitted)).toEqual(APP_SIDE)
  })

  it('emitToExpectations clamps frequency bounds below the verifiable floor', () => {
    expect(MIN_VERIFIABLE_HZ).toBe(0.25) // 2 transitions / 8s window cap
    const [slow] = emitToExpectations([
      {
        kind: 'led_blinks',
        target: 'D1',
        digit: null,
        minHz: 0.05,
        maxHz: 0.1,
        minV: null,
        maxV: null,
      },
    ])
    // sub-floor bounds are mathematically unverifiable — clamp them up
    expect(slow.minHz).toBe(MIN_VERIFIABLE_HZ)
    expect(slow.maxHz).toBe(MIN_VERIFIABLE_HZ)
    // bounds at or above the floor pass through untouched
    const [ok] = emitToExpectations([
      {
        kind: 'net_oscillates',
        target: 'f12',
        digit: null,
        minHz: 0.5,
        maxHz: 3,
        minV: null,
        maxV: null,
      },
    ])
    expect(ok.minHz).toBe(0.5)
    expect(ok.maxHz).toBe(3)
  })

  it('extractEnvelope surfaces well-formed expectations and tolerates junk', () => {
    const env = extractEnvelope({
      explanation: 'x',
      circuit: { name: 'c', board: null, components: [], wires: [] },
      expectations: [
        { kind: 'led_on', target: 'D1', digit: null, minHz: null, maxHz: null, minV: null, maxV: null },
        { kind: 'not_a_kind', target: 'D1' }, // unknown kind -> dropped
        'garbage', // not an object -> dropped
      ],
    })
    expect(env.expectations).toHaveLength(1)
    expect(env.expectations[0].kind).toBe('led_on')
  })

  it('extractEnvelope defaults missing expectations to []', () => {
    const env = extractEnvelope({
      explanation: 'x',
      circuit: { name: 'c', components: [], wires: [] },
    })
    expect(env.expectations).toEqual([])
  })

  it('CIRCUIT_OUTPUT_SCHEMA requires the expectations array', () => {
    expect(CIRCUIT_OUTPUT_SCHEMA.required).toContain('expectations')
    const props = CIRCUIT_OUTPUT_SCHEMA.properties as Record<string, { type?: string }>
    expect(props.expectations.type).toBe('array')
  })
})

// ------------------------------------------------------------- prompt coverage

describe('system prompt expectations instructions', () => {
  it('documents the expectation kinds and embeds them in the worked examples', async () => {
    const { buildSystemPrompt } = await import('../src/llm/prompt')
    const prompt = buildSystemPrompt()
    expect(prompt).toContain('## Declared expectations (machine-tested)')
    expect(prompt).toContain('machine-tested against these')
    // segments_show documented as targeting a seven_segment id
    expect(prompt).toMatch(/segments_show.*seven_segment/s)
    // few-shot envelopes carry honest expectations (button LED off, blinker 0.5-3Hz)
    expect(prompt).toContain('"kind": "led_off"')
    expect(prompt).toContain('"kind": "led_blinks"')
    expect(prompt).toContain('"minHz": 0.5')
    expect(prompt).toContain('"maxHz": 3')
  })

  it('forbids declaring frequency bounds below the verifiable floor', async () => {
    const { buildSystemPrompt } = await import('../src/llm/prompt')
    const prompt = buildSystemPrompt()
    expect(prompt).toContain(`cannot measure anything slower than ${MIN_VERIFIABLE_HZ}Hz`)
    expect(prompt).toContain(`minHz below ${MIN_VERIFIABLE_HZ}`)
  })
})

// ----------------------------------------------------------- describeExpectation

describe('describeExpectation', () => {
  it('produces human-readable one-liners', () => {
    expect(
      describeExpectation({ kind: 'led_blinks', target: 'D1', minHz: 0.5, maxHz: 3 }),
    ).toBe('LED D1 blinks at 0.5-3Hz')
    expect(describeExpectation({ kind: 'segments_show', target: 'DS2', digit: '6' })).toBe(
      'display DS2 shows "6"',
    )
    expect(describeExpectation({ kind: 'led_off', target: 'D1' })).toContain('stays off')
    expect(describeExpectation({ kind: 'buzzer_sounds', target: 'BZ1' })).toBe('buzzer BZ1 sounds')
  })
})
