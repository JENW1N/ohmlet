# ohmlet — Architecture

A Crumb-style **3D breadboard circuit simulator** in the browser:
real-time hybrid analog (MNA) + digital (behavioral IC) simulation,
hardware-only components (no microcontroller), JSON import/export, and a
Claude-powered "describe a circuit → it appears on the board" panel.

Decisions (locked): Three.js 3D rendering · custom MNA solver + event-driven
chips · no MCU (dates/counters built from 555s, counters, BCD decoders,
7-segment displays) · Claude called directly from the browser with the user's
API key (`claude-opus-4-8`).

## Stack

Vite + React 18 + TypeScript (strict) · Three.js (vanilla, no react-three-fiber)
· zustand · @anthropic-ai/sdk · vitest. `npm run dev|build|typecheck|test`.

## Directory map & ownership

| Path | Owner | Contents |
|---|---|---|
| `src/model/types.ts` | CONTRACT | shared types (layout, holes, telemetry) |
| `src/model/breadboard.ts` | CONTRACT | topology, hole parsing, coordinates, net ids, footprints |
| `src/model/catalog.ts` | CONTRACT¹ | every component definition (pins, params, docs, body footprints) |
| `src/model/occlusion.ts` | CONTRACT | body occlusion: which holes a molded body covers beyond its pins |
| `src/model/validate.ts` | **llm agent** | layout validator (schema + placement + electrical rules) |
| `src/sim/chip-api.ts` | CONTRACT | chip↔solver bridge + chip registry |
| `src/sim/netlist.ts` `mna.ts` `devices.ts` `engine.ts` | **sim-core agent** | union-find nets, MNA solver, analog devices, engine |
| `src/sim/chips/all.ts` | CONTRACT | barrel importing `all-a` + `all-b` |
| `src/sim/chips/all-a.ts` + gates/flipflops/timer555/opamp | **chips-A agent** | 7400/04/08/32/86, 7474, NE555, LM358 |
| `src/sim/chips/all-b.ts` + counters/decoders | **chips-B agent** | CD4017, CD4026, CD4511, 74193, CD4040 |
| `src/three/scene-api.ts` | CONTRACT | scene interface |
| `src/three/scene.ts` (+ `src/three/internal/*`) | **scene agent** | scene, board mesh, picking, wires, ghost, edit drags |
| `src/three/render-modes/*` | **render-modes agent** | Performance / Enhanced / Studio engine (spec: its `RENDER-MODES.md`) |
| `src/three/component-meshes.ts` (+ `src/three/meshes/*`) | **meshes agent** | procedural component visuals |
| `src/state/types.ts` | CONTRACT | store interface |
| `src/state/store.ts`, `src/state/history.ts`, `src/App.tsx` | **glue agent** | real store, undo history, app layout, sim loop |
| `src/ui/*` | **ui agent** | panels (palette, properties, scope, LLM, toolbar...) |
| `src/llm/*` | **llm agent** | Claude client, schema, prompt builder, generate+repair |
| `tests/*.test.ts` | **tests agent** | vitest suites |
| `examples/*.json` | **demos agent** | curated example circuits |

¹ Chip agents may correct the **pin name arrays of their own chips** in
`catalog.ts` after verifying against datasheets (use the Edit tool with small,
surgical replacements — another agent may be editing other entries of the same
file concurrently). Everything else in catalog.ts is fixed.

**Never modify files owned by another agent.** If a contract needs changing,
return the request in your `contractRequests` output instead.

## Breadboard geometry (the coordinate system everyone shares)

Boards come in three size presets (`BOARD_SIZES` in `src/model/types.ts`,
keyed by `BoardSizeId`):

| id | label | columns | rail holes | points |
|---|---|---|---|---|
| `half` | Half | 1..30 | 0..24 | 400 |
| `standard` | Standard | 1..63 | 0..49 | 830 |
| `labxl` | Lab XL | 1..126 | 0..99 | 1660 |

