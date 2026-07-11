/**
 * sn7474 — dual D-type positive-edge-triggered flip-flop with asynchronous
 * preset and clear (TI SN7474, DIP-14).
 *
 * Pinout verified against the TI datasheet (array in src/model/catalog.ts):
 *   1CLR 1D 1CLK 1PRE 1Q 1QN GND 2QN 2Q 2PRE 2CLK 2D 2CLR VCC
 *
 * Model:
 *  - Rising edge on nCLK (previous clock level tracked per unit) latches nD
 *    into Q. Q and QN are driven push-pull every step.
 *  - nCLR low → Q = 0; nPRE low → Q = 1. Both are asynchronous and override
 *    the clock. Both low simultaneously is unstable on the real part (it
 *    forces Q = QN = high); we simply prioritize CLR.
 *  - Floating/unconnected inputs read LOW (documented simplification), so
 *    CLR and PRE must be tied to VCC when unused — exactly what the catalog
 *    doc instructs.
 *  - VCC below MIN_SUPPLY: Q/QN are released and state is left untouched.
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

interface FFUnit {
  n: 1 | 2
  q: boolean
  prevClk: boolean
}

registerChip('sn7474', (comp: ComponentInstance): ChipInstance => {
  const units: FFUnit[] = [
    { n: 1, q: false, prevClk: false },
    { n: 2, q: false, prevClk: false },
  ]
  const levels: Record<string, boolean> = {}
  return {
    comp,
    step(ctx: ChipStepCtx): void {
      const vdd = supplyOf(ctx, 'VCC')
      if (vdd < MIN_SUPPLY) {
        for (const u of units) {
          ctx.drivePin(`${u.n}Q`, null)
          ctx.drivePin(`${u.n}QN`, null)
        }
        return
      }
      for (const u of units) {
        const clrLow = !readLogic(ctx, `${u.n}CLR`, vdd) // active low
        const preLow = !readLogic(ctx, `${u.n}PRE`, vdd) // active low
        const clk = readLogic(ctx, `${u.n}CLK`, vdd)
        const rising = clk && !u.prevClk
        u.prevClk = clk
        if (clrLow) {
          u.q = false // CLR dominates (also covers the CLR+PRE-both-low case)
        } else if (preLow) {
          u.q = true
        } else if (rising) {
          u.q = readLogic(ctx, `${u.n}D`, vdd)
        }
        levels[`${u.n}Q`] = u.q
        levels[`${u.n}QN`] = !u.q
        driveLogic(ctx, `${u.n}Q`, u.q, vdd)
        driveLogic(ctx, `${u.n}QN`, !u.q, vdd)
      }
    },
    outputs(): Record<string, boolean> {
      return { ...levels }
    },
  }
})
