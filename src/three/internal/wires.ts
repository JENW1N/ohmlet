/**
 * Wire + leaded-component visuals: color resolution, unified collision-aware
 * route planning, and tube geometry.
 *
 * Routing is delegated to the PURE planner in wire-router.ts. The scene calls
 * planRoutes() once per setLayout — ONE routeAll() pass routes the axial
 * leaded components (resistor / diode / inductor, as first-class fat bodies)
 * AND every wire of the layout together, so wires dodge component bodies and
 * each other, short leaded parts become vertical mounts, and long ones fly
 * level spans. Off-board instruments join the pass as obstacle boxes with
 * terminal exits (instrumentsForLayout — explicit `comp.pos` honored), so
 * committed wires AND previews clear instrument bodies and exit their own
 * unit's posts cleanly. Results are cached by an endpoint+obstacle+instrument
 * signature; nothing is recomputed when the layout signature is unchanged.
 *
 * Consumers:
 *  - wireGeometry() renders a wire's cached route as a CatmullRom tube
 *    (legacy raised arc when un-routed).
 *  - routedComponentPose() / routedComponentSignature() feed the planned body
 *    pose into component-meshes' buildComponentObject (and the scene's
 *    rebuild diff).
 *  - previewWireGeometry() / previewComponentPose() run routeOne() against
 *    the cached world for live previews (wire drag, holographic ghost).
 *    routeOne simulates the candidate's true routeAll sort position (a
 *    component ghost ignores wires, exactly as the commit pass does; a wire
 *    only sees components and longer wires), so the preview IS the
 *    candidate's final committed path — already-placed wires may still
 *    re-route around it after commit, and an exact span-length tie can
 *    break differently (routeAll ties by id, unknowable at preview time).
 */

import * as THREE from 'three'
import type { CircuitLayout, ComponentInstance, Wire } from '../../model/types'
import { boardConfigOf } from '../../model/types'
import {
  OFFBOARD_BODY_HEIGHT,
  componentPinHoles,
  holePosition,
  offboardBodyRect,
  offboardTerminalPosition,
  parseHole,
  parseTerminalRef,
} from '../../model/breadboard'
import { getEntry, paramOf, type CatalogEntry } from '../../model/catalog'
import {
  routeAll,
  routeOne,
  toRoutedPose,
  type InstrumentObstacle,
  type RouteItemInput,
  type RouteObstacle,
  type RoutePoint,
  type RoutedComponent,
  type RoutedComponentPath,
  type RoutedWire,
  type RoutedWorld,
} from './wire-router'

/** y of the top of an off-board terminal post (wire attachment point). */
export const TERMINAL_TOP_Y = 0.7

/** Jumper-wire palette used when a wire has no (valid) explicit color. */
const PALETTE = [
  '#d6453a', // red
  '#2e62d9', // blue
  '#2fa84f', // green
  '#e8b73a', // yellow
  '#8e44ad', // purple
  '#e07b2f', // orange
  '#1fb1a9', // teal
  '#33353a', // black
  '#9aa0a8', // grey
  '#d44f9e', // pink
]

const HEX_RE = /^#([0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/

/**
 * Real PVC insulation tones for the common DSL color NAMES. Passing names
 * straight to THREE.Color gives maximally-saturated CSS primaries ('red' =
 * #ff0000, 'blue' = #0000ff) that read as neon licorice under the ACES
 * pipeline — actual jumper PVC is pigmented, desaturated plastic. Aligned
 * with the hashed-id PALETTE above so named and palette wires look like one
 * kit. Explicit hex strings still pass through untouched.
 */
const PVC_NAMES: Record<string, string> = {
  red: '#c23b32',
  blue: '#2e62d9',
  green: '#2fa84f',
  yellow: '#e8b73a',
  orange: '#e07b2f',
  purple: '#8e44ad',
  violet: '#8e44ad',
  teal: '#1fb1a9',
  cyan: '#1fb1a9',
  black: '#33353a',
  white: '#e6e3da',
  gray: '#9aa0a8',
  grey: '#9aa0a8',
  brown: '#8a5a33',
  pink: '#d44f9e',
}

