/**
 * The breadboard mesh, size- AND rig-aware (multi-board "lab station" rigs),
 * authored for the PBR pipeline in scene.ts (IBL + ACES + one soft shadow
 * map):
 *
 *  - injection-molded ABS body (MeshPhysicalMaterial, thin clearcoat, subtle
 *    procedural noise normal map) built from extruded rounded-corner slabs so
 *    the outline gets gentle edge fillets, with a real recessed center channel
 *  - TRUE recessed hole sockets: a square bore is PUNCHED through every
 *    slab's top face (Shape.holes on the extrusion — the face stays flush,
 *    exactly like the reference photos), and three InstancedMeshes descend
 *    inside each bore: a chamfered square funnel collar, a dark tapering
 *    shaft, and the metal contact plug at the bottom
 *  - a per-module decal (CanvasTexture color + bump pair on a lit material):
 *    painted rail-stripe grooves with lip shading, AO-style darkening around
 *    every hole, printed legend (column numbers CONTINUING across modules,
 *    row letters, ± signs) and an embossed "BREADBOARD STUDIO" + rig brand
 *
 * Multi-board rigs (`BoardConfig.count` > 1) render as a mounted lab station,
 * matching the electrical model exactly: per-module TERMINAL-STRIP slabs
 * tiled left→right, ABUTTING at every module boundary (module n's hull ends
 * exactly where module n+1's begins) — the seam reads as a thin V-groove IN
 * the plastic where the two edge fillets meet, never as a see-through air
 * gap — while the power-rail BUS STRIPS run as two continuous slabs along
 * the whole rig, because the rails are bused into single nets (and because
 * the continuous rail-hole lattice puts holes exactly on the column seams: a
 * per-module rail body is geometrically impossible). The bus strips abut the
 * terminal block the same way (groove at z 1.9 / 14.1, like a real
 * snap-together breadboard). Each module's group is exposed via `modules` so
 * the scene can animate a freshly added module into place.
 *
 * BOARD-ROW grids (`BoardConfig.rows` > 1, see model/types.ts) stack
 * additional FULL rig rows front-to-back at `boardRowZs` offsets
 * (BOARD_ROW_PITCH = one row's full mesh depth, so consecutive rows ABUT
 * with the same thin-groove seam treatment as the module columns). Interior
 * row edges are built SQUARE (a second slab-geometry variant) so abutting
 * rows meet flush — the rounded outline corners survive only on the rig's
 * outer front/back edges. Every row otherwise shares ONE set of geometries /
 * materials / decal textures (a deeper grid costs meshes, not GPU
 * resources); each row's group is exposed via `rowGroups` and its module
 * slices via `moduleGroups[row][module]` so the scene can animate freshly
 * added rows/modules into place on any edge of the 2-D grid.
 *
 * All positions come from src/model/breadboard.ts helpers — nothing here
 * re-derives hole math. Runs headless (no DOM → decal is skipped) so the
 * geometry can be unit-tested in node.
 */

import * as THREE from 'three'
import {
  RAIL_Z,
  ROW_Z,
  allHoles,
  boardExtents,
  boardRowZs,
  holePosition,
  moduleOfCol,
  moduleSeamXs,
} from '../../model/breadboard'
import {
  BOARD_SIZES,
  STRIP_ROWS,
  asBoardConfig,
  boardRowsOf,
  type BoardConfig,
  type BoardSizeId,
} from '../../model/types'
import { noiseNormalTexture } from '../meshes/shared'

export interface BoardBuild {
  group: THREE.Group
  /** the board preset this mesh was built for */
  size: BoardSizeId
  /** the full rig (size × module count × board-rows) — the scene diffs against this */
  config: BoardConfig
  /**
   * FRONT-ROW per-module groups, left → right (`config.count` entries) —
   * kept for back-compat with single-row callers. Module bodies, strip-hole
   * sockets and the printed decal live inside; on multi-board rigs the
   * continuous rail bus strips do NOT (they span the whole rig row).
   * Equals `moduleGroups[0]`.
   */
  modules: THREE.Group[]
  /**
   * One group per BOARD-ROW, front row first (`rows` entries, already
   * positioned at their boardRowZs z offsets). The scene animates an entry
   * when a row is added to the grid.
   */
  rowGroups: THREE.Group[]
  /**
   * Module groups per board-row: `moduleGroups[row][module]`. The scene
   * animates one column of these when a module is added (left/right growth
   * springs every row's new module slice together).
   */
  moduleGroups: THREE.Group[][]
  dispose(): void
}

