/**
 * Smart collision-free routing for wires AND leaded components.
 *
 * PURE geometry module — no three.js imports, fully node-testable. The
 * scene's wires.ts feeds it endpoint plan positions plus component-body
 * obstacle boxes and renders the returned waypoint paths as CatmullRom tubes.
 *
 * Wire algorithm: wires are routed one at a time, longest plan span first
 * (ties broken by id ascending → fully deterministic). Endpoints always enter
 * their holes vertically (final 0.5 units straight down), so entries never
 * clash. Short hops (< 3 units) become low "staple" jumpers (rise 0.7, flat
 * run); longer runs are smooth flat-topped arcs whose apex starts at
 * max(0.9, 0.10·length capped at 2.2). Every candidate path is sampled (≥ 24
 * points, ~0.3 units apart along the 3D path — steep climb sections get
 * proportionally more samples so near-tangent crossings cannot slip between
 * samples) and tested against already-routed wires (0.45 clearance) and
 * obstacle boxes (a wire over a box must clear its height + 0.35). Conflicts
 * are resolved by walking a fixed cost-ordered ladder of (lift tier, lateral
 * offset) candidates: lateral mid-section dodges of ±0.35·n (n ≤ 3) are
 * cheaper than +0.55 lift tiers (max 8), so wires spread sideways before
 * they stack upward (the old lift-first ladder produced ugly two-board-tall
 * "towers"). The lateral offset ramps to full strength within ~0.3 plan
 * units of each entry and holds flat across the run, so the separation is
 * already there where a bumped wire's climb crosses a lower neighbour's flat
 * top — a sin(π·u) taper would vanish exactly there. Climb runs scale with
 * the lift (slope stays gentle however high a wire is bumped) and a staple
 * bumped beyond 1.5 lift re-shapes into a smooth arc — escalated wires read
 * as longer arcs, never near-vertical walls. The first clearance-passing
 * candidate wins; if every candidate conflicts, the least-bad one (max
 * clearance) is accepted — the router never loops forever.
 *
 * Leaded components (routeAll) are first-class citizens: a 2-lead part's
 * lead path obeys the exact same physics (vertical hole entries, 0.45
 * clearance against everything, obstacle clearance, apex tiers, lateral
 * offsets) plus two extra constraints. (a) SPAN style: the rigid body
 * occupies the flat top of the path — the route reserves a straight, level
 * segment of body.length centered on the span (waypoints carry
 * bodyStart/bodyEnd markers) and collision sampling treats that segment as a
 * FAT cylinder of radius diameter/2 + 0.1, so other paths keep clearance
 * from the body surface, not its centerline. (b) VERTICAL style: spans under
 * 3 plan units stand the body upright over endpoint A (cylinder of
 * body.length starting at y = 0.4) and the long lead loops from the body top
 * (+0.5 rise) over to endpoint B. Vertical bodies are collision-sampled too
 * (fat cylinder samples), and conflicts are resolved by a deterministic
 * ladder of small lean angles (±0.12·n rad, n ≤ 3, toward each of the four
 * plan axes) so adjacent vertical parts tilt apart — the lean is reported as
 * `tilt` with the actual axis in `bodyDir`. Samples near the body base are
 * exempt from the candidate's own clearance check (the part is plugged where
 * it is plugged — the base cannot move) but still block later paths.
 * 3-lead parts route their outer span; the fixed middle-lead drop point
 * (`mid`) contributes a vertical sample column so later wires dodge it.
 * Components route BEFORE wires (span desc, id asc within each kind), so
 * wires dodge bodies — never the other way around. toRoutedPose() converts a
 * routed component path into the mesh builders' RoutedComponent render
 * contract (body pose + per-lead waypoint runs).
 *
 * Off-board INSTRUMENTS (PSU / function generator boxes) are first-class
 * obstacles too: routeAll takes an optional third `instruments` argument
 * (InstrumentObstacle — a solid box plus its terminal posts). The boxes are
 * collision-checked exactly like component obstacle boxes, so wires can no
 * longer noclip through an instrument enclosure. A wire whose ENDPOINT sits
 * on an instrument terminal additionally gets a fixed EXIT SEGMENT: the path
 * rises from the post, then runs level along the terminal's exitDir (away
 * from the box face) for EXIT_RUN (1.5) units before the normal staple/arc
 * geometry begins — by construction the wire can never slice back through
 * the instrument it is plugged into. The variable part of such a wire is
 * planned between the exit-run ends (so the candidate ladder, clearances and
 * obstacle checks all apply to it normally, INCLUDING the wire's own
 * instrument box — a wire routed to the far side must still climb over);
 * the fixed prefix itself is exempt from candidate evaluation (it cannot
 * move) but its samples are added to the world grid so later paths dodge it.
 *
 * routeOne() previews one extra candidate against an already-routed world
 * (ghost placement / wire drag) without recomputing or mutating anything.
 * It simulates the candidate's true routeAll sort position — paths that
 * would route after it on commit are invisible to it — so the previewed
 * path IS the candidate's committed path (modulo exact span-length ties).
 *
 * Performance: routed-path samples live in uniform hash grids — thin
 * (wire/lead) samples in a 0.9-cell grid, fat (body) samples in a separate
 * coarser grid so thin queries keep their tight 8-bucket window. Each
 * candidate sample only inspects its neighbouring cells; bucket windows are
 * cached between adjacent samples; sample data is interleaved in one
 * Float64Array; candidates sampled by the early-exit ladder are memoized
 * for the least-bad pass; and obstacle checks keep early-exit bbox
 * prechecks. A realistic 100-component + 200-wire board routes in well
 * under 80ms; the adversarial random-soup stress test stays several times
 * inside its 800ms CI bound.
 */

export interface RouteWireInput {
  id: string
  ax: number
  az: number
  bx: number
  bz: number
}

/** A wire item for routeAll (kind is optional — plain wires stay valid). */
export interface RouteWireItemInput extends RouteWireInput {
  kind?: 'wire'
}

/** A 2-lead (or 3-lead via `mid`) leaded component for routeAll. */
export interface RouteComponentInput {
  id: string
  kind: 'component'
  ax: number
  az: number
  bx: number
  bz: number
  /**
   * rigid body: straight cylinder `length` plan units long, `diameter` thick.
   * `standing` (radial packages — LED): the body is rendered UPRIGHT at the
   * routed span center instead of lying along it; the value is the body's
   * full vertical extent. Standing bodies always route span-style (the lift
   * tier + lateral ladder is what nests packed parts) and are
   * collision-sampled as a vertical column at the body center — the column
   * spans the rendered body height, so wires can never cross the dome even
   * when the part's obstacle box is endpoint-skipped.
   */
  body: { length: number; diameter: number; standing?: number }
  /** 3-lead parts: fixed middle-lead drop point between the outer span */
  mid?: { x: number; z: number }
}

export type RouteItemInput = RouteWireItemInput | RouteComponentInput

export interface RouteObstacle {
  minX: number
  maxX: number
  minZ: number
  maxZ: number
  height: number
}

/** A terminal post of an instrument: plan position + outward exit direction. */
export interface InstrumentTerminal {
  x: number
  z: number
  /** plan direction pointing AWAY from the box face (normalized internally) */
  exitDir: { x: number; z: number }
}

/**
 * An off-board instrument as a routing obstacle: a solid box (~4 high for the
 * bench instruments) that wires must clear like any component body, plus its
 * terminal posts. A wire whose endpoint sits on one of the `terminals` gets a
 * fixed exit segment along that terminal's exitDir (see module doc).
 */
export interface InstrumentObstacle {
  id: string
  minX: number
  maxX: number
  minZ: number
  maxZ: number
  height: number
  terminals: InstrumentTerminal[]
}

export interface Vec3 {
  x: number
  y: number
  z: number
}

export interface RoutePoint extends Vec3 {
  /** set on the two waypoints delimiting where a component body sits */
  marker?: 'bodyStart' | 'bodyEnd'
}

export interface RoutedWire {
  waypoints: RoutePoint[]
  style: 'staple' | 'arc'
}

/**
 * Routed path of a leaded component (router output — see RoutedComponent at
 * the bottom of this file for the mesh builders' render-side contract;
 * toRoutedPose() converts between the two).
 */
export interface RoutedComponentPath {
  /** continuous lead path A → body (marked) → B, hole entries vertical */
  waypoints: RoutePoint[]
  style: 'span' | 'vertical'
  /** center of the rigid body cylinder */
  bodyCenter: Vec3
  /** unit body axis — level along the run for 'span', ≈ +y for 'vertical' */
  bodyDir: Vec3
  /** vertical-mount lean angle (radians) when conflicts forced a tilt */
  tilt?: number
}

export type RoutedItem = RoutedWire | RoutedComponentPath

/** Result of routeAll — also the world handle routeOne previews against. */
export type RoutedWorld = Map<string, RoutedItem>

// ---------------------------------------------------------------- tunables

/** plan length below which a wire becomes a low staple jumper */
const STAPLE_MAX_SPAN = 3
/** staple flat-run height */
const STAPLE_RISE = 0.7
/** vertical hole-entry leg length (both wire styles) */
const ENTRY_RISE = 0.5
/**
 * Board-hugging arc spec (photorealism reboot): real jumpers stay LOW — the
 * old 0.16/unit, cap-4 apexes ballooned every long run into a wire fountain
 * towering over the parts. Long runs now crest at ~2.2 units (≈5.6mm) and
 * only the conflict ladder lifts them higher.
 */
const ARC_MIN_APEX = 0.9
const ARC_APEX_PER_UNIT = 0.1
const ARC_APEX_CAP = 2.2
/** min center distance between two thin path samples (fat radii add to it) */
const WIRE_CLEARANCE = 0.45
/** required clearance above an obstacle box top */
const OBSTACLE_CLEARANCE = 0.35
/** apex/rise bump per conflict tier */
const LIFT_STEP = 0.55
const MAX_BUMP_TIERS = 8
/** lateral mid-section conflict-dodge offset unit */
const LATERAL_STEP = 0.35
/** lateral dodge steps per side (max offset = LATERAL_STEP · this) */
const LATERAL_MAX_STEPS = 3
/**
 * candidate-ladder cost of one lateral step relative to one lift tier (< 1:
 * spreading sideways is preferred over stacking upward, so conflict pile-ups
 * fan out flat instead of growing visual towers)
 */
const LATERAL_COST = 0.7
/**
 * component-ladder lateral cost: the OPPOSITE preference of wires. 0.55mm
 * steel leads do not sweep sideways in plan — DESIGN §4b's packed-part rule
 * is "raise the body height tier AND bend the legs inward", i.e. resolve in
 * the VERTICAL plane first. Lateral dodges stay available as a last resort
 * but cost well over a lift tier, so leaded bodies stack up like a real
 * dense build instead of fanning into rubbery plan-bent S-curves.
 */
