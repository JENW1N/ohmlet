/**
 * Self-verification for AI-generated circuits.
 *
 * `verifyCircuit` is PURE and node-testable (no DOM): it builds a SimEngine
 * from the layout, warms it up, samples telemetry over an adaptive window and
 * checks the model's declared expectations (led_on / led_off / led_blinks /
 * segments_show / net_oscillates / net_in_range / buzzer_sounds) plus a set of
 * always-on HEALTH checks (burned LEDs, shorts, unpowered chips, solver
 * NaN/convergence trouble). Every failure string embeds the MEASURED data so
 * the repair turn can act on it.
 *
 * `runVerification` is the async wrapper used by the generate pipeline: in
 * the browser it runs verifyCircuit inside a module Worker so the UI never
 * jank-freezes, and falls back to a direct call when Workers are unavailable
 * (node, tests, CSP).
 */

import '../sim/chips/all' // side-effect: registers every behavioral chip model

import type { CircuitLayout, SimTelemetry } from '../model/types'
import { SimEngine } from '../sim/engine'
import { MIN_VERIFIABLE_HZ } from './schema'
import type { Expectation } from './schema'

// ---------------------------------------------------------------- results

export interface VerifyResult {
  /** true ⇔ zero expectation failures AND zero health problems */
  pass: boolean
  /** expectation failures, with measured data embedded */
  failures: string[]
  /** engine-health problems (always checked, even with no expectations) */
  health: string[]
}

/** postMessage payload verify.worker.ts receives (structured-clone-safe). */
export interface VerifyRequest {
  layout: CircuitLayout
  expectations: Expectation[]
}

/** postMessage payload verify.worker.ts replies with. */
export type VerifyReply =
  | { ok: true; result: VerifyResult }
  | { ok: false; error: string }

// ----------------------------------------------------------------- tuning

/** Sim time to run before sampling starts (rails up, first solve settled). */
const WARMUP_S = 0.05
/** Telemetry sampling period (sim seconds). */
const SAMPLE_DT = 0.005
/** Smallest / largest sampling window (sim seconds). */
const MIN_WINDOW_S = 1
const MAX_WINDOW_S = 8
/** LED brightness hysteresis: ≥ON enters "on", ≤OFF re-arms "off". */
const LED_ON = 0.15
const LED_OFF = 0.05
/** A net must swing at least this much to count as oscillating (V). */
const MIN_SWING_V = 0.5
/**
 * Default lower frequency bound when the expectation omits minHz (Hz). Equals
 * the slowest bound the capped window can verify (2 transitions in 8s), so an
 * omitted bound never demands more than the window can measure.
 */
const DEFAULT_MIN_HZ = MIN_VERIFIABLE_HZ

// ----------------------------------------------------- seven-segment fonts

const SEG_KEYS = ['a', 'b', 'c', 'd', 'e', 'f', 'g'] as const

/**
 * Acceptable segment patterns per digit, bit0=a … bit6=g (dp ignored).
 * Covers both standard font variants: CD4511 draws 6 and 9 without tails
 * (0x7c / 0x67), CD4026 with tails (0x7d / 0x6f); 7 may carry segment f.
 */
const DIGIT_PATTERNS: readonly (readonly number[])[] = [
  [0x3f], // 0
  [0x06], // 1
  [0x5b], // 2
  [0x4f], // 3
  [0x66], // 4
  [0x6d], // 5
  [0x7d, 0x7c], // 6 (with / without tail)
  [0x07, 0x27], // 7 (without / with serif f)
  [0x7f], // 8
  [0x6f, 0x67], // 9 (with / without tail)
]

function segmentBits(segments: Record<string, boolean>): number {
  let bits = 0
  for (let i = 0; i < SEG_KEYS.length; i++) {
    if (segments[SEG_KEYS[i]]) bits |= 1 << i
  }
  return bits
}