const BODY_THICKNESS = 1.2
const CHANNEL_HALF_WIDTH = 0.5 // groove spans z 7.5..8.5 (between rows e and f)
const CHANNEL_DEPTH = 0.45
/** edge fillet of the molded body (extrude bevel) */
const FILLET = 0.07
/** rounding radius of the outer board corners */
const CORNER_R = 0.55
/**
 * Recessed hole socket — a REAL countersink cut into the slab. Every slab
 * shape gets a square hole of HOLE_CUT half-side punched through it (the
 * extrude bevel adds its own tiny chamfer at the mouth), so the board face
 * stays one flush plane with dark wells — never raised collars. Inside each
 * bore, three instanced meshes (all sitting BELOW y = 0):
 *   - a chamfered square funnel from RIM_OUTER (slightly wider than the cut,
 *     so the seam hides under the face) down to RIM_INNER at CHAMFER_DEPTH,
 *     rendered BackSide — the camera sees its interior walls
 *   - a darker square shaft tapering to SHAFT_TAPER × RIM_INNER
 *   - the metal contact plug at the bottom of the bore (PLUG_TOP_Y)
 * The face-edge → plug-floor parallax is real geometric depth now, visible
 * from any angle the mouth is visible from.
 */
const HOLE_CUT = 0.34
const RIM_OUTER = 0.4
const RIM_INNER = 0.21
const CHAMFER_DEPTH = 0.16
/** shaft bore: tapers to SHAFT_TAPER × RIM_INNER at the plug floor */
const SHAFT_TAPER = 0.78
const PLUG_TOP_Y = -0.3
const PLUG_THICKNESS = 0.05

/**
 * Seam treatment (user-acceptance: modules must visually ABUT, never show
 * the desk through a slot): adjacent hulls share their boundary plane
 * exactly — module n's maxX == module n+1's minX — and the slab shapes are
 * inset by FILLET with the extrude bevel growing back to the hull, so two
 * abutting slabs meet in a shallow 2×FILLET-wide V-groove cut INTO the
 * plastic. A matching printed seam line in the decal keeps the joint legible
 * from directly above. The same construction joins the rail bus strips to
 * the terminal block (z = BUS_TOP_Z / BUS_BOT_Z) and consecutive board-rows
 * (BOARD_ROW_PITCH = full mesh depth).
 */
const BUS_TOP_Z = 1.9
const BUS_BOT_Z = 14.1

/** z offset of each painted stripe line (outside-facing edge of its rail). */
const STRIPES: { z: number; red: boolean }[] = [
  { z: RAIL_Z['top+'] - 0.5, red: true },
  { z: RAIL_Z['top-'] + 0.5, red: false },
  { z: RAIL_Z['bot-'] - 0.5, red: false },
  { z: RAIL_Z['bot+'] + 0.5, red: true },
]

const RED = '#b23327'
const BLUE = '#3353b5'
const INK = '#56544c'

/**
 * Plan outline of one body slab: the two corners on `roundedEdge` (the board's
 * outer edge) get a CORNER_R radius; the channel-facing edge stays square (the
 * extrude bevel chamfers it). `'none'` keeps every corner square — used for
 * the interior-row variants of a 2-D grid, whose front/back edges abut the
 * neighboring board-row flush. Shape space is (x, z).
 */
function slabShape(
  x0: number,
  x1: number,
  zA: number,
  zB: number,
  roundedEdge: 'a' | 'b' | 'none',
): THREE.Shape {
  if (roundedEdge === 'none') return rectShape(x0, x1, zA, zB)
  const s = new THREE.Shape()
  const r = Math.min(CORNER_R, (x1 - x0) / 4, Math.abs(zB - zA) / 2)
  if (roundedEdge === 'a') {
    s.moveTo(x0 + r, zA)
    s.lineTo(x1 - r, zA)
    s.quadraticCurveTo(x1, zA, x1, zA + r)
    s.lineTo(x1, zB)
    s.lineTo(x0, zB)
    s.lineTo(x0, zA + r)
    s.quadraticCurveTo(x0, zA, x0 + r, zA)
  } else {
    s.moveTo(x0, zA)
    s.lineTo(x1, zA)
    s.lineTo(x1, zB - r)
    s.quadraticCurveTo(x1, zB, x1 - r, zB)
    s.lineTo(x0 + r, zB)
    s.quadraticCurveTo(x0, zB, x0, zB - r)
    s.lineTo(x0, zA)
  }
  return s
}

