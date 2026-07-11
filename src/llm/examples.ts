/**
 * Worked example layouts embedded in the LLM system prompt.
 * Both MUST pass validateLayout() with zero errors — hole assignments were
 * checked by hand against the DIP rule (pin 1 in row f, pins 1..N/2 along f,
 * N/2+1..N back along e) and the one-lead-per-hole occupancy rule.
 */

import type { CircuitLayout } from '../model/types'

/**
 * Example A — "button LED".
 *
 * Pushbutton SW1 at f10 occupies f10 (A1), e10 (A2), f12 (B1), e12 (B2).
 * Current path: PS+ → bot+ rail → j10 (strip S10B, shared with A1 at f10)
 * → button (when pressed) → S12B (B1 at f12, R1 lead at j12) → R1 → S16B
 * → LED → S20B → j20 → bot- rail → PS−.
 */
const BUTTON_LED: CircuitLayout = {
  version: 1,
  name: 'Button LED',
  description:
    'A 5V supply feeds the bottom power rails. Pressing the tactile button connects its A side (column 10) to its B side (column 12), letting current flow through the 470Ω series resistor and the red LED to ground. The resistor limits the LED current to a safe ~7mA.',
  components: [
    { id: 'PS1', type: 'power_supply', params: { voltage: 5 } },
    { id: 'SW1', type: 'pushbutton', at: 'f10' },
    { id: 'R1', type: 'resistor', params: { resistance: 470 }, holes: ['j12', 'j16'] },
    { id: 'D1', type: 'led', params: { color: 'red' }, holes: ['i16', 'i20'] },
  ],
  wires: [
    { id: 'w1', from: 'PS1:+', to: 'bot+0', color: 'red' },
    { id: 'w2', from: 'PS1:-', to: 'bot-0', color: 'black' },
    { id: 'w3', from: 'bot+1', to: 'j10', color: 'red' },
    { id: 'w4', from: 'j20', to: 'bot-1', color: 'black' },
  ],
}

/**
 * Example B — "555 blinker at ~1 Hz" (astable, per the NE555 catalog doc).
 *
 * NE555 U1 at f20 (DIP-8): GND=f20, TRIG=f21, OUT=f22, RESET=f23,
 * CTRL=e23, THRES=e22, DISCH=e21, VCC=e20.
 *
 * R_A (10k) VCC→DISCH: b20→b21 (S20T→S21T).
 * R_B (68k) DISCH→THRES: c21→c22 (S21T→S22T).
 * C (10µF) THRES→GND: d22→top-6.
 * TRIG tied to THRES: j21 (S21B) → b22 (S22T).
 * f ≈ 1.44 / ((R_A + 2·R_B)·C) = 1.44 / ((10k + 136k)·10µ) ≈ 0.99 Hz.
 * OUT (S22B) drives the LED through a 330Ω resistor.
 */
const BLINKER_555: CircuitLayout = {
  version: 1,
  name: '555 LED blinker (~1 Hz)',
  description:
    'A classic NE555 astable oscillator. R_A (10kΩ) and R_B (68kΩ) charge the 10µF capacitor toward VCC; the 555 discharges it through DISCH, producing a square wave at OUT of about 1Hz (f ≈ 1.44/((R_A+2R_B)·C)). OUT drives the red LED through a 330Ω series resistor. RESET is tied to VCC so the timer free-runs.',
  components: [
    { id: 'PS1', type: 'power_supply', params: { voltage: 5 } },
    { id: 'U1', type: 'ne555', at: 'f20' },
    { id: 'R1', type: 'resistor', params: { resistance: 10000 }, holes: ['b20', 'b21'] },
    { id: 'R2', type: 'resistor', params: { resistance: 68000 }, holes: ['c21', 'c22'] },
    {
      id: 'C1',
      type: 'capacitor',
      params: { capacitance: 1e-5, polarized: true },
      holes: ['d22', 'top-6'],
    },
    { id: 'R3', type: 'resistor', params: { resistance: 330 }, holes: ['j22', 'j26'] },
    { id: 'D1', type: 'led', params: { color: 'red' }, holes: ['i26', 'i30'] },
  ],
  wires: [
    { id: 'w1', from: 'PS1:+', to: 'top+0', color: 'red' },
    { id: 'w2', from: 'PS1:-', to: 'top-0', color: 'black' },
    { id: 'w3', from: 'a20', to: 'top+3', color: 'red' },
    { id: 'w4', from: 'j20', to: 'top-3', color: 'black' },
    { id: 'w5', from: 'j23', to: 'top+5', color: 'red' },
    { id: 'w6', from: 'j21', to: 'b22', color: 'yellow' },
    { id: 'w7', from: 'j30', to: 'top-8', color: 'black' },
  ],
}

export const FEW_SHOT_EXAMPLES: CircuitLayout[] = [BUTTON_LED, BLINKER_555]

/** The user request each worked example answers, by index. */
export const FEW_SHOT_REQUESTS: string[] = [
  'Wire a pushbutton that lights an LED while it is pressed.',
  'Make an LED blink about once per second using a 555 timer.',
]
