/**
 * System prompt for circuit generation — assembled programmatically from the
 * component CATALOG so it never drifts from the simulator. Everything here is
 * deterministic per (catalog, board config): stable key order, no timestamps —
 * the prompt is byte-stable across calls for a given active rig, so prompt
 * caching works.
 */

import { CATALOG, CatalogEntry, ParamDef } from '../model/catalog'
import { leadsBodyOverhang, occludedOffsetsForEntry } from '../model/occlusion'
import {
  asBoardConfig,
  BOARD_SIZES,
  BoardConfig,
  BoardSizeId,
  boardConfigOf,
  boardOf,
  boardRowsOf,
  MAX_BOARD_COUNT,
  MAX_BOARD_ROWS,
} from '../model/types'
import { FEW_SHOT_EXAMPLES, FEW_SHOT_REQUESTS } from './examples'
import { expectationsToEmit, layoutToEmit, MIN_VERIFIABLE_HZ } from './schema'
import type { Expectation } from './schema'

function formatParam(p: ParamDef): string {
  const bits: string[] = [p.kind]
  if (p.kind === 'select' && p.options) bits.push(`options: ${p.options.join(' | ')}`)
  bits.push(`default: ${JSON.stringify(p.default)}`)
  if (p.unit) bits.push(`unit: ${p.unit}`)
  if (p.min !== undefined && p.max !== undefined) bits.push(`range ${p.min}..${p.max}`)
  if (p.runtime) bits.push('user-adjustable while simulating')
  return `  - ${p.key} (${bits.join(', ')})`
}

function placementLine(entry: CatalogEntry): string {
  switch (entry.placement) {
    case 'leads':
      return `placement: leads — set "holes" to exactly ${entry.pins.length} hole refs, one per pin in the order below; "at" is null`
    case 'probe':
      return 'placement: probe — set "holes" to exactly 1 hole ref; "at" is null'
    case 'dip':
      return `placement: dip (DIP-${entry.pins.length}) — set "at" to the hole of pin 1, which MUST be in row "f"; pins 1..${entry.pins.length / 2} run left→right along row f, pins ${entry.pins.length / 2 + 1}..${entry.pins.length} run right→left along row e; "holes" is []; optional "rotation" 0 or 180 ONLY (180 = same holes, pin walk reversed: pin 1 moves to the row-e right end; 90/270 would short every pin pair into one strip column)`
    case 'footprint':
      return 'placement: footprint — set "at" to the hole of pin 1; the other pins land at fixed offsets (see below); "holes" is []; optional "rotation" 0|90|180|270 (pin 1 stays at "at", the other offsets rotate around it in clockwise quarter turns)'
    case 'offboard':
      return `placement: off-board instrument — no "at", no "holes"; wires reference its terminals as "ID:PIN" (e.g. "${'ID'}:${entry.pins[0]}")`
  }
}

function pinTable(entry: CatalogEntry): string {
  if (entry.placement === 'offboard') {
    return `terminals: ${entry.pins.map((p) => `"${p}"`).join(', ')}`
  }
  const label = entry.placement === 'leads' || entry.placement === 'probe' ? 'pins (holes[] order)' : 'pins (package pin = position)'
  return `${label}: ${entry.pins.map((p, i) => `${i + 1}=${p}`).join(', ')}`
}

/**
 * Per-part body-occlusion warning, generated from the catalog bodyFootprint
 * so it can never drift from the validator. null when the body covers nothing
 * beyond its own pins.
 */
function occlusionLine(entry: CatalogEntry): string | null {
  const overhang = leadsBodyOverhang(entry)
  if (overhang) {
    return (
      `body occlusion: the body overhangs ${overhang.left} column(s) beyond each outer lead ` +
      `and ${overhang.above} row(s) above/below its leads — every overhung hole must stay ` +
      'completely EMPTY (no other pins, no wire ends)'
    )
  }
  const offsets = occludedOffsetsForEntry(entry)
  if (!offsets || offsets.length === 0) return null
  const cells = offsets
    .map((o) => `(col${o.dCol >= 0 ? `+${o.dCol}` : o.dCol}, row ${o.row})`)
    .join(', ')
  return `body occlusion: besides its pins the body covers ${cells} relative to "at" — those holes must stay completely EMPTY (no other pins, no wire ends)`
}

