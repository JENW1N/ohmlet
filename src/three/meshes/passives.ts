/**
 * Passive two/three-lead parts: resistor, capacitor, inductor, potentiometer,
 * photoresistor (LDR), diode.
 *
 * Phase C asset redo — every body is rebuilt against reference photos of the
 * canonical real part (1/4W carbon film, 1N4148 glass diode, Bourns 3296
 * trimmer, amber-glazed ceramic disc, sleeved aluminum electrolytic, drum-core
 * axial inductor, CdS photoresistor). Materials are physically plausible (no
 * fake emissive, no transmission — that stays LEDs-only per the perf budget);
 * silhouette features are real geometry, prints/scores are textures only.
 */

import * as THREE from 'three'
import type { ComponentInstance } from '../../model/types'
import type { CatalogEntry } from '../../model/catalog'
import { paramOf } from '../../model/catalog'
import type { RoutedComponent } from '../internal/wire-router'
import {
  BuildResult,
  alignFrameToAxis,
  bakeMergedGeometry,
  brushedRoughnessTexture,
  cachedGeometry,
  cachedMaterial,
  centroidOf,
  extendIntoBody,
  frameBetween,
  fromHole,
  labelMaterial,
  legMesh,
  markShared,
  mergeStatic,
  pinLeg,
  plastic,
  roundedPath,
  routedAxialLength,
  routedPoseFor,
  textTexture,
  yawOf,
} from './shared'

// ---------------------------------------------------------------------------
// Resistor color code
// ---------------------------------------------------------------------------

const DIGIT_COLORS = [
  0x12100e, // 0 black
  0x7b4a12, // 1 brown
  0xc62828, // 2 red
  0xe65100, // 3 orange
  0xf2c230, // 4 yellow
  0x2e7d32, // 5 green
  0x1565c0, // 6 blue
  0x7b1fa2, // 7 violet
  0x8d8d8d, // 8 gray
  0xf5f5f5, // 9 white
]
const GOLD = 0xc9a227
const SILVER = 0xc4c4c4

/** [digit1, digit2, multiplier, tolerance] band colors for a resistance. */
export function resistorBandColors(r: number): [number, number, number, number] {
  if (!(r > 0) || !Number.isFinite(r)) {
    return [DIGIT_COLORS[0], DIGIT_COLORS[0], DIGIT_COLORS[0], GOLD]
  }
  let exp = Math.floor(Math.log10(r))
  let m2 = Math.round(r / Math.pow(10, exp - 1))
  if (m2 >= 100) {
    m2 = Math.round(m2 / 10)
    exp += 1
  }
  if (m2 < 10) m2 = 10
  const d1 = Math.floor(m2 / 10)
  const d2 = m2 % 10
  const mult = exp - 1
  const multColor = mult >= 0 && mult <= 9 ? DIGIT_COLORS[mult] : mult === -1 ? GOLD : SILVER
  return [DIGIT_COLORS[d1], DIGIT_COLORS[d2], multColor, GOLD]
}

// ---------------------------------------------------------------------------
// Resistor
// ---------------------------------------------------------------------------

/**
 * Carbon-film body lacquer: warm tan with the thin glossy dip-coat sheen the
 * reference macros show (clearly NOT matte ceramic — highlights roll across
 * the bands and body alike).
 */
function resistorLacquer(): THREE.MeshPhysicalMaterial {
  return cachedMaterial('res-ceramic', () =>
    new THREE.MeshPhysicalMaterial({
      color: 0xb08a58, // reads as the photo's tan once the bright IBL lifts it
      roughness: 0.38,
      metalness: 0,
      clearcoat: 0.55,
      clearcoatRoughness: 0.32,
    }),
  )
}

/**
 * Paint for the color bands — same dip-lacquer sheen as the body (the coat
 * goes over the bands). The gold/silver tolerance bands are metallic paint.
 */
function bandPaint(color: number, metalness = 0): THREE.MeshPhysicalMaterial {
  return cachedMaterial(`res-band-paint:${color}:${metalness}`, () =>
    new THREE.MeshPhysicalMaterial({
      color,
      roughness: 0.35,
      metalness,
      clearcoat: 0.5,
      clearcoatRoughness: 0.25,
    }),
  )
}

/**
 * Vertex-colored variant of the flat band paint (identical spec, white base):
 * ALL the non-metallic bands of a resistor merge into ONE mesh under this one
 * shared material, the per-band tint riding in the vertex color channel —
 * same sRGB→linear conversion as material.color, so each band shades exactly
 * as it did with its own bandPaint(color). Phase D draw-call budget: bands
 * were 4 draws on the most numerous part of every dense board.
 */
function flatBandPaint(): THREE.MeshPhysicalMaterial {
  return cachedMaterial('res-band-paint-vc', () =>
    new THREE.MeshPhysicalMaterial({
      color: 0xffffff,
      vertexColors: true,
      roughness: 0.35,
      metalness: 0,
      clearcoat: 0.5,
      clearcoatRoughness: 0.25,
    }),
  )
}

const RES_R_CAP = 0.4
const RES_R_WAIST = 0.33
/** color bands ride STRICTLY proud of the local body surface (≥ 0.015 spec) */
const BAND_PROUD = 0.016
/** real 1/4W lead gauge ≈ 0.55 mm — clearly slimmer than the body end caps */
const RES_LEAD_R = 0.06

function resistorCapLen(L: number): number {
  return Math.min(0.42, L * 0.24)
}

/**
 * Dog-bone lathe profile as piecewise-linear [x, radius] (x ascending along
 * the body axis). Ends are CLOSED down to r=0.065 (just under the lead, which
 * overlaps it) — an open end ring would show a gap around the lead close up.
 */
export function resistorProfile(L: number): [number, number][] {
  const cl = resistorCapLen(L)
  return [
    [-L / 2, 0.065],
    [-L / 2 + cl * 0.14, RES_R_CAP * 0.82],
    [-L / 2 + cl * 0.5, RES_R_CAP],
    [-L / 2 + cl * 0.9, RES_R_CAP * 0.97],
    [-L / 2 + cl * 1.45, RES_R_WAIST],
    [L / 2 - cl * 1.45, RES_R_WAIST],
    [L / 2 - cl * 0.9, RES_R_CAP * 0.97],
    [L / 2 - cl * 0.5, RES_R_CAP],
    [L / 2 - cl * 0.14, RES_R_CAP * 0.82],
    [L / 2, 0.065],
  ]
}

/** Body radius at axial position x (linear interpolation over the profile). */
export function resistorRadiusAt(L: number, x: number): number {
  const prof = resistorProfile(L)
  if (x <= prof[0][0]) return prof[0][1]
  for (let i = 1; i < prof.length; i++) {
    if (x <= prof[i][0]) {
      const [x0, r0] = prof[i - 1]
      const [x1, r1] = prof[i]
      const t = x1 > x0 ? (x - x0) / (x1 - x0) : 1
      return r0 + (r1 - r0) * t
    }
  }
  return prof[prof.length - 1][1]
}

/** Band centers + width for a body length: clear of the end-cap rolls. */
export function resistorBandLayout(L: number): { xs: number[]; w: number } {
  const margin = resistorCapLen(L) * 0.5 + 0.1
  const half = Math.max(0.2, L / 2 - margin)
  const w = THREE.MathUtils.clamp(half / 3.4, 0.09, 0.13)
  return { xs: [-0.78, -0.36, 0.06, 0.78].map((fr) => fr * half), w }
}

