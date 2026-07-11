/**
 * Discrete semiconductors with state: LED (glow / burnout) and TO-92
 * transistor packages.
 *
 * Phase C asset redo — judged against reference macros:
 *  - LED: real 5mm construction. Water-clear colors (blue/white) get a
 *    colorless transmissive epoxy dome with crisp refraction; classic
 *    indicator colors (red/green/yellow) get colored-diffused epoxy. Both
 *    show the true internals: cathode anvil with reflector cup + die, anode
 *    post, a gold bond wire arcing between them, and a base flange with the
 *    real flat spot on the cathode side (geometry, not a texture).
 *  - TO-92: matte black molded body (full circle with a chord flat — the
 *    real cross-section, not a half-round), light mold texture, printed
 *    part number + lot code on the flat face.
 *
 * Transmission is allowed HERE ONLY (perf budget: "transmission LEDs-only");
 * every other part stays alpha-blend/opaque.
 */

import * as THREE from 'three'
import type { ComponentInstance } from '../../model/types'
import type { CatalogEntry } from '../../model/catalog'
import { paramOf } from '../../model/catalog'
import type { RoutedComponent } from '../internal/wire-router'
import {
  BuildResult,
  cachedGeometry,
  cachedMaterial,
  centroidOf,
  extendIntoBody,
  fakeLotCode,
  frameBetween,
  fromHole,
  labelMaterial,
  legMesh,
  markShared,
  mergeStatic,
  noiseNormalTexture,
  routedPoseFor,
  shortLabel,
  yawOf,
} from './shared'

// ---------------------------------------------------------------------------
// LED
// ---------------------------------------------------------------------------

const LED_COLORS: Record<string, number> = {
  red: 0xff3526,
  green: 0x2ecc55,
  yellow: 0xffd02e,
  blue: 0x2e66ff,
  white: 0xf2f2f2,
}

/** Colors molded as water-clear epoxy; the rest are colored-diffused. */
const LED_WATER_CLEAR = new Set(['blue', 'white'])

/**
 * Colored-diffused epoxy (red/green/yellow): TRANSLUCENT, like the reference
 * macro — deep saturated tint, internal anvil/post silhouettes showing
 * through, crisp window highlights on the dome. Diffusion comes from real
 * transmission (allowed: the perf budget is "transmission LEDs-only" and
 * these ARE the flagship LEDs) blurred by surface roughness; the saturated
 * depth comes from attenuation, not from piling color into the diffuse lobe
 * (which is what used to read salmon). transmission stays > 0 through
 * burnout so no program flag ever flips (no shader recompile), and the
 * material is NOT `transparent`, so depthWrite stays on and the board's
 * transparent hole-collar pass can never stamp over the dome (the Phase B
 * "ghost holes" artifact only ever bit depthWrite-false alpha blending).
 */
const LED_GLASS_DIFFUSED = { roughness: 0.32, transmission: 0.55 }
/** Water-clear epoxy: colorless, crisp refraction via real transmission. */
const LED_GLASS_CLEAR = { color: 0xf2f5f8, roughness: 0.03, transmission: 1.0 }
/** Smoked epoxy after burnout. */
const LED_GLASS_BURNED = { color: 0x33322e, roughness: 0.45 }

/**
 * T-1 package proportions from ref-led.jpg: body height ≈ 1.7 × diameter
 * (flange bottom 0.47 → dome top 1.89 = 1.42 tall over a 0.84 dia body).
 * Dome top stays ≤ 1.9 — the router's declared LED obstacle height — and the
 * body fills the router's standing column (see LED_ROUTED_LIFT below).
 */
const LED_BASE_Y = 0.49
const LED_CYL_H = 0.98
const LED_DOME_R = 0.42
/**
 * Flange radius 0.50 (real-LED flange:dome dia ratio ≈ 1.2): the router's
 * packed-LED nesting floor is 1.45 plan units for co-height neighbors
 * (internal/wires.ts ROUTED_BODY.led), so the flange disc must stay ≤ 0.72
 * or two nested LEDs' flange rims would shave each other (DESIGN §4b).
 */