function entrySection(entry: CatalogEntry): string {
  const lines: string[] = [`### ${entry.type} — ${entry.label}`]
  lines.push(placementLine(entry))
  lines.push(pinTable(entry))
  if (entry.placement === 'footprint' && entry.footprintOffsets) {
    lines.push(
      'footprint offsets from pin 1: ' +
        entry.footprintOffsets
          .map((o, i) => `${entry.pins[i]} at (col+${o.dCol}, row ${o.row})`)
          .join(', '),
    )
  }
  if (entry.internalBridges && entry.internalBridges.length > 0) {
    lines.push(
      'internally connected pin pairs: ' +
        entry.internalBridges.map(([a, b]) => `${a}↔${b}`).join(', '),
    )
  }
  const occ = occlusionLine(entry)
  if (occ) lines.push(occ)
  if (entry.params && entry.params.length > 0) {
    lines.push('params:')
    for (const p of entry.params) lines.push(formatParam(p))
  } else {
    lines.push('params: none')
  }
  lines.push(`doc: ${entry.doc}`)
  return lines.join('\n')
}

function boardRules(config: BoardConfig): string {
  const { size: sizeId, count } = config
  const rows = boardRowsOf(config)
  const size = BOARD_SIZES[sizeId]
  const totalCols = size.cols * count
  const totalRail = size.railHoles * count
  const presetTable = (Object.keys(BOARD_SIZES) as BoardSizeId[])
    .map((id) => {
      const s = BOARD_SIZES[id]
      return `  - "${id}" — ${s.label} (${s.points} points): columns 1..${s.cols}, rail holes 0..${s.railHoles - 1}`
    })
    .join('\n')
  const activeLine =
    count === 1
      ? `The ACTIVE board is the ${size.label} ${size.points}-point solderless breadboard
("${sizeId}"): columns 1..${size.cols}, rail holes 0..${size.railHoles - 1}.`
      : `The ACTIVE rig is ${count} ${size.label} ${size.points}-point solderless breadboards
ganged side by side ("${sizeId}" × ${count}, ${size.points * count} points total):
columns 1..${totalCols}, rail holes 0..${totalRail - 1}.`
  const activeRowsLine =
    rows === 1
      ? ''
      : `
The active grid is also ${rows} board-rows deep ("boardRows": ${rows}): board-rows
0..${rows - 1}, the front row bare ("a12") and deeper rows prefixed ("1:a12" up to
"${rows - 1}:a12"). Each board-row has its own INDEPENDENT power rails — jumper power
to every board-row you use.`
  return `## The breadboard

${activeLine}${activeRowsLine}

Board size presets (the "board" field of your output):
${presetTable}

Multi-board rigs (the "boardCount" field of your output): up to ${MAX_BOARD_COUNT}
identical board modules can be ganged side by side, like bench-mounted lab
stations. Column numbering is CONTINUOUS across modules — on "standard"
modules, board 2 starts at column ${BOARD_SIZES.standard.cols + 1} — and rail hole indices continue the
same way. The four power rails are BUSED across all modules: each rail is
still ONE continuous net along the entire rig. The only physical limit is the
SEAM between modules: a dip or footprint package must sit entirely on ONE
module — it may never straddle a module boundary (on "standard" modules the
first seam is between columns ${BOARD_SIZES.standard.cols} and ${BOARD_SIZES.standard.cols + 1}). Wires and leaded parts (resistors,
LEDs, capacitors, jumpers...) may cross seams freely.

Board-row grids (the "boardRows" field of your output): up to ${MAX_BOARD_ROWS} full rig
rows can be stacked front-to-back into a 2-D grid (boardCount modules wide ×
boardRows deep). Hole refs on the FRONT row (board-row 0) are bare ("a12",
"top+5"); rows behind it use a 0-INDEXED row prefix "r:" — "1:a12" is on
board-row 1, "2:top+5" on board-row 2 (valid prefixes "1:".."${MAX_BOARD_ROWS - 1}:"). Every
board-row has the same column/rail ranges. UNLIKE the side-by-side modules,
the power rails of DIFFERENT board-rows are INDEPENDENT nets — like separate
breadboards on a bench, a deeper row's rails are dead until powered: jumper
power between rows with wires (e.g. "top+10" → "1:top+10" red and "top-10" →
"1:top-10" black) before using that row's rails. A dip or footprint package
must sit entirely on ONE board-row (the rows are physically far apart); wires
and leaded parts may span board-rows freely.

Design for the ACTIVE rig: set "board": "${sizeId}", "boardCount": ${count} and
"boardRows": ${rows} in your output. If the request genuinely needs more room
than the active rig offers (e.g. many display digits or several DIP
packages), you may instead set "board" to a LARGER preset, "boardCount" to a
larger count (1..${MAX_BOARD_COUNT}) and/or "boardRows" to a larger depth (1..${MAX_BOARD_ROWS}), and lay
the circuit out for that grid's ranges. Never reference holes beyond the
columns/rail indices — or board-rows — of the grid you set.

- Terminal strips: columns 1..${totalCols} × rows a..j. Rows a–e are the TOP block,
  rows f–j the BOTTOM block, with the center channel between rows e and f.
- Strip connectivity: the 5 holes of one column-half are ONE electrical net.
  "a12","b12","c12","d12","e12" are all the same net; "f12".."j12" are a
  different net. Different columns are never connected by the board itself.
  Strips on different board-rows are always different nets ("a12" vs "1:a12").
- Power rails: 4 horizontal rails ("top+", "top-", "bot-", "bot+") per
  board-row, each with ${totalRail} holes indexed 0..${totalRail - 1}. Each rail is ONE continuous
  net along its whole length — but ONLY within its own board-row.
- Hole refs are strings: strip holes "a12", "j${totalCols}" (row letter + column);
  rail holes "top+5", "bot-12" (rail name + hole index); on board-rows ≥ 1
  prepend the row prefix ("1:a12", "2:top+5").
- DIP rule: a DIP package straddles the center channel. Its "at" anchor is the
  hole of PIN 1 and must be in row "f". Pins 1..N/2 run left→right along row f,
  pins N/2+1..N run right→left along row e. So pin N sits at row e in the same
  column as pin 1.
- ROTATION: dip and footprint parts take an optional "rotation" (default 0;
  null/0 for every other placement). DIP packages (including seven_segment)
  allow ONLY 0 or 180 —
  rotating a DIP 90 would put every pin in one strip column, shorting them.
  A DIP at 180 occupies the SAME holes ("at" still names its row-f LEFT hole)
  but the pin walk reverses: pin 1 ends at the row-e RIGHT end. Footprint
  parts (pushbutton) allow 0|90|180|270: pin 1 stays at "at" and the other
  pin offsets rotate around it in clockwise quarter turns.
- BODY OVERHANG: some parts' molded bodies cover holes beyond their own pins
  (see the per-part "body occlusion" notes in the catalog — e.g. a
  potentiometer covers one extra column/row around its leads; a pushbutton
  covers its middle column). A covered hole must stay completely empty: no
  other component lead and no wire end may use it.
- Off-board instruments (power_supply, function_generator) are not on the
  board. Wires reference their terminals directly as "ID:PIN" ("PS1:+",
  "FG1:out"). ONLY off-board instruments may be referenced this way.
- ONE LEAD PER HOLE: every hole accepts exactly one component lead OR one wire
  end. Two things must never share a hole. To join two leads electrically, put
  them in DIFFERENT free holes of the SAME strip column-half (e.g. one lead at
  f16, the other at j16) — the strip connects them.
- Wires connect any two endpoints (hole↔hole, hole↔terminal). Never write
  "U1:OUT" for an on-board chip — instead connect the wire to a free hole in
  the same strip column as that pin.`
}

