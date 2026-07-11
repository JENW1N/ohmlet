/**
 * Shared helpers for procedural component visuals (meshes agent).
 *
 * Conventions:
 *  - 1 unit = one hole pitch (0.1"). Board top surface is y = 0.
 *  - Legs may dip to HOLE_DEPTH (into the hole); nothing else goes below
 *    y = -0.05.
 *  - Geometries and static materials are cached module-wide; anything with
 *    per-instance state (emissive, canvas screens) is created per instance.
 */

import * as THREE from 'three'
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js'
import type { ComponentInstance, ComponentTelemetry } from '../../model/types'
import type { CatalogEntry } from '../../model/catalog'
import type { RoutedComponent } from '../internal/wire-router'

/** Per-frame visual refresh callback registered by each builder. */
export type VisualUpdater = (
  comp: ComponentInstance,
  entry: CatalogEntry,
  telemetry: ComponentTelemetry | null,
) => void

/** Internal builder result (the public BuiltComponent drops `update`). */
export interface BuildResult {
  object: THREE.Group
  pinWorld: THREE.Vector3[]
  update?: VisualUpdater
}

/** How deep legs reach into a hole (below the y=0 board surface). */
export const HOLE_DEPTH = -0.18
export const LEG_RADIUS = 0.05

// ---------------------------------------------------------------------------
// Geometry / material caches
// ---------------------------------------------------------------------------

/**
 * Every module-wide cached resource (geometry/material/texture) is registered
 * here. These are shared across all component instances and live for the page
 * lifetime — they must NEVER be disposed when a single component is removed
 * (see disposeComponentObject in ../component-meshes.ts).
 */
const sharedResources = new WeakSet<object>()

/** True when a geometry/material/texture is a module-wide shared resource. */
export function isSharedResource(resource: object | null | undefined): boolean {
  return resource != null && sharedResources.has(resource)
}

/**
 * Mark an externally created geometry/material/texture as shared (page
 * lifetime, skipped by disposeComponentObject). Used by the GLTF override
 * loader whose cloned instances all reference one cached resource set.
 */
export function markShared(resource: object): void {
  sharedResources.add(resource)
}

const geoCache = new Map<string, THREE.BufferGeometry>()
export function cachedGeometry<T extends THREE.BufferGeometry>(key: string, make: () => T): T {
  let g = geoCache.get(key)
  if (!g) {
    g = make()
    sharedResources.add(g)
    geoCache.set(key, g)
  }
  return g as T
}

const matCache = new Map<string, THREE.Material>()
export function cachedMaterial<T extends THREE.Material>(key: string, make: () => T): T {
  let m = matCache.get(key)
  if (!m) {
    m = make()
    sharedResources.add(m)
    matCache.set(key, m)
  }
  return m as T
}

// --- procedural micro-textures (tiny, tileable, shared) ---------------------

const proceduralTexCache = new Map<string, THREE.Texture | null>()

function cachedProceduralTexture(
  key: string,
  paint: (ctx: CanvasRenderingContext2D, w: number, h: number) => void,
  w: number,
  h: number,
): THREE.Texture | null {
  if (proceduralTexCache.has(key)) return proceduralTexCache.get(key) ?? null
  let tex: THREE.Texture | null = null
  if (typeof document !== 'undefined') {
    const canvas = document.createElement('canvas')
    canvas.width = w
    canvas.height = h
    const ctx = canvas.getContext('2d')
    if (ctx) {
      paint(ctx, w, h)
      tex = new THREE.CanvasTexture(canvas)
      tex.wrapS = THREE.RepeatWrapping
      tex.wrapT = THREE.RepeatWrapping
      sharedResources.add(tex)
    }
  }
  proceduralTexCache.set(key, tex)
  return tex
}

/** Mulberry32 — deterministic noise so the textures are stable across builds. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** Subtle tileable noise normal map shared by every ABS-plastic surface. */
export function noiseNormalTexture(): THREE.Texture | null {
  return cachedProceduralTexture(
    'noise-normal',
    (ctx, w, h) => {
      const img = ctx.createImageData(w, h)
      const rnd = mulberry32(0xab5)
      for (let i = 0; i < w * h; i++) {
        // near-flat normals (128,128,255) with a faint random wobble
        img.data[i * 4 + 0] = 128 + Math.round((rnd() - 0.5) * 22)
        img.data[i * 4 + 1] = 128 + Math.round((rnd() - 0.5) * 22)
        img.data[i * 4 + 2] = 255
        img.data[i * 4 + 3] = 255
      }
      ctx.putImageData(img, 0, 0)
    },
    64,
    64,
  )
}