/** Plain rectangular slab plan (interior terminal strips of a multi-board rig). */
function rectShape(x0: number, x1: number, zA: number, zB: number): THREE.Shape {
  const s = new THREE.Shape()
  s.moveTo(x0, zA)
  s.lineTo(x1, zA)
  s.lineTo(x1, zB)
  s.lineTo(x0, zB)
  s.lineTo(x0, zA)
  return s
}

/**
 * Punch a square socket bore (HOLE_CUT half-side) through a slab plan shape
 * for every hole position — the extrusion then has REAL recesses cut into
 * its flush top face (ExtrudeGeometry handles hole winding itself).
 */
function punchHoles(shape: THREE.Shape, holes: readonly { x: number; z: number }[]): THREE.Shape {
  for (const p of holes) {
    const h = new THREE.Path()
    h.moveTo(p.x - HOLE_CUT, p.z - HOLE_CUT)
    h.lineTo(p.x + HOLE_CUT, p.z - HOLE_CUT)
    h.lineTo(p.x + HOLE_CUT, p.z + HOLE_CUT)
    h.lineTo(p.x - HOLE_CUT, p.z + HOLE_CUT)
    h.closePath()
    shape.holes.push(h)
  }
  return shape
}

/** Extrude a slab plan shape down from y=0 to y=-BODY_THICKNESS with fillets. */
function slabGeometry(shape: THREE.Shape): THREE.ExtrudeGeometry {
  const geo = new THREE.ExtrudeGeometry(shape, {
    depth: BODY_THICKNESS - 2 * FILLET,
    bevelEnabled: true,
    bevelThickness: FILLET,
    bevelSize: FILLET,
    bevelSegments: 2,
    curveSegments: 6,
  })
  // shape (x, z) extruded along +w → rotate so w becomes -y and v becomes z,
  // then shift so the top face (with its fillet) lands exactly at y = 0
  geo.rotateX(Math.PI / 2)
  geo.translate(0, -FILLET, 0)
  return geo
}

/** First/last rail-hole x for a hole count (rail holes are grouped in 5s). */
function railSpanX(railHoles: number): { first: number; last: number } {
  const i = railHoles - 1
  return { first: 2.5, last: 2.5 + i + Math.floor(i / 5) }
}

// ---------------------------------------------------------------------------
// Decal painting (color + bump canvases) — one canvas pair PER MODULE, all
// drawing in GLOBAL plan coordinates so graphics continue across modules and
// simply clip at each canvas slice edge.
// ---------------------------------------------------------------------------

interface DecalCtx {
  config: BoardConfig
  /** x-slice this canvas covers (global plan coordinates) */
  minX: number
  width: number
  /** full-board z range (every slice spans the whole depth) */
  minZ: number
  depth: number
  px: number
  /** rig outer extents (brand / size-label anchors) */
  rigMinX: number
  rigMaxX: number
  /** whether this slice is the rig's first / last module */
  first: boolean
  last: boolean
  /** rig has > 1 board-row → print the row-joint seam at the z edges */
  rowSeams: boolean
}

/** printed width of a molded seam-groove line (plan units) */
const SEAM_LINE_W = 0.12

/**
 * Painted seam lines over every molded V-groove joint, so the seams read
 * from directly above too (the groove geometry alone only shadows at grazing
 * angles): module seams at the slice's x edges (each canvas paints its half;
 * coordinates are global so the halves join exactly), the bus/terminal
 * grooves of a multi-board rig, and the board-row joints at the z edges.
 */
function paintSeams(ctx: CanvasRenderingContext2D, d: DecalCtx, px: number, style: string): void {
  const X = (x: number) => (x - d.minX) * px
  const Y = (z: number) => (z - d.minZ) * px
  const w = SEAM_LINE_W * px
  ctx.fillStyle = style
  // module seams (vertical, half-clipped at the canvas edge)
  if (!d.first) ctx.fillRect(X(d.minX) - w / 2, Y(d.minZ), w, d.depth * px)
  if (!d.last) ctx.fillRect(X(d.minX + d.width) - w / 2, Y(d.minZ), w, d.depth * px)
  // bus-strip / terminal-block grooves (multi-board rigs only — the single
  // board is one molded piece there)
  if (d.config.count > 1) {
    for (const z of [BUS_TOP_Z, BUS_BOT_Z]) {
      ctx.fillRect(X(d.minX), Y(z) - w / 2, d.width * px, w)
    }
  }
  // board-row joints (horizontal, half-clipped at the canvas edge)
  if (d.rowSeams) {
    ctx.fillRect(X(d.minX), Y(d.minZ) - w / 2, d.width * px, w)
    ctx.fillRect(X(d.minX), Y(d.minZ + d.depth) - w / 2, d.width * px, w)
  }
}

