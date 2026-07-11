/**
 * Switches: tactile pushbutton (footprint), SPDT slide switch (leads),
 * 8-position DIP switch (DIP-16).
 *
 * Realism notes (judged against reference photos — 6x6 B3F-style tact switch,
 * SS-12 slide switch, KSD-08 DIP switch):
 *  - The tactile button is a black molded base under a stamped stainless top
 *    plate with a REAL punched round hole; the actuator pokes through it and
 *    the four molded corner stake posts sit on the plate. Legs are the
 *    characteristic outward-bowed "crab" wires.
 *  - The slide switch is a polished stamped-nickel shell with a punched
 *    travel slot, end mounting ears with real holes, a ribbed black slider
 *    and a tan phenolic base with flat stamped pins.
 *  - The DIP switch is a molded red body (double-draft profile = visible mold
 *    seam) with white piston levers in dark wells, an ON legend and printed
 *    position numbers.
 */

import * as THREE from 'three'
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js'
import type { ComponentInstance } from '../../model/types'
import type { CatalogEntry } from '../../model/catalog'
import { paramOf } from '../../model/catalog'
import {
  BuildResult,
  HOLE_DEPTH,
  cachedGeometry,
  cachedMaterial,
  centroidOf,
  frameBetween,
  gullWingLeg,
  markShared,
  mergeStatic,
  metal,
  plastic,
  roundedPath,
  topLabel,
} from './shared'
import { draftBodyGeometry } from './ics'

/** Rounded-rect outline (centered) for punched-plate shapes. */
function roundedRectPath(w: number, h: number, r: number): THREE.Shape {
  const s = new THREE.Shape()
  const x = -w / 2
  const y = -h / 2
  s.moveTo(x + r, y)
  s.lineTo(x + w - r, y)
  s.quadraticCurveTo(x + w, y, x + w, y + r)
  s.lineTo(x + w, y + h - r)
  s.quadraticCurveTo(x + w, y + h, x + w - r, y + h)
  s.lineTo(x + r, y + h)
  s.quadraticCurveTo(x, y + h, x, y + h - r)
  s.lineTo(x, y + r)
  s.quadraticCurveTo(x, y, x + r, y)
  return s
}

// ---------------------------------------------------------------------------
// Tactile pushbutton (footprint over 4 holes, cap depresses while pressed)
// ---------------------------------------------------------------------------