/**
 * One color band: a lathe ring that FOLLOWS the dog-bone surface at +BAND_PROUD
 * everywhere under the band, with its edges dipped back inside the body. A
 * constant-radius cylinder would cross the cap bulge exactly at the body
 * surface on short (two-hole) resistors → coplanar ring → flicker.
 */
function resistorBandGeometry(L: number, bx: number, w: number): THREE.BufferGeometry {
  return cachedGeometry(`res-band:${L.toFixed(2)}:${bx.toFixed(3)}:${w.toFixed(3)}`, () => {
    const x0 = bx - w / 2
    const x1 = bx + w / 2
    const pts: THREE.Vector2[] = [new THREE.Vector2(resistorRadiusAt(L, x0) - 0.05, x0)]
    const N = 5
    for (let i = 0; i <= N; i++) {
      const x = x0 + ((x1 - x0) * i) / N
      pts.push(new THREE.Vector2(resistorRadiusAt(L, x) + BAND_PROUD, x))
    }
    pts.push(new THREE.Vector2(resistorRadiusAt(L, x1) - 0.05, x1))
    const g = new THREE.LatheGeometry(pts, 16)
    g.rotateZ(-Math.PI / 2) // lathe axis Y → local X (profile x baked in)
    return g
  })
}

export function buildResistor(
  comp: ComponentInstance,
  entry: CatalogEntry,
  pins: THREE.Vector3[],
  routed?: RoutedComponent,
): BuildResult {
  const group = new THREE.Group()
  const [a, b] = [pins[0], pins[1]]
  const f = frameBetween(a, b)
  const rp = routedPoseFor(routed, pins, 2)
  const bodyY = 0.55

  const frame = new THREE.Group()
  let bodyLen: number
  if (rp) {
    // router-planned pose: body at bodyCenter along bodyDir ('span' level runs
    // and 'vertical' stand-up mounts alike — tilt is encoded in the axis)
    const span = routedAxialLength(rp)
    bodyLen = THREE.MathUtils.clamp(span > 0.05 ? span : 1.7, 0.9, 2.4)
    alignFrameToAxis(frame, rp.center, rp.dir)
  } else {
    bodyLen = THREE.MathUtils.clamp(f.dist - 0.8, 0.9, 2.4)
    frame.position.set(f.mid.x, bodyY, f.mid.z)
    frame.rotation.y = f.angleY
  }

  // body + the two lacquer meniscus collars (the menisci where the leads exit
  // the end bumps) bake into ONE cached lacquer mesh. Phase D draw budget:
  // resistors are the most numerous part on dense boards — date-display's 28
  // of them cost 196 draws/frame before this merge pass, ~112 after.
  const bodyGeo = cachedGeometry(`res-body:${bodyLen.toFixed(2)}`, () => {
    const pts = resistorProfile(bodyLen).map(([x, r]) => new THREE.Vector2(r, x))
    const lathe = new THREE.LatheGeometry(pts, 24)
    lathe.rotateZ(-Math.PI / 2) // lathe axis Y → local X
    const collar = new THREE.CylinderGeometry(0.075, 0.15, 0.1, 12)
    collar.rotateZ(-Math.PI / 2) // narrow end → +X (outward)
    const atPlusEnd = new THREE.Matrix4().makeTranslation(bodyLen / 2 - 0.03, 0, 0)
    const atMinusEnd = new THREE.Matrix4().makeRotationY(Math.PI)
    atMinusEnd.setPosition(-(bodyLen / 2 - 0.03), 0, 0)
    return bakeMergedGeometry([
      { geometry: lathe },
      { geometry: collar, matrix: atPlusEnd },
      { geometry: collar, matrix: atMinusEnd },
    ])
  })
  frame.add(new THREE.Mesh(bodyGeo, resistorLacquer()))

  const resistance = Number(paramOf(comp.params, entry, 'resistance') ?? 1000)
  const bands = resistorBandColors(resistance)
  const layout = resistorBandLayout(bodyLen)
  // fewest band meshes that keep the exact look: flat paint bands differ only
  // by color → one vertex-colored mesh (flatBandPaint); metallic gold/silver
  // paint keeps its own material per color (metalness can't ride per-vertex)
  const flatBands: { i: number; color: number }[] = []
  const metallicBands = new Map<number, number[]>() // paint color → band indices
  for (let i = 0; i < 4; i++) {
    if (bands[i] === GOLD || bands[i] === SILVER) {
      const list = metallicBands.get(bands[i])
      if (list) list.push(i)
      else metallicBands.set(bands[i], [i])
    } else {
      flatBands.push({ i, color: bands[i] })
    }
  }
  // cached per (length, band slots, colors): deterministic → shared, like the
  // per-band geometries it replaces (repeated resistor values share buffers)
  if (flatBands.length > 0) {
    const key = `res-bands:${bodyLen.toFixed(2)}:${flatBands
      .map((b) => `${b.i}-${b.color.toString(16)}`)
      .join('.')}`
    const geo = cachedGeometry(key, () =>
      bakeMergedGeometry(
        flatBands.map((b) => ({
          geometry: resistorBandGeometry(bodyLen, layout.xs[b.i], layout.w),
          color: b.color,
        })),
      ),
    )
    frame.add(new THREE.Mesh(geo, flatBandPaint()))
  }
  for (const [color, indices] of metallicBands) {
    const geo =
      indices.length === 1
        ? resistorBandGeometry(bodyLen, layout.xs[indices[0]], layout.w)
        : cachedGeometry(`res-bands-met:${bodyLen.toFixed(2)}:${indices.join('.')}`, () =>
            bakeMergedGeometry(
              indices.map((i) => ({
                geometry: resistorBandGeometry(bodyLen, layout.xs[i], layout.w),
              })),
            ),
          )
    frame.add(new THREE.Mesh(geo, bandPaint(color, 0.8)))
  }

  const statics: THREE.Object3D[] = []
  group.add(frame)

  if (rp) {
    // smooth bent leads along the planned waypoints into the exact holes;
    // body ends buried so a vertical mount reads body-on-end + hairpin top
    for (const leg of rp.legs) {
      const path = leg.slice()
      extendIntoBody(path, rp.center, rp.dir, 0.18)
      statics.push(legMesh(path, RES_LEAD_R))
    }
  } else {
    const endA = f.mid.clone().addScaledVector(f.dir, -(bodyLen / 2 - 0.12)).setY(bodyY)
    const endB = f.mid.clone().addScaledVector(f.dir, bodyLen / 2 - 0.12).setY(bodyY)
    statics.push(legMesh(fromHole(a, new THREE.Vector3(a.x, bodyY, a.z), endA), RES_LEAD_R))
    statics.push(legMesh(fromHole(b, new THREE.Vector3(b.x, bodyY, b.z), endB), RES_LEAD_R))
  }
  for (const m of mergeStatic(statics)) group.add(m)

  return { object: group, pinWorld: pins.map((p) => p.clone()) }
}

// ---------------------------------------------------------------------------
// Diode — 1N4148: amber glass body, black cathode band, visible internals
// ---------------------------------------------------------------------------

const DIODE_R = 0.28

/**
 * Hermetic DO-35 glass: translucent amber (alpha-blended, NOT transmission —
 * that budget belongs to LEDs alone). The internals render in the opaque
 * pass first and show through the blend; depthWrite stays ON so the board's
 * transparent hole-collar pass can never stamp over the glass.
 */
function diodeGlass(): THREE.MeshPhysicalMaterial {
  return cachedMaterial('diode-glass', () =>
    new THREE.MeshPhysicalMaterial({
      color: 0xd2932a,
      roughness: 0.05,
      metalness: 0,
      ior: 1.5,
      clearcoat: 1.0,
      clearcoatRoughness: 0.06,
      transparent: true,
      opacity: 0.62,
      depthWrite: true,
    }),
  )
}