const LATERAL_COST_COMPONENT = 2.4
/**
 * plan run over which the lateral offset ramps from 0 (at the entry) to full.
 * Must be shorter than the height-climb run: a lift-bumped parallel wire
 * crosses its neighbour's apex height early in its own climb, and the full
 * lateral separation has to be in place by then.
 */
const LATERAL_RAMP = 0.3
/**
 * least-bad selection tie band: a costlier candidate must beat the best
 * margin by MORE than this to win. Margins are computed from 0.3-spaced
 * samples, so equally-bad candidates differ by sampling noise — without the
 * band that noise routinely crowned a max-tier candidate, growing the exact
 * towers the lateral-first ladder exists to avoid.
 */
const MARGIN_TIE_EPS = 0.05
/** floor on collision samples per candidate path */
const BASE_SAMPLES = 24
/** hard cap on samples per candidate (spacing widens on huge boards instead) */
const MAX_SAMPLES = 640
/**
 * target spacing between collision samples ALONG THE 3D PATH — must stay
 * well under the 0.45 wire clearance or point-vs-point checks miss
 * near-tangent crossings (a bumped parallel wire's climb skimming a
 * neighbour's flat top)
 */
const SAMPLE_SPACING = 0.3
/** minimum plan units over which an arc climbs to (and descends from) its apex */
const CLIMB_RUN = 1.6
/**
 * extra climb run per unit of lift above the entry rise: bumped wires keep a
 * gentle ≤ ~45° climb instead of scaling a near-vertical wall (the fixed-run
 * climb was what made high-tier wires read as squared-off towers)
 */
const CLIMB_RUN_PER_LIFT = 1.1
/**
 * a staple bumped to (or beyond) this lift is re-shaped as a smooth arc —
 * vertical staple legs taller than ~2 tiers dominate the board silhouette
 */
const STAPLE_ARC_LIFT = 1.5
/** samples this close (plan) to a shared endpoint are exempt from clashes */
const SHARED_R2 = 0.9 * 0.9
const EPS_LEN = 1e-4
/** hash-grid cell edge = 2·WIRE_CLEARANCE → ±clearance spans ≤ 2 cells/axis */
const CELL = 2 * WIRE_CLEARANCE
/**
 * cell edge of the SEPARATE grid holding fat (body) samples. Fat samples
 * widen the query window by their radius — if they shared the thin grid,
 * every thin-vs-thin query would pay the widened window too (27 bucket
 * lookups instead of 8, the dominant routing cost on mixed boards). The
 * coarser cell keeps fat queries at ≤ 2 cells per axis for any body
 * diameter ≤ ~1.3; larger windows simply visit more cells (still correct).
 */
const CELL_FAT = 2.2

// --------------------------------------------------- component-body tunables

/** extra collision fat added around a body's physical radius */
const BODY_FAT_PAD = 0.1
/**
 * span-style body bottom keeps this much air under its collision radius.
 * Kept SMALL: an unobstructed axial part should rest near the board like a
 * real flat-laid resistor — only conflicts/obstacles lift it higher.
 */
const BODY_GROUND_CLEAR = 0.18
/** min plan run each lead keeps between hole entry and body end (span) */
const MIN_LEAD_RUN = 0.3
/** spacing of fat samples along a body axis */
const BODY_AXIS_SPACING = 0.25
/** vertical mount: body cylinder starts this high (short lead under it) */
const V_BASE_Y = 0.4
/** vertical mount: long lead rises this far above the body top */
const V_TOP_RISE = 0.5
/**
 * vertical mount: air gap the long lead keeps beyond the body's routing
 * envelope (bodyR already includes the fat margin) so the hairpin clears the
 * proud color bands + its own lead radius at any span — the user-reported
 * span-1 self-clip came from the old half-span loop midpoint landing INSIDE
 * the body envelope (DESIGN.md §4b: legs are colliders too).
 */
const V_LOOP_CLEARANCE = 0.18
/** vertical-mount lean ladder: radians per step, max steps per direction */
const TILT_STEP = 0.12
const TILT_MAX_STEPS = 3
/**
 * vertical body samples within this axial distance of the base are exempt
 * from the candidate's own clearance check: the base is plugged where it is
 * plugged (like a wire endpoint inside an obstacle box), and exempting it
 * lets the tilt ladder's margin actually improve as the body leans away
 * instead of being pinned by the immovable base. They still enter the grid,
 * so later paths keep clearance from the whole body.
 */
const BODY_SOFT_AXIAL = 0.7
/**
 * A standing body (`body.standing` — LED) renders hanging this far below its
 * routed center (mesh builders clamp the body seat toward the board), so its
 * vertical collision column starts at lift − STANDING_BELOW and runs the
 * declared standing extent upward — covering flange through dome top.
 */
const STANDING_BELOW = 0.45

// --------------------------------------------------- instrument-exit tunables

/** fixed exit-segment run from an instrument terminal along its exitDir */
const EXIT_RUN = 1.5
/** plan-distance tolerance for matching a wire endpoint to a terminal */
const TERMINAL_EPS2 = 1e-3 * 1e-3
/** effective spans shorter than this suppress exits (degenerate guard) */
const MIN_EXIT_SPAN = 0.5

/** Resolved terminal exit of one wire endpoint (terminal pos + unit dir). */
interface ExitInfo {
  x: number
  z: number
  dx: number
  dz: number
}

// ----------------------------------------------------------- internal types

interface Prepped {
  id: string
  kind: 'wire' | 'component'
  ax: number
  az: number
  bx: number
  bz: number
  len: number
  /** unit plan run direction ((1,0) when degenerate) and its perpendicular */
  ux: number
  uz: number
  px: number
  pz: number
  style: 'staple' | 'arc' | 'span' | 'vertical'
  baseLift: number
  /** body length / fat collision radius (0 for wires) */
  bodyLen: number
  bodyR: number
  /** standing-body vertical extent (0 = classic axial body / wire) */
  standing: number
  /** fixed middle-lead drop point (NaN when absent) */
  midX: number
  midZ: number
  /**
   * instrument-terminal exits (wires only). When set, ax/az (bx/bz) hold the
   * EFFECTIVE endpoint — the end of the fixed exit run, EXIT_RUN units from
   * the terminal along exitDir — and the exit prefix is prepended to the
   * waypoints / appended to the accepted grid samples.
   */
  exitA: ExitInfo | null
  exitB: ExitInfo | null
}

interface Bounds {
  minX: number
  maxX: number
  minY: number
  maxY: number
  minZ: number
  maxZ: number
}

/**
 * Uniform hash grids over every already-routed path's collision samples.
 * Thin (radius-0 wire/lead) samples and fat (body) samples live in separate
 * bucket maps so thin-vs-thin queries keep their tight 8-bucket window.
 * Sample data is interleaved (x, y, z, r — one cache line per sample) in a
 * growable Float64Array: the pair-distance loop is the routing hot spot.
 */
interface SampleGrid {
  buckets: Map<number, number[]>
  fatBuckets: Map<number, number[]>
  /** interleaved x,y,z,fat-radius per sample (stride 4), `len` samples used */
  data: Float64Array
  /** index into the routed Prepped[] that owns each sample */
  owner: Int32Array
  len: number
  /** largest stored fat radius (fat query-window expansion) */
  maxR: number
  /** bbox of all fat samples — cheap whole-scan rejection for fat queries */
  fatMinX: number
  fatMaxX: number
  fatMinY: number
  fatMaxY: number
  fatMinZ: number
  fatMaxZ: number
}

function newGrid(): SampleGrid {
  return {
    buckets: new Map(),
    fatBuckets: new Map(),
    data: new Float64Array(4096 * 4),
    owner: new Int32Array(4096),
    len: 0,
    maxR: 0,
    fatMinX: Infinity,
    fatMaxX: -Infinity,
    fatMinY: Infinity,
    fatMaxY: -Infinity,
    fatMinZ: Infinity,
    fatMaxZ: -Infinity,
  }
}

function cellKey(ix: number, iy: number, iz: number): number {
  // 4096³ < 2^53 — exact integer keys for coords within ±~1800 units
  return ((ix + 1024) * 4096 + (iy + 1024)) * 4096 + (iz + 1024)
}

function gridAdd(
  g: SampleGrid,
  x: number,
  y: number,
  z: number,
  owner: number,
  r: number,
): void {
  const idx = g.len
  if (idx >= g.owner.length) {
    // amortized doubling growth
    const data = new Float64Array(g.data.length * 2)
    data.set(g.data)
    g.data = data
    const own = new Int32Array(g.owner.length * 2)
    own.set(g.owner)
    g.owner = own
  }
  const o4 = idx * 4
  g.data[o4] = x
  g.data[o4 + 1] = y
  g.data[o4 + 2] = z
  g.data[o4 + 3] = r
  g.owner[idx] = owner
  g.len = idx + 1
  const fat = r > 0
  if (fat) {
    if (r > g.maxR) g.maxR = r
    if (x < g.fatMinX) g.fatMinX = x
    if (x > g.fatMaxX) g.fatMaxX = x
    if (y < g.fatMinY) g.fatMinY = y
    if (y > g.fatMaxY) g.fatMaxY = y
    if (z < g.fatMinZ) g.fatMinZ = z
    if (z > g.fatMaxZ) g.fatMaxZ = z
  }
  const cell = fat ? CELL_FAT : CELL
  const key = cellKey(Math.floor(x / cell), Math.floor(y / cell), Math.floor(z / cell))
  const buckets = fat ? g.fatBuckets : g.buckets
  const bucket = buckets.get(key)
  if (bucket) bucket.push(idx)
  else buckets.set(key, [idx])
}

// ------------------------------------------------------------ path geometry

function prep(w: RouteWireInput): Prepped {
  const dx = w.bx - w.ax
  const dz = w.bz - w.az
  const len = Math.hypot(dx, dz)
  const degenerate = len < EPS_LEN
  const ux = degenerate ? 1 : dx / len
  const uz = degenerate ? 0 : dz / len
  const style: 'staple' | 'arc' = len < STAPLE_MAX_SPAN ? 'staple' : 'arc'
  const baseLift =
    style === 'staple'
      ? STAPLE_RISE
      : Math.max(ARC_MIN_APEX, Math.min(ARC_APEX_CAP, ARC_APEX_PER_UNIT * len))
  return {
    id: w.id,
    kind: 'wire',
    ax: w.ax,
    az: w.az,
    bx: w.bx,
    bz: w.bz,
    len,
    ux,
    uz,
    px: -uz,
    pz: ux,
    style,
    baseLift,
    bodyLen: 0,
    bodyR: 0,
    standing: 0,
    midX: NaN,
    midZ: NaN,
    exitA: null,
    exitB: null,
  }
}