/**
 * Horizontal-streak grayscale map (roughness variation). Gives metals a
 * brushed / slightly anisotropic feel without the cost of real anisotropy.
 */
export function brushedRoughnessTexture(): THREE.Texture | null {
  return cachedProceduralTexture(
    'brushed-rough',
    (ctx, w, h) => {
      ctx.fillStyle = '#f2f2f2'
      ctx.fillRect(0, 0, w, h)
      const rnd = mulberry32(0xb705)
      for (let y = 0; y < h; y++) {
        const v = 205 + Math.floor(rnd() * 50) // 0.80..1.0 multiplier
        ctx.fillStyle = `rgb(${v},${v},${v})`
        ctx.fillRect(0, y, w, 1)
      }
    },
    128,
    128,
  )
}

// --- shared PBR materials ----------------------------------------------------

/**
 * ABS-feel plastic (button bodies, switch bodies, pots, sleeves):
 * MeshPhysicalMaterial with a very subtle shared noise normal map.
 */
export function plastic(color: number, roughness = 0.55, metalness = 0.05): THREE.MeshPhysicalMaterial {
  return cachedMaterial(`plastic:${color}:${roughness}:${metalness}`, () => {
    const m = new THREE.MeshPhysicalMaterial({ color, roughness, metalness })
    const n = noiseNormalTexture()
    if (n) {
      m.normalMap = n
      m.normalScale.set(0.18, 0.18)
    }
    return m
  })
}

/**
 * Real metal (legs, pins, switch tops, terminal posts): metalness 1.0,
 * roughness 0.22–0.35 with streaked variation via a shared roughnessMap.
 * Pure metals only reflect their environment — and the raster modes run the
 * env deliberately dim (Enhanced drops scene.environmentIntensity to protect
 * the bloom threshold), which used to collapse every lead to gunmetal. The
 * bright tinned-lead albedo + envMapIntensity lift below compensate so legs
 * read white-silver (ref-resistor-array.jpg / ref-led.jpg) without touching
 * the modes' lighting.
 */
export function metal(color = 0xdadee3, roughness = 0.3): THREE.MeshPhysicalMaterial {
  return cachedMaterial(`metal:${color}:${roughness}`, () => {
    const m = new THREE.MeshPhysicalMaterial({ color, metalness: 1.0, roughness })
    m.envMapIntensity = 1.7
    const r = brushedRoughnessTexture()
    if (r) m.roughnessMap = r // texture spans ~0.8..1.0 → roughness varies subtly
    return m
  })
}

/**
 * Near-black molded epoxy (IC bodies, 7-seg shells, TO-92): satin with a thin
 * clearcoat — the look of transfer-molded packages under studio light.
 */
export function moldedEpoxy(color = 0x1a1a1c, roughness = 0.45): THREE.MeshPhysicalMaterial {
  return cachedMaterial(`epoxy:${color}:${roughness}`, () => {
    const m = new THREE.MeshPhysicalMaterial({
      color,
      roughness,
      metalness: 0.0,
      clearcoat: 0.25,
      clearcoatRoughness: 0.4,
    })
    const n = noiseNormalTexture()
    if (n) {
      m.normalMap = n
      m.normalScale.set(0.1, 0.1)
    }
    return m
  })
}

/**
 * PVC jumper-wire insulation. Exported for the wires/scene owner to adopt
 * (wire meshes themselves live in scene.ts — not built here).
 */
export function makeWireMaterial(colorHex: number | string): THREE.MeshPhysicalMaterial {
  const c = new THREE.Color(colorHex)
  return cachedMaterial(`wire:${c.getHexString()}`, () => {
    const m = new THREE.MeshPhysicalMaterial({
      color: c,
      roughness: 0.4,
      metalness: 0.0,
      clearcoat: 0.15,
      clearcoatRoughness: 0.35,
    })
    return m
  })
}