/** Glass body profile [x, radius]: rounded shoulders, closed onto the leads. */
function diodeProfile(L: number): [number, number][] {
  const sh = Math.min(0.26, L * 0.22) // shoulder roll length
  return [
    [-L / 2, 0.07],
    [-L / 2 + sh * 0.25, DIODE_R * 0.72],
    [-L / 2 + sh * 0.6, DIODE_R * 0.95],
    [-L / 2 + sh, DIODE_R],
    [L / 2 - sh, DIODE_R],
    [L / 2 - sh * 0.6, DIODE_R * 0.95],
    [L / 2 - sh * 0.25, DIODE_R * 0.72],
    [L / 2, 0.07],
  ]
}

function diodeRadiusAt(L: number, x: number): number {
  const prof = diodeProfile(L)
  if (x <= prof[0][0]) return prof[0][1]
  for (let i = 1; i < prof.length; i++) {
    if (x <= prof[i][0]) {
      const [x0, r0] = prof[i - 1]
      const [x1, r1] = prof[i]
      const t = x1 > x0 ? (x - x0) / (x1 - x0) : 1
      return r0 + (r1 - r0) * t
    }
  }
  return prof[prof.length - 1][1]
}

/** Cathode band ring following the glass surface, strictly proud (+0.02). */
function diodeBandGeometry(L: number, bx: number, w: number): THREE.BufferGeometry {
  return cachedGeometry(`diode-band:${L.toFixed(2)}:${bx.toFixed(3)}`, () => {
    const x0 = bx - w / 2
    const x1 = bx + w / 2
    const pts: THREE.Vector2[] = [new THREE.Vector2(diodeRadiusAt(L, x0) - 0.05, x0)]
    const N = 4
    for (let i = 0; i <= N; i++) {
      const x = x0 + ((x1 - x0) * i) / N
      pts.push(new THREE.Vector2(diodeRadiusAt(L, x) + 0.016, x))
    }
    pts.push(new THREE.Vector2(diodeRadiusAt(L, x1) - 0.05, x1))
    const g = new THREE.LatheGeometry(pts, 16)
    g.rotateZ(-Math.PI / 2)
    return g
  })
}

export function buildDiode(
  comp: ComponentInstance,
  entry: CatalogEntry,
  pins: THREE.Vector3[],
  routed?: RoutedComponent,
): BuildResult {
  const group = new THREE.Group()
  const [a, k] = [pins[0], pins[1]] // anode, cathode
  const f = frameBetween(a, k)
  const rp = routedPoseFor(routed, pins, 2)
  const bodyY = 0.45

  const frame = new THREE.Group()
  let bodyLen: number
  if (rp) {
    const span = routedAxialLength(rp)
    bodyLen = THREE.MathUtils.clamp(span > 0.05 ? span : 1.0, 0.7, 1.3)
    alignFrameToAxis(frame, rp.center, rp.dir)
  } else {
    bodyLen = THREE.MathUtils.clamp(f.dist - 0.8, 0.7, 1.3)
    frame.position.set(f.mid.x, bodyY, f.mid.z)
    frame.rotation.y = f.angleY
  }

  // --- internals first (opaque pass renders them through the glass) --------
  const slugMetal = cachedMaterial('diode-slug', () => {
    const m = new THREE.MeshPhysicalMaterial({ color: 0xb4b6ba, metalness: 1.0, roughness: 0.32 })
    const r = brushedRoughnessTexture()
    if (r) m.roughnessMap = r
    return m
  })
  // lead slugs reaching in from both glass ends (the dumet pins)
  const slugGeo = cachedGeometry(`diode-slug-geo:${bodyLen.toFixed(2)}`, () => {
    const g = new THREE.CylinderGeometry(0.1, 0.1, bodyLen * 0.3, 10)
    g.rotateZ(Math.PI / 2)
    return g
  })
  // internals merge per material (slugs + whisker → one metal mesh; the die
  // keeps its own near-black wafer material) — Phase D draw-call budget
  const frameStatics: THREE.Object3D[] = []
  for (const s of [-1, 1]) {
    const slug = new THREE.Mesh(slugGeo, slugMetal)
    slug.position.x = s * (bodyLen / 2 - bodyLen * 0.15 - 0.04)
    frameStatics.push(slug)
  }
  // the die wafer sits against the cathode slug face
  const dieGeo = cachedGeometry('diode-die', () => {
    const g = new THREE.CylinderGeometry(0.13, 0.13, 0.09, 10)
    g.rotateZ(Math.PI / 2)
    return g
  })
  const die = new THREE.Mesh(
    dieGeo,
    cachedMaterial('diode-die-mat', () =>
      new THREE.MeshStandardMaterial({ color: 0x17130e, roughness: 0.35, metalness: 0.2 }),
    ),
  )
  const dieX = bodyLen / 2 - bodyLen * 0.3 - 0.1
  die.position.x = dieX
  frameStatics.push(die)
  // the spring whisker arcing from the anode slug onto the die
  const whiskerGeo = cachedGeometry(`diode-whisker:${bodyLen.toFixed(2)}`, () => {
    const x0 = -(bodyLen / 2 - bodyLen * 0.3 - 0.04)
    const curve = new THREE.QuadraticBezierCurve3(
      new THREE.Vector3(x0, 0.02, 0),
      new THREE.Vector3((x0 + dieX) / 2, 0.12, 0.03),
      new THREE.Vector3(dieX - 0.06, 0.0, 0),
    )
    return new THREE.TubeGeometry(curve, 12, 0.022, 5, false)
  })
  frameStatics.push(new THREE.Mesh(whiskerGeo, slugMetal))
  for (const m of mergeStatic(frameStatics)) frame.add(m)

  // --- amber glass over the internals ---------------------------------------
  const bodyGeo = cachedGeometry(`diode-body:${bodyLen.toFixed(2)}`, () => {
    const pts = diodeProfile(bodyLen).map(([x, r]) => new THREE.Vector2(r, x))
    const g = new THREE.LatheGeometry(pts, 20)
    g.rotateZ(-Math.PI / 2)
    return g
  })
  frame.add(new THREE.Mesh(bodyGeo, diodeGlass()))

  // cathode band at the local +X end (pin order is [anode, cathode] → +X =
  // cathode; the routed bodyDir keeps the same lead-0 → lead-1 convention).
  const band = new THREE.Mesh(
    diodeBandGeometry(bodyLen, bodyLen / 2 - Math.min(0.26, bodyLen * 0.22) - 0.09, 0.14),
    bandPaint(0x191310),
  )
  frame.add(band)
  group.add(frame)

  const statics: THREE.Object3D[] = []
  if (rp) {
    for (const leg of rp.legs) {
      const path = leg.slice()
      extendIntoBody(path, rp.center, rp.dir, 0.15)
      statics.push(legMesh(path, 0.055))
    }
  } else {
    // leads terminate INSIDE the body, swallowed by the end shoulders
    const endA = f.mid.clone().addScaledVector(f.dir, -(bodyLen / 2 - 0.1)).setY(bodyY)
    const endK = f.mid.clone().addScaledVector(f.dir, bodyLen / 2 - 0.1).setY(bodyY)
    statics.push(legMesh(fromHole(a, new THREE.Vector3(a.x, bodyY, a.z), endA), 0.055))
    statics.push(legMesh(fromHole(k, new THREE.Vector3(k.x, bodyY, k.z), endK), 0.055))
  }
  for (const m of mergeStatic(statics)) group.add(m)

  return { object: group, pinWorld: pins.map((p) => p.clone()) }
}