function paintColor(ctx: CanvasRenderingContext2D, d: DecalCtx): void {
  const { px } = d
  const X = (x: number) => (x - d.minX) * px
  const Y = (z: number) => (z - d.minZ) * px
  const { size, count } = d.config
  const { cols, railHoles, label, points } = BOARD_SIZES[size]
  const totalCols = cols * count
  ctx.clearRect(0, 0, d.width * px, d.depth * px)
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'

  // --- AO veil over the hole field (multiply-style darkening) --------------
  ctx.fillStyle = 'rgba(38,33,26,0.07)'
  for (const band of [
    { z0: 2.45, z1: 7.55 }, // rows a..e
    { z0: 8.45, z1: 13.55 }, // rows f..j
    { z0: -0.55, z1: 1.55 }, // top rails
    { z0: 14.45, z1: 16.55 }, // bottom rails
  ]) {
    ctx.fillRect(X(0.3), Y(band.z0), (totalCols + 0.4) * px, (band.z1 - band.z0) * px)
  }
  // soft per-hole contact shadow (subtle — the real darkness is the hole plug)
  const sliceMax = d.minX + d.width
  for (const h of allHoles(d.config)) {
    const p = holePosition(h)
    if (p.x < d.minX - 1 || p.x > sliceMax + 1) continue
    const g = ctx.createRadialGradient(X(p.x), Y(p.z), 0.18 * px, X(p.x), Y(p.z), 0.46 * px)
    g.addColorStop(0, 'rgba(30,26,20,0.13)')
    g.addColorStop(1, 'rgba(30,26,20,0)')
    ctx.fillStyle = g
    ctx.fillRect(X(p.x - 0.46), Y(p.z - 0.46), 0.92 * px, 0.92 * px)
  }

  // --- painted rail-stripe grooves (recessed: shadowed top lip, lit bottom) -
  // the rails are BUSED along the whole rig → the stripes run continuously
  const span = railSpanX(railHoles * count)
  const sx0 = span.first - 1.2
  const sx1 = span.last + 1.2
  for (const s of STRIPES) {
    ctx.fillStyle = s.red ? RED : BLUE
    ctx.globalAlpha = 0.92
    ctx.fillRect(X(sx0), Y(s.z - 0.09), (sx1 - sx0) * px, 0.18 * px)
    ctx.globalAlpha = 1
    ctx.fillStyle = 'rgba(0,0,0,0.38)' // groove lip shadow
    ctx.fillRect(X(sx0), Y(s.z - 0.09), (sx1 - sx0) * px, 0.045 * px)
    ctx.fillStyle = 'rgba(255,255,255,0.16)' // lit lower edge
    ctx.fillRect(X(sx0), Y(s.z + 0.05), (sx1 - sx0) * px, 0.04 * px)
  }

  // --- printed legend (column numbers continue across module seams) --------
  ctx.fillStyle = INK
  ctx.font = `600 ${Math.round(0.56 * px)}px system-ui, "Segoe UI", sans-serif`
  const colLabels: number[] = [1]
  for (let c = 5; c <= totalCols; c += 5) colLabels.push(c)
  for (const col of colLabels) {
    if (col < d.minX - 1 || col > sliceMax + 1) continue
    ctx.fillText(String(col), X(col), Y(2.1))
    ctx.fillText(String(col), X(col), Y(13.9))
  }
  ctx.font = `600 ${Math.round(0.6 * px)}px system-ui, "Segoe UI", sans-serif`
  for (const row of STRIP_ROWS) {
    ctx.fillText(row, X(0), Y(ROW_Z[row]))
    ctx.fillText(row, X(totalCols + 1), Y(ROW_Z[row]))
  }
  ctx.font = `700 ${Math.round(0.8 * px)}px system-ui, "Segoe UI", sans-serif`
  for (const s of STRIPES) {
    ctx.fillStyle = s.red ? RED : BLUE
    const sign = s.red ? '+' : '−'
    ctx.fillText(sign, X(sx0 - 0.6), Y(s.z))
    ctx.fillText(sign, X(sx1 + 0.6), Y(s.z))
  }

  // --- molded seam joints (modules / bus strips / board-rows) ---------------
  paintSeams(ctx, d, px, 'rgba(24,21,16,0.45)')

  // --- embossed brand (plastic-on-plastic: faint tone shift, bump does the rest)
  ctx.fillStyle = 'rgba(62,58,50,0.34)'
  if (d.first) {
    ctx.font = `700 ${Math.round(0.52 * px)}px system-ui, "Segoe UI", sans-serif`
    ctx.textAlign = 'left'
    ctx.fillText('BREADBOARD STUDIO', X(d.rigMinX + 1.6), Y(-1.02))
  }
  if (d.last) {
    ctx.textAlign = 'right'
    ctx.font = `600 ${Math.round(0.46 * px)}px system-ui, "Segoe UI", sans-serif`
    const brand = count > 1 ? `${label.toUpperCase()} ×${count}` : label.toUpperCase()
    ctx.fillText(`${brand} · ${points * count} TIE POINTS`, X(d.rigMaxX - 1.6), Y(-1.02))
  }
}

