/**
 * Component catalog: every part the simulator (and the LLM) can place.
 * CONTRACT FILE — chip pin arrays may be corrected by the owning chips agent
 * (verified against datasheets); everything else is fixed.
 *
 * Pin order in `pins` IS the package pin number (index 0 = pin 1) for 'dip'
 * and 'footprint' parts, and the order of `holes[]` for 'leads'/'probe' parts.
 */

import type { StripRow } from './types'

export type PlacementKind =
  | 'leads' // free 2/3-lead part: instance lists one HoleRef per pin in `holes`
  | 'dip' // DIP package straddling the channel: instance gives pin-1 hole in `at` (row f)
  | 'footprint' // fixed multi-hole footprint (e.g. pushbutton): pin-1 hole in `at`
  | 'offboard' // instrument with terminals, not on the board (wire to "ID:PIN")
  | 'probe' // single-hole instrument probe

export type ComponentCategory =
  | 'passive'
  | 'semiconductor'
  | 'switch'
  | 'display'
  | 'ic'
  | 'power'
  | 'instrument'

/**
 * Plan-rect the molded BODY of a part covers, for occlusion checks
 * (src/model/occlusion.ts): a hole under the body that is not one of the
 * part's own pin holes must stay completely empty — no other component pin
 * and no wire end may plug into it. The rects mirror the rendered meshes
 * (a hole counts as covered when the body crosses its center in plan view).
 *
 * Interpretation by placement kind:
 *  - 'dip' / 'footprint' (anchored, row-pinned): `dCols` is the inclusive
 *    column range covered relative to the `at` anchor column, and `rows`
 *    lists the absolute strip rows covered (exact, because these anchors are
 *    pinned to fixed rows). Rotation re-maps the rect together with the pins.
 *  - 'leads' (free parts, e.g. the potentiometer): the rect floats with the
 *    pins — `dCols` is the column overhang beyond the leftmost/rightmost pin
 *    column ([-1, 1] = one extra column each side), and `rows` is a window
 *    RE-CENTERED on the pins' rows: its extent each side of its middle letter
 *    is the rows of overhang above/below the pin rows (['e','f','g'] = one
 *    row each side).
 */
export type BodyFootprint = { dCols: [number, number]; rows: StripRow[] }

export interface ParamDef {
  key: string
  label: string
  kind: 'number' | 'select' | 'boolean' | 'text'
  default: number | string | boolean
  min?: number
  max?: number
  step?: number
  unit?: string
  options?: string[]
  /** runtime params are adjustable while the simulation runs (knobs, switches) */
  runtime?: boolean
}

export interface CatalogEntry {
  type: string
  label: string
  category: ComponentCategory
  placement: PlacementKind
  /** pin names; order = package pin number (dip/footprint) or holes[] order (leads) */
  pins: string[]
  /** for placement 'footprint': hole offsets per pin, relative to the pin-1 anchor */
  footprintOffsets?: { dCol: number; row: StripRow }[]
  /** pin-name pairs permanently connected inside the part (merged in the netlist) */
  internalBridges?: [string, string][]
  /**
   * Plan-rect the molded body covers, for occlusion (see BodyFootprint).
   * 'auto' = the bounding box of the pin holes (a body that covers exactly
   * its pin rect, like a plain DIP package). Absent = the body covers nothing
   * beyond its own pin holes (thin leaded parts the router can stand up).
   */
  bodyFootprint?: BodyFootprint | 'auto'
  params?: ParamDef[]
  sim:
    | { kind: 'device'; model: string } // analog model in src/sim/devices.ts
    | { kind: 'chip'; model: string } // behavioral IC in src/sim/chips/*
    | { kind: 'probe' } // no electrical stamp
  /** rendering hints for src/three/component-meshes.ts (free to ignore) */
  visual?: { shape?: string; color?: string; body?: [number, number, number] }
  /** 1-3 sentence usage doc — embedded verbatim in the LLM system prompt */
  doc: string
}

const E = (e: CatalogEntry) => e