const LED_FLANGE_R = 0.5
/** chord position of the cathode flat on the flange (local +X = cathode) */
const LED_FLAT_X = 0.38
/**
 * The router's default standing-span lift (wire-router baseLift for the LED
 * body spec). The geometry above is authored for THIS routed center: flange
 * bottom = center − 0.43, dome top = center + 0.99 — inside the standing
 * collision column [center − 0.45, center + 1.0] declared by
 * internal/wires.ts (ROUTED_BODY.led standing 1.45). Routed poses translate
 * the whole body by (center.y − LED_ROUTED_LIFT).
 */
const LED_ROUTED_LIFT = 0.9

/**
 * Shared soft radial halo billboard texture for lit LEDs (page lifetime).
 * Replaces the old per-LED dynamic PointLight: adding/removing a real light
 * changed three.js's lights hash and recompiled EVERY material's shader
 * (multi-hundred-ms hitches on the first blinks), and N lit LEDs multiplied
 * every fragment's lighting cost scene-wide. A pre-baked additive sprite +
 * emissive glass costs one tiny draw call per lit LED instead.
 */
let glowTex: THREE.Texture | null | undefined
function ledGlowTexture(): THREE.Texture | null {
  if (glowTex !== undefined) return glowTex
  if (typeof document === 'undefined') return (glowTex = null)
  const S = 128
  const canvas = document.createElement('canvas')
  canvas.width = S
  canvas.height = S
  const ctx = canvas.getContext('2d')
  if (!ctx) return (glowTex = null)
  const g = ctx.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S / 2)
  g.addColorStop(0, 'rgba(255,255,255,0.9)')
  g.addColorStop(0.2, 'rgba(255,255,255,0.5)')
  g.addColorStop(0.55, 'rgba(255,255,255,0.14)')
  g.addColorStop(1, 'rgba(255,255,255,0)')
  ctx.fillStyle = g
  ctx.fillRect(0, 0, S, S)
  const tex = new THREE.CanvasTexture(canvas)
  markShared(tex)
  glowTex = tex
  return tex
}

/** Flange disc with the real molded flat spot on the cathode (+X) side. */
function ledFlangeGeometry(): THREE.BufferGeometry {
  return cachedGeometry('led-flange', () => {
    const R = LED_FLANGE_R
    const theta = Math.acos(LED_FLAT_X / R)
    const shape = new THREE.Shape()
    shape.moveTo(LED_FLAT_X, -Math.sin(theta) * R)
    shape.absarc(0, 0, R, -theta, theta - Math.PI * 2, true) // long way: bulge −X
    shape.closePath() // the chord = the flat spot
    const g = new THREE.ExtrudeGeometry(shape, {
      depth: 0.12,
      bevelEnabled: false,
      curveSegments: 22,
    })
    g.rotateX(-Math.PI / 2) // extrusion → +Y (X preserved: flat stays at +X)
    return g
  })
}