const ELECTRICAL_RULES = `## Electrical golden rules

1. Every circuit needs exactly one power_supply, with "+" wired to a red (+)
   rail and "-" wired to a blue (-) rail. The "-" terminal is circuit ground.
2. Every IC's supply pins must be wired: VCC/VDD to the + rail, GND/VSS to the
   - rail (via a wire from a free hole in the pin's strip column).
3. Every LED needs a series resistor (220Ω–1kΩ). Sustained current above 30mA
   burns an LED out permanently.
4. A seven_segment display needs ~330Ω resistors on its segment lines (or a
   CD4511/CD4026 driver with resistors), and its COM pin wired to ground.
5. Tie unused control pins deliberately: active-low pins (7474 CLR/PRE, 555
   RESET, CD4511 LT/BL) to VCC when unused; CD4017/CD4026/CD4040 INH and RST
   to GND for free running. Never leave chip control inputs floating.
6. A function_generator's "gnd" terminal must be tied to the supply ground.
7. Use realistic SI values: resistance in ohms, capacitance in farads,
   frequency in hertz (10kΩ = 10000, 10µF = 1e-5).`

const LAYOUT_RULES = `## Layout quality

- Spread parts left→right in signal-flow order (inputs/sources on the left,
  outputs/indicators on the right). Don't pile everything in one corner.
- Keep at least 2 empty columns between DIP packages.
- Wire colors: "red" for +/supply, "black" for -/ground, other colors
  ("yellow", "green", "blue", "orange") for signals.
- Prefer short wires: power a chip from rail holes near its columns.
- Give components conventional ids: R1.. resistors, C1.. capacitors, D1..
  LEDs/diodes, U1.. ICs, SW1.. switches/buttons, PS1 power supply, FG1
  function generator, Q1.. transistors, BZ1.. buzzers, P1.. probes.`