**The 2-D board grid.** Identical modules of one preset gang into a 2-D
rig: `BoardConfig = { size: BoardSizeId; count: number; rows: number }`
(types.ts), carried on the layout as the optional `boardCount` (modules
wide, 1..`MAX_BOARD_COUNT` = 6; absent = 1) and `boardRows` (board-rows
deep, 1..`MAX_BOARD_ROWS` = 4; absent = 1) fields. The two axes behave
differently, mirroring a real bench:

- **Across a row (modules, side by side):** column numbering and rail
  indices are **continuous** — module 2 of a `'standard'` rig starts at
  column 64; total columns = cols × count, total rail holes =
  railHoles × count — and each of the four power rails stays ONE bused net
  along the whole row (like ganged lab stations), so `netIdForHole` needs
  no module awareness. The one physical rule is the **seam rule**: a rigid
  dip/footprint package may not straddle the gap between two modules —
  `spansSeam(holes, config)` — enforced by the validator, store placement
  and board-size/count switches; wires and flexible leaded parts cross
  seams freely. Module helpers: `moduleOfCol`, `moduleOfRailIndex`,
  `moduleSeamXs` (plan-view seam x positions for the scene).
- **Front-to-back (board-rows):** each board-row is a COMPLETE rig row with
  its own four power rails. Hole refs address rows with an optional
  0-indexed prefix — the front row (row 0) is bare (`a12`, `top+5`; full
  back-compat), deeper rows are `1:a12`, `2:top+5`, `3:j63` (`0:` parses as
  a non-canonical alias; `formatHole` always emits bare row 0). Row r is
  offset in plan z by r × `BOARD_ROW_PITCH` (19.5 units = one row's full
  mesh depth — rows abut at a thin molded seam); x is unchanged. Unlike
  the side-by-side bus, rails on DIFFERENT
  board-rows are **independent nets** (jumper power between rows), which
  `netIdForHole` encodes by namespacing nets per row (`2:S12T`, `1:R:top+`;
  row 0 stays unprefixed). A rigid package can never span board-rows
  (`spansBoardRows`); wires and flexible leaded parts may.

Every size-aware helper accepts `BoardConfig | BoardSizeId` (a bare size
id = a single board, via `asBoardConfig`). A layout's board is
`layout.board` (absent = `'standard'`; use `boardOf(layout)`) and its full
rig is `boardConfigOf(layout)` (hardened — a malformed `boardCount` /
`boardRows` can never produce a bogus rig; read rows with `boardRowsOf`).
The deprecated `NUM_COLS` / `RAIL_HOLES` / `BOARD_EXTENTS` constants remain
as the single-standard-board values. Full details + helpers in
`src/model/breadboard.ts` — always use its helpers, never re-derive.

- Terminal strips: columns **1..cols** × rows **a..j**. Rows a–e are the top
  block, f–j the bottom block, center channel between e and f.
  Connectivity: one net per (column, block) — `a12..e12` are one net (`S12T`),
  `f12..j12` another (`S12B`).
- Power rails: 4 horizontal rails (`top+`, `top-`, `bot-`, `bot+`),
  `railHoles` holes each, each rail is ONE continuous net.
- Hole refs (DSL strings): `"a12"`, `"j63"`, `"top+5"`, `"bot-12"`, plus
  the optional board-row prefix `"1:a12"`, `"2:top+5"` (0-indexed; row 0 is
  written bare). `parseHole()` is SYNTAX-level: it accepts the maxima
  across **rigs** (columns 1..756, rail index 0..599 — the `'labxl'`
  preset × `MAX_BOARD_COUNT` modules — and board-row prefixes
  0..`MAX_BOARD_ROWS`−1); whether a hole exists on a given rig is
  `isHoleOnBoard(hole, config)`. Size-aware helpers (`allHoles`,
  `boardExtents`, `dipHoles`, `footprintHoles`, `componentPinHoles`) take a
  trailing `config: BoardConfig | BoardSizeId = 'standard'` argument.
- Plan units: 1 unit = 0.1" pitch; x = along board, z = across, y = up.
  Board top surface is y = 0. `holePosition()` gives {x,z}. The geometry
  formulas are size-independent (strip x = col; rail hole i at
  x = 2.5 + i + ⌊i/5⌋, grouped in 5s) — larger boards just extend the same
  lattice rightward; only the bounds differ.