function litSegmentNames(bits: number): string {
  const lit: string[] = []
  for (let i = 0; i < SEG_KEYS.length; i++) {
    if (bits & (1 << i)) lit.push(SEG_KEYS[i])
  }
  return lit.length > 0 ? lit.join('') : 'none'
}

/** The digit a pattern reads as, or -1 when it matches no digit. */
function patternDigit(bits: number): number {
  for (let d = 0; d < DIGIT_PATTERNS.length; d++) {
    if (DIGIT_PATTERNS[d].includes(bits)) return d
  }
  return -1
}

// ------------------------------------------------------------- formatting

function fmtV(v: number | undefined): string {
  return v !== undefined && Number.isFinite(v) ? `${v.toFixed(2)}V` : 'unconnected'
}

function fmtHzRange(minHz: number | undefined, maxHz: number | undefined): string {
  const lo = minHz ?? DEFAULT_MIN_HZ
  return maxHz !== undefined ? `${lo}-${maxHz}Hz` : `≥${lo}Hz`
}

/** Human-readable one-liner for an expectation (UI badge + summaries). */
export function describeExpectation(e: Expectation): string {
  switch (e.kind) {
    case 'led_on':
      return `LED ${e.target} lights up`
    case 'led_off':
      return `LED ${e.target} stays off until you interact`
    case 'led_blinks':
      return `LED ${e.target} blinks at ${fmtHzRange(e.minHz, e.maxHz)}`
    case 'segments_show':
      return `display ${e.target} shows "${e.digit ?? '?'}"`
    case 'net_oscillates':
      return `net ${e.target} oscillates at ${fmtHzRange(e.minHz, e.maxHz)}`
    case 'net_in_range':
      return `net ${e.target} stays within ${e.minV ?? '-∞'}V to ${e.maxV ?? '+∞'}V`
    case 'buzzer_sounds':
      return `buzzer ${e.target} sounds`
  }
}

// ----------------------------------------------------------- measurements

interface LedStats {
  /** off→on transitions (hysteresis LED_ON / LED_OFF) */
  transitions: number
  min: number
  max: number
  onFraction: number
  finalOn: boolean
}

function ledStats(samples: number[]): LedStats {
  let min = Infinity
  let max = -Infinity
  let on = samples.length > 0 && samples[0] >= LED_ON
  let onCount = on ? 1 : 0
  let transitions = 0
  for (let i = 0; i < samples.length; i++) {
    const b = samples[i]
    if (b < min) min = b
    if (b > max) max = b
    if (i === 0) continue
    if (!on && b >= LED_ON) {
      on = true
      transitions++
    } else if (on && b <= LED_OFF) {
      on = false
    }
    if (on) onCount++
  }
  if (samples.length === 0) {
    min = 0
    max = 0
  }
  return {
    transitions,
    min,
    max,
    onFraction: samples.length > 0 ? onCount / samples.length : 0,
    finalOn: on,
  }
}

interface NetStats {
  valid: boolean
  min: number
  max: number
  /** rising threshold crossings with hysteresis at 30%/70% of the swing */
  crossings: number
}

function netStats(samples: number[]): NetStats {
  let min = Infinity
  let max = -Infinity
  let valid = false
  for (const v of samples) {
    if (!Number.isFinite(v)) continue
    valid = true
    if (v < min) min = v
    if (v > max) max = v
  }
  if (!valid) return { valid: false, min: NaN, max: NaN, crossings: 0 }
  const swing = max - min
  let crossings = 0
  if (swing >= MIN_SWING_V) {
    const lo = min + 0.3 * swing
    const hi = min + 0.7 * swing
    let armed = false
    for (const v of samples) {
      if (!Number.isFinite(v)) continue
      if (v < lo) armed = true
      else if (v > hi && armed) {
        crossings++
        armed = false
      }
    }
  }
  return { valid: true, min, max, crossings }
}

// --------------------------------------------------------------- verifier