function paintBump(ctx: CanvasRenderingContext2D, d: DecalCtx): void {
  const px = d.px / 2 // bump canvas is half resolution
  const X = (x: number) => (x - d.minX) * px
  const Y = (z: number) => (z - d.minZ) * px
  const { size, count } = d.config
  const { railHoles, label, points } = BOARD_SIZES[size]
  ctx.fillStyle = '#808080' // neutral height
  ctx.fillRect(0, 0, d.width * px, d.depth * px)

  // recessed stripe grooves
  const span = railSpanX(railHoles * count)
  const sx0 = span.first - 1.2
  const sx1 = span.last + 1.2
  ctx.fillStyle = '#565656'
  for (const s of STRIPES) {
    ctx.fillRect(X(sx0), Y(s.z - 0.1), (sx1 - sx0) * px, 0.2 * px)
  }

  // recessed molded seam joints (modules / bus strips / board-rows)
  paintSeams(ctx, d, px, '#606060')

  // raised embossed brand
  ctx.fillStyle = '#b9b9b9'
  ctx.textBaseline = 'middle'
  if (d.first) {
    ctx.textAlign = 'left'
    ctx.font = `700 ${Math.round(0.52 * px)}px system-ui, "Segoe UI", sans-serif`
    ctx.fillText('BREADBOARD STUDIO', X(d.rigMinX + 1.6), Y(-1.02))
  }
  if (d.last) {
    ctx.textAlign = 'right'
    ctx.font = `600 ${Math.round(0.46 * px)}px system-ui, "Segoe UI", sans-serif`
    const brand = count > 1 ? `${label.toUpperCase()} ×${count}` : label.toUpperCase()
    ctx.fillText(`${brand} · ${points * count} TIE POINTS`, X(d.rigMaxX - 1.6), Y(-1.02))
  }
}

function makeCanvas(w: number, h: number): HTMLCanvasElement | null {
  if (typeof document === 'undefined') return null
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, Math.ceil(w))
  canvas.height = Math.max(1, Math.ceil(h))
  return canvas
}

// ---------------------------------------------------------------------------
// Build
// ---------------------------------------------------------------------------

