/**
 * The 3D breadboard scene — implements IBreadboardScene (src/three/scene-api.ts).
 *
 * Owns the renderer / camera / controls / lights / board mesh / wires / ghost
 * / picking. Component visuals are delegated to src/three/component-meshes.ts.
 *
 * Units: 1 unit = one hole pitch; board top surface at y = 0.
 */

import * as THREE from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js'
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js'
import { MAX_BOARD_COUNT, MAX_BOARD_ROWS, STRIP_ROWS, boardConfigOf, isRotation } from '../model/types'
import type {
  BoardConfig,
  CircuitLayout,
  ComponentInstance,
  Hole,
  HoleRef,
  ParamValue,
  Rotation,
  SimTelemetry,
  Wire,
} from '../model/types'
import {
  BOARD_ROW_PITCH,
  ROW_Z,
  boardExtents,
  componentPinHoles,
  dipHoles,
  footprintHoles,
  formatHole,
  holePosition,
  offboardBodyPosition,
  offboardBodyRect,
  offboardTerminalPosition,
  parseHole,
  parseTerminalRef,
} from '../model/breadboard'
import { occludedHoles } from '../model/occlusion'
import { getEntry, type CatalogEntry } from '../model/catalog'
import {
  buildComponentObject,
  disposeComponentObject,
  updateComponentVisual,
  type BuiltComponent,
} from './component-meshes'
import type { RoutedComponent } from './internal/wire-router'
import type {
  GhostSpec,
  GridGrowDirection,
  IBreadboardScene,
  SceneCallbacks,
  SceneInteractionMode,
  SceneMoveTarget,
} from './scene-api'
import { buildBoard, type BoardBuild } from './internal/board'
import { SpawnFX, type PuffRect } from './internal/spawn-fx'
import { HoleIndex } from './internal/hole-index'
import {
  TERMINAL_TOP_Y,
  WIRE_TIP_LEN,
  WIRE_TIP_SINK,
  planRoutes,
  planVersion,
  previewComponentPose,
  previewWireGeometry,
  routedBodyFor,
  routedComponentPose,
  routedComponentSignature,
  routedWireSignature,
  wireColorFor,
  wireGeometry,
} from './internal/wires'
import {
  applyHologram,
  disposeHolograms,
  makeHologramMaterial,
  makePinMarkers,
  setHologramReducedMotion,
  tickHolograms,
  type HologramVariant,
  type PinMarkers,
} from './internal/hologram'
import { makeHoleLabel, makeHoverRing, type HoleLabel, type HoverRing } from './internal/hole-fx'
import { RenderModeManager, type RenderModeId } from './render-modes/manager'

// ---------------------------------------------------------------------------
// Tunables
// ---------------------------------------------------------------------------

/** Off-board terminal posts are DRAWN by the instrument mesh itself (panel-
 *  mounted binding posts, meshes/instruments.ts — one visual source of
 *  truth); the scene keeps one INVISIBLE box per post as the pick/touch
 *  proxy, aligned over the mesh post and sized generously for fingers.
 *  three's Raycaster tests invisible meshes too, so every existing terminal
 *  raycast keeps working while nothing extra renders or casts shadows. */
const POST_PROXY_W = 0.9
const POST_PROXY_H = 0.9
const POST_PROXY_D = 1.1
/** proxy-center offset from the wire attach point (x, TERMINAL_TOP_Y, z):
 *  down to the post's horizontal axis, back over the body toward the panel */
const POST_PROXY_DY = -0.1
const POST_PROXY_DZ = -0.25
const HOLE_SNAP_DIST = 0.55
/** coarse-pointer snap radius (DESIGN.md §4: fingers need bigger targets) */
const HOLE_SNAP_DIST_TOUCH = 0.9
/** mouse click discrimination (unchanged desktop behavior) */
const CLICK_MAX_PX = 6
const CLICK_MAX_MS = 400
/** touch tap discrimination (DESIGN.md §4: moved < 10px && < 350ms) */
const TAP_MAX_PX = 10
const TAP_MAX_MS = 350
/** long-press on a component/wire → onObjectLongPress (10px hold tolerance) */
const LONG_PRESS_MS = 500
const LONG_PRESS_MAX_PX = 10
/** double-tap/double-click empty space → re-frame (gap between the two taps) */
const DOUBLE_TAP_MS = 450
const DOUBLE_TAP_MAX_PX = 40
/** plan-units the fingertip ghost-cursor floats toward the top of the screen */
const FINGERTIP_OFFSET_UNITS = 2.5
/** the cursor's screen offset is clamped to a finger-sized px band so extreme
 *  zoom levels keep the aim ring visible just above the fingertip */
const FINGERTIP_OFFSET_MIN_PX = 44
const FINGERTIP_OFFSET_MAX_PX = 88
/** screen-space probe (px) used to find the screen-up direction on the board */
const FINGERTIP_PROBE_PX = 24
/** terminal-post snap radius for the fingertip cursor (posts are chunky) */
const TERMINAL_SNAP_DIST_TOUCH = 1.25
/** touch slop for body/wire/post picking (px): a wire tube is ~6px on screen,
 *  far under the 44px touch-target rule (DESIGN.md §4) */
const OBJECT_TOUCH_SLOP_PX = 22
/** ring sample pattern [radius px, sample count] for the slop raycast */
const SLOP_RINGS: ReadonlyArray<readonly [number, number]> = [
  [6, 6],
  [12, 10],
  [18, 12],
  [22, 14],
]
/** camera re-frame tween duration */
const REFRAME_MS = 450
/** home view direction (unit vector, target → camera): the elevated 3/4 view */
const HOME_DIR = new THREE.Vector3(-6, 36, 40).normalize()
/** camera basis for the home direction (used by the fit-to-content math) */
const HOME_FWD = HOME_DIR.clone().negate()
const HOME_RIGHT = new THREE.Vector3().crossVectors(HOME_FWD, new THREE.Vector3(0, 1, 0)).normalize()
const HOME_UP = new THREE.Vector3().crossVectors(HOME_RIGHT, HOME_FWD).normalize()
/** y-range of framable content (board slab bottom … tallest part) */
const HOME_MIN_Y = -1.2
const HOME_MAX_Y = 3.2
const HOME_FIT_MARGIN = 1.05
const MIN_HOME_DISTANCE = 20
const WIRE_RADIUS = 0.16
const PREVIEW_RADIUS = 0.07
const SELECT_EMISSIVE = 0x2f6bff
const SELECT_INTENSITY = 0.55
const SELECT_BOX_PAD = 0.35
/** hover ring lift: floats just above the flush board face (sockets recess) */
const HOVER_RING_LIFT = 0.05
/** hole-coordinate chip anchor height above the board (bottom-center) */
const HOLE_LABEL_Y = 1.5
/** ...and above the fingertip aim ring while touch-aiming */
const FINGERTIP_LABEL_Y = 2.3
/** clicked-hole chip stays pinned this long (desktop QOL) */
const LABEL_PIN_MS = 1200
/** default plan span of the routed ghost before the first hole is picked */
const GHOST_DEFAULT_SPAN = 3
/** "+" grow paddles (one per grid edge): plate size / float pose / spring-in */
const PADDLE_SIZE = 2.8
const PADDLE_GAP = 1.6 // plan gap between board edge and plate
const PADDLE_Y = 1.9 // plate center height
const PADDLE_TILT = -0.42 // lean back toward the camera (radians)
/** "−" removal chip: a quiet companion revealed beneath a hovered "+" paddle */
const PADDLE_MINUS_SCALE = 0.52 // chip size relative to the + plate
const PADDLE_MINUS_DROP = 2.35 // local-y offset beneath the + plate
/**
 * Board SPAWN animation (grow paddles): the freshly built module column /
 * board-row DROPS in from above — a gravity-feel ease-in fall with a slight
 * tilt that levels out, then a one-beat squash-and-relax settle on the house
 * spring, plus a tiny pooled dust puff at touchdown (~650ms total). The new
 * meshes are FULLY BUILT before the first animated frame (transform-only
 * tween of prebuilt groups) and the tween clock starts on the first rAF tick
 * AFTER the synchronous rebuild, so the fall never starts mid-air; the
 * camera glide home waits for the settle (drop → settle → dust → glide).
 */
const SPAWN_DROP_MS = 290
const SPAWN_SETTLE_MS = 360
const SPAWN_DROP_HEIGHT = 9
const SPAWN_TILT_RAD = (2.5 * Math.PI) / 180
const SPAWN_SQUASH = 0.035 // scaleY dips to ~0.965 at touchdown, then relaxes
/** reduced-motion spawn: simple material fade-in (no fall, no dust) */
const SPAWN_FADE_MS = 240
/** scene-initiated module/row removal: quick lift + fade + a smaller puff */
const REMOVE_MS = 300
const REMOVE_LIFT = 2.6
/** ghost-rotation spin spring (R key / rotate button cycles the hologram) */
const GHOST_SPIN_MS = 220
/** drag must travel this many px before a move-drag/marquee starts (a tap stays a tap) */
const DRAG_START_PX = 5
const DRAG_START_PX_TOUCH = 8
/** snap radius (plan units) for re-anchoring a dragged package */
const MOVE_ANCHOR_SNAP = 0.9
/** instrument drags snap their bench anchor to the model's 0.5 grid */
const INSTRUMENT_GRID = 0.5
/** validity tint of the instrument-drag overlay box (hologram palette) */
const DRAG_TINT_VALID = 0x66ccff
const DRAG_TINT_INVALID = 0xff453a

// --- rendering pipeline (see DESIGN.md 'Rendering') -------------------------
/** ACES filmic exposure (tuned by eye against the glass UI via screenshots) */
const EXPOSURE = 1.05
/** RoomEnvironment IBL strength — what makes the PBR metals/glass read */
const ENV_INTENSITY = 0.85
/** warm key light: direction (target → light, normalized) + intensity */
const KEY_DIR = new THREE.Vector3(0.5, 1.05, 0.55).normalize()
const KEY_COLOR = 0xfff0dd
const KEY_INTENSITY = 1.2
const FILL_COLOR = 0xbcd0ff
const FILL_INTENSITY = 0.22
/** ONE shadow map for the whole scene (phone perf budget) */
const SHADOW_MAP_SIZE = 2048
/** lit laminate desk plane (receives the key-light shadow physically) */
const GROUND_BACKDROP_Y = -1.3
const GROUND_SIZE = 640
/**
 * Camera layer for the Studio raster-overlay compositing pass: everything
 * excluded from the path-traced still (overlay subtree + grow paddles) is
 * re-rendered on top of the presented path-traced frame through this layer,
 * so holograms / hover FX / selection stay live while a still converges or
 * holds. Layer 0 membership is never removed — the normal raster pipelines
 * keep drawing the same objects untouched.
 */
const OVERLAY_LAYER = 1
const enableOverlayLayer = (o: THREE.Object3D): void => {
  o.layers.enable(OVERLAY_LAYER)
}
/**
 * Telemetry-driven material refreshes (LED emissive, display segments) reach
 * Studio at most this often: each refresh restarts path-traced accumulation
 * by design (the still must show live LED state), but the running sim pushes
 * telemetry every frame and re-packing the path tracer's material texture at
 * 60Hz would be pure waste while accumulation can never get past a frame.
 */
const MATERIALS_REFRESH_MS = 250

const EMPTY_LAYOUT: CircuitLayout = { version: 1, components: [], wires: [] }

// ---------------------------------------------------------------------------
// Internal record types
// ---------------------------------------------------------------------------

interface ComponentRecord {
  comp: ComponentInstance
  entry: CatalogEntry
  built: BuiltComponent
  signature: string
  /** wire attachment point per pin (hole tops at y=0; terminal post tops) */
  attach: THREE.Vector3[]
  /** invisible terminal-post hit proxies (empty for on-board parts) — the
   *  visible posts are part of the instrument mesh */
  posts: THREE.Mesh[]
  /** slot among the layout's off-board components (-1 for on-board parts) */
  slot: number
}

interface WireRecord {
  wire: Wire
  group: THREE.Group
  signature: string
  /** merged insulation geometry (tube + baked end caps) — per-wire, disposed */
  geo: THREE.BufferGeometry
  /** merged bare-tip pin geometry (board-hole ends), when any — disposed */
  tipsGeo: THREE.BufferGeometry | null
  material: THREE.MeshStandardMaterial
}

/** What the fingertip ghost-cursor is snapped to: a board hole or a terminal post. */
type FingertipTarget =
  | { kind: 'hole'; hole: HoleRef }
  | { kind: 'terminal'; ref: string; x: number; z: number }

/** One of the four "+" grow paddles (per 2-D grid edge). */
interface PaddleRecord {
  dir: GridGrowDirection
  group: THREE.Group
  plate: THREE.Mesh
  mat: THREE.MeshPhysicalMaterial
  glyphMat: THREE.MeshBasicMaterial
  /**
   * The quiet "−" removal chip (right/down paddles only — the store can only
   * shrink those edges): revealed beneath the + plate while the paddle is
   * hovered on desktop AND the axis has more than one module/row; touch uses
   * a long-press on the + paddle instead. `minusReveal` is the eased 0..1
   * reveal driven per frame in updatePaddles (number writes only).
   */
  minus: THREE.Group | null
  minusPlate: THREE.Mesh | null
  minusMat: THREE.MeshPhysicalMaterial | null
  minusGlyphMat: THREE.MeshBasicMaterial | null
  minusReveal: number
}

/**
 * A temporary material-fade over a board subtree (reduced-motion spawn
 * fade-in; removal fade-out). Materials are CLONED per unique source and
 * swapped in — the build's shared materials are never mutated — then either
 * restored (fade-in) or dropped with the disposed old build (removal).
 * Bounded one-time cost at the user's tap, never per frame.
 */
interface FadeSet {
  swaps: {
    mesh: THREE.Mesh
    original: THREE.Material | THREE.Material[]
    renderOrder: number
  }[]
  clones: { mat: THREE.Material; base: number }[]
}

/**
 * Clone + swap transparent materials under `roots` for an opacity fade.
 * Render order is forced to mirror the boards' opaque layering (slabs first,
 * then the interior socket bores, printed decals last): renderOrder beats
 * three's transparent depth sort, so depth-tested writes keep the dark bore
 * interiors INSIDE the fading body instead of compositing over it.
 */
function buildFadeSet(roots: THREE.Object3D[]): FadeSet {
  const cloneOf = new Map<THREE.Material, THREE.Material>()
  const set: FadeSet = { swaps: [], clones: [] }
  const cloned = (src: THREE.Material): THREE.Material => {
    let c = cloneOf.get(src)
    if (!c) {
      c = src.clone()
      c.transparent = true
      cloneOf.set(src, c)
      set.clones.push({ mat: c, base: src.transparent ? src.opacity : 1 })
    }
    return c
  }
  for (const root of roots) {
    root.traverse((o) => {
      const mesh = o as THREE.Mesh
      if (!mesh.isMesh) return
      const wasTransparent = Array.isArray(mesh.material)
        ? mesh.material.some((mm) => mm.transparent)
        : mesh.material.transparent
      set.swaps.push({ mesh, original: mesh.material, renderOrder: mesh.renderOrder })
      mesh.material = Array.isArray(mesh.material)
        ? mesh.material.map(cloned)
        : cloned(mesh.material)
      mesh.renderOrder = wasTransparent
        ? 6 // decals stay on top of the body they label
        : (mesh as THREE.InstancedMesh).isInstancedMesh
          ? 5 // socket bores draw after the slabs → depth-tested inside them
          : 4 // body slabs / channel floors first (cloned depthWrite kept)
    })
  }
  return set
}

/** Drive every cloned material to `k` × its base opacity (number writes). */
function setFadeOpacity(set: FadeSet, k: number): void {
  for (const c of set.clones) (c.mat as THREE.Material & { opacity: number }).opacity = c.base * k
}

/** Restore the original materials (fade-in end) and free the clones. */
function disposeFadeSet(set: FadeSet, restore: boolean): void {
  if (restore) {
    for (const s of set.swaps) {
      s.mesh.material = s.original
      s.mesh.renderOrder = s.renderOrder
    }
  }
  for (const c of set.clones) c.mat.dispose()
  set.swaps.length = 0
  set.clones.length = 0
}

/** An in-flight move-drag of the selected on-board part(s). */
interface MoveDrag {
  /** selected on-board component ids the drag translates (wires stay put) */
  ids: string[]
  /** board-plane grab point at pointerdown */
  grab: THREE.Vector3
  /** single dip/footprint package → anchor-form re-anchor; else delta form */
  anchor: { pos: { x: number; z: number } } | null
  /** delta-form reference strip hole (first strip pin of the moved set) */
  ref: { col: number; rowIdx: number; boardRow: number; x: number; z: number } | null
  /** passed the start threshold (hologram visible, taps suppressed) */
  started: boolean
  target: SceneMoveTarget | null
  valid: boolean
  /** group hologram of the moved part(s), translated to the candidate spot */
  holo: THREE.Group | null
  holoVariant: HologramVariant
}

/** An in-flight bench drag of a selected off-board instrument. */
interface InstrumentDrag {
  id: string
  /** current body anchor (explicit pos or the legacy slot shelf) */
  origin: { x: number; z: number }
  grab: THREE.Vector3
  started: boolean
  /** snapped candidate anchor (0.5 grid) */
  pos: { x: number; z: number }
  valid: boolean
  /** original world positions of the unit's terminal posts */
  postBase: THREE.Vector3[]
  /** validity tint box over the dragged enclosure */
  tint: THREE.Mesh | null
  tintMat: THREE.MeshBasicMaterial | null
  /** world center the tint box returns to at zero offset */
  tintBase: THREE.Vector3
}

/** A desktop shift+drag marquee (screen-space overlay rectangle). */
interface MarqueeDrag {
  startX: number
  startY: number
  curX: number
  curY: number
  el: HTMLDivElement | null
  started: boolean
}