// ---------------------------------------------------------------------------
// Capacitor (ceramic disc / electrolytic can)
// ---------------------------------------------------------------------------

export function buildCapacitor(
  comp: ComponentInstance,
  entry: CatalogEntry,
  pins: THREE.Vector3[],
  routed?: RoutedComponent,
): BuildResult {
  const polarized = paramOf(comp.params, entry, 'polarized') === true
  return polarized
    ? buildElectrolytic(comp, entry, pins, routed)
    : buildCeramicDisc(comp, entry, pins, routed)
}

/** EIA 3-digit pF code for a capacitance ("104" = 100nF). */
function capCode(farads: number): string {
  if (!(farads > 0) || !Number.isFinite(farads)) return '104'
  const pF = farads * 1e12
  const exp = Math.max(0, Math.floor(Math.log10(pF)) - 1)
  let mant = Math.round(pF / 10 ** exp)
  if (mant >= 100) return `${Math.round(mant / 10)}${exp + 1}`
  if (mant < 10 && exp === 0) mant *= 10 // sub-10pF: print tenths-free best effort
  return `${mant}${exp}`
}

/** Amber dipped-epoxy glaze over the ceramic disc (reference: orange-tan). */
function discGlaze(): THREE.MeshPhysicalMaterial {
  return cachedMaterial('cap-glaze', () =>
    new THREE.MeshPhysicalMaterial({
      color: 0xd08a2e,
      roughness: 0.42,
      metalness: 0,
      clearcoat: 0.55,
      clearcoatRoughness: 0.22,
    }),
  )
}

function buildCeramicDisc(
  comp: ComponentInstance,
  entry: CatalogEntry,
  pins: THREE.Vector3[],
  routed?: RoutedComponent,
): BuildResult {
  const group = new THREE.Group()
  const [a, b] = [pins[0], pins[1]]
  const f = frameBetween(a, b)
  const rp = routedPoseFor(routed, pins, 2)
  const discR = 0.55
  const discY = 0.75

  const frame = new THREE.Group()
  if (rp) {
    // radial part: it stands — bodyDir is the lead span axis (sets the yaw)
    frame.position.set(rp.center.x, Math.max(discY, rp.center.y), rp.center.z)
    frame.rotation.y = yawOf(rp.dir, f.angleY)
  } else {
    frame.position.set(f.mid.x, discY, f.mid.z)
    frame.rotation.y = f.angleY
  }

  // lens-shaped disc (squashed sphere) with the dip-coat glaze
  const discGeo = cachedGeometry('cap-disc', () => {
    const g = new THREE.SphereGeometry(discR, 24, 14)
    g.scale(1, 1, 0.3) // axis → local Z; disc plane contains the two legs
    return g
  })
  frame.add(new THREE.Mesh(discGeo, discGlaze()))

  // printed value code on both faces, floated just proud of the glaze
  const code = capCode(Number(paramOf(comp.params, entry, 'capacitance') ?? 1e-7))
  const lblMat = labelMaterial(code, { w: 128, h: 80, fg: '#3a2a14' })
  if (lblMat) {
    const lblGeo = cachedGeometry('cap-disc-label', () => new THREE.PlaneGeometry(0.62, 0.4))
    for (const s of [1, -1]) {
      const lbl = new THREE.Mesh(lblGeo, lblMat)
      lbl.position.set(0, 0.05, s * (discR * 0.3 + 0.035))
      if (s < 0) lbl.rotation.y = Math.PI
      frame.add(lbl)
    }
  }
  group.add(frame)

  const statics: THREE.Object3D[] = []
  if (rp) {
    for (const leg of rp.legs) {
      const path = leg.slice()
      extendIntoBody(path, frame.position, null, 0.25)
      statics.push(legMesh(path))
    }
  } else {
    const inset = Math.min(0.25, Math.max(0.1, f.dist * 0.25))
    for (const [pin, side] of [
      [a, -1],
      [b, 1],
    ] as [THREE.Vector3, number][]) {
      const entryPt = f.mid.clone().addScaledVector(f.dir, side * inset).setY(0.5)
      statics.push(legMesh(fromHole(pin, new THREE.Vector3(pin.x, 0.25, pin.z), entryPt)))
    }
  }
  for (const m of mergeStatic(statics)) group.add(m)
  return { object: group, pinWorld: pins.map((p) => p.clone()) }
}

// --- electrolytic ------------------------------------------------------------

const CAN_R = 0.55
/** can top + vent disc must stay ≤ 1.6 — the router's electrolytic obstacle */
const CAN_H = 1.34

/**
 * Printed shrink sleeve: near-black PVC, light polarity stripe (hollow minus
 * marks) facing the negative lead, value print running down the can.
 */
function sleeveMaterial(uF: string): THREE.Material {
  return cachedMaterial(`cap-sleeve-mat:${uF}`, () => {
    if (typeof document === 'undefined') {
      return new THREE.MeshPhysicalMaterial({ color: 0x14171c, roughness: 0.4, side: THREE.DoubleSide })
    }
    const W = 512
    const H = 256
    const canvas = document.createElement('canvas')
    canvas.width = W
    canvas.height = H
    const ctx = canvas.getContext('2d')!
    ctx.fillStyle = '#10141d'
    ctx.fillRect(0, 0, W, H)
    // polarity stripe wraps the u=0 seam (lathe theta 0 → local +X = − pin)
    const sw = Math.round(W * 0.045)
    ctx.fillStyle = '#b9bec6'
    ctx.fillRect(0, 0, sw, H)
    ctx.fillRect(W - sw, 0, sw, H)
    // bold minus bars stacked down the stripe (drawn, not font-dependent)
    ctx.fillStyle = '#10141d'
    const mw = Math.round(sw * 1.1)
    const mh = Math.max(3, Math.round(H * 0.035))
    for (const y of [0.14, 0.38, 0.62, 0.86]) {
      ctx.fillRect(Math.round(sw * 0.5 - mw / 2), Math.round(H * y - mh / 2), mw, mh)
      ctx.fillRect(Math.round(W - sw * 0.5 - mw / 2), Math.round(H * y - mh / 2), mw, mh)
    }
    // value print running down the can (three placements around the girth —
    // at least one always faces the camera)
    ctx.fillStyle = '#e2e6ec'
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    for (const u of [0.2, 0.5, 0.8]) {
      ctx.save()
      ctx.translate(W * u, H * 0.5)
      ctx.rotate(Math.PI / 2)
      ctx.font = `bold ${Math.round(H * 0.2)}px Arial, sans-serif`
      ctx.fillText(`${uF} 25V`, 0, 0)
      ctx.restore()
    }
    const tex = new THREE.CanvasTexture(canvas)
    tex.colorSpace = THREE.SRGBColorSpace
    tex.anisotropy = 4
    markShared(tex)
    return new THREE.MeshPhysicalMaterial({
      map: tex,
      // semi-matte PVC: a glossy sleeve mirrors the env as a huge white
      // streak across the black vinyl, swallowing the print + stripe
      roughness: 0.5,
      metalness: 0,
      clearcoat: 0.12,
      clearcoatRoughness: 0.45,
      envMapIntensity: 0.55,
      side: THREE.DoubleSide,
    })
  })
}