function hashString(s: string): number {
  let h = 0
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0
  return Math.abs(h)
}

/** Wire color: wire.color if it is a valid css name / hex (common jumper
 *  names mapped to PVC tones), else a palette hash by id. */
export function wireColorFor(wire: Wire): THREE.Color {
  const c = wire.color?.trim().toLowerCase()
  if (c) {
    if (HEX_RE.test(c)) return new THREE.Color(c)
    const pvc = PVC_NAMES[c]
    if (pvc) return new THREE.Color(pvc)
    if (c in THREE.Color.NAMES) return new THREE.Color(c)
  }
  return new THREE.Color(PALETTE[hashString(wire.id) % PALETTE.length])
}

// ---------------------------------------------------------------------------
// Routed component bodies (axial leaded parts the router owns)
// ---------------------------------------------------------------------------

/**
 * Rigid-body dimensions (plan units) fed to the router per AXIAL leaded type.
 * The router reserves a straight body segment of `length` on span routes /
 * stands it upright for short spans, and collision-samples it as a fat
 * cylinder of `diameter`. The mesh builders infer the rendered body length
 * from the routed lead exits, so these must sit inside their clamp ranges
 * (resistor 0.9..2.4, diode 0.7..1.3, inductor 1.2..2.6 — meshes/passives.ts).
 *
 * Most standing/radial parts (LDR, TO-92, pot, switches) keep their classic
 * pins-derived placement and stay obstacle BOXES instead.
 *
 * LEDs and capacitors are the exception (`standing`): the user-reported
 * packed-part noclip (two of them in neighboring columns share volume —
 * DESIGN.md §4b) needs the router's lift-tier + lateral ladder, so they
 * route as standing span bodies (rendered upright at the routed center;
 * meshes/semis.ts + passives.ts consume the pose and lead runs). `standing`
 * = the body's full vertical extent measured from 0.45 below the routed
 * center (LED: flange ≈ center−0.40 through dome top ≈ center+0.98;
 * electrolytic can ≈ center±0.7). diameter 0.8 is deliberately under the
 * physical girth: the router's clearance demand (0.45 + rA + rB = 1.45)
 * then lands right at the no-touch band of the ladder's reachable plan
 * separations, so packed parts NEST (one column over, half a tier up)
 * instead of scattering skyward. Standing types also KEEP their obstacle
 * box below — the router endpoint-skips a box for any item plugged inside
 * it, so the box never fights the part's own route but still walls wires
 * off the body.
 */
const ROUTED_BODY: Record<string, { length: number; diameter: number; standing?: number }> = {
  resistor: { length: 2.2, diameter: 0.8 },
  diode: { length: 1.1, diameter: 0.55 },
  inductor: { length: 2.0, diameter: 0.8 },
  led: { length: 1.5, diameter: 0.8, standing: 1.45 },
  capacitor: { length: 1.2, diameter: 0.8, standing: 1.2 },
}

/** Router body dims for a type routed as a first-class component, else null. */
export function routedBodyFor(type: string): { length: number; diameter: number } | null {
  return ROUTED_BODY[type] ?? null
}

// ---------------------------------------------------------------------------
// Obstacle derivation (component bodies wires must fly over)
// ---------------------------------------------------------------------------

/** plan margin added around a component's hole bbox */
const OBSTACLE_MARGIN = 0.4
/** body heights by package: DIP/displays, leaded parts, buttons (footprint) */
const DIP_HEIGHT = 1.7
const LEADS_HEIGHT = 1.2
const BUTTON_HEIGHT = 1.1
/**
 * Leaded parts taller than the generic 1.2 envelope. The router only keeps
 * wires above height + 0.35, so each entry must be ≥ the actual mesh top
 * (src/three/meshes/*): LED dome 1.83 (semis.ts), TO-92 body ~1.8 (semis.ts),
 * slide-switch lever 1.88 (switches.ts), pot knob slot ~1.83 (passives.ts).
 */
