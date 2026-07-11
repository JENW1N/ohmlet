/**
 * IC packages: generic black epoxy DIP (used by every chip) and the DIP-10
 * seven-segment display.
 *
 * Realism notes (judged against reference photos — Signetics NE555N, FND500):
 *  - DIP bodies are transfer-molded with a DOUBLE DRAFT: the side walls are
 *    widest at the mid-height mold seam and taper toward both the top and the
 *    bottom face. `draftBodyGeometry` builds that exact profile; the seam edge
 *    catches light the way the real parting line does.
 *  - Tops carry two shallow round EJECTOR-PIN marks (slightly glossier discs)
 *    plus the molded end-notch and the pin-1 dimple, both with a faint
 *    light-catching rim so they read as recesses, not stickers.
 *  - Markings are laser-etched (color + matching bump canvas with a fake
 *    date/lot line); legs are stamped gull-wing metal.
 *  - Orientation cues track pin 1's REAL hole (which already encodes the
 *    instance's `rotation`): a 180° DIP shows notch + dimple on its pin-1
 *    end with upside-down silkscreen; a 180° display renders its whole digit
 *    (dp included) upside down.
 *  - The seven-segment is a molded shell with a raised bezel around a RECESSED
 *    smoked-glass window; the segment wafers sit visibly BEHIND the glass on a
 *    near-black cavity floor and ghost faintly when unlit (FND500 style).
 */

import * as THREE from 'three'
import type { ComponentInstance } from '../../model/types'
import type { CatalogEntry } from '../../model/catalog'
import {
  BuildResult,
  cachedGeometry,
  cachedMaterial,
  centroidOf,
  etchedLabelMaterial,
  fakeLotCode,
  gullWingLeg,
  mergeStatic,
  moldedEpoxy,
  pinLeg,
  shortLabel,
} from './shared'

interface DipExtents {
  minX: number
  maxX: number
  cx: number
  zc: number
  span: number
}

function dipExtents(pins: THREE.Vector3[]): DipExtents {
  let minX = Infinity
  let maxX = -Infinity
  for (const p of pins) {
    minX = Math.min(minX, p.x)
    maxX = Math.max(maxX, p.x)
  }
  if (!Number.isFinite(minX)) {
    minX = 0
    maxX = 0
  }
  const c = centroidOf(pins)
  return { minX, maxX, cx: (minX + maxX) / 2, zc: pins.length ? c.z : 8, span: maxX - minX }
}

/**
 * Transfer-molded package body with the real double-draft profile: the
 * cross-section is a hexagon — widest at the mid-height mold seam, tapering
 * by `inset` toward both the top and bottom faces. Geometry origin is at the
 * package BOTTOM (y = 0..h), centered in x/z. Cached per dimensions; the
 * returned type is a plain BufferGeometry so DIP leg tests can keep counting
 * gull-wing stampings by their ExtrudeGeometry type.
 */
export function draftBodyGeometry(
  w: number,
  h: number,
  d: number,
  inset = 0.09,
): THREE.BufferGeometry {
  const key = `draft-body:${w.toFixed(2)}:${h.toFixed(2)}:${d.toFixed(2)}:${inset.toFixed(2)}`
  return cachedGeometry(key, () => {
    const zi = d / 2 - inset
    const zo = d / 2
    const s = new THREE.Shape()
    s.moveTo(-zi, 0)
    s.lineTo(-zo, h * 0.5)
    s.lineTo(-zi, h)
    s.lineTo(zi, h)
    s.lineTo(zo, h * 0.5)
    s.lineTo(zi, 0)
    s.closePath()
    const ext = new THREE.ExtrudeGeometry(s, { depth: w, bevelEnabled: false, curveSegments: 2 })
    // shape plane was (z-profile, y); spin the extrusion axis onto x and center
    ext.rotateY(Math.PI / 2)
    ext.translate(-w / 2, 0, 0)
    const plain = new THREE.BufferGeometry()
    plain.copy(ext)
    return plain
  })
}

// ---------------------------------------------------------------------------
// Generic DIP body (black epoxy, draft + seam, notch, dimple, ejector marks)
// ---------------------------------------------------------------------------