function prepComponent(c: RouteComponentInput): Prepped {
  const dx = c.bx - c.ax
  const dz = c.bz - c.az
  const len = Math.hypot(dx, dz)
  const degenerate = len < EPS_LEN
  const ux = degenerate ? 1 : dx / len
  const uz = degenerate ? 0 : dz / len
  // clamp degenerate body specs so the geometry can never go NaN/zero-length
  const standing = Math.max(0, c.body.standing ?? 0)
  // a standing body's reserved flat-top segment can never exceed the span
  // (short spans would push the leg knees behind the holes)
  const bodyLen =
    standing > 0
      ? Math.max(0.2, Math.min(c.body.length, Math.max(0.7, len)))
      : Math.max(0.2, c.body.length)
  const bodyR = Math.max(0.05, c.body.diameter / 2) + BODY_FAT_PAD
  // standing bodies always span-route: the lift-tier + lateral ladder is the
  // packed-parts nesting mechanism (verticals only lean, which cannot
  // separate two radial bodies plugged one column apart)
  const style: 'span' | 'vertical' =
    standing > 0 || len >= STAPLE_MAX_SPAN ? 'span' : 'vertical'
  return {
    id: c.id,
    kind: 'component',
    ax: c.ax,
    az: c.az,
    bx: c.bx,
    bz: c.bz,
    len,
    ux,
    uz,
    px: -uz,
    pz: ux,
    style,
    // AXIAL resting height biased DOWN (no ARC_MIN_APEX floor): an
    // unobstructed part lies just clear of the board; only the ladder lifts
    // it. STANDING bodies keep the original height — their packed-part
    // nesting geometry (ROUTED_BODY diameter tuning + ladder separations)
    // was calibrated at it.
    baseLift:
      standing > 0
        ? Math.max(ARC_MIN_APEX, bodyR + 0.35)
        : Math.max(ENTRY_RISE + 0.12, bodyR + BODY_GROUND_CLEAR),
    bodyLen,
    bodyR,
    standing,
    midX: c.mid ? c.mid.x : NaN,
    midZ: c.mid ? c.mid.z : NaN,
    exitA: null,
    exitB: null,
  }
}

function prepItem(item: RouteItemInput): Prepped {
  return item.kind === 'component' ? prepComponent(item) : prep(item)
}

/** The terminal exit at plan point (x, z), or null when none matches. */
function findExit(x: number, z: number, instruments: InstrumentObstacle[]): ExitInfo | null {
  for (const inst of instruments) {
    for (const t of inst.terminals) {
      const dx = x - t.x
      const dz = z - t.z
      if (dx * dx + dz * dz < TERMINAL_EPS2) {
        const len = Math.hypot(t.exitDir.x, t.exitDir.z)
        if (len < EPS_LEN) return null
        return { x: t.x, z: t.z, dx: t.exitDir.x / len, dz: t.exitDir.z / len }
      }
    }
  }
  return null
}

/**
 * Prep an item, attaching instrument-terminal exits: a wire endpoint sitting
 * on a terminal is shifted to the end of its fixed exit run (the variable
 * path is planned between the shifted points; the prefix is fixed geometry).
 * Components never exit (leaded parts cannot plug into terminals), and a
 * degenerate effective span suppresses the exits (legacy shape kept).
 */
function prepItemWithExits(
  item: RouteItemInput,
  instruments: InstrumentObstacle[],
): Prepped {
  if (item.kind === 'component' || instruments.length === 0) return prepItem(item)
  const exitA = findExit(item.ax, item.az, instruments)
  const exitB = findExit(item.bx, item.bz, instruments)
  if (!exitA && !exitB) return prepItem(item)
  const ax = exitA ? exitA.x + exitA.dx * EXIT_RUN : item.ax
  const az = exitA ? exitA.z + exitA.dz * EXIT_RUN : item.az
  const bx = exitB ? exitB.x + exitB.dx * EXIT_RUN : item.bx
  const bz = exitB ? exitB.z + exitB.dz * EXIT_RUN : item.bz
  if (Math.hypot(bx - ax, bz - az) < MIN_EXIT_SPAN) return prepItem(item)
  const p = prep({ id: item.id, ax, az, bx, bz })
  p.exitA = exitA
  p.exitB = exitB
  return p
}

/** Plain collision-obstacle view of an instrument box. */
function instrumentBox(inst: InstrumentObstacle): RouteObstacle {
  return {
    minX: inst.minX,
    maxX: inst.maxX,
    minZ: inst.minZ,
    maxZ: inst.maxZ,
    height: inst.height,
  }
}

/** Plan run of an arc's climb section: scales with the lift (gentle slopes). */
function climbRun(len: number, lift: number): number {
  return Math.min(len / 2, Math.max(CLIMB_RUN, (lift - ENTRY_RISE) * CLIMB_RUN_PER_LIFT))
}

/**
 * Effective path shape for a candidate lift: staples escalated past
 * STAPLE_ARC_LIFT are sampled AND rendered as smooth arcs (the two must stay
 * consistent — the renderer may never draw a shape the collision pass did not
 * check). Degenerate/very short spans keep the vertical staple.
 */
function styleFor(w: Prepped, lift: number): 'staple' | 'arc' {
  if (w.style === 'staple' && lift >= STAPLE_ARC_LIFT && w.len >= 1) return 'arc'
  return w.style === 'arc' ? 'arc' : 'staple'
}

/** Arc height above the board at plan distance `s` along the run. */
function aerialY(s: number, len: number, lift: number): number {
  const r = climbRun(len, lift)
  const t = Math.min(1, s / r, (len - s) / r)
  return ENTRY_RISE + (lift - ENTRY_RISE) * Math.sin((Math.PI / 2) * Math.max(0, t))
}

/**
 * Lateral offset at plan distance `s` with ramp length `ramp`: ramps to the
 * full offset within `ramp` units of either entry and holds flat in between
 * (entries stay exactly over their holes; the dodge is at full strength
 * everywhere else).
 */
function lateralRamped(s: number, len: number, lateral: number, ramp: number): number {
  if (lateral === 0 || len < EPS_LEN) return 0
  const r = Math.min(ramp, len / 4)
  return lateral * Math.max(0, Math.min(1, s / r, (len - s) / r))
}

/** Wire lateral offset (fixed LATERAL_RAMP). */
function lateralAt(s: number, len: number, lateral: number): number {
  return lateralRamped(s, len, lateral, LATERAL_RAMP)
}

/** |d(path)/ds| transverse slope (height climb + lateral ramp combined). */
function pathSlope(w: Prepped, s: number, lift: number, lateral: number): number {
  let gy = 0
  if (styleFor(w, lift) === 'arc') {
    const r = climbRun(w.len, lift)
    const t = Math.min(1, s / r, (w.len - s) / r)
    if (t < 1) gy = (((lift - ENTRY_RISE) * Math.PI) / (2 * r)) * Math.cos((Math.PI / 2) * t)
  }
  if (lateral !== 0) {
    const r = Math.min(LATERAL_RAMP, w.len / 4)
    if (s < r || s > w.len - r) {
      const gl = Math.abs(lateral) / r
      return Math.hypot(gy, gl)
    }
  }
  return gy
}

function resetBounds(bb: Bounds): void {
  bb.minX = Infinity
  bb.maxX = -Infinity
  bb.minY = Infinity
  bb.maxY = -Infinity
  bb.minZ = Infinity
  bb.maxZ = -Infinity
}

/**
 * Sample-index ranges (lo, hi pairs) of the last-sampled candidate that are
 * CANDIDATE-INVARIANT (vertical hole-entry columns — every candidate of an
 * item passes through them unchanged). Filled by the samplers; consumed by
 * the least-bad "unfixable conflict" shortcut: when the cheapest candidate's
 * binding conflict sits on a fixed section, no candidate can meaningfully
 * beat it (their margins are capped by the same immovable clash), so the
 * cost-ordered ladder keeps the cheapest candidate without scanning the
 * other ~60 — the dominant cost in dense least-bad pile-ups.
 */
const FIXED_RANGES: number[] = []
/** copy of FIXED_RANGES for the CHEAPEST candidate (the shortcut's anchor) */
const FIXED_SAVED: number[] = []
/** sample index of the binding (minimum-margin) conflict of the last FULL
 * evaluate scan; −1 when the scan early-returned or found nothing */
let BIND_IDX = -1

function saveFixedRanges(): void {
  FIXED_SAVED.length = 0
  for (const v of FIXED_RANGES) FIXED_SAVED.push(v)
}

function bindIsFixed(): boolean {
  if (BIND_IDX < 0) return false
  for (let k = 0; k < FIXED_SAVED.length; k += 2) {
    if (BIND_IDX >= FIXED_SAVED[k] && BIND_IDX < FIXED_SAVED[k + 1]) return true
  }
  return false
}

/**
 * Sample the candidate wire path (vertical entry legs + aerial section) into
 * `out` (xyz interleaved), updating `bb`. Samples are ~SAMPLE_SPACING apart
 * along the 3D path — the plan step adapts to the local climb/ramp slope so
 * steep sections are sampled as densely as flat ones. Returns sample count.
 */