// ---------------------------------------------------------------------------
// Static-part merging (draw-call budget)
// ---------------------------------------------------------------------------

/**
 * Merge static (never re-posed, never material-swapped) parts into as few
 * meshes as possible — one mesh per distinct material. `parts` are detached
 * objects/groups positioned in the CALLER's coordinate space; all transforms
 * (nested groups included) are baked into per-instance merged geometries.
 * Cached/shared source geometries are cloned first, so the merged output is
 * always per-instance and safely disposable; materials pass through
 * untouched, so the shared material cache keeps working.
 *
 * Anything whose transform changes later (pot screws), whose material is
 * swapped per state (7-seg wafers), or that needs its own render-order
 * treatment (transparent labels/glass) must NOT go through here.
 *
 * Why: at ~100 parts the unmerged builders averaged ~16 meshes/part — ~1,900
 * draw calls/frame, a real mid-range-phone risk against the DESIGN §7 60 fps
 * bar. Merging the static metalwork/plastic of the heavy builders (DIPs,
 * displays, instrument boxes) cuts their mesh counts ~3-4× with identical
 * triangles.
 */
export function mergeStatic(parts: THREE.Object3D[]): THREE.Mesh[] {
  const byMat = new Map<THREE.Material, THREE.BufferGeometry[]>()
  const collect = (o: THREE.Object3D, parent: THREE.Matrix4): void => {
    o.updateMatrix()
    const world = new THREE.Matrix4().multiplyMatrices(parent, o.matrix)
    const mesh = o as THREE.Mesh
    if (mesh.isMesh && mesh.geometry && !Array.isArray(mesh.material)) {
      // non-indexed normalization (TubeGeometry/CylinderGeometry are indexed,
      // ExtrudeGeometry is not — mergeGeometries refuses mixed inputs)
      const g = mesh.geometry.index ? mesh.geometry.toNonIndexed() : mesh.geometry.clone()
      g.applyMatrix4(world)
      const list = byMat.get(mesh.material)
      if (list) list.push(g)
      else byMat.set(mesh.material, [g])
    }
    for (const child of o.children) collect(child, world)
  }
  const identity = new THREE.Matrix4()
  for (const p of parts) collect(p, identity)
  const out: THREE.Mesh[] = []
  for (const [mat, geos] of byMat) {
    const merged = geos.length === 1 ? geos[0] : mergeGeometries(geos, false)
    if (merged) {
      out.push(new THREE.Mesh(merged, mat))
    } else {
      // attribute-set mismatch (never expected): fall back, never lose parts
      for (const g of geos) out.push(new THREE.Mesh(g, mat))
    }
  }
  return out
}

/** One input of bakeMergedGeometry. */
export interface MergePart {
  geometry: THREE.BufferGeometry
  /** optional transform baked into this part's vertices */
  matrix?: THREE.Matrix4
  /** optional per-part tint written as a vertex-color attribute */
  color?: number
}

/**
 * Bake several (possibly transformed, possibly tinted) geometries into ONE
 * BufferGeometry. Inputs are cloned first — cached/shared source geometries
 * stay pristine. When ANY part carries a `color`, every vertex gets a color
 * attribute (parts without one default to white) — pair the result with a
 * `vertexColors: true` material whose base color is white: each region then
 * shades exactly as it would with `material.color` set to its tint (colors
 * pass through the same sRGB→linear conversion), and the path tracer applies
 * the attribute too (verified: three-gpu-pathtracer 0.0.23 multiplies albedo
 * by vertex color when material.vertexColors is set).
 *
 * Why: parts like the resistor's color bands are look-identical materials
 * differing ONLY in color — merging them under one vertex-colored material
 * turns 3–4 draw calls into one. Callers should wrap the result in
 * `cachedGeometry` whenever the inputs are deterministic (shared, never
 * disposed); un-cached results are per-instance and disposable.
 */