const TALL_LEADS_HEIGHTS: Record<string, number> = {
  led: 1.9,
  npn: 1.85,
  pnp: 1.85,
  nmos: 1.85,
  slide_switch: 1.9,
  potentiometer: 1.9,
}
/** electrolytic can top = 1.55 (passives.ts) — the flat 1.2 left zero margin */
const ELECTROLYTIC_HEIGHT = 1.6
/** vertical hole-entry rise — must match wire-router's ENTRY_RISE */
const ENTRY_RISE = 0.5

/** Obstacle height of a 'leads' part, matched to its actual mesh top. */
function leadsHeightFor(comp: ComponentInstance, entry: CatalogEntry): number {
  if (comp.type === 'capacitor' && paramOf(comp.params, entry, 'polarized') === true) {
    return ELECTROLYTIC_HEIGHT // matches buildCapacitor's electrolytic branch
  }
  return TALL_LEADS_HEIGHTS[comp.type] ?? LEADS_HEIGHT
}

/**
 * Obstacle boxes for every on-board component body in the layout (probes and
 * off-board instruments are skipped — they never obstruct board wiring; the
 * axial ROUTED_BODY types are skipped too: the router collision-samples their
 * planned bodies directly, which replaces the box).
 */
export function obstaclesForLayout(layout: CircuitLayout): RouteObstacle[] {
  const out: RouteObstacle[] = []
  // resolve pin holes against the layout's ACTUAL rig: with the default
  // ('standard' × 1) config, parts beyond column 63 on a Lab XL (or second
  // module) would read as malformed and produce no collision obstacles
  const board = boardConfigOf(layout)
  for (const comp of layout.components) {
    const entry = getEntry(comp.type)
    if (!entry || entry.placement === 'offboard' || entry.placement === 'probe') continue
    // axial routed bodies replace their box outright; STANDING routed bodies
    // (LED) keep the box as well — it walls wires off the dome (the router
    // endpoint-skips it for the LED's own route and for parts plugged
    // alongside, which then dodge the sampled body column instead)
    const routedBody = ROUTED_BODY[comp.type]
    if (routedBody && !routedBody.standing) continue
    const holes = componentPinHoles(comp, entry, board)
    if (!holes) continue
    let minX = Infinity
    let maxX = -Infinity
    let minZ = Infinity
    let maxZ = -Infinity
    for (const h of holes) {
      if (!h) continue
      const p = holePosition(h)
      if (p.x < minX) minX = p.x
      if (p.x > maxX) maxX = p.x
      if (p.z < minZ) minZ = p.z
      if (p.z > maxZ) maxZ = p.z
    }
    if (minX > maxX) continue
    const height =
      entry.placement === 'dip'
        ? DIP_HEIGHT
        : entry.placement === 'footprint'
          ? BUTTON_HEIGHT
          : leadsHeightFor(comp, entry)
    out.push({
      minX: minX - OBSTACLE_MARGIN,
      maxX: maxX + OBSTACLE_MARGIN,
      minZ: minZ - OBSTACLE_MARGIN,
      maxZ: maxZ + OBSTACLE_MARGIN,
      height,
    })
  }
  return out
}

/**
 * Off-board instruments (PSU, function generator) as router obstacle boxes
 * with terminal exits, slot-ordered exactly like the endpoint resolver and
 * the scene's record builder (explicit `comp.pos` honored everywhere). The
 * boxes keep wires from noclipping through an enclosure; each terminal's
 * exitDir points +z (off the front face, where the posts sit) so a wire
 * plugged into a post first runs AWAY from the box before arcing onward.
 */