const OUTPUT_RULES = `## Output format

Respond with a single JSON object matching the provided schema:
{ "explanation": "...", "circuit": { "name": "...", "board": "...", "boardCount": 1, "boardRows": 1, "components": [...], "wires": [...] }, "expectations": [...] }

- explanation: 2–6 friendly sentences on how the circuit works and how to
  interact with it (which knobs/buttons to use while simulating).
- board: the board size preset the circuit is laid out for ("half" |
  "standard" | "labxl") — normally the active board; a larger preset only when
  the circuit needs the extra room.
- boardCount: how many board modules the circuit is laid out for (1..${MAX_BOARD_COUNT}) —
  normally the active count; a larger count only when the circuit needs the
  extra width (remember: packages may not straddle module seams).
- boardRows: how many board-rows deep the circuit is laid out (1..${MAX_BOARD_ROWS}) —
  normally the active depth; a larger value only when the circuit needs the
  extra depth (remember: each board-row's rails are independent — jumper
  power to every row you use; packages sit on one board-row).
- Each component: { "id", "type", "at", "holes", "params", "rotation" }. Use
  "at" only for dip/footprint placements (null otherwise); use "holes" only
  for leads/probe placements ([] otherwise); "params" is an array of
  {"key","value"} pairs — use [] to keep all catalog defaults; "rotation" only
  for dip/footprint placements (0|180 for DIP packages, 0|90|180|270 for
  footprints; null for everything else and for unrotated parts).
- Each wire: { "id", "from", "to", "color" }. Endpoints are hole refs or
  off-board terminals.
- expectations: the machine-tested behavior claims (see "Declared
  expectations" below).
- Output the COMPLETE circuit: every component and every wire, fully placed.`