export function buildButton(
  comp: ComponentInstance,
  entry: CatalogEntry,
  pins: THREE.Vector3[],
): BuildResult {
  const group = new THREE.Group()
  const c = centroidOf(pins)

  // static body parts merge per material at the end (Phase D draw budget:
  // base+stakes → 1, plate → 1, all four crab legs → 1; 11 meshes → 4)
  const statics: THREE.Object3D[] = []

  // black molded base (axis-aligned: the footprint is fixed), small standoff
  const baseGeo = cachedGeometry('btn-base', () => new RoundedBoxGeometry(3.05, 0.62, 2.85, 2, 0.07))
  const base = new THREE.Mesh(baseGeo, plastic(0x1c1c1f, 0.55))
  base.position.set(c.x, 0.14 + 0.31, c.z)
  statics.push(base)

  // stamped stainless top plate with a REAL punched round actuator hole;
  // slightly embedded into the base top so no face is ever coplanar
  const plateGeo = cachedGeometry('btn-plate', () => {
    const shape = roundedRectPath(2.95, 2.78, 0.3)
    const hole = new THREE.Path()
    hole.absarc(0, 0, 0.74, 0, Math.PI * 2, true)
    shape.holes.push(hole)
    const g = new THREE.ExtrudeGeometry(shape, { depth: 0.09, bevelEnabled: false, curveSegments: 12 })
    g.rotateX(-Math.PI / 2) // flat in XZ, thickness along +y
    return g
  })
  // brushed (not polished) stainless: 0.45 keeps the metal read while the
  // Enhanced HDRI softbox no longer mirrors into a blown white face + bloom
  const plate = new THREE.Mesh(plateGeo, metal(0xd5d8dc, 0.45))
  plate.position.set(c.x, 0.74, c.z) // spans y 0.74..0.83 (base top 0.76)
  statics.push(plate)

  // four molded corner stake posts riveting the plate down (reference photo)
  const stakeGeo = cachedGeometry('btn-stake', () => new THREE.CylinderGeometry(0.19, 0.21, 0.1, 12))
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      const stake = new THREE.Mesh(stakeGeo, plastic(0x1c1c1f, 0.55))
      stake.position.set(c.x + sx * (2.95 / 2 - 0.34), 0.88, c.z + sz * (2.78 / 2 - 0.34))
      statics.push(stake)
    }
  }

  // round actuator cap pokes through the punched hole (visible clearance gap)
  const capGeo = cachedGeometry('btn-cap', () => new THREE.CylinderGeometry(0.58, 0.66, 0.56, 20))
  const cap = new THREE.Mesh(capGeo, plastic(0x111114, 0.45))
  const capRestY = 0.98
  cap.position.set(c.x, capRestY, c.z)
  group.add(cap)

  // "crab" legs: out of the hole, bow outward past the body edge, then bend
  // up and inward to enter the base side wall (see the tact-switch photo).
  // Both tube ends are buried (hole plug / base interior), so a light local
  // tube keeps the whole part well inside the triangle budget.
  for (const p of pins) {
    const sz = p.z >= c.z ? 1 : -1
    const path = roundedPath([
      new THREE.Vector3(p.x, HOLE_DEPTH, p.z),
      new THREE.Vector3(p.x, 0.16, p.z + 0.42 * sz),
      new THREE.Vector3(p.x, 0.42, p.z + 0.18 * sz),
      new THREE.Vector3(p.x, 0.5, p.z - 0.2 * sz), // buried inside the base
    ])
    statics.push(new THREE.Mesh(new THREE.TubeGeometry(path, 16, 0.055, 7, false), metal()))
  }
  for (const m of mergeStatic(statics)) group.add(m)

  const apply = (pressed: boolean) => {
    cap.position.y = capRestY - (pressed ? 0.16 : 0)
  }
  apply(paramOf(comp.params, entry, 'pressed') === true)

  return {
    object: group,
    pinWorld: pins.map((p) => p.clone()),
    update: (c2, e2, telemetry) => {
      apply(telemetry?.pressed ?? paramOf(c2.params, e2, 'pressed') === true)
    },
  }
}

// ---------------------------------------------------------------------------
// SPDT slide switch (SS-12 style; lever slides between 'a' and 'b')
// ---------------------------------------------------------------------------

