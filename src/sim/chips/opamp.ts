/**
 * lm358 — dual single-supply op-amp (DIP-8), two independent units.
 *
 * Pinout verified against the TI datasheet (array in src/model/catalog.ts):
 *   1 OUT1 · 2 IN1− · 3 IN1+ · 4 GND · 5 IN2+ · 6 IN2− · 7 OUT2 · 8 VCC
 *
 * Behavioral model per unit:
 *  - Open-loop target = clamp(1e5·(V+ − V−), 0.02, VCC − 1.2): gain 100k,
 *    output swings from ~20mV above ground up to ~VCC−1.2V (real LM358).
 *  - The driven output moves toward that target, slew-limited to 0.5 V/µs
 *    (max delta = 0.5e6·dt volts per step), and is driven with rout = 50Ω.
 *  - Stability with external feedback: chips read pin voltages from the
 *    PREVIOUS solve, so a feedback wire (e.g. unity-gain follower OUT→IN−)
 *    arrives one step late and a naive jump to the open-loop target would
 *    bang the output rail-to-rail every step. Instead the model estimates
 *    the external feedback gain h = dV−/dVout from the observed response to
 *    its own previous move (secant), and steps toward the closed-loop fixed
 *    point x solving x = A·(V+ − V− − h·(x − Vout)). With no feedback
 *    (h = 0, comparator) this reduces exactly to the open-loop target and
 *    the output slews rail-to-rail at full speed; with negative feedback it
 *    converges onto the closed-loop operating point in a couple of steps.
 *    Positive feedback estimates clamp to h = 0, which yields the correct
 *    bang-bang Schmitt-trigger behavior.
 *  - Robustness: the fast (1-step) gain estimate is low-pass filtered (V−
 *    also moves when other circuit nodes change, which would corrupt a raw
 *    secant), a slow 8-step-baseline estimate sees through moderately lagged
 *    feedback, and the per-step move is additionally bounded by an adaptive
 *    step size that halves whenever the error changes sign (oscillation
 *    detected) and grows while it persists. Loops with a large feedback lag
 *    (e.g. a 250µs RC inside the loop) oscillate around the correct mean —
 *    which mirrors the real part: such loops have ~no phase margin and
 *    genuinely ring on a breadboard.
 *  - Floating/unconnected inputs read 0V (documented simplification).
 *  - VCC below MIN_SUPPLY: both outputs released, state untouched.
 */

import type { ComponentInstance } from '../../model/types'
import {
  registerChip,
  supplyOf,
  MIN_SUPPLY,
  PUSH_PULL_ROUT,
  type ChipInstance,
  type ChipStepCtx,
} from '../chip-api'

/** Open-loop voltage gain. */
const A_OL = 1e5
/** Slew rate in V/s (0.5 V/µs). */
const SLEW_RATE = 0.5e6
/** Output saturates this close to ground (single-supply LM358 reaches ~20mV). */
const V_OUT_LOW = 0.02
/** Output saturates this far below VCC. */
const V_OUT_DROP = 1.2
/** Smallest output move considered usable for the feedback (secant) estimate. */
const MIN_DV = 1e-7
/** Upper clamp for the estimated feedback gain. */
const H_MAX = 100
/** Low-pass mixing factor for new feedback-gain estimates. */
const H_MIX = 0.5
/** Baseline length (steps) of the slow secant that sees through feedback lag. */
const SLOW_LAG = 8
/** Adaptive step bound: floor (V), growth and shrink factors. */
const DELTA_MIN = 0.05
const DELTA_GROW = 1.5
const DELTA_SHRINK = 0.5

interface OpUnit {
  out: string
  inp: string
  inm: string
  /** currently driven output voltage */
  vout: number
  /** output voltage driven on the previous step (for the secant estimate) */
  prevVout: number
  /** V− observed on the previous step (NaN until first step) */
  prevVm: number
  /** estimated external feedback gain dV−/dVout (0 = open loop) */
  h: number
  /** slow-baseline feedback gain estimate (sees through lagged feedback) */
  hSlow: number
  /** ring buffers of past (vout, vm) pairs for the slow secant */
  histVout: number[]
  histVm: number[]
  histIdx: number
  histFill: number
  /** adaptive per-step move bound (anti-oscillation) */
  delta: number
  /** sign of the error on the previous step (−1, 0, +1) */
  lastSign: number
}