- **DIP rule**: `at` = pin 1's hole, must be row `f`. Pins 1..N/2 run
  left→right along row f; N/2+1..N right→left along row e (`dipHoles()`).
- **Rotation** (dip/footprint packages only): the optional
  `rotation: 0 | 90 | 180 | 270` on a component is the in-plane package
  rotation, clockwise in plan view, about the `at` anchor. DIPs accept only
  0|180 (90/270 would put every pin pair in one strip column) — 180 spins
  the package IN PLACE: same holes, `at` still names the row-f hole at the
  package's left end, but the pin walk reverses (`dipHoles`). Footprints
  rotate their offset deltas in quarter turns (`rotateOffsetDelta` /
  `footprintHoles`). Leaded parts orient by their hole placement;
  instruments have no orientation.
- **Body occlusion** (`src/model/occlusion.ts`): a part's molded body
  covers holes beyond its own pins, from `CatalogEntry.bodyFootprint`
  (`'auto'` = the pin bounding rect; explicit plan-rects mirror the
  rendered meshes). A covered hole takes no other pin and no wire end —
  errors in the validator, a named-coverer toast in the app, and per-part
  warnings in the LLM prompt. Rotation-aware: the rect rotates with the
  pins. Whenever a part's visual extents change, `bodyFootprint` and the
  router obstacle rects must be re-synced to the new geometry (DESIGN §4b).
- Off-board instruments (power supply, function generator) have terminals,
  not holes. Wire endpoints use `"PS1:+"` form. Render positions come from
  `offboardTerminalPosition(slot, pinIndex, pos?)` where slot = index among
  off-board components in layout order. Instruments are MOVABLE: an optional
  `pos: {x, z}` on the component (plan units, 0.5-grid) overrides the legacy
  slot-shelf formula as the body anchor (`offboardBodyPosition(slot, pos?)`);
  absent `pos` = the legacy formula, so existing layouts render identically,
  and `pos` round-trips export/import. `offboardBodyRect(slot, pos?)` is the
  unit's plan footprint (6.5-wide enclosure + terminal-post apron;
  `OFFBOARD_BODY_HEIGHT` ≈ 4 is its obstacle height). The validator rejects
  a `pos` off the 0.5 grid, a body rect intersecting the active rig's
  `boardExtents`, or one overlapping another instrument's body rect.

## The DSL (= import/export format = LLM output)

```json
{
  "version": 1,
  "name": "555 blinker",
  "board": "standard",
  "components": [
    { "id": "PS1", "type": "power_supply", "params": { "voltage": 5 } },
    { "id": "U1", "type": "ne555", "at": "f20" },
    { "id": "R1", "type": "resistor", "params": { "resistance": 1000 }, "holes": ["j18", "j24"] },
    { "id": "C1", "type": "capacitor", "params": { "capacitance": 1e-5 }, "holes": ["d22", "top-10"] },
    { "id": "D1", "type": "led", "params": { "color": "red" }, "holes": ["b30", "b32"] }
  ],
  "wires": [
    { "id": "w1", "from": "PS1:+", "to": "top+0", "color": "red" },
    { "id": "w2", "from": "PS1:-", "to": "top-0", "color": "black" }
  ]
}
```

`holes[]` length must equal the catalog pin count (leads/probe). `at` for
dip/footprint (which may also carry `"rotation"`: 0|180 for DIPs, quarter
turns for footprints). Off-board components have neither, but may carry a
movable-instrument `"pos"` (plan units on the 0.5 grid). `"board"` is
optional (`"half" | "standard" | "labxl"`; absent = `"standard"` for full
backward compatibility), `"boardCount"` is optional (integer 1..6; absent
= 1) — it gangs that many identical modules into one rig with continuous
column/rail numbering — and `"boardRows"` is optional (integer 1..4;
absent = 1) — it stacks that many full rig rows front-to-back, addressed
by the `"1:a12"` hole-ref prefix, each with independent power rails. The
validator bounds-checks every hole against the declared 2-D rig and
rejects dip/footprint packages that straddle a module seam (or would span
board-rows). The LLM is told the active rig and may emit a larger
`"board"` / `"boardCount"` / `"boardRows"` when the request needs more
room.