function samplePath(
  w: Prepped,
  lift: number,
  lateral: number,
  out: Float64Array,
  bb: Bounds,
): number {
  resetBounds(bb)
  let count = 0
  const push = (x: number, y: number, z: number): void => {
    if (count >= MAX_SAMPLES) return
    out[3 * count] = x
    out[3 * count + 1] = y
    out[3 * count + 2] = z
    count++
    if (x < bb.minX) bb.minX = x
    if (x > bb.maxX) bb.maxX = x
    if (y < bb.minY) bb.minY = y
    if (y > bb.maxY) bb.maxY = y
    if (z < bb.minZ) bb.minZ = z
    if (z > bb.maxZ) bb.maxZ = z
  }

  const style = styleFor(w, lift)
  const legs = style === 'staple' ? lift : ENTRY_RISE
  const aerial3d =
    w.len + (style === 'arc' ? 2 * (lift - ENTRY_RISE) : 0) + 2 * Math.abs(lateral)
  const total3d = 2 * legs + aerial3d
  // ≥ BASE_SAMPLES points, ≈ SAMPLE_SPACING apart, capped (huge spans widen)
  const spacing = Math.max(
    Math.min(SAMPLE_SPACING, total3d / (BASE_SAMPLES - 1)),
    total3d / (MAX_SAMPLES - 32),
  )

  // entry legs: a terminal-exit endpoint arrives level at ENTRY_RISE (the
  // fixed exit prefix is sampled separately, post-acceptance), so its leg
  // only covers [ENTRY_RISE, legs] — empty for arcs, the staple top for
  // staples. Plain hole endpoints keep the full [0, legs] vertical column.
  const aBase = w.exitA ? ENTRY_RISE : 0
  const bBase = w.exitB ? ENTRY_RISE : 0
  const aSpan = legs - aBase
  const kLegA = aSpan > 1e-9 ? Math.max(1, Math.ceil(aSpan / spacing)) : 0
  for (let i = 0; i < kLegA; i++) push(w.ax, aBase + (aSpan * i) / kLegA, w.az)

  if (w.len < EPS_LEN) {
    // degenerate (zero plan length, exits never attach — prepItemWithExits
    // suppresses them under MIN_EXIT_SPAN): one vertical column up and down
    push(w.ax, legs, w.az)
    for (let i = kLegA - 1; i >= 0; i--) push(w.bx, (legs * i) / kLegA, w.bz)
    FIXED_RANGES.length = 0
    return count
  }

  let s = 0
  for (;;) {
    const lat = lateralAt(s, w.len, lateral)
    const y = style === 'staple' ? lift : aerialY(s, w.len, lift)
    push(w.ax + w.ux * s + w.px * lat, y, w.az + w.uz * s + w.pz * lat)
    if (s >= w.len) break
    // adaptive plan step: ds·√(1+slope²) ≈ spacing, probing the slope at both
    // ends of the step so the steep base of a climb cannot be jumped over
    const g1 = pathSlope(w, s, lift, lateral)
    let ds = spacing / Math.sqrt(1 + g1 * g1)
    const g2 = pathSlope(w, Math.min(w.len, s + ds), lift, lateral)
    if (g2 > g1) ds = spacing / Math.sqrt(1 + g2 * g2)
    s = Math.min(w.len, s + Math.max(ds, 0.02))
  }

  const bSpan = legs - bBase
  const kLegB = bSpan > 1e-9 ? Math.max(1, Math.ceil(bSpan / spacing)) : 0
  const bLegStart = count
  for (let i = kLegB - 1; i >= 0; i--) push(w.bx, bBase + (bSpan * i) / kLegB, w.bz)
  // entry columns are candidate-invariant for arcs (legs always ENTRY_RISE);
  // staples vary their leg height with the lift, so they opt out. Exit-run
  // endpoints have no entry column at all (kLeg 0 — the prefix is fixed).
  FIXED_RANGES.length = 0
  if (style === 'arc') {
    if (kLegA > 0) FIXED_RANGES.push(0, kLegA)
    if (kLegB > 0) FIXED_RANGES.push(bLegStart, count)
  }
  return count
}

/** Aerial waypoint stations (plan distances) for an arc of length `len`. */
function arcStations(len: number, lift: number): number[] {
  const r = climbRun(len, lift)
  const out = [r * 0.55, r]
  const m = Math.max(3, Math.min(13, 2 * Math.round(len / 6) + 1))
  for (let j = 1; j <= m; j++) {
    const s = (len * j) / (m + 1)
    if (s > r + 0.25 && s < len - r - 0.25) out.push(s)
  }
  out.push(len - r, len - r * 0.55)
  out.sort((a, b) => a - b)
  const dedup: number[] = []
  for (const s of out) {
    if (dedup.length === 0 || s - dedup[dedup.length - 1] > 0.2) dedup.push(s)
  }
  return dedup
}

/** Fixed exit-prefix waypoints: terminal → rise → level run to the effective
 * endpoint. A mid-run station keeps the CatmullRom taut along the exitDir
 * line so the rendered tube cannot bow back into the instrument face. */
function pushExitRun(pts: RoutePoint[], e: ExitInfo): void {
  pts.push({ x: e.x, y: 0, z: e.z })
  pts.push({ x: e.x, y: ENTRY_RISE, z: e.z })
  pts.push({
    x: e.x + e.dx * (EXIT_RUN / 2),
    y: ENTRY_RISE,
    z: e.z + e.dz * (EXIT_RUN / 2),
  })
}

/** Waypoints for the renderer (CatmullRom through these follows the path). */
function buildWaypoints(w: Prepped, lift: number, lateral: number): RoutePoint[] {
  const pts: RoutePoint[] = []
  if (w.exitA) pushExitRun(pts, w.exitA)
  else pts.push({ x: w.ax, y: 0, z: w.az })
  if (w.len < EPS_LEN) {
    // degenerate (zero-length): a tiny loop of pairwise-distinct points so a
    // CatmullRom through them stays finite — never NaN, never throws
    pts.push({ x: w.ax - 0.12, y: lift * 0.55, z: w.az })
    pts.push({ x: w.ax, y: lift, z: w.az })
    pts.push({ x: w.ax + 0.12, y: lift * 0.55, z: w.az })
    pts.push({ x: w.bx, y: 0, z: w.bz })
    return pts
  }
  const aerial = (s: number, y: number) => {
    const lat = lateralAt(s, w.len, lateral)
    pts.push({ x: w.ax + w.ux * s + w.px * lat, y, z: w.az + w.uz * s + w.pz * lat })
  }
  /** stations at the lateral-ramp knees, so the rendered polyline reaches the
   * full offset as fast as the collision-checked analytic path does (a
   * straight cut from the entry to the first arc station would under-ramp
   * laterally right where a neighbour's flat top is crossed) */
  const withRampKnees = (stations: number[]): number[] => {
    if (lateral === 0) return stations
    const r = Math.min(LATERAL_RAMP, w.len / 4)
    for (const s of [r, w.len - r]) {
      if (!stations.some((q) => Math.abs(q - s) < 0.12)) stations.push(s)
    }
    return stations.sort((a, b) => a - b)
  }
  if (styleFor(w, lift) === 'staple') {
    if (w.exitA) pts.push({ x: w.ax, y: ENTRY_RISE, z: w.az }) // exit-run arrival
    pts.push({ x: w.ax, y: lift, z: w.az })
    const fractions = w.len >= 1.5 ? [0.25, 0.5, 0.75] : [0.5]
    for (const s of withRampKnees(fractions.map((f) => f * w.len))) aerial(s, lift)
    pts.push({ x: w.bx, y: lift, z: w.bz })
    if (w.exitB) pts.push({ x: w.bx, y: ENTRY_RISE, z: w.bz }) // exit-run departure
  } else {
    pts.push({ x: w.ax, y: ENTRY_RISE, z: w.az })
    for (const s of withRampKnees(arcStations(w.len, lift))) aerial(s, aerialY(s, w.len, lift))
    pts.push({ x: w.bx, y: ENTRY_RISE, z: w.bz })
  }
  if (w.exitB) {
    pts.push({
      x: w.exitB.x + w.exitB.dx * (EXIT_RUN / 2),
      y: ENTRY_RISE,
      z: w.exitB.z + w.exitB.dz * (EXIT_RUN / 2),
    })
    pts.push({ x: w.exitB.x, y: ENTRY_RISE, z: w.exitB.z })
    pts.push({ x: w.exitB.x, y: 0, z: w.exitB.z })
  } else {
    pts.push({ x: w.bx, y: 0, z: w.bz })
  }
  return pts
}

// ------------------------------------------------- component span geometry

/**
 * Span-style flat-top geometry: the level body segment is body.length long,
 * centered on the run (clamped so each lead keeps ≥ MIN_LEAD_RUN of climb).
 * Returns the climb run `r` and the flat segment [s0, s1].
 */
function spanFlat(w: Prepped): { r: number; s0: number; s1: number } {
  const flatLen = Math.min(w.bodyLen, Math.max(0.2, w.len - 2 * MIN_LEAD_RUN))
  const r = Math.max(0.1, (w.len - flatLen) / 2)
  return { r, s0: r, s1: w.len - r }
}

/** Span path height at plan distance `s` (climb run `r` from spanFlat). */
function spanYAt(s: number, len: number, lift: number, r: number): number {
  const t = Math.min(1, s / r, (len - s) / r)
  return ENTRY_RISE + (lift - ENTRY_RISE) * Math.sin((Math.PI / 2) * Math.max(0, t))
}

/** Transverse slope of the span path (adaptive sampling density). */
function spanSlopeAt(
  w: Prepped,
  s: number,
  lift: number,
  lateral: number,
  r: number,
  lramp: number,
): number {
  let gy = 0
  const t = Math.min(1, s / r, (w.len - s) / r)
  if (t < 1) {
    gy = (((lift - ENTRY_RISE) * Math.PI) / (2 * r)) * Math.cos((Math.PI / 2) * Math.max(0, t))
  }
  if (lateral !== 0) {
    const rl = Math.min(lramp, w.len / 4)
    if (s < rl || s > w.len - rl) return Math.hypot(gy, Math.abs(lateral) / rl)
  }
  return gy
}

/**
 * Sample a span-style component: thin lead path (entries + climbs + flat),
 * the FAT body axis (radius bodyR, full body.length — it may overhang the
 * climbs on tight spans), and the fixed middle-lead drop column when present.
 */