export function bakeMergedGeometry(parts: MergePart[]): THREE.BufferGeometry {
  const useColor = parts.some((p) => p.color !== undefined)
  let geos = parts.map((p) => {
    const g = p.geometry.clone()
    if (p.matrix) g.applyMatrix4(p.matrix)
    if (useColor) {
      const c = new THREE.Color(p.color ?? 0xffffff)
      const n = g.getAttribute('position').count
      // RGBA, alpha 1 — NOT itemSize 3: the path tracer pads meshes that lack
      // vertex colors with itemSize-4 white and merges attributes at the
      // FIRST geometry's itemSize, copying only the components the source
      // has. A 3-component band attribute merged into that 4-component
      // target would leave alpha = 0 and `albedo *= vertexColor` would erase
      // the bands from every Studio still. Alpha 1 is inert in the raster
      // modes too (the material is opaque; 1×1 multiplications throughout).
      const arr = new Float32Array(n * 4)
      for (let i = 0; i < n; i++) {
        arr[i * 4] = c.r
        arr[i * 4 + 1] = c.g
        arr[i * 4 + 2] = c.b
        arr[i * 4 + 3] = 1
      }
      g.setAttribute('color', new THREE.BufferAttribute(arr, 4))
    }
    return g
  })
  // mergeGeometries refuses mixed indexed/non-indexed inputs
  if (!geos.every((g) => !!g.index)) {
    geos = geos.map((g) => (g.index ? g.toNonIndexed() : g))
  }
  // ... and mismatched attribute sets: keep only the common channels
  const common = geos
    .map((g) => new Set(Object.keys(g.attributes)))
    .reduce((a, b) => new Set([...a].filter((k) => b.has(k))))
  for (const g of geos) {
    for (const name of Object.keys(g.attributes)) {
      if (!common.has(name)) g.deleteAttribute(name)
    }
  }
  const merged = mergeGeometries(geos, false)
  if (merged) return merged
  // unreachable in practice (attributes normalized above) — never lose parts
  return geos[0]
}

// ---------------------------------------------------------------------------
// Bent-wire legs
// ---------------------------------------------------------------------------

/**
 * Rounded polyline through `points`: straight segments with quadratic-bezier
 * fillets at every interior corner. Used as the spine of TubeGeometry legs.
 */
export function roundedPath(points: THREE.Vector3[], fillet = 0.18): THREE.CurvePath<THREE.Vector3> {
  const path = new THREE.CurvePath<THREE.Vector3>()
  if (points.length < 2) {
    const p = points[0] ?? new THREE.Vector3()
    path.add(new THREE.LineCurve3(p.clone(), p.clone().add(new THREE.Vector3(0, 0.01, 0))))
    return path
  }
  let prev = points[0].clone()
  for (let i = 1; i < points.length - 1; i++) {
    const cur = points[i]
    const next = points[i + 1]
    const dIn = cur.clone().sub(prev)
    const dOut = next.clone().sub(cur)
    const lIn = dIn.length()
    const lOut = dOut.length()
    if (lIn < 1e-6 || lOut < 1e-6) continue
    const f = Math.min(fillet, lIn / 2, lOut / 2)
    const inPt = cur.clone().addScaledVector(dIn.normalize(), -f)
    const outPt = cur.clone().addScaledVector(dOut.normalize(), f)
    if (inPt.distanceTo(prev) > 1e-6) path.add(new THREE.LineCurve3(prev, inPt))
    path.add(new THREE.QuadraticBezierCurve3(inPt, cur.clone(), outPt))
    prev = outPt
  }
  const last = points[points.length - 1].clone()
  if (last.distanceTo(prev) > 1e-6) path.add(new THREE.LineCurve3(prev, last))
  return path
}

/**
 * A bent wire leg following `points` (world space). TubeGeometry ends are
 * OPEN rings — any end that finishes above the board surface gets a small
 * sphere cap (ends at/below y≈0 are buried inside the hole plug and skipped),
 * so a leg can never show a hollow tube mouth at inspection zoom.
 */
export function legMesh(
  points: THREE.Vector3[],
  radius = LEG_RADIUS,
  material: THREE.Material = metal(),
): THREE.Group {
  const path = roundedPath(points)
  const segments = Math.min(44, Math.max(16, points.length * 10))
  const geo = new THREE.TubeGeometry(path, segments, radius, 8, false)
  const group = new THREE.Group()
  group.add(new THREE.Mesh(geo, material))
  const capGeo = cachedGeometry(
    `legcap:${radius}`,
    () => new THREE.SphereGeometry(radius, 8, 6),
  )
  for (const end of [points[0], points[points.length - 1]]) {
    if (end && end.y > 0.02) {
      const cap = new THREE.Mesh(capGeo, material)
      cap.position.copy(end)
      group.add(cap)
    }
  }
  return group
}