export function buildSlideSwitch(
  comp: ComponentInstance,
  entry: CatalogEntry,
  pins: THREE.Vector3[],
): BuildResult {
  const group = new THREE.Group()
  const c = centroidOf(pins)
  const f = frameBetween(pins[0], pins[pins.length - 1])

  let spanX = 0
  for (const p of pins) {
    spanX = Math.max(spanX, Math.abs(p.clone().sub(c).dot(f.dir)) * 2)
  }
  const bodyW = Math.max(3.3, spanX + 1.3)
  const baseY = 0.1 // phenolic base bottom (small standoff over the board)
  const baseH = 0.34
  const shellH = 0.6
  const plateY = baseY + baseH + shellH // underside of the punched top plate
  const slotL = Math.min(bodyW - 1.6, 2.2)

  const frame = new THREE.Group()
  frame.position.set(c.x, 0, c.z)
  frame.rotation.y = f.angleY

  // static housing parts (everything but the sliding knob) merge per material
  // at the end: base / shell+ears / cavity / plate / pins → 5 meshes where the
  // unmerged build cost 9 (Phase D draw budget)
  const statics: THREE.Object3D[] = []

  // tan phenolic base (the SS-12 body bottom is fiber board, not metal)
  const baseGeo = cachedGeometry(`slide-base:${bodyW.toFixed(2)}`, () =>
    new THREE.BoxGeometry(bodyW, baseH, 1.36),
  )
  const phenolic = cachedMaterial('slide-phenolic', () =>
    new THREE.MeshPhysicalMaterial({ color: 0xb08a5e, roughness: 0.75, metalness: 0 }),
  )
  const base = new THREE.Mesh(baseGeo, phenolic)
  base.position.y = baseY + baseH / 2
  statics.push(base)

  // polished stamped-nickel shell (slightly narrower than the plate above)
  const shellGeo = cachedGeometry(`slide-shell:${bodyW.toFixed(2)}`, () =>
    new RoundedBoxGeometry(bodyW - 0.06, shellH, 1.28, 2, 0.05),
  )
  const shell = new THREE.Mesh(shellGeo, metal(0x868c94, 0.34))
  shell.position.y = baseY + baseH + shellH / 2
  statics.push(shell)

  // dark cavity visible through the punched travel slot
  const cavityGeo = cachedGeometry(`slide-cavity:${slotL.toFixed(2)}`, () =>
    new THREE.BoxGeometry(slotL + 0.3, 0.3, 0.62),
  )
  const cavityMat = cachedMaterial('slide-cavity-mat', () =>
    new THREE.MeshPhysicalMaterial({ color: 0x040405, roughness: 1.0, metalness: 0 }),
  )
  const cavity = new THREE.Mesh(cavityGeo, cavityMat)
  cavity.position.y = plateY - 0.24 // deep below the slot → reads as shadow
  statics.push(cavity)

  // top plate with a REAL punched rectangular travel slot
  const plateGeo = cachedGeometry(`slide-plate:${bodyW.toFixed(2)}:${slotL.toFixed(2)}`, () => {
    const shape = roundedRectPath(bodyW, 1.34, 0.08)
    const hole = new THREE.Path()
    const hw = slotL / 2
    hole.moveTo(-hw, -0.25)
    hole.lineTo(-hw, 0.25)
    hole.lineTo(hw, 0.25)
    hole.lineTo(hw, -0.25)
    hole.closePath()
    shape.holes.push(hole)
    const g = new THREE.ExtrudeGeometry(shape, { depth: 0.07, bevelEnabled: false, curveSegments: 6 })
    g.rotateX(-Math.PI / 2)
    return g
  })
  const plate = new THREE.Mesh(plateGeo, metal(0x8f959d, 0.3))
  plate.position.y = plateY
  statics.push(plate)

  // end mounting ears with punched holes (the SS-12 housing tabs)
  const earGeo = cachedGeometry('slide-ear', () => {
    const shape = roundedRectPath(0.44, 0.5, 0.1)
    const hole = new THREE.Path()
    hole.absarc(0.04, 0, 0.1, 0, Math.PI * 2, true)
    shape.holes.push(hole)
    const g = new THREE.ExtrudeGeometry(shape, { depth: 0.05, bevelEnabled: false, curveSegments: 8 })
    g.rotateX(-Math.PI / 2)
    return g
  })
  for (const sx of [-1, 1]) {
    const ear = new THREE.Mesh(earGeo, metal(0x868c94, 0.34))
    ear.position.set(sx * (bodyW / 2 + 0.2), plateY - 0.01, 0)
    ear.rotation.y = sx > 0 ? 0 : Math.PI
    statics.push(ear) // shares the shell's nickel → merges into the shell mesh
  }

  // ribbed black slider knob (stem through the slot + chunky knurled cap):
  // the knob GROUP animates (position.x = throw), so it merges internally —
  // stem+cap one mesh, the three ridges another — but stays out of `statics`
  const knob = new THREE.Group()
  const knobParts: THREE.Object3D[] = []
  const stemGeo = cachedGeometry('slide-stem', () => new THREE.BoxGeometry(0.36, 0.62, 0.42))
  const knobMat = plastic(0x18181b, 0.5)
  const stem = new THREE.Mesh(stemGeo, knobMat)
  stem.position.y = plateY + 0.16
  knobParts.push(stem)
  const capGeo = cachedGeometry('slide-knob', () => new RoundedBoxGeometry(0.58, 0.42, 0.62, 1, 0.06))
  const cap = new THREE.Mesh(capGeo, knobMat)
  cap.position.y = plateY + 0.52
  knobParts.push(cap)
  const ridgeGeo = cachedGeometry('slide-ridge', () => new THREE.BoxGeometry(0.08, 0.06, 0.6))
  for (const rx of [-0.17, 0, 0.17]) {
    const ridge = new THREE.Mesh(ridgeGeo, plastic(0x232328, 0.45))
    ridge.position.set(rx, plateY + 0.74, 0)
    knobParts.push(ridge)
  }
  for (const m of mergeStatic(knobParts)) knob.add(m)
  frame.add(knob)
  group.add(frame)

  // flat stamped pins out of the phenolic base into their holes (frame-local
  // x/z offsets keep them correct even for skewed lead placements)
  const legH = baseY + 0.15 - HOLE_DEPTH
  const pinGeo = cachedGeometry(`slide-pin:${legH.toFixed(2)}`, () =>
    new THREE.BoxGeometry(0.1, legH, 0.05),
  )
  const cosA = Math.cos(f.angleY)
  const sinA = Math.sin(f.angleY)
  for (const p of pins) {
    const dx = p.x - c.x
    const dz = p.z - c.z
    const lx = dx * cosA - dz * sinA // world→frame-local (inverse of rotation.y)
    const lz = dx * sinA + dz * cosA
    const pin = new THREE.Mesh(pinGeo, metal())
    pin.position.set(lx, HOLE_DEPTH + legH / 2, lz)
    statics.push(pin)
  }
  for (const m of mergeStatic(statics)) frame.add(m)

  const throwX = slotL / 2 - 0.28
  const apply = (state: string) => {
    // pin order is [a, common, b]; the frame's +X points a→b
    knob.position.x = state === 'b' ? throwX : -throwX
  }
  apply(String(paramOf(comp.params, entry, 'state') ?? 'a'))

  return {
    object: group,
    pinWorld: pins.map((p) => p.clone()),
    update: (c2, e2) => {
      apply(String(paramOf(c2.params, e2, 'state') ?? 'a'))
    },
  }
}