function sampleSpan(
  w: Prepped,
  lift: number,
  lateral: number,
  out: Float64Array,
  rads: Float64Array,
  bb: Bounds,
): number {
  resetBounds(bb)
  let count = 0
  const push = (x: number, y: number, z: number, r: number): void => {
    if (count >= MAX_SAMPLES) return
    out[3 * count] = x
    out[3 * count + 1] = y
    out[3 * count + 2] = z
    rads[count] = r
    count++
    if (x < bb.minX) bb.minX = x
    if (x > bb.maxX) bb.maxX = x
    if (y < bb.minY) bb.minY = y
    if (y > bb.maxY) bb.maxY = y
    if (z < bb.minZ) bb.minZ = z
    if (z > bb.maxZ) bb.maxZ = z
  }

  const { r } = spanFlat(w)
  const lramp = Math.min(LATERAL_RAMP, r)
  const total3d =
    2 * ENTRY_RISE + w.len + 2 * (lift - ENTRY_RISE) + 2 * Math.abs(lateral) + w.bodyLen + lift
  const spacing = Math.max(
    Math.min(SAMPLE_SPACING, total3d / (BASE_SAMPLES - 1)),
    total3d / (MAX_SAMPLES - 32),
  )

  const kLeg = Math.max(1, Math.ceil(ENTRY_RISE / spacing))
  for (let i = 0; i < kLeg; i++) push(w.ax, (ENTRY_RISE * i) / kLeg, w.az, 0)

  let s = 0
  for (;;) {
    const lat = lateralRamped(s, w.len, lateral, lramp)
    push(
      w.ax + w.ux * s + w.px * lat,
      spanYAt(s, w.len, lift, r),
      w.az + w.uz * s + w.pz * lat,
      0,
    )
    if (s >= w.len) break
    const g1 = spanSlopeAt(w, s, lift, lateral, r, lramp)
    let ds = spacing / Math.sqrt(1 + g1 * g1)
    const g2 = spanSlopeAt(w, Math.min(w.len, s + ds), lift, lateral, r, lramp)
    if (g2 > g1) ds = spacing / Math.sqrt(1 + g2 * g2)
    s = Math.min(w.len, s + Math.max(ds, 0.02))
  }

  const bLegStart = count
  for (let i = kLeg - 1; i >= 0; i--) push(w.bx, (ENTRY_RISE * i) / kLeg, w.bz, 0)
  FIXED_RANGES.length = 0
  FIXED_RANGES.push(0, kLeg, bLegStart, count)

  // fat body samples at the flat-top height: axial bodies lie along the
  // span; standing bodies (LED) are a vertical column at the span center
  // covering the rendered body height (flange through dome top)
  const latC = lateralRamped(w.len / 2, w.len, lateral, lramp)
  if (w.standing > 0) {
    const cx = w.ax + w.ux * (w.len / 2) + w.px * latC
    const cz = w.az + w.uz * (w.len / 2) + w.pz * latC
    const y0 = Math.max(0.08, lift - STANDING_BELOW)
    const y1 = lift - STANDING_BELOW + w.standing
    const kCol = Math.max(3, Math.ceil((y1 - y0) / BODY_AXIS_SPACING))
    for (let i = 0; i <= kCol; i++) {
      push(cx, y0 + ((y1 - y0) * i) / kCol, cz, w.bodyR)
    }
  } else {
    const kBody = Math.max(2, Math.ceil(w.bodyLen / BODY_AXIS_SPACING))
    for (let i = 0; i <= kBody; i++) {
      const sb = w.len / 2 - w.bodyLen / 2 + (w.bodyLen * i) / kBody
      push(w.ax + w.ux * sb + w.px * latC, lift, w.az + w.uz * sb + w.pz * latC, w.bodyR)
    }
  }

  // fixed middle-lead drop column (3-lead parts)
  if (Number.isFinite(w.midX)) {
    const sMid = Math.max(
      0,
      Math.min(w.len, (w.midX - w.ax) * w.ux + (w.midZ - w.az) * w.uz),
    )
    const yTop = spanYAt(sMid, w.len, lift, r)
    const kCol = Math.max(2, Math.ceil(yTop / spacing))
    for (let i = 0; i <= kCol; i++) push(w.midX, (yTop * i) / kCol, w.midZ, 0)
  }
  return count
}

/** Span waypoints: vertical entries, climb knees, marked level body segment. */
function buildSpanWaypoints(w: Prepped, lift: number, lateral: number): RoutePoint[] {
  const { r, s0, s1 } = spanFlat(w)
  const lramp = Math.min(LATERAL_RAMP, r)
  const pts: RoutePoint[] = [
    { x: w.ax, y: 0, z: w.az },
    { x: w.ax, y: ENTRY_RISE, z: w.az },
  ]
  const aerial = (s: number, marker?: 'bodyStart' | 'bodyEnd'): void => {
    const lat = lateralRamped(s, w.len, lateral, lramp)
    const p: RoutePoint = {
      x: w.ax + w.ux * s + w.px * lat,
      y: spanYAt(s, w.len, lift, r),
      z: w.az + w.uz * s + w.pz * lat,
    }
    if (marker) p.marker = marker
    pts.push(p)
  }
  const rl = Math.min(lramp, w.len / 4)
  const climb: number[] = [r * 0.55]
  if (lateral !== 0 && rl < r * 0.55 - 0.12) climb.push(rl)
  for (const s of climb.sort((a, b) => a - b)) aerial(s)
  aerial(s0, 'bodyStart')
  aerial(s1, 'bodyEnd')
  const desc: number[] = [w.len - r * 0.55]
  if (lateral !== 0 && rl < r * 0.55 - 0.12) desc.push(w.len - rl)
  for (const s of desc.sort((a, b) => a - b)) aerial(s)
  pts.push({ x: w.bx, y: ENTRY_RISE, z: w.bz })
  pts.push({ x: w.bx, y: 0, z: w.bz })
  return pts
}

// ---------------------------------------------- component vertical geometry

interface VertGeom {
  bottom: Vec3
  top: Vec3
  rise: Vec3
  loopMid: Vec3
  bEntry: Vec3
}

/** Vertical-mount key points for a lean of `tilt` radians toward (dx, dz). */
function vertGeom(w: Prepped, tilt: number, dx: number, dz: number): VertGeom {
  const sin = Math.sin(tilt)
  const cos = Math.cos(tilt)
  const bottom: Vec3 = { x: w.ax, y: V_BASE_Y, z: w.az }
  const top: Vec3 = {
    x: w.ax + dx * sin * w.bodyLen,
    y: V_BASE_Y + cos * w.bodyLen,
    z: w.az + dz * sin * w.bodyLen,
  }
  const rise: Vec3 = { x: top.x, y: top.y + V_TOP_RISE, z: top.z }
  const bEntry: Vec3 = { x: w.bx, y: ENTRY_RISE, z: w.bz }
  // Hairpin knee: swing OUT past the body envelope before diving to B, so the
  // descending lead can never shear through the body or its proud bands —
  // the old half-span midpoint sat inside the envelope at 1-hole spans.
  // Descent plan-distance from the body axis grows monotonically from the
  // knee to bEntry, so clearing it at the knee clears the whole dive.
  const span = Math.hypot(w.bx - w.ax, w.bz - w.az)
  const ux = span > 1e-6 ? (w.bx - w.ax) / span : 1
  const uz = span > 1e-6 ? (w.bz - w.az) / span : 0
  // when the body leans toward B, its envelope follows — push the knee out
  const leanTowardB = Math.max(0, ux * dx + uz * dz) * sin * w.bodyLen
  const clear = w.bodyR + leanTowardB + V_LOOP_CLEARANCE
  const k = Math.min(Math.max(clear, span * 0.55), span * 0.9)
  const loopMid: Vec3 = { x: w.ax + ux * k, y: rise.y, z: w.az + uz * k }
  return { bottom, top, rise, loopMid, bEntry }
}

/**
 * Sample a vertical-mount component: thin A-entry column, FAT body cylinder
 * (base section soft — grid only, see BODY_SOFT_AXIAL), thin top-lead loop
 * over to B, and the middle-lead column when present.
 */
function sampleVertical(
  w: Prepped,
  tilt: number,
  dx: number,
  dz: number,
  out: Float64Array,
  rads: Float64Array,
  bb: Bounds,
  forGrid: boolean,
): number {
  resetBounds(bb)
  let count = 0
  const push = (x: number, y: number, z: number, r: number): void => {
    if (count >= MAX_SAMPLES) return
    out[3 * count] = x
    out[3 * count + 1] = y
    out[3 * count + 2] = z
    rads[count] = r
    count++
    if (x < bb.minX) bb.minX = x
    if (x > bb.maxX) bb.maxX = x
    if (y < bb.minY) bb.minY = y
    if (y > bb.maxY) bb.maxY = y
    if (z < bb.minZ) bb.minZ = z
    if (z > bb.maxZ) bb.maxZ = z
  }

  const g = vertGeom(w, tilt, dx, dz)
  const sin = Math.sin(tilt)
  const cos = Math.cos(tilt)

  // A-side entry column (thin)
  const kLeg = Math.max(2, Math.ceil(V_BASE_Y / SAMPLE_SPACING))
  for (let i = 0; i <= kLeg; i++) push(w.ax, (V_BASE_Y * i) / kLeg, w.az, 0)

  // fat body cylinder along the (possibly leaning) axis
  const soft = Math.min(BODY_SOFT_AXIAL, w.bodyLen / 2)
  const kBody = Math.max(3, Math.ceil(w.bodyLen / BODY_AXIS_SPACING))
  for (let i = 0; i <= kBody; i++) {
    const a = (w.bodyLen * i) / kBody
    if (!forGrid && a < soft) continue
    push(w.ax + dx * sin * a, V_BASE_Y + cos * a, w.az + dz * sin * a, w.bodyR)
  }

  // long lead: body top → +0.5 rise → loop over → vertical B entry (thin)
  const line = (a: Vec3, b: Vec3): void => {
    const len = Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z)
    const k = Math.max(1, Math.ceil(len / SAMPLE_SPACING))
    for (let i = 1; i <= k; i++) {
      const t = i / k
      push(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t, a.z + (b.z - a.z) * t, 0)
    }
  }
  push(g.top.x, g.top.y, g.top.z, 0)
  line(g.top, g.rise)
  line(g.rise, g.loopMid)
  line(g.loopMid, g.bEntry)
  const bColStart = count
  line(g.bEntry, { x: w.bx, y: 0, z: w.bz })

  // middle-lead column (3-lead vertical mounts are odd, but stay safe)
  if (Number.isFinite(w.midX)) {
    const k = Math.max(2, Math.ceil(ENTRY_RISE / SAMPLE_SPACING))
    for (let i = 0; i <= k; i++) push(w.midX, (ENTRY_RISE * i) / k, w.midZ, 0)
  }
  // tilt-invariant sections: the A column and the B drop (+ mid) column
  FIXED_RANGES.length = 0
  FIXED_RANGES.push(0, kLeg + 1, bColStart, count)
  return count
}

/** Vertical waypoints: A entry, marked body, +0.5 rise, loop over, B drop. */
function buildVerticalWaypoints(w: Prepped, g: VertGeom): RoutePoint[] {
  return [
    { x: w.ax, y: 0, z: w.az },
    { x: g.bottom.x, y: g.bottom.y, z: g.bottom.z, marker: 'bodyStart' },
    { x: g.top.x, y: g.top.y, z: g.top.z, marker: 'bodyEnd' },
    { x: g.rise.x, y: g.rise.y, z: g.rise.z },
    { x: g.loopMid.x, y: g.loopMid.y, z: g.loopMid.z },
    { x: g.bEntry.x, y: g.bEntry.y, z: g.bEntry.z },
    { x: w.bx, y: 0, z: w.bz },
  ]
}

// ------------------------------------------------------- conflict detection