export function buildLed(
  comp: ComponentInstance,
  entry: CatalogEntry,
  pins: THREE.Vector3[],
  routed?: RoutedComponent,
): BuildResult {
  const group = new THREE.Group()
  const [a, k] = [pins[0], pins[1]]
  const f = frameBetween(a, k)
  const rp = routedPoseFor(routed, pins, 2)
  const colorName = String(paramOf(comp.params, entry, 'color') ?? 'red')
  const color = LED_COLORS[colorName] ?? LED_COLORS.red
  const waterClear = LED_WATER_CLEAR.has(colorName)
  // diffused epoxy: the emission color, barely milked — staying saturated
  // (the bright IBL + ACES already lift it; more white reads salmon)
  const tint = new THREE.Color(color).lerp(new THREE.Color(0xffffff), 0.05)

  const baseY = LED_BASE_Y
  const cylH = LED_CYL_H
  const domeR = LED_DOME_R
  const domeY = baseY + cylH // sphere center

  // per-instance epoxy — burnout/reset mutate it, so it is never shared.
  // BOTH variants use real transmission (the perf budget is "transmission
  // LEDs-only" — and these are the LEDs): water-clear refracts crisply,
  // colored-diffused scatters it through a tinted attenuating body.
  const glass = waterClear
    ? new THREE.MeshPhysicalMaterial({
        color: LED_GLASS_CLEAR.color,
        roughness: LED_GLASS_CLEAR.roughness,
        metalness: 0,
        ior: 1.5,
        transmission: LED_GLASS_CLEAR.transmission,
        thickness: 0.45,
        specularIntensity: 1.0,
        emissive: new THREE.Color(color),
        emissiveIntensity: 0,
      })
    : new THREE.MeshPhysicalMaterial({
        color: tint,
        // surface roughness BLURS the transmitted scene → the milky-diffused
        // look with internals as soft silhouettes (exactly the reference)
        roughness: LED_GLASS_DIFFUSED.roughness,
        metalness: 0,
        ior: 1.5,
        transmission: LED_GLASS_DIFFUSED.transmission,
        thickness: 0.6,
        // attenuation carries the deep saturated color through the body —
        // the diffuse lobe alone used to read salmon under the bright IBL
        attenuationColor: new THREE.Color(color),
        attenuationDistance: 1.0,
        specularIntensity: 1.0,
        // glossy molded surface: the crisp window highlights on the dome
        clearcoat: 0.55,
        clearcoatRoughness: 0.18,
        emissive: new THREE.Color(color),
        emissiveIntensity: 0,
      })

  const bodyGroup = new THREE.Group()
  if (rp) {
    // LEDs always stand dome-up: the geometry is authored for the router's
    // default standing lift, so the whole body translates with the routed
    // center; yaw the internals to the lead-span axis
    const yOff = Math.max(-0.45, rp.center.y - LED_ROUTED_LIFT)
    bodyGroup.position.set(rp.center.x, yOff, rp.center.z)
    bodyGroup.rotation.y = yawOf(rp.dir, f.angleY)
  } else {
    bodyGroup.position.set(f.mid.x, 0, f.mid.z)
    bodyGroup.rotation.y = f.angleY // align internals with the anode→cathode axis
  }

  // cylinder + dome merge into ONE transmissive mesh (each transmissive mesh
  // is an extra draw in the transmissive pass — and a draw call besides)
  const cylGeo = cachedGeometry('led-cyl', () => new THREE.CylinderGeometry(domeR, domeR, cylH, 24))
  const cyl = new THREE.Mesh(cylGeo, glass)
  cyl.position.y = baseY + cylH / 2

  const domeGeo = cachedGeometry(
    'led-dome',
    () => new THREE.SphereGeometry(domeR, 24, 12, 0, Math.PI * 2, 0, Math.PI / 2),
  )
  const dome = new THREE.Mesh(domeGeo, glass)
  dome.position.y = domeY
  for (const m of mergeStatic([cyl, dome])) bodyGroup.add(m)

  // base flange with the molded flat spot on the cathode side (real geometry)
  const flange = new THREE.Mesh(ledFlangeGeometry(), glass)
  flange.position.y = baseY - 0.02 // top ends 0.1 into the cylinder, never coplanar
  bodyGroup.add(flange)

  // --- visible internals: lead frame (anvil + post), cup, die, bond wire ----
  const frameMetal = cachedMaterial('led-frame', () =>
    new THREE.MeshPhysicalMaterial({ color: 0x8d9298, metalness: 1.0, roughness: 0.35 }),
  )
  const anvilGeo = cachedGeometry('led-anvil', () => new THREE.BoxGeometry(0.16, 0.56, 0.22))
  const anvil = new THREE.Mesh(anvilGeo, frameMetal) // cathode side (+X), carries the cup
  anvil.position.set(0.13, baseY + 0.28, 0)
  const postGeo = cachedGeometry('led-post', () => new THREE.BoxGeometry(0.09, 0.42, 0.12))
  const post = new THREE.Mesh(postGeo, frameMetal) // anode post (−X)
  post.position.set(-0.14, baseY + 0.21, 0)
  for (const m of mergeStatic([anvil, post])) bodyGroup.add(m)

  const cupGeo = cachedGeometry(
    'led-cup',
    () => new THREE.CylinderGeometry(0.24, 0.12, 0.17, 16, 1, true),
  )
  const cupMat = cachedMaterial('led-cup-mat', () =>
    new THREE.MeshPhysicalMaterial({ color: 0xc8ccd0, metalness: 1.0, roughness: 0.25, side: THREE.DoubleSide }),
  )
  const cup = new THREE.Mesh(cupGeo, cupMat)
  cup.position.set(0.13, baseY + 0.61, 0)
  bodyGroup.add(cup)

  // the die itself: per-instance emissive — this is what "lights up"
  const dieMat = new THREE.MeshStandardMaterial({
    color: 0x6a665a,
    roughness: 0.4,
    emissive: color,
    emissiveIntensity: 0,
  })
  const dieGeo = cachedGeometry('led-die', () => new THREE.BoxGeometry(0.09, 0.05, 0.09))
  const die = new THREE.Mesh(dieGeo, dieMat)
  die.position.set(0.13, baseY + 0.58, 0)
  bodyGroup.add(die)

  // gold bond wire arcing from the anode post top down onto the die
  const bondGeo = cachedGeometry('led-bond', () => {
    const curve = new THREE.QuadraticBezierCurve3(
      new THREE.Vector3(-0.14, 0.43, 0),
      new THREE.Vector3(0.0, 0.8, 0.02),
      new THREE.Vector3(0.12, 0.61, 0),
    )
    return new THREE.TubeGeometry(curve, 12, 0.014, 5, false)
  })
  const gold = cachedMaterial('led-bond-mat', () =>
    new THREE.MeshPhysicalMaterial({ color: 0xd6b25e, metalness: 1.0, roughness: 0.28 }),
  )
  const bond = new THREE.Mesh(bondGeo, gold)
  bond.position.y = baseY
  bodyGroup.add(bond)
  group.add(bodyGroup)

  // --- legs: real LED leads exit the package BOTTOM under the flange — never
  // the epoxy side wall. Each lead follows its routed waypoints while it is
  // clear of the flange footprint, then drops below the base, runs under the
  // package and turns up into the bottom face beside the lead frame.
  const flangeBottomY = bodyGroup.position.y + baseY - 0.02
  const underY = Math.max(0.14, flangeBottomY - 0.14)
  const axisX = Math.cos(bodyGroup.rotation.y)
  const axisZ = -Math.sin(bodyGroup.rotation.y)
  const bottomEntry = (side: number) =>
    new THREE.Vector3(
      bodyGroup.position.x + axisX * side * 0.25,
      flangeBottomY + 0.3, // buried inside the cylinder, swallowed end cap
      bodyGroup.position.z + axisZ * side * 0.25,
    )
  const legStatics: THREE.Object3D[] = []
  if (rp) {
    const exitR = LED_FLANGE_R + 0.18
    rp.legs.forEach((leg, i) => {
      const path: THREE.Vector3[] = []
      for (const p of leg) {
        // cut where the routed run would cross into the flange footprint
        if (
          path.length > 0 &&
          Math.hypot(p.x - bodyGroup.position.x, p.z - bodyGroup.position.z) < exitR
        ) {
          break
        }
        // ride the routed plan corridor but never ABOVE the package bottom:
        // a lead that humps over its own flange reads as a basket handle.
        // Lower-than-sampled is safe (same plan corridor, farther from the
        // wires that were routed over the sampled path).
        path.push(new THREE.Vector3(p.x, Math.min(p.y, underY), p.z))
      }
      // level out at the under-body height (rise straight out of the hole
      // when the span is too short to have climbed at all)
      const last = path[path.length - 1]
      if (Math.abs(last.y - underY) > 0.04) path.push(new THREE.Vector3(last.x, underY, last.z))
      const entryPt = bottomEntry(i === 0 ? -1 : 1)
      if (Math.hypot(last.x - entryPt.x, last.z - entryPt.z) > 1e-3) {
        path.push(new THREE.Vector3(entryPt.x, underY, entryPt.z))
      }
      path.push(entryPt)
      legStatics.push(legMesh(path, 0.055))
    })
  } else {
    for (const [pin, side] of [
      [a, -1],
      [k, 1],
    ] as [THREE.Vector3, number][]) {
      const entryPt = bottomEntry(side)
      legStatics.push(
        legMesh(
          fromHole(
            pin,
            new THREE.Vector3(pin.x, underY, pin.z),
            new THREE.Vector3(entryPt.x, underY, entryPt.z),
            entryPt,
          ),
          0.055,
        ),
      )
    }
  }
  for (const m of mergeStatic(legStatics)) group.add(m)

  // lit-LED halo: a pre-baked additive billboard (see ledGlowTexture) — its
  // material is per-instance (opacity/scale track brightness), the texture is
  // shared. Toggling `visible` never touches three's lights hash, so blinking
  // LEDs cause zero shader recompiles.
  const glowMat = new THREE.SpriteMaterial({
    map: ledGlowTexture(),
    color,
    transparent: true,
    opacity: 0,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  })
  const glow = new THREE.Sprite(glowMat)
  glow.position.set(
    bodyGroup.position.x,
    bodyGroup.position.y + domeY + 0.15,
    bodyGroup.position.z,
  )
  glow.scale.setScalar(2.2)
  glow.visible = false
  group.add(glow)

  const state = { burned: false }

  const restoreLive = () => {
    if (waterClear) {
      glass.color.setHex(LED_GLASS_CLEAR.color)
      glass.roughness = LED_GLASS_CLEAR.roughness
      glass.transmission = LED_GLASS_CLEAR.transmission
    } else {
      glass.color.copy(tint)
      glass.roughness = LED_GLASS_DIFFUSED.roughness
      glass.transmission = LED_GLASS_DIFFUSED.transmission
    }
  }

  const update: BuildResult['update'] = (_c2, _e2, telemetry) => {
    if (telemetry?.burned) {
      if (!state.burned) {
        state.burned = true
        // smoked epoxy: dark tint; both variants keep a sliver of transmission
        // (numeric-only change — no shader recompile from program flag flips)
        glass.color.setHex(LED_GLASS_BURNED.color)
        glass.roughness = LED_GLASS_BURNED.roughness
        glass.transmission = waterClear ? 0.12 : 0.05
        glass.emissiveIntensity = 0
        dieMat.emissiveIntensity = 0
        dieMat.color.setHex(0x191813)
        glow.visible = false
        glowMat.opacity = 0
      }
      return
    }
    if (state.burned) {
      // the engine cleared its burned flag (rebuild/reset) — restore the live look
      state.burned = false
      restoreLive()
      dieMat.color.setHex(0x6a665a)
    }
    const b = THREE.MathUtils.clamp(telemetry?.ledBrightness ?? 0, 0, 1)
    dieMat.emissiveIntensity = b <= 0.001 ? 0 : 0.4 + 5.5 * b
    // the body lights up — softer on water-clear (the die does the work there)
    glass.emissiveIntensity = b <= 0.001 ? 0 : waterClear ? 0.12 + 0.5 * b : 0.25 + 0.9 * b
    if (b > 0.05) {
      glow.visible = true
      glowMat.opacity = Math.min(1, 0.3 + 0.7 * b)
      glow.scale.setScalar(2.0 + 1.4 * b)
    } else {
      glow.visible = false
      glowMat.opacity = 0
    }
  }

  return { object: group, pinWorld: pins.map((p) => p.clone()), update }
}