// ---------------------------------------------------------------------------
// DIP switch ×8 (DIP-16 body, 8 piston levers)
// ---------------------------------------------------------------------------

export function buildDipSwitch(
  comp: ComponentInstance,
  entry: CatalogEntry,
  pins: THREE.Vector3[],
): BuildResult {
  const group = new THREE.Group()
  let minX = Infinity
  let maxX = -Infinity
  let zSum = 0
  for (const p of pins) {
    minX = Math.min(minX, p.x)
    maxX = Math.max(maxX, p.x)
    zSum += p.z
  }
  const zc = pins.length ? zSum / pins.length : 0
  const span = maxX - minX
  const baseY = 0.25
  const bodyH = 0.78
  const topY = baseY + bodyH
  const cx = (minX + maxX) / 2
  const bodyD = 2.6 // narrower than the pin span so the gull-wings show

  // molded red body with the double-draft profile (visible mold seam line)
  const body = new THREE.Mesh(
    draftBodyGeometry(span + 1.6, bodyH, bodyD, 0.08),
    moldedRed(),
  )
  body.position.set(cx, baseY, zc)
  group.add(body)

  const onLbl = topLabel('ON', 0.7, 0.36, { w: 128, h: 64, fg: '#f2ece4' })
  if (onLbl) {
    onLbl.position.set(minX - 0.45, topY + 0.02, zc - 0.92) // proud, never coplanar
    group.add(onLbl)
  }

  // 8 wells + white piston levers along the package; pins 1..8 at minX..maxX.
  // Wells + gull-wing legs are static → merged per material below; the levers
  // are state-posed and MUST stay 8 separate meshes (Phase D draw budget:
  // this builder was the worst per-part offender at 49 meshes, now ~11).
  const statics: THREE.Object3D[] = []
  const wellGeo = cachedGeometry('dipsw-well', () => new THREE.BoxGeometry(0.56, 0.04, 1.45))
  const wellMat = cachedMaterial('dipsw-well-mat', () =>
    new THREE.MeshPhysicalMaterial({ color: 0x551714, roughness: 0.7, metalness: 0 }),
  )
  const leverGeo = cachedGeometry('dipsw-lever', () => new RoundedBoxGeometry(0.4, 0.26, 0.48, 1, 0.04))
  const leverMat = plastic(0xf2f0e6, 0.4)
  const levers: THREE.Mesh[] = []
  const switchCount = Math.max(1, Math.floor(pins.length / 2))
  for (let i = 0; i < switchCount; i++) {
    const x = span >= 1 ? minX + (i * span) / (switchCount - 1 || 1) : cx
    const well = new THREE.Mesh(wellGeo, wellMat)
    well.position.set(x, topY + 0.02, zc)
    statics.push(well)
    const lever = new THREE.Mesh(leverGeo, leverMat)
    lever.position.set(x, topY + 0.12, zc)
    group.add(lever)
    levers.push(lever)
  }

  // printed position numbers along the row-f edge: ONE baked label strip
  // (same glyphs/density as the old per-number planes, 1 draw instead of 8)
  const nums = numberStripLabel(switchCount, span)
  if (nums) {
    nums.position.set(cx, topY + 0.018, zc + 0.92)
    group.add(nums)
  }

  // DIP-16 package → stamped gull-wing legs like every other DIP
  for (const p of pins) {
    const reach = Math.abs(p.z - zc) - bodyD / 2
    statics.push(gullWingLeg(p, zc, { enterY: baseY + bodyH * 0.4, reach, width: 0.34 }))
  }
  for (const m of mergeStatic(statics)) group.add(m)

  const apply = (on: string) => {
    for (let i = 0; i < levers.length; i++) {
      // ON side toward row e (−z, the 'B' pins side)
      levers[i].position.z = zc + (on[i] === '1' ? -0.42 : 0.42)
    }
  }
  apply(String(paramOf(comp.params, entry, 'on') ?? '00000000'))

  return {
    object: group,
    pinWorld: pins.map((p) => p.clone()),
    update: (c2, e2) => {
      apply(String(paramOf(c2.params, e2, 'on') ?? '00000000'))
    },
  }
}