function readVolt(ctx: ChipStepCtx, pin: string): number {
  const v = ctx.readPin(pin)
  return Number.isNaN(v) ? 0 : v
}

registerChip('lm358', (comp: ComponentInstance): ChipInstance => {
  const mkUnit = (n: 1 | 2): OpUnit => ({
    out: `OUT${n}`,
    inp: `IN${n}+`,
    inm: `IN${n}-`,
    vout: V_OUT_LOW,
    prevVout: V_OUT_LOW,
    prevVm: NaN,
    h: 0,
    hSlow: 0,
    histVout: new Array<number>(SLOW_LAG).fill(V_OUT_LOW),
    histVm: new Array<number>(SLOW_LAG).fill(0),
    histIdx: 0,
    histFill: 0,
    delta: 1,
    lastSign: 0,
  })
  const units: OpUnit[] = [mkUnit(1), mkUnit(2)]
  const levels: Record<string, boolean> = {}
  return {
    comp,
    step(ctx: ChipStepCtx): void {
      const vcc = supplyOf(ctx, 'VCC')
      if (vcc < MIN_SUPPLY) {
        for (const u of units) ctx.drivePin(u.out, null)
        return
      }
      const lo = V_OUT_LOW
      const hi = Math.max(vcc - V_OUT_DROP, lo)
      const slewMax = SLEW_RATE * ctx.dt
      for (const u of units) {
        const vp = readVolt(ctx, u.inp)
        const vm = readVolt(ctx, u.inm)
        // Re-estimate the external feedback gain from how V− responded to
        // our previous output move (secant), low-pass filtered because V−
        // also moves when other circuit nodes change. Keep the old estimate
        // when the output barely moved (no information).
        const dvo = u.vout - u.prevVout
        if (!Number.isNaN(u.prevVm) && Math.abs(dvo) > MIN_DV) {
          const raw = (vm - u.prevVm) / dvo
          const est = raw > 0 ? Math.min(raw, H_MAX) : 0
          u.h += H_MIX * (est - u.h)
        }
        // Slow secant over a SLOW_LAG-step baseline: lagged (RC-filtered)
        // feedback barely responds within one step but shows up here.
        if (u.histFill >= SLOW_LAG) {
          const oldVout = u.histVout[u.histIdx]
          const oldVm = u.histVm[u.histIdx]
          const dvoS = u.vout - oldVout
          if (Math.abs(dvoS) > MIN_DV) {
            const raw = (vm - oldVm) / dvoS
            u.hSlow = raw > 0 ? Math.min(raw, H_MAX) : 0
          }
        }
        u.histVout[u.histIdx] = u.vout
        u.histVm[u.histIdx] = vm
        u.histIdx = (u.histIdx + 1) % SLOW_LAG
        if (u.histFill < SLOW_LAG) u.histFill++
        const h = Math.max(u.h, u.hSlow)
        // Closed-loop fixed point of x = A·(vp − vm − h·(x − vout));
        // h = 0 reduces this to the open-loop target A·(vp − vm).
        const x = (A_OL * (vp - vm) + A_OL * h * u.vout) / (1 + A_OL * h)
        const target = Math.min(Math.max(x, lo), hi)
        const err = target - u.vout
        // Adaptive anti-oscillation bound on top of the slew limit.
        const sign = err > 0 ? 1 : err < 0 ? -1 : 0
        if (sign !== 0) {
          if (u.lastSign !== 0 && sign !== u.lastSign) {
            u.delta = Math.max(u.delta * DELTA_SHRINK, DELTA_MIN)
          } else {
            u.delta = Math.min(u.delta * DELTA_GROW, slewMax)
          }
          u.lastSign = sign
        }
        const move = sign * Math.min(Math.abs(err), u.delta, slewMax)
        u.prevVout = u.vout
        u.prevVm = vm
        u.vout = Math.min(Math.max(u.vout + move, lo), hi)
        ctx.drivePin(u.out, { v: u.vout, rout: PUSH_PULL_ROUT })
        levels[u.out] = u.vout > 0.5 * vcc
      }
    },
    outputs(): Record<string, boolean> {
      return { ...levels }
    },
  }
})