/** Everything created at mount() and torn down at dispose(). */
interface Mounted {
  container: HTMLElement
  renderer: THREE.WebGLRenderer
  scene: THREE.Scene
  camera: THREE.PerspectiveCamera
  controls: OrbitControls
  board: BoardBuild
  componentsGroup: THREE.Group
  wiresGroup: THREE.Group
  terminalsGroup: THREE.Group
  overlayGroup: THREE.Group
  /** image-based lighting (PMREM'd RoomEnvironment) */
  pmrem: THREE.PMREMGenerator
  envTex: THREE.Texture
  /** warm key (the one shadow caster) + dim cool fill */
  keyLight: THREE.DirectionalLight
  fillLight: THREE.DirectionalLight
  /** desk: lit laminate plane, receives the key shadow (recentered on board rebuild) */
  groundGroup: THREE.Group
  groundGeo: THREE.PlaneGeometry
  backdropMat: THREE.MeshStandardMaterial
  backdropTexs: THREE.Texture[]
  /** shared FX clock (holograms, hover ring, paddle pulse) */
  clock: THREE.Clock
  /** prefers-reduced-motion, sampled at mount */
  reduced: boolean
  /** hovered-hole FX: phosphor glow ring + pooled coordinate chip */
  hoverRing: HoverRing
  holeLabel: HoleLabel
  /** four "+" grow paddles (select mode, sim stopped, axis below its cap) */
  paddles: PaddleRecord[]
  paddleGeos: THREE.BufferGeometry[]
  /** pooled touchdown dust (board spawn/removal FX — internal/spawn-fx.ts) */
  spawnFx: SpawnFX
  /** fingertip ghost-cursor (touch aiming in place/wire modes) */
  fingertipGroup: THREE.Group
  fingertipGeos: THREE.BufferGeometry[]
  fingertipRingMat: THREE.MeshBasicMaterial
  fingertipGlowMat: THREE.MeshBasicMaterial
  fingertipCrossMat: THREE.MeshBasicMaterial
  /** default camera framing — the re-frame destination for an empty board */
  homePos: THREE.Vector3
  homeTarget: THREE.Vector3
  /** shared unit-box geometry + material for selection highlight overlays */
  selBoxGeo: THREE.BoxGeometry
  selBoxMat: THREE.MeshBasicMaterial
  /** clone source for wire end caps (baked into each wire's merged tube) */
  capGeo: THREE.SphereGeometry
  /** clone source + shared material for the exposed tinned wire tips */
  tipGeo: THREE.CylinderGeometry
  tipMat: THREE.MeshStandardMaterial
  /** shared geometry + material for the invisible terminal-post hit proxies */
  postGeo: THREE.BoxGeometry
  postMat: THREE.MeshBasicMaterial
  previewMesh: THREE.Mesh | null
  previewMat: THREE.MeshBasicMaterial
  resizeObserver: ResizeObserver
  raf: number
  /** false while the tab is hidden — the render loop is fully paused */
  rafActive: boolean
  /** preallocated raycast root lists (no per-frame array churn) */
  objectPickRoots: THREE.Object3D[]
  hoverPickRoots: THREE.Object3D[]
  removeListeners(): void
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/**
 * Mesh-rebuild signature. Runtime params (pot position, switch state, pressed,
 * PSU voltage...) are excluded: they change on every slider drag while the sim
 * runs and their visuals are applied via updateComponentVisual — only
 * structural changes (type, placement, build-time params) force a rebuild.
 */
function componentSignature(
  comp: ComponentInstance,
  entry: CatalogEntry,
  slot: number,
  config: BoardConfig,
): string {
  let params: Record<string, ParamValue> | null = null
  if (comp.params) {
    const runtimeKeys = new Set<string>()
    for (const def of entry.params ?? []) if (def.runtime) runtimeKeys.add(def.key)
    for (const key of Object.keys(comp.params).sort()) {
      if (runtimeKeys.has(key)) continue
      ;(params ??= {})[key] = comp.params[key]
    }
  }
  return JSON.stringify({
    t: comp.type,
    at: comp.at ?? null,
    h: comp.holes ?? null,
    rot: comp.rotation ?? 0,
    // explicit instrument bench position (movable instruments)
    pos: comp.pos ? `${comp.pos.x},${comp.pos.z}` : null,
    p: params,
    s: slot,
    // a rig change (size × modules × board-rows) re-validates every placement
    b: `${config.size}x${config.count}x${config.rows ?? 1}`,
    // a routed part rebuilds when re-planning moved its body pose
    r: routedComponentSignature(comp.id),
  })
}

function wireSignature(w: Wire, a: THREE.Vector3, b: THREE.Vector3): string {
  // the routed-path signature folds in collision-avoidance shape changes:
  // a wire reroutes (and must rebuild) when OTHER wires/obstacles move
  return (
    `${w.from}|${w.to}|${w.color ?? ''}|` +
    `${a.x.toFixed(3)},${a.y.toFixed(3)},${a.z.toFixed(3)}|` +
    `${b.x.toFixed(3)},${b.y.toFixed(3)},${b.z.toFixed(3)}|` +
    routedWireSignature(w.id, a, b)
  )
}

/**
 * cubic-bezier(p1x, p1y, p2x, p2y) easing evaluator with CSS timing-function
 * semantics (hand-rolled — no runtime deps). Newton iteration with a
 * bisection fallback to invert x(t), then evaluates y(t).
 */
function cubicBezier(p1x: number, p1y: number, p2x: number, p2y: number): (x: number) => number {
  const cx = 3 * p1x
  const bx = 3 * (p2x - p1x) - cx
  const ax = 1 - cx - bx
  const cy = 3 * p1y
  const by = 3 * (p2y - p1y) - cy
  const ay = 1 - cy - by
  const xAt = (t: number) => ((ax * t + bx) * t + cx) * t
  const yAt = (t: number) => ((ay * t + by) * t + cy) * t
  const dxAt = (t: number) => (3 * ax * t + 2 * bx) * t + cx
  return (x: number) => {
    if (x <= 0) return 0
    if (x >= 1) return 1
    let t = x
    for (let i = 0; i < 5; i++) {
      const d = dxAt(t)
      if (Math.abs(d) < 1e-6) break
      t -= (xAt(t) - x) / d
      if (t < 0) t = 0
      else if (t > 1) t = 1
    }
    if (Math.abs(xAt(t) - x) > 1e-4) {
      let lo = 0
      let hi = 1
      while (hi - lo > 1e-5) {
        t = (lo + hi) / 2
        if (xAt(t) < x) lo = t
        else hi = t
      }
    }
    return yAt(t)
  }
}

/** The one app spring (DESIGN.md §1 Motion): cubic-bezier(0.32, 0.72, 0, 1). */
const SPRING_EASE = cubicBezier(0.32, 0.72, 0, 1)

function prefersReducedMotion(): boolean {
  return (
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  )
}

/**
 * Procedural laminate-desk textures (color + roughness pair). DESIGN §9 asks
 * for "a product photo of a real breadboard on a DESK" — the old unlit
 * radial-gradient MeshBasicMaterial plane read as a turntable-render void.
 * This is a LIT walnut-laminate surface: warm base tone, low-frequency tonal
 * blotches, long wavy grain strokes, and a matching roughness map so the IBL
 * sheen breaks up along the grain. Deterministic LCG noise (no reload
 * shimmer, headless-safe null).
 *
 * The rim still fades to FULLY TRANSPARENT — an opaque rim color can never
 * exactly match the scene background (the plane is ACES-tone-mapped, the
 * clear color is not), so without the alpha fade the plane's straight edges
 * read as a hard seam whenever the camera orbits low.
 */
/** Desk texture tiling: the grain/roughness pair repeats this many times
 *  across the GROUND_SIZE plane (640/4 = 160 world units ≈ 40cm per tile —
 *  texel density high enough that grazing views keep crisp grain instead of
 *  smearing into motion-blur streaks). The alpha fade does NOT repeat. */
const DESK_REPEAT = 4

function makeDeskTextures(maxAnisotropy: number): {
  map: THREE.CanvasTexture
  rough: THREE.CanvasTexture | null
  alpha: THREE.CanvasTexture | null
} | null {
  if (typeof document === 'undefined') return null
  const S = 1024
  const canvas = document.createElement('canvas')
  canvas.width = S
  canvas.height = S
  const ctx = canvas.getContext('2d')
  if (!ctx) return null

  let seed = 0x5eed1234
  const rnd = (): number => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff
    return seed / 0x7fffffff
  }
  /** draw cb at the 9 wrap offsets so the tile repeats seamlessly */
  const wrapped = (c: CanvasRenderingContext2D, cb: () => void): void => {
    for (const ox of [-S, 0, S]) {
      for (const oy of [-S, 0, S]) {
        c.save()
        c.translate(ox, oy)
        cb()
        c.restore()
      }
    }
  }

  // warm walnut base — saturated enough to still read WARM after ACES tone
  // mapping and the cool fill light desaturate it
  ctx.fillStyle = '#52402c'
  ctx.fillRect(0, 0, S, S)
  // broad tonal blotches (plank-to-plank variation), wrap-drawn to tile —
  // low-frequency detail survives grazing-angle minification best
  for (let i = 0; i < 90; i++) {
    const x = rnd() * S
    const y = rnd() * S
    const r = (0.08 + rnd() * 0.22) * S
    const light = rnd() > 0.5
    wrapped(ctx, () => {
      const g = ctx.createRadialGradient(x, y, 0, x, y, r)
      g.addColorStop(0, light ? 'rgba(168,128,82,0.14)' : 'rgba(30,20,12,0.16)')
      g.addColorStop(1, 'rgba(0,0,0,0)')
      ctx.fillStyle = g
      ctx.fillRect(x - r, y - r, 2 * r, 2 * r)
    })
  }
  // wood grain: wavy horizontal strokes (≈ 4–40cm at the tile scale)
  for (let i = 0; i < 1500; i++) {
    const y = rnd() * S
    const x0 = rnd() * S
    const len = (0.04 + rnd() * 0.2) * S
    const amp = 1 + rnd() * 3
    const stroke =
      rnd() > 0.42
        ? `rgba(26,17,9,${(0.04 + rnd() * 0.08).toFixed(3)})`
        : `rgba(178,138,92,${(0.04 + rnd() * 0.07).toFixed(3)})`
    const width = 0.6 + rnd() * 1.8
    const c1 = (rnd() - 0.5) * 2 * amp
    const c2 = (rnd() - 0.5) * amp
    wrapped(ctx, () => {
      ctx.strokeStyle = stroke
      ctx.lineWidth = width
      ctx.beginPath()
      ctx.moveTo(x0, y)
      ctx.quadraticCurveTo(x0 + len / 2, y + c1, x0 + len, y + c2)
      ctx.stroke()
    })
  }

  const map = new THREE.CanvasTexture(canvas)
  map.colorSpace = THREE.SRGBColorSpace
  map.anisotropy = Math.max(1, maxAnisotropy)
  map.wrapS = THREE.RepeatWrapping
  map.wrapT = THREE.RepeatWrapping
  map.repeat.set(DESK_REPEAT, DESK_REPEAT)

  // roughness map: satin variation breaking the sheen up along the grain
  const RS = 512
  const rc = document.createElement('canvas')
  rc.width = RS
  rc.height = RS
  const rctx = rc.getContext('2d')
  let rough: THREE.CanvasTexture | null = null
  if (rctx) {
    rctx.fillStyle = '#d2d2d2' // base roughness ≈ 0.82
    rctx.fillRect(0, 0, RS, RS)
    for (let i = 0; i < 420; i++) {
      const y = rnd() * RS
      const x0 = rnd() * RS
      const len = (0.04 + rnd() * 0.16) * RS
      rctx.strokeStyle =
        rnd() > 0.5
          ? `rgba(176,176,176,${(0.2 + rnd() * 0.3).toFixed(3)})` // glossier grain line
          : `rgba(232,232,232,${(0.2 + rnd() * 0.3).toFixed(3)})` // rougher one
      rctx.lineWidth = 0.8 + rnd() * 2
      rctx.beginPath()
      rctx.moveTo(x0, y)
      rctx.lineTo(x0 + len, y + (rnd() - 0.5) * 5)
      rctx.stroke()
    }
    rough = new THREE.CanvasTexture(rc)
    rough.anisotropy = Math.max(1, maxAnisotropy)
    rough.wrapS = THREE.RepeatWrapping
    rough.wrapT = THREE.RepeatWrapping
    rough.repeat.set(DESK_REPEAT, DESK_REPEAT)
  }

  // rim fade (NON-repeating): dissolves the plane into the background before
  // its straight edges — an opaque rim can never match the un-tone-mapped
  // clear color, so without this the edges read as a hard seam at low orbits
  const AS = 256
  const ac = document.createElement('canvas')
  ac.width = AS
  ac.height = AS
  const actx = ac.getContext('2d')
  let alpha: THREE.CanvasTexture | null = null
  if (actx) {
    const fade = actx.createRadialGradient(AS / 2, AS / 2, 0, AS / 2, AS / 2, AS / 2)
    fade.addColorStop(0, '#ffffff')
    fade.addColorStop(0.55, '#ffffff')
    fade.addColorStop(0.8, '#737373')
    fade.addColorStop(1, '#000000')
    actx.fillStyle = '#000000'
    actx.fillRect(0, 0, AS, AS)
    actx.fillStyle = fade
    actx.fillRect(0, 0, AS, AS)
    alpha = new THREE.CanvasTexture(ac)
  }
  return { map, rough, alpha }
}

/**
 * Cheap shadow casting for dynamic objects: opaque meshes cast into the ONE
 * shadow map (cast only — they never receive). Transparent parts (LED glass,
 * glows, labels) are skipped so the map stays clean and alpha stays cheap.
 */
function enableShadowCasting(root: THREE.Object3D): void {
  root.traverse((o) => {
    const mesh = o as THREE.Mesh
    if (!mesh.isMesh) return
    const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material]
    if (mats.some((m) => m.transparent)) return
    mesh.castShadow = true
  })
}

/**
 * PERF (perf/hotspots.md B2): the scene graph is static between edits, but
 * three.js recomposes every object's local matrix on each render while
 * matrixAutoUpdate is true — O(scene) wasted math during orbits, where only
 * the camera moves. Static subtrees (board, desk, placed parts, wires, posts,
 * selection boxes) are frozen once their transforms are committed; every
 * scene-side mutation of a frozen transform calls updateMatrix() explicitly
 * (module spring-in, instrument drags, telemetry-posed children). Tweened /
 * per-frame-animated objects (paddles, overlay FX, holograms) stay auto.
 */
function freezeTransforms(root: THREE.Object3D): void {
  root.traverse((o) => {
    o.updateMatrix()
    o.matrixAutoUpdate = false
  })
}

/** Recompose one frozen subtree (after visual updaters posed its children). */
const refreshMatrixOf = (o: THREE.Object3D): void => {
  o.updateMatrix()
}

/** The four grid-growth directions, paddle build/iteration order. */
const GROW_DIRECTIONS: readonly GridGrowDirection[] = ['right', 'left', 'up', 'down']

/**
 * The "+" grow paddles: rounded glass-look plates with a plus glyph,
 * kit-blue tinted, leaning back toward the elevated home camera — one per
 * edge of the 2-D grid (right/left grow modules, up/down grow board-rows).
 * Transmission stays reserved for LEDs (perf budget) — the glass read comes
 * from transparency + clearcoat + a soft emissive tint, pulsed per frame in
 * updatePaddles (number writes only). Geometry is shared by all four plates;
 * materials are per paddle (independent hover highlights). Never cast
 * shadows.
 */
function buildPaddles(): { paddles: PaddleRecord[]; geos: THREE.BufferGeometry[] } {
  const geos: THREE.BufferGeometry[] = []

  const half = PADDLE_SIZE / 2
  const r = 0.62
  const shape = new THREE.Shape()
  shape.moveTo(-half + r, -half)
  shape.lineTo(half - r, -half)
  shape.quadraticCurveTo(half, -half, half, -half + r)
  shape.lineTo(half, half - r)
  shape.quadraticCurveTo(half, half, half - r, half)
  shape.lineTo(-half + r, half)
  shape.quadraticCurveTo(-half, half, -half, half - r)
  shape.lineTo(-half, -half + r)
  shape.quadraticCurveTo(-half, -half, -half + r, -half)
  const plateGeo = new THREE.ExtrudeGeometry(shape, {
    depth: 0.18,
    bevelEnabled: true,
    bevelThickness: 0.05,
    bevelSize: 0.05,
    bevelSegments: 2,
    curveSegments: 8,
  })
  plateGeo.translate(0, 0, -0.09)
  geos.push(plateGeo)
  const barGeo = new THREE.BoxGeometry(PADDLE_SIZE * 0.52, 0.32, 0.1)
  geos.push(barGeo)

  const paddles: PaddleRecord[] = GROW_DIRECTIONS.map((dir) => {
    const group = new THREE.Group()
    group.name = `plus-paddle-${dir}`
    // UI chrome, not circuit: kept out of the Studio path-traced still and
    // composited raster-side on top of it (see renderStudioOverlays)
    group.userData.bbNoStudio = true
    const mat = new THREE.MeshPhysicalMaterial({
      color: 0x66a8ff,
      transparent: true,
      opacity: 0.32,
      roughness: 0.22,
      metalness: 0,
      clearcoat: 0.8,
      clearcoatRoughness: 0.25,
      emissive: 0x0a84ff,
      emissiveIntensity: 0.35,
      depthWrite: false,
      side: THREE.DoubleSide,
    })
    const plate = new THREE.Mesh(plateGeo, mat)
    plate.renderOrder = 1
    group.add(plate)

    const glyphMat = new THREE.MeshBasicMaterial({
      color: 0xeaf6ff,
      transparent: true,
      opacity: 0.92,
      depthWrite: false,
    })
    const barH = new THREE.Mesh(barGeo, glyphMat)
    barH.position.z = 0.18
    barH.renderOrder = 2
    const barV = new THREE.Mesh(barGeo, glyphMat)
    barV.rotation.z = Math.PI / 2
    barV.position.z = 0.18
    barV.renderOrder = 2
    group.add(barH, barV)
    group.rotation.x = PADDLE_TILT // lean the face up toward the 3/4 home view
    group.visible = false

    // the quiet "−" removal chip: same glass language, smaller, hidden until
    // the + paddle is hovered (desktop) on a shrinkable axis. Right/down
    // only — the store's shrink (setBoardCount/setBoardRows) drops the
    // rightmost module column / deepest board-row, so those are the honest
    // edges to offer. Shares the plate/bar geometry (scaled by the chip
    // group); independent materials for the reveal/hover fades.
    let minus: THREE.Group | null = null
    let minusPlate: THREE.Mesh | null = null
    let minusMat: THREE.MeshPhysicalMaterial | null = null
    let minusGlyphMat: THREE.MeshBasicMaterial | null = null
    if (dir === 'right' || dir === 'down') {
      minus = new THREE.Group()
      minus.name = `minus-chip-${dir}`
      minusMat = new THREE.MeshPhysicalMaterial({
        color: 0x9caabd,
        transparent: true,
        opacity: 0,
        roughness: 0.25,
        metalness: 0,
        clearcoat: 0.8,
        clearcoatRoughness: 0.25,
        emissive: 0x8a93a3,
        emissiveIntensity: 0.2,
        depthWrite: false,
        side: THREE.DoubleSide,
      })
      minusPlate = new THREE.Mesh(plateGeo, minusMat)
      minusPlate.renderOrder = 1
      minus.add(minusPlate)
      minusGlyphMat = new THREE.MeshBasicMaterial({
        color: 0xf2f5fa,
        transparent: true,
        opacity: 0,
        depthWrite: false,
      })
      const minusBar = new THREE.Mesh(barGeo, minusGlyphMat)
      minusBar.position.z = 0.18
      minusBar.renderOrder = 2
      minus.add(minusBar)
      minus.position.y = -PADDLE_MINUS_DROP // beneath the + plate (local space)
      minus.scale.setScalar(PADDLE_MINUS_SCALE)
      minus.visible = false
      group.add(minus) // inherits the paddle's lean + float position
    }
    return { dir, group, plate, mat, glyphMat, minus, minusPlate, minusMat, minusGlyphMat, minusReveal: 0 }
  })
  return { paddles, geos }
}

// ---------------------------------------------------------------------------
// Scene
// ---------------------------------------------------------------------------

export class BreadboardScene implements IBreadboardScene {
  private m: Mounted | null = null

  // desired state — survives unmount/remount and may be set before mount()
  private callbacks: Partial<SceneCallbacks> = {}
  private layout: CircuitLayout = EMPTY_LAYOUT
  private telemetry: SimTelemetry | null = null
  private ghost: GhostSpec | null = null
  private selectedIds: string[] = []
  private preview: { from: HoleRef | string | null; to: HoleRef | null } = { from: null, to: null }
  /** render-mode preference set before mount (host picker); null = unset */
  private renderModePref: RenderModeId | null = null

  // render-mode engine (Performance / Enhanced / Studio — render-modes/)
  private readonly modes = new RenderModeManager()
  /** an OrbitControls gesture is in flight (boolean-guarded: depth-safe) */
  private controlsInteracting = false
  /** a primary canvas pointer is down (aiming / edit drags) */
  private pointerInteracting = false
  /** a telemetry/selection material refresh awaits the next throttle slot */
  private materialsRefreshPending = false
  /** timestamp (ms) of the last Studio material refresh actually sent */
  private lastMaterialsRefresh = 0

  // scene-graph records
  private components = new Map<string, ComponentRecord>()
  private wires = new Map<string, WireRecord>()
  /** saved emissive of highlighted per-instance wire materials (scene-owned) */
  private savedEmissive = new Map<THREE.MeshStandardMaterial, { color: number; intensity: number }>()
  /** translucent overlay boxes around selected components */
  private selectionBoxes: THREE.Mesh[] = []
  /** holographic placement ghost (actual part mesh + pin markers) */
  private ghostFx: {
    holo: THREE.Object3D | null
    built: BuiltComponent | null
    markers: PinMarkers
    sig: string
  } | null = null
  /** clicked-hole coordinate chip stays pinned until this timestamp (ms) */
  private labelPinnedUntil = 0
  /** which grow paddle the pointer hovers (hover highlight + cursor) */
  private paddleHover: GridGrowDirection | null = null
  /** ...and whether the hover sits on the paddle's "−" removal chip */
  private paddleMinusHover: GridGrowDirection | null = null
  /**
   * Spawn tween for freshly added board modules / board-rows: drop from
   * SPAWN_DROP_HEIGHT with a leveling tilt (rotated about each entry's own
   * plan center), one-beat squash settle, dust at touchdown. `t0 = 0` until
   * the first rAF tick after the synchronous rebuild (lazy start — the heavy
   * mesh build must never eat into the fall). All per-frame work is scalar
   * math + transform writes on prebuilt groups.
   */
  private spawnTween: {
    entries: {
      group: THREE.Group
      base: THREE.Vector3
      /** rotation pivot (entry's plan center at board level, parent space) */
      pivot: THREE.Vector3
      /** local-space bottom y (squash pivot — the face that stays planted) */
      bottom: number
    }[]
    /** tilt axis ('z' for module columns, 'x' for board-rows) + signed angle */
    axis: 'x' | 'z'
    tilt: number
    /** world base rect of the new slab(s) — dust burst ring */
    rect: PuffRect
    t0: number
    landed: boolean
  } | null = null
  /** reduced-motion spawn: simple fade-in over the new groups */
  private fadeTween: { set: FadeSet; t0: number } | null = null
  /**
   * Scene-initiated removal ("−" chip / paddle long-press): the dropped
   * module column / board-row groups are detached from the OLD board build
   * (whose disposal is deferred to the tween end), lifted and faded out over
   * cloned materials, with a smaller dust puff at liftoff.
   */
  private removalTween: {
    groups: THREE.Group[]
    bases: THREE.Vector3[]
    set: FadeSet
    oldBuild: BoardBuild
    t0: number
  } | null = null
  /** fly home after the rig GREW (the new module must come into view) */
  private flyHomePending = false
  /** paddle direction tapped last — picks which groups animate on rebuild */
  private pendingGrowDir: GridGrowDirection | null = null
  /** "−" direction tapped last — arms the removal animation on rebuild */
  private pendingShrinkDir: GridGrowDirection | null = null
  /** canonical refs of holes covered by component bodies (occlusion UX) */
  private occluded = new Set<string>()
  /** ghost spin spring: pivot un-rotates from `from` to 0 (R-key cycle) */
  private ghostSpin: { pivot: THREE.Group; from: number; t0: number } | null = null
  /** ghost identity (type|at|picked) + rotation of the previous syncGhost */
  private lastGhostKey = ''
  private lastGhostRotation: Rotation = 0
  /** in-flight editing drags (select mode only; at most one non-null) */
  private moveDrag: MoveDrag | null = null
  private instDrag: InstrumentDrag | null = null
  private marquee: MarqueeDrag | null = null
  /** controls.enabled was forced off for a drag — restore on gesture end */
  private controlsSuspended = false

