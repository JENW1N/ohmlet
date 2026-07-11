/**
 * Behavioral counter ICs — CD4017, CD4040, SN74193.
 * OWNED BY THE chips-B AGENT. Self-registers via registerChip (side-effect
 * import from src/sim/chips/all-b.ts).
 *
 * Pinouts and behavior verified against TI datasheets:
 *  - CD4017B  (SCHS027): Johnson decade counter, rising-edge clock gated by
 *    CLOCK INHIBIT, async active-high RESET, CARRY OUT high for counts 0-4.
 *  - CD4040B  (SCHS030D terminal assignment: 1 Q12, 2 Q6, 3 Q5, 4 Q7, 5 Q4,
 *    6 Q3, 7 Q2, 8 VSS, 9 Q1, 10 CLK, 11 RST, 12 Q9, 13 Q8, 14 Q10, 15 Q11,
 *    16 VDD): 12-stage ripple counter advancing on the FALLING clock edge,
 *    async active-high RESET.
 *  - SN74193  (SDLS074): presettable 4-bit binary up/down counter with dual
 *    clocks, async active-low LOAD, async active-high CLR (independent of
 *    load), combinational active-low CARRY (count 15 & UP low) and BORROW
 *    (count 0 & DOWN low) for cascading.
 */

import type { ComponentInstance } from '../../model/types'
import {
  MIN_SUPPLY,
  driveLogic,
  readLogic,
  registerChip,
  supplyOf,
  type ChipInstance,
  type ChipStepCtx,
} from '../chip-api'

// --------------------------------------------------------------- CD4017

const CD4017_Q = ['Q0', 'Q1', 'Q2', 'Q3', 'Q4', 'Q5', 'Q6', 'Q7', 'Q8', 'Q9']

registerChip('cd4017', (comp: ComponentInstance): ChipInstance => {
  let count = 0
  let lastClk = false
  /** false until the clock has been sampled at least once while powered —
   * prevents a phantom edge on power-up when CLK idles high. */
  let primed = false
  const out: Record<string, boolean> = { CO: false }
  for (const q of CD4017_Q) out[q] = false

  return {
    comp,
    step(ctx: ChipStepCtx): void {
      const vdd = supplyOf(ctx, 'VDD')
      if (vdd < MIN_SUPPLY) {
        count = 0
        lastClk = false
        primed = false
        for (const q of CD4017_Q) {
          out[q] = false
          ctx.drivePin(q, null)
        }
        out.CO = false
        ctx.drivePin('CO', null)
        return
      }

      const clk = readLogic(ctx, 'CLK', vdd)
      const inh = readLogic(ctx, 'INH', vdd)
      const rst = readLogic(ctx, 'RST', vdd)

      if (rst) {
        count = 0 // async reset dominates the clock
      } else if (primed && clk && !lastClk && !inh) {
        count = (count + 1) % 10
      }
      lastClk = clk
      primed = true

      for (let i = 0; i < 10; i++) {
        const hi = i === count
        out[CD4017_Q[i]] = hi
        driveLogic(ctx, CD4017_Q[i], hi, vdd)
      }
      // CARRY OUT: one cycle per 10 clocks — high during counts 0-4.
      const co = count < 5
      out.CO = co
      driveLogic(ctx, 'CO', co, vdd)
    },
    outputs(): Record<string, boolean> {
      return { ...out }
    },
  }
})

// --------------------------------------------------------------- CD4040

const CD4040_Q = ['Q1', 'Q2', 'Q3', 'Q4', 'Q5', 'Q6', 'Q7', 'Q8', 'Q9', 'Q10', 'Q11', 'Q12']

registerChip('cd4040', (comp: ComponentInstance): ChipInstance => {
  let count = 0
  let lastClk = false
  let primed = false
  const out: Record<string, boolean> = {}
  for (const q of CD4040_Q) out[q] = false

  return {
    comp,
    step(ctx: ChipStepCtx): void {
      const vdd = supplyOf(ctx, 'VDD')
      if (vdd < MIN_SUPPLY) {
        count = 0
        lastClk = false
        primed = false
        for (const q of CD4040_Q) {
          out[q] = false
          ctx.drivePin(q, null)
        }
        return
      }

      const clk = readLogic(ctx, 'CLK', vdd)
      const rst = readLogic(ctx, 'RST', vdd)

      if (rst) {
        count = 0 // async reset, independent of clock
      } else if (primed && !clk && lastClk) {
        // advances one count on the NEGATIVE clock transition
        count = (count + 1) & 0xfff
      }
      lastClk = clk
      primed = true

      for (let i = 0; i < 12; i++) {
        const hi = ((count >> i) & 1) === 1 // Qn = clock / 2^n
        out[CD4040_Q[i]] = hi
        driveLogic(ctx, CD4040_Q[i], hi, vdd)
      }
    },
    outputs(): Record<string, boolean> {
      return { ...out }
    },
  }
})

// -------------------------------------------------------------- SN74193

const SN74193_Q = ['QA', 'QB', 'QC', 'QD']

registerChip('sn74193', (comp: ComponentInstance): ChipInstance => {
  let count = 0
  let lastUp = false
  let lastDown = false
  let primed = false
  const out: Record<string, boolean> = {
    QA: false,
    QB: false,
    QC: false,
    QD: false,
    CO: true,
    BO: true,
  }

  return {
    comp,
    step(ctx: ChipStepCtx): void {
      const vcc = supplyOf(ctx, 'VCC')
      if (vcc < MIN_SUPPLY) {
        count = 0
        lastUp = false
        lastDown = false
        primed = false
        for (const q of SN74193_Q) {
          out[q] = false
          ctx.drivePin(q, null)
        }
        out.CO = false
        out.BO = false
        ctx.drivePin('CO', null)
        ctx.drivePin('BO', null)
        return
      }

      const up = readLogic(ctx, 'UP', vcc)
      const down = readLogic(ctx, 'DOWN', vcc)
      const clr = readLogic(ctx, 'CLR', vcc) // active high
      const loadN = readLogic(ctx, 'LOAD', vcc) // active low

      if (clr) {
        // async clear, dominates LOAD and the clocks
        count = 0
      } else if (!loadN) {
        // async load: outputs follow the data inputs while LOAD is low
        count =
          (readLogic(ctx, 'A', vcc) ? 1 : 0) |
          (readLogic(ctx, 'B', vcc) ? 2 : 0) |
          (readLogic(ctx, 'C', vcc) ? 4 : 0) |
          (readLogic(ctx, 'D', vcc) ? 8 : 0)
      } else if (primed) {
        // dual-clock counting: an edge counts only while the other clock is high
        if (up && !lastUp && down) count = (count + 1) & 0xf
        else if (down && !lastDown && up) count = (count - 1) & 0xf
      }
      lastUp = up
      lastDown = down
      primed = true

      for (let i = 0; i < 4; i++) {
        const hi = ((count >> i) & 1) === 1
        out[SN74193_Q[i]] = hi
        driveLogic(ctx, SN74193_Q[i], hi, vcc)
      }
      // CO (active low): pulses low while count = 15 and UP is in its low
      // half-cycle (mirrors the UP clock at terminal count). BO likewise at 0
      // for DOWN. Feed CO/BO to the next stage's UP/DOWN to cascade.
      const co = !(count === 15 && !up)
      const bo = !(count === 0 && !down)
      out.CO = co
      out.BO = bo
      driveLogic(ctx, 'CO', co, vcc)
      driveLogic(ctx, 'BO', bo, vcc)
    },
    outputs(): Record<string, boolean> {
      return { ...out }
    },
  }
})
