/**
 * Behavioral 7-segment display drivers — CD4026, CD4511.
 * OWNED BY THE chips-B AGENT. Self-registers via registerChip (side-effect
 * import from src/sim/chips/all-b.ts).
 *
 * Pinouts and behavior verified against TI datasheets:
 *  - CD4026B (SCHS031B): decade counter with decoded 7-segment outputs.
 *    Terminal assignment: 1 CLK, 2 INH, 3 DEI, 4 DEO, 5 CO, 6 f, 7 g, 8 VSS,
 *    9 d, 10 a, 11 e, 12 b, 13 c, 14 UCS, 15 RST, 16 VDD. The timing diagram
 *    (Fig. 3) shows digit 6 WITH its tail (segment a lit) and 9 WITH its tail
 *    (segment d lit); CO is high for counts 0-4; UCS is low only at count 2;
 *    segment outputs are forced low while DISPLAY ENABLE IN is low, but CO
 *    and UCS are not gated; DEO is a buffered copy of DEI.
 *  - CD4511B (SCHS063): BCD-to-7-segment latch/decoder/driver. 1 B, 2 C,
 *    3 ~LT, 4 ~BL, 5 LE, 6 D, 7 A, 8 VSS, 9 e, 10 d, 11 c, 12 b, 13 a, 14 g,
 *    15 f, 16 VDD. Truth table: LE low = transparent, LE high = latched;
 *    ~LT low lights all segments (overrides ~BL); ~BL low blanks; BCD > 9
 *    blanks. Its font shows 6 and 9 WITHOUT tails (6 = cdefg, 9 = abcfg).
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

/** Segment bit order used by the font tables below: bit0=a ... bit6=g. */
const SEG_BITS = 7

// --------------------------------------------------------------- CD4026

/** Catalog pin names of the gated segment outputs, in a..g order. */
const CD4026_SEG_PINS = ['A', 'B', 'C', 'D', 'E', 'F', 'G']

/**
 * CD4026 font (datasheet Fig. 3): 6 with tail (a,c,d,e,f,g) and 9 with tail
 * (a,b,c,d,f,g).
 */
const CD4026_FONT = [0x3f, 0x06, 0x5b, 0x4f, 0x66, 0x6d, 0x7d, 0x07, 0x7f, 0x6f]

const CD4026_AUX = ['DEO', 'CO', 'UCS']

registerChip('cd4026', (comp: ComponentInstance): ChipInstance => {
  let count = 0
  let lastClk = false
  /** false until the clock has been sampled at least once while powered —
   * prevents a phantom edge on power-up when CLK idles high. */
  let primed = false
  const out: Record<string, boolean> = {}
  for (const p of CD4026_SEG_PINS) out[p] = false
  for (const p of CD4026_AUX) out[p] = false

  return {
    comp,
    step(ctx: ChipStepCtx): void {
      const vdd = supplyOf(ctx, 'VDD')
      if (vdd < MIN_SUPPLY) {
        count = 0
        lastClk = false
        primed = false
        for (const p of CD4026_SEG_PINS) {
          out[p] = false
          ctx.drivePin(p, null)
        }
        for (const p of CD4026_AUX) {
          out[p] = false
          ctx.drivePin(p, null)
        }
        return
      }

      const clk = readLogic(ctx, 'CLK', vdd)
      const inh = readLogic(ctx, 'INH', vdd)
      const rst = readLogic(ctx, 'RST', vdd)
      const dei = readLogic(ctx, 'DEI', vdd)

      if (rst) {
        count = 0 // async reset to zero count
      } else if (primed && clk && !lastClk && !inh) {
        count = (count + 1) % 10
      }
      lastClk = clk
      primed = true

      // Decoded segment outputs, forced low while DISPLAY ENABLE IN is low.
      const font = CD4026_FONT[count]
      for (let i = 0; i < SEG_BITS; i++) {
        const lit = dei && ((font >> i) & 1) === 1
        out[CD4026_SEG_PINS[i]] = lit
        driveLogic(ctx, CD4026_SEG_PINS[i], lit, vdd)
      }

      // DEO buffers DEI; CO (÷10, high for 0-4) and UCS (ungated c segment,
      // low only at count 2) are NOT gated by display enable.
      const deo = dei
      const co = count < 5
      const ucs = count !== 2
      out.DEO = deo
      out.CO = co
      out.UCS = ucs
      driveLogic(ctx, 'DEO', deo, vdd)
      driveLogic(ctx, 'CO', co, vdd)
      driveLogic(ctx, 'UCS', ucs, vdd)
    },
    outputs(): Record<string, boolean> {
      return { ...out }
    },
  }
})

// --------------------------------------------------------------- CD4511

/** Catalog pin names of the segment outputs, in a..g order. */
const CD4511_SEG_PINS = ['A_SEG', 'B_SEG', 'C_SEG', 'D_SEG', 'E_SEG', 'F_SEG', 'G_SEG']

/**
 * CD4511 font (datasheet truth table): 6 without tail (c,d,e,f,g) and 9
 * without tail (a,b,c,f,g). BCD codes 10-15 blank the display.
 */
const CD4511_FONT = [0x3f, 0x06, 0x5b, 0x4f, 0x66, 0x6d, 0x7c, 0x07, 0x7f, 0x67]

registerChip('cd4511', (comp: ComponentInstance): ChipInstance => {
  /** the 4-bit BCD value held in the input latch */
  let latched = 0
  const out: Record<string, boolean> = {}
  for (const p of CD4511_SEG_PINS) out[p] = false

  return {
    comp,
    step(ctx: ChipStepCtx): void {
      const vdd = supplyOf(ctx, 'VDD')
      if (vdd < MIN_SUPPLY) {
        latched = 0
        for (const p of CD4511_SEG_PINS) {
          out[p] = false
          ctx.drivePin(p, null)
        }
        return
      }

      const ltN = readLogic(ctx, 'LT', vdd) // lamp test, active LOW
      const blN = readLogic(ctx, 'BL', vdd) // blanking, active LOW
      const le = readLogic(ctx, 'LE', vdd) // latch enable: low = transparent

      // The input latch operates on LE regardless of LT/BL (those only
      // override the output stage).
      if (!le) {
        latched =
          (readLogic(ctx, 'A', vdd) ? 1 : 0) |
          (readLogic(ctx, 'B', vdd) ? 2 : 0) |
          (readLogic(ctx, 'C', vdd) ? 4 : 0) |
          (readLogic(ctx, 'D', vdd) ? 8 : 0)
      }

      let font: number
      if (!ltN) font = 0x7f // lamp test: all segments on (overrides BL)
      else if (!blN) font = 0 // blanked
      else font = latched <= 9 ? CD4511_FONT[latched] : 0 // BCD > 9 blanks

      for (let i = 0; i < SEG_BITS; i++) {
        const lit = ((font >> i) & 1) === 1
        out[CD4511_SEG_PINS[i]] = lit
        driveLogic(ctx, CD4511_SEG_PINS[i], lit, vdd)
      }
    },
    outputs(): Record<string, boolean> {
      return { ...out }
    },
  }
})