/** Bare aluminum top with the stamped K-score vent (texture + bump pair). */
function kScoreTopMaterial(): THREE.Material {
  return cachedMaterial('cap-kscore', () => {
    if (typeof document === 'undefined') {
      return new THREE.MeshPhysicalMaterial({ color: 0xc9cdd1, metalness: 0.9, roughness: 0.3 })
    }
    const S = 256
    const draw = (ctx: CanvasRenderingContext2D, bg0: string, bg1: string, line: string) => {
      const g = ctx.createRadialGradient(S / 2, S / 2, S * 0.1, S / 2, S / 2, S * 0.5)
      g.addColorStop(0, bg0)
      g.addColorStop(1, bg1)
      ctx.fillStyle = g
      ctx.fillRect(0, 0, S, S)
      ctx.strokeStyle = line
      ctx.lineCap = 'round'
      ctx.lineWidth = S * 0.045
      // K-score: one full diameter + two arms (the classic vent stamping)
      ctx.beginPath()
      ctx.moveTo(S / 2, S * 0.12)
      ctx.lineTo(S / 2, S * 0.88)
      ctx.moveTo(S / 2, S / 2)
      ctx.lineTo(S * 0.14, S * 0.26)
      ctx.moveTo(S / 2, S / 2)
      ctx.lineTo(S * 0.86, S * 0.26)
      ctx.stroke()
    }
    const colorCanvas = document.createElement('canvas')
    colorCanvas.width = S
    colorCanvas.height = S
    const cctx = colorCanvas.getContext('2d')!
    draw(cctx, '#d3d7da', '#aeb3b8', '#878c91')
    const map = new THREE.CanvasTexture(colorCanvas)
    map.colorSpace = THREE.SRGBColorSpace
    map.anisotropy = 4
    markShared(map)
    const bumpCanvas = document.createElement('canvas')
    bumpCanvas.width = S
    bumpCanvas.height = S
    const bctx = bumpCanvas.getContext('2d')!
    draw(bctx, '#c8c8c8', '#b4b4b4', '#3a3a3a') // scores pressed IN
    const bump = new THREE.CanvasTexture(bumpCanvas)
    markShared(bump)
    const m = new THREE.MeshPhysicalMaterial({
      map,
      bumpMap: bump,
      bumpScale: 0.8,
      metalness: 0.9,
      roughness: 0.32,
    })
    return m
  })
}

function buildElectrolytic(
  comp: ComponentInstance,
  entry: CatalogEntry,
  pins: THREE.Vector3[],
  routed?: RoutedComponent,
): BuildResult {
  const group = new THREE.Group()
  const [a, b] = [pins[0], pins[1]] // p1 = +, p2 = −
  const f = frameBetween(a, b)
  const rp = routedPoseFor(routed, pins, 2)
  const baseY = 0.2

  const frame = new THREE.Group()
  if (rp) {
    // radial can: stands at the routed center, yawed so the −stripe still
    // faces lead 1 (bodyDir is the lead-0 → lead-1 span axis)
    frame.position.set(rp.center.x, Math.max(baseY + CAN_H / 2, rp.center.y), rp.center.z)
    frame.rotation.y = yawOf(rp.dir, f.angleY)
  } else {
    frame.position.set(f.mid.x, baseY + CAN_H / 2, f.mid.z)
    frame.rotation.y = f.angleY
  }

  // aluminum can: closed bottom roll, side, crimp groove near the top, top rim
  const aluminum = cachedMaterial('cap-aluminum', () =>
    new THREE.MeshPhysicalMaterial({ color: 0xd4d8dc, metalness: 0.9, roughness: 0.3 }),
  )
  const canGeo = cachedGeometry('cap-can', () => {
    const pts = [
      new THREE.Vector2(0, 0), // closed bottom
      new THREE.Vector2(0.3, 0),
      new THREE.Vector2(CAN_R - 0.06, 0.02),
      new THREE.Vector2(CAN_R, 0.12), // rolled base edge
      new THREE.Vector2(CAN_R, CAN_H * 0.78),
      new THREE.Vector2(CAN_R - 0.09, CAN_H * 0.84), // crimp groove
      new THREE.Vector2(CAN_R, CAN_H * 0.9),
      new THREE.Vector2(CAN_R, CAN_H - 0.06),
      new THREE.Vector2(CAN_R - 0.04, CAN_H - 0.015), // top roll
      new THREE.Vector2(CAN_R - 0.1, CAN_H),
      new THREE.Vector2(0, CAN_H), // top face (K-score disc floats just above)
    ]
    const g = new THREE.LatheGeometry(pts, 28)
    g.translate(0, -CAN_H / 2, 0) // center on the frame origin
    return g
  })
  frame.add(new THREE.Mesh(canGeo, aluminum))

  // K-scored vent disc riding strictly proud of the top face
  const topGeo = cachedGeometry('cap-top', () => {
    const g = new THREE.CircleGeometry(CAN_R - 0.13, 24)
    g.rotateX(-Math.PI / 2)
    return g
  })
  const top = new THREE.Mesh(topGeo, kScoreTopMaterial())
  top.position.y = CAN_H / 2 + 0.012
  frame.add(top)

  // printed shrink sleeve following the can (and its crimp), radius +0.022
  const sleeveGeo = cachedGeometry('cap-sleeve', () => {
    const r = CAN_R + 0.022
    const pts = [
      new THREE.Vector2(r, 0.05),
      new THREE.Vector2(r, CAN_H * 0.78),
      new THREE.Vector2(r - 0.09, CAN_H * 0.84), // crimp shows through the sleeve
      new THREE.Vector2(r, CAN_H * 0.9),
      new THREE.Vector2(r, CAN_H * 0.94),
      new THREE.Vector2(CAN_R - 0.02, CAN_H * 0.965), // rolls in over the rim
    ]
    const g = new THREE.LatheGeometry(pts, 28)
    g.translate(0, -CAN_H / 2, 0)
    return g
  })
  const uF = Number(paramOf(comp.params, entry, 'capacitance') ?? 1e-4) * 1e6
  const uFLabel = uF >= 1 ? `${Math.round(uF)}µF` : `${Math.round(uF * 1000)}nF`
  const sleeve = new THREE.Mesh(sleeveGeo, sleeveMaterial(uFLabel))
  frame.add(sleeve)
  group.add(frame)

  const statics: THREE.Object3D[] = []
  if (rp) {
    for (const leg of rp.legs) {
      const path = leg.slice()
      extendIntoBody(path, frame.position, null, 0.25)
      statics.push(legMesh(path))
    }
  } else {
    const inset = Math.min(0.25, Math.max(0.1, f.dist * 0.25))
    for (const [pin, side] of [
      [a, -1],
      [b, 1],
    ] as [THREE.Vector3, number][]) {
      const entryPt = f.mid.clone().addScaledVector(f.dir, side * inset).setY(baseY + 0.1)
      statics.push(legMesh(fromHole(pin, new THREE.Vector3(pin.x, 0.12, pin.z), entryPt)))
    }
  }
  for (const m of mergeStatic(statics)) group.add(m)
  return { object: group, pinWorld: pins.map((p) => p.clone()) }
}

// ---------------------------------------------------------------------------
// Inductor — drum-core axial choke: copper turns over a ferrite dumbbell
// ---------------------------------------------------------------------------

class HelixCurve extends THREE.Curve<THREE.Vector3> {
  constructor(
    private len: number,
    private radius: number,
    private turns: number,
  ) {
    super()
  }
  override getPoint(t: number, target = new THREE.Vector3()): THREE.Vector3 {
    const ang = this.turns * Math.PI * 2 * t
    return target.set(
      -this.len / 2 + this.len * t,
      Math.cos(ang) * this.radius,
      Math.sin(ang) * this.radius,
    )
  }
}

