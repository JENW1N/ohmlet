/**
 * 74xx combinational gates:
 *   sn7400 quad 2-input NAND · sn7404 hex inverter · sn7408 quad AND
 *   sn7432 quad OR · sn7486 quad XOR
 *
 * Pinouts verified against the TI datasheets (arrays in src/model/catalog.ts):
 *   7400/08/32/86 (DIP-14): 1A 1B 1Y 2A 2B 2Y GND 3Y 3A 3B 4Y 4A 4B VCC
 *   7404 (DIP-14):          1A 1Y 2A 2Y 3A 3Y GND 4Y 4A 5Y 5A 6Y 6A VCC
 *
 * Model: pure combinational logic, re-evaluated every sim step.
 *  - Inputs are compared against 0.5·VDD (VDD = voltage on the VCC pin).
 *  - Floating/unconnected inputs read LOW — a documented simplification
 *    (real TTL inputs float high).
 *  - Outputs are push-pull Norton drives: {VDD or 0, 50Ω}.
 *  - If VCC reads below MIN_SUPPLY the chip is unpowered: every output is
 *    released (high-impedance) and internal state is left untouched.
 */

import type { ComponentInstance } from '../../model/types'
import {
  registerChip,
  supplyOf,
  readLogic,
  driveLogic,
  MIN_SUPPLY,
  type ChipInstance,
  type ChipStepCtx,
} from '../chip-api'

type Gate2 = (a: boolean, b: boolean) => boolean

const QUAD_UNITS = [1, 2, 3, 4] as const
const HEX_UNITS = [1, 2, 3, 4, 5, 6] as const

/** Register a quad 2-input gate (7400-style pin naming: nA, nB → nY). */
function registerQuadGate(model: string, op: Gate2): void {
  registerChip(model, (comp: ComponentInstance): ChipInstance => {
    const levels: Record<string, boolean> = {}
    return {
      comp,
      step(ctx: ChipStepCtx): void {
        const vdd = supplyOf(ctx, 'VCC')
        if (vdd < MIN_SUPPLY) {
          for (const n of QUAD_UNITS) ctx.drivePin(`${n}Y`, null)
          return
        }
        for (const n of QUAD_UNITS) {
          const a = readLogic(ctx, `${n}A`, vdd)
          const b = readLogic(ctx, `${n}B`, vdd)
          const y = op(a, b)
          levels[`${n}Y`] = y
          driveLogic(ctx, `${n}Y`, y, vdd)
        }
      },
      outputs(): Record<string, boolean> {
        return { ...levels }
      },
    }
  })
}

registerQuadGate('sn7400', (a, b) => !(a && b)) // NAND
registerQuadGate('sn7408', (a, b) => a && b) // AND
registerQuadGate('sn7432', (a, b) => a || b) // OR
registerQuadGate('sn7486', (a, b) => a !== b) // XOR

// sn7404 hex inverter: nY = NOT nA
registerChip('sn7404', (comp: ComponentInstance): ChipInstance => {
  const levels: Record<string, boolean> = {}
  return {
    comp,
    step(ctx: ChipStepCtx): void {
      const vdd = supplyOf(ctx, 'VCC')
      if (vdd < MIN_SUPPLY) {
        for (const n of HEX_UNITS) ctx.drivePin(`${n}Y`, null)
        return
      }
      for (const n of HEX_UNITS) {
        const y = !readLogic(ctx, `${n}A`, vdd)
        levels[`${n}Y`] = y
        driveLogic(ctx, `${n}Y`, y, vdd)
      }
    },
    outputs(): Record<string, boolean> {
      return { ...levels }
    },
  }
})