function adaptiveWindow(expectations: Expectation[]): number {
  // max(1s, 3/minHz of the slowest declared frequency), capped at 8 sim-s.
  // An omitted minHz falls back to DEFAULT_MIN_HZ — the SAME default the pass
  // check uses — so the window is always sized for the bound actually tested
  // (a 1s window would fail every honest blinker under 2 Hz: the pass check
  // needs >= 2 transitions).
  let window = MIN_WINDOW_S
  for (const e of expectations) {
    if (e.kind !== 'led_blinks' && e.kind !== 'net_oscillates') continue
    const minHz = e.minHz ?? DEFAULT_MIN_HZ
    if (minHz > 0) {
      window = Math.max(window, 3 / minHz)
    }
  }
  return Math.min(window, MAX_WINDOW_S)
}

/** Engine warnings that count as health problems even at warning level. */
function isSeriousWarning(message: string): boolean {
  return (
    message.includes('short circuit') ||
    message.includes('not connected to a powered net') ||
    message.includes('converge') ||
    message.includes('numerical error') ||
    message.includes('singular')
  )
}

/**
 * Build the circuit in the simulator and machine-test it against the
 * declared expectations. Pure, synchronous, node-testable.
 */
export function verifyCircuit(
  layout: CircuitLayout,
  expectations: Expectation[],
): VerifyResult {
  const engine = new SimEngine(layout)
  engine.advance(WARMUP_S)

  const window = adaptiveWindow(expectations)
  const steps = Math.max(1, Math.round(window / SAMPLE_DT))

  const typeOf = new Map<string, string>()
  for (const c of Array.isArray(layout?.components) ? layout.components : []) {
    if (c && typeof c.id === 'string') typeOf.set(c.id, c.type)
  }

  // which series each expectation needs
  const ledSeries = new Map<string, number[]>()
  const netSeries = new Map<string, number[]>()
  const buzzerOnCount = new Map<string, number>()
  const buzzerPeakV = new Map<string, number>()
  const segLast = new Map<string, Record<string, boolean>>()
  for (const e of expectations) {
    switch (e.kind) {
      case 'led_on':
      case 'led_off':
      case 'led_blinks':
        ledSeries.set(e.target, [])
        break
      case 'net_oscillates':
      case 'net_in_range':
        netSeries.set(e.target, [])
        break
      case 'buzzer_sounds':
        buzzerOnCount.set(e.target, 0)
        buzzerPeakV.set(e.target, 0)
        break
      case 'segments_show':
        segLast.set(e.target, {})
        break
    }
  }

  // ---- sample the window
  let tele: SimTelemetry = engine.telemetry()
  for (let i = 0; i < steps; i++) {
    engine.advance(SAMPLE_DT)
    tele = engine.telemetry()
    for (const [id, arr] of ledSeries) arr.push(tele.components[id]?.ledBrightness ?? 0)
    for (const [ref, arr] of netSeries) arr.push(engine.netVoltage(ref))
    for (const id of buzzerOnCount.keys()) {
      const ct = tele.components[id]
      if (ct?.sounding) buzzerOnCount.set(id, (buzzerOnCount.get(id) ?? 0) + 1)
      const pv = ct?.pinVoltages
      if (pv) {
        const dv = Math.abs((pv.p1 ?? NaN) - (pv.p2 ?? NaN))
        if (Number.isFinite(dv) && dv > (buzzerPeakV.get(id) ?? 0)) buzzerPeakV.set(id, dv)
      }
    }
    for (const id of segLast.keys()) {
      const seg = tele.components[id]?.segments
      if (seg) segLast.set(id, seg)
    }
  }

  const ledPinHint = (id: string): string => {
    const pv = tele.components[id]?.pinVoltages
    if (!pv) return ''
    return `; anode net at ${fmtV(pv.anode)}, cathode at ${fmtV(pv.cathode)}`
  }

  // ---- evaluate expectations
  const failures: string[] = []
  for (const e of expectations) {
    const fail = (msg: string) => failures.push(msg)
    switch (e.kind) {
      case 'led_on':
      case 'led_off':
      case 'led_blinks': {
        if (typeOf.get(e.target) !== 'led') {
          fail(`${e.kind} targets "${e.target}", which is not an led component in this circuit`)
          break
        }
        const stats = ledStats(ledSeries.get(e.target) ?? [])
        const pct = Math.round(stats.onFraction * 100)
        if (e.kind === 'led_off') {
          if (stats.max >= LED_ON) {
            fail(
              `LED ${e.target}: expected off, measured peak brightness ${stats.max.toFixed(2)} ` +
                `(on for ${pct}% of the ${window.toFixed(1)}s window) — it lights without any user interaction`,
            )
          }
        } else if (e.kind === 'led_on') {
          if (!(stats.onFraction >= 0.95 && stats.finalOn)) {
            const dark = stats.max < LED_OFF
            fail(
              `LED ${e.target}: expected steadily on, measured brightness ${stats.min.toFixed(2)}–${stats.max.toFixed(2)} ` +
                `(on for ${pct}% of ${window.toFixed(1)}s)` +
                (dark
                  ? `${ledPinHint(e.target)} — the LED never lit; check its series resistor and the wiring to the rails`
                  : ''),
            )
          }
        } else {
          const minHz = e.minHz ?? DEFAULT_MIN_HZ
          const maxHz = e.maxHz
          const freq = stats.transitions / window
          const ok =
            stats.transitions >= 2 && freq >= minHz && (maxHz === undefined || freq <= maxHz)
          if (!ok) {
            let detail = `; brightness ${stats.min.toFixed(2)}–${stats.max.toFixed(2)}`
            if (stats.max < LED_OFF) {
              detail =
                `; brightness stayed ${stats.max.toFixed(2)}${ledPinHint(e.target)}` +
                ' — the LED never lit; likely a missing wire or series resistor between its net and the driving pin/rail'
            } else if (stats.transitions === 0 && stats.min > LED_OFF) {
              detail += ' — the LED stayed on and never blinked off'
            }
            fail(
              `LED ${e.target}: expected blinking ${fmtHzRange(e.minHz, e.maxHz)}, ` +
                `measured ${stats.transitions} off→on transitions in ${window.toFixed(1)}s ` +
                `(${freq.toFixed(2)}Hz)${detail}`,
            )
          }
        }
        break
      }
      case 'segments_show': {
        if (typeOf.get(e.target) !== 'seven_segment') {
          fail(
            `segments_show targets "${e.target}", which is not a seven_segment component in this circuit`,
          )
          break
        }
        const digit = e.digit ?? ''
        if (!/^[0-9]$/.test(digit)) {
          fail(`segments_show for ${e.target}: digit must be "0"–"9" (got "${digit}")`)
          break
        }
        const bits = segmentBits(segLast.get(e.target) ?? {})
        if (!DIGIT_PATTERNS[Number(digit)].includes(bits)) {
          const reads = patternDigit(bits)
          fail(
            `display ${e.target}: expected digit ${digit}, measured lit segments "${litSegmentNames(bits)}"` +
              (reads >= 0 ? ` which reads as digit ${reads}` : ' which is not a valid digit') +
              ' — check the BCD inputs and segment wiring',
          )
        }
        break
      }
      case 'net_oscillates':
      case 'net_in_range': {
        const stats = netStats(netSeries.get(e.target) ?? [])
        if (!stats.valid) {
          fail(`${e.kind}: "${e.target}" is not a known hole/terminal ref — nothing to measure`)
          break
        }
        if (e.kind === 'net_oscillates') {
          const minHz = e.minHz ?? DEFAULT_MIN_HZ
          const maxHz = e.maxHz
          const freq = stats.crossings / window
          const ok = stats.crossings >= 2 && freq >= minHz && (maxHz === undefined || freq <= maxHz)
          if (!ok) {
            fail(
              `net ${e.target}: expected oscillation at ${fmtHzRange(e.minHz, e.maxHz)}, ` +
                `measured ${stats.crossings} rising crossings in ${window.toFixed(1)}s (${freq.toFixed(2)}Hz), ` +
                `voltage range ${stats.min.toFixed(2)}V to ${stats.max.toFixed(2)}V` +
                (stats.max - stats.min < MIN_SWING_V ? ' — the net is essentially static' : ''),
            )
          }
        } else {
          const lo = e.minV ?? -Infinity
          const hi = e.maxV ?? Infinity
          if (!(stats.min >= lo && stats.max <= hi)) {
            fail(
              `net ${e.target}: expected to stay within ${lo}V to ${hi}V, ` +
                `measured ${stats.min.toFixed(2)}V to ${stats.max.toFixed(2)}V over ${window.toFixed(1)}s`,
            )
          }
        }
        break
      }
      case 'buzzer_sounds': {
        if (typeOf.get(e.target) !== 'buzzer') {
          fail(`buzzer_sounds targets "${e.target}", which is not a buzzer component in this circuit`)
          break
        }
        const onCount = buzzerOnCount.get(e.target) ?? 0
        if (onCount === 0) {
          const peak = buzzerPeakV.get(e.target) ?? 0
          fail(
            `buzzer ${e.target}: expected to sound, but it never did in ${window.toFixed(1)}s ` +
              `(peak ${peak.toFixed(2)}V across its pins — it needs more than 1V)`,
          )
        }
        break
      }
    }
  }

  // ---- health checks (always run)
  const health: string[] = []
  for (const issue of engine.issues) {
    if (issue.level === 'error') health.push(`engine error: ${issue.message}`)
    else if (isSeriousWarning(issue.message)) health.push(`engine warning: ${issue.message}`)
  }

  return { pass: failures.length === 0 && health.length === 0, failures, health }
}