export function instrumentsForLayout(layout: CircuitLayout): InstrumentObstacle[] {
  const out: InstrumentObstacle[] = []
  let slot = 0
  for (const comp of layout.components) {
    const entry = getEntry(comp.type)
    if (entry?.placement !== 'offboard') continue
    const mySlot = slot++
    const rect = offboardBodyRect(mySlot, comp.pos)
    out.push({
      id: comp.id,
      ...rect,
      height: OFFBOARD_BODY_HEIGHT,
      terminals: entry.pins.map((_pin, i) => {
        const p = offboardTerminalPosition(mySlot, i, comp.pos)
        return { x: p.x, z: p.z, exitDir: { x: 0, z: 1 } }
      }),
    })
  }
  return out
}

// ---------------------------------------------------------------------------
// Route planning cache (one unified routing pass per layout change)
// ---------------------------------------------------------------------------

interface CachedWireRoute {
  route: RoutedWire
  /** endpoint signature the route was computed for (stale-lookup guard) */
  key: string
  /** endpoint heights (terminal posts attach above the board plane) */
  ya: number
  yb: number
}

interface CachedComponentRoute {
  pose: RoutedComponent
  /** stable pose hash — folds into the scene's component rebuild signature */
  sig: string
}

let wireRouteCache = new Map<string, CachedWireRoute>()
let compRouteCache = new Map<string, CachedComponentRoute>()
let plannedWorld: RoutedWorld | null = null
let planSignature = ''
let planVersionCounter = 0

function endpointKey(a: THREE.Vector3, b: THREE.Vector3): string {
  return (
    `${a.x.toFixed(3)},${a.y.toFixed(3)},${a.z.toFixed(3)}|` +
    `${b.x.toFixed(3)},${b.y.toFixed(3)},${b.z.toFixed(3)}`
  )
}

/** Stable little hash of a routed item's waypoints (rebuild-diff signatures). */
function waypointHash(pts: readonly RoutePoint[]): string {
  let h = 0
  for (const p of pts) {
    h = (h * 31 + Math.round(p.x * 100)) | 0
    h = (h * 31 + Math.round(p.y * 100)) | 0
    h = (h * 31 + Math.round(p.z * 100)) | 0
  }
  return (h >>> 0).toString(36)
}

/**
 * Pure endpoint resolution for planning (no scene records needed): board
 * holes at y = 0; off-board terminals at their post tops, positioned by the
 * component's slot among the layout's off-board components — identical to the
 * scene's attach points, so plan inputs and rendered wires always agree.
 */
function makeEndpointResolver(
  layout: CircuitLayout,
): (ref: string) => { x: number; y: number; z: number } | null {
  const offboard = new Map<
    string,
    { slot: number; entry: CatalogEntry; pos?: { x: number; z: number } }
  >()
  let slot = 0
  for (const comp of layout.components) {
    const entry = getEntry(comp.type)
    if (entry?.placement === 'offboard') {
      offboard.set(comp.id, { slot: slot++, entry, pos: comp.pos })
    }
  }
  return (ref) => {
    const hole = parseHole(ref)
    if (hole) {
      const p = holePosition(hole)
      return { x: p.x, y: 0, z: p.z }
    }
    const term = parseTerminalRef(ref)
    if (!term) return null
    const rec = offboard.get(term.componentId)
    if (!rec) return null
    const pinIdx = rec.entry.pins.indexOf(term.pin)
    if (pinIdx < 0) return null
    // explicit instrument pos (movable instruments) overrides the slot shelf
    const p = offboardTerminalPosition(rec.slot, pinIdx, rec.pos)
    return { x: p.x, y: TERMINAL_TOP_Y, z: p.z }
  }
}

const tmpA = new THREE.Vector3()
const tmpB = new THREE.Vector3()

/**
 * Route the whole layout — axial leaded components AND wires — in one
 * collision-aware routeAll() pass, and cache the result. Idempotent: when
 * endpoints, bodies and obstacles are unchanged the cached routes are kept
 * as-is. The scene calls this at the top of every setLayout sync (it needs
 * no scene state: terminal positions resolve from the layout alone).
 */