## Simulation architecture

### Nets (src/sim/netlist.ts — sim-core)

Union-find: seed each hole's static net (`netIdForHole`), each off-board
terminal (`netIdForTerminal`), then merge across wires and catalog
`internalBridges`. Expose: `buildNetlist(layout)` →
`{ netOf(ref: EndpointRef): string|null, nets: string[], ground: string|null,
warnings }`. Ground = the net of the first `power_supply`'s `-` terminal
(else first `function_generator`'s `gnd`, else first net + warning).

### Solver (src/sim/mna.ts — sim-core)

Nodal analysis, **Norton-only** (no group-2 voltage-source rows): every
source is a Thevenin {v, rout} stamped as G = 1/rout, I = v/rout (power
supply rout = 0.01Ω). Matrix = pure conductance form, dense, solved with LU +
partial pivoting. Nonlinear devices (diodes, BJTs, MOSFETs) iterate
Newton-Raphson (≤ 40 iters, tol 1µV, with pn-junction voltage limiting for
convergence). Linear-only circuits factor once and reuse. Capacitors/inductors
use backward-Euler companion models.

### Chips (src/sim/chip-api.ts bridge)

Behavioral models step BEFORE each solve: read previous-step pin voltages,
update state, declare per-pin drives ({v, rout} Norton stamps). Conventions
(in chip-api.ts): logic threshold 0.5·VDD; push-pull rout 50Ω; open-drain
conducting {v:0, rout:25}; supply pin < 2V → release all outputs. Each chip
self-registers via `registerChip(model, factory)`; engine instantiates with
`createChip` after importing `src/sim/chips/all`.

### Engine (src/sim/engine.ts — sim-core) — EXACT public API

```ts
export const DEFAULT_DT = 5e-5 // seconds
export class SimEngine {
  constructor(layout: CircuitLayout)
  readonly issues: SimIssue[]            // static + runtime, deduped
  time: number
  step(dt?: number): void                // one step (default DEFAULT_DT)
  advance(seconds: number, dt?: number): void
  telemetry(): SimTelemetry
  /** live tweaks while running: pot position, switch state, pressed, light, voltage... */
  setRuntimeParam(componentId: string, key: string, value: ParamValue): void
  netVoltage(ref: EndpointRef): number   // NaN if unknown ref
}
```

Telemetry per component: pinVoltages always; `current` for 2-lead devices;
`ledBrightness` 0..1 (≈ I/10mA clamped); `burned` latches when LED current
> 30mA sustained for > 1ms (burned LEDs stop emitting light but still conduct);
`segments` for seven_segment; `outputs` from chips; `sounding` for buzzer
(|V| > 1). Issue examples: "no power supply", "no ground", "chip U1 VCC pin
not connected to a powered net" (checked statically), "LED D1 burned out
(current 80mA — add a series resistor)", "supply current > 2A (short
circuit?)".

Performance target: a 30-net circuit at dt=50µs must simulate ≥ 20k
steps/sec (reuse buffers; don't allocate per step).

### Devices (src/sim/devices.ts — sim-core)

resistor, capacitor, inductor, potentiometer (2 resistors), photoresistor
(R = 200Ω·10^(3·(1−light))), diode/led (Shockley, Is=1e-12, n=2 for LEDs with
per-color Vf via saturation scaling — red≈1.8V green≈2.2 yellow≈2.0 blue≈3.0
white≈3.2 at 10mA), npn/pnp (Ebers-Moll, β=150), nmos (square law, Vth=2,
k=0.1), pushbutton/slide_switch/dip_switch_8 (G = 20S closed / 1e-9S open),
seven_segment (8 LED junctions to COM), buzzer (300Ω + sounding flag),
power_supply (Thevenin 0.01Ω), function_generator (time-varying Thevenin 50Ω).

## 3D scene

Contract in `src/three/scene-api.ts`. Scene owns renderer/camera
(OrbitControls)/lights/board mesh/wires/ghost/picking; component visuals are
delegated to `component-meshes.ts` (`buildComponentObject` /
`updateComponentVisual`). Picking: raycast a y=0 plane and snap to the nearest
hole within 0.5 units (use breadboard.ts math); component bodies picked by
raycasting their groups (set `userData.componentId`).

**Unified wire + component routing**
(`src/three/internal/wire-router.ts` — pure geometry, no three.js imports,
node-tested; fed by `internal/wires.ts`): wires AND axial leaded parts
(resistor / diode / inductor — body dims from `routedBodyFor`) are planned
in ONE deterministic pass: components first (their rigid bodies become
collision samples other paths must clear), then wires, longest plan span
first, ids breaking ties. Endpoints always enter holes vertically; short
hops become low "staple" jumpers, longer runs flat-topped arcs; conflicts
walk a fixed cost-ordered candidate ladder where lateral mid-section dodges
are cheaper than lift tiers, so paths spread sideways before stacking
upward. A leaded part routes as a **span** (the rigid body reserved as a
straight, level segment on the flat top, collision-sampled as a fat
cylinder) or — under 3 plan units — a **vertical** stand-up mount (body
upright over hole A, hairpin lead over to B) with a deterministic lean
ladder (±0.12·n rad toward the plan axes) when upright bodies collide;
the lean is reported as `tilt`. `routeOne()` previews a single candidate
against the already-routed world without mutating it — the placement
hologram and the wire-drag preview show the same path the commit produces
(modulo exact span-length ties). `toRoutedPose()` converts a routed path
into the mesh builders' `RoutedComponent` render contract (body pose +
per-lead waypoint runs). Rendered wires are CatmullRom tubes along the
planned waypoints, colored.

Off-board instruments are router obstacles too: `routeAll(items, obstacles,
instruments?)` takes optional `InstrumentObstacle` boxes ({id, plan extents,
height ~4, terminals with per-post `exitDir`}). The boxes are
collision-checked like any component obstacle — wires can no longer noclip
through a PSU enclosure — and a wire whose ENDPOINT sits on an instrument
terminal gets a fixed EXIT SEGMENT: it rises from the post, then runs level
along the terminal's exitDir (away from the box face) for ≥ 1.5 units before
the normal staple/arc geometry begins, so a wire can never slice back
through the instrument it plugs into. The fixed exit prefix is exempt from
candidate evaluation (it cannot move) but its samples join the world grid so
later paths dodge it; `routeOne()` previews resolve the same exits from the
world's remembered instruments (preview = commit, instruments included).

**Placement & hover FX** (`internal/hologram.ts`, `internal/hole-fx.ts`):
the placement ghost is a hologram clone of the real part mesh (shader
scanlines + fresnel rim + flicker, all driven off one shared clock uniform;
cyan = valid, iOS red = invalid) with per-hole pin markers (glow ring +
light beam); with one hole picked, 2-lead parts ghost their full routed
pose (`GhostSpec.picked`). The hovered hole gets a springy glow ring plus a
pooled CanvasTexture coordinate chip ("e23"). Four 3D "+" grow paddles —
one per 2-D grid edge (select mode, sim stopped, axis below its
`MAX_BOARD_COUNT` / `MAX_BOARD_ROWS` cap) — grow the rig via the optional
`onGrowGrid(direction)` scene callback → `store.growGrid(direction)`;
`scene.setLayout` rebuilds the board for size, count and row changes and
springs new modules in.

**Edit drags** (scene-side gestures, select mode; the store stays the
validator): a drag starting on an already-selected part suspends
OrbitControls and translates the selection as a snapping hologram —
`onMovePreview(ids, target)` tints it valid/invalid against
`store.previewMove` and `onMoveCommit` lands it (`MoveTarget`: `{anchor}`
re-anchors one package, `{dCol, dRowLattice}` translates a group; wires
stay put). Shift+drag on empty board (desktop mouse) sweeps a screen-space
marquee → `onMarqueeSelect(ids)`; `onObjectClick(id, additive)` carries
shift/cmd for toggle-into-selection. Dragging a selected off-board
instrument snaps its bench anchor to the 0.5 grid with a validity-tinted
overlay box (`onInstrumentMovePreview` / `onInstrumentMoveCommit` →
`store.setInstrumentPos`). Tapping a body-occluded hole fires
`onHoleOcclusionRejected(hole)` so the app can name the covering part.

**Render modes** (`src/three/render-modes/`, spec + wiring contract in its
`RENDER-MODES.md`): the scene consumes one facade, `RenderModeManager` —
Performance (the untouched raster path, zero added cost), Enhanced (HDRI
IBL + SAO/bloom/SMAA composer), Studio (three-gpu-pathtracer progressive
path tracing of the same scene graph; raster fallback during interaction;
raster overlays composited live over the held still via the `bbNoStudio`
camera-layer pass). Enhanced and Studio are lazy-loaded chunks; mode
selection/persistence logic is pure and node-tested (`capability.ts`,
default phone → performance, desktop → enhanced, stored override under
`localStorage['bb.renderMode']`).

60 fps with ~100 components; dispose() must free all GPU resources.

## State & app loop (glue agent)

`src/state/store.ts` implements `src/state/types.ts` with zustand. Sim loop:
requestAnimationFrame; each frame advance the engine by (frame dt ×
simSpeed) of sim time using a step budget (≤ 8ms of wall time per frame —
if the budget is hit, sim time falls behind rather than freezing the UI).
Telemetry pushed to the scene every frame; React state updates throttled to
~10 Hz. Scope sampling: append (time, ch1..4 voltages from scope_probe
components) every sim millisecond, ring-buffered to the time window.
Autosave layout to localStorage (debounced) and restore on boot. API key in
localStorage (`bb.apiKey`).

Document edits flow through the in-memory undo history
(`src/state/history.ts`): every user-level edit — placement, wiring,
deletes (incl. group deletes), param changes, moves (`commitMove`,
all-or-nothing across the selected group), rotations (`rotateArmed` /
`rotatePlaced`), instrument repositioning (drag-coalesced), board
size/count/rows switches, `growGrid` (incl. the left/up hole-ref remap),
imports and AI applies — is exactly ONE undoable step. `selection` is an
id array (`select` / `toggleSelect` / `marqueeSelect` / `clearSelection`);
the persisted render-mode preference lives on the store as
`renderMode`/`setRenderMode` (`null` = device default). See
`src/state/types.ts` for the full annotated contract.

## LLM flow (llm agent)

`src/llm/` calls Claude **from the browser** with the user's key
(`claude-opus-4-8`). System prompt is built programmatically from CATALOG
(pin tables from the `pins` arrays + `doc` strings + the breadboard rules
above + 1 worked example layout). The model must return a CircuitLayout via
structured output (strict tool or output_config json_schema — confirm what the
installed SDK version supports by reading node_modules). Pipeline:
generate → `validateLayout()` (src/model/validate.ts) → if errors, send them
back for repair (≤ 2 retries) → return {layout, explanation}. Use streaming.
The validator is also used by import: it must catch bad hole refs (bounds
checked against the declared 2-D rig, board-row prefixes included), wrong
holes[] length, DIP anchors off row f, packages straddling a module seam,
invalid `rotation` values (non-quarter-turn anywhere; 90/270 on a DIP;
rotation on parts that cannot rotate), overlapping hole occupancy, pins or
wire ends landing under another part's body (occlusion), bad instrument
`pos` (off the 0.5 grid / body over the board / overlapping another
instrument), unknown types/params, duplicate ids, wires to nonexistent
endpoints, missing power supply (warning).

## Conventions

- TypeScript strict; no new runtime dependencies beyond package.json.
- Plain CSS in `src/ui/styles.css` (dark theme, CSS vars defined there).
- Verify with `npx tsc --noEmit` — ignore errors in files you don't own.
- Tests: `npx vitest run` (node env, no DOM needed for sim tests).