/** Plan positions (flat [x,z,…]) of endpoints the two items share exactly. */
function sharedEndpoints(a: Prepped, b: Prepped): number[] {
  const out: number[] = []
  const push = (x: number, z: number) => {
    for (let k = 0; k < out.length; k += 2) {
      if (out[k] === x && out[k + 1] === z) return
    }
    out.push(x, z)
  }
  const same = (x1: number, z1: number, x2: number, z2: number) => {
    const dx = x1 - x2
    const dz = z1 - z2
    return dx * dx + dz * dz < 1e-10
  }
  if (same(a.ax, a.az, b.ax, b.az) || same(a.ax, a.az, b.bx, b.bz)) push(a.ax, a.az)
  if (same(a.bx, a.bz, b.ax, b.az) || same(a.bx, a.bz, b.bx, b.bz)) push(a.bx, a.bz)
  return out
}

/** Both samples sit (in plan) next to an endpoint the two items share. */
function isSharedZone(shared: number[], x1: number, z1: number, x2: number, z2: number): boolean {
  for (let k = 0; k < shared.length; k += 2) {
    const sx = shared[k]
    const sz = shared[k + 1]
    const dx1 = x1 - sx
    const dz1 = z1 - sz
    if (dx1 * dx1 + dz1 * dz1 > SHARED_R2) continue
    const dx2 = x2 - sx
    const dz2 = z2 - sz
    if (dx2 * dx2 + dz2 * dz2 <= SHARED_R2) return true
  }
  return false
}

/**
 * Clearance margin (< 0 ⇒ conflict; +∞ when nothing is near) of a sampled
 * candidate against obstacles + routed paths. Fat samples (radius > 0)
 * require their radius ON TOP of the 0.45 clearance — body surfaces keep the
 * same air gap thin wires do — and obstacle boxes grow by the radius too.
 * Path proximity is resolved through the split thin/fat sample hash grids
 * (fat windows widen by the fattest stored radius; thin windows stay
 * tight). earlyExit returns on the first conflict
 * (margin < 0); the full scan is only used to pick the least-bad candidate
 * when every candidate conflicts. In full-scan mode, `abortBelow` (the best
 * margin found by a previous candidate) lets a losing candidate bail the
 * moment its running margin can no longer win the least-bad comparison.
 */
function evaluate(
  w: Prepped,
  samples: Float64Array,
  radii: Float64Array | null,
  maxRad: number,
  n: number,
  bb: Bounds,
  grid: SampleGrid,
  routedW: Prepped[],
  obstacles: RouteObstacle[],
  earlyExit: boolean,
  abortBelow = -Infinity,
): number {
  let margin = Infinity
  let bindIdx = -1
  BIND_IDX = -1

  for (const o of obstacles) {
    if (
      bb.maxX + maxRad < o.minX ||
      bb.minX - maxRad > o.maxX ||
      bb.maxZ + maxRad < o.minZ ||
      bb.minZ - maxRad > o.maxZ
    ) {
      continue
    }
    const lim = o.height + OBSTACLE_CLEARANCE
    if (bb.minY - maxRad >= lim) continue
    for (let i = 0; i < n; i++) {
      const r = radii ? radii[i] : 0
      const x = samples[3 * i]
      if (x < o.minX - r || x > o.maxX + r) continue
      const z = samples[3 * i + 2]
      if (z < o.minZ - r || z > o.maxZ + r) continue
      const m = samples[3 * i + 1] - lim - r
      if (m < margin) {
        margin = m
        bindIdx = i
        if (earlyExit && margin < 0) return margin
        if (margin <= abortBelow) return margin
      }
    }
  }

  if (routedW.length > 0) {
    let minM = Infinity
    let bindP = -1
    /** sharedEndpoints() per conflicting item, computed at most once each */
    let sharedCache: Map<number, number[]> | null = null
    /**
     * scan one bucket map (thin or fat) around sample i. Returns NaN to keep
     * going, or the evaluate() result when the scan terminates the whole
     * call (early-exit conflict / margin fell to abortBelow).
     */
    const scan = (
      buckets: Map<number, number[]>,
      cell: number,
      reach: number,
      cache: WindowCache,
      i: number,
      x: number,
      y: number,
      z: number,
      rc: number,
    ): number => {
      const ix0 = Math.floor((x - reach) / cell)
      const ix1 = Math.floor((x + reach) / cell)
      const iy0 = Math.floor((y - reach) / cell)
      const iy1 = Math.floor((y + reach) / cell)
      const iz0 = Math.floor((z - reach) / cell)
      const iz1 = Math.floor((z + reach) / cell)
      if (
        !cache.valid ||
        ix0 !== cache.ix0 ||
        ix1 !== cache.ix1 ||
        iy0 !== cache.iy0 ||
        iy1 !== cache.iy1 ||
        iz0 !== cache.iz0 ||
        iz1 !== cache.iz1
      ) {
        cache.count = 0
        for (let ix = ix0; ix <= ix1; ix++) {
          for (let iy = iy0; iy <= iy1; iy++) {
            for (let iz = iz0; iz <= iz1; iz++) {
              const bucket = buckets.get(cellKey(ix, iy, iz))
              if (bucket) cache.list[cache.count++] = bucket
            }
          }
        }
        cache.ix0 = ix0
        cache.ix1 = ix1
        cache.iy0 = iy0
        cache.iy1 = iy1
        cache.iz0 = iz0
        cache.iz1 = iz1
        cache.valid = true
      }
      const data = grid.data
      for (let bi = 0; bi < cache.count; bi++) {
        const bucket = cache.list[bi]
        for (let bj = 0; bj < bucket.length; bj++) {
          const j4 = bucket[bj] * 4
          const req = WIRE_CLEARANCE + rc + data[j4 + 3]
          const dx = x - data[j4]
          const dy = y - data[j4 + 1]
          const dz = z - data[j4 + 2]
          const d2 = dx * dx + dy * dy + dz * dz
          if (earlyExit) {
            if (d2 >= req * req) continue
          } else {
            // skip pairs that cannot beat the best margin found so far
            const cap = minM + req
            if (cap <= 0 || d2 >= cap * cap) continue
          }
          const ownerIdx = grid.owner[bucket[bj]]
          // routeOne sort-position preview: items that would route AFTER the
          // candidate (and dodge it on commit) are invisible to it
          if (ownerIdx >= PREVIEW_OWNER_LIMIT) continue
          sharedCache ??= new Map()
          let shared = sharedCache.get(ownerIdx)
          if (shared === undefined) {
            shared = sharedEndpoints(w, routedW[ownerIdx])
            sharedCache.set(ownerIdx, shared)
          }
          if (shared.length > 0 && isSharedZone(shared, x, z, data[j4], data[j4 + 2])) {
            continue
          }
          const m = Math.sqrt(d2) - req
          if (earlyExit) return m
          if (m < minM) {
            minM = m
            bindP = i
            if (minM <= abortBelow) return m
          }
        }
      }
      return NaN
    }
    THIN_CACHE.valid = false
    FAT_CACHE.valid = false
    const queryFat = grid.fatBuckets.size > 0
    for (let i = 0; i < n; i++) {
      const rc = radii ? radii[i] : 0
      const x = samples[3 * i]
      const y = samples[3 * i + 1]
      const z = samples[3 * i + 2]
      const rt = scan(grid.buckets, CELL, WIRE_CLEARANCE + rc, THIN_CACHE, i, x, y, z, rc)
      if (!Number.isNaN(rt)) return rt
      if (queryFat) {
        const reachF = WIRE_CLEARANCE + rc + grid.maxR
        if (
          x >= grid.fatMinX - reachF &&
          x <= grid.fatMaxX + reachF &&
          y >= grid.fatMinY - reachF &&
          y <= grid.fatMaxY + reachF &&
          z >= grid.fatMinZ - reachF &&
          z <= grid.fatMaxZ + reachF
        ) {
          const rf = scan(grid.fatBuckets, CELL_FAT, reachF, FAT_CACHE, i, x, y, z, rc)
          if (!Number.isNaN(rf)) return rf
        }
      }
    }
    if (minM < margin) {
      margin = minM
      bindIdx = bindP
    }
  }
  BIND_IDX = bindIdx
  return margin
}

// ------------------------------------------------------------------ routing

interface Candidate {
  tier: number
  /** signed lateral offset in LATERAL_STEP units */
  lat: number
}

/**
 * The fixed conflict-resolution ladder, cheapest candidate first: every
 * (lift tier, lateral offset) combination ordered by tier + latCost·|lat|.
 * Ties prefer the lower tier, then the positive side (deterministic).
 */
function buildLadder(latCost: number): Candidate[] {
  const out: Candidate[] = []
  for (let tier = 0; tier <= MAX_BUMP_TIERS; tier++) {
    for (let l = 0; l <= LATERAL_MAX_STEPS; l++) {
      out.push({ tier, lat: l })
      if (l > 0) out.push({ tier, lat: -l })
    }
  }
  const cost = (c: Candidate) => c.tier + latCost * Math.abs(c.lat)
  out.sort((a, b) => cost(a) - cost(b) || a.tier - b.tier || b.lat - a.lat)
  return out
}

/** Wire ladder: flat sideways dodges are tried before lift bumps. STANDING
 *  (radial) bodies use it too — their packed-part nesting mechanism is
 *  exactly the cheap lateral + half-tier combination (see wires.ts
 *  ROUTED_BODY: the LED/cap diameters are tuned to its reachable plan
 *  separations). */
const CANDIDATES: Candidate[] = buildLadder(LATERAL_COST)
/** AXIAL component ladder: vertical-plane (lift) resolution first — stiff
 *  leads bend up, not into lazy horizontal S-sweeps (DESIGN §4b: raise the
 *  height tier and hairpin the legs, never fan packed parts sideways). */
const CANDIDATES_COMPONENT: Candidate[] = buildLadder(LATERAL_COST_COMPONENT)

interface VertCand {
  mag: number
  /** unit plan lean direction (0,0 when upright) */
  dx: number
  dz: number
}

/**
 * Vertical-mount conflict ladder: upright first, then growing lean angles
 * toward each of the four plan axes of the part's own frame (perpendicular
 * sides first — adjacent same-strip parts separate sideways). Deterministic.
 */
function vertCandidates(w: Prepped): VertCand[] {
  const out: VertCand[] = [{ mag: 0, dx: 0, dz: 0 }]
  const dirs: [number, number][] = [
    [w.px, w.pz],
    [-w.px, -w.pz],
    [w.ux, w.uz],
    [-w.ux, -w.uz],
  ]
  for (let mag = 1; mag <= TILT_MAX_STEPS; mag++) {
    for (const [dx, dz] of dirs) out.push({ mag, dx, dz })
  }
  return out
}