const EXPECTATION_RULES = `## Declared expectations (machine-tested)

Alongside the circuit, declare 1–4 expectations describing the OBSERVABLE
behavior the user asked for. The circuit will be machine-tested against these
in the simulator — only claim what must be true. Each expectation is
{ "kind", "target", "digit", "minHz", "maxHz", "minV", "maxV" }; set every
field that does not apply to null.

- Kinds and targets:
  - "led_on" / "led_off" / "led_blinks" — target = the LED's component id.
  - "segments_show" — target = a seven_segment component id (NOT the driver
    chip); digit = the digit "0".."9" it must display.
  - "buzzer_sounds" — target = the buzzer's component id.
  - "net_oscillates" / "net_in_range" — target = a hole ref on the net to
    measure (e.g. a free hole in the strip column of a chip's output pin).
- "led_blinks" and "net_oscillates" take minHz/maxHz frequency bounds; give a
  generous honest band (e.g. a ~1Hz blinker → minHz 0.5, maxHz 3). The test
  window cannot measure anything slower than ${MIN_VERIFIABLE_HZ}Hz: never set
  minHz below ${MIN_VERIFIABLE_HZ}, and design blinkers/oscillators to run at
  0.5Hz or faster so the test can observe them.
- "net_in_range" takes minV/maxV voltage bounds.
- The test runs the circuit exactly as placed, with default/declared params
  and NO user interaction. Declare the honest before-interaction state: a
  button-controlled LED is off until pressed → "led_off"; a dark-activated
  light under the default bright light level → "led_off". For static circuits
  "led_off" before the press is fine — pick what is honestly testable.
- expectations may be [] ONLY for circuits with no LED, no display and no
  buzzer.`

/**
 * Honest, machine-verified expectations for each worked example, by index
 * (button LED: off until pressed; 555 blinker: ~1Hz blink within 0.5–3Hz).
 */
const FEW_SHOT_EXPECTATIONS: Expectation[][] = [
  [{ kind: 'led_off', target: 'D1' }],
  [{ kind: 'led_blinks', target: 'D1', minHz: 0.5, maxHz: 3 }],
]

function exampleSection(): string {
  const parts: string[] = ['## Worked examples']
  for (let i = 0; i < FEW_SHOT_EXAMPLES.length; i++) {
    const layout = FEW_SHOT_EXAMPLES[i]
    // Examples always state their board + count + rows explicitly so they
    // read the same whatever the active rig is.
    const envelope = {
      explanation: layout.description ?? '',
      circuit: {
        ...layoutToEmit(layout),
        board: boardOf(layout),
        boardCount: boardConfigOf(layout).count,
        boardRows: boardConfigOf(layout).rows,
      },
      expectations: expectationsToEmit(FEW_SHOT_EXPECTATIONS[i] ?? []),
    }
    parts.push(`### Example ${i + 1} — user asked: "${FEW_SHOT_REQUESTS[i]}"`)
    parts.push(JSON.stringify(envelope, null, 2))
  }
  return parts.join('\n\n')
}

function catalogSection(): string {
  // Object.keys over the static CATALOG literal — insertion order, stable
  // across calls and builds, which keeps the prompt cache-friendly.
  const sections = Object.keys(CATALOG).map((key) => entrySection(CATALOG[key]))
  return `## Component catalog\n\nUse ONLY these component types.\n\n${sections.join('\n\n')}`
}

/**
 * Build the full system prompt for circuit generation. Accepts the active
 * board as a bare size id (= a single board, back-compat) or a full
 * BoardConfig. Deterministic per (catalog, size, count) — byte-identical for
 * repeated calls with the same active rig, so prompt caching keeps working.
 */
export function buildSystemPrompt(board: BoardSizeId | BoardConfig = 'standard'): string {
  return [
    'You are the expert circuit designer inside Breadboard Studio, a 3D breadboard ' +
      'circuit simulator. The user describes a circuit in plain language; you design ' +
      'a complete, working, well-laid-out breadboard circuit and emit it as JSON. ' +
      'There is no microcontroller — build everything from the hardware catalog ' +
      '(timers, counters, decoders, gates, passives). The circuit will be placed on ' +
      'the board and simulated immediately, so every pin assignment and wire must be ' +
      'exactly right.',
    boardRules(asBoardConfig(board)),
    catalogSection(),
    ELECTRICAL_RULES,
    LAYOUT_RULES,
    OUTPUT_RULES,
    EXPECTATION_RULES,
    exampleSection(),
  ].join('\n\n')
}