export function buildDip(
  _comp: ComponentInstance,
  entry: CatalogEntry,
  pins: THREE.Vector3[],
): BuildResult {
  const group = new THREE.Group()
  const { minX, maxX, cx, zc, span } = dipExtents(pins)
  const bodyW = span + 1.5
  const bodyD = 2.45
  const bodyH = 0.62
  const baseY = 0.32
  const topY = baseY + bodyH

  // orientation: pin 1 sits at one END of the package (its hole position
  // already carries the instance's `rotation` — dipHoles flips the pin map at
  // 180°), so every molded cue derives from where pin 1 actually IS. A
  // 180-rotated DIP gets the notch on its pin-1 (right) end, the dimple in
  // the matching corner, and upside-down silkscreen — never the impossible
  // notch-left/dimple-right combination.
  const pin1 = pins[0]
  const endSign = pin1 && pin1.x > cx ? 1 : -1 // pin-1 end of the package
  const flipped = endSign > 0

  const body = new THREE.Mesh(
    draftBodyGeometry(bodyW, bodyH, bodyD, 0.09),
    moldedEpoxy(0x1a1a1c, 0.45),
  )
  body.position.set(cx, baseY, zc)
  group.add(body)

  const recess = cachedMaterial('dip-recess', () =>
    new THREE.MeshPhysicalMaterial({ color: 0x0a0a0c, roughness: 0.7, metalness: 0 }),
  )
  // ejector-pin marks read glossier than the matte epoxy around them
  const ejector = cachedMaterial('dip-ejector', () =>
    new THREE.MeshPhysicalMaterial({ color: 0x141416, roughness: 0.22, metalness: 0 }),
  )
  // recess rims: a hair lighter than the epoxy so the edge catches light
  const rim = cachedMaterial('dip-rim', () =>
    new THREE.MeshPhysicalMaterial({ color: 0x2e2e32, roughness: 0.35, metalness: 0 }),
  )

  // static molded details + metalwork build detached, then merge into one
  // mesh per material (recess / rim / ejector / leg metal): a 14-pin DIP went
  // from ~38 meshes to 6 — the draw-call budget at 100 parts demands it
  const statics: THREE.Object3D[] = []

  // pin-1 end notch: vertical half-embedded cylinder reads as the molded
  // recess from every angle, plus a matching dark disc flush with the top
  // and a light-catching rim ring around its mouth
  const notchSideGeo = cachedGeometry(
    'dip-notch-side',
    () => new THREE.CylinderGeometry(0.22, 0.22, 0.4, 12),
  )
  const notchSide = new THREE.Mesh(notchSideGeo, recess)
  notchSide.position.set(cx + endSign * (bodyW / 2), baseY + bodyH / 2, zc)
  statics.push(notchSide)
  const notchTopGeo = cachedGeometry('dip-notch', () => new THREE.CylinderGeometry(0.24, 0.24, 0.03, 16))
  const notchTop = new THREE.Mesh(notchTopGeo, recess)
  notchTop.position.set(cx + endSign * (bodyW / 2 - 0.1), topY + 0.006, zc)
  statics.push(notchTop)
  const notchRimGeo = cachedGeometry('dip-notch-rim', () => {
    const g = new THREE.RingGeometry(0.24, 0.29, 16)
    g.rotateX(-Math.PI / 2)
    return g
  })
  const notchRim = new THREE.Mesh(notchRimGeo, rim)
  notchRim.position.set(cx + endSign * (bodyW / 2 - 0.1), topY + 0.004, zc)
  statics.push(notchRim)

  // pin-1 dimple (molded depression next to pin 1, on pin 1's side):
  // dark floor disc + light rim ring = crisp engraved dot at close-up
  if (pin1) {
    const dz = pin1.z > zc ? bodyD / 2 - 0.42 : -(bodyD / 2 - 0.42)
    const dx = flipped ? maxX - 0.18 : minX + 0.18
    const dimpleGeo = cachedGeometry('dip-dimple', () => new THREE.CylinderGeometry(0.1, 0.1, 0.025, 12))
    const dimple = new THREE.Mesh(dimpleGeo, recess)
    dimple.position.set(dx, topY + 0.006, zc + dz)
    statics.push(dimple)
    const dotRimGeo = cachedGeometry('dip-dimple-rim', () => {
      const g = new THREE.RingGeometry(0.1, 0.14, 12)
      g.rotateX(-Math.PI / 2)
      return g
    })
    const dotRim = new THREE.Mesh(dotRimGeo, rim)
    dotRim.position.set(dx, topY + 0.004, zc + dz)
    statics.push(dotRim)
  }

  // two shallow ejector-pin marks near the package ends (see NE555N photo)
  const ejectorGeo = cachedGeometry('dip-ejector-disc', () => {
    const g = new THREE.CircleGeometry(0.16, 16)
    g.rotateX(-Math.PI / 2)
    return g
  })
  for (const [sx, sz] of [
    [-1, 1],
    [1, -1],
  ] as const) {
    const mark = new THREE.Mesh(ejectorGeo, ejector)
    mark.position.set(cx + sx * (bodyW / 2 - 0.62), topY + 0.005, zc + sz * 0.42)
    statics.push(mark)
  }

  // stamped gull-wing legs: shoulder out of the body side, drop into the hole
  for (const p of pins) {
    const reach = Math.abs(p.z - zc) - bodyD / 2
    statics.push(gullWingLeg(p, zc, { enterY: baseY + bodyH * 0.4, reach, width: 0.34 }))
  }
  for (const m of mergeStatic(statics)) group.add(m)

  // laser-etched marking: part code + fake date/lot line. Reads with the
  // package: a 180-rotated DIP shows its silkscreen upside down.
  const code = shortLabel(entry)
  const lblW = Math.min(Math.max(bodyW - 1.4, 1.2), 3.4)
  const lblH = lblW / 2.6
  const lblMat = etchedLabelMaterial([code, fakeLotCode(code)], lblW / lblH)
  if (lblMat) {
    const lblGeo = cachedGeometry(`etchlabel:${lblW.toFixed(2)}x${lblH.toFixed(2)}`, () => {
      const g = new THREE.PlaneGeometry(lblW, lblH)
      g.rotateX(-Math.PI / 2)
      return g
    })
    const lbl = new THREE.Mesh(lblGeo, lblMat)
    lbl.position.set(cx - endSign * 0.2, topY + 0.02, zc) // clearly proud — never coplanar
    if (flipped) lbl.rotation.y = Math.PI
    group.add(lbl)
  }

  return { object: group, pinWorld: pins.map((p) => p.clone()) }
}