// ---------------------------------------------------------------------------
// TO-92 (transistors / small MOSFETs)
// ---------------------------------------------------------------------------

// Body top must stay ≤ 1.85 — the router's declared TO-92 obstacle height.
const TO92_R = 0.85
/** chord offset: full circle with a flat — depth ≈ 0.8 × diameter, per spec */
const TO92_CHORD = 0.51
const TO92_H = 1.42
const TO92_BASE_Y = 0.4
/** local z of the flat face plane (before the molding bevel) */
const TO92_FACE_Z = 0.68

/** Matte molded epoxy with a visible light mold texture (TO-92 finish). */
function to92Mold(): THREE.MeshPhysicalMaterial {
  return cachedMaterial('to92-mold', () => {
    const m = new THREE.MeshPhysicalMaterial({
      color: 0x232326,
      roughness: 0.62,
      metalness: 0,
      clearcoat: 0.06,
      clearcoatRoughness: 0.5,
    })
    const n = noiseNormalTexture()
    if (n) {
      m.normalMap = n
      m.normalScale.set(0.45, 0.45)
    }
    return m
  })
}

function to92BodyGeometry(): THREE.BufferGeometry {
  return cachedGeometry('to92-body', () => {
    // real TO-92 cross-section: a full circle with one chord flat (NOT a
    // semicircle) — bulge depth ≈ 1.47 vs width 1.84 at R 0.92
    const R = TO92_R
    const c = TO92_CHORD
    const aHalf = Math.sqrt(R * R - c * c)
    const t1 = Math.atan2(-c, -aHalf) // chord left point, rel. circle center
    const t2 = Math.atan2(-c, aHalf) // chord right point
    const shape = new THREE.Shape()
    shape.moveTo(-aHalf, 0)
    shape.absarc(0, c, R, t1, t2, true) // clockwise = the long way over the top
    shape.closePath() // chord = the flat face
    const g = new THREE.ExtrudeGeometry(shape, {
      depth: TO92_H - 0.1,
      curveSegments: 24,
      // molded parts have draft/rounded edges, not razor extrusions
      bevelEnabled: true,
      bevelThickness: 0.05,
      bevelSize: 0.05,
      bevelSegments: 2,
    })
    g.rotateX(-Math.PI / 2) // extrusion → +Y (up); bulge (shape +y) → local −Z
    g.translate(0, TO92_BASE_Y + 0.05, TO92_FACE_Z)
    return g
  })
}