/** Convenience: points for a leg that starts inside the hole at `pin`. */
export function fromHole(pin: THREE.Vector3, ...rest: THREE.Vector3[]): THREE.Vector3[] {
  return [new THREE.Vector3(pin.x, HOLE_DEPTH, pin.z), ...rest]
}

/** Straight vertical pin from inside the hole up to `topY` (cached geometry). */
export function pinLeg(pin: THREE.Vector3, topY: number, radius = LEG_RADIUS): THREE.Mesh {
  const h = topY - HOLE_DEPTH
  const geo = cachedGeometry(
    `pinleg:${radius}:${h.toFixed(3)}`,
    () => new THREE.CylinderGeometry(radius, radius, h, 8),
  )
  const m = new THREE.Mesh(geo, metal())
  m.position.set(pin.x, HOLE_DEPTH + h / 2, pin.z)
  return m
}

/**
 * Gull-wing DIP leg: a flat stamped-metal shoulder leaves the package side at
 * `enterY`, reaches `reach` outward, drops vertically and necks into a thin
 * foot that enters the hole. `zc` = the package centerline (the leg bends away
 * from it). Returns a group positioned at the pin.
 */
export function gullWingLeg(
  pin: THREE.Vector3,
  zc: number,
  opts: { enterY?: number; reach?: number; width?: number } = {},
): THREE.Group {
  const enterY = opts.enterY ?? 0.55
  const reach = Math.max(0.16, opts.reach ?? 0.28)
  const width = opts.width ?? 0.34
  const ht = 0.045 // half thickness of the stamped metal
  const ch = 0.07 // chamfer at the outer bend
  const geo = cachedGeometry(
    `gullwing:${reach.toFixed(2)}:${enterY.toFixed(2)}:${width}`,
    () => {
      // side profile in (x = outward from body, y = up); drop centered at x=0
      const s = new THREE.Shape()
      s.moveTo(-reach, enterY - ht)
      s.lineTo(-ht, enterY - ht)
      s.lineTo(-ht, 0.04)
      s.lineTo(ht, 0.04)
      s.lineTo(ht, enterY + ht - ch)
      s.lineTo(ht - ch, enterY + ht)
      s.lineTo(-reach, enterY + ht)
      s.closePath()
      const g = new THREE.ExtrudeGeometry(s, { depth: width, bevelEnabled: false, curveSegments: 4 })
      g.translate(0, 0, -width / 2)
      return g
    },
  )
  const group = new THREE.Group()
  const wing = new THREE.Mesh(geo, metal())
  // profile +x must point away from the package centerline
  const side = pin.z >= zc ? 1 : -1
  wing.rotation.y = side > 0 ? -Math.PI / 2 : Math.PI / 2
  wing.position.set(pin.x, 0, pin.z)
  group.add(wing)
  group.add(pinLeg(pin, 0.15, 0.06)) // narrow foot into the hole
  return group
}

// ---------------------------------------------------------------------------
// Frames (orienting a body along the line between two pins)
// ---------------------------------------------------------------------------

export interface Frame {
  mid: THREE.Vector3
  /** unit vector a→b (horizontal) */
  dir: THREE.Vector3
  /** horizontal unit vector perpendicular to dir */
  perp: THREE.Vector3
  /** rotation.y that maps local +X onto `dir` */
  angleY: number
  dist: number
}

export function frameBetween(a: THREE.Vector3, b: THREE.Vector3): Frame {
  const mid = a.clone().add(b).multiplyScalar(0.5)
  const d = b.clone().sub(a)
  d.y = 0
  const dist = d.length()
  const dir = dist > 1e-6 ? d.multiplyScalar(1 / dist) : new THREE.Vector3(1, 0, 0)
  const perp = new THREE.Vector3(dir.z, 0, -dir.x)
  return { mid, dir, perp, angleY: Math.atan2(-dir.z, dir.x), dist }
}

export function centroidOf(points: THREE.Vector3[]): THREE.Vector3 {
  const c = new THREE.Vector3()
  for (const p of points) c.add(p)
  if (points.length) c.divideScalar(points.length)
  return c
}