  // picking state (reused buffers — no per-frame allocations)
  private readonly holeIndex = new HoleIndex()
  private readonly raycaster = new THREE.Raycaster()
  private readonly pointerNdc = new THREE.Vector2()
  private readonly hitBuf: THREE.Intersection[] = []
  private pointerDirty = false
  private pointerInside = false
  private lastHoverHole: HoleRef | null = null
  private downInfo: {
    x: number
    y: number
    t: number
    id: number
    type: string
    /** peak drift (px) from the down point — tap/long-press discrimination */
    maxDrift: number
  } | null = null
  /** pointerType of the most recent pointer event (drives snap radius) */
  private lastPointerType = 'mouse'
  /** primary touch pointer currently down (drives fingertip aiming) */
  private activeTouchId: number | null = null
  private longPressTimer: number | null = null
  /** a long-press fired — swallow the matching pointerup tap */
  private tapSuppressed = false
  /** previous empty-space tap, for double-tap re-frame detection */
  private lastBgTap: { x: number; y: number; t: number } | null = null
  /** app interaction mode, if the host reports it (else inferred from ghost/preview) */
  private explicitMode: SceneInteractionMode | null = null
  /** camera re-frame tween (rAF-interpolated, spring-eased) */
  private camTween: {
    startPos: THREE.Vector3
    startTgt: THREE.Vector3
    endPos: THREE.Vector3
    endTgt: THREE.Vector3
    t0: number
  } | null = null
  /** scratch state for the fingertip cursor (no per-frame allocations) */
  private fingertipHasPoint = false
  private readonly fingertipPoint = new THREE.Vector3()
  private readonly tmpNdc = new THREE.Vector2()
  private readonly tmpVecA = new THREE.Vector3()
  private readonly tmpVecB = new THREE.Vector3()

  // -------------------------------------------------------------- lifecycle