export function buildBoard(
  maxAnisotropy: number,
  configIn: BoardConfig | BoardSizeId = 'standard',
): BoardBuild {
  const config = asBoardConfig(configIn)
  const { size, count } = config
  const rows = boardRowsOf(config)
  const group = new THREE.Group()
  group.name = 'breadboard'
  const disposables: { dispose(): void }[] = []
  const track = <T extends { dispose(): void }>(d: T): T => {
    disposables.push(d)
    return d
  }

  // every board-row is an identical copy of the SINGLE-ROW rig, offset in z
  // by boardRowZs — geometries / materials / decal textures are built once
  // (for row 0's local coordinates) and shared by every row's meshes
  const rowConfig: BoardConfig = { size, count }
  const { minX, maxX, minZ, maxZ } = boardExtents(rowConfig)

  // --- injection-molded ABS body materials ----------------------------------
  const bodyMat = track(
    new THREE.MeshPhysicalMaterial({
      color: 0xe9e5d8,
      roughness: 0.58,
      metalness: 0.0,
      clearcoat: 0.2,
      clearcoatRoughness: 0.55,
    }),
  )
  // Studio compat: three-gpu-pathtracer 0.0.23 renders LARGE FLAT clearcoated
  // surfaces black at grazing view angles (curved tubes mask the bug — the
  // board slab, seen mostly at grazing, goes catastrophically dark). The
  // Studio pipeline suppresses clearcoat on flagged materials for the
  // path-traced still and restores it on leaving the mode; every raster
  // pipeline keeps the molded-ABS clearcoat untouched. See RENDER-MODES.md.
  bodyMat.userData.bbStudioNoClearcoat = true
  const noise = noiseNormalTexture() // module-shared — never disposed here
  if (noise) {
    bodyMat.normalMap = noise
    bodyMat.normalScale.set(0.22, 0.22)
  }
  const channelMat = track(
    new THREE.MeshPhysicalMaterial({ color: 0xd0ccbe, roughness: 0.85, metalness: 0.0 }),
  )

  const chanMinZ = 8 - CHANNEL_HALF_WIDTH
  const chanMaxZ = 8 + CHANNEL_HALF_WIDTH
  const inset = FILLET // shape is inset so the beveled hull lands on the extents
  const floorHeight = BODY_THICKNESS - CHANNEL_DEPTH

  // --- row / module scaffolding ----------------------------------------------
  // moduleSeamXs/boardRowZs come from the model layer — never re-derived here
  const seams = moduleSeamXs(rowConfig)
  const slices: { x0: number; x1: number }[] = []
  for (let k = 0; k < count; k++) {
    slices.push({
      x0: k === 0 ? minX : seams[k - 1],
      x1: k === count - 1 ? maxX : seams[k],
    })
  }
  const rowGroups: THREE.Group[] = boardRowZs(config).map((z, r) => {
    const g = new THREE.Group()
    g.name = `board-row-${r}`
    g.position.z = z
    group.add(g)
    return g
  })
  const moduleGroups: THREE.Group[][] = rowGroups.map((rg, r) =>
    slices.map((_, k) => {
      const g = new THREE.Group()
      g.name = `board-module-${r}-${k + 1}`
      rg.add(g)
      return g
    }),
  )

  // helpers instantiate shared geometry into every board-row (meshes are
  // cheap; geometries/materials are the GPU cost and stay row-count-free).
  // Slabs that touch the rig's front ('a') / back ('b') edge get at most TWO
  // variants: the outermost row keeps the rounded outline corners, interior
  // rows use a square-cornered variant so abutting board-rows meet flush in
  // the thin seam groove (no corner notches at interior row joints).
  const addSlab = (
    makeShape: (edge: 'a' | 'b' | 'none') => THREE.Shape,
    outerEdge: 'a' | 'b',
    parentOf: (r: number) => THREE.Object3D,
  ): void => {
    const rounded = track(slabGeometry(makeShape(outerEdge)))
    const square = rows > 1 ? track(slabGeometry(makeShape('none'))) : null
    for (let r = 0; r < rows; r++) {
      const outer = outerEdge === 'a' ? r === 0 : r === rows - 1
      const slab = new THREE.Mesh(outer || !square ? rounded : square, bodyMat)
      slab.castShadow = true
      slab.receiveShadow = true
      parentOf(r).add(slab)
    }
  }
  // interior terminal slabs of a multi-board rig never touch a row edge —
  // one geometry serves every board-row
  const addSlabAllRows = (
    geo: THREE.ExtrudeGeometry,
    parentOf: (r: number) => THREE.Object3D,
  ): void => {
    track(geo)
    for (let r = 0; r < rows; r++) {
      const slab = new THREE.Mesh(geo, bodyMat)
      slab.castShadow = true
      slab.receiveShadow = true
      parentOf(r).add(slab)
    }
  }
  const addChannelFloor = (
    x0: number,
    x1: number,
    parentOf: (r: number) => THREE.Object3D,
  ): void => {
    const geo = track(new THREE.BoxGeometry(x1 - x0, floorHeight, chanMaxZ - chanMinZ))
    for (let r = 0; r < rows; r++) {
      const floor = new THREE.Mesh(geo, channelMat)
      floor.position.set((x0 + x1) / 2, -CHANNEL_DEPTH - floorHeight / 2, 8)
      floor.receiveShadow = true
      parentOf(r).add(floor)
    }
  }

  // --- hole plan positions (row-LOCAL — shared by the slab punching below
  // and the socket instancing further down) -----------------------------------
  const railTop: { x: number; z: number }[] = []
  const railBot: { x: number; z: number }[] = []
  const stripTop: { x: number; z: number }[][] = slices.map(() => [])
  const stripBot: { x: number; z: number }[][] = slices.map(() => [])
  for (const h of allHoles(rowConfig)) {
    const p = holePosition(h)
    if (h.kind === 'rail') (p.z < 8 ? railTop : railBot).push(p)
    else (p.z < 8 ? stripTop : stripBot)[moduleOfCol(h.col, size) - 1].push(p)
  }

  // --- bodies (every slab face gets its socket bores PUNCHED through) --------
  // All hulls land EXACTLY on their shared boundary planes (module seams,
  // bus/terminal grooves, row edges): the shape is inset by FILLET and the
  // extrude bevel grows back to the hull, so abutting slabs meet in a
  // shallow V-groove with NO see-through gap (the coincident interior walls
  // face each other and are never both visible).
  if (count === 1) {
    // single board: the classic two full-depth slabs (rails included)
    addSlab(
      (edge) =>
        punchHoles(
          slabShape(minX + inset, maxX - inset, minZ + inset, chanMinZ - inset, edge),
          railTop.concat(stripTop[0]),
        ),
      'a',
      (r) => moduleGroups[r][0],
    )
    addSlab(
      (edge) =>
        punchHoles(
          slabShape(minX + inset, maxX - inset, chanMaxZ + inset, maxZ - inset, edge),
          railBot.concat(stripBot[0]),
        ),
      'b',
      (r) => moduleGroups[r][0],
    )
    addChannelFloor(minX + inset, maxX - inset, (r) => moduleGroups[r][0])
  } else {
    // lab-station rig: continuous bus strips (the rails are bused into single
    // nets — and rail holes land exactly on column seams, so per-module rail
    // bodies are impossible) + per-module terminal slabs abutting at seams
    addSlab(
      (edge) =>
        punchHoles(
          slabShape(minX + inset, maxX - inset, minZ + inset, BUS_TOP_Z - inset, edge),
          railTop,
        ),
      'a',
      (r) => rowGroups[r],
    )
    addSlab(
      (edge) =>
        punchHoles(
          slabShape(minX + inset, maxX - inset, BUS_BOT_Z + inset, maxZ - inset, edge),
          railBot,
        ),
      'b',
      (r) => rowGroups[r],
    )
    for (let k = 0; k < count; k++) {
      const x0 = slices[k].x0 + inset
      const x1 = slices[k].x1 - inset
      addSlabAllRows(
        slabGeometry(
          punchHoles(rectShape(x0, x1, BUS_TOP_Z + inset, chanMinZ - inset), stripTop[k]),
        ),
        (r) => moduleGroups[r][k],
      )
      addSlabAllRows(
        slabGeometry(
          punchHoles(rectShape(x0, x1, chanMaxZ + inset, BUS_BOT_Z - inset), stripBot[k]),
        ),
        (r) => moduleGroups[r][k],
      )
      addChannelFloor(x0, x1, (r) => moduleGroups[r][k])
    }
  }

  // --- recessed hole sockets: chamfer funnel + dark shaft bore + plug, all
  // descending INSIDE the punched bores (below the flush face) ----------------
  const SQRT2 = Math.SQRT2

  // collar: 4-sided frustum rotated 45° → a square chamfer funnel from
  // RIM_OUTER (under the punched face edge — the overlap hides the seam) down
  // to RIM_INNER at CHAMFER_DEPTH; BackSide = interior walls face the camera
  const rimGeo = track(
    new THREE.CylinderGeometry(RIM_OUTER * SQRT2, RIM_INNER * SQRT2, CHAMFER_DEPTH, 4, 1, true),
  )
  rimGeo.rotateY(Math.PI / 4)
  const rimMat = track(
    new THREE.MeshPhysicalMaterial({
      color: 0xcfc9ba,
      roughness: 0.8,
      metalness: 0.0,
      side: THREE.BackSide,
    }),
  )
  /** funnel top sits a hair below the face (z-fight guard) */
  const rimTopY = -0.005

  // shaft bore: square tube continuing down from the funnel to the plug
  // (tiny overlaps at both joints so no hairline gap can open)
  const shaftTopY = rimTopY - CHAMFER_DEPTH + 0.01
  const shaftHeight = shaftTopY - PLUG_TOP_Y + 0.005
  const shaftGeo = track(
    new THREE.CylinderGeometry(
      RIM_INNER * SQRT2,
      RIM_INNER * SHAFT_TAPER * SQRT2,
      shaftHeight,
      4,
      1,
      true,
    ),
  )
  shaftGeo.rotateY(Math.PI / 4)
  const shaftMat = track(
    new THREE.MeshPhysicalMaterial({
      color: 0x17181c,
      roughness: 0.9,
      metalness: 0.0,
      side: THREE.BackSide,
    }),
  )

  // dark contact plug at the bottom of the bore (reads as the metal clip)
  const plugHalf = RIM_INNER * SHAFT_TAPER
  const holeGeo = track(new THREE.BoxGeometry(plugHalf * 2, PLUG_THICKNESS, plugHalf * 2))
  const holeMat = track(
    new THREE.MeshPhysicalMaterial({ color: 0x121316, roughness: 0.5, metalness: 0.35 }),
  )

  const mtx = new THREE.Matrix4()
  // one InstancedMesh trio per board-row (rows spring in/out independently)
  // over the SAME shared geometries/materials
  const addSockets = (
    positions: { x: number; z: number }[],
    parentOf: (r: number) => THREE.Object3D,
  ): void => {
    if (positions.length === 0) return
    for (let r = 0; r < rows; r++) {
      const rims = new THREE.InstancedMesh(rimGeo, rimMat, positions.length)
      rims.name = 'board-hole-rims'
      rims.receiveShadow = true
      const shafts = new THREE.InstancedMesh(shaftGeo, shaftMat, positions.length)
      shafts.name = 'board-hole-shafts'
      const plugs = new THREE.InstancedMesh(holeGeo, holeMat, positions.length)
      plugs.name = 'board-holes'
      for (let i = 0; i < positions.length; i++) {
        const p = positions[i]
        mtx.setPosition(p.x, rimTopY - CHAMFER_DEPTH / 2, p.z)
        rims.setMatrixAt(i, mtx)
        mtx.setPosition(p.x, shaftTopY - shaftHeight / 2, p.z)
        shafts.setMatrixAt(i, mtx)
        mtx.setPosition(p.x, PLUG_TOP_Y - PLUG_THICKNESS / 2, p.z)
        plugs.setMatrixAt(i, mtx)
      }
      rims.instanceMatrix.needsUpdate = true
      shafts.instanceMatrix.needsUpdate = true
      plugs.instanceMatrix.needsUpdate = true
      parentOf(r).add(rims, shafts, plugs)
    }
  }

  // positions are row-LOCAL (front-row holes); deeper rows reuse them inside
  // their offset rowGroup, exactly matching holePosition's +BOARD_ROW_PITCH·r
  if (count === 1) {
    addSockets(railTop.concat(stripTop[0], railBot, stripBot[0]), (r) => moduleGroups[r][0])
  } else {
    // strip holes belong to their module (they spring in with it); rail holes
    // sit on the continuous bus strips and stay with the row root
    addSockets(railTop.concat(railBot), (r) => rowGroups[r])
    for (let k = 0; k < count; k++) {
      addSockets(stripTop[k].concat(stripBot[k]), (r) => moduleGroups[r][k])
    }
  }

  // --- decals: stripes + AO + legend + brand (color & bump pair per module
  // slice, SHARED by every board-row — rows are identical printed rigs) -------
  const px = size === 'labxl' ? 24 : 40 // canvas pixels per board unit (≤4096 wide)
  const depth = maxZ - minZ
  for (let k = 0; k < count; k++) {
    const sliceW = slices[k].x1 - slices[k].x0
    const colorCanvas = makeCanvas(sliceW * px, depth * px)
    const colorCtx = colorCanvas?.getContext('2d') ?? null
    if (!colorCanvas || !colorCtx) continue
    const d: DecalCtx = {
      config: rowConfig,
      minX: slices[k].x0,
      width: sliceW,
      minZ,
      depth,
      px,
      rigMinX: minX,
      rigMaxX: maxX,
      first: k === 0,
      last: k === count - 1,
      rowSeams: rows > 1,
    }
    paintColor(colorCtx, d)
    const map = track(new THREE.CanvasTexture(colorCanvas))
    map.colorSpace = THREE.SRGBColorSpace
    map.anisotropy = Math.max(1, maxAnisotropy)

    const decalMat = track(
      new THREE.MeshStandardMaterial({
        map,
        transparent: true,
        depthWrite: false,
        roughness: 0.62,
        metalness: 0,
      }),
    )
    const bumpCanvas = makeCanvas((sliceW * px) / 2, (depth * px) / 2)
    const bumpCtx = bumpCanvas?.getContext('2d') ?? null
    if (bumpCanvas && bumpCtx) {
      paintBump(bumpCtx, d)
      const bump = track(new THREE.CanvasTexture(bumpCanvas))
      bump.anisotropy = Math.max(1, maxAnisotropy)
      decalMat.bumpMap = bump
      decalMat.bumpScale = 0.5
    }

    const labelGeo = track(new THREE.PlaneGeometry(sliceW, depth))
    for (let r = 0; r < rows; r++) {
      const labels = new THREE.Mesh(labelGeo, decalMat)
      labels.rotation.x = -Math.PI / 2
      labels.position.set((slices[k].x0 + slices[k].x1) / 2, 0.015, (minZ + maxZ) / 2)
      labels.renderOrder = 2
      moduleGroups[r][k].add(labels)
    }
  }

  return {
    group,
    size,
    config,
    modules: moduleGroups[0],
    rowGroups,
    moduleGroups,
    dispose() {
      for (const d of disposables) d.dispose()
      disposables.length = 0
    },
  }
}