export function planRoutes(layout: CircuitLayout): void {
  const resolve = makeEndpointResolver(layout)
  const board = boardConfigOf(layout)

  const items: RouteItemInput[] = []
  const compIds: string[] = []
  const wireMetas: { id: string; key: string; ya: number; yb: number }[] = []
  const sigParts: string[] = []

  for (const comp of layout.components) {
    const body = ROUTED_BODY[comp.type]
    if (!body) continue
    const entry = getEntry(comp.type)
    if (!entry || entry.pins.length < 2) continue
    const holes = componentPinHoles(comp, entry, board)
    if (!holes || !holes[0] || !holes[1]) continue
    const a = holePosition(holes[0])
    const b = holePosition(holes[1])
    items.push({
      id: comp.id,
      kind: 'component',
      ax: a.x,
      az: a.z,
      bx: b.x,
      bz: b.z,
      body,
    })
    compIds.push(comp.id)
    sigParts.push(
      `c${comp.id}@${a.x.toFixed(3)},${a.z.toFixed(3)}|${b.x.toFixed(3)},${b.z.toFixed(3)}` +
        `#${body.length},${body.diameter},${body.standing ?? 0}`,
    )
  }

  for (const wire of layout.wires) {
    const a = resolve(wire.from)
    const b = resolve(wire.to)
    if (!a || !b) continue // unresolvable endpoint → no visual → no route
    items.push({ id: wire.id, ax: a.x, az: a.z, bx: b.x, bz: b.z })
    tmpA.set(a.x, a.y, a.z)
    tmpB.set(b.x, b.y, b.z)
    wireMetas.push({ id: wire.id, key: endpointKey(tmpA, tmpB), ya: a.y, yb: b.y })
    sigParts.push(`w${wire.id}@${endpointKey(tmpA, tmpB)}`)
  }

  const obstacles = obstaclesForLayout(layout)
  for (const o of obstacles) {
    sigParts.push(
      `o${o.minX.toFixed(2)},${o.maxX.toFixed(2)},${o.minZ.toFixed(2)},${o.maxZ.toFixed(2)},${o.height}`,
    )
  }
  // instrument boxes + terminal exits fold into the plan signature too: a
  // dragged PSU (comp.pos change) must replan every wire around its new box
  const instruments = instrumentsForLayout(layout)
  for (const inst of instruments) {
    sigParts.push(
      `i${inst.id}@${inst.minX.toFixed(2)},${inst.maxX.toFixed(2)},` +
        `${inst.minZ.toFixed(2)},${inst.maxZ.toFixed(2)}` +
        `#${inst.terminals.map((t) => `${t.x.toFixed(2)},${t.z.toFixed(2)}`).join('|')}`,
    )
  }
  const signature = sigParts.join(';')
  if (signature === planSignature && plannedWorld) return
  planSignature = signature
  planVersionCounter++

  const world = routeAll(items, obstacles, instruments)
  plannedWorld = world

  compRouteCache = new Map()
  for (const id of compIds) {
    const item = world.get(id)
    if (!item || !('bodyCenter' in item)) continue
    const path = item as RoutedComponentPath
    const pose = toRoutedPose(path)
    const sig =
      `${path.style}${waypointHash(path.waypoints)}` +
      `${Math.round(path.bodyCenter.y * 100)},${Math.round(path.bodyDir.y * 100)}`
    compRouteCache.set(id, { pose, sig })
  }

  wireRouteCache = new Map()
  for (const meta of wireMetas) {
    const item = world.get(meta.id)
    if (!item || 'bodyCenter' in item) continue
    wireRouteCache.set(meta.id, {
      route: item as RoutedWire,
      key: meta.key,
      ya: meta.ya,
      yb: meta.yb,
    })
  }
}