const IND_FLANGE_R = 0.4
const IND_WAIST_R = 0.26
const IND_WIRE_R = 0.06

/** Enamelled magnet wire: copper under a glossy lacquer film. */
function enamelCopper(): THREE.MeshPhysicalMaterial {
  return cachedMaterial('copper', () =>
    new THREE.MeshPhysicalMaterial({
      color: 0xb06a2d,
      metalness: 1.0,
      roughness: 0.22,
      clearcoat: 0.55,
      clearcoatRoughness: 0.12,
    }),
  )
}

export function buildInductor(
  comp: ComponentInstance,
  entry: CatalogEntry,
  pins: THREE.Vector3[],
  routed?: RoutedComponent,
): BuildResult {
  const group = new THREE.Group()
  const [a, b] = [pins[0], pins[1]]
  const f = frameBetween(a, b)
  const rp = routedPoseFor(routed, pins, 2)
  const axisY = 0.62

  const frame = new THREE.Group()
  let coilLen: number
  if (rp) {
    const span = routedAxialLength(rp)
    coilLen = THREE.MathUtils.clamp(span > 0.05 ? span : 1.8, 1.2, 2.6)
    alignFrameToAxis(frame, rp.center, rp.dir)
  } else {
    coilLen = THREE.MathUtils.clamp(f.dist - 1.0, 1.2, 2.6)
    frame.position.set(f.mid.x, axisY, f.mid.z)
    frame.rotation.y = f.angleY
  }

  // ferrite dumbbell core (dark, faintly glossy ceramic)
  const ferrite = cachedMaterial('ferrite', () =>
    new THREE.MeshPhysicalMaterial({
      color: 0x3a3a40,
      roughness: 0.45,
      metalness: 0,
      clearcoat: 0.18,
      clearcoatRoughness: 0.4,
    }),
  )
  const coreGeo = cachedGeometry(`ind-core:${coilLen.toFixed(2)}`, () => {
    const L = coilLen
    const pts: THREE.Vector2[] = [
      new THREE.Vector2(0.07, -L / 2),
      new THREE.Vector2(IND_FLANGE_R * 0.88, -L / 2 + 0.02),
      new THREE.Vector2(IND_FLANGE_R, -L / 2 + 0.07),
      new THREE.Vector2(IND_FLANGE_R, -L / 2 + 0.18),
      new THREE.Vector2(IND_WAIST_R, -L / 2 + 0.24),
      new THREE.Vector2(IND_WAIST_R, L / 2 - 0.24),
      new THREE.Vector2(IND_FLANGE_R, L / 2 - 0.18),
      new THREE.Vector2(IND_FLANGE_R, L / 2 - 0.07),
      new THREE.Vector2(IND_FLANGE_R * 0.88, L / 2 - 0.02),
      new THREE.Vector2(0.07, L / 2),
    ]
    const g = new THREE.LatheGeometry(pts, 20)
    g.rotateZ(-Math.PI / 2) // lathe axis Y → local X
    return g
  })
  frame.add(new THREE.Mesh(coreGeo, ferrite))

  // close-wound copper turns filling the winding window between the flanges
  const windowLen = coilLen - 0.56
  const turns = Math.max(6, Math.floor(windowLen / (IND_WIRE_R * 2 + 0.015)))
  const coilR = IND_WAIST_R + IND_WIRE_R + 0.005
  const coilGeo = cachedGeometry(`coil:${coilLen.toFixed(2)}:${turns}`, () => {
    const curve = new HelixCurve(windowLen * 0.92, coilR, turns)
    return new THREE.TubeGeometry(curve, turns * 12, IND_WIRE_R, 6, false)
  })
  const copper = enamelCopper()
  // every copper piece (coil, end beads, both legs) merges into ONE mesh —
  // the inductor used to be 8 draw calls of mostly-copper (finding-7 budget)
  const copperParts = new THREE.Group()
  copperParts.position.copy(frame.position)
  copperParts.quaternion.copy(frame.quaternion)
  copperParts.add(new THREE.Mesh(coilGeo, copper))

  // the helix tube ends are open rings — cap them with copper beads (these
  // also swallow the smaller leg-tube ends meeting at the same points)
  const coilCapGeo = cachedGeometry('coil-cap', () => new THREE.SphereGeometry(0.068, 8, 6))
  const helixEndLocal = (s: number) => new THREE.Vector3((s * windowLen * 0.92) / 2, coilR, 0)
  for (const s of [-1, 1]) {
    const cap = new THREE.Mesh(coilCapGeo, copper)
    cap.position.copy(helixEndLocal(s))
    copperParts.add(cap)
  }
  group.add(frame)

  // world positions of the helix ends (frame matrices aren't computed yet)
  const helixEndWorld = (s: number) =>
    helixEndLocal(s).applyQuaternion(frame.quaternion).add(frame.position)

  const statics: THREE.Object3D[] = [copperParts]
  if (rp) {
    for (const leg of rp.legs) {
      const path = leg.slice()
      // finish exactly at the nearer helix end so lead and coil meet cleanly
      const last = path[path.length - 1]
      const endPt =
        last.distanceToSquared(helixEndWorld(-1)) <= last.distanceToSquared(helixEndWorld(1))
          ? helixEndWorld(-1)
          : helixEndWorld(1)
      if (last.distanceToSquared(endPt) > 1e-6) path.push(endPt)
      statics.push(legMesh(path, 0.05, copper))
    }
  } else {
    const topY = axisY + coilR
    const endA = f.mid.clone().addScaledVector(f.dir, -windowLen / 2).setY(topY)
    const endB = f.mid.clone().addScaledVector(f.dir, windowLen / 2).setY(topY)
    statics.push(legMesh(fromHole(a, new THREE.Vector3(a.x, topY, a.z), endA), 0.05, copper))
    statics.push(legMesh(fromHole(b, new THREE.Vector3(b.x, topY, b.z), endB), 0.05, copper))
  }
  for (const m of mergeStatic(statics)) group.add(m)

  return { object: group, pinWorld: pins.map((p) => p.clone()) }
}

// ---------------------------------------------------------------------------
// Potentiometer — Bourns 3296P-style multiturn trimmer (top adjust)
// ---------------------------------------------------------------------------
// The 3296P is the square-top member of the 3296 family: blue chamfered body
// 9.53×9.53 mm in plan but only 4.83 mm tall (≈1.9 units — exactly the
// router's declared pot obstacle height), knurled brass screw at one corner
// of the top, white printed legend + 3-digit code, molded wiper-cavity seam.

/** Knurled brass adjustment screw with a real slot punched through the head. */
function knurledScrewGeometry(): THREE.BufferGeometry {
  return cachedGeometry('pot-screw', () => {
    const R = 0.4
    const teeth = 24
    const shape = new THREE.Shape()
    for (let i = 0; i <= teeth * 2; i++) {
      const ang = (i / (teeth * 2)) * Math.PI * 2
      const r = i % 2 === 0 ? R : R * 0.88 // deep knurl — reads at arm's length
      const x = Math.cos(ang) * r
      const y = Math.sin(ang) * r
      if (i === 0) shape.moveTo(x, y)
      else shape.lineTo(x, y)
    }
    shape.closePath()
    const slot = new THREE.Path()
    slot.moveTo(-0.31, -0.08)
    slot.lineTo(0.31, -0.08)
    slot.lineTo(0.31, 0.08)
    slot.lineTo(-0.31, 0.08)
    slot.closePath()
    shape.holes.push(slot)
    const g = new THREE.ExtrudeGeometry(shape, { depth: 0.3, bevelEnabled: false, curveSegments: 2 })
    g.rotateX(-Math.PI / 2) // extrusion → +Y; head lies flat
    return g
  })
}