  mount(container: HTMLElement): void {
    if (this.m) this.dispose()

    const renderer = new THREE.WebGLRenderer({ antialias: true })
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2))
    const w = Math.max(1, container.clientWidth)
    const h = Math.max(1, container.clientHeight)
    renderer.setSize(w, h)
    // product-render pipeline: sRGB out, ACES filmic tone mapping, ONE soft
    // shadow map (PCFSoft, 2048) — no postprocessing, pixelRatio stays ≤ 2
    renderer.outputColorSpace = THREE.SRGBColorSpace
    renderer.toneMapping = THREE.ACESFilmicToneMapping
    renderer.toneMappingExposure = EXPOSURE
    renderer.shadowMap.enabled = true
    renderer.shadowMap.type = THREE.PCFSoftShadowMap
    // The shadow map depends only on geometry + the key light — never the
    // orbiting camera — and the scene is static between layout edits. Render
    // it on demand (syncLayout / refitShadows set shadowMap.needsUpdate)
    // instead of re-rendering every caster into the 2048² map every frame.
    renderer.shadowMap.autoUpdate = false
    renderer.shadowMap.needsUpdate = true
    renderer.domElement.style.display = 'block'
    // touch-native canvas: the page must never scroll/zoom/select/loupe from here
    renderer.domElement.style.touchAction = 'none'
    renderer.domElement.style.userSelect = 'none'
    renderer.domElement.style.setProperty('-webkit-user-select', 'none')
    renderer.domElement.style.setProperty('-webkit-touch-callout', 'none')
    renderer.domElement.style.setProperty('-webkit-tap-highlight-color', 'transparent')
    container.appendChild(renderer.domElement)

    const scene = new THREE.Scene()
    scene.background = new THREE.Color(0x15171c)

    // image-based lighting: PMREM'd RoomEnvironment makes the PBR materials
    // (brushed metal, molded epoxy, LED glass) actually read as materials
    const pmrem = new THREE.PMREMGenerator(renderer)
    const room = new RoomEnvironment()
    const envTex = pmrem.fromScene(room, 0.04).texture
    room.dispose()
    scene.environment = envTex
    scene.environmentIntensity = ENV_INTENSITY

    const boardConfig = boardConfigOf(this.layout)
    const ext = boardExtents(boardConfig)
    const cx = (ext.minX + ext.maxX) / 2
    const cz = (ext.minZ + ext.maxZ) / 2

    const camera = new THREE.PerspectiveCamera(45, w / h, 0.1, 1000)
    // provisional elevated 3/4 view — replaced by the aspect-fit home framing
    // (computeHomeFraming) as soon as the Mounted record exists below
    camera.position.set(cx - 6, 36, cz + 40)

    const controls = new OrbitControls(camera, renderer.domElement)
    controls.target.set(cx, 0, cz)
    controls.enableDamping = true
    controls.dampingFactor = 0.08
    // sane orbit limits — the camera can never go under the board
    controls.minDistance = 6
    controls.maxDistance = 180
    controls.maxPolarAngle = Math.PI * 0.49
    // touch: one finger rotates, two fingers pinch-zoom + pan (DESIGN.md §4).
    // touches.ONE is swapped to null while place/wire aiming is active — see
    // updateTouchGestures().
    controls.touches.ONE = THREE.TOUCH.ROTATE
    controls.touches.TWO = THREE.TOUCH.DOLLY_PAN
    controls.update()

    // render-mode engine: Performance keeps the plain render call in the rAF
    // loop below at zero added cost; Enhanced/Studio take over presentation
    // (contract in render-modes/manager.ts). Boots from the persisted
    // 'bb.renderMode' / device default; a host preference set before mount
    // (store boot value) is applied on top.
    this.modes.init(renderer, scene, camera)
    if (this.renderModePref) this.modes.setMode(this.renderModePref)
    // camera interaction → Studio yields to the Enhanced raster while moving
    // (booleans guard the depth counter against unbalanced start/end events)
    const onControlsStart = () => {
      if (!this.controlsInteracting) {
        this.controlsInteracting = true
        this.modes.onInteractionStart()
      }
    }
    const onControlsEnd = () => {
      if (this.controlsInteracting) {
        this.controlsInteracting = false
        this.modes.onInteractionEnd()
        // hover processing is gated off during the gesture (B3) — re-arm it
        // so the ring/label/cursor refresh on release even without a move
        this.pointerDirty = true
      }
    }
    controls.addEventListener('start', onControlsStart)
    controls.addEventListener('end', onControlsEnd)
    // Studio convergence progress → host status capsule (payload is reused)
    const offRenderProgress = this.modes.on('progress', (p) => {
      this.callbacks.onRenderProgress?.(p)
    })

    // lighting: the IBL carries the ambience; one warm shadow-casting key
    // (camera fitted to the board in refitShadows) + a dim cool fill.
    // No hemisphere light — it would wash the IBL flat.
    const keyLight = new THREE.DirectionalLight(KEY_COLOR, KEY_INTENSITY)
    keyLight.castShadow = true
    keyLight.shadow.mapSize.set(SHADOW_MAP_SIZE, SHADOW_MAP_SIZE)
    keyLight.shadow.bias = -0.0002
    keyLight.shadow.normalBias = 0.02
    const fillLight = new THREE.DirectionalLight(FILL_COLOR, FILL_INTENSITY)
    fillLight.position.set(-35, 40, -30)
    scene.add(keyLight, keyLight.target, fillLight)

    // desk: one large LIT laminate plane just under the board — it receives
    // the key-light shadow physically, so the board and instruments sit on a
    // believable surface instead of floating in an unlit void (DESIGN §9
    // "product photo of a real breadboard on a desk"). The texture's alpha
    // fades to 0 at the rim, dissolving into the background with no edge.
    const groundGroup = new THREE.Group()
    groundGroup.name = 'ground'
    const groundGeo = new THREE.PlaneGeometry(GROUND_SIZE, GROUND_SIZE)
    const deskTex = makeDeskTextures(renderer.capabilities.getMaxAnisotropy())
    const backdropMat = new THREE.MeshStandardMaterial(
      deskTex
        ? {
            map: deskTex.map, // repeats (per-map UV transforms, three r152+)
            roughnessMap: deskTex.rough,
            roughness: 1, // multiplied by the roughness map (≈ 0.82 base)
            alphaMap: deskTex.alpha, // non-repeating radial rim fade
            metalness: 0,
            transparent: true,
            depthWrite: false,
          }
        : { color: 0x2c241d, roughness: 0.9, metalness: 0 },
    )
    const backdropTexs: THREE.Texture[] = deskTex
      ? [deskTex.map, deskTex.rough, deskTex.alpha].filter((t): t is THREE.CanvasTexture => !!t)
      : []
    const backdrop = new THREE.Mesh(groundGeo, backdropMat)
    backdrop.rotation.x = -Math.PI / 2
    backdrop.position.y = GROUND_BACKDROP_Y
    backdrop.receiveShadow = true // the ONE shadow map lands here
    groundGroup.add(backdrop)
    groundGroup.position.set(cx, 0, cz)
    scene.add(groundGroup)
    freezeTransforms(groundGroup) // static (B2); board rebuilds updateMatrix

    this.holeIndex.rebuild(boardConfig)
    const board = buildBoard(renderer.capabilities.getMaxAnisotropy(), boardConfig)
    scene.add(board.group)
    // the board is static between rig edits (B2); the module spring-in tween
    // is the one mover and calls updateMatrix per animated group per frame
    freezeTransforms(board.group)

    const componentsGroup = new THREE.Group()
    componentsGroup.name = 'components'
    const wiresGroup = new THREE.Group()
    wiresGroup.name = 'wires'
    const terminalsGroup = new THREE.Group()
    terminalsGroup.name = 'terminals'
    const overlayGroup = new THREE.Group()
    overlayGroup.name = 'overlay'
    // Studio: the whole overlay subtree (holograms, hover FX, selection
    // boxes, previews, coordinate chips) is excluded from the path-traced
    // still and composited raster-side instead — see renderStudioOverlays
    overlayGroup.userData.bbNoStudio = true
    scene.add(componentsGroup, wiresGroup, terminalsGroup, overlayGroup)
    // the container groups themselves never move (children freeze/animate
    // individually — root-only, NOT recursive: overlay FX stay auto)
    for (const g of [componentsGroup, wiresGroup, terminalsGroup, overlayGroup]) {
      g.updateMatrix()
      g.matrixAutoUpdate = false
    }

    // shared FX clock + reduced-motion preference (sampled once per mount)
    const clock = new THREE.Clock()
    const reduced = prefersReducedMotion()
    setHologramReducedMotion(reduced)

    // hovered-hole FX: LED-phosphor glow ring + pooled coordinate chip
    // (the holographic placement ghost is built on demand in syncGhost)
    const hoverRing = makeHoverRing()
    hoverRing.setReducedMotion(reduced)
    overlayGroup.add(hoverRing.object)
    const holeLabel = makeHoleLabel()
    overlayGroup.add(holeLabel.object)

    // "+" grow paddles: floating glass plates with plus glyphs at the four
    // edges of the 2-D grid (visibility driven per frame in updatePaddles)
    const paddleBuild = buildPaddles()
    for (const p of paddleBuild.paddles) scene.add(p.group)

    // pooled touchdown-dust FX (board spawn/removal). Mounted invisible so
    // the warmup compile below links its sprite program at mount time — the
    // first puff must never compile a shader mid-animation.
    const spawnFx = new SpawnFX()
    scene.add(spawnFx.group)

    // fingertip ghost-cursor (DESIGN.md §4): a glowing ring + crosshair that
    // floats toward the top of the screen from the touched point so the finger
    // never hides the target hole. Always on top (depthTest off), shown only
    // while a touch pointer is down in place/wire mode.
    const fingertipGroup = new THREE.Group()
    fingertipGroup.name = 'fingertip-cursor'
    fingertipGroup.visible = false
    const fingertipGeos: THREE.BufferGeometry[] = []
    const fingertipRingMat = new THREE.MeshBasicMaterial({
      color: 0x0a84ff,
      transparent: true,
      opacity: 0.95,
      depthTest: false,
      depthWrite: false,
      side: THREE.DoubleSide,
    })
    const fingertipGlowMat = new THREE.MeshBasicMaterial({
      color: 0x64d2ff,
      transparent: true,
      opacity: 0.3,
      depthTest: false,
      depthWrite: false,
      side: THREE.DoubleSide,
    })
    const fingertipCrossMat = new THREE.MeshBasicMaterial({
      color: 0xeaf4ff,
      transparent: true,
      opacity: 0.9,
      depthTest: false,
      depthWrite: false,
      side: THREE.DoubleSide,
    })
    {
      const ringGeo = new THREE.RingGeometry(0.55, 0.8, 32)
      const glowGeo = new THREE.RingGeometry(0.8, 1.25, 32)
      const crossGeo = new THREE.PlaneGeometry(1.0, 0.07)
      fingertipGeos.push(ringGeo, glowGeo, crossGeo)
      const crossB = new THREE.Mesh(crossGeo, fingertipCrossMat)
      crossB.rotation.z = Math.PI / 2 // in-plane spin — applied before the x-flip below
      for (const mesh of [
        new THREE.Mesh(glowGeo, fingertipGlowMat),
        new THREE.Mesh(ringGeo, fingertipRingMat),
        new THREE.Mesh(crossGeo, fingertipCrossMat),
        crossB,
      ]) {
        mesh.rotation.x = -Math.PI / 2 // lie flat on the board plane
        mesh.renderOrder = 10
        fingertipGroup.add(mesh)
      }
    }
    overlayGroup.add(fingertipGroup)

    // selection highlight overlay (translucent box per selected component —
    // component meshes share module-cached materials, so never mutate those)
    const selBoxGeo = new THREE.BoxGeometry(1, 1, 1)
    const selBoxMat = new THREE.MeshBasicMaterial({
      color: SELECT_EMISSIVE,
      transparent: true,
      opacity: 0.3,
      depthWrite: false,
    })

    // shared resources for wires and terminal-post hit proxies. The tip pin
    // is the ~5mm stripped tinned end every real jumper shows at a hole
    // entry: the insulation tube stops WIRE_TIP_LEN above the board (wires.ts
    // trims the curve) and this bare pin carries on down into the recessed
    // socket. The post proxy is INVISIBLE — the instrument mesh draws the
    // real panel-mounted post; this box only catches rays/touches for it.
    const capGeo = new THREE.SphereGeometry(1, 10, 8)
    const tipGeo = new THREE.CylinderGeometry(
      0.085,
      0.07,
      WIRE_TIP_LEN + WIRE_TIP_SINK,
      8,
    )
    const tipMat = new THREE.MeshStandardMaterial({
      color: 0xc9ccd2,
      metalness: 0.9,
      roughness: 0.35,
    })
    const postGeo = new THREE.BoxGeometry(POST_PROXY_W, POST_PROXY_H, POST_PROXY_D)
    const postMat = new THREE.MeshBasicMaterial()
    const previewMat = new THREE.MeshBasicMaterial({
      color: 0xffd84d,
      transparent: true,
      opacity: 0.85,
      depthWrite: false,
    })

    // pointer events — passive observers that do not fight OrbitControls
    const dom = renderer.domElement
    const onPointerMove = (e: PointerEvent) => {
      if (!e.isPrimary) return // ignore secondary fingers during a pinch
      this.lastPointerType = e.pointerType
      this.updateNdc(e)
      this.pointerInside = true
      this.pointerDirty = true
      const down = this.downInfo
      if (down && e.pointerId === down.id) {
        const drift = Math.hypot(e.clientX - down.x, e.clientY - down.y)
        if (drift > down.maxDrift) down.maxDrift = drift
        if (drift > LONG_PRESS_MAX_PX) this.cancelLongPress()
        // editing gestures (move-drag / instrument-drag / marquee) track the
        // pointer directly — they own the gesture once past the threshold
        this.updateEditDrags(e, drift)
      }
    }
    const onPointerDown = (e: PointerEvent) => {
      this.lastPointerType = e.pointerType
      this.camTween = null // grabbing the scene cancels the re-frame tween
      if (!e.isPrimary) {
        // a second finger means pinch — never a tap / long-press / fingertip
        // commit, and any in-flight editing drag is abandoned (not committed)
        this.cancelLongPress()
        this.cancelEditDrags()
        this.downInfo = null
        this.activeTouchId = null
        this.hideFingertip()
        return
      }
      if (e.button !== 0) return
      this.beginPointerInteraction() // Studio raster-falls-back while touched
      this.updateNdc(e)
      this.pointerInside = true
      this.pointerDirty = true // fingertip cursor appears within one frame
      this.tapSuppressed = false // fresh gesture
      this.downInfo = {
        x: e.clientX,
        y: e.clientY,
        t: performance.now(),
        id: e.pointerId,
        type: e.pointerType,
        maxDrift: 0,
      }
      if (e.pointerType === 'touch') this.activeTouchId = e.pointerId
      // long-press a component/wire (suppressed while fingertip-aiming a touch)
      if (!(e.pointerType === 'touch' && this.isPlaceOrWireMode())) {
        let id = this.pickObjectIdAtPointer()
        if (id === null && e.pointerType === 'touch' && this.m) {
          // finger-sized long-press target — wires are only ~6px wide
          id = this.pickWithSlop(this.m.objectPickRoots, OBJECT_TOUCH_SLOP_PX)?.componentId ?? null
        }
        if (id !== null) this.startLongPress(id)
        else if (e.pointerType === 'touch' && this.m) {
          // touch removal affordance: long-pressing a "+" paddle on a
          // shrinkable edge removes the board there (no hover on touch, so
          // the "−" chip can't be reached — this is its coarse-pointer twin)
          this.raycaster.setFromCamera(this.pointerNdc, this.m.camera)
          const pad = this.pickPaddle(this.m)
          if (pad && !pad.minus && this.paddleRemovable(this.m, pad.rec.dir)) {
            this.startPaddleLongPress(pad.rec.dir)
          }
        }
        // editing gestures (select mode): a drag starting on an already-
        // SELECTED part is a move — NOT an orbit (decided here so the orbit
        // can be suspended before OrbitControls rotates); shift+drag on empty
        // board (desktop mouse) arms the marquee rectangle.
        this.maybeBeginEditDrag(e, id)
      }
    }
    const onPointerUp = (e: PointerEvent) => {
      this.cancelLongPress()
      this.endPointerInteraction()
      if (this.finishEditDrags(e)) {
        // a started move/instrument/marquee drag consumed the whole gesture
        if (this.activeTouchId === e.pointerId) this.activeTouchId = null
        this.hideFingertip()
        this.downInfo = null
        this.tapSuppressed = false
        return
      }
      const down = this.downInfo
      const wasFingertip = this.activeTouchId === e.pointerId && this.isPlaceOrWireMode()
      if (this.activeTouchId === e.pointerId) this.activeTouchId = null
      this.hideFingertip()
      if (!down || e.pointerId !== down.id) return
      this.downInfo = null
      if (e.button !== 0) return
      if (this.tapSuppressed) {
        this.tapSuppressed = false // a long-press already consumed this gesture
        return
      }
      const touchLike = down.type !== 'mouse'
      const maxPx = touchLike ? TAP_MAX_PX : CLICK_MAX_PX
      const maxMs = touchLike ? TAP_MAX_MS : CLICK_MAX_MS
      const drift = Math.max(down.maxDrift, Math.hypot(e.clientX - down.x, e.clientY - down.y))
      const dt = performance.now() - down.t
      const isTap = drift < maxPx && dt < maxMs
      if (wasFingertip && !isTap) {
        // drag/dwell-to-aim, lift-to-commit: the finger moved or held long
        // enough to have SEEN the aim ring, so the snapped candidate (hole or
        // off-board terminal) wins, however far the finger travelled
        this.updateNdc(e)
        const target = this.pickFingertipTarget()
        if (target?.kind === 'hole') {
          if (this.occluded.has(target.hole)) {
            // occluded hole: rejected — the red locked chip shows WHERE, the
            // host callback explains WHY (toast naming the covering part)
            this.callbacks.onHoleOcclusionRejected?.(target.hole)
          } else {
            this.callbacks.onHoleClick?.(target.hole)
          }
        } else if (target) {
          this.callbacks.onTerminalClick?.(target.ref)
        }
        return
      }
      // quick taps — including in place/wire mode, where the offset aim ring is
      // never perceivable within <350ms — commit what is under the finger
      if (isTap) this.handleClick(e)
    }
    const onPointerCancel = () => {
      this.cancelLongPress()
      this.endPointerInteraction()
      this.cancelEditDrags()
      this.downInfo = null
      this.activeTouchId = null
      this.tapSuppressed = false
      this.hideFingertip()
    }
    const onPointerLeave = () => {
      this.cancelLongPress()
      this.endPointerInteraction()
      this.cancelEditDrags()
      this.pointerInside = false
      this.pointerDirty = false
      this.downInfo = null
      this.activeTouchId = null
      this.tapSuppressed = false
      this.hideFingertip()
      if (this.lastHoverHole !== null) {
        this.lastHoverHole = null
        this.callbacks.onHoleHover?.(null)
      }
      const mm = this.m
      if (mm) {
        mm.hoverRing.hide(mm.clock.getElapsedTime())
        if (this.labelPinnedUntil <= performance.now()) mm.holeLabel.hide()
        this.paddleHover = null
        this.paddleMinusHover = null
        mm.container.style.cursor = ''
      }
    }
    // iOS Safari hardening: pinch must never zoom the page, long-press must
    // never trigger the system loupe/menu (touch-action:none + these guards)
    const preventDefault = (e: Event) => e.preventDefault()
    const onWheel = () => {
      this.camTween = null // user zoom cancels the re-frame tween
    }
    dom.addEventListener('pointermove', onPointerMove)
    dom.addEventListener('pointerdown', onPointerDown)
    dom.addEventListener('pointerup', onPointerUp)
    dom.addEventListener('pointercancel', onPointerCancel)
    dom.addEventListener('pointerleave', onPointerLeave)
    dom.addEventListener('gesturestart', preventDefault)
    dom.addEventListener('gesturechange', preventDefault)
    dom.addEventListener('gestureend', preventDefault)
    dom.addEventListener('touchstart', preventDefault, { passive: false })
    dom.addEventListener('touchmove', preventDefault, { passive: false })
    dom.addEventListener('contextmenu', preventDefault)
    dom.addEventListener('wheel', onWheel, { passive: true })
    // pause the render loop entirely while the tab is hidden (perf budget)
    const onVisibility = () => {
      if (document.hidden) stopLoop()
      else startLoop()
    }
    document.addEventListener('visibilitychange', onVisibility)
    const removeListeners = () => {
      controls.removeEventListener('start', onControlsStart)
      controls.removeEventListener('end', onControlsEnd)
      offRenderProgress()
      dom.removeEventListener('pointermove', onPointerMove)
      dom.removeEventListener('pointerdown', onPointerDown)
      dom.removeEventListener('pointerup', onPointerUp)
      dom.removeEventListener('pointercancel', onPointerCancel)
      dom.removeEventListener('pointerleave', onPointerLeave)
      dom.removeEventListener('gesturestart', preventDefault)
      dom.removeEventListener('gesturechange', preventDefault)
      dom.removeEventListener('gestureend', preventDefault)
      dom.removeEventListener('touchstart', preventDefault)
      dom.removeEventListener('touchmove', preventDefault)
      dom.removeEventListener('contextmenu', preventDefault)
      dom.removeEventListener('wheel', onWheel)
      document.removeEventListener('visibilitychange', onVisibility)
    }

    const resizeObserver = new ResizeObserver(() => this.handleResize())
    resizeObserver.observe(container)

    const m: Mounted = {
      container,
      renderer,
      scene,
      camera,
      controls,
      board,
      componentsGroup,
      wiresGroup,
      terminalsGroup,
      overlayGroup,
      pmrem,
      envTex,
      keyLight,
      fillLight,
      groundGroup,
      groundGeo,
      backdropMat,
      backdropTexs,
      clock,
      reduced,
      hoverRing,
      holeLabel,
      paddles: paddleBuild.paddles,
      paddleGeos: paddleBuild.geos,
      spawnFx,
      fingertipGroup,
      fingertipGeos,
      fingertipRingMat,
      fingertipGlowMat,
      fingertipCrossMat,
      homePos: camera.position.clone(),
      homeTarget: controls.target.clone(),
      selBoxGeo,
      selBoxMat,
      capGeo,
      tipGeo,
      tipMat,
      postGeo,
      postMat,
      previewMesh: null,
      previewMat,
      resizeObserver,
      raf: 0,
      rafActive: false,
      objectPickRoots: [componentsGroup, wiresGroup],
      hoverPickRoots: [terminalsGroup, componentsGroup, wiresGroup],
      removeListeners,
    }
    this.m = m

    // aspect-fit home framing (replaces the provisional position above): a
    // portrait phone must see the whole board, not a landscape-tuned crop
    this.computeHomeFraming(m)
    m.camera.position.copy(m.homePos)
    m.controls.target.copy(m.homeTarget)
    m.controls.update()

    // sync any state set before mount
    this.positionPaddles(m)
    this.syncLayout()
    this.syncGhost()
    this.syncWirePreview()
    this.applySelection()
    this.applyTelemetryAll()
    this.updateTouchGestures()

    // PERF (perf/hotspots.md, A5): pre-warm the first-use FX shader programs.
    // The hover ring + coordinate chip otherwise compile in the middle of the
    // user's FIRST drag (+2 program links, a >100ms frame mid-orbit), and the
    // hologram/pin-marker materials compile mid-first-placement. compile()
    // walks the graph with scene.traverse (visibility ignored), so the
    // invisible FX already mounted warm in place; the on-demand hologram
    // materials are compiled against throwaway meshes. One-time mount cost —
    // these programs would otherwise compile inside a gesture.
    {
      const warmGeo = new THREE.BoxGeometry(0.1, 0.1, 0.1)
      const warm = new THREE.Group()
      warm.name = 'shader-warmup'
      warm.visible = false
      const warmMarkers: PinMarkers[] = []
      for (const variant of ['valid', 'invalid'] as const) {
        warm.add(new THREE.Mesh(warmGeo, makeHologramMaterial(variant)))
        const markers = makePinMarkers([{ x: 0, y: 0, z: 0 }], variant)
        warmMarkers.push(markers)
        warm.add(markers.group)
      }
      scene.add(warm)
      renderer.compile(scene, camera)
      scene.remove(warm)
      for (const mk of warmMarkers) mk.dispose()
      warmGeo.dispose() // hologram/marker materials stay module-cached
    }

    let prevFrameT = 0 // rAF-local: render-mode dt without per-frame allocs
    const animate = () => {
      if (this.m !== m || !m.rafActive) return // disposed/paused — stop this loop
      m.raf = requestAnimationFrame(animate)
      m.controls.update()
      this.updateCamTween(m) // after controls.update so the tween wins while active
      // shared-FX clock: one number write drives every hologram/marker shader
      const t = m.clock.getElapsedTime()
      const dt = prevFrameT > 0 ? t - prevFrameT : 0
      prevFrameT = t
      tickHolograms(t)
      m.hoverRing.tick(t)
      this.updatePaddles(m, t)
      this.updateSpawnTween(m)
      this.updateRemovalTween(m)
      this.updateFadeTween()
      if (m.spawnFx.live) m.spawnFx.tick(performance.now())
      this.updateGhostSpin()
      if (this.labelPinnedUntil > 0 && performance.now() > this.labelPinnedUntil) {
        this.labelPinnedUntil = 0
        if (this.lastHoverHole === null) m.holeLabel.hide()
      }
      // PERF (perf/hotspots.md B3): hover targeting is meaningless while an
      // orbit gesture is in flight — without the gate the brute-force
      // raycast (+ its Intersection allocations) runs on EVERY orbit frame,
      // because the drag moves the pointer each frame. pointerDirty stays
      // set (and onControlsEnd re-arms it), so the ring/label/cursor refresh
      // on the frame the gesture releases.
      if (this.pointerDirty && this.pointerInside && !this.controlsInteracting) {
        this.processHover(m)
        this.pointerDirty = false
      }
      // throttled Studio material refresh (telemetry / wire-tint changes)
      if (
        this.materialsRefreshPending &&
        performance.now() - this.lastMaterialsRefresh >= MATERIALS_REFRESH_MS
      ) {
        this.materialsRefreshPending = false
        this.lastMaterialsRefresh = performance.now()
        this.modes.invalidate('materials')
      }
      // Performance mode (and any still-loading pipeline) returns false and
      // the classic raster pipeline below runs untouched — byte-identical
      // behavior and cost to the pre-render-modes loop. Enhanced/Studio draw
      // inside render(); a path-traced frame additionally gets the raster
      // overlays (holograms, hover FX, selection) composited on top so every
      // interactive affordance stays live over the converging/held still.
      if (!this.modes.render(dt)) {
        m.renderer.render(m.scene, m.camera)
      } else if (this.modes.pathTracedFrame) {
        this.renderStudioOverlays(m)
      }
    }
    const startLoop = () => {
      if (this.m !== m || m.rafActive) return
      m.rafActive = true
      m.raf = requestAnimationFrame(animate)
    }
    const stopLoop = () => {
      if (!m.rafActive) return
      m.rafActive = false
      cancelAnimationFrame(m.raf)
    }
    if (!document.hidden) startLoop() // else onVisibility resumes it
  }

  dispose(): void {
    const m = this.m
    if (!m) return
    this.m = null // stops the animation loop

    cancelAnimationFrame(m.raf)
    m.resizeObserver.disconnect()
    m.removeListeners()
    // before scene teardown: Enhanced/Studio restore the displaced
    // environment + shadow budget onto still-live objects, and Studio frees
    // its BVH/accumulation GPU memory
    this.modes.dispose()
    m.controls.dispose()

    this.clearSelectionHighlights()
    for (const id of Array.from(this.components.keys())) this.removeComponentRecord(m, id)
    for (const id of Array.from(this.wires.keys())) this.removeWireRecord(m, id)
    this.components.clear()
    this.wires.clear()

    if (m.previewMesh) {
      m.overlayGroup.remove(m.previewMesh)
      ;(m.previewMesh.geometry as THREE.BufferGeometry).dispose()
    }
    m.previewMat.dispose()
    this.cancelEditDrags()
    this.clearGhostFx(m)
    disposeHolograms() // module-cached FX materials (recreated on demand)
    m.hoverRing.dispose()
    m.holeLabel.dispose()
    this.finishBoardAnims(m) // removal tween may hold the OLD board build
    m.spawnFx.dispose()
    for (const g of m.paddleGeos) g.dispose()
    for (const p of m.paddles) {
      p.mat.dispose()
      p.glyphMat.dispose()
      p.minusMat?.dispose()
      p.minusGlyphMat?.dispose()
    }
    for (const g of m.fingertipGeos) g.dispose()
    m.fingertipRingMat.dispose()
    m.fingertipGlowMat.dispose()
    m.fingertipCrossMat.dispose()
    m.selBoxGeo.dispose()
    m.selBoxMat.dispose()
    m.capGeo.dispose()
    m.tipGeo.dispose()
    m.tipMat.dispose()
    m.postGeo.dispose()
    m.postMat.dispose()
    m.groundGeo.dispose()
    m.backdropMat.dispose()
    for (const t of m.backdropTexs) t.dispose()
    m.keyLight.shadow.dispose()
    m.scene.environment = null
    m.envTex.dispose()
    m.pmrem.dispose()
    m.board.dispose()

    m.scene.clear()
    m.renderer.dispose()
    m.renderer.domElement.remove()
    m.container.style.cursor = ''

    this.cancelLongPress()
    this.camTween = null
    this.flyHomePending = false
    this.pendingGrowDir = null
    this.pendingShrinkDir = null
    this.labelPinnedUntil = 0
    this.paddleHover = null
    this.paddleMinusHover = null
    this.ghostSpin = null
    this.lastGhostKey = ''
    this.lastGhostRotation = 0
    this.controlsSuspended = false
    this.controlsInteracting = false
    this.pointerInteracting = false
    this.materialsRefreshPending = false
    this.lastMaterialsRefresh = 0
    this.activeTouchId = null
    this.tapSuppressed = false
    this.lastBgTap = null
    this.fingertipHasPoint = false
    this.pointerDirty = false
    this.pointerInside = false
    this.lastHoverHole = null
    this.downInfo = null
    this.hitBuf.length = 0
  }

  setCallbacks(cb: Partial<SceneCallbacks>): void {
    Object.assign(this.callbacks, cb)
  }

  // ------------------------------------------------------------------ state

  setLayout(layout: CircuitLayout): void {
    this.layout = layout
    if (this.m) this.syncLayout()
  }

  setTelemetry(t: SimTelemetry | null): void {
    const changed = t !== this.telemetry
    this.telemetry = t
    // PERF: the engine emits a FRESH telemetry object per push, so an
    // identical reference carries nothing new — skip the O(components)
    // visual pass (a paused sim re-pushing the same snapshot costs zero)
    if (changed && this.m) this.applyTelemetryAll()
    // Studio: LED emissive / display segments are material-only changes —
    // request a (throttled) refresh so a held still shows live LED state.
    // No-op in Performance/Enhanced (they redraw every frame anyway).
    if (changed) this.materialsRefreshPending = true
  }

  setGhost(ghost: GhostSpec | null): void {
    this.ghost = ghost
    this.updateTouchGestures() // ghost ⇒ place mode may be inferred
    if (this.m) this.syncGhost()
  }

  setSelection(ids: string[]): void {
    this.selectedIds = ids.slice()
    if (this.m) this.applySelection()
  }

  setWirePreview(from: HoleRef | string | null, to: HoleRef | null): void {
    this.preview = { from, to }
    this.updateTouchGestures() // active preview ⇒ wire mode may be inferred
    if (this.m) this.syncWirePreview()
  }

  /**
   * ADDITIVE contract extension (optional in IBreadboardScene): the host
   * app's interaction mode. Enables touch ergonomics — fingertip ghost-cursor
   * and one-finger aiming (instead of orbiting) during place/wire. When never
   * called, the scene infers the mode from setGhost/setWirePreview.
   */
  setInteractionMode(mode: SceneInteractionMode): void {
    this.explicitMode = mode
    this.updateTouchGestures()
  }

  /**
   * ADDITIVE contract extension (optional in IBreadboardScene): spring the
   * camera to frame the current circuit. The host calls this after wholesale
   * layout loads (examples / JSON import / AI apply) — those circuits can sit
   * anywhere on the board, and the fixed home framing crops phone portrait
   * viewports to a fraction of it. Empty board → home framing.
   */
  frameContent(): void {
    this.reframeCamera()
  }

  /**
   * ADDITIVE contract extension (optional in IBreadboardScene): the user's
   * render-mode preference (More sheet picker → store.renderMode). The
   * manager clamps unsupported modes to the device's best fallback and
   * persists the resolved choice under 'bb.renderMode'. Like all desired
   * state this survives unmount/remount (applied again after init).
   */
  setRenderMode(mode: RenderModeId): void {
    this.renderModePref = mode
    if (this.m) this.modes.setMode(mode)
  }

  // ----------------------------------------------------------- layout diff

  private syncLayout(): void {
    const m = this.m
    if (!m) return

    // board size/count/board-row change → rebuild the board mesh + hole index
    // (home framing and the shadow-camera fit follow at the end of this method)
    const config = boardConfigOf(this.layout)
    if (
      config.size !== m.board.config.size ||
      config.count !== m.board.config.count ||
      config.rows !== (m.board.config.rows ?? 1)
    ) {
      this.rebuildBoard(m, config)
    } else {
      // a non-rig edit landed first (or a paddle tap was refused by the
      // store): stale paddle intents must not mis-attribute a LATER rebuild
      this.pendingGrowDir = null
      this.pendingShrinkDir = null
    }

    // un-apply highlights so saved emissive values stay coherent across rebuilds
    this.clearSelectionHighlights()

    // occlusion UX inputs: holes covered by component bodies get no hover
    // ring, a red locked coordinate chip, and silently rejected place/wire
    // clicks (mirrors the validator's occlusion pass via the same model code)
    this.occluded.clear()
    for (const comp of this.layout.components) {
      const entry = getEntry(comp.type)
      if (!entry) continue
      for (const ref of occludedHoles(comp, entry, config)) this.occluded.add(ref)
    }

    // ONE unified collision-aware routing pass: axial leaded components and
    // every wire route together (cached inside wires.ts by an endpoint +
    // obstacle signature — no-op when unchanged). Must run before the
    // component diff: routed body poses fold into the rebuild signatures.
    planRoutes(this.layout)

    // --- components ---
    const seen = new Set<string>()
    let offboardSlot = 0
    for (const comp of this.layout.components) {
      const entry = getEntry(comp.type)
      if (!entry) continue
      const slot = entry.placement === 'offboard' ? offboardSlot++ : -1
      const sig = componentSignature(comp, entry, slot, config)
      const existing = this.components.get(comp.id)
      if (existing && existing.signature === sig) {
        existing.comp = comp
        seen.add(comp.id)
        continue
      }
      if (existing) this.removeComponentRecord(m, comp.id)
      const rec = this.buildComponentRecord(m, comp, entry, slot, sig)
      if (rec) {
        this.components.set(comp.id, rec)
        seen.add(comp.id)
      }
    }
    for (const id of Array.from(this.components.keys())) {
      if (!seen.has(id)) this.removeComponentRecord(m, id)
    }

    // --- wires (after components, so terminal attach points are current) ---
    const seenWires = new Set<string>()
    for (const wire of this.layout.wires) {
      const a = this.resolveEndpoint(wire.from)
      const b = this.resolveEndpoint(wire.to)
      if (!a || !b) continue // unresolvable endpoint → no visual
      const sig = wireSignature(wire, a, b)
      const existing = this.wires.get(wire.id)
      if (existing && existing.signature === sig) {
        existing.wire = wire
        seenWires.add(wire.id)
        continue
      }
      if (existing) this.removeWireRecord(m, wire.id)
      this.wires.set(wire.id, this.buildWireRecord(m, wire, a, b, sig))
      seenWires.add(wire.id)
    }
    for (const id of Array.from(this.wires.keys())) {
      if (!seenWires.has(id)) this.removeWireRecord(m, id)
    }

    this.applySelection()
    this.applyTelemetryAll()

    // casters changed → re-render the on-demand shadow map once next frame
    m.renderer.shadowMap.needsUpdate = true
    // Studio: scene-graph contents changed → schedule a lazy BVH rebuild
    // (no-op in Performance/Enhanced; rebuild runs off the interaction path
    // — only on an idle Studio frame, on a worker when available)
    this.modes.invalidate()

    // off-board instruments and board rig changes grow/shrink the home
    // extents; while the camera is parked at home, follow it so a freshly
    // added PSU (or a bigger board) stays framed (a user-positioned camera is
    // left alone). A rig GROWTH always flies home — the new module (and the
    // plus paddle that just moved to its edge) must come into view.
    // computeHomeFraming also refits the shadow camera.
    const wasHome = this.cameraAtHome(m)
    const homeMoved = this.computeHomeFraming(m)
    if (this.spawnTween || this.removalTween) {
      // the camera glide is SEQUENCED after the board animation (drop →
      // settle → dust → glide) — updateSpawnTween/updateRemovalTween fly
      // home when they land, so just remember that home moved under us
      if (homeMoved && wasHome) this.flyHomePending = true
    } else if (this.flyHomePending || (homeMoved && wasHome)) {
      this.flyHomePending = false
      this.flyCamera(m, m.homePos, m.homeTarget)
    }
  }

  /** Swap the board mesh + hole index to a new rig config (dispose the old). */
  private rebuildBoard(m: Mounted, config: BoardConfig): void {
    const prev = m.board.config
    const prevBuild = m.board
    this.finishBoardAnims(m) // any in-flight spawn/removal snaps to its end state

    const prevRows = prev.rows ?? 1
    const rows = config.rows ?? 1
    const shrankCount =
      config.size === prev.size && config.count === prev.count - 1 && rows === prevRows
    const shrankRows =
      config.size === prev.size && rows === prevRows - 1 && config.count === prev.count
    const shrinkDir = this.pendingShrinkDir
    this.pendingShrinkDir = null

    // scene-initiated removal ("−" chip / paddle long-press): detach the
    // dropped module column / board-row from the OLD build BEFORE disposing
    // it — the groups lift + fade out over cloned materials with a small
    // dust puff, and the old build's disposal waits for the tween end.
    let removalArmed = false
    if (
      (shrankCount || shrankRows) &&
      shrinkDir !== null &&
      !m.reduced &&
      !document.hidden
    ) {
      prevBuild.group.updateMatrixWorld(true)
      const groups = shrankCount
        ? prevBuild.moduleGroups
            .map((rowMods) => rowMods[prev.count - 1])
            .filter((g): g is THREE.Group => !!g)
        : prevBuild.rowGroups[prevRows - 1]
          ? [prevBuild.rowGroups[prevRows - 1]]
          : []
      if (groups.length > 0) {
        const box = new THREE.Box3()
        for (const g of groups) box.expandByObject(g) // world rect (pre-detach)
        const bases: THREE.Vector3[] = []
        for (const g of groups) {
          // reparent to the scene at the same world pose (parents are the
          // origin-rooted board group / its z-offset row groups)
          const pw = new THREE.Vector3()
          g.parent?.getWorldPosition(pw)
          g.removeFromParent()
          g.position.add(pw)
          g.updateMatrix() // frozen subtree (B2)
          m.scene.add(g)
          g.traverse((o) => {
            ;(o as THREE.Mesh).castShadow = false // no lingering shadow
          })
          bases.push(g.position.clone())
        }
        this.removalTween = {
          groups,
          bases,
          set: buildFadeSet(groups),
          oldBuild: prevBuild,
          t0: performance.now(),
        }
        m.spawnFx.burst(
          { minX: box.min.x, maxX: box.max.x, minZ: box.min.z, maxZ: box.max.z },
          performance.now(),
          9,
          0.8,
        )
        removalArmed = true
      }
    }

    m.scene.remove(prevBuild.group)
    if (!removalArmed) prevBuild.dispose() // else deferred to the tween end
    m.board = buildBoard(m.renderer.capabilities.getMaxAnisotropy(), config)
    m.scene.add(m.board.group)
    freezeTransforms(m.board.group) // static between rig edits (B2)
    this.holeIndex.rebuild(config)
    const ext = boardExtents(config)
    m.groundGroup.position.set((ext.minX + ext.maxX) / 2, 0, (ext.minZ + ext.maxZ) / 2)
    m.groundGroup.updateMatrix() // frozen (B2) — commit the recenter
    this.positionPaddles(m)
    this.lastHoverHole = null // stale refs may not exist on the new board

    // the grid GREW → the new module column / board-row DROPS in on its
    // fully prebuilt meshes (transform-only; the shadow map follows per
    // tween frame), then the camera glides home so the grown grid is framed.
    // The paddle the user tapped picks the edge: growing left/up remaps
    // content, so the NEW groups are the ones at index 0 (leftmost module
    // column / front board-row).
    const dir = this.pendingGrowDir
    this.pendingGrowDir = null
    if (config.size !== prev.size) return
    const grewCount = config.count === prev.count + 1 && rows === prevRows
    const grewRows = rows === prevRows + 1 && config.count === prev.count
    if (config.count < prev.count || rows < prevRows || (!grewCount && !grewRows)) {
      if (config.count > prev.count || rows > prevRows) this.flyHomePending = true
      return
    }
    this.flyHomePending = true
    if (document.hidden) return // FX are skipped entirely on a hidden tab
    let groups: THREE.Group[]
    let axis: 'x' | 'z'
    let tilt: number
    if (grewCount) {
      const k = dir === 'left' ? 0 : config.count - 1
      groups = m.board.moduleGroups
        .map((rowMods) => rowMods[k])
        .filter((g): g is THREE.Group => !!g)
      axis = 'z' // module columns lean sideways, toward the existing rig
      tilt = dir === 'left' ? -SPAWN_TILT_RAD : SPAWN_TILT_RAD
    } else {
      const r = dir === 'up' ? 0 : rows - 1
      const grp = m.board.rowGroups[r]
      groups = grp ? [grp] : []
      axis = 'x' // board-rows pitch front/back, toward the existing rig
      tilt = dir === 'up' ? SPAWN_TILT_RAD : -SPAWN_TILT_RAD
    }
    if (groups.length === 0) return

    if (m.reduced) {
      // reduced motion: simple fade-in — no fall, no squash, no dust
      this.fadeTween = { set: buildFadeSet(groups), t0: performance.now() }
      setFadeOpacity(this.fadeTween.set, 0)
      return
    }

    // setup allocations happen ONCE here (never per frame): per-entry pivot
    // (own plan center at board level, parent space) + base + squash bottom,
    // and the union base rect for the touchdown dust ring
    m.board.group.updateMatrixWorld(true)
    const rect: PuffRect = { minX: Infinity, maxX: -Infinity, minZ: Infinity, maxZ: -Infinity }
    const entries = groups.map((group) => {
      const box = new THREE.Box3().setFromObject(group)
      rect.minX = Math.min(rect.minX, box.min.x)
      rect.maxX = Math.max(rect.maxX, box.max.x)
      rect.minZ = Math.min(rect.minZ, box.min.z)
      rect.maxZ = Math.max(rect.maxZ, box.max.z)
      const base = group.position.clone()
      const pw = new THREE.Vector3()
      group.parent?.getWorldPosition(pw)
      const pivot = new THREE.Vector3(
        (box.min.x + box.max.x) / 2 - pw.x,
        -pw.y,
        (box.min.z + box.max.z) / 2 - pw.z,
      )
      return { group, base, pivot, bottom: box.min.y - pw.y - base.y }
    })
    this.spawnTween = { entries, axis, tilt, rect, t0: 0, landed: false }
    this.poseSpawnEntries(m, SPAWN_DROP_HEIGHT, this.spawnTween.tilt, 1)
  }

  /**
   * Pose every spawn entry at fall offset `yOff` with tilt `theta` about its
   * own pivot (scalar math — no per-frame allocations); `scaleY` < 1 squashes
   * about the slab's resting bottom face so the base stays planted.
   */
  private poseSpawnEntries(m: Mounted, yOff: number, theta: number, scaleY: number): void {
    const tw = this.spawnTween
    if (!tw) return
    const cos = Math.cos(theta)
    const sin = Math.sin(theta)
    for (const e of tw.entries) {
      const vx = e.base.x - e.pivot.x
      const vy = e.base.y + yOff - e.pivot.y
      const vz = e.base.z - e.pivot.z
      let nx = vx
      let ny = vy
      let nz = vz
      if (theta !== 0) {
        if (tw.axis === 'z') {
          nx = vx * cos - vy * sin
          ny = vx * sin + vy * cos
        } else {
          ny = vy * cos - vz * sin
          nz = vy * sin + vz * cos
        }
      }
      const g = e.group
      g.position.set(e.pivot.x + nx, e.pivot.y + ny, e.pivot.z + nz)
      if (tw.axis === 'z') g.rotation.z = theta
      else g.rotation.x = theta
      if (scaleY !== 1) {
        g.scale.y = scaleY
        g.position.y += e.bottom * (1 - scaleY)
      } else {
        g.scale.y = 1
      }
      g.updateMatrix() // frozen board subtree (B2) — explicit commit
    }
    // the moving casters shift — keep the on-demand shadow map fresh
    m.renderer.shadowMap.needsUpdate = true
  }

  private buildComponentRecord(
    m: Mounted,
    comp: ComponentInstance,
    entry: CatalogEntry,
    slot: number,
    signature: string,
  ): ComponentRecord | null {
    const pinPositions: THREE.Vector3[] = []
    const attach: THREE.Vector3[] = []
    const posts: THREE.Mesh[] = []

    if (entry.placement === 'offboard') {
      for (let i = 0; i < entry.pins.length; i++) {
        const pin = entry.pins[i]
        // explicit bench position (movable instruments) overrides the shelf
        const p = offboardTerminalPosition(slot, i, comp.pos)
        pinPositions.push(new THREE.Vector3(p.x, 0, p.z))
        attach.push(new THREE.Vector3(p.x, TERMINAL_TOP_Y, p.z))

        // invisible hit proxy aligned over the instrument mesh's panel-
        // mounted post (the ONLY rendered post) — raycasts/touch picking
        // keep their generous target without a second, floating visual
        const post = new THREE.Mesh(m.postGeo, m.postMat)
        post.visible = false
        post.position.set(p.x, TERMINAL_TOP_Y + POST_PROXY_DY, p.z + POST_PROXY_DZ)
        post.userData.terminalRef = `${comp.id}:${pin}`
        // static between edits (B2) — instrument drags updateMatrix explicitly
        post.updateMatrix()
        post.matrixAutoUpdate = false
        m.terminalsGroup.add(post)
        posts.push(post)
      }
    } else {
      // validate against the ACTIVE rig: far columns exist on labxl/multi-board
      const holes = componentPinHoles(comp, entry, boardConfigOf(this.layout))
      if (!holes) return null
      for (const h of holes) {
        if (!h) return null
        const p = holePosition(h)
        const v = new THREE.Vector3(p.x, 0, p.z)
        pinPositions.push(v)
        attach.push(v.clone())
      }
    }

    // axial leaded parts take their router-planned pose (body + lead paths);
    // wire attachment stays at the holes (attach[] above) — routed leads
    // always enter their exact holes, so picking/telemetry are unaffected
    const built = buildComponentObject(
      comp,
      entry,
      pinPositions,
      routedComponentPose(comp.id) ?? undefined,
    )
    built.object.userData.componentId = comp.id
    enableShadowCasting(built.object)
    // placed parts commit their matrices once (B2); telemetry/param updaters
    // that pose children are followed by a refresh in applyTelemetryAll, and
    // instrument drags updateMatrix the slid root explicitly
    freezeTransforms(built.object)
    m.componentsGroup.add(built.object)
    return { comp, entry, built, signature, attach, posts, slot }
  }

  private removeComponentRecord(m: Mounted, id: string): void {
    const rec = this.components.get(id)
    if (!rec) return
    m.componentsGroup.remove(rec.built.object)
    // only frees per-instance resources — module-cached shared ones are kept
    disposeComponentObject(rec.built.object)
    for (const post of rec.posts) m.terminalsGroup.remove(post) // shared geo/mat — no dispose
    this.components.delete(id)
  }

  private buildWireRecord(
    m: Mounted,
    wire: Wire,
    a: THREE.Vector3,
    b: THREE.Vector3,
    signature: string,
  ): WireRecord {
    // PVC jumper insulation (matches meshes/shared.ts makeWireMaterial spec)
    // but PER-INSTANCE: the scene mutates emissive for selection highlight and
    // disposes it with the wire — shared cached materials would break both.
    const material = new THREE.MeshPhysicalMaterial({
      color: wireColorFor(wire),
      roughness: 0.4,
      metalness: 0.0,
      clearcoat: 0.15,
      clearcoatRoughness: 0.35,
    })
    // PERF (perf/hotspots.md B1): one wire = ONE insulation draw. The two end
    // caps share the tube's material and never move relative to it, so they
    // are BAKED into the tube geometry (identical world-space shape — caps
    // were separate meshes purely for code convenience, at 2 extra draw calls
    // per wire). The up-to-2 bare tinned tip pins share tipMat and merge into
    // one more mesh. 5 draws/objects per wire → 2; merging runs only on
    // layout edits, never per frame.
    const tubeGeo = wireGeometry(a, b, WIRE_RADIUS, wire.id)
    const insulationParts: THREE.BufferGeometry[] = [tubeGeo]
    const tipParts: THREE.BufferGeometry[] = []
    for (const p of [a, b]) {
      // board-hole ends (y = 0) are stripped: the insulation stops
      // WIRE_TIP_LEN up and a bare tinned pin runs down into the socket;
      // terminal-post ends keep the classic insulated cap at the post top
      const stripped = p.y === 0
      const cap = m.capGeo.clone()
      const s = WIRE_RADIUS * 1.15
      cap.scale(s, s, s)
      cap.translate(p.x, stripped ? WIRE_TIP_LEN : p.y, p.z)
      insulationParts.push(cap)
      if (stripped) {
        const pin = m.tipGeo.clone()
        pin.translate(p.x, (WIRE_TIP_LEN - WIRE_TIP_SINK) / 2, p.z)
        tipParts.push(pin)
      }
    }
    const group = new THREE.Group()
    const mergedTube = mergeGeometries(insulationParts)
    let geo: THREE.BufferGeometry
    if (mergedTube) {
      for (const g of insulationParts) g.dispose() // copied into the merge
      geo = mergedTube
      const tube = new THREE.Mesh(geo, material)
      tube.castShadow = true // cast only — wires never receive
      group.add(tube)
    } else {
      // defensive fallback (tube/sphere attribute sets always match, so this
      // is unreachable in practice): legacy per-piece meshes, shared cap geo
      geo = tubeGeo
      for (let i = 1; i < insulationParts.length; i++) insulationParts[i].dispose()
      const tube = new THREE.Mesh(tubeGeo, material)
      tube.castShadow = true
      group.add(tube)
      for (const p of [a, b]) {
        const stripped = p.y === 0
        const cap = new THREE.Mesh(m.capGeo, material)
        cap.scale.setScalar(WIRE_RADIUS * 1.15)
        cap.position.set(p.x, stripped ? WIRE_TIP_LEN : p.y, p.z)
        group.add(cap)
      }
    }
    let tipsGeo: THREE.BufferGeometry | null = null
    if (tipParts.length > 0) {
      const mergedTips = tipParts.length === 1 ? tipParts[0] : mergeGeometries(tipParts)
      if (mergedTips) {
        if (tipParts.length > 1) for (const g of tipParts) g.dispose()
        tipsGeo = mergedTips
        const pins = new THREE.Mesh(tipsGeo, m.tipMat)
        pins.castShadow = true
        group.add(pins)
      } else {
        // unreachable fallback (identical clones always merge): shared geo
        for (const g of tipParts) g.dispose()
        for (const p of [a, b]) {
          if (p.y !== 0) continue
          const pin = new THREE.Mesh(m.tipGeo, m.tipMat)
          pin.castShadow = true
          pin.position.set(p.x, (WIRE_TIP_LEN - WIRE_TIP_SINK) / 2, p.z)
          group.add(pin)
        }
      }
    }
    group.userData.componentId = wire.id
    freezeTransforms(group) // static until this record is rebuilt (B2)
    m.wiresGroup.add(group)
    return { wire, group, signature, geo, tipsGeo, material }
  }

  private removeWireRecord(m: Mounted, id: string): void {
    const rec = this.wires.get(id)
    if (!rec) return
    m.wiresGroup.remove(rec.group)
    rec.geo.dispose()
    rec.tipsGeo?.dispose()
    rec.material.dispose()
    this.wires.delete(id)
  }

  /** World position of a wire endpoint: hole top (y=0) or terminal post top. */
  private resolveEndpoint(ref: string): THREE.Vector3 | null {
    const hole = parseHole(ref)
    if (hole) {
      const p = holePosition(hole)
      return new THREE.Vector3(p.x, 0, p.z)
    }
    const term = parseTerminalRef(ref)
    if (!term) return null
    const rec = this.components.get(term.componentId)
    if (!rec || rec.entry.placement !== 'offboard') return null
    const pinIdx = rec.entry.pins.indexOf(term.pin)
    if (pinIdx < 0) return null
    return rec.attach[pinIdx].clone()
  }

  // -------------------------------------------------------------- telemetry

  private applyTelemetryAll(): void {
    const t = this.telemetry
    for (const [id, rec] of this.components) {
      updateComponentVisual(rec.built, rec.comp, rec.entry, t ? (t.components[id] ?? null) : null)
      // transforms are frozen (B2) and updaters may pose children (button
      // caps, switch levers, pot knobs) — recompose the subtree after each
      // applied update. This runs only on telemetry/layout CHANGES (exactly
      // where auto-update used to pay every frame), never during pure
      // camera motion.
      rec.built.object.traverse(refreshMatrixOf)
    }
  }

  // ------------------------------------------------------------------ ghost

  /** Drop the holographic ghost + pin markers (frees the source build). */
  private clearGhostFx(m: Mounted): void {
    this.ghostSpin = null // any pending spin pivot dies with its hologram
    const fx = this.ghostFx
    if (!fx) return
    this.ghostFx = null
    if (fx.holo) m.overlayGroup.remove(fx.holo)
    // the hologram clone shares the source's geometry — dispose the source
    if (fx.built) disposeComponentObject(fx.built.object)
    fx.markers.dispose()
  }

  /** Quick spring that settles a freshly rotated ghost into place (R cycle). */
  private updateGhostSpin(): void {
    const s = this.ghostSpin
    if (!s) return
    const k = Math.min(1, (performance.now() - s.t0) / GHOST_SPIN_MS)
    s.pivot.rotation.y = s.from * (1 - SPRING_EASE(k))
    if (k >= 1) {
      s.pivot.rotation.y = 0
      this.ghostSpin = null
    }
  }

  /**
   * Holographic placement preview: the ACTUAL part mesh rendered through the
   * hologram material (scanlines + fresnel, cyan-blue valid / red invalid)
   * plus pulsing pin markers on every committed target hole.
   *
   *  - dip/footprint: the package at its anchor, markers on every pin hole.
   *  - routed 2-lead parts (resistor/diode/inductor): after the first pick
   *    the ghost is the FINAL routed pose stretching first-hole → hover
   *    (vertical mount included) via routeOne; before the first pick a
   *    default-span pose previews at the hover hole.
   *  - other leads/probe parts: the part spanning picked + hovered holes
   *    (remaining pins inferred rightward), markers on the real targets only.
   */
  private syncGhost(): void {
    const m = this.m
    if (!m) return
    const g = this.ghost
    if (!g) {
      this.clearGhostFx(m)
      this.lastGhostKey = ''
      this.lastGhostRotation = 0
      return
    }
    const entry = getEntry(g.type)
    const at = parseHole(g.at)
    if (!entry || !at || entry.placement === 'offboard') {
      this.clearGhostFx(m)
      return
    }

    const config = boardConfigOf(this.layout) // packages must fit the ACTIVE rig
    const picked = g.picked ?? []
    // armed in-plane rotation (dip/footprint; hardened against bad values)
    const rotation: Rotation = isRotation(g.rotation) ? g.rotation : 0
    const isPackage = entry.placement === 'dip' || entry.placement === 'footprint'
    const key = `${g.type}|${g.at}|${picked.join(',')}`
    const sig =
      `${key}|${g.valid}|r${rotation}` +
      `|${planVersion()}|${config.size}x${config.count}x${config.rows ?? 1}`
    if (this.ghostFx?.sig === sig) return
    const prevKey = this.lastGhostKey
    const prevRotation = this.lastGhostRotation
    this.lastGhostKey = key
    this.lastGhostRotation = rotation
    this.clearGhostFx(m)

    const variant: HologramVariant = g.valid ? 'valid' : 'invalid'
    const atP = holePosition(at)

    // pin world positions for the build + marker positions (real targets only)
    let pins: THREE.Vector3[] | null = null
    let markerPts: { x: number; y: number; z: number }[]
    let routed: RoutedComponent | undefined
    /** plan point the rotation spin pivots around (packages only) */
    let spinPivot: { x: number; z: number } | null = null

    if (isPackage) {
      const hs =
        entry.placement === 'dip'
          ? dipHoles(at, entry.pins.length, config, rotation)
          : entry.footprintOffsets
            ? footprintHoles(at, entry.footprintOffsets, config, rotation)
            : null
      if (hs) {
        const pts = hs.map(holePosition)
        pins = pts.map((p) => new THREE.Vector3(p.x, 0, p.z))
        markerPts = pts.map((p) => ({ x: p.x, y: 0, z: p.z }))
        // spin pivot: a DIP occupies the same holes at 180 → its hole-bbox
        // center is rotation-invariant; footprints rotate around pin 1 (at)
        if (entry.placement === 'dip') {
          let minX = Infinity
          let maxX = -Infinity
          let minZ = Infinity
          let maxZ = -Infinity
          for (const p of pts) {
            if (p.x < minX) minX = p.x
            if (p.x > maxX) maxX = p.x
            if (p.z < minZ) minZ = p.z
            if (p.z > maxZ) maxZ = p.z
          }
          spinPivot = { x: (minX + maxX) / 2, z: (minZ + maxZ) / 2 }
        } else {
          spinPivot = { x: atP.x, z: atP.z }
        }
      } else {
        markerPts = [{ x: atP.x, y: 0, z: atP.z }] // anchor invalid for the package
      }
    } else {
      // leads / probe parts: picked holes first, the hover hole next, any
      // remaining pins inferred one column to the right per pin
      const pickedPts = picked
        .map(parseHole)
        .filter((h): h is Hole => h !== null)
        .map(holePosition)
      markerPts = [...pickedPts, atP].map((p) => ({ x: p.x, y: 0, z: p.z }))
      if (routedBodyFor(g.type) && entry.pins.length === 2) {
        const a = pickedPts[0] ?? atP
        const b =
          pickedPts.length >= 1 ? atP : { x: atP.x + GHOST_DEFAULT_SPAN, z: atP.z }
        if (Math.hypot(b.x - a.x, b.z - a.z) > 1e-6) {
          routed = previewComponentPose(g.type, a, b) ?? undefined
          pins = [new THREE.Vector3(a.x, 0, a.z), new THREE.Vector3(b.x, 0, b.z)]
        }
        // a == b (hovering the already-picked hole): marker only, no hologram
      } else {
        pins = []
        for (let i = 0; i < entry.pins.length; i++) {
          const p =
            i < pickedPts.length
              ? pickedPts[i]
              : i === pickedPts.length
                ? atP
                : { x: atP.x + (i - pickedPts.length), z: atP.z }
          pins.push(new THREE.Vector3(p.x, 0, p.z))
        }
      }
    }

    let holo: THREE.Object3D | null = null
    let built: BuiltComponent | null = null
    if (pins) {
      const ghostComp: ComponentInstance =
        rotation !== 0
          ? { id: '__ghost__', type: g.type, rotation }
          : { id: '__ghost__', type: g.type }
      built = buildComponentObject(ghostComp, entry, pins, routed)
      holo = applyHologram(built.object, variant)
      // R-key / rotate-button cycle on the SAME armed ghost: spring the
      // hologram from its previous orientation into the new one (clockwise
      // plan rotation = negative yaw, so the pivot un-rotates from +delta)
      const spinDelta = (((rotation - prevRotation) % 360) + 360) % 360
      if (spinPivot && key === prevKey && spinDelta !== 0 && !m.reduced) {
        const pivot = new THREE.Group()
        pivot.name = 'ghost-spin-pivot'
        pivot.position.set(spinPivot.x, 0, spinPivot.z)
        holo.position.set(-spinPivot.x, 0, -spinPivot.z)
        pivot.add(holo)
        const from = THREE.MathUtils.degToRad(spinDelta)
        pivot.rotation.y = from
        this.ghostSpin = { pivot, from, t0: performance.now() }
        holo = pivot
      }
      m.overlayGroup.add(holo)
    }
    const markers = makePinMarkers(markerPts, pins ? variant : 'invalid')
    m.overlayGroup.add(markers.group)
    this.ghostFx = { holo, built, markers, sig }
  }

  // -------------------------------------------------------------- selection

  private clearSelectionHighlights(): void {
    for (const [mat, saved] of this.savedEmissive) {
      mat.emissive.setHex(saved.color)
      mat.emissiveIntensity = saved.intensity
    }
    this.savedEmissive.clear()
    for (const box of this.selectionBoxes) box.removeFromParent()
    this.selectionBoxes.length = 0
  }

  /**
   * Component meshes share module-cached materials across instances, so they
   * are highlighted with a translucent overlay box (never by mutating their
   * materials). Wire materials are per-instance and scene-owned, so wires get
   * a precise emissive tint instead of a (potentially huge) bounding box.
   */
  private applySelection(): void {
    const hadWireTint = this.savedEmissive.size > 0
    this.clearSelectionHighlights()
    const m = this.m
    if (!m) return
    for (const id of this.selectedIds) {
      const compRec = this.components.get(id)
      if (compRec) {
        this.addSelectionBox(m, compRec.built.object)
        continue
      }
      const wireRec = this.wires.get(id)
      if (wireRec) {
        const mat = wireRec.material
        if (!this.savedEmissive.has(mat)) {
          this.savedEmissive.set(mat, {
            color: mat.emissive.getHex(),
            intensity: mat.emissiveIntensity,
          })
        }
        mat.emissive.setHex(SELECT_EMISSIVE)
        mat.emissiveIntensity = SELECT_INTENSITY
      }
    }
    // wire selection tints REAL (path-traced) materials; component selection
    // boxes live in the overlay (raster-composited) and need nothing
    if (hadWireTint || this.savedEmissive.size > 0) this.materialsRefreshPending = true
  }

  private addSelectionBox(m: Mounted, obj: THREE.Object3D): void {
    const box = new THREE.Box3().setFromObject(obj)
    if (box.isEmpty()) return
    const size = box.getSize(new THREE.Vector3())
    const center = box.getCenter(new THREE.Vector3())
    const mesh = new THREE.Mesh(m.selBoxGeo, m.selBoxMat)
    mesh.position.copy(center)
    mesh.scale.set(size.x + SELECT_BOX_PAD, size.y + SELECT_BOX_PAD, size.z + SELECT_BOX_PAD)
    mesh.renderOrder = 2
    mesh.updateMatrix() // static until the selection changes (B2)
    mesh.matrixAutoUpdate = false
    m.overlayGroup.add(mesh)
    this.selectionBoxes.push(mesh)
  }

  // ----------------------------------------------------------- wire preview

  private syncWirePreview(): void {
    const m = this.m
    if (!m) return
    if (m.previewMesh) {
      m.overlayGroup.remove(m.previewMesh)
      ;(m.previewMesh.geometry as THREE.BufferGeometry).dispose()
      m.previewMesh = null
    }
    const { from, to } = this.preview
    if (!from || !to) return
    const a = this.resolveEndpoint(from)
    const toHole = parseHole(to)
    if (!a || !toHole) return
    const pb = holePosition(toHole)
    const b = new THREE.Vector3(pb.x, 0, pb.z)
    // the preview IS the final path: routeOne against the planned world
    const mesh = new THREE.Mesh(previewWireGeometry(a, b, PREVIEW_RADIUS), m.previewMat)
    mesh.renderOrder = 3
    m.overlayGroup.add(mesh)
    m.previewMesh = mesh
  }

  // ---------------------------------------------------------------- picking

  private updateNdc(e: PointerEvent): void {
    const m = this.m
    if (!m) return
    const rect = m.renderer.domElement.getBoundingClientRect()
    if (rect.width < 1 || rect.height < 1) return
    this.pointerNdc.x = ((e.clientX - rect.left) / rect.width) * 2 - 1
    this.pointerNdc.y = -((e.clientY - rect.top) / rect.height) * 2 + 1
  }

  /** Intersect the raycaster's current ray with the board plane (y = 0). */
  private rayToPlane(out: THREE.Vector3): boolean {
    const ray = this.raycaster.ray
    if (Math.abs(ray.direction.y) < 1e-9) return false
    const t = -ray.origin.y / ray.direction.y
    if (t <= 0) return false
    out.set(ray.origin.x + ray.direction.x * t, 0, ray.origin.z + ray.direction.z * t)
    return true
  }

  /** Snap the pointer ray's board-plane point to the nearest hole within maxDist. */
  private pickHole(maxDist: number): HoleRef | null {
    if (!this.rayToPlane(this.tmpVecA)) return null
    return this.holeIndex.nearest(this.tmpVecA.x, this.tmpVecA.z, maxDist)
  }

  /** Component/wire id under the pointer (sets the raycaster itself). */
  private pickObjectIdAtPointer(): string | null {
    return this.raycastRoots(this.m?.objectPickRoots ?? null, this.pointerNdc)?.componentId ?? null
  }

  /** One raycast at `ndc` against `roots` → terminalRef / componentId of the first hit. */
  private raycastRoots(
    roots: THREE.Object3D[] | null,
    ndc: THREE.Vector2,
  ): { terminalRef?: string; componentId?: string } | null {
    const m = this.m
    if (!m || !roots) return null
    this.raycaster.setFromCamera(ndc, m.camera)
    this.hitBuf.length = 0
    const hits = this.raycaster.intersectObjects(roots, true, this.hitBuf)
    for (const hit of hits) {
      let o: THREE.Object3D | null = hit.object
      while (o) {
        const ref = o.userData.terminalRef
        if (typeof ref === 'string') return { terminalRef: ref }
        const id = o.userData.componentId
        if (typeof id === 'string') return { componentId: id }
        o = o.parent
      }
    }
    return null
  }

  /**
   * Nearest off-board terminal post to the pointer in SCREEN space (px).
   * Posts can be a couple of px wide at the fit-to-board zoom, so ray
   * sampling can slip past them — projecting the post tops is exact.
   */
  private pickTerminalNearPointer(slopPx: number, only?: ComponentRecord): string | null {
    const m = this.m
    if (!m) return null
    const rect = m.renderer.domElement.getBoundingClientRect()
    if (rect.width < 1 || rect.height < 1) return null
    const px = ((this.pointerNdc.x + 1) / 2) * rect.width
    const py = ((1 - this.pointerNdc.y) / 2) * rect.height
    let bestD2 = Number.isFinite(slopPx) ? slopPx * slopPx : Infinity
    let best: string | null = null
    for (const rec of only ? [only] : this.components.values()) {
      for (let i = 0; i < rec.posts.length; i++) {
        const ref = rec.posts[i].userData.terminalRef
        if (typeof ref !== 'string') continue
        this.tmpVecB.copy(rec.attach[i]).project(m.camera)
        if (this.tmpVecB.z > 1) continue // behind the camera
        const dx = ((this.tmpVecB.x + 1) / 2) * rect.width - px
        const dy = ((1 - this.tmpVecB.y) / 2) * rect.height - py
        const d2 = dx * dx + dy * dy
        if (d2 < bestD2) {
          bestD2 = d2
          best = ref
        }
      }
    }
    return best
  }

  /**
   * Touch-slop pick (DESIGN.md §4 44px targets): the exact ray first, then
   * rings of offset rays out to slopPx, nearest ring first — wires/posts are
   * a few px wide on screen, far too thin for a fingertip. Touch taps and
   * long-presses only; mouse picking stays pixel-exact.
   */
  private pickWithSlop(
    roots: THREE.Object3D[],
    slopPx: number,
  ): { terminalRef?: string; componentId?: string } | null {
    const m = this.m
    if (!m) return null
    const rect = m.renderer.domElement.getBoundingClientRect()
    if (rect.width < 1 || rect.height < 1) return null
    const direct = this.raycastRoots(roots, this.pointerNdc)
    if (direct) return direct
    for (const [r, n] of SLOP_RINGS) {
      if (r > slopPx) break
      for (let i = 0; i < n; i++) {
        const a = (2 * Math.PI * i) / n
        this.tmpNdc.set(
          this.pointerNdc.x + (2 * r * Math.cos(a)) / rect.width,
          this.pointerNdc.y + (2 * r * Math.sin(a)) / rect.height,
        )
        const hit = this.raycastRoots(roots, this.tmpNdc)
        if (hit) return hit
      }
    }
    return null
  }

  /**
   * Candidate target for the fingertip ghost-cursor. Screen-space "up" is
   * mapped onto the board by unprojecting a point FINGERTIP_PROBE_PX above the
   * touch onto y = 0; the aim point is the touch's own plane point pushed
   * FINGERTIP_OFFSET_UNITS along that direction (clamped to a finger-sized
   * screen offset so the ring stays visible at any zoom), then snapped to the
   * nearest board hole — or, while wiring, the nearest off-board terminal
   * post. Side effects: fingertipHasPoint/fingertipPoint.
   */
  private pickFingertipTarget(): FingertipTarget | null {
    this.fingertipHasPoint = false
    const m = this.m
    if (!m) return null
    this.raycaster.setFromCamera(this.pointerNdc, m.camera)
    if (!this.rayToPlane(this.tmpVecA)) return null
    const rect = m.renderer.domElement.getBoundingClientRect()
    const dNdcY = rect.height >= 1 ? (2 * FINGERTIP_PROBE_PX) / rect.height : 0.06
    this.tmpNdc.set(this.pointerNdc.x, this.pointerNdc.y + dNdcY)
    this.raycaster.setFromCamera(this.tmpNdc, m.camera)
    this.fingertipPoint.copy(this.tmpVecA)
    if (this.rayToPlane(this.tmpVecB)) {
      this.tmpVecB.sub(this.tmpVecA) // plane direction of "screen up"
      this.tmpVecB.y = 0
      const len = this.tmpVecB.length() // plan-units per FINGERTIP_PROBE_PX
      if (len > 1e-6) {
        const unitsPerPx = len / FINGERTIP_PROBE_PX
        const offsetUnits = Math.min(
          Math.max(FINGERTIP_OFFSET_UNITS, FINGERTIP_OFFSET_MIN_PX * unitsPerPx),
          FINGERTIP_OFFSET_MAX_PX * unitsPerPx,
        )
        this.fingertipPoint.addScaledVector(this.tmpVecB, offsetUnits / len)
      }
    } // else: probe ray missed the plane (grazing camera) — aim at the raw point
    this.fingertipHasPoint = true
    const ax = this.fingertipPoint.x
    const az = this.fingertipPoint.z

    const hole = this.holeIndex.nearest(ax, az, HOLE_SNAP_DIST_TOUCH)
    let holeD2 = Infinity
    if (hole) {
      const h = parseHole(hole)
      if (h) {
        const p = holePosition(h)
        holeD2 = (p.x - ax) * (p.x - ax) + (p.z - az) * (p.z - az)
      }
    }

    // off-board terminal posts are wire endpoints too — the aim ring must be
    // able to land on them while wiring (they are never placement targets)
    if (this.isWireAiming()) {
      let bestD2 = TERMINAL_SNAP_DIST_TOUCH * TERMINAL_SNAP_DIST_TOUCH
      let best: FingertipTarget | null = null
      for (const rec of this.components.values()) {
        for (let i = 0; i < rec.posts.length; i++) {
          const ref = rec.posts[i].userData.terminalRef
          if (typeof ref !== 'string') continue
          const p = rec.attach[i]
          const d2 = (p.x - ax) * (p.x - ax) + (p.z - az) * (p.z - az)
          if (d2 < bestD2) {
            bestD2 = d2
            best = { kind: 'terminal', ref, x: p.x, z: p.z }
          }
        }
      }
      if (best && bestD2 <= holeD2) return best
    }
    return hole ? { kind: 'hole', hole } : null
  }

  /** Hover pass — runs at most once per animation frame, only when the pointer moved. */
  private processHover(m: Mounted): void {
    // an in-flight editing drag owns the pointer — its own handlers track it
    if (this.moveDrag?.started || this.instDrag?.started || this.marquee?.started) return
    // touch aiming (place/wire): the fingertip ghost-cursor drives hover
    if (this.activeTouchId !== null && this.isPlaceOrWireMode()) {
      this.processFingertip(m)
      return
    }
    m.fingertipGroup.visible = false

    const t = m.clock.getElapsedTime()
    this.raycaster.setFromCamera(this.pointerNdc, m.camera)
    const snap = this.lastPointerType === 'touch' ? HOLE_SNAP_DIST_TOUCH : HOLE_SNAP_DIST
    const holeRef = this.pickHole(snap)
    if (holeRef !== this.lastHoverHole) {
      this.lastHoverHole = holeRef
      if (holeRef) {
        const h = parseHole(holeRef)
        if (h) {
          const p = holePosition(h)
          // occluded hole (covered by a component body): NO hover ring — the
          // coordinate chip alone shows the ref in red with a lock glyph
          const blocked = this.occluded.has(holeRef)
          if (blocked) {
            m.hoverRing.hide(t)
          } else {
            // glow ring + coordinate chip follow the hovered hole (pooled —
            // setText only redraws when the ref actually changed)
            m.hoverRing.object.position.set(p.x, HOVER_RING_LIFT, p.z)
            m.hoverRing.show(t)
          }
          m.holeLabel.setLocked(blocked)
          m.holeLabel.setText(holeRef)
          m.holeLabel.object.position.set(p.x, HOLE_LABEL_Y, p.z)
          m.holeLabel.show()
        }
      } else {
        m.hoverRing.hide(t)
        if (this.labelPinnedUntil <= performance.now()) m.holeLabel.hide()
      }
      this.callbacks.onHoleHover?.(holeRef)
    }

    if (this.lastPointerType === 'touch') {
      m.container.style.cursor = '' // no cursor to style — skip the object raycast
      return
    }
    // grow-paddle hover highlight (progressive enhancement, mouse only);
    // hovering the + plate reveals its "−" chip, which keeps the paddle in
    // hover state while the pointer moves down onto it
    const paddle = this.pickPaddle(m)
    this.paddleHover = paddle?.rec.dir ?? null
    this.paddleMinusHover = paddle?.minus ? paddle.rec.dir : null
    if (paddle) {
      m.container.style.cursor = 'pointer'
      return
    }
    this.hitBuf.length = 0
    const hits = this.raycaster.intersectObjects(m.hoverPickRoots, true, this.hitBuf)
    m.container.style.cursor = hits.length > 0 ? 'pointer' : ''
  }

  /**
   * Fingertip pass: the cursor floats toward the top of the screen from the
   * touched point and snaps to the candidate target — the snapped hole (not
   * the raw touch point) is what onHoleHover reports; a snapped terminal post
   * shows the ring on the post (terminals have no hover callback).
   */
  private processFingertip(m: Mounted): void {
    const target = this.pickFingertipTarget()
    if (!this.fingertipHasPoint) {
      m.fingertipGroup.visible = false
      m.holeLabel.hide()
      if (this.lastHoverHole !== null) {
        this.lastHoverHole = null
        this.callbacks.onHoleHover?.(null)
      }
      return
    }
    let px = this.fingertipPoint.x
    let pz = this.fingertipPoint.z
    let py = 0.1
    let hole: HoleRef | null = null
    if (target?.kind === 'hole') {
      hole = target.hole
      const h = parseHole(hole)
      if (h) {
        const p = holePosition(h)
        px = p.x
        pz = p.z
      }
    } else if (target) {
      px = target.x
      pz = target.z
      py = TERMINAL_TOP_Y + 0.05 // ring sits on the post top
    }
    m.fingertipGroup.position.set(px, py, pz)
    m.fingertipGroup.visible = true
    // dim the cursor when it has nothing to snap to
    m.fingertipRingMat.opacity = target ? 0.95 : 0.45
    m.fingertipGlowMat.opacity = target ? 0.3 : 0.15
    m.fingertipCrossMat.opacity = target ? 0.9 : 0.5
    m.hoverRing.hide(m.clock.getElapsedTime())
    // the coordinate chip rides above the aim ring showing the snapped ref
    // (occluded holes read red + locked — the lift commit will be rejected)
    if (hole) {
      m.holeLabel.setLocked(this.occluded.has(hole))
      m.holeLabel.setText(hole)
      m.holeLabel.object.position.set(px, py + FINGERTIP_LABEL_Y, pz)
      m.holeLabel.show()
    } else {
      m.holeLabel.hide()
    }
    m.container.style.cursor = ''
    if (hole !== this.lastHoverHole) {
      this.lastHoverHole = hole
      this.callbacks.onHoleHover?.(hole)
    }
  }

  // ------------------------------------------------- touch gestures & camera

  /** place/wire = touch aiming mode (fingertip cursor; one-finger aims, not orbits) */
  private isPlaceOrWireMode(): boolean {
    if (this.explicitMode !== null) return this.explicitMode !== 'select'
    return this.ghost !== null || this.preview.from !== null
  }

  /** wire mode specifically — terminal posts are valid endpoints only here */
  private isWireAiming(): boolean {
    if (this.explicitMode !== null) return this.explicitMode === 'wire'
    return this.ghost === null && this.preview.from !== null
  }

  /**
   * One-finger touch: orbit normally; while place/wire aiming is active it is
   * handed to the fingertip cursor instead (OrbitControls treats a null
   * touches.ONE as "no gesture"). Two-finger dolly/pan always works.
   */
  private updateTouchGestures(): void {
    const m = this.m
    if (!m) return
    m.controls.touches.ONE = this.isPlaceOrWireMode() ? null : THREE.TOUCH.ROTATE
  }

  // ------------------------------------------------ editing drags (select mode)
  //
  // GESTURE DECISION (documented per the task spec): in select mode a
  // one-finger / left-button drag that STARTS on an already-SELECTED part is
  // a MOVE gesture, never an orbit — selecting a part is the explicit "I want
  // to manipulate this" signal, and grabbing the selected thing should move
  // it (iOS drag-and-drop semantics); orbit stays available everywhere else
  // on the canvas, so nothing is lost. Touch and mouse behave identically.
  // OrbitControls is suspended at pointerdown (its pointermove handler checks
  // `enabled` per event, and its pointerup always releases the pointer, so a
  // mid-gesture disable is safe) and restored when the gesture ends.
  //
  // Desktop shift+drag on EMPTY board = marquee selection. The rectangle is a
  // screen-space overlay <div> (not an in-scene mesh) because (a) the hit
  // test is itself screen-space — "parts whose centers PROJECT inside" — so
  // the visual and the test can never disagree, (b) it costs zero GPU work
  // and no scene-graph churn, and (c) the scene already owns DOM (the
  // renderer canvas), so no new React plumbing is needed.

  /** Force-disable orbiting for the duration of an editing drag. */
  private suspendControls(m: Mounted, e: PointerEvent): void {
    if (!this.controlsSuspended) {
      this.controlsSuspended = true
      m.controls.enabled = false
    }
    try {
      m.renderer.domElement.setPointerCapture(e.pointerId)
    } catch {
      /* pointer already gone — the drag will just end on the next event */
    }
  }

  private restoreControls(): void {
    if (this.controlsSuspended && this.m) this.m.controls.enabled = true
    this.controlsSuspended = false
  }

  /**
   * Pointerdown in select mode: arm a move-drag (selected part), an
   * instrument bench drag (selected off-board unit) or a shift+drag marquee.
   * Armed drags only START once the pointer travels DRAG_START_PX — a tap
   * stays a tap.
   */
  private maybeBeginEditDrag(e: PointerEvent, picked: string | null): void {
    const m = this.m
    if (!m || this.moveDrag || this.instDrag || this.marquee) return
    if (this.isPlaceOrWireMode()) return

    // shift+drag on empty board (desktop mouse) = marquee rectangle
    if (picked === null && e.shiftKey && e.pointerType === 'mouse') {
      this.raycaster.setFromCamera(this.pointerNdc, m.camera)
      if (this.pickPaddle(m)) return
      this.hitBuf.length = 0
      if (this.raycaster.intersectObjects(m.terminalsGroup.children, false, this.hitBuf).length > 0)
        return
      this.marquee = {
        startX: e.clientX,
        startY: e.clientY,
        curX: e.clientX,
        curY: e.clientY,
        el: null,
        started: false,
      }
      this.suspendControls(m, e)
      return
    }

    if (picked === null || !this.selectedIds.includes(picked)) return
    const rec = this.components.get(picked)
    if (!rec) return // a selected WIRE was grabbed — wires stay put; orbit instead
    this.raycaster.setFromCamera(this.pointerNdc, m.camera)
    if (!this.rayToPlane(this.tmpVecA)) return

    // selected off-board instrument → bench drag (0.5-grid, validity tint)
    if (rec.entry.placement === 'offboard') {
      const origin = rec.comp.pos ?? offboardBodyPosition(rec.slot)
      this.instDrag = {
        id: picked,
        origin: { x: origin.x, z: origin.z },
        grab: this.tmpVecA.clone(),
        started: false,
        pos: { x: origin.x, z: origin.z },
        valid: true,
        postBase: rec.posts.map((p) => p.position.clone()),
        tint: null,
        tintMat: null,
        tintBase: new THREE.Vector3(),
      }
      this.suspendControls(m, e)
      return
    }

    // selected on-board part(s) → move gesture. The whole selected group of
    // on-board components moves together (wires always stay put).
    const ids = this.selectedIds.filter((id) => {
      const r = this.components.get(id)
      return !!r && r.entry.placement !== 'offboard'
    })
    if (ids.length === 0) return

    // anchor form: exactly ONE moved part and it is a dip/footprint package
    // (free re-anchor — may hop rows/board-rows); everything else translates
    // by whole columns + strip-row-lattice steps (delta form)
    let anchor: MoveDrag['anchor'] = null
    if (ids.length === 1) {
      const only = this.components.get(ids[0])
      if (
        only &&
        (only.entry.placement === 'dip' || only.entry.placement === 'footprint') &&
        only.comp.at
      ) {
        const ah = parseHole(only.comp.at)
        if (ah) {
          const p = holePosition(ah)
          anchor = { pos: { x: p.x, z: p.z } }
        }
      }
    }
    let ref: MoveDrag['ref'] = null
    if (!anchor) {
      const config = boardConfigOf(this.layout)
      refSearch: for (const id of ids) {
        const r = this.components.get(id)
        if (!r) continue
        const holes = componentPinHoles(r.comp, r.entry, config)
        if (!holes) continue
        for (const h of holes) {
          if (h && h.kind === 'strip') {
            const p = holePosition(h)
            ref = {
              col: h.col,
              rowIdx: STRIP_ROWS.indexOf(h.row),
              boardRow: h.boardRow ?? 0,
              x: p.x,
              z: p.z,
            }
            break refSearch
          }
        }
      }
    }
    this.moveDrag = {
      ids,
      grab: this.tmpVecA.clone(),
      anchor,
      ref,
      started: false,
      target: null,
      valid: false,
      holo: null,
      holoVariant: 'valid',
    }
    this.suspendControls(m, e)
  }

  /** Per-pointermove drive of whichever editing drag is armed/running. */
  private updateEditDrags(e: PointerEvent, drift: number): void {
    const m = this.m
    if (!m) return
    const startPx = e.pointerType === 'touch' ? DRAG_START_PX_TOUCH : DRAG_START_PX
    if (this.marquee) {
      this.marquee.curX = e.clientX
      this.marquee.curY = e.clientY
      if (!this.marquee.started && drift > startPx) {
        this.marquee.started = true
        this.cancelLongPress()
      }
      if (this.marquee.started) this.updateMarqueeEl()
      return
    }
    if (this.moveDrag) {
      if (!this.moveDrag.started && drift > startPx) {
        this.moveDrag.started = true
        this.cancelLongPress()
        this.buildMoveHolo(m)
      }
      if (this.moveDrag.started) this.updateMoveDrag(m)
      return
    }
    if (this.instDrag) {
      if (!this.instDrag.started && drift > startPx) {
        this.instDrag.started = true
        this.cancelLongPress()
        this.buildInstTint(m)
      }
      if (this.instDrag.started) this.updateInstDrag(m)
    }
  }

  /** Group hologram of the moved part(s) — geometry shared with the live meshes. */
  private buildMoveHolo(m: Mounted): void {
    const d = this.moveDrag
    if (!d || d.holo) return
    const group = new THREE.Group()
    group.name = 'move-drag-holo'
    for (const id of d.ids) {
      const rec = this.components.get(id)
      if (rec) group.add(applyHologram(rec.built.object, 'valid'))
    }
    d.holoVariant = 'valid'
    m.overlayGroup.add(group)
    d.holo = group
  }

  /** Swap the move hologram's cyan/red tint (cached materials — no compiles). */
  private setMoveHoloVariant(d: MoveDrag, variant: HologramVariant): void {
    if (!d.holo || d.holoVariant === variant) return
    d.holoVariant = variant
    const mat = makeHologramMaterial(variant)
    d.holo.traverse((o) => {
      const mesh = o as THREE.Mesh
      if (mesh.isMesh) mesh.material = mat
    })
  }

  /**
   * Track the move-drag: snap the candidate target on the hole lattice,
   * re-validate through onMovePreview only when the SNAPPED target changes,
   * and float the group hologram at the implied plan offset.
   */
  private updateMoveDrag(m: Mounted): void {
    const d = this.moveDrag
    if (!d) return
    this.raycaster.setFromCamera(this.pointerNdc, m.camera)
    if (!this.rayToPlane(this.tmpVecA)) return
    const dx = this.tmpVecA.x - d.grab.x
    const dz = this.tmpVecA.z - d.grab.z

    let target: SceneMoveTarget | null = null
    let planDx = dx
    let planDz = dz
    if (d.anchor) {
      // single package: re-anchor pin 1 to the nearest hole under the drag
      const hole = this.holeIndex.nearest(
        d.anchor.pos.x + dx,
        d.anchor.pos.z + dz,
        MOVE_ANCHOR_SNAP,
      )
      if (hole) {
        const h = parseHole(hole)
        if (h) {
          const p = holePosition(h)
          target = { anchor: hole }
          planDx = p.x - d.anchor.pos.x
          planDz = p.z - d.anchor.pos.z
        }
      }
      // no hole in range: the hologram tracks the raw drag, tinted invalid
    } else {
      // group / leads: whole-column + strip-row-lattice translation, snapped
      // against the reference pin (rail-only selections translate columns)
      const dCol = Math.round(dx)
      let dRowLattice = 0
      planDx = dCol
      planDz = 0
      if (d.ref) {
        const rowOffset = d.ref.boardRow * BOARD_ROW_PITCH
        const targetZ = d.ref.z + dz
        let best = d.ref.rowIdx
        let bestErr = Infinity
        for (let i = 0; i < STRIP_ROWS.length; i++) {
          const err = Math.abs(ROW_Z[STRIP_ROWS[i]] + rowOffset - targetZ)
          if (err < bestErr) {
            bestErr = err
            best = i
          }
        }
        dRowLattice = best - d.ref.rowIdx
        planDz = ROW_Z[STRIP_ROWS[best]] - ROW_Z[STRIP_ROWS[d.ref.rowIdx]]
      }
      target = { dCol, dRowLattice }
    }

    const targetKey = JSON.stringify(target)
    if (targetKey !== JSON.stringify(d.target)) {
      d.target = target
      d.valid =
        target === null
          ? false
          : 'dCol' in target && target.dCol === 0 && target.dRowLattice === 0
            ? true // resting at the origin — dropping is a no-op, not an error
            : (this.callbacks.onMovePreview?.(d.ids, target) ?? true)
      this.setMoveHoloVariant(d, d.valid ? 'valid' : 'invalid')
    }
    d.holo?.position.set(planDx, 0, planDz)
  }

  /** Validity tint box over a dragged instrument's enclosure. */
  private buildInstTint(m: Mounted): void {
    const d = this.instDrag
    if (!d || d.tint) return
    const rec = this.components.get(d.id)
    if (!rec) return
    const rect = offboardBodyRect(rec.slot, rec.comp.pos)
    const mat = new THREE.MeshBasicMaterial({
      color: DRAG_TINT_VALID,
      transparent: true,
      opacity: 0.22,
      depthWrite: false,
    })
    const mesh = new THREE.Mesh(m.selBoxGeo, mat)
    const height = 4.2 // covers the ~4-unit enclosure + posts
    d.tintBase.set((rect.minX + rect.maxX) / 2, height / 2 - 0.1, (rect.minZ + rect.maxZ) / 2)
    mesh.position.copy(d.tintBase)
    mesh.scale.set(rect.maxX - rect.minX + 0.4, height, rect.maxZ - rect.minZ + 0.4)
    mesh.renderOrder = 2
    m.overlayGroup.add(mesh)
    d.tint = mesh
    d.tintMat = mat
  }

  /**
   * Track the instrument drag: snap the bench anchor to the 0.5 grid, ask the
   * host for validity, slide the real unit + posts by the offset (wires lag
   * until the commit replans them) and tint the overlay box.
   */
  private updateInstDrag(m: Mounted): void {
    const d = this.instDrag
    if (!d) return
    this.raycaster.setFromCamera(this.pointerNdc, m.camera)
    if (!this.rayToPlane(this.tmpVecA)) return
    const snap = (v: number) => Math.round(v / INSTRUMENT_GRID) * INSTRUMENT_GRID
    const x = snap(d.origin.x + this.tmpVecA.x - d.grab.x)
    const z = snap(d.origin.z + this.tmpVecA.z - d.grab.z)
    if (x === d.pos.x && z === d.pos.z) return
    d.pos = { x, z }
    d.valid = this.callbacks.onInstrumentMovePreview?.(d.id, d.pos) ?? true
    d.tintMat?.color.setHex(d.valid ? DRAG_TINT_VALID : DRAG_TINT_INVALID)
    const ox = x - d.origin.x
    const oz = z - d.origin.z
    const rec = this.components.get(d.id)
    if (rec) {
      rec.built.object.position.set(ox, 0, oz)
      rec.built.object.updateMatrix() // frozen (B2) — commit the slide
      for (let i = 0; i < rec.posts.length && i < d.postBase.length; i++) {
        rec.posts[i].position.set(d.postBase[i].x + ox, d.postBase[i].y, d.postBase[i].z + oz)
        rec.posts[i].updateMatrix()
      }
    }
    d.tint?.position.set(d.tintBase.x + ox, d.tintBase.y, d.tintBase.z + oz)
    m.renderer.shadowMap.needsUpdate = true // the unit's casters moved
  }

  /** Restore the dragged instrument's real meshes to their record positions. */
  private resetInstDragVisuals(m: Mounted, d: InstrumentDrag): void {
    const rec = this.components.get(d.id)
    if (rec) {
      rec.built.object.position.set(0, 0, 0)
      rec.built.object.updateMatrix() // frozen (B2)
      for (let i = 0; i < rec.posts.length && i < d.postBase.length; i++) {
        rec.posts[i].position.copy(d.postBase[i])
        rec.posts[i].updateMatrix()
      }
    }
    if (d.tint) {
      m.overlayGroup.remove(d.tint)
      d.tintMat?.dispose()
      d.tint = null
      d.tintMat = null
    }
    m.renderer.shadowMap.needsUpdate = true
    // Studio: the unit's REAL meshes were slid around during the drag — make
    // sure the still rebuilds even when the drop was cancelled (a committed
    // drop reroutes the layout and re-invalidates via syncLayout anyway)
    this.modes.invalidate()
  }

  /** Screen-space marquee rectangle (lazy overlay div, fixed positioning). */
  private updateMarqueeEl(): void {
    const mq = this.marquee
    if (!mq || typeof document === 'undefined') return
    if (!mq.el) {
      const el = document.createElement('div')
      el.style.position = 'fixed'
      el.style.border = '1px solid rgba(10,132,255,0.95)'
      el.style.background = 'rgba(10,132,255,0.14)'
      el.style.borderRadius = '3px'
      el.style.pointerEvents = 'none'
      el.style.zIndex = '5'
      document.body.appendChild(el)
      mq.el = el
    }
    mq.el.style.left = `${Math.min(mq.startX, mq.curX)}px`
    mq.el.style.top = `${Math.min(mq.startY, mq.curY)}px`
    mq.el.style.width = `${Math.abs(mq.curX - mq.startX)}px`
    mq.el.style.height = `${Math.abs(mq.curY - mq.startY)}px`
  }

  /** Components + wires whose screen-projected centers fall inside the marquee. */
  private computeMarqueeIds(m: Mounted, mq: MarqueeDrag): string[] {
    const rect = m.renderer.domElement.getBoundingClientRect()
    const x0 = Math.min(mq.startX, mq.curX)
    const x1 = Math.max(mq.startX, mq.curX)
    const y0 = Math.min(mq.startY, mq.curY)
    const y1 = Math.max(mq.startY, mq.curY)
    const ids: string[] = []
    const box = new THREE.Box3()
    const center = new THREE.Vector3()
    m.camera.updateMatrixWorld()
    const test = (id: string, obj: THREE.Object3D): void => {
      box.setFromObject(obj)
      if (box.isEmpty()) return
      box.getCenter(center).project(m.camera)
      if (center.z > 1) return // behind the camera
      const sx = rect.left + ((center.x + 1) / 2) * rect.width
      const sy = rect.top + ((1 - center.y) / 2) * rect.height
      if (sx >= x0 && sx <= x1 && sy >= y0 && sy <= y1) ids.push(id)
    }
    for (const [id, rec] of this.components) test(id, rec.built.object)
    for (const [id, rec] of this.wires) test(id, rec.group)
    return ids
  }

  /**
   * Pointerup lands an editing drag. Returns true when a STARTED drag
   * consumed the whole gesture (the caller suppresses the tap); a merely
   * armed drag cleans up silently and lets the tap proceed.
   */
  private finishEditDrags(e: PointerEvent): boolean {
    const m = this.m
    let consumed = false
    if (this.marquee) {
      const mq = this.marquee
      this.marquee = null
      if (mq.started && m) {
        mq.curX = e.clientX
        mq.curY = e.clientY
        this.callbacks.onMarqueeSelect?.(this.computeMarqueeIds(m, mq))
        consumed = true
      }
      mq.el?.remove()
    } else if (this.moveDrag) {
      const d = this.moveDrag
      this.moveDrag = null
      if (d.started) {
        consumed = true
        if (d.valid && d.target) {
          const noop = 'dCol' in d.target && d.target.dCol === 0 && d.target.dRowLattice === 0
          if (!noop) this.callbacks.onMoveCommit?.(d.ids, d.target)
        }
      }
      if (d.holo && m) m.overlayGroup.remove(d.holo) // clones share geometry — nothing to free
    } else if (this.instDrag) {
      const d = this.instDrag
      this.instDrag = null
      if (m) this.resetInstDragVisuals(m, d)
      if (d.started) {
        consumed = true
        if (d.valid && (d.pos.x !== d.origin.x || d.pos.z !== d.origin.z)) {
          this.callbacks.onInstrumentMoveCommit?.(d.id, d.pos)
        }
      }
    }
    this.restoreControls()
    return consumed
  }

  /** Abandon any editing drag (pointer cancel/leave, dispose). */
  private cancelEditDrags(): void {
    const m = this.m
    if (this.marquee) {
      this.marquee.el?.remove()
      this.marquee = null
    }
    if (this.moveDrag) {
      if (m && this.moveDrag.holo) m.overlayGroup.remove(this.moveDrag.holo)
      this.moveDrag = null
    }
    if (this.instDrag) {
      if (m) this.resetInstDragVisuals(m, this.instDrag)
      this.instDrag = null
    }
    this.restoreControls()
  }

  private cancelLongPress(): void {
    if (this.longPressTimer !== null) {
      window.clearTimeout(this.longPressTimer)
      this.longPressTimer = null
    }
  }

  private startLongPress(id: string): void {
    this.cancelLongPress()
    this.longPressTimer = window.setTimeout(() => {
      this.longPressTimer = null
      if (!this.downInfo) return // already released
      this.tapSuppressed = true // swallow the matching pointerup tap
      this.callbacks.onObjectLongPress?.(id)
    }, LONG_PRESS_MS)
  }

  /** Touch long-press on a "+" paddle → remove a board from that edge. */
  private startPaddleLongPress(dir: GridGrowDirection): void {
    this.cancelLongPress()
    this.longPressTimer = window.setTimeout(() => {
      this.longPressTimer = null
      if (!this.downInfo) return // already released
      this.tapSuppressed = true // the matching pointerup must not also grow
      this.pendingShrinkDir = dir
      this.callbacks.onShrinkGrid?.(dir)
    }, LONG_PRESS_MS)
  }

  private hideFingertip(): void {
    const m = this.m
    if (!m) return
    m.fingertipGroup.visible = false
    if (this.lastPointerType === 'touch') m.holeLabel.hide()
  }

  /** Keep the coordinate chip on a just-clicked hole for ~1.2s (desktop). */
  private pinHoleLabel(m: Mounted, holeRef: HoleRef): void {
    const h = parseHole(holeRef)
    if (!h) return
    const p = holePosition(h)
    m.holeLabel.setLocked(this.occluded.has(holeRef))
    m.holeLabel.setText(holeRef)
    m.holeLabel.object.position.set(p.x, HOLE_LABEL_Y, p.z)
    m.holeLabel.show()
    this.labelPinnedUntil = performance.now() + LABEL_PIN_MS
  }

  // ------------------------------------------------------------ grow paddles

  /** Float one "+" paddle just past each edge of the 2-D grid. */
  private positionPaddles(m: Mounted): void {
    const ext = boardExtents(m.board.config)
    const cx = (ext.minX + ext.maxX) / 2
    const cz = (ext.minZ + ext.maxZ) / 2
    const off = PADDLE_GAP + PADDLE_SIZE / 2
    for (const p of m.paddles) {
      switch (p.dir) {
        case 'right':
          p.group.position.set(ext.maxX + off, PADDLE_Y, cz)
          break
        case 'left':
          p.group.position.set(ext.minX - off, PADDLE_Y, cz)
          break
        case 'up':
          p.group.position.set(cx, PADDLE_Y, ext.minZ - off)
          break
        case 'down':
          p.group.position.set(cx, PADDLE_Y, ext.maxZ + off)
          break
      }
    }
  }

  /** Can the "−" affordance shrink this paddle's edge right now? (right/down
   *  only — the store shrink drops the rightmost module / deepest row.) */
  private paddleRemovable(m: Mounted, dir: GridGrowDirection): boolean {
    const config = m.board.config
    if (dir === 'right') return config.count > 1
    if (dir === 'down') return (config.rows ?? 1) > 1
    return false
  }

  /**
   * Per-frame paddle state: visible only in select mode while the sim is
   * stopped and that paddle's axis can still grow (modules for left/right,
   * board-rows for up/down); gentle idle glass pulse; hover highlight eased
   * with a tiny scale spring. Hovering a paddle (desktop) reveals its quiet
   * "−" removal chip beneath when the axis has something to remove — eased
   * scale + opacity, warm-red tinted only while the chip itself is hovered.
   * Number writes only.
   */
  private updatePaddles(m: Mounted, t: number): void {
    // PERF: boardConfigOf allocates a fresh object per call — this runs every
    // frame, so read the built board's config instead (syncLayout rebuilds
    // the board whenever the layout's rig differs, so they always agree here)
    const config = m.board.config
    const baseVisible =
      !this.isPlaceOrWireMode() && this.telemetry === null && this.moveDrag === null
    const pulse = m.reduced ? 0.5 : 0.5 + 0.5 * Math.sin(t * 2.1)
    let anyHover = false
    for (const p of m.paddles) {
      const capped =
        p.dir === 'right' || p.dir === 'left'
          ? config.count >= MAX_BOARD_COUNT
          : (config.rows ?? 1) >= MAX_BOARD_ROWS
      const visible = baseVisible && !capped
      p.group.visible = visible
      if (!visible) {
        if (this.paddleHover === p.dir) this.paddleHover = null
        if (this.paddleMinusHover === p.dir) this.paddleMinusHover = null
        p.minusReveal = 0
        if (p.minus) p.minus.visible = false
        continue
      }
      const minusHover = this.paddleMinusHover === p.dir
      const hover = this.paddleHover === p.dir || minusHover
      anyHover ||= hover
      p.mat.opacity = hover ? 0.55 : 0.3 + 0.07 * pulse
      p.mat.emissiveIntensity = hover ? 0.85 : 0.28 + 0.2 * pulse
      p.glyphMat.opacity = hover ? 1 : 0.72 + 0.18 * pulse
      const target = hover && !m.reduced ? 1.07 : 1
      const s = p.group.scale.x
      p.group.scale.setScalar(s + (target - s) * 0.25)

      // "−" chip reveal (progressive enhancement — only hover can reach it,
      // so touch never sees a dangling chip; long-press covers touch)
      if (p.minus && p.minusMat && p.minusGlyphMat) {
        const revealTarget = hover && this.paddleRemovable(m, p.dir) ? 1 : 0
        p.minusReveal = m.reduced
          ? revealTarget
          : p.minusReveal + (revealTarget - p.minusReveal) * 0.22
        if (p.minusReveal < 0.02) {
          p.minusReveal = revealTarget === 0 ? 0 : p.minusReveal
          p.minus.visible = p.minusReveal > 0
        } else {
          p.minus.visible = true
        }
        if (p.minus.visible) {
          const r = p.minusReveal
          p.minus.scale.setScalar(PADDLE_MINUS_SCALE * (0.7 + 0.3 * r))
          p.minus.position.y = -PADDLE_MINUS_DROP * (0.85 + 0.15 * r)
          p.minusMat.opacity = (minusHover ? 0.5 : 0.26) * r
          p.minusMat.emissiveIntensity = minusHover ? 0.6 : 0.18
          p.minusMat.emissive.setHex(minusHover ? 0xff453a : 0x8a93a3)
          p.minusGlyphMat.opacity = (minusHover ? 1 : 0.8) * r
        }
      }
    }
    if (!anyHover && !baseVisible) {
      this.paddleHover = null
      this.paddleMinusHover = null
    }
  }

  /** The visible paddle plate (or its revealed "−" chip) under the ray. */
  private pickPaddle(m: Mounted): { rec: PaddleRecord; minus: boolean } | null {
    for (const p of m.paddles) {
      if (!p.group.visible) continue
      // the revealed chip first — it sits below the + plate, never occluded
      if (p.minusPlate && p.minus?.visible && p.minusReveal > 0.5) {
        this.hitBuf.length = 0
        if (this.raycaster.intersectObject(p.minusPlate, false, this.hitBuf).length > 0) {
          return { rec: p, minus: true }
        }
      }
      this.hitBuf.length = 0
      if (this.raycaster.intersectObject(p.plate, false, this.hitBuf).length > 0) {
        return { rec: p, minus: false }
      }
    }
    return null
  }

  /**
   * Drive the board SPAWN drop (transform-only on prebuilt groups):
   * gravity-feel ease-in fall with a leveling tilt → touchdown (dust puff +
   * squash) → house-spring relax → deferred camera glide home.
   */
  private updateSpawnTween(m: Mounted): void {
    const tw = this.spawnTween
    if (!tw) return
    const now = performance.now()
    if (tw.t0 === 0) {
      // lazy clock start: the synchronous rebuild (board + every component
      // mesh) happened before this first tick — the fall starts at its top,
      // never mid-air, however long the rebuild took
      tw.t0 = now
      return
    }
    const fall = (now - tw.t0) / SPAWN_DROP_MS
    if (fall < 1) {
      const p = fall * fall // accelerating, gravity-feel
      this.poseSpawnEntries(m, SPAWN_DROP_HEIGHT * (1 - p), tw.tilt * (1 - p), 1)
      return
    }
    if (!tw.landed) {
      tw.landed = true
      // touchdown: tiny dust puff at the base edges (the store path already
      // fired the haptic). The rAF loop only runs on a visible tab.
      m.spawnFx.burst(tw.rect, now, 12, 1)
    }
    const settle = (now - tw.t0 - SPAWN_DROP_MS) / SPAWN_SETTLE_MS
    if (settle < 1) {
      // one-beat squash: quick dip into the squash, house-spring relax out
      const dip = settle < 0.25 ? settle / 0.25 : 1 - SPRING_EASE((settle - 0.25) / 0.75)
      this.poseSpawnEntries(m, 0, 0, 1 - SPAWN_SQUASH * dip)
      return
    }
    this.poseSpawnEntries(m, 0, 0, 1) // exact rest pose
    this.spawnTween = null
    // Studio: a BVH built mid-tween captured displaced module poses —
    // rebuild once the drop has settled on the final geometry
    this.modes.invalidate()
    // sequence tail: drop → settle → dust → NOW the camera glides home
    if (this.flyHomePending) {
      this.flyHomePending = false
      this.flyCamera(m, m.homePos, m.homeTarget)
    }
  }

  /** Drive the removal lift + fade (detached old-board groups + clones). */
  private updateRemovalTween(m: Mounted): void {
    const tw = this.removalTween
    if (!tw) return
    const k = Math.min(1, (performance.now() - tw.t0) / REMOVE_MS)
    const ease = 1 - (1 - k) * (1 - k) // ease-out lift
    for (let i = 0; i < tw.groups.length; i++) {
      const g = tw.groups[i]
      g.position.set(tw.bases[i].x, tw.bases[i].y + REMOVE_LIFT * ease, tw.bases[i].z)
      g.updateMatrix()
    }
    setFadeOpacity(tw.set, 1 - ease)
    if (k >= 1) {
      // natural end: clean up WITHOUT killing the still-drifting dust puff
      this.removalTween = null
      for (const g of tw.groups) m.scene.remove(g)
      disposeFadeSet(tw.set, false) // the groups die with the old build
      tw.oldBuild.dispose()
      this.modes.invalidate()
      // deferred camera follow (the home extents shrank under the tween)
      if (this.flyHomePending) {
        this.flyHomePending = false
        this.flyCamera(m, m.homePos, m.homeTarget)
      }
    }
  }

  /** Drive the reduced-motion spawn fade-in (opacity only, no movement). */
  private updateFadeTween(): void {
    const tw = this.fadeTween
    if (!tw) return
    const k = Math.min(1, (performance.now() - tw.t0) / SPAWN_FADE_MS)
    setFadeOpacity(tw.set, k)
    if (k >= 1) {
      disposeFadeSet(tw.set, true) // restore the build's shared materials
      this.fadeTween = null
      this.modes.invalidate()
    }
  }

  /**
   * Snap every board spawn/removal animation to its end state and free what
   * it held (the removal tween owns the OLD board build until it finishes).
   * Safe to call any time — rebuilds and dispose() both funnel through here.
   */
  private finishBoardAnims(m: Mounted): void {
    const spawn = this.spawnTween
    if (spawn) {
      this.spawnTween = null
      for (const e of spawn.entries) {
        e.group.position.copy(e.base)
        e.group.rotation.set(0, 0, 0)
        e.group.scale.set(1, 1, 1)
        e.group.updateMatrix()
      }
    }
    const fade = this.fadeTween
    if (fade) {
      this.fadeTween = null
      disposeFadeSet(fade.set, true)
    }
    const removal = this.removalTween
    if (removal) {
      this.removalTween = null
      for (const g of removal.groups) m.scene.remove(g)
      disposeFadeSet(removal.set, false) // groups die with the old build
      removal.oldBuild.dispose()
      this.modes.invalidate()
    }
    m.spawnFx.reset()
  }

  /** Spring the camera to pos/tgt (~450ms); reduced motion jumps instantly. */
  private flyCamera(m: Mounted, pos: THREE.Vector3, tgt: THREE.Vector3): void {
    if (prefersReducedMotion()) {
      this.camTween = null
      m.camera.position.copy(pos)
      m.controls.target.copy(tgt)
      m.controls.update()
      return
    }
    this.camTween = {
      startPos: m.camera.position.clone(),
      startTgt: m.controls.target.clone(),
      endPos: pos.clone(),
      endTgt: tgt.clone(),
      t0: performance.now(),
    }
  }

  /**
   * HARNESS ONLY (scripts/closeups.mjs via App's `?shotrig` hook): park the
   * camera at an exact pose for deterministic close-up screenshots. Cancels
   * any active re-frame tween; the running rAF loop renders the new view.
   * Not part of the scene contract — never called by product code.
   */
  setCameraPose(
    pos: { x: number; y: number; z: number },
    target: { x: number; y: number; z: number },
  ): void {
    const m = this.m
    if (!m) return
    this.camTween = null
    // close-up shots go under the product orbit floor — relax it (the hook is
    // only reachable through the ?shotrig harness page, never in normal use)
    m.controls.minDistance = Math.min(m.controls.minDistance, 1.5)
    m.camera.position.set(pos.x, pos.y, pos.z)
    m.controls.target.set(target.x, target.y, target.z)
    m.controls.update()
  }

  /**
   * HARNESS ONLY (scripts/sweeps.mjs via App's `?shotrig` hook): project a
   * world point to viewport-client pixel coordinates so the sweep can aim
   * deterministic drags at parts and paddles. Not part of the scene contract.
   */
  projectToScreen(p: { x: number; y: number; z: number }): { x: number; y: number } | null {
    const m = this.m
    if (!m) return null
    const rect = m.renderer.domElement.getBoundingClientRect()
    if (rect.width < 1 || rect.height < 1) return null
    m.camera.updateMatrixWorld()
    this.tmpVecB.set(p.x, p.y, p.z).project(m.camera)
    if (this.tmpVecB.z > 1) return null
    return {
      x: rect.left + ((this.tmpVecB.x + 1) / 2) * rect.width,
      y: rect.top + ((1 - this.tmpVecB.y) / 2) * rect.height,
    }
  }

  /** Plan-extents of everything framable: the grid + off-board instrument units. */
  private homeBounds(): { minX: number; maxX: number; minZ: number; maxZ: number } {
    const config = boardConfigOf(this.layout)
    let { minX, maxX, minZ, maxZ } = boardExtents(config)
    // the "+" grow paddles float just past the grid's edges — keep them framed
    const pad = PADDLE_GAP + PADDLE_SIZE
    if (config.count < MAX_BOARD_COUNT) {
      minX -= pad
      maxX += pad
    }
    if (config.rows < MAX_BOARD_ROWS) {
      minZ -= pad
      maxZ += pad
    }
    // off-board instrument bodies (explicit `pos` honored — instruments are
    // movable) extend the framable bench; +margin past the terminal apron
    let slot = 0
    for (const comp of this.layout.components) {
      if (getEntry(comp.type)?.placement !== 'offboard') continue
      const r = offboardBodyRect(slot++, comp.pos)
      minX = Math.min(minX, r.minX - 0.8)
      maxX = Math.max(maxX, r.maxX + 0.8)
      minZ = Math.min(minZ, r.minZ - 0.5)
      maxZ = Math.max(maxZ, r.maxZ + 0.5)
    }
    return { minX, maxX, minZ, maxZ }
  }

  /**
   * Aspect-fit home framing (the default view, the empty-board re-frame
   * destination and the resize anchor): the camera distance along HOME_DIR is
   * the minimum that puts every corner of the board (+ off-board instruments)
   * bounding box inside the CURRENT frustum — a portrait phone gets the whole
   * board, not a landscape-tuned crop. Returns true when home moved.
   */
  private computeHomeFraming(m: Mounted): boolean {
    const b = this.homeBounds()
    this.refitShadows(m, b) // the shadow camera tracks the same extents
    const cx = (b.minX + b.maxX) / 2
    const cz = (b.minZ + b.maxZ) / 2
    const tanV = Math.tan(THREE.MathUtils.degToRad(m.camera.fov / 2))
    const tanH = tanV * Math.max(m.camera.aspect, 0.01)
    let d = MIN_HOME_DISTANCE
    for (const x of [b.minX, b.maxX]) {
      for (const y of [HOME_MIN_Y, HOME_MAX_Y]) {
        for (const z of [b.minZ, b.maxZ]) {
          const ox = x - cx
          const oz = z - cz
          const px = ox * HOME_RIGHT.x + y * HOME_RIGHT.y + oz * HOME_RIGHT.z
          const py = ox * HOME_UP.x + y * HOME_UP.y + oz * HOME_UP.z
          const pf = ox * HOME_FWD.x + y * HOME_FWD.y + oz * HOME_FWD.z
          d = Math.max(d, Math.abs(px) / tanH - pf, Math.abs(py) / tanV - pf)
        }
      }
    }
    d *= HOME_FIT_MARGIN
    const hx = cx + HOME_DIR.x * d
    const hy = HOME_DIR.y * d
    const hz = cz + HOME_DIR.z * d
    const moved =
      Math.abs(hx - m.homePos.x) > 1e-3 ||
      Math.abs(hy - m.homePos.y) > 1e-3 ||
      Math.abs(hz - m.homePos.z) > 1e-3 ||
      Math.abs(cx - m.homeTarget.x) > 1e-3 ||
      Math.abs(cz - m.homeTarget.z) > 1e-3
    m.homeTarget.set(cx, 0, cz)
    m.homePos.set(hx, hy, hz)
    // the home framing must stay reachable by pinch-zoom-out (and the
    // content-framing clamp below must never crop a fitted circuit)
    m.controls.maxDistance = Math.max(180, d * 1.35)
    return moved
  }

  /**
   * Fit the key light's ONE shadow map tightly around the active extents
   * (board + instruments): the ortho frustum is the bounding sphere of the
   * plan bounds, so texel density rises on smaller boards and nothing clips
   * on 'labxl'. Called whenever the home bounds are recomputed.
   */
  private refitShadows(
    m: Mounted,
    b: { minX: number; maxX: number; minZ: number; maxZ: number },
  ): void {
    const cx = (b.minX + b.maxX) / 2
    const cz = (b.minZ + b.maxZ) / 2
    // +3 margin: leaning wires/tall parts at the rim still land in the map
    const r = Math.hypot(b.maxX - b.minX, b.maxZ - b.minZ) / 2 + 3
    const d = Math.max(60, r * 1.6)
    m.keyLight.position.set(cx + KEY_DIR.x * d, KEY_DIR.y * d, cz + KEY_DIR.z * d)
    m.keyLight.target.position.set(cx, 0, cz)
    m.keyLight.target.updateMatrixWorld()
    const cam = m.keyLight.shadow.camera
    if (cam.left !== -r || cam.right !== r) {
      cam.left = -r
      cam.right = r
      cam.top = r
      cam.bottom = -r
      cam.near = Math.max(1, d - r - 8)
      cam.far = d + r + 8
      cam.updateProjectionMatrix()
    }
    // light/frustum may have moved — schedule one on-demand shadow render
    m.renderer.shadowMap.needsUpdate = true
  }

  /** True while the camera is (still) parked at the home framing. */
  private cameraAtHome(m: Mounted): boolean {
    return (
      m.camera.position.distanceToSquared(m.homePos) < 0.04 &&
      m.controls.target.distanceToSquared(m.homeTarget) < 0.04
    )
  }

  /**
   * Camera framing that fits the layout's content (components, wires,
   * off-board terminal posts) from the home view's direction; null when the
   * board is empty. Distance fits the content's bounding sphere in the
   * narrower field of view, so phone portrait (narrow horizontal FOV) zooms
   * out far enough to reveal circuits placed anywhere along the board.
   */
  private contentFraming(m: Mounted): { pos: THREE.Vector3; tgt: THREE.Vector3 } | null {
    const box = new THREE.Box3()
    box.expandByObject(m.componentsGroup)
    box.expandByObject(m.wiresGroup)
    box.expandByObject(m.terminalsGroup)
    if (box.isEmpty()) return null

    const sphere = box.getBoundingSphere(new THREE.Sphere())
    const radius = Math.max(sphere.radius, 5) + 1.5 // pad; floor avoids over-zoom on tiny circuits
    const tgt = new THREE.Vector3(sphere.center.x, 0, sphere.center.z)
    const dir = new THREE.Vector3().subVectors(m.homePos, m.homeTarget).normalize()
    const vFov = THREE.MathUtils.degToRad(m.camera.fov)
    const hFov = 2 * Math.atan(Math.tan(vFov / 2) * m.camera.aspect)
    // sphere-tangent fit in the narrower FOV, +10% headroom for the chrome
    const dist = (radius / Math.sin(Math.min(vFov, hFov) / 2)) * 1.1
    const clamped = THREE.MathUtils.clamp(dist, m.controls.minDistance, m.controls.maxDistance)
    const pos = dir.multiplyScalar(clamped).add(tgt)
    return { pos, tgt }
  }

  /**
   * Double-tap/double-click on empty space: spring the camera to frame the
   * circuit (or back to the home framing when the board is empty).
   */
  private reframeCamera(): void {
    const m = this.m
    if (!m) return
    const f = this.contentFraming(m)
    this.flyCamera(m, f ? f.pos : m.homePos, f ? f.tgt : m.homeTarget)
  }

  /** rAF interpolation of camera position+target toward the tween destination. */
  private updateCamTween(m: Mounted): void {
    const tw = this.camTween
    if (!tw) return
    const t = Math.min(1, (performance.now() - tw.t0) / REFRAME_MS)
    const s = SPRING_EASE(t)
    m.camera.position.lerpVectors(tw.startPos, tw.endPos, s)
    m.controls.target.lerpVectors(tw.startTgt, tw.endTgt, s)
    m.camera.lookAt(m.controls.target)
    if (t >= 1) {
      this.camTween = null
      m.controls.update() // re-sync OrbitControls' spherical state
    }
  }

  /** Resolved tap/click (touch: <10px && <350ms; mouse: <6px && <400ms). */
  private handleClick(e: PointerEvent): void {
    const m = this.m
    if (!m) return
    this.updateNdc(e)
    this.raycaster.setFromCamera(this.pointerNdc, m.camera)
    const touch = e.pointerType === 'touch'
    const aiming = this.isPlaceOrWireMode()

    // 0. the "+" grow paddles (select mode + sim stopped only). The tapped
    // direction is remembered so the rebuild can animate the new module
    // column / board-row in at the matching edge. A click on the revealed
    // "−" chip removes from that edge instead (store shrink — protection
    // toasts handle stranded parts on the host side).
    const paddle = this.pickPaddle(m)
    if (paddle) {
      if (paddle.minus) {
        if (this.paddleRemovable(m, paddle.rec.dir)) {
          this.pendingShrinkDir = paddle.rec.dir
          this.callbacks.onShrinkGrid?.(paddle.rec.dir)
        }
        return
      }
      this.pendingGrowDir = paddle.rec.dir
      if (this.callbacks.onGrowGrid) this.callbacks.onGrowGrid(paddle.rec.dir)
      else if (paddle.rec.dir === 'right') this.callbacks.onAddBoardClick?.() // legacy host
      return
    }

    // 1. terminal posts (exact)
    this.hitBuf.length = 0
    const termHits = this.raycaster.intersectObjects(m.terminalsGroup.children, false, this.hitBuf)
    if (termHits.length > 0) {
      const ref = termHits[0].object.userData.terminalRef
      if (typeof ref === 'string') {
        this.callbacks.onTerminalClick?.(ref)
        return
      }
    }

    // 2. component bodies / wires (exact). shift/cmd/ctrl+click asks the
    // host for an ADDITIVE toggle (desktop multi-select extension).
    const id = this.pickObjectIdAtPointer()
    if (id !== null) {
      if (aiming) {
        // while wiring/placing, an off-board instrument BODY is a fat target
        // for its terminal posts (the posts themselves are a few px wide)
        const rec = this.components.get(id)
        if (rec && rec.posts.length > 0) {
          const term = this.pickTerminalNearPointer(Infinity, rec)
          if (term) {
            this.callbacks.onTerminalClick?.(term)
            return
          }
        }
        // aiming at a hole that a molded body COVERS: the body mesh wins the
        // ray, so without this branch the tap dies with zero feedback — pin
        // the red locked chip and let the host explain why (occlusion toast)
        this.raycaster.setFromCamera(this.pointerNdc, m.camera)
        const under = this.pickHole(touch ? HOLE_SNAP_DIST_TOUCH : HOLE_SNAP_DIST)
        if (under && this.occluded.has(under)) {
          this.pinHoleLabel(m, under)
          this.callbacks.onHoleOcclusionRejected?.(under)
          return
        }
      }
      this.callbacks.onObjectClick?.(id, e.shiftKey || e.metaKey || e.ctrlKey)
      return
    }

    // 2b. touch slop, select mode: wires (~6px) and posts are far under the
    // 44px rule — search outward before holes (a hole tap in select mode only
    // clears the selection, so the nearby object should win)
    if (touch && !aiming) {
      const term = this.pickTerminalNearPointer(OBJECT_TOUCH_SLOP_PX)
      if (term) {
        this.callbacks.onTerminalClick?.(term)
        return
      }
      const t = this.pickWithSlop(m.objectPickRoots, OBJECT_TOUCH_SLOP_PX)
      if (t?.componentId) {
        this.callbacks.onObjectClick?.(t.componentId)
        return
      }
    }

    // 3. board holes (coarse snap radius for touch); re-aim the ray first —
    // the slop scan above may have left it on an offset sample
    this.raycaster.setFromCamera(this.pointerNdc, m.camera)
    const snap = touch ? HOLE_SNAP_DIST_TOUCH : HOLE_SNAP_DIST
    const holeRef = this.pickHole(snap)
    if (holeRef) {
      if (!touch) this.pinHoleLabel(m, holeRef) // desktop QOL: chip lingers ~1.2s
      // occlusion UX: place/wire clicks on a body-covered hole are rejected —
      // pin the red locked chip even on touch (a quick tap never saw the aim
      // chip) and let the host explain WHY via onHoleOcclusionRejected
      // (select-mode taps still pass through, e.g. to clear the selection)
      if (aiming && this.occluded.has(holeRef)) {
        if (touch) this.pinHoleLabel(m, holeRef)
        this.callbacks.onHoleOcclusionRejected?.(holeRef)
        return
      }
      this.callbacks.onHoleClick?.(holeRef)
      return
    }

    // 3b. touch slop while placing/wiring: holes won above, but off the board
    // the terminal posts still deserve a finger-sized target
    if (touch && aiming) {
      const term = this.pickTerminalNearPointer(OBJECT_TOUCH_SLOP_PX)
      if (term) {
        this.callbacks.onTerminalClick?.(term)
        return
      }
    }

    // 4. empty space — a second tap right after the first one re-frames the camera
    const now = performance.now()
    const prev = this.lastBgTap
    this.lastBgTap = { x: e.clientX, y: e.clientY, t: now }
    if (
      prev &&
      now - prev.t < DOUBLE_TAP_MS &&
      Math.hypot(e.clientX - prev.x, e.clientY - prev.y) < DOUBLE_TAP_MAX_PX
    ) {
      this.lastBgTap = null
      this.reframeCamera()
      return
    }
    this.callbacks.onBackgroundClick?.()
  }

  // ----------------------------------------------------- render-mode plumbing

  /** A primary canvas pointer went down (orbit, aiming, drags): Studio yields
   *  to the Enhanced raster until it lifts. Boolean-guarded so the manager's
   *  depth counter can never wedge on an unbalanced event. */
  private beginPointerInteraction(): void {
    if (this.pointerInteracting) return
    this.pointerInteracting = true
    this.modes.onInteractionStart()
  }

  private endPointerInteraction(): void {
    if (!this.pointerInteracting) return
    this.pointerInteracting = false
    this.modes.onInteractionEnd()
  }

  /**
   * Raster-overlay compositing for path-traced frames: everything excluded
   * from the Studio still (the overlay subtree + grow paddles — holograms,
   * hover ring, pin markers, selection boxes, wire/instrument previews,
   * coordinate chips, fingertip cursor) is re-rendered on top of the
   * presented image each frame, so placement / wiring / hover / selection
   * stay fully live while a still converges or holds. The pass draws a
   * handful of unlit transparent meshes over a cleared depth buffer —
   * negligible cost, no allocations.
   */
  private renderStudioOverlays(m: Mounted): void {
    // overlay children are created at many sites (ghost, drags, selection,
    // labels) — refreshing layer membership on the tiny subtree once per
    // composited frame beats layer bookkeeping at every add site
    m.overlayGroup.traverse(enableOverlayLayer)
    for (const p of m.paddles) p.group.traverse(enableOverlayLayer)
    const r = m.renderer
    const bg = m.scene.background
    const shadowPending = r.shadowMap.needsUpdate
    m.scene.background = null // never repaint the backdrop over the still
    r.shadowMap.needsUpdate = false // don't burn the on-demand map on overlays
    r.autoClear = false
    r.clearDepth()
    m.camera.layers.set(OVERLAY_LAYER)
    r.render(m.scene, m.camera)
    m.camera.layers.set(0)
    r.autoClear = true
    r.shadowMap.needsUpdate = shadowPending
    m.scene.background = bg
  }

  // ----------------------------------------------------------------- resize

  private handleResize(): void {
    const m = this.m
    if (!m) return
    const w = m.container.clientWidth
    const h = m.container.clientHeight
    if (w < 1 || h < 1) return
    const wasHome = this.cameraAtHome(m)
    m.camera.aspect = w / h
    m.camera.updateProjectionMatrix()
    m.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2)) // keep the ≤2 cap
    m.renderer.setSize(w, h)
    this.modes.setSize(w, h) // composer targets track the canvas (after setSize)
    // an aspect change moves the fit-to-board home framing; snap with it while
    // parked there (rotation/first-layout pass), never mid-tween or mid-orbit
    if (this.computeHomeFraming(m) && wasHome && !this.camTween) {
      m.camera.position.copy(m.homePos)
      m.controls.target.copy(m.homeTarget)
      m.controls.update()
    }
  }
}
