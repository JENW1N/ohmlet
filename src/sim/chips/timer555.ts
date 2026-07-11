/**
 * ne555 — classic bipolar 555 timer (DIP-8).
 *
 * Pinout verified against the TI/ST datasheets (array in src/model/catalog.ts):
 *   1 GND · 2 TRIG · 3 OUT · 4 RESET · 5 CTRL · 6 THRES · 7 DISCH · 8 VCC
 *
 * Model — internal RS latch plus two comparators:
 *  - Reference Vref defaults to 2/3·VCC. The chip stamps its internal
 *    5k-5k-5k divider on CTRL as a Thevenin {2/3·VCC, ~3.33kΩ}, so the
 *    common "10nF bypass cap on pin 5" hookup settles at the right voltage.
 *    If CTRL reads more than 0.2V away from 2/3·VCC (i.e. it is being driven
 *    externally, or a bypass cap is still charging) the measured CTRL
 *    voltage becomes Vref. The trigger reference is always Vref/2.
 *  - Trigger comparator: TRIG < Vref/2 SETS the latch (output high). It
 *    dominates the threshold comparator, as in the real part.
 *  - Threshold comparator: THRES > Vref RESETS the latch (output low).
 *  - RESET (pin 4) is asynchronous, active low (datasheet threshold ~0.7V)
 *    and dominates both comparators. A truly unconnected RESET pin is
 *    treated as inactive so a forgetful hookup still runs.
 *  - OUT is a strong push-pull stage: {VCC−0.5, 10Ω} high / {0.1V, 10Ω} low.
 *  - DISCH is open drain: conducting {0V, 25Ω} while the latch is low,
 *    released while the latch is high.
 *  - VCC below MIN_SUPPLY: every pin released, latch state untouched.
 *
 * Astable (R_A: VCC→DISCH, R_B: DISCH→THRES=TRIG, C: THRES→GND) oscillates
 * at f ≈ 1.44/((R_A+2·R_B)·C); monostable pulses for t ≈ 1.1·R·C.
 */

import type { ComponentInstance } from '../../model/types'
import {
  registerChip,
  supplyOf,
  MIN_SUPPLY,
  OPEN_DRAIN_ROUT,
  type ChipInstance,
  type ChipStepCtx,
} from '../chip-api'

/** Thevenin resistance of the internal 5k/5k/5k divider seen from CTRL (5k ∥ 10k). */
const CTRL_ROUT = 3333
/** RESET pin threshold (datasheet: 0.4–1.0V, typ 0.7V). */
const RESET_THRESHOLD = 0.7
/** Strong output stage resistance (Ω). */
const OUT_ROUT = 10

registerChip('ne555', (comp: ComponentInstance): ChipInstance => {
  let latch = false // true = output high, discharge released
  return {
    comp,
    step(ctx: ChipStepCtx): void {
      const vcc = supplyOf(ctx, 'VCC')
      if (vcc < MIN_SUPPLY) {
        ctx.drivePin('OUT', null)
        ctx.drivePin('DISCH', null)
        ctx.drivePin('CTRL', null)
        return
      }

      // Internal reference divider, always present on CTRL while powered.
      const twoThirds = (2 / 3) * vcc
      ctx.drivePin('CTRL', { v: twoThirds, rout: CTRL_ROUT })

      // Reference selection: use the measured CTRL voltage when it deviates
      // from the nominal 2/3·VCC by more than 0.2V.
      const vCtrl = ctx.readPin('CTRL')
      let vref = twoThirds
      if (!Number.isNaN(vCtrl) && Math.abs(vCtrl - twoThirds) > 0.2) vref = vCtrl

      // Async reset (active low) dominates the comparators.
      const vReset = ctx.readPin('RESET')
      const resetAsserted = !Number.isNaN(vReset) && vReset < RESET_THRESHOLD

      const vTrig = ctx.readPin('TRIG')
      const vThres = ctx.readPin('THRES')

      if (resetAsserted) {
        latch = false
      } else if (!Number.isNaN(vTrig) && vTrig < vref / 2) {
        latch = true // trigger comparator sets (dominates threshold)
      } else if (!Number.isNaN(vThres) && vThres > vref) {
        latch = false // threshold comparator resets
      }

      ctx.drivePin(
        'OUT',
        latch ? { v: Math.max(vcc - 0.5, 0), rout: OUT_ROUT } : { v: 0.1, rout: OUT_ROUT },
      )
      // Open-drain discharge transistor: on while the latch is low.
      ctx.drivePin('DISCH', latch ? null : { v: 0, rout: OPEN_DRAIN_ROUT })
    },
    outputs(): Record<string, boolean> {
      // DISCH reported as "high" when released (not sinking current).
      return { OUT: latch, DISCH: latch }
    },
  }
})