// ---------------------------------------------------------------------------
// Routed component poses (router-planned body placement + lead paths)
// ---------------------------------------------------------------------------

/**
 * Sanitized routed pose for a 2/3-lead part, converted to world Vector3s.
 * `legs[i]` is the lead path for catalog pin i, ordered hole end FIRST and
 * guaranteed to start inside the hole (HOLE_DEPTH) at the pin position.
 */
export interface RoutedPose {
  pose: 'span' | 'vertical'
  center: THREE.Vector3
  /** unit body-axis direction (lead 0 → lead 1 for axial parts) */
  dir: THREE.Vector3
  legs: THREE.Vector3[][]
}

const finite = (v: { x: number; y: number; z: number }) =>
  Number.isFinite(v.x) && Number.isFinite(v.y) && Number.isFinite(v.z)

/**
 * Validate + normalize a RoutedComponent against the catalog pin positions.
 * Returns null when anything is malformed — callers then take their normal
 * (pins-derived) fallback path, so a bad route can never crash a build.
 */
export function routedPoseFor(
  routed: RoutedComponent | undefined,
  pins: THREE.Vector3[],
  legCount: number,
): RoutedPose | null {
  if (!routed) return null
  if (!finite(routed.bodyCenter) || !finite(routed.bodyDir)) return null
  if (!Array.isArray(routed.waypoints) || routed.waypoints.length < legCount) return null
  const dir = new THREE.Vector3(routed.bodyDir.x, routed.bodyDir.y, routed.bodyDir.z)
  if (dir.lengthSq() < 1e-8) return null
  dir.normalize()

  const legs: THREE.Vector3[][] = []
  for (let i = 0; i < legCount; i++) {
    const pin = pins[i]
    const wp = routed.waypoints[i]
    if (!pin || !Array.isArray(wp) || wp.length < 2) return null
    const path: THREE.Vector3[] = []
    for (const p of wp) {
      if (!finite(p)) return null
      const v = new THREE.Vector3(p.x, p.y, p.z)
      // drop coincident points (degenerate curve segments)
      if (path.length === 0 || path[path.length - 1].distanceToSquared(v) > 1e-8) path.push(v)
    }
    if (path.length < 2) return null
    // hole end first: the end nearer (in plan) to this pin's hole
    const d0 = (path[0].x - pin.x) ** 2 + (path[0].z - pin.z) ** 2
    const dn =
      (path[path.length - 1].x - pin.x) ** 2 + (path[path.length - 1].z - pin.z) ** 2
    if (dn < d0) path.reverse()
    // guarantee the lead actually enters the hole (vertical final descent)
    const start = path[0]
    const overHole = Math.hypot(start.x - pin.x, start.z - pin.z) < 1e-3
    if (!overHole) path.unshift(new THREE.Vector3(pin.x, Math.min(start.y, 0.3), pin.z))
    if (path[0].y > HOLE_DEPTH + 1e-3) {
      path.unshift(new THREE.Vector3(pin.x, HOLE_DEPTH, pin.z))
    }
    legs.push(path)
  }
  const pose: 'span' | 'vertical' =
    routed.pose === 'vertical' || (routed.pose !== 'span' && Math.abs(dir.y) > 0.6)
      ? 'vertical'
      : 'span'
  return {
    pose,
    center: new THREE.Vector3(routed.bodyCenter.x, routed.bodyCenter.y, routed.bodyCenter.z),
    dir,
    legs,
  }
}

/** Distance along the body axis between the two outer legs' body-end points. */
export function routedAxialLength(rp: RoutedPose): number {
  const a = rp.legs[0]?.[rp.legs[0].length - 1]
  const b = rp.legs[rp.legs.length - 1]?.[rp.legs[rp.legs.length - 1].length - 1]
  if (!a || !b) return 0
  return Math.abs(b.clone().sub(a).dot(rp.dir))
}

/**
 * Extend a leg path's body end slightly INTO the body so the (capped) tube
 * terminates inside it — no seam or gap where lead meets body. `axis` given:
 * push inward along the body axis (axial parts); otherwise push toward
 * `center` (standing parts whose leads enter the underside).
 */
