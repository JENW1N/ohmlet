/**
 * Close-up mesh-gate manifest generator (run via `npx vite-node`).
 *
 * Script-generates a showcase layout containing EVERY catalog component type
 * (valid placements on a Lab XL board, checked with validateLayout), then
 * computes a per-component-type close-up camera pose from the part's actual
 * pin holes via the model helpers (holePosition / componentPinHoles /
 * offboardTerminalPosition). Prints a JSON manifest to stdout for
 * scripts/closeups.mjs to drive through the `?shotrig` camera hook.
 */

import { CATALOG, getEntry } from '../src/model/catalog'
import {
  componentPinHoles,
  holePosition,
  offboardTerminalPosition,
} from '../src/model/breadboard'
import { validateLayout } from '../src/model/validate'
import type { CircuitLayout, ComponentInstance } from '../src/model/types'

// ------------------------------------------------------- showcase layout

// Channel parts (dip/footprint) packed left→right along the Lab XL channel.
const components: ComponentInstance[] = [
  // off-board instruments first (slot order = layout order)
  { id: 'PS1', type: 'power_supply', params: { voltage: 5 } },
  { id: 'FG1', type: 'function_generator', params: { waveform: 'sine', frequency: 50 } },
  // DIP ICs straddling the channel
  { id: 'U1', type: 'ne555', at: 'f2' },
  { id: 'U2', type: 'lm358', at: 'f7' },
  { id: 'U3', type: 'sn7400', at: 'f12' },
  { id: 'U4', type: 'sn7404', at: 'f20' },
  { id: 'U5', type: 'sn7408', at: 'f28' },
  { id: 'U6', type: 'sn7432', at: 'f36' },
  { id: 'U7', type: 'sn7486', at: 'f44' },
  { id: 'U8', type: 'sn7474', at: 'f52' },
  { id: 'U9', type: 'cd4017', at: 'f60' },
  { id: 'U10', type: 'cd4026', at: 'f69' },
  { id: 'U11', type: 'cd4511', at: 'f78' },
  { id: 'U12', type: 'sn74193', at: 'f87' },
  { id: 'U13', type: 'cd4040', at: 'f96' },
  { id: 'DS1', type: 'seven_segment', at: 'f105' },
  { id: 'SW2', type: 'dip_switch_8', at: 'f111', params: { on: '10110010' } },
  { id: 'BTN1', type: 'pushbutton', at: 'f120' },
  // leaded parts along row i (bottom block, clear of the channel)
  { id: 'R1', type: 'resistor', params: { resistance: 4700 }, holes: ['i2', 'i7'] },
  { id: 'C1', type: 'capacitor', params: { capacitance: 1e-7 }, holes: ['i10', 'i12'] },
  {
    id: 'C2',
    type: 'capacitor',
    params: { capacitance: 1e-4, polarized: true },
    holes: ['i15', 'i17'],
  },
  { id: 'L1', type: 'inductor', holes: ['i20', 'i24'] },
  { id: 'VR1', type: 'potentiometer', holes: ['i27', 'i29', 'i31'] },
  { id: 'LDR1', type: 'photoresistor', holes: ['i34', 'i36'] },
  { id: 'D1', type: 'diode', holes: ['i39', 'i42'] },
  { id: 'D2', type: 'led', params: { color: 'red' }, holes: ['i45', 'i47'] },
  { id: 'Q1', type: 'npn', holes: ['i50', 'i51', 'i52'] },
  { id: 'Q2', type: 'pnp', holes: ['i55', 'i56', 'i57'] },
  { id: 'Q3', type: 'nmos', holes: ['i60', 'i61', 'i62'] },
  { id: 'SW1', type: 'slide_switch', holes: ['i65', 'i67', 'i69'] },
  { id: 'BZ1', type: 'buzzer', holes: ['i72', 'i75'] },
  { id: 'P1', type: 'scope_probe', holes: ['i78'] },
  // the user-acceptance "2-hole resistor" — must render as a clean vertical mount
  { id: 'R2', type: 'resistor', params: { resistance: 220 }, holes: ['i81', 'i83'] },
]

const layout: CircuitLayout = {
  version: 1,
  name: 'mesh-gate showcase',
  board: 'labxl',
  components,
  wires: [
    { id: 'w1', from: 'PS1:+', to: 'top+0', color: 'red' },
    { id: 'w2', from: 'PS1:-', to: 'top-0', color: 'black' },
    { id: 'w3', from: 'FG1:out', to: 'a1', color: 'yellow' },
    { id: 'w4', from: 'FG1:gnd', to: 'top-1', color: 'black' },
  ],
}

// every catalog type must appear at least once
const placedTypes = new Set(components.map((c) => c.type))
const missing = Object.keys(CATALOG).filter((t) => !placedTypes.has(t))
if (missing.length > 0) {
  throw new Error(`showcase layout is missing catalog types: ${missing.join(', ')}`)
}

const res = validateLayout(layout)
if (res.errors.length > 0) {
  throw new Error(`showcase layout invalid:\n${res.errors.map((e) => `  - ${e}`).join('\n')}`)
}

// ------------------------------------------------------- camera poses