/**
 * Monotonic plan generation — changes whenever planRoutes() recomputed the
 * routed world. Previews (ghost holograms) fold it into their dedupe
 * signatures so they re-route when the world changes under them.
 */
export function planVersion(): number {
  return planVersionCounter
}

/**
 * Stable signature of a wire's routed path (changes when re-planning moved
 * the wire because of OTHER wires/obstacles). The scene folds this into its
 * wire diff signature so stale tubes rebuild. '' when no route is cached.
 */
export function routedWireSignature(wireId: string, a: THREE.Vector3, b: THREE.Vector3): string {
  const rec = wireRouteCache.get(wireId)
  if (!rec || rec.key !== endpointKey(a, b)) return ''
  return `${rec.route.style}${waypointHash(rec.route.waypoints)}`
}

/**
 * Router-planned pose for an axial leaded component (null when the part is
 * not routed — wrong type, malformed holes, or planRoutes not run yet). The
 * scene passes this straight into buildComponentObject's `routed` parameter.
 */
export function routedComponentPose(componentId: string): RoutedComponent | null {
  return compRouteCache.get(componentId)?.pose ?? null
}

/**
 * Stable signature of a component's routed pose ('' when un-routed). The
 * scene folds this into its component rebuild signature so a part whose body
 * pose moved (because OTHER parts/wires forced a re-route) rebuilds its mesh.
 */
export function routedComponentSignature(componentId: string): string {
  return compRouteCache.get(componentId)?.sig ?? ''
}

// ---------------------------------------------------------------------------
// Geometry
// ---------------------------------------------------------------------------

/**
 * Exposed tinned tip at board-hole entries: the colored insulation tube STOPS
 * this far above the hole and a bare metal pin (scene-built) continues down
 * into the recessed socket — real jumpers always show ~5mm of stripped wire
 * at the hole. Terminal-post endpoints keep their insulated ends.
 */
export const WIRE_TIP_LEN = 0.42
/** how far the bare pin sinks below the board face, into the socket bore */
export const WIRE_TIP_SINK = 0.18

/** Arc apex height above the endpoints: min 0.8, 0.10× the horizontal run,
 *  capped at 2.2 (mirrors wire-router's board-hugging arc spec). */
export function arcHeight(a: THREE.Vector3, b: THREE.Vector3): number {
  const run = Math.hypot(b.x - a.x, b.z - a.z)
  return Math.min(2.2, Math.max(0.8, run * 0.1))
}

/** Raised quadratic arc between two endpoints (unrouted fallback). */
export function wireCurve(a: THREE.Vector3, b: THREE.Vector3): THREE.QuadraticBezierCurve3 {
  const h = arcHeight(a, b)
  // Quadratic bezier apex at t=0.5 is (a + 2c + b) / 4 → lift the control point
  // by 2h so the wire crests ~h above the higher endpoint.
  const ctrl = new THREE.Vector3(
    (a.x + b.x) / 2,
    Math.max(a.y, b.y) + 2 * h,
    (a.z + b.z) / 2,
  )
  return new THREE.QuadraticBezierCurve3(a.clone(), ctrl, b.clone())
}

/**
 * CatmullRom through routed waypoints, ends lifted to terminal posts.
 * Board-hole ends (y = 0) are TRIMMED to WIRE_TIP_LEN: the insulation tube
 * stops above the hole and the scene's bare tip pin carries on into the
 * socket — exactly like a real jumper's stripped end.
 */
function routedCurve(
  waypoints: readonly RoutePoint[],
  ya: number,
  yb: number,
): THREE.CatmullRomCurve3 {
  const pts = waypoints.map((p) => new THREE.Vector3(p.x, p.y, p.z))
  if (pts.length >= 2) {
    if (ya !== 0) {
      pts[0].y += ya
      pts[1].y = Math.max(pts[1].y, ya + ENTRY_RISE)
    } else {
      pts[0].y = WIRE_TIP_LEN // stripped tip below the insulation
    }
    if (yb !== 0) {
      pts[pts.length - 1].y += yb
      pts[pts.length - 2].y = Math.max(pts[pts.length - 2].y, yb + ENTRY_RISE)
    } else {
      pts[pts.length - 1].y = WIRE_TIP_LEN
    }
  }
  return new THREE.CatmullRomCurve3(pts, false, 'centripetal')
}