function brass(): THREE.MeshPhysicalMaterial {
  return cachedMaterial('brass', () => {
    // dull worn brass (ref-bourns3296.jpg) — NOT jewelry-bright: darker alloy
    // tone and a high roughness so the knurl reads matte under the key light
    const m = new THREE.MeshPhysicalMaterial({ color: 0xa8894e, metalness: 1.0, roughness: 0.48 })
    const r = brushedRoughnessTexture()
    if (r) m.roughnessMap = r
    return m
  })
}

export function buildPotentiometer(
  comp: ComponentInstance,
  entry: CatalogEntry,
  pins: THREE.Vector3[],
): BuildResult {
  const group = new THREE.Group()
  const c = centroidOf(pins)
  const f = frameBetween(pins[0], pins[2] ?? pins[pins.length - 1])

  // the real 3296 is a 9.53 mm SQUARE in plan (3.75 units) — a fixed square
  // body, NOT a brick stretched over the pin span: pins that fall outside the
  // footprint get bottom-entry formed leads instead (see legs below)
  const w = 3.75
  const d = 3.75
  const baseY = 0.12
  const h = 1.45 // body top 1.57; screw tops out ≤ 1.9 (router pot envelope)
  const topY = baseY + h
  const bv = 0.09 // molded chamfer

  const frame = new THREE.Group()
  frame.position.set(c.x, 0, c.z)
  frame.rotation.y = f.angleY

  // muted, slightly worn blue (ref photo), satin-matte so the chamfers stop
  // reading billiard-smooth
  const bodyBlue = plastic(0x35588f, 0.62)
  const bodyGeo = cachedGeometry(`pot-body:${w.toFixed(2)}:${d.toFixed(2)}`, () => {
    const shape = new THREE.Shape()
    const hw = w / 2 - bv
    const hd = d / 2 - bv
    shape.moveTo(-hw, -hd)
    shape.lineTo(hw, -hd)
    shape.lineTo(hw, hd)
    shape.lineTo(-hw, hd)
    shape.closePath()
    const g = new THREE.ExtrudeGeometry(shape, {
      depth: h - 2 * bv,
      bevelEnabled: true,
      bevelThickness: bv,
      bevelSize: bv,
      bevelSegments: 2,
      curveSegments: 2,
    })
    g.rotateX(-Math.PI / 2) // extrusion → +Y (up); shape y → plan z
    g.translate(0, bv, 0) // body occupies y 0..h
    return g
  })
  const body = new THREE.Mesh(bodyGeo, bodyBlue)
  body.position.y = baseY
  // static molded plastic (body, boss, seams) merges per material below
  const frameStatics: THREE.Object3D[] = [body]

  // the adjustment screw lives at one corner of the top face
  const screwX = -w / 2 + 0.78
  const screwZ = -d / 2 + 0.78

  // molded boss collar around the screw
  const bossGeo = cachedGeometry('pot-boss', () => new THREE.CylinderGeometry(0.5, 0.54, 0.16, 20))
  const boss = new THREE.Mesh(bossGeo, bodyBlue)
  boss.position.set(screwX, topY - 0.02, screwZ)
  frameStatics.push(boss)

  // wiper-cavity seam: the fine recessed ring molded around the screw boss
  const seamGeo = cachedGeometry('pot-seam', () => new THREE.TorusGeometry(0.62, 0.018, 6, 36))
  const seamMat = plastic(0x2c4a79, 0.66)
  const seam = new THREE.Mesh(seamGeo, seamMat)
  seam.rotation.x = -Math.PI / 2
  seam.position.set(screwX, topY + 0.008, screwZ)
  frameStatics.push(seam)

  // body parting line: a FAINT molded seam — a hairline strip a shade darker
  // than the body, barely proud (the old 0.035-tall belt read as a separate
  // stacked lid; the real seam is a thin line you have to look for)
  const partGeo = cachedGeometry(`pot-part:${w.toFixed(2)}:${d.toFixed(2)}`, () =>
    new THREE.BoxGeometry(w + 0.012, 0.018, d + 0.012),
  )
  const parting = new THREE.Mesh(partGeo, seamMat)
  parting.position.y = baseY + h * 0.42
  frameStatics.push(parting)
  for (const m of mergeStatic(frameStatics)) frame.add(m)

  // knurled brass screw, slot punched clean through the head — proud of the
  // boss so the knurl edge and the slot shadow both read in close-up
  const screw = new THREE.Group()
  screw.position.set(screwX, topY - 0.06, screwZ)
  const head = new THREE.Mesh(knurledScrewGeometry(), brass())
  screw.add(head)
  // dark slot floor inside the punched hole (well below the head top)
  const slotFloorGeo = cachedGeometry('pot-slot-floor', () => new THREE.BoxGeometry(0.6, 0.06, 0.15))
  const slotFloor = new THREE.Mesh(
    slotFloorGeo,
    cachedMaterial('pot-slot-mat', () =>
      new THREE.MeshStandardMaterial({ color: 0x2e2618, roughness: 0.55, metalness: 0.5 }),
    ),
  )
  slotFloor.position.y = 0.08
  screw.add(slotFloor)
  frame.add(screw)

  // printed legend + the 3-digit code on the top face: LIT ink (standard
  // material + the text as a faint bump = thin molded/printed marking), set
  // nearly flush — the old unlit Basic plane floated 0.02 proud and read as
  // a hovering pure-white sticker with a parallax gap
  const rOhm = Number(paramOf(comp.params, entry, 'resistance') ?? 10000)
  const exp = Math.max(0, Math.floor(Math.log10(Math.max(1, rOhm))) - 1)
  const code = `${Math.round(rOhm / 10 ** exp)}${exp}`
  const lx = (screwX + 0.95 + w / 2) / 2 // centered over the free top area
  const ink = (text: string, texW: number, texH: number) => {
    const tex = textTexture(text, { w: texW, h: texH, fg: '#d9dce1' })
    if (!tex) return null
    return cachedMaterial(`pot-ink:${text}|${texW}x${texH}`, () => {
      const m = new THREE.MeshStandardMaterial({
        map: tex,
        transparent: true,
        depthWrite: false,
        roughness: 0.6,
        metalness: 0,
      })
      m.bumpMap = tex
      m.bumpScale = 0.35
      return m
    })
  }
  const legend = (text: string, lw: number, lh: number, z: number, texW: number, texH: number) => {
    const mat = ink(text, texW, texH)
    if (!mat) return
    const geo = cachedGeometry(`toplabel:${lw.toFixed(2)}x${lh.toFixed(2)}`, () => {
      const g = new THREE.PlaneGeometry(lw, lh)
      g.rotateX(-Math.PI / 2)
      return g
    })
    const lbl = new THREE.Mesh(geo, mat)
    lbl.position.set(lx, topY + 0.006, z)
    frame.add(lbl)
  }
  legend('BOURNS', 1.5, 0.44, -d * 0.18, 256, 72)
  legend(`3296  ${code}`, 1.8, 0.42, d * 0.18, 256, 64)
  group.add(frame)

  // legs: real 3296 leads exit the package BOTTOM. Pins under the footprint
  // get a straight pin; pins outside it (the catalog's wide 2-column spacing)
  // get a formed lead that rises from the hole, runs low under the body edge
  // and turns up into the bottom face — the body stays a true square.
  const legInsetX = w / 2 - 0.35
  const legInsetZ = d / 2 - 0.35
  const runY = 0.1
  const legStatics: THREE.Object3D[] = []
  for (const p of pins) {
    const rel = p.clone().sub(c)
    const relX = rel.dot(f.dir)
    const relZ = rel.dot(f.perp)
    if (Math.abs(relX) <= legInsetX && Math.abs(relZ) <= legInsetZ) {
      legStatics.push(pinLeg(p, baseY + 0.2, 0.055))
      continue
    }
    const inX = THREE.MathUtils.clamp(relX, -legInsetX, legInsetX)
    const inZ = THREE.MathUtils.clamp(relZ, -legInsetZ, legInsetZ)
    const entryPt = c.clone().addScaledVector(f.dir, inX).addScaledVector(f.perp, inZ)
    legStatics.push(
      legMesh(
        fromHole(
          p,
          new THREE.Vector3(p.x, runY, p.z),
          new THREE.Vector3(entryPt.x, runY, entryPt.z),
          new THREE.Vector3(entryPt.x, baseY + 0.3, entryPt.z),
        ),
        0.055,
      ),
    )
  }
  for (const m of mergeStatic(legStatics)) group.add(m)

  // multiturn trimmer: the screw spins several visual turns lock-to-lock
  const applyKnob = (pos: number) => {
    screw.rotation.y = -THREE.MathUtils.clamp(pos, 0, 1) * Math.PI * 2 * 6.5
  }
  applyKnob(Number(paramOf(comp.params, entry, 'position') ?? 0.5))

  return {
    object: group,
    pinWorld: pins.map((p) => p.clone()),
    update: (c2, e2) => {
      applyKnob(Number(paramOf(c2.params, e2, 'position') ?? 0.5))
    },
  }
}