function contains(o: RouteObstacle, x: number, z: number): boolean {
  return x >= o.minX && x <= o.maxX && z >= o.minZ && z <= o.maxZ
}

/** Widest plan bulge any candidate of this item can take (bbox prefilters). */
function planReach(w: Prepped): number {
  if (w.kind === 'component') {
    if (w.style === 'vertical') {
      return 0.5 + w.bodyR + Math.sin(TILT_STEP * TILT_MAX_STEPS) * w.bodyLen
    }
    return (
      LATERAL_STEP * LATERAL_MAX_STEPS + 0.5 + w.bodyR + Math.max(0, (w.bodyLen - w.len) / 2)
    )
  }
  return LATERAL_STEP * LATERAL_MAX_STEPS + 0.5
}

// shared scratch buffers (also keeps routeOne previews allocation-free)
const SCRATCH = new Float64Array(MAX_SAMPLES * 3)
const SCRATCH_R = new Float64Array(MAX_SAMPLES)
const BB: Bounds = { minX: 0, maxX: 0, minY: 0, maxY: 0, minZ: 0, maxZ: 0 }
/**
 * Per-candidate margin upper bounds harvested from the early-exit ladder:
 * the first conflict a failing candidate hits is ≥ its true minimum margin,
 * so the least-bad pass can skip (sample + full-scan) any candidate whose
 * bound already cannot beat the running best + tie band — exact, and it
 * eliminates most of the ~60 full scans a jammed item would otherwise pay.
 */
const CAND_UB = new Float64Array(64)
/**
 * Per-candidate sample memo: the early-exit ladder samples every candidate
 * once; the least-bad pass and the final accept reuse those samples instead
 * of re-running the (trig-heavy) samplers — sampling was ~30% of routing.
 */
const CAND_S: Float64Array[] = []
const CAND_RD: Float64Array[] = []
const CAND_N = new Int32Array(64)
const CAND_BB: Bounds[] = []
for (let i = 0; i < 64; i++) {
  CAND_S.push(new Float64Array(MAX_SAMPLES * 3))
  CAND_RD.push(new Float64Array(MAX_SAMPLES))
  CAND_BB.push({ minX: 0, maxX: 0, minY: 0, maxY: 0, minZ: 0, maxZ: 0 })
}

/**
 * Bucket-window cache: consecutive collision samples sit ~0.3 units apart,
 * well inside one 0.9 grid cell, so the 8-bucket query window is usually
 * IDENTICAL between neighbouring samples. Caching the gathered bucket list
 * cuts Map lookups (the routing hot spot) to roughly a third. One cache per
 * grid kind; invalidated at every evaluate() entry (the grid only mutates
 * between items).
 */
interface WindowCache {
  ix0: number
  iy0: number
  iz0: number
  ix1: number
  iy1: number
  iz1: number
  list: number[][]
  count: number
  valid: boolean
}

function newWindowCache(): WindowCache {
  return { ix0: 0, iy0: 0, iz0: 0, ix1: -1, iy1: -1, iz1: -1, list: [], count: 0, valid: false }
}

const THIN_CACHE = newWindowCache()
const FAT_CACHE = newWindowCache()

interface RoutedInternal {
  item: RoutedItem
  /** accepted candidate's collision samples (xyz interleaved) + fat radii */
  n: number
  samples: Float64Array
  radii: Float64Array | null
}

/**
 * Append the fixed exit-prefix collision samples (terminal rise column +
 * level exit run) of an ACCEPTED wire to its sample buffer. Deliberately not
 * part of candidate evaluation — the prefix cannot move, so clashes on it
 * could never be fixed by the ladder (and the prefix legitimately crosses
 * its own instrument's box footprint in front of the face) — but later paths
 * must keep wire clearance from it. Returns the new sample count.
 */
function appendExitSamples(w: Prepped, out: Float64Array, count: number): number {
  for (const e of [w.exitA, w.exitB]) {
    if (!e) continue
    const kCol = Math.max(2, Math.ceil(ENTRY_RISE / SAMPLE_SPACING))
    for (let i = 0; i <= kCol; i++) {
      if (count >= MAX_SAMPLES) return count
      const o = 3 * count++
      out[o] = e.x
      out[o + 1] = (ENTRY_RISE * i) / kCol
      out[o + 2] = e.z
    }
    const kRun = Math.max(2, Math.ceil(EXIT_RUN / SAMPLE_SPACING))
    for (let i = 1; i <= kRun; i++) {
      if (count >= MAX_SAMPLES) return count
      const o = 3 * count++
      out[o] = e.x + (e.dx * EXIT_RUN * i) / kRun
      out[o + 1] = ENTRY_RISE
      out[o + 2] = e.z + (e.dz * EXIT_RUN * i) / kRun
    }
  }
  return count
}

function routeWireItem(
  w: Prepped,
  grid: SampleGrid,
  routed: Prepped[],
  relevant: RouteObstacle[],
): RoutedInternal {
  let acceptedCi = -1
  for (let ci = 0; ci < CANDIDATES.length; ci++) {
    const c = CANDIDATES[ci]
    const lift = w.baseLift + LIFT_STEP * c.tier
    const n = samplePath(w, lift, LATERAL_STEP * c.lat, CAND_S[ci], CAND_BB[ci])
    CAND_N[ci] = n
    if (ci === 0) saveFixedRanges()
    const m = evaluate(w, CAND_S[ci], null, 0, n, CAND_BB[ci], grid, routed, relevant, true)
    if (m >= 0) {
      acceptedCi = ci
      break
    }
    CAND_UB[ci] = m
  }
  if (acceptedCi < 0) {
    // every candidate conflicts — accept the least-bad one (max clearance;
    // margins within MARGIN_TIE_EPS tie, and ties go to the CHEAPEST
    // candidate so sampling noise can never crown a needless tower)
    let bestMargin = -Infinity
    acceptedCi = 0
    for (let ci = 0; ci < CANDIDATES.length; ci++) {
      const threshold = bestMargin + MARGIN_TIE_EPS
      if (CAND_UB[ci] <= threshold) continue // provably cannot win
      const margin = evaluate(
        w, CAND_S[ci], null, 0, CAND_N[ci], CAND_BB[ci], grid, routed, relevant, false, threshold,
      )
      if (margin > threshold) {
        bestMargin = margin
        acceptedCi = ci
      }
      // unfixable-conflict shortcut: the cheapest candidate's binding clash
      // sits on a fixed entry column no candidate can move — every other
      // candidate is capped by that same clash, so the cheapest one keeps
      // the win (the tie band would eat sampling noise anyway). Skips the
      // other ~60 full scans.
      if (ci === 0 && bindIsFixed()) break
    }
  }
  const accepted = CANDIDATES[acceptedCi]
  const lift = w.baseLift + LIFT_STEP * accepted.tier
  const lat = LATERAL_STEP * accepted.lat
  // fixed terminal-exit prefixes join the grid samples here (post-acceptance)
  const n = appendExitSamples(w, CAND_S[acceptedCi], CAND_N[acceptedCi])
  return {
    item: { waypoints: buildWaypoints(w, lift, lat), style: styleFor(w, lift) },
    n,
    samples: CAND_S[acceptedCi],
    radii: null,
  }
}

function routeSpanComponent(
  w: Prepped,
  grid: SampleGrid,
  routed: Prepped[],
  relevant: RouteObstacle[],
): RoutedInternal {
  // axial bodies resolve vertically first; standing (radial) bodies keep the
  // lateral-cheap wire ladder their nesting geometry was tuned for
  const ladder = w.standing > 0 ? CANDIDATES : CANDIDATES_COMPONENT
  let acceptedCi = -1
  for (let ci = 0; ci < ladder.length; ci++) {
    const c = ladder[ci]
    const lift = w.baseLift + LIFT_STEP * c.tier
    const n = sampleSpan(w, lift, LATERAL_STEP * c.lat, CAND_S[ci], CAND_RD[ci], CAND_BB[ci])
    CAND_N[ci] = n
    if (ci === 0) saveFixedRanges()
    const m = evaluate(
      w, CAND_S[ci], CAND_RD[ci], w.bodyR, n, CAND_BB[ci], grid, routed, relevant, true,
    )
    if (m >= 0) {
      acceptedCi = ci
      break
    }
    CAND_UB[ci] = m
  }
  if (acceptedCi < 0) {
    let bestMargin = -Infinity
    acceptedCi = 0
    for (let ci = 0; ci < ladder.length; ci++) {
      const threshold = bestMargin + MARGIN_TIE_EPS
      if (CAND_UB[ci] <= threshold) continue // provably cannot win
      const margin = evaluate(
        w, CAND_S[ci], CAND_RD[ci], w.bodyR, CAND_N[ci], CAND_BB[ci],
        grid, routed, relevant, false, threshold,
      )
      if (margin > threshold) {
        bestMargin = margin
        acceptedCi = ci
      }
      // unfixable-conflict shortcut (see routeWireItem)
      if (ci === 0 && bindIsFixed()) break
    }
  }
  const accepted = ladder[acceptedCi]
  const lift = w.baseLift + LIFT_STEP * accepted.tier
  const lat = LATERAL_STEP * accepted.lat
  const { r } = spanFlat(w)
  const latC = lateralRamped(w.len / 2, w.len, lat, Math.min(LATERAL_RAMP, r))
  const item: RoutedComponentPath = {
    waypoints: buildSpanWaypoints(w, lift, lat),
    style: 'span',
    bodyCenter: {
      x: w.ax + w.ux * (w.len / 2) + w.px * latC,
      y: lift,
      z: w.az + w.uz * (w.len / 2) + w.pz * latC,
    },
    bodyDir: { x: w.ux, y: 0, z: w.uz },
  }
  return { item, n: CAND_N[acceptedCi], samples: CAND_S[acceptedCi], radii: CAND_RD[acceptedCi] }
}