export function buildTo92(
  _comp: ComponentInstance,
  entry: CatalogEntry,
  pins: THREE.Vector3[],
  routed?: RoutedComponent,
): BuildResult {
  const group = new THREE.Group()
  const c = centroidOf(pins)
  const f = frameBetween(pins[0], pins[pins.length - 1])
  const rp = routedPoseFor(routed, pins, Math.min(3, pins.length))

  const baseY = TO92_BASE_Y
  const bodyH = TO92_H
  const faceZ = TO92_FACE_Z

  const frame = new THREE.Group()
  if (rp) {
    // TO-92 packages stand at their molded height; routed poses move the
    // body over the board (x/z) and yaw it along the routed lead axis
    frame.position.set(rp.center.x, 0, rp.center.z)
    frame.rotation.y = yawOf(rp.dir, f.angleY)
  } else {
    frame.position.set(c.x, 0, c.z)
    frame.rotation.y = f.angleY
  }

  frame.add(new THREE.Mesh(to92BodyGeometry(), to92Mold()))

  // printed part number + lot code on the flat face (faces local +Z) — the
  // bevel pushes the face to faceZ+0.05, so +0.075 keeps the ink 0.025 proud
  const code = shortLabel(entry)
  const lblMat = labelMaterial(code, { w: 256, h: 80, fg: '#d6d6d8' })
  if (lblMat) {
    const lblGeo = cachedGeometry('to92-label', () => new THREE.PlaneGeometry(1.0, 0.36))
    const lbl = new THREE.Mesh(lblGeo, lblMat)
    lbl.position.set(0, baseY + bodyH * 0.62, faceZ + 0.075)
    frame.add(lbl)
  }
  const lotMat = labelMaterial(fakeLotCode(code), { w: 256, h: 72, fg: '#9b9b9e' })
  if (lotMat) {
    const lotGeo = cachedGeometry('to92-lot', () => new THREE.PlaneGeometry(0.72, 0.22))
    const lot = new THREE.Mesh(lotGeo, lotMat)
    lot.position.set(0, baseY + bodyH * 0.34, faceZ + 0.075)
    frame.add(lot)
  }
  group.add(frame)

  const statics: THREE.Object3D[] = []
  if (rp) {
    const interior = new THREE.Vector3(frame.position.x, baseY + 0.45, frame.position.z)
    for (const leg of rp.legs) {
      const path = leg.slice()
      extendIntoBody(path, interior, null, 0.2)
      statics.push(legMesh(path))
    }
  } else {
    // legs: the real flat-face spread — they fan from the holes into a tight
    // 0.5-pitch row under the body, entering just behind the flat face
    const n = pins.length
    for (let i = 0; i < n; i++) {
      const pin = pins[i]
      const lx = (i - (n - 1) / 2) * 0.5
      // local +Z maps to world −perp; enter the body slightly on the face side
      const entryPt = c
        .clone()
        .addScaledVector(f.dir, lx)
        .addScaledVector(f.perp, -0.15)
      statics.push(
        legMesh(
          fromHole(
            pin,
            new THREE.Vector3(pin.x, 0.3, pin.z),
            new THREE.Vector3(entryPt.x, baseY - 0.1, entryPt.z),
            new THREE.Vector3(entryPt.x, baseY + 0.25, entryPt.z),
          ),
        ),
      )
    }
  }
  for (const m of mergeStatic(statics)) group.add(m)

  return { object: group, pinWorld: pins.map((p) => p.clone()) }
}