// ------------------------------------------------------------ async wrapper

export interface RunVerificationOptions {
  signal?: AbortSignal
}

function cancelError(): Error {
  return new Error('Verification cancelled.')
}

/**
 * Run verifyCircuit off the main thread (module Worker) so the UI never
 * freezes; falls back to a direct call when Workers are unavailable (node,
 * tests) or worker construction fails (CSP). Aborting the signal terminates
 * an in-flight worker immediately.
 */
export function runVerification(
  layout: CircuitLayout,
  expectations: Expectation[],
  opts: RunVerificationOptions = {},
): Promise<VerifyResult> {
  const { signal } = opts
  if (signal?.aborted) return Promise.reject(cancelError())

  if (typeof Worker === 'undefined') {
    return new Promise((resolve, reject) => {
      try {
        resolve(verifyCircuit(layout, expectations))
      } catch (err) {
        reject(err instanceof Error ? err : new Error(String(err)))
      }
    })
  }

  let worker: Worker
  try {
    worker = new Worker(new URL('./verify.worker.ts', import.meta.url), { type: 'module' })
  } catch {
    // worker construction blocked (CSP, exotic embedder) — degrade gracefully
    return Promise.resolve().then(() => verifyCircuit(layout, expectations))
  }

  return new Promise<VerifyResult>((resolve, reject) => {
    let settled = false
    const finish = (fn: () => void) => {
      if (settled) return
      settled = true
      signal?.removeEventListener('abort', onAbort)
      worker.terminate()
      fn()
    }
    const onAbort = () => finish(() => reject(cancelError()))
    signal?.addEventListener('abort', onAbort)
    worker.onmessage = (e: MessageEvent<VerifyReply>) => {
      const data = e.data
      if (data && data.ok === true) finish(() => resolve(data.result))
      else {
        finish(() =>
          reject(new Error(data && data.ok === false ? data.error : 'verification failed in the worker')),
        )
      }
    }
    worker.onerror = (e: ErrorEvent) => {
      finish(() => reject(new Error(`verification worker error: ${e.message || 'unknown error'}`)))
    }
    const request: VerifyRequest = { layout, expectations }
    worker.postMessage(request)
  })
}