function routedTube(
  waypoints: readonly RoutePoint[],
  ya: number,
  yb: number,
  run: number,
  radius: number,
): THREE.TubeGeometry {
  const segments = Math.max(16, Math.min(96, Math.round((run + 6) * 2)))
  return new THREE.TubeGeometry(routedCurve(waypoints, ya, yb), segments, radius, 8, false)
}

/**
 * Tube geometry along the wire's routed path (when `wireId` has a cached
 * route for these endpoints) or the legacy raised arc. Caller owns disposal.
 */
export function wireGeometry(
  a: THREE.Vector3,
  b: THREE.Vector3,
  radius: number,
  wireId?: string,
): THREE.TubeGeometry {
  const run = Math.hypot(b.x - a.x, b.z - a.z)
  const rec = wireId !== undefined ? wireRouteCache.get(wireId) : undefined
  if (rec && rec.key === endpointKey(a, b)) {
    return routedTube(rec.route.waypoints, rec.ya, rec.yb, run, radius)
  }
  const segments = Math.max(12, Math.min(64, Math.round((run + 4) * 1.5)))
  return new THREE.TubeGeometry(wireCurve(a, b), segments, radius, 8, false)
}

// ---------------------------------------------------------------------------
// Previews (routeOne at the candidate's true commit sort position against the
// cached world — the preview IS the candidate's final path)
// ---------------------------------------------------------------------------

/**
 * Wire-drawing preview geometry: the dragged wire candidate is routed with
 * routeOne() against the planned world at its true commit sort position, so
 * the preview shows the exact collision-aware path the committed wire will
 * take (existing wires may still re-route around it on commit). Falls back to
 * the legacy raised arc when no world is planned yet. Caller owns disposal.
 */
export function previewWireGeometry(
  a: THREE.Vector3,
  b: THREE.Vector3,
  radius: number,
): THREE.TubeGeometry {
  const run = Math.hypot(b.x - a.x, b.z - a.z)
  if (plannedWorld && run > 1e-6) {
    const item = routeOne(plannedWorld, {
      id: ' preview', // placeholder (NUL prefix) — never collides with a user id
      ax: a.x,
      az: a.z,
      bx: b.x,
      bz: b.z,
    })
    if (!('bodyCenter' in item)) {
      return routedTube((item as RoutedWire).waypoints, a.y, b.y, run, radius)
    }
  }
  const segments = Math.max(12, Math.min(64, Math.round((run + 4) * 1.5)))
  return new THREE.TubeGeometry(wireCurve(a, b), segments, radius, 8, false)
}

/**
 * Ghost-placement preview pose for an axial leaded part stretching plan point
 * a → b: routeOne() against the planned world returns the FINAL routed pose
 * (vertical mount for short spans included) — wires are invisible to a
 * component candidate, exactly as in the commit pass where components route
 * before all wires, so the ghost lands in the same pose the committed part
 * will. Null when the type is not routed, the span is degenerate, or no
 * world is planned yet.
 */
export function previewComponentPose(
  type: string,
  a: { x: number; z: number },
  b: { x: number; z: number },
): RoutedComponent | null {
  const body = ROUTED_BODY[type]
  if (!body || !plannedWorld) return null
  if (Math.hypot(b.x - a.x, b.z - a.z) < 1e-6) return null
  const item = routeOne(plannedWorld, {
    id: ' ghost',
    kind: 'component',
    ax: a.x,
    az: a.z,
    bx: b.x,
    bz: b.z,
    body,
  })
  if (!('bodyCenter' in item)) return null
  return toRoutedPose(item as RoutedComponentPath)
}