export const CATALOG: Record<string, CatalogEntry> = {
  // ----------------------------------------------------------- passives
  resistor: E({
    type: 'resistor',
    label: 'Resistor',
    category: 'passive',
    placement: 'leads',
    pins: ['p1', 'p2'],
    params: [
      { key: 'resistance', label: 'Resistance', kind: 'number', default: 1000, min: 0.1, max: 1e8, unit: 'Ω' },
    ],
    sim: { kind: 'device', model: 'resistor' },
    visual: { shape: 'resistor' },
    doc: 'Basic resistor. Two leads, place each lead in any hole. Always put 220Ω–1kΩ in series with every LED.',
  }),
  capacitor: E({
    type: 'capacitor',
    label: 'Capacitor',
    category: 'passive',
    placement: 'leads',
    pins: ['p1', 'p2'],
    params: [
      { key: 'capacitance', label: 'Capacitance', kind: 'number', default: 1e-5, min: 1e-12, max: 1, unit: 'F' },
      { key: 'polarized', label: 'Polarized (electrolytic)', kind: 'boolean', default: false },
    ],
    sim: { kind: 'device', model: 'capacitor' },
    visual: { shape: 'capacitor' },
    doc: 'Capacitor. For polarized (electrolytic) caps, p1 is +, p2 is −. Timing for a 555: t ≈ 1.1·R·C.',
  }),
  inductor: E({
    type: 'inductor',
    label: 'Inductor',
    category: 'passive',
    placement: 'leads',
    pins: ['p1', 'p2'],
    params: [
      { key: 'inductance', label: 'Inductance', kind: 'number', default: 0.01, min: 1e-9, max: 100, unit: 'H' },
    ],
    sim: { kind: 'device', model: 'inductor' },
    visual: { shape: 'inductor' },
    doc: 'Inductor (coil). Two leads.',
  }),
  potentiometer: E({
    type: 'potentiometer',
    label: 'Potentiometer',
    category: 'passive',
    placement: 'leads',
    pins: ['ccw', 'wiper', 'cw'],
    params: [
      { key: 'resistance', label: 'Total resistance', kind: 'number', default: 10000, min: 100, max: 1e6, unit: 'Ω' },
      { key: 'position', label: 'Position', kind: 'number', default: 0.5, min: 0, max: 1, step: 0.01, runtime: true },
    ],
    // wide square trimmer body (3296P-style): overhangs one column beyond each
    // outer lead and one row above/below the lead row — matches the rendered mesh
    bodyFootprint: { dCols: [-1, 1], rows: ['e', 'f', 'g'] },
    sim: { kind: 'device', model: 'potentiometer' },
    visual: { shape: 'pot' },
    doc: 'Potentiometer with 3 leads: ccw end, wiper, cw end. The user can turn the knob while the simulation runs. Its wide body overhangs neighboring holes (one column left/right of the outer leads, one row above/below) — leave those holes empty.',
  }),
  photoresistor: E({
    type: 'photoresistor',
    label: 'Photoresistor (LDR)',
    category: 'passive',
    placement: 'leads',
    pins: ['p1', 'p2'],
    params: [
      { key: 'light', label: 'Light level', kind: 'number', default: 0.5, min: 0, max: 1, step: 0.01, runtime: true },
    ],
    sim: { kind: 'device', model: 'photoresistor' },
    visual: { shape: 'ldr' },
    doc: 'Light-dependent resistor: ~200kΩ in the dark down to ~200Ω in bright light. The user can change the light level slider while simulating — great for night-light circuits.',
  }),

  // ------------------------------------------------------ semiconductors
  diode: E({
    type: 'diode',
    label: 'Diode (1N4148)',
    category: 'semiconductor',
    placement: 'leads',
    pins: ['anode', 'cathode'],
    sim: { kind: 'device', model: 'diode' },
    visual: { shape: 'diode' },
    doc: 'Small-signal silicon diode. Conducts anode→cathode with ~0.7V drop.',
  }),
  led: E({
    type: 'led',
    label: 'LED',
    category: 'semiconductor',
    placement: 'leads',
    pins: ['anode', 'cathode'],
    params: [
      { key: 'color', label: 'Color', kind: 'select', default: 'red', options: ['red', 'green', 'yellow', 'blue', 'white'] },
    ],
    sim: { kind: 'device', model: 'led' },
    visual: { shape: 'led' },
    doc: 'LED. Anode (+) to the higher potential through a series resistor (220Ω–1kΩ); cathode (−) toward ground. Sustained current above 30mA burns it out permanently.',
  }),
  npn: E({
    type: 'npn',
    label: 'NPN transistor (2N3904)',
    category: 'semiconductor',
    placement: 'leads',
    pins: ['emitter', 'base', 'collector'],
    sim: { kind: 'device', model: 'npn' },
    visual: { shape: 'to92' },
    doc: 'NPN BJT, pin order emitter/base/collector (2N3904 flat side facing you: E-B-C). Drive the base through a resistor (1k–10k).',
  }),
  pnp: E({
    type: 'pnp',
    label: 'PNP transistor (2N3906)',
    category: 'semiconductor',
    placement: 'leads',
    pins: ['emitter', 'base', 'collector'],
    sim: { kind: 'device', model: 'pnp' },
    visual: { shape: 'to92' },
    doc: 'PNP BJT, pin order emitter/base/collector.',
  }),
  nmos: E({
    type: 'nmos',
    label: 'N-MOSFET (2N7000)',
    category: 'semiconductor',
    placement: 'leads',
    pins: ['source', 'gate', 'drain'],
    sim: { kind: 'device', model: 'nmos' },
    visual: { shape: 'to92' },
    doc: 'Small N-channel MOSFET, pin order source/gate/drain. Vth ≈ 2V.',
  }),

  // ------------------------------------------------------------ switches
  pushbutton: E({
    type: 'pushbutton',
    label: 'Pushbutton (tactile)',
    category: 'switch',
    placement: 'footprint',
    pins: ['A1', 'A2', 'B1', 'B2'],
    footprintOffsets: [
      { dCol: 0, row: 'f' }, // A1 (pin 1, anchor)
      { dCol: 0, row: 'e' }, // A2
      { dCol: 2, row: 'f' }, // B1
      { dCol: 2, row: 'e' }, // B2
    ],
    internalBridges: [
      ['A1', 'A2'],
      ['B1', 'B2'],
    ],
    params: [{ key: 'pressed', label: 'Pressed', kind: 'boolean', default: false, runtime: true }],
    // 3-column-wide molded base: the middle column (at+1, rows e/f) sits
    // under the body and must stay empty
    bodyFootprint: { dCols: [0, 2], rows: ['e', 'f'] },
    sim: { kind: 'device', model: 'pushbutton' },
    visual: { shape: 'button' },
    doc: 'Momentary tactile button straddling the center channel. `at` = hole for pin A1 (row f). Occupies columns at and at+2 in rows e and f. A-side and B-side connect while pressed. A1/A2 are internally joined, as are B1/B2. The body also covers the middle column (at+1, rows e and f) — leave those two holes empty.',
  }),
  slide_switch: E({
    type: 'slide_switch',
    label: 'Slide switch (SPDT)',
    category: 'switch',
    placement: 'leads',
    pins: ['a', 'common', 'b'],
    params: [
      { key: 'state', label: 'Position', kind: 'select', default: 'a', options: ['a', 'b'], runtime: true },
    ],
    sim: { kind: 'device', model: 'slide_switch' },
    visual: { shape: 'slide' },
    doc: 'SPDT slide switch with 3 leads: the common connects to lead a or lead b depending on the slider position. User-togglable during simulation.',
  }),
  dip_switch_8: E({
    type: 'dip_switch_8',
    label: 'DIP switch ×8',
    category: 'switch',
    placement: 'dip',
    pins: [
      '1A', '2A', '3A', '4A', '5A', '6A', '7A', '8A',
      '8B', '7B', '6B', '5B', '4B', '3B', '2B', '1B',
    ],
    params: [
      { key: 'on', label: 'Switch states (1=on)', kind: 'text', default: '00000000', runtime: true },
    ],
    // explicit rect = the full DIP-16 package span (cols at..at+7 × rows e/f);
    // the rendered body stays inside the pin rows, so nothing beyond the pins
    bodyFootprint: { dCols: [0, 7], rows: ['e', 'f'] },
    sim: { kind: 'device', model: 'dip_switch_8' },
    visual: { shape: 'dipswitch' },
    doc: 'Eight independent switches in a DIP-16 package. Switch n connects pin nA to pin nB when on. Perfect for setting BCD digit inputs by hand.',
  }),

  // ----------------------------------------------------- power / sources
  power_supply: E({
    type: 'power_supply',
    label: 'DC power supply',
    category: 'power',
    placement: 'offboard',
    pins: ['+', '-'],
    params: [
      { key: 'voltage', label: 'Voltage', kind: 'number', default: 5, min: 0, max: 15, step: 0.1, unit: 'V', runtime: true },
    ],
    sim: { kind: 'device', model: 'power_supply' },
    visual: { shape: 'psu' },
    doc: 'Adjustable bench DC supply, off-board. Wire its terminals ("ID:+" and "ID:-") to the power rails, e.g. {"from":"PS1:+","to":"top+0"}. Its "-" terminal defines circuit ground. Every circuit needs exactly one.',
  }),
  function_generator: E({
    type: 'function_generator',
    label: 'Function generator',
    category: 'power',
    placement: 'offboard',
    pins: ['out', 'gnd'],
    params: [
      { key: 'waveform', label: 'Waveform', kind: 'select', default: 'square', options: ['sine', 'square', 'triangle'], runtime: true },
      { key: 'frequency', label: 'Frequency', kind: 'number', default: 1, min: 0.01, max: 100000, unit: 'Hz', runtime: true },
      { key: 'amplitude', label: 'Amplitude (peak)', kind: 'number', default: 2.5, min: 0, max: 10, step: 0.1, unit: 'V', runtime: true },
      { key: 'offset', label: 'DC offset', kind: 'number', default: 2.5, min: -10, max: 10, step: 0.1, unit: 'V', runtime: true },
    ],
    sim: { kind: 'device', model: 'function_generator' },
    visual: { shape: 'fungen' },
    doc: 'Off-board signal source: out = offset + amplitude·wave(2π·f·t). Wire "ID:out" and "ID:gnd". Tie gnd to the supply ground rail.',
  }),

  // ----------------------------------------------------------- displays
  seven_segment: E({
    type: 'seven_segment',
    label: '7-segment display',
    category: 'display',
    placement: 'dip',
    pins: ['E', 'D', 'COM1', 'C', 'DP', 'B', 'A', 'COM2', 'F', 'G'],
    internalBridges: [['COM1', 'COM2']],
    // explicit rect = the DIP-10 package span (cols at..at+4 × rows e/f); the
    // rendered display body stays inside the pin rows, nothing beyond the pins
    bodyFootprint: { dCols: [0, 4], rows: ['e', 'f'] },
    sim: { kind: 'device', model: 'seven_segment' },
    visual: { shape: 'sevenseg' },
    doc: 'Common-cathode single-digit 7-segment display (DIP-10, straddles the channel; `at` = pin E hole in row f). Segment pins A–G and DP are LED anodes (~2V forward); wire COM1 or COM2 to ground. Use series resistors on segment lines, or a CD4511/CD4026 driver.',
  }),
  buzzer: E({
    type: 'buzzer',
    label: 'Buzzer',
    category: 'display',
    placement: 'leads',
    pins: ['p1', 'p2'],
    sim: { kind: 'device', model: 'buzzer' },
    visual: { shape: 'buzzer' },
    doc: 'Simple buzzer (~300Ω load). Sounds when more than ~1V is applied (p1 positive).',
  }),

  // ----------------------------------------------------------------- ICs
  ne555: E({
    type: 'ne555',
    label: 'NE555 timer',
    category: 'ic',
    placement: 'dip',
    pins: ['GND', 'TRIG', 'OUT', 'RESET', 'CTRL', 'THRES', 'DISCH', 'VCC'],
    sim: { kind: 'chip', model: 'ne555' },
    visual: { shape: 'dip' },
    bodyFootprint: 'auto', // plain DIP package: the body covers exactly its pin rect
    doc: 'Classic 555 timer (DIP-8). Astable blinker: R_A from VCC to DISCH, R_B from DISCH to THRES, C from THRES to GND, tie TRIG to THRES, RESET to VCC. f ≈ 1.44/((R_A+2·R_B)·C). OUT drives loads directly.',
  }),
  lm358: E({
    type: 'lm358',
    label: 'LM358 dual op-amp',
    category: 'ic',
    placement: 'dip',
    pins: ['OUT1', 'IN1-', 'IN1+', 'GND', 'IN2+', 'IN2-', 'OUT2', 'VCC'],
    sim: { kind: 'chip', model: 'lm358' },
    visual: { shape: 'dip' },
    bodyFootprint: 'auto', // plain DIP package: the body covers exactly its pin rect
    doc: 'Dual single-supply op-amp (DIP-8). Output swings from 0V to about VCC−1.2V. Use as comparator or amplifier.',
  }),
  sn7400: E({
    type: 'sn7400',
    label: '7400 quad NAND',
    category: 'ic',
    placement: 'dip',
    pins: ['1A', '1B', '1Y', '2A', '2B', '2Y', 'GND', '3Y', '3A', '3B', '4Y', '4A', '4B', 'VCC'],
    sim: { kind: 'chip', model: 'sn7400' },
    visual: { shape: 'dip' },
    bodyFootprint: 'auto', // plain DIP package: the body covers exactly its pin rect
    doc: 'Quad 2-input NAND gates (DIP-14). Gate n: inputs nA,nB → output nY. Power VCC (pin 14) and GND (pin 7) must be wired.',
  }),
  sn7404: E({
    type: 'sn7404',
    label: '7404 hex inverter',
    category: 'ic',
    placement: 'dip',
    pins: ['1A', '1Y', '2A', '2Y', '3A', '3Y', 'GND', '4Y', '4A', '5Y', '5A', '6Y', '6A', 'VCC'],
    sim: { kind: 'chip', model: 'sn7404' },
    visual: { shape: 'dip' },
    bodyFootprint: 'auto', // plain DIP package: the body covers exactly its pin rect
    doc: 'Six independent inverters (DIP-14). nY = NOT nA.',
  }),
  sn7408: E({
    type: 'sn7408',
    label: '7408 quad AND',
    category: 'ic',
    placement: 'dip',
    pins: ['1A', '1B', '1Y', '2A', '2B', '2Y', 'GND', '3Y', '3A', '3B', '4Y', '4A', '4B', 'VCC'],
    sim: { kind: 'chip', model: 'sn7408' },
    visual: { shape: 'dip' },
    bodyFootprint: 'auto', // plain DIP package: the body covers exactly its pin rect
    doc: 'Quad 2-input AND gates (DIP-14).',
  }),
  sn7432: E({
    type: 'sn7432',
    label: '7432 quad OR',
    category: 'ic',
    placement: 'dip',
    pins: ['1A', '1B', '1Y', '2A', '2B', '2Y', 'GND', '3Y', '3A', '3B', '4Y', '4A', '4B', 'VCC'],
    sim: { kind: 'chip', model: 'sn7432' },
    visual: { shape: 'dip' },
    bodyFootprint: 'auto', // plain DIP package: the body covers exactly its pin rect
    doc: 'Quad 2-input OR gates (DIP-14).',
  }),
  sn7486: E({
    type: 'sn7486',
    label: '7486 quad XOR',
    category: 'ic',
    placement: 'dip',
    pins: ['1A', '1B', '1Y', '2A', '2B', '2Y', 'GND', '3Y', '3A', '3B', '4Y', '4A', '4B', 'VCC'],
    sim: { kind: 'chip', model: 'sn7486' },
    visual: { shape: 'dip' },
    bodyFootprint: 'auto', // plain DIP package: the body covers exactly its pin rect
    doc: 'Quad 2-input XOR gates (DIP-14).',
  }),
  sn7474: E({
    type: 'sn7474',
    label: '7474 dual D flip-flop',
    category: 'ic',
    placement: 'dip',
    pins: ['1CLR', '1D', '1CLK', '1PRE', '1Q', '1QN', 'GND', '2QN', '2Q', '2PRE', '2CLK', '2D', '2CLR', 'VCC'],
    sim: { kind: 'chip', model: 'sn7474' },
    visual: { shape: 'dip' },
    bodyFootprint: 'auto', // plain DIP package: the body covers exactly its pin rect
    doc: 'Dual D flip-flop with async preset/clear, rising-edge clock (DIP-14). CLR and PRE are active-low — tie them to VCC when unused. Tie QN back to D for a divide-by-2 toggle.',
  }),
  cd4017: E({
    type: 'cd4017',
    label: 'CD4017 decade counter',
    category: 'ic',
    placement: 'dip',
    pins: ['Q5', 'Q1', 'Q0', 'Q2', 'Q6', 'Q7', 'Q3', 'VSS', 'Q8', 'Q4', 'Q9', 'CO', 'INH', 'CLK', 'RST', 'VDD'],
    sim: { kind: 'chip', model: 'cd4017' },
    visual: { shape: 'dip' },
    bodyFootprint: 'auto', // plain DIP package: the body covers exactly its pin rect
    doc: 'Johnson decade counter (DIP-16): one of Q0–Q9 goes high in sequence on each rising CLK edge. Tie INH and RST to GND for free running. Great for LED chasers.',
  }),
  cd4026: E({
    type: 'cd4026',
    label: 'CD4026 counter + 7-seg driver',
    category: 'ic',
    placement: 'dip',
    pins: ['CLK', 'INH', 'DEI', 'DEO', 'CO', 'F', 'G', 'VSS', 'D', 'A', 'E', 'B', 'C', 'UCS', 'RST', 'VDD'],
    sim: { kind: 'chip', model: 'cd4026' },
    visual: { shape: 'dip' },
    bodyFootprint: 'auto', // plain DIP package: the body covers exactly its pin rect
    doc: 'Decade counter with direct 7-segment outputs A–G (DIP-16) — drives a common-cathode display through ~330Ω resistors. CO emits one pulse per 10 counts (chain it to the next digit CLK). Tie DEI to VDD, INH and RST to GND.',
  }),
  cd4511: E({
    type: 'cd4511',
    label: 'CD4511 BCD→7-seg latch/decoder',
    category: 'ic',
    placement: 'dip',
    pins: ['B', 'C', 'LT', 'BL', 'LE', 'D', 'A', 'VSS', 'E_SEG', 'D_SEG', 'C_SEG', 'B_SEG', 'A_SEG', 'G_SEG', 'F_SEG', 'VDD'],
    sim: { kind: 'chip', model: 'cd4511' },
    visual: { shape: 'dip' },
    bodyFootprint: 'auto', // plain DIP package: the body covers exactly its pin rect
    doc: 'BCD-to-7-segment latch/decoder/driver (DIP-16) for common-cathode displays. BCD in on A(lsb) B C D(msb); segment outputs *_SEG drive the display through ~330Ω resistors. Tie LT and BL to VDD, LE to GND for transparent display. To show a fixed digit, tie A–D to VDD/GND in its BCD pattern — ideal for hardwired date displays.',
  }),
  sn74193: E({
    type: 'sn74193',
    label: '74193 4-bit up/down counter',
    category: 'ic',
    placement: 'dip',
    pins: ['B', 'QB', 'QA', 'DOWN', 'UP', 'QC', 'QD', 'GND', 'D', 'C', 'LOAD', 'CO', 'BO', 'CLR', 'A', 'VCC'],
    sim: { kind: 'chip', model: 'sn74193' },
    visual: { shape: 'dip' },
    bodyFootprint: 'auto', // plain DIP package: the body covers exactly its pin rect
    doc: 'Presettable 4-bit binary up/down counter (DIP-16). Rising edge on UP counts up (hold DOWN high), on DOWN counts down (hold UP high). LOAD (active low) presets QA–QD from inputs A–D; CLR high resets to 0.',
  }),
  cd4040: E({
    type: 'cd4040',
    label: 'CD4040 12-bit ripple counter',
    category: 'ic',
    placement: 'dip',
    pins: ['Q12', 'Q6', 'Q5', 'Q7', 'Q4', 'Q3', 'Q2', 'VSS', 'Q1', 'CLK', 'RST', 'Q9', 'Q8', 'Q10', 'Q11', 'VDD'],
    sim: { kind: 'chip', model: 'cd4040' },
    visual: { shape: 'dip' },
    bodyFootprint: 'auto', // plain DIP package: the body covers exactly its pin rect
    doc: '12-stage binary ripple counter (DIP-16), advances on the FALLING edge of CLK. Qn toggles at CLK/2^n — chain after a 555 to divide a fast clock down to ~1Hz. RST high clears.',
  }),

  // -------------------------------------------------------- instruments
  scope_probe: E({
    type: 'scope_probe',
    label: 'Oscilloscope probe',
    category: 'instrument',
    placement: 'probe',
    pins: ['tip'],
    params: [
      { key: 'channel', label: 'Channel', kind: 'number', default: 1, min: 1, max: 4, step: 1 },
    ],
    sim: { kind: 'probe' },
    visual: { shape: 'probe' },
    doc: 'Oscilloscope probe: place its single hole on any net to plot that voltage on the scope panel (channels 1–4).',
  }),
}

export function getEntry(type: string): CatalogEntry | undefined {
  return CATALOG[type]
}

export function paramDefault(entry: CatalogEntry, key: string): number | string | boolean | undefined {
  return entry.params?.find((p) => p.key === key)?.default
}

/** Effective param value with catalog default fallback. */
export function paramOf(
  params: Record<string, number | string | boolean> | undefined,
  entry: CatalogEntry,
  key: string,
): number | string | boolean | undefined {
  return params?.[key] ?? paramDefault(entry, key)
}