// ---------------------------------------------------------------------------
// Seven-segment display (DIP-10, emissive segments driven by telemetry)
// ---------------------------------------------------------------------------

const SEG_UNLIT = { color: 0x240808, emissive: 0x550000, intensity: 0.25 }
const SEG_LIT = { color: 0x7a1410, emissive: 0xff3020, intensity: 1.4 }

interface SegSpec {
  name: string
  x: number
  z: number
  kind: 'h' | 'v' | 'dot'
}

// digit drawn on the top face; -z is "up" in plan view
const SEG_LAYOUT: SegSpec[] = [
  { name: 'a', x: 0, z: -1.05, kind: 'h' },
  { name: 'g', x: 0, z: 0, kind: 'h' },
  { name: 'd', x: 0, z: 1.05, kind: 'h' },
  { name: 'f', x: -0.62, z: -0.52, kind: 'v' },
  { name: 'b', x: 0.62, z: -0.52, kind: 'v' },
  { name: 'e', x: -0.62, z: 0.52, kind: 'v' },
  { name: 'c', x: 0.62, z: 0.52, kind: 'v' },
  { name: 'dp', x: 1.1, z: 1.05, kind: 'dot' },
]

export function buildSevenSeg(
  _comp: ComponentInstance,
  _entry: CatalogEntry,
  pins: THREE.Vector3[],
): BuildResult {
  const group = new THREE.Group()
  const { cx, zc, span } = dipExtents(pins)
  const baseY = 0.3
  const bodyH = 0.95
  const topY = baseY + bodyH

  // orientation: like buildDip, read it off pin 1's actual hole — a
  // 180-rotated display is physically upside down, so the whole digit
  // (decimal point included) turns with the package
  const pin1 = pins[0]
  const flipped = !!pin1 && pin1.x > cx

  // molded shell with the same double-draft profile as every molded package
  const body = new THREE.Mesh(
    draftBodyGeometry(span + 1.8, bodyH, 3.3, 0.08),
    moldedEpoxy(0x232327, 0.5),
  )
  body.position.set(cx, baseY, zc)
  group.add(body)

  // static shell details build detached, then merge per material (bezel,
  // floor, pins → 3 meshes instead of 16): draw-call budget at 100 parts
  const statics: THREE.Object3D[] = []

  // raised bezel frame around the recessed display window
  const bezelMat = cachedMaterial('7seg-bezel', () =>
    new THREE.MeshPhysicalMaterial({ color: 0x1b1b1f, roughness: 0.5, metalness: 0 }),
  )
  const W = span + 1.55 // bezel outer width
  const D = 3.05 // bezel outer depth
  const bezelH = 0.16
  const railGeo = cachedGeometry(`7seg-bzx:${W.toFixed(2)}`, () => new THREE.BoxGeometry(W - 0.48, bezelH, 0.24))
  const sideGeo = cachedGeometry('7seg-bzz', () => new THREE.BoxGeometry(0.24, bezelH, D))
  for (const sz of [-1, 1]) {
    const rail = new THREE.Mesh(railGeo, bezelMat)
    rail.position.set(cx, topY + bezelH / 2, zc + sz * (D / 2 - 0.12))
    statics.push(rail)
  }
  for (const sx of [-1, 1]) {
    const side = new THREE.Mesh(sideGeo, bezelMat)
    side.position.set(cx + sx * (W / 2 - 0.12), topY + bezelH / 2, zc)
    statics.push(side)
  }

  // near-black cavity floor the segment wafers rest over (proud of body top)
  const floorMat = cachedMaterial('7seg-floor', () =>
    new THREE.MeshPhysicalMaterial({ color: 0x070709, roughness: 0.85, metalness: 0 }),
  )
  const floorGeo = cachedGeometry(`7seg-floor:${W.toFixed(2)}`, () =>
    new THREE.BoxGeometry(W - 0.5, 0.02, D - 0.5),
  )
  const floor = new THREE.Mesh(floorGeo, floorMat)
  floor.position.set(cx, topY + 0.012, zc)
  statics.push(floor)

  // segment wafers BEHIND the glass (between cavity floor and cover) — in a
  // digit group centered on the package so a flipped display rotates whole
  const hGeo = cachedGeometry('7seg-h', () => new THREE.BoxGeometry(1.0, 0.05, 0.22))
  const vGeo = cachedGeometry('7seg-v', () => new THREE.BoxGeometry(0.22, 0.05, 0.95))
  const dotGeo = cachedGeometry('7seg-dot', () => new THREE.CylinderGeometry(0.13, 0.13, 0.05, 12))

  const segMats: Record<string, THREE.MeshStandardMaterial> = {}
  const segY = topY + 0.05
  const digit = new THREE.Group()
  digit.position.set(cx, 0, zc)
  if (flipped) digit.rotation.y = Math.PI
  for (const spec of SEG_LAYOUT) {
    const mat = new THREE.MeshStandardMaterial({
      color: SEG_UNLIT.color,
      emissive: SEG_UNLIT.emissive,
      emissiveIntensity: SEG_UNLIT.intensity,
      roughness: 0.32,
    })
    segMats[spec.name] = mat
    const geo = spec.kind === 'h' ? hGeo : spec.kind === 'v' ? vGeo : dotGeo
    const seg = new THREE.Mesh(geo, mat)
    seg.position.set(-0.15 + spec.x, segY, spec.z) // digit shifted so dp fits
    digit.add(seg)
  }
  group.add(digit)

  // smoked glass cover: recessed below the bezel rim, slightly reflective,
  // alpha-blended (NO transmission — full-scene re-render cost)
  const glassMat = cachedMaterial('7seg-glass', () =>
    new THREE.MeshPhysicalMaterial({
      color: 0x1a070a,
      roughness: 0.08,
      metalness: 0,
      transparent: true,
      opacity: 0.45,
      depthWrite: false,
    }),
  )
  const glassGeo = cachedGeometry(`7seg-glass:${W.toFixed(2)}`, () =>
    new THREE.BoxGeometry(W - 0.5, 0.03, D - 0.5),
  )
  const glass = new THREE.Mesh(glassGeo, glassMat)
  glass.position.set(cx, topY + 0.1, zc)
  group.add(glass)

  // pins sit under the package (body overhangs the holes) — straight pins
  for (const p of pins) statics.push(pinLeg(p, baseY + 0.1, 0.07))
  for (const m of mergeStatic(statics)) group.add(m)

  const apply = (segments: Record<string, boolean> | undefined) => {
    for (const spec of SEG_LAYOUT) {
      const mat = segMats[spec.name]
      const lit = segments?.[spec.name] === true
      const s = lit ? SEG_LIT : SEG_UNLIT
      mat.color.setHex(s.color)
      mat.emissive.setHex(s.emissive)
      mat.emissiveIntensity = s.intensity
    }
  }
  apply(undefined)

  return {
    object: group,
    pinWorld: pins.map((p) => p.clone()),
    update: (_c2, _e2, telemetry) => {
      apply(telemetry?.segments)
    },
  }
}