/**
 * All the DIP switch's printed position numbers baked into ONE label strip —
 * one shared canvas texture / material / plane per (count, span) instead of
 * `count` floating planes. Glyph size, font, color and per-digit placement
 * reproduce the old `topLabel(String(i+1), 0.34, 0.34, {w:64, h:64})` planes
 * exactly (same ≈188 px/unit density, same bold 62%-height face).
 */
function numberStripLabel(count: number, span: number): THREE.Mesh | null {
  if (typeof document === 'undefined') return null
  const h = 0.34 // plane height in units — the old per-number label size
  const w = span + h // covers the first/last digit cells
  const H = 64
  const W = Math.min(2048, Math.max(H, Math.round((w / h) * H)))
  const key = `dipsw-nums:${count}:${span.toFixed(2)}`
  const mat = cachedMaterial(key, () => {
    const canvas = document.createElement('canvas')
    canvas.width = W
    canvas.height = H
    const ctx = canvas.getContext('2d')
    if (ctx) {
      ctx.clearRect(0, 0, W, H)
      ctx.fillStyle = '#f2ece4'
      ctx.font = `bold ${Math.floor(H * 0.62)}px "Helvetica Neue", Arial, sans-serif`
      ctx.textAlign = 'center'
      ctx.textBaseline = 'middle'
      for (let i = 0; i < count; i++) {
        // digit centers mirror the lever x layout, strip-local
        const x = span >= 1 ? h / 2 + (i * span) / (count - 1 || 1) : w / 2
        ctx.fillText(String(i + 1), (x / w) * W, H / 2 + 1)
      }
    }
    const tex = new THREE.CanvasTexture(canvas)
    tex.colorSpace = THREE.SRGBColorSpace
    tex.anisotropy = 4
    markShared(tex)
    return new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false })
  })
  const geo = cachedGeometry(`toplabel:${w.toFixed(2)}x${h.toFixed(2)}`, () => {
    const g = new THREE.PlaneGeometry(w, h)
    g.rotateX(-Math.PI / 2)
    return g
  })
  return new THREE.Mesh(geo, mat)
}

/** Glossy molded red DIP-switch body plastic (shared). */
function moldedRed(): THREE.MeshPhysicalMaterial {
  return cachedMaterial('dipsw-body', () =>
    new THREE.MeshPhysicalMaterial({
      color: 0x86211c,
      roughness: 0.5,
      metalness: 0,
      clearcoat: 0.2,
      clearcoatRoughness: 0.4,
    }),
  )
}