function routeVerticalComponent(
  w: Prepped,
  grid: SampleGrid,
  routed: Prepped[],
  relevant: RouteObstacle[],
): RoutedInternal {
  const cands = vertCandidates(w)
  let acceptedCi = -1
  for (let ci = 0; ci < cands.length; ci++) {
    const c = cands[ci]
    const n = sampleVertical(
      w, TILT_STEP * c.mag, c.dx, c.dz, CAND_S[ci], CAND_RD[ci], CAND_BB[ci], false,
    )
    CAND_N[ci] = n
    if (ci === 0) saveFixedRanges()
    const m = evaluate(
      w, CAND_S[ci], CAND_RD[ci], w.bodyR, n, CAND_BB[ci], grid, routed, relevant, true,
    )
    if (m >= 0) {
      acceptedCi = ci
      break
    }
    CAND_UB[ci] = m
  }
  if (acceptedCi < 0) {
    let bestMargin = -Infinity
    acceptedCi = 0
    for (let ci = 0; ci < cands.length; ci++) {
      const threshold = bestMargin + MARGIN_TIE_EPS
      if (CAND_UB[ci] <= threshold) continue // provably cannot win
      const margin = evaluate(
        w, CAND_S[ci], CAND_RD[ci], w.bodyR, CAND_N[ci], CAND_BB[ci],
        grid, routed, relevant, false, threshold,
      )
      if (margin > threshold) {
        bestMargin = margin
        acceptedCi = ci
      }
      // unfixable-conflict shortcut (see routeWireItem) — exact here: the
      // A/B columns are tilt-invariant
      if (ci === 0 && bindIsFixed()) break
    }
  }
  const accepted = cands[acceptedCi]
  const tilt = TILT_STEP * accepted.mag
  const g = vertGeom(w, tilt, accepted.dx, accepted.dz)
  // grid samples include the soft base section (later paths must dodge it)
  const n = sampleVertical(w, tilt, accepted.dx, accepted.dz, SCRATCH, SCRATCH_R, BB, true)
  const sin = Math.sin(tilt)
  const cos = Math.cos(tilt)
  const item: RoutedComponentPath = {
    waypoints: buildVerticalWaypoints(w, g),
    style: 'vertical',
    bodyCenter: {
      x: w.ax + accepted.dx * sin * (w.bodyLen / 2),
      y: V_BASE_Y + cos * (w.bodyLen / 2),
      z: w.az + accepted.dz * sin * (w.bodyLen / 2),
    },
    bodyDir: { x: accepted.dx * sin, y: cos, z: accepted.dz * sin },
  }
  if (accepted.mag > 0) item.tilt = tilt
  return { item, n, samples: SCRATCH, radii: SCRATCH_R }
}

/** Route one prepped item against the current world state (read-only). */
function routeItem(
  w: Prepped,
  grid: SampleGrid,
  routed: Prepped[],
  obstacles: RouteObstacle[],
): RoutedInternal {
  // obstacle prefilter: boxes containing one of this item's endpoints are
  // skipped outright (a path plugged beside/under a part cannot avoid it —
  // its vertical entry is clash-free by construction; a component's own
  // footprint box would otherwise self-collide), as are boxes the item's
  // plan bbox cannot possibly touch
  const reach = planReach(w)
  const loX = Math.min(w.ax, w.bx) - reach
  const hiX = Math.max(w.ax, w.bx) + reach
  const loZ = Math.min(w.az, w.bz) - reach
  const hiZ = Math.max(w.az, w.bz) + reach
  const relevant: RouteObstacle[] = []
  for (const o of obstacles) {
    if (o.maxX < o.minX || o.maxZ < o.minZ) continue
    if (hiX < o.minX || loX > o.maxX || hiZ < o.minZ || loZ > o.maxZ) continue
    if (contains(o, w.ax, w.az) || contains(o, w.bx, w.bz)) continue
    relevant.push(o)
  }
  if (w.kind === 'component') {
    return w.style === 'vertical'
      ? routeVerticalComponent(w, grid, routed, relevant)
      : routeSpanComponent(w, grid, routed, relevant)
  }
  return routeWireItem(w, grid, routed, relevant)
}

/** Routing order: components before wires, span desc, id asc (deterministic). */
function routeOrder(a: Prepped, b: Prepped): number {
  const ka = a.kind === 'component' ? 0 : 1
  const kb = b.kind === 'component' ? 0 : 1
  return ka - kb || b.len - a.len || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
}

/** World collision state retained for routeOne previews (never mutated by them). */
interface WorldState {
  grid: SampleGrid
  routed: Prepped[]
  /** plain obstacles PLUS the instrument boxes (the collision view) */
  obstacles: RouteObstacle[]
  /** instruments as given — routeOne candidates resolve terminal exits here */
  instruments: InstrumentObstacle[]
}

const WORLD_STATE = new WeakMap<RoutedWorld, WorldState>()

/**
 * routeOne's sort-position simulation: grid samples owned by routed items at
 * or after this index (in routeAll order) are invisible to the candidate's
 * collision pass — those items would route AFTER the candidate on commit and
 * dodge it, never the other way around. Infinity outside routeOne, so
 * routeAll itself always sees every sample.
 */
let PREVIEW_OWNER_LIMIT = Infinity

/**
 * Route every item — leaded components FIRST (so wires dodge bodies, never
 * vice versa), then wires; each group longest span first, ties by id asc.
 * Returns a map keyed by item id, usable as the world for routeOne().
 *
 * `instruments` (optional) adds off-board instrument boxes: solid collision
 * obstacles like any component box, plus terminal posts — a wire whose
 * endpoint sits on a terminal routes with a fixed exit segment along the
 * terminal's exitDir (see module doc). Routing stays fully deterministic.
 */
export function routeAll(
  items: RouteItemInput[],
  obstacles: RouteObstacle[],
  instruments: InstrumentObstacle[] = [],
): RoutedWorld {
  const result: RoutedWorld = new Map()
  const allObstacles =
    instruments.length > 0 ? [...obstacles, ...instruments.map(instrumentBox)] : obstacles
  const prepped = items.map((it) => prepItemWithExits(it, instruments))
  prepped.sort(routeOrder)

  const grid = newGrid()
  const routed: Prepped[] = []
  for (const w of prepped) {
    const { item, n, samples, radii } = routeItem(w, grid, routed, allObstacles)
    const ownerIdx = routed.length
    for (let i = 0; i < n; i++) {
      gridAdd(
        grid,
        samples[3 * i],
        samples[3 * i + 1],
        samples[3 * i + 2],
        ownerIdx,
        radii ? radii[i] : 0,
      )
    }
    routed.push(w)
    result.set(w.id, item)
  }
  WORLD_STATE.set(result, {
    grid,
    routed,
    obstacles: allObstacles.slice(),
    instruments: instruments.slice(),
  })
  return result
}

/**
 * Route every wire, collision-free where geometrically possible.
 * Returns a map keyed by wire id (routing order: span desc, id asc).
 * Wire-only convenience wrapper over routeAll — identical results.
 */
export function routeWires(
  wires: RouteWireInput[],
  obstacles: RouteObstacle[],
  instruments: InstrumentObstacle[] = [],
): Map<string, RoutedWire> {
  return routeAll(wires, obstacles, instruments) as Map<string, RoutedWire>
}

/**
 * Preview routing for ONE extra candidate (ghost component / dragged wire)
 * against a world previously returned by routeAll/routeWires — nothing is
 * recomputed and the world is not mutated. The candidate is routed at its
 * TRUE routeAll sort position: items that would route after it (every wire
 * when the candidate is a component; shorter-span items of its own kind) are
 * invisible to its collision pass, exactly as on commit. Items routed before
 * it are unaffected by inserting it (routing is sequential), so the result
 * equals the candidate's own item in routeAll() with it added — committing
 * never changes the previewed path, only later-routing items may shift to
 * dodge it. Sole caveat: an exact span-length tie breaks by id in routeAll,
 * which the preview cannot know; it assumes the candidate routes after its
 * ties (true for freshly appended ids in practice).
 */
export function routeOne(
  existingRouted: RoutedWorld,
  candidate: RouteItemInput,
): RoutedItem {
  const state = WORLD_STATE.get(existingRouted)
  if (!state) {
    throw new Error('routeOne: world must come from routeAll()/routeWires()')
  }
  // terminal-exit resolution mirrors routeAll exactly (preview = commit)
  const w = prepItemWithExits(candidate, state.instruments)
  // state.routed is in routeAll order (components first, span desc): the
  // candidate's sort position is the first item it would strictly precede
  // by kind/length (ties keep the candidate after — see doc above).
  const kw = w.kind === 'component' ? 0 : 1
  let limit = state.routed.length
  for (let i = 0; i < state.routed.length; i++) {
    const r = state.routed[i]
    const kr = r.kind === 'component' ? 0 : 1
    if (kw < kr || (kw === kr && w.len > r.len)) {
      limit = i
      break
    }
  }
  PREVIEW_OWNER_LIMIT = limit
  try {
    return routeItem(w, state.grid, state.routed, state.obstacles).item
  } finally {
    PREVIEW_OWNER_LIMIT = Infinity
  }
}

/**
 * Convert a routed component path into the mesh builders' RoutedComponent
 * render contract (see below): the flat marked waypoint run splits at
 * bodyStart/bodyEnd into per-lead paths, each starting at its hole (y = 0)
 * and ending at the body lead exit. Falls back to empty lead paths when the
 * markers are missing (builders treat that as a malformed pose).
 */
export function toRoutedPose(r: RoutedComponentPath): RoutedComponent {
  const i0 = r.waypoints.findIndex((p) => p.marker === 'bodyStart')
  const i1 = r.waypoints.findIndex((p) => p.marker === 'bodyEnd')
  const waypoints: RoutePoint[][] =
    i0 >= 0 && i1 > i0
      ? [r.waypoints.slice(0, i0 + 1), r.waypoints.slice(i1).reverse()]
      : []
  return {
    pose: r.style,
    bodyCenter: r.bodyCenter,
    bodyDir: r.bodyDir,
    waypoints,
  }
}

// ------------------------------------------------- routed component poses
// Type-only contract between the component-pose planner (scene side) and the
// mesh builders (src/three/component-meshes.ts buildComponentObject's
// optional `routed` parameter). No runtime code.

/**
 * Router-planned pose for a 2/3-lead leaded part.
 *
 * - `pose: 'span'` — body axis level over the board at bodyCenter.y;
 *   `'vertical'` — standing on end (vertical-mount resistor style). Any
 *   tilt is encoded directly in `bodyDir`; no separate angle field.
 * - `bodyCenter` — world center of the body (plan units, y up).
 * - `bodyDir` — unit body-axis direction, lead 0 → lead 1 for axial parts
 *   (resistor/diode/inductor); for radial/standing parts it is the lead-span
 *   axis used for yaw.
 * - `waypoints[i]` — lead path for catalog pin i: ≥ 2 points from (or to)
 *   the pin's hole at y=0 to the body lead exit. Builders render each as a
 *   smooth rounded tube and bury the body end inside the body.
 */
export interface RoutedComponent {
  pose: 'span' | 'vertical'
  bodyCenter: RoutePoint
  bodyDir: RoutePoint
  waypoints: RoutePoint[][]
}