export function extendIntoBody(
  path: THREE.Vector3[],
  center: THREE.Vector3,
  axis: THREE.Vector3 | null,
  depth = 0.15,
): void {
  const last = path[path.length - 1]
  if (!last) return
  let inward: THREE.Vector3
  if (axis) {
    const s = last.clone().sub(center).dot(axis)
    inward = axis.clone().multiplyScalar(s >= 0 ? -1 : 1)
  } else {
    inward = center.clone().sub(last)
    if (inward.lengthSq() < 1e-8) return
    inward.normalize()
  }
  path.push(last.clone().addScaledVector(inward, depth))
}

const X_AXIS = new THREE.Vector3(1, 0, 0)

/** Orient `obj` (at `center`) so its local +X maps onto the body axis `dir`. */
export function alignFrameToAxis(
  obj: THREE.Object3D,
  center: THREE.Vector3,
  dir: THREE.Vector3,
): void {
  obj.position.copy(center)
  obj.quaternion.setFromUnitVectors(X_AXIS, dir)
}

/** rotation.y for a standing part facing along the horizontal part of `dir`. */
export function yawOf(dir: THREE.Vector3, fallback: number): number {
  const h = Math.hypot(dir.x, dir.z)
  if (h < 0.2) return fallback // near-vertical axis: keep the pins-derived yaw
  return Math.atan2(-dir.z / h, dir.x / h)
}

// ---------------------------------------------------------------------------
// Canvas text / textures
// ---------------------------------------------------------------------------

export interface TextTexOpts {
  w?: number
  h?: number
  font?: string
  fg?: string
  /** null = transparent background */
  bg?: string | null
}

const texCache = new Map<string, THREE.CanvasTexture | null>()

/** Cached canvas texture with centered text. Returns null when no DOM. */
export function textTexture(text: string, opts: TextTexOpts = {}): THREE.CanvasTexture | null {
  const key = `${text}|${opts.w}|${opts.h}|${opts.font}|${opts.fg}|${opts.bg}`
  if (texCache.has(key)) return texCache.get(key) ?? null
  const tex = makeTextTexture(text, opts)
  if (tex) sharedResources.add(tex)
  texCache.set(key, tex)
  return tex
}

function makeTextTexture(text: string, opts: TextTexOpts): THREE.CanvasTexture | null {
  if (typeof document === 'undefined') return null
  const w = opts.w ?? 256
  const h = opts.h ?? 64
  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  const ctx = canvas.getContext('2d')
  if (!ctx) return null
  if (opts.bg) {
    ctx.fillStyle = opts.bg
    ctx.fillRect(0, 0, w, h)
  } else {
    ctx.clearRect(0, 0, w, h)
  }
  ctx.fillStyle = opts.fg ?? '#e8e8e8'
  ctx.font = opts.font ?? `bold ${Math.floor(h * 0.62)}px "Helvetica Neue", Arial, sans-serif`
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.fillText(text, w / 2, h / 2 + 1)
  const tex = new THREE.CanvasTexture(canvas)
  tex.colorSpace = THREE.SRGBColorSpace
  tex.anisotropy = 4
  return tex
}

/** Cached unlit label material (white text on transparent). */
export function labelMaterial(text: string, opts: TextTexOpts = {}): THREE.MeshBasicMaterial | null {
  const tex = textTexture(text, opts)
  if (!tex) return null
  return cachedMaterial(
    `label:${text}|${opts.w}|${opts.h}|${opts.font}|${opts.fg}|${opts.bg}`,
    () => new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false }),
  )
}

/**
 * Flat label lying on a top face (plane rotated into the XZ plane, text top
 * pointing toward -Z, readable in plan view).
 */
export function topLabel(text: string, w: number, h: number, opts: TextTexOpts = {}): THREE.Mesh | null {
  const mat = labelMaterial(text, opts)
  if (!mat) return null
  const geo = cachedGeometry(`toplabel:${w.toFixed(2)}x${h.toFixed(2)}`, () => {
    const g = new THREE.PlaneGeometry(w, h)
    g.rotateX(-Math.PI / 2)
    return g
  })
  return new THREE.Mesh(geo, mat)
}

/**
 * Laser-etched IC marking: part code + a fake date/lot code line, rendered to
 * a high-res CanvasTexture pair (color map + matching bumpMap so the text
 * reads slightly engraved). Cached/shared per text content.
 */