interface Shot {
  /** shots/closeup-<name>.png */
  name: string
  /** [px, py, pz, tx, ty, tz] — null = keep the app's own framing */
  cam: [number, number, number, number, number, number] | null
}

/** unit-ish close-up view direction (target → camera): low front-right 3/4 */
const VIEW = { x: 0.42, y: 0.78, z: 1.0 }
const VIEW_LEN = Math.hypot(VIEW.x, VIEW.y, VIEW.z)

function poseFor(comp: ComponentInstance): [number, number, number, number, number, number] {
  const entry = getEntry(comp.type)
  if (!entry) throw new Error(`unknown type ${comp.type}`)

  if (entry.placement === 'offboard') {
    // instrument box: terminals give the slot; the body stands behind them
    const offboard = components.filter((c) => getEntry(c.type)?.placement === 'offboard')
    const slot = offboard.findIndex((c) => c.id === comp.id)
    const t0 = offboardTerminalPosition(slot, 0)
    const t1 = offboardTerminalPosition(slot, 1)
    const cx = (t0.x + t1.x) / 2
    const frontZ = t0.z - 0.8
    if (slot === offboard.length - 1) {
      // nearest unit: raised frontal 3/4 — screen lettering AND posts read
      return [cx + 2.2, 6.8, frontZ + 10.5, cx, 1.1, frontZ + 0.3]
    }
    // a later slot's box stands in front (+z): come in over the left diagonal
    return [cx - 9, 6.5, frontZ + 6.5, cx - 0.5, 1.0, frontZ + 0.3]
  }

  const holes = componentPinHoles(comp, entry, { size: 'labxl', count: 1 })
  if (!holes) throw new Error(`componentPinHoles failed for ${comp.id}`)
  const pts = holes.flatMap((h) => (h ? [holePosition(h)] : []))
  if (pts.length === 0) throw new Error(`no holes for ${comp.id}`)
  const cx = pts.reduce((s, p) => s + p.x, 0) / pts.length
  const cz = pts.reduce((s, p) => s + p.z, 0) / pts.length
  let spread = 0
  for (const a of pts) for (const b of pts) spread = Math.max(spread, Math.hypot(a.x - b.x, a.z - b.z))

  // vertical mounts and DIP bodies want a slightly higher look-at point
  const span2 = comp.holes?.length === 2 && spread < 3
  const ty = span2 ? 1.1 : 0.45
  if (entry.placement === 'leads' || entry.placement === 'probe') {
    // wide box-bodied parts (trimmer pot, slide switch): pull back + orbit
    // higher so the body top (knob / slot) reads instead of one slab face
    const boxy = comp.type === 'potentiometer' || comp.type === 'slide_switch'
    if (boxy) {
      const dist = 4.6 + spread * 1.05
      const dir = { x: 0.55, y: 0.95, z: 1.0 }
      const k = dist / Math.hypot(dir.x, dir.y, dir.z)
      return [cx + dir.x * k, ty + dir.y * k, cz + dir.z * k, cx, ty, cz]
    }
    // small free-standing parts: closer + lower orbit so the package reads
    const dist = Math.max(3.0, 2.3 + spread * 0.8)
    const dir = { x: 0.5, y: 0.52, z: 1.0 }
    const k = dist / Math.hypot(dir.x, dir.y, dir.z)
    return [cx + dir.x * k, ty + dir.y * k, cz + dir.z * k, cx, ty, cz]
  }
  const dist = Math.min(13, Math.max(5.5, 4.6 + spread * 0.95))
  const k = dist / VIEW_LEN
  return [cx + VIEW.x * k, ty + VIEW.y * k, cz + VIEW.z * k, cx, ty, cz]
}

const shots: Shot[] = [{ name: 'overview', cam: null }]
const seen = new Set<string>()
for (const comp of components) {
  // one close-up per catalog type, plus the named special cases
  let name = comp.type
  if (comp.id === 'C2') name = 'capacitor-electrolytic'
  else if (comp.id === 'R2') name = 'resistor-vertical'
  else if (seen.has(comp.type)) continue
  seen.add(comp.type)
  shots.push({ name, cam: poseFor(comp) })
}

// ---------------------- example sweeps (interpenetration review close-ups)

/** 3/4 sweep pose centered on board column x (standard board, z mid 8). */
function sweepPose(x: number): [number, number, number, number, number, number] {
  const k = 17 / VIEW_LEN
  return [x + VIEW.x * k, 0.5 + VIEW.y * k, 8 + VIEW.z * k, x, 0.5, 8]
}

const examples: { file: string; shots: Shot[] }[] = [
  {
    file: 'date-display',
    shots: [
      { name: 'example-date-display', cam: null },
      { name: 'example-date-display-left', cam: sweepPose(11) },
      { name: 'example-date-display-mid', cam: sweepPose(31) },
      { name: 'example-date-display-right', cam: sweepPose(52) },
    ],
  },
  {
    file: 'counter',
    shots: [
      { name: 'example-counter', cam: null },
      { name: 'example-counter-left', cam: sweepPose(12) },
      { name: 'example-counter-right', cam: sweepPose(27) },
    ],
  },
]

process.stdout.write(JSON.stringify({ layout, shots, examples }, null, 2))