// ---------------------------------------------------------------------------
// Photoresistor (LDR) — CdS serpentine in real relief under a clear window
// ---------------------------------------------------------------------------

export function buildPhotoresistor(
  _comp: ComponentInstance,
  _entry: CatalogEntry,
  pins: THREE.Vector3[],
  routed?: RoutedComponent,
): BuildResult {
  const group = new THREE.Group()
  const [a, b] = [pins[0], pins[1]]
  const f = frameBetween(a, b)
  const rp = routedPoseFor(routed, pins, 2)
  const R = 0.55

  const body = new THREE.Group()
  const cy = 0.62 // vertical reference (substrate center height)
  if (rp) body.position.set(rp.center.x, Math.max(0, rp.center.y - cy), rp.center.z)
  else body.position.set(f.mid.x, 0, f.mid.z)
  body.rotation.y = rp ? yawOf(rp.dir, f.angleY) : f.angleY

  const coat = plastic(0xc77e35, 0.5)
  coat.side = THREE.DoubleSide // the open side ring shows its inner wall

  // coated epoxy shell merges into ONE mesh (Phase D draw budget):
  // side ring (open, rising just past the window like the coated rim) +
  // rounded rim bead at the top edge (an open tube mouth would read hollow) +
  // closed bottom cap
  const coatStatics: THREE.Object3D[] = []
  const ringGeo = cachedGeometry('ldr-ring', () => new THREE.CylinderGeometry(0.56, 0.56, 0.44, 24, 1, true))
  const ring = new THREE.Mesh(ringGeo, coat)
  ring.position.y = 0.66
  coatStatics.push(ring)
  const rimGeo = cachedGeometry('ldr-rim', () => new THREE.TorusGeometry(0.535, 0.04, 6, 24))
  const rim = new THREE.Mesh(rimGeo, coat)
  rim.rotation.x = -Math.PI / 2
  rim.position.y = 0.88
  coatStatics.push(rim)
  const baseGeo = cachedGeometry('ldr-base', () => new THREE.CylinderGeometry(0.56, 0.56, 0.08, 24))
  const base = new THREE.Mesh(baseGeo, coat)
  base.position.y = 0.46
  coatStatics.push(base)
  for (const m of mergeStatic(coatStatics)) body.add(m)

  // ceramic substrate carrying the cell
  const substrate = cachedMaterial('ldr-substrate', () =>
    new THREE.MeshPhysicalMaterial({ color: 0xcfc3a4, roughness: 0.55, metalness: 0 }),
  )
  const subGeo = cachedGeometry('ldr-substrate-geo', () => new THREE.CylinderGeometry(0.53, 0.53, 0.18, 24))
  const sub = new THREE.Mesh(subGeo, substrate)
  sub.position.y = cy + 0.08 // face at 0.79
  body.add(sub)

  // the CdS serpentine track — REAL raised geometry, not a decal
  const trackGeo = cachedGeometry('ldr-track', () => {
    const rows = 6
    const halfZ = 0.33
    const pts: THREE.Vector3[] = []
    for (let i = 0; i <= rows; i++) {
      const z = -halfZ + (2 * halfZ * i) / rows
      const xr = Math.sqrt(Math.max(0.03, 0.47 * 0.47 - z * z)) * 0.94
      const s = i % 2 === 0 ? 1 : -1
      pts.push(new THREE.Vector3(-s * xr, 0, z))
      pts.push(new THREE.Vector3(s * xr, 0, z))
    }
    const path = roundedPath(pts, 0.07)
    return new THREE.TubeGeometry(path, 96, 0.034, 6, false)
  })
  const trackMat = cachedMaterial('ldr-track-mat', () =>
    new THREE.MeshPhysicalMaterial({
      color: 0xc05a20,
      roughness: 0.38,
      metalness: 0,
      clearcoat: 0.4,
      clearcoatRoughness: 0.25,
    }),
  )
  const track = new THREE.Mesh(trackGeo, trackMat)
  track.position.y = cy + 0.175 // half-buried in the substrate face → relief
  body.add(track)

  // clear protective window floating over the cell, inside the rim
  const windowGeo = cachedGeometry('ldr-window', () => new THREE.CylinderGeometry(0.52, 0.52, 0.05, 24))
  const windowMat = cachedMaterial('ldr-window-mat', () =>
    new THREE.MeshPhysicalMaterial({
      color: 0xf2f4f6,
      roughness: 0.08,
      metalness: 0,
      clearcoat: 0.5,
      clearcoatRoughness: 0.12,
      envMapIntensity: 0.6, // a hot window highlight washes the cell beneath
      transparent: true,
      opacity: 0.15,
      depthWrite: true, // collar-pass stamp immunity (see diodeGlass)
    }),
  )
  const win = new THREE.Mesh(windowGeo, windowMat)
  win.position.y = 0.85
  body.add(win)
  group.add(body)

  const interior = new THREE.Vector3()
  const statics: THREE.Object3D[] = []
  if (rp) {
    for (const leg of rp.legs) {
      const path = leg.slice()
      interior.set(body.position.x, body.position.y + cy, body.position.z)
      extendIntoBody(path, interior, null, 0.2)
      statics.push(legMesh(path))
    }
  } else {
    const inset = Math.min(0.22, Math.max(0.1, f.dist * 0.22))
    for (const [pin, sideSign] of [
      [a, -1],
      [b, 1],
    ] as [THREE.Vector3, number][]) {
      const entryPt = f.mid.clone().addScaledVector(f.dir, sideSign * inset).setY(cy - 0.05)
      statics.push(legMesh(fromHole(pin, new THREE.Vector3(pin.x, 0.3, pin.z), entryPt)))
    }
  }
  for (const m of mergeStatic(statics)) group.add(m)
  return { object: group, pinWorld: pins.map((p) => p.clone()) }
}