export function etchedLabelMaterial(lines: string[], aspect = 3.2): THREE.MeshStandardMaterial | null {
  if (typeof document === 'undefined') return null
  const key = `etched:${lines.join(' ')}|${aspect.toFixed(2)}`
  const cached = matCache.get(key)
  if (cached) return cached as THREE.MeshStandardMaterial

  const w = 512
  const h = Math.max(96, Math.round(w / aspect))
  const draw = (ctx: CanvasRenderingContext2D, fg1: string, fg2: string, bg: string | null) => {
    if (bg) {
      ctx.fillStyle = bg
      ctx.fillRect(0, 0, w, h)
    } else {
      ctx.clearRect(0, 0, w, h)
    }
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    const line2 = lines[1]
    ctx.fillStyle = fg1
    ctx.font = `bold ${Math.floor(h * (line2 ? 0.4 : 0.52))}px "Helvetica Neue", Arial, sans-serif`
    ctx.fillText(lines[0] ?? '', w / 2, h * (line2 ? 0.32 : 0.5))
    if (line2) {
      ctx.fillStyle = fg2
      ctx.font = `${Math.floor(h * 0.24)}px "Helvetica Neue", Arial, sans-serif`
      ctx.fillText(line2, w / 2, h * 0.72)
    }
  }
  const colorCanvas = document.createElement('canvas')
  colorCanvas.width = w
  colorCanvas.height = h
  const colorCtx = colorCanvas.getContext('2d')
  if (!colorCtx) return null
  // etched text: slightly darker than bare epoxy sheen → light gray, dim 2nd line
  draw(colorCtx, '#c9c9cd', '#8e8e94', null)
  const map = new THREE.CanvasTexture(colorCanvas)
  map.colorSpace = THREE.SRGBColorSpace
  map.anisotropy = 4
  sharedResources.add(map)

  const bumpCanvas = document.createElement('canvas')
  bumpCanvas.width = w
  bumpCanvas.height = h
  const bumpCtx = bumpCanvas.getContext('2d')
  let bump: THREE.CanvasTexture | null = null
  if (bumpCtx) {
    // engraved: text darker than the surround on the height map
    draw(bumpCtx, '#2c2c2c', '#3c3c3c', '#9e9e9e')
    bump = new THREE.CanvasTexture(bumpCanvas)
    sharedResources.add(bump)
  }

  const mat = new THREE.MeshStandardMaterial({
    map,
    transparent: true,
    depthWrite: false,
    roughness: 0.55,
    metalness: 0,
  })
  if (bump) {
    mat.bumpMap = bump
    mat.bumpScale = 0.6
  }
  sharedResources.add(mat)
  matCache.set(key, mat)
  return mat
}

/** Deterministic fake date/lot code for IC markings (e.g. "2342 K57"). */
export function fakeLotCode(code: string): string {
  let hsh = 0
  for (let i = 0; i < code.length; i++) hsh = (hsh * 33 + code.charCodeAt(i)) | 0
  hsh = Math.abs(hsh)
  const year = 21 + (hsh % 5)
  const week = String((hsh % 52) + 1).padStart(2, '0')
  const lot = `${String.fromCharCode(65 + (hsh % 26))}${(hsh % 90) + 10}`
  return `${year}${week} ${lot}`
}

/** Short part code from a catalog label: "(2N3904)" → "2N3904", else first word. */
export function shortLabel(entry: CatalogEntry): string {
  const par = /\(([^)]+)\)/.exec(entry.label)
  if (par) return par[1]
  return entry.label.split(/\s+/)[0]
}

// ---------------------------------------------------------------------------
// Misc formatting
// ---------------------------------------------------------------------------

export function formatHz(f: number): string {
  if (!Number.isFinite(f)) return '? Hz'
  if (f >= 1e6) return `${trimNum(f / 1e6)} MHz`
  if (f >= 1e3) return `${trimNum(f / 1e3)} kHz`
  return `${trimNum(f)} Hz`
}

function trimNum(v: number): string {
  const s = v >= 100 ? v.toFixed(0) : v >= 10 ? v.toFixed(1) : v.toFixed(2)
  return s.includes('.') ? s.replace(/0+$/, '').replace(/\.$/, '') : s
}

export function nowMs(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now()
}
