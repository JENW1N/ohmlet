/**
 * Tests for the procedural component visuals (meshes agent):
 * PBR material spec values, gull-wing DIP legs, LED glass + die internals,
 * dispose safety with the shared-resource WeakSet, the GLTF override hook,
 * and the per-component triangle budget.
 *
 * Runs in node (no DOM): canvas-backed textures degrade to null by design.
 */
import { afterEach, describe, expect, it } from 'vitest'
import * as THREE from 'three'
import { CATALOG, getEntry } from '../src/model/catalog'
import type { ComponentInstance, ComponentTelemetry } from '../src/model/types'
import {
  buildComponentObject,
  disposeComponentObject,
  updateComponentVisual,
} from '../src/three/component-meshes'
import {
  fakeLotCode,
  gullWingLeg,
  isSharedResource,
  legMesh,
  makeWireMaterial,
  markShared,
  metal,
  moldedEpoxy,
  plastic,
} from '../src/three/meshes/shared'
import {
  clearModelOverrides,
  hasModelOverride,
  loadModelOverride,
  registerModelOverride,
  tryModelOverride,
} from '../src/three/meshes/gltf-overrides'
import { resistorBandLayout, resistorRadiusAt } from '../src/three/meshes/passives'
import type { RoutedComponent } from '../src/three/internal/wire-router'

const v = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z)

function entryOf(type: string) {
  const e = getEntry(type)
  if (!e) throw new Error(`catalog entry missing: ${type}`)
  return e
}

function comp(type: string, params?: Record<string, number | string | boolean>): ComponentInstance {
  return { id: `T_${type}`, type, params }
}

const telemetry = (extra: Partial<ComponentTelemetry>): ComponentTelemetry => ({
  pinVoltages: {},
  ...extra,
})

/** All meshes (with geometry+material) under a root. */
function meshesOf(root: THREE.Object3D): THREE.Mesh[] {
  const out: THREE.Mesh[] = []
  root.traverse((o) => {
    if ((o as THREE.Mesh).isMesh) out.push(o as THREE.Mesh)
  })
  return out
}

function materialsOf(root: THREE.Object3D): THREE.Material[] {
  const out = new Set<THREE.Material>()
  for (const m of meshesOf(root)) {
    const mat = m.material
    for (const mm of Array.isArray(mat) ? mat : [mat]) out.add(mm)
  }
  return [...out]
}

function triangleCount(root: THREE.Object3D): number {
  let tris = 0
  for (const m of meshesOf(root)) {
    const g = m.geometry
    tris += (g.index ? g.index.count : g.attributes.position.count) / 3
  }
  return tris
}

/**
 * The resistor's body mesh. Phase D merges the dog-bone lathe + the two lead
 * meniscus collars into ONE lacquer mesh, so it is located by its material
 * (the 0.38-roughness dip-coat) rather than by LatheGeometry type.
 */
function resistorBodyOf(root: THREE.Object3D): THREE.Mesh {
  const body = meshesOf(root).find(
    (m) => (m.material as THREE.MeshPhysicalMaterial).roughness === 0.38,
  )
  expect(body).toBeDefined()
  return body!
}

/** DIP pin layout: n/2 pins along row f (z=+1.5), n/2 back along row e. */
function dipPins(n: number): THREE.Vector3[] {
  const half = n / 2
  const pins: THREE.Vector3[] = []
  for (let i = 0; i < half; i++) pins.push(v(i, 0, 1.5))
  for (let i = half - 1; i >= 0; i--) pins.push(v(i, 0, -1.5))
  return pins
}

/** The same package rotated 180° (dipHoles convention: pin 1 at the RIGHT end of row e). */
function dipPins180(n: number): THREE.Vector3[] {
  const half = n / 2
  const pins: THREE.Vector3[] = []
  for (let i = half - 1; i >= 0; i--) pins.push(v(i, 0, -1.5))
  for (let i = 0; i < half; i++) pins.push(v(i, 0, 1.5))
  return pins
}

afterEach(() => clearModelOverrides())

// ---------------------------------------------------------------------------
// Shared PBR materials
// ---------------------------------------------------------------------------

describe('shared PBR materials', () => {
  it('metal(): physical, metalness 1.0, roughness in the 0.22–0.35 band, shared', () => {
    const m = metal()
    expect(m).toBeInstanceOf(THREE.MeshPhysicalMaterial)
    expect(m.metalness).toBe(1.0)
    expect(m.roughness).toBeGreaterThanOrEqual(0.22)
    expect(m.roughness).toBeLessThanOrEqual(0.35)
    expect(isSharedResource(m)).toBe(true)
    expect(metal()).toBe(m) // cached
  })

  it('moldedEpoxy(): near-black, roughness 0.45, clearcoat 0.25/0.4', () => {
    const m = moldedEpoxy()
    expect(m.color.getHex()).toBe(0x1a1a1c)
    expect(m.roughness).toBe(0.45)
    expect(m.clearcoat).toBe(0.25)
    expect(m.clearcoatRoughness).toBe(0.4)
    expect(isSharedResource(m)).toBe(true)
  })

  it('plastic(): ABS roughness 0.55 default, physical, shared + cached', () => {
    const m = plastic(0x123456)
    expect(m).toBeInstanceOf(THREE.MeshPhysicalMaterial)
    expect(m.roughness).toBe(0.55)
    expect(plastic(0x123456)).toBe(m)
    expect(isSharedResource(m)).toBe(true)
  })

  it('makeWireMaterial(): PVC look — roughness 0.4, clearcoat 0.15, cached per color', () => {
    const m = makeWireMaterial(0xff0000)
    expect(m.roughness).toBe(0.4)
    expect(m.clearcoat).toBe(0.15)
    expect(m.metalness).toBe(0)
    expect(isSharedResource(m)).toBe(true)
    expect(makeWireMaterial('#ff0000')).toBe(m)
    expect(makeWireMaterial(0x00ff00)).not.toBe(m)
  })

  it('fakeLotCode(): deterministic, plausible date/lot shape', () => {
    expect(fakeLotCode('NE555')).toBe(fakeLotCode('NE555'))
    expect(fakeLotCode('NE555')).toMatch(/^2[1-5]\d{2} [A-Z]\d{2}$/)
    expect(fakeLotCode('NE555')).not.toBe(fakeLotCode('CD4017'))
  })
})

// ---------------------------------------------------------------------------
// Resistor / capacitors
// ---------------------------------------------------------------------------

describe('resistor', () => {
  const pins = [v(0, 0, 0), v(4, 0, 0)]

  it('has a dog-bone body in tan dip-lacquer (subtle sheen), collars folded in', () => {
    const built = buildComponentObject(comp('resistor'), entryOf('resistor'), pins)
    const body = resistorBodyOf(built.object)
    const mat = body.material as THREE.MeshPhysicalMaterial
    expect(mat.roughness).toBe(0.38) // glossy dip-coat, not matte ceramic
    expect(mat.clearcoat).toBeGreaterThanOrEqual(0.5) // the lacquer sheen
    // the dog-bone silhouette is real geometry: cap bulge AND waist present
    const pos = body.geometry.attributes.position
    let maxR = 0
    for (let i = 0; i < pos.count; i++) {
      maxR = Math.max(maxR, Math.hypot(pos.getY(i), pos.getZ(i)))
    }
    expect(maxR).toBeCloseTo(0.4, 1) // RES_R_CAP
    // exactly ONE lacquer mesh: the meniscus collars merged into the body
    const lacquer = meshesOf(built.object).filter((m) => m.material === mat)
    expect(lacquer).toHaveLength(1)
    disposeComponentObject(built.object)
  })

  it('renders 4 color bands in glossier paint: flat bands vertex-color-merged + metallic gold', () => {
    const built = buildComponentObject(
      comp('resistor', { resistance: 4700 }),
      entryOf('resistor'),
      pins,
    )
    const bandMeshes = meshesOf(built.object).filter(
      (m) => (m.material as THREE.MeshPhysicalMaterial).roughness === 0.35,
    )
    // Phase D: the flat digit/multiplier bands merge into ONE mesh whose tints
    // ride in the vertex color channel; the gold tolerance band keeps its own
    // metallic paint (2 draws where there were 4)
    expect(bandMeshes).toHaveLength(2)
    const flat = bandMeshes.find(
      (m) => (m.material as THREE.MeshPhysicalMaterial).vertexColors,
    )
    expect(flat).toBeDefined()
    expect((flat!.material as THREE.MeshPhysicalMaterial).color.getHex()).toBe(0xffffff)
    const colors = flat!.geometry.getAttribute('color')
    expect(colors).toBeDefined()
    // 4.7kΩ = yellow / violet / red: three DISTINCT band tints in one mesh
    const distinct = new Set<string>()
    for (let i = 0; i < colors.count; i++) {
      distinct.add(
        `${colors.getX(i).toFixed(3)},${colors.getY(i).toFixed(3)},${colors.getZ(i).toFixed(3)}`,
      )
    }
    expect(distinct.size).toBe(3)
    const gold = bandMeshes.find(
      (m) => (m.material as THREE.MeshPhysicalMaterial).metalness === 0.8,
    )
    expect(gold).toBeDefined()
    disposeComponentObject(built.object)
  })

  it('legs are real metal (metalness 1.0)', () => {
    const built = buildComponentObject(comp('resistor'), entryOf('resistor'), pins)
    const metals = materialsOf(built.object).filter(
      (m) => (m as THREE.MeshPhysicalMaterial).metalness === 1.0,
    )
    expect(metals.length).toBeGreaterThan(0)
    disposeComponentObject(built.object)
  })
})

describe('capacitors', () => {
  const pins = [v(0, 0, 0), v(2, 0, 0)]

  it('electrolytic: lathed aluminum can (metalness 0.9, roughness 0.3) + sleeve', () => {
    const built = buildComponentObject(
      comp('capacitor', { polarized: true }),
      entryOf('capacitor'),
      pins,
    )
    const lathe = meshesOf(built.object).find((m) => m.geometry.type === 'LatheGeometry')
    expect(lathe).toBeDefined()
    const alu = lathe!.material as THREE.MeshPhysicalMaterial
    expect(alu.metalness).toBe(0.9)
    expect(alu.roughness).toBe(0.3)
    // printed shrink sleeve: a second lathe following the can + crimp groove
    const lathes = meshesOf(built.object).filter((m) => m.geometry.type === 'LatheGeometry')
    expect(lathes.length).toBeGreaterThanOrEqual(2)
    const sleeve = lathes.find(
      (m) => (m.material as THREE.MeshPhysicalMaterial).side === THREE.DoubleSide,
    )
    expect(sleeve).toBeDefined()
    // K-scored vent top rides strictly proud of the can's top face
    const vent = meshesOf(built.object).find((m) => m.geometry.type === 'CircleGeometry')
    expect(vent).toBeDefined()
    disposeComponentObject(built.object)
  })

  it('ceramic disc: rounded lens (sphere-based) under an amber glaze', () => {
    const built = buildComponentObject(comp('capacitor'), entryOf('capacitor'), pins)
    const lens = meshesOf(built.object).find((m) => m.geometry.type === 'SphereGeometry')
    expect(lens).toBeDefined()
    const glaze = lens!.material as THREE.MeshPhysicalMaterial
    expect(glaze.roughness).toBe(0.42) // dipped epoxy glaze, satin
    expect(glaze.clearcoat).toBeGreaterThanOrEqual(0.5) // glaze sheen
    disposeComponentObject(built.object)
  })
})

// ---------------------------------------------------------------------------
// LED — tinted glass, internal die, light + burnout
// ---------------------------------------------------------------------------

describe('LED', () => {
  const pins = [v(0, 0, 0), v(2, 0, 0)]
  const build = () => buildComponentObject(comp('led', { color: 'red' }), entryOf('led'), pins)

  function glassOf(root: THREE.Object3D): THREE.MeshPhysicalMaterial {
    // the epoxy body: the per-instance physical material with an emissive
    // channel (the die is a plain MeshStandardMaterial, the lead frame has
    // emissive 0x000000 but is shared)
    const g = materialsOf(root).find(
      (m) =>
        (m as THREE.MeshPhysicalMaterial).isMeshPhysicalMaterial &&
        !isSharedResource(m) &&
        (m as THREE.MeshPhysicalMaterial).emissive.getHex() !== 0,
    ) as THREE.MeshPhysicalMaterial
    expect(g).toBeDefined()
    return g
  }

  function glowOf(root: THREE.Object3D): THREE.Sprite {
    const out: THREE.Sprite[] = []
    root.traverse((o) => {
      if ((o as THREE.Sprite).isSprite) out.push(o as THREE.Sprite)
    })
    expect(out).toHaveLength(1)
    return out[0]
  }

  function dieOf(root: THREE.Object3D): THREE.MeshStandardMaterial {
    const d = materialsOf(root).find(
      (m) =>
        (m as THREE.MeshStandardMaterial).emissive !== undefined &&
        !(m as THREE.MeshPhysicalMaterial).isMeshPhysicalMaterial &&
        (m as THREE.MeshStandardMaterial).emissive.getHex() !== 0,
    ) as THREE.MeshStandardMaterial
    expect(d).toBeDefined()
    return d
  }

  it('red/green/yellow are colored-diffused TRANSLUCENT epoxy (attenuated transmission)', () => {
    const built = build()
    const glass = glassOf(built.object)
    // translucent like the reference macro — internals silhouette through —
    // but clearly NOT water-clear
    expect(glass.transmission).toBeGreaterThanOrEqual(0.4)
    expect(glass.transmission).toBeLessThanOrEqual(0.7)
    // the deep saturated color rides in the attenuation, not in a milked
    // diffuse lobe (the diffuse-only body read salmon under the bright IBL)
    expect(glass.attenuationColor.getHex()).toBe(0xff3526)
    expect(glass.attenuationDistance).toBeLessThanOrEqual(1.5)
    // NOT alpha-blended: depthWrite-false transparency lets the board's
    // collar pass stamp over the dome (Phase B artifact); transmission keeps
    // depth writes on
    expect(glass.transparent).toBe(false)
    expect(glass.depthWrite).toBe(true)
    expect(glass.ior).toBe(1.5)
    expect(glass.roughness).toBe(0.32) // blurs the transmitted internals: milky
    expect(glass.clearcoat).toBeGreaterThanOrEqual(0.4) // crisp dome window highlights
    expect(isSharedResource(glass)).toBe(false) // per-instance (burnout mutates it)
    disposeComponentObject(built.object)
  })

  it('blue/white are water-clear: real transmission, colorless, crisp refraction', () => {
    for (const colorName of ['blue', 'white']) {
      const built = buildComponentObject(
        comp('led', { color: colorName }),
        entryOf('led'),
        pins,
      )
      const clear = materialsOf(built.object).find(
        (m) => ((m as THREE.MeshPhysicalMaterial).transmission ?? 0) > 0,
      ) as THREE.MeshPhysicalMaterial
      expect(clear, colorName).toBeDefined()
      expect(clear.transmission).toBe(1.0)
      expect(clear.ior).toBe(1.5)
      expect(clear.roughness).toBeLessThanOrEqual(0.05) // water-clear polish
      expect(clear.metalness).toBe(0)
      expect(isSharedResource(clear)).toBe(false) // per-instance (burnout mutates it)
      disposeComponentObject(built.object)
    }
  })

  it('flange carries the cathode flat spot as REAL extruded geometry', () => {
    const built = build()
    const flange = meshesOf(built.object).find((m) => m.geometry.type === 'ExtrudeGeometry')
    expect(flange).toBeDefined()
    // the chord flat truncates the disc on the cathode (+X internals) side:
    // max X extent is visibly smaller than the radius on the round side
    flange!.geometry.computeBoundingBox()
    const bb = flange!.geometry.boundingBox!
    expect(bb.max.x).toBeLessThan(-bb.min.x - 0.08)
    disposeComponentObject(built.object)
  })

  it('has visible internals: reflector cup + emissive die', () => {
    const built = build()
    // cup: open-ended cone of metal
    const cup = meshesOf(built.object).find((m) => {
      const mat = m.material as THREE.MeshPhysicalMaterial
      return m.geometry.type === 'CylinderGeometry' && mat.side === THREE.DoubleSide && mat.metalness === 1.0
    })
    expect(cup).toBeDefined()
    expect(dieOf(built.object)).toBeDefined()
    disposeComponentObject(built.object)
  })

  it('lights the die + glow halo with brightness — and NEVER a PointLight', () => {
    const built = build()
    const die = dieOf(built.object)
    const glow = glowOf(built.object)
    const lights = () => {
      const out: THREE.PointLight[] = []
      built.object.traverse((o) => {
        if ((o as THREE.PointLight).isPointLight) out.push(o as THREE.PointLight)
      })
      return out
    }
    updateComponentVisual(built, comp('led'), entryOf('led'), telemetry({ ledBrightness: 0.8 }))
    expect(die.emissiveIntensity).toBeGreaterThan(1)
    expect(glow.visible).toBe(true)
    expect(glow.material.opacity).toBeGreaterThan(0.5)
    // a real light would invalidate the lights hash → scene-wide shader
    // recompile every time a blinking LED toggles; the halo must stay a sprite
    expect(lights()).toHaveLength(0)

    updateComponentVisual(built, comp('led'), entryOf('led'), telemetry({ ledBrightness: 0 }))
    expect(die.emissiveIntensity).toBe(0)
    expect(glow.visible).toBe(false)
    expect(lights()).toHaveLength(0)
    disposeComponentObject(built.object)
  })

  it('burnout = smoked epoxy, restorable', () => {
    const built = build()
    const glass = glassOf(built.object)
    const glow = glowOf(built.object)
    updateComponentVisual(built, comp('led'), entryOf('led'), telemetry({ burned: true }))
    expect(glass.color.getHex()).toBe(0x33322e) // smoked tint
    expect(glass.roughness).toBe(0.45) // smoked epoxy
    // collapses but stays > 0: no program flag flip → no shader recompile
    expect(glass.transmission).toBeGreaterThan(0)
    expect(glass.transmission).toBeLessThanOrEqual(0.1)
    expect(glow.visible).toBe(false) // a dead LED must not keep glowing

    updateComponentVisual(built, comp('led'), entryOf('led'), telemetry({ ledBrightness: 0.5 }))
    expect(glass.color.getHex()).not.toBe(0x33322e) // reset restores the tint
    expect(glass.roughness).toBe(0.32)
    expect(glass.transmission).toBeGreaterThanOrEqual(0.4) // translucency restored
    disposeComponentObject(built.object)
  })

  it('burned water-clear LED collapses its transmission (numeric-only mutation)', () => {
    const built = buildComponentObject(comp('led', { color: 'blue' }), entryOf('led'), pins)
    const clear = materialsOf(built.object).find(
      (m) => ((m as THREE.MeshPhysicalMaterial).transmission ?? 0) > 0,
    ) as THREE.MeshPhysicalMaterial
    expect(clear).toBeDefined()
    updateComponentVisual(built, comp('led', { color: 'blue' }), entryOf('led'), telemetry({ burned: true }))
    // stays > 0 (no program flag flip → no shader recompile) but goes smoked
    expect(clear.transmission).toBeGreaterThan(0)
    expect(clear.transmission).toBeLessThanOrEqual(0.15)
    expect(clear.roughness).toBe(0.45)
    updateComponentVisual(built, comp('led', { color: 'blue' }), entryOf('led'), telemetry({ ledBrightness: 0.5 }))
    expect(clear.transmission).toBe(1.0) // reset restores water-clear
    expect(clear.roughness).toBe(0.03)
    disposeComponentObject(built.object)
  })

  it('transmission stays LEDs-only (everything else re-renders the scene per frame)', () => {
    // NOTHING in the catalog but the LED is transmissive
    for (const type of Object.keys(CATALOG)) {
      if (type === 'led') continue // the one budgeted exception, asserted below
      const entry = CATALOG[type]
      const n = Math.max(1, entry.pins.length)
      const pins2 =
        entry.placement === 'dip' ? dipPins(n) : entry.pins.map((_, i) => v(i * 2, 0, 0))
      const built = buildComponentObject(comp(type), entry, pins2)
      const transmissive = materialsOf(built.object).filter(
        (m) => ((m as THREE.MeshPhysicalMaterial).transmission ?? 0) > 0,
      )
      expect(transmissive, `${type} must not use transmission`).toHaveLength(0)
      disposeComponentObject(built.object)
    }
    // the exception: every LED epoxy body (diffused AND water-clear), and
    // exactly ONE transmissive material per LED — never more
    for (const colorName of ['red', 'green', 'yellow', 'blue', 'white']) {
      const built = buildComponentObject(
        comp('led', { color: colorName }),
        entryOf('led'),
        pins,
      )
      const transmissive = materialsOf(built.object).filter(
        (m) => ((m as THREE.MeshPhysicalMaterial).transmission ?? 0) > 0,
      )
      expect(transmissive, colorName).toHaveLength(1)
      disposeComponentObject(built.object)
    }
  })
})

// ---------------------------------------------------------------------------
// Routed component poses (router-planned body placement + lead paths)
// ---------------------------------------------------------------------------

describe('routed component poses', () => {
  const twoHole = [v(0, 0, 0), v(1, 0, 0)]
  const verticalMount: RoutedComponent = {
    pose: 'vertical',
    bodyCenter: { x: 0, y: 1.05, z: 0 },
    bodyDir: { x: 0, y: 1, z: 0 },
    waypoints: [
      [
        { x: 0, y: 0, z: 0 },
        { x: 0, y: 0.6, z: 0 },
      ],
      [
        // hairpin top lead: up past the body, over the top, down into b-hole
        { x: 1, y: 0, z: 0 },
        { x: 1, y: 2.2, z: 0 },
        { x: 0, y: 2.4, z: 0 },
        { x: 0, y: 1.5, z: 0 },
      ],
    ],
  }

  it('vertical resistor: body stands on end at bodyCenter with a hairpin top lead', () => {
    const built = buildComponentObject(
      comp('resistor'),
      entryOf('resistor'),
      twoHole,
      verticalMount,
    )
    const frame = resistorBodyOf(built.object).parent!
    expect(frame.position.x).toBeCloseTo(0, 5)
    expect(frame.position.y).toBeCloseTo(1.05, 5)
    // the body axis (local +X) points straight up
    const axis = new THREE.Vector3(1, 0, 0).applyQuaternion(frame.quaternion)
    expect(axis.y).toBeCloseTo(1, 5)
    // the hairpin lead rises above the standing body and both legs reach
    // down into their holes
    const bb = new THREE.Box3().setFromObject(built.object)
    expect(bb.max.y).toBeGreaterThan(2.0)
    expect(bb.min.y).toBeLessThan(-0.1)
    // pin attachment points stay at the catalog holes
    built.pinWorld.forEach((p, i) => expect(p.distanceTo(twoHole[i])).toBeLessThan(1e-9))
    disposeComponentObject(built.object)
  })

  it('span pose levels the body at the routed height along bodyDir', () => {
    const pins = [v(0, 0, 0), v(4, 0, 0)]
    const span: RoutedComponent = {
      pose: 'span',
      bodyCenter: { x: 2, y: 1.4, z: 0 },
      bodyDir: { x: 1, y: 0, z: 0 },
      waypoints: [
        [
          { x: 0, y: 0, z: 0 },
          { x: 0, y: 1.4, z: 0 },
          { x: 1.15, y: 1.4, z: 0 },
        ],
        [
          { x: 4, y: 0, z: 0 },
          { x: 4, y: 1.4, z: 0 },
          { x: 2.85, y: 1.4, z: 0 },
        ],
      ],
    }
    const built = buildComponentObject(comp('resistor'), entryOf('resistor'), pins, span)
    const frame = resistorBodyOf(built.object).parent!
    expect(frame.position.y).toBeCloseTo(1.4, 5)
    expect(frame.position.x).toBeCloseTo(2, 5)
    disposeComponentObject(built.object)
  })

  it('malformed routed poses fall back to the pins-derived placement', () => {
    const bad: RoutedComponent = {
      pose: 'span',
      bodyCenter: { x: Number.NaN, y: 0, z: 0 },
      bodyDir: { x: 0, y: 0, z: 0 },
      waypoints: [],
    }
    const built = buildComponentObject(comp('resistor'), entryOf('resistor'), twoHole, bad)
    const frame = resistorBodyOf(built.object).parent!
    expect(frame.position.y).toBeCloseTo(0.55, 5) // default body height
    disposeComponentObject(built.object)
  })

  it('routed builds stay inside the triangle budget and dispose cleanly', () => {
    const built = buildComponentObject(
      comp('resistor'),
      entryOf('resistor'),
      twoHole,
      verticalMount,
    )
    expect(triangleCount(built.object)).toBeLessThanOrEqual(4000)
    disposeComponentObject(built.object)
  })
})

// ---------------------------------------------------------------------------
// Z-fighting / close-up quality regressions
// ---------------------------------------------------------------------------

describe('band z-fighting + close-up quality', () => {
  it('resistor bands ride strictly proud of the dog-bone surface (even two holes wide)', () => {
    for (const dist of [1, 2, 4]) {
      const pins = [v(0, 0, 0), v(dist, 0, 0)]
      const built = buildComponentObject(
        comp('resistor', { resistance: 220 }),
        entryOf('resistor'),
        pins,
      )
      const L = THREE.MathUtils.clamp(dist - 0.8, 0.9, 2.4)
      const bands = meshesOf(built.object).filter(
        (m) => (m.material as THREE.MeshPhysicalMaterial).roughness === 0.35,
      )
      // Phase D merge: flat bands fold into one vertex-colored mesh + the
      // metallic tolerance band — at most 2 meshes carry all 4 bands
      expect(bands.length, `dist ${dist}`).toBeLessThanOrEqual(2)
      const layout = resistorBandLayout(L)
      const slotsCovered = new Set<number>()
      for (const band of bands) {
        const pos = band.geometry.attributes.position
        for (let i = 0; i < pos.count; i++) {
          const x = pos.getX(i)
          const r = Math.hypot(pos.getY(i), pos.getZ(i))
          layout.xs.forEach((bx, slot) => {
            if (Math.abs(x - bx) <= layout.w) slotsCovered.add(slot)
          })
          const body = resistorRadiusAt(L, x)
          // every band vertex is either clearly proud of the body surface
          // (≥ +0.014) or buried inside it (≤ −0.03) — NEVER coplanar
          expect(
            r >= body + 0.014 || r <= body - 0.03,
            `band vertex coplanar with body (dist ${dist}, x ${x.toFixed(3)}, r ${r.toFixed(3)})`,
          ).toBe(true)
        }
      }
      // …and all 4 band slots are present in the merged geometry
      expect([...slotsCovered].sort().join(','), `dist ${dist}: all 4 bands`).toBe('0,1,2,3')
      disposeComponentObject(built.object)
    }
  })

  it('leg tubes are end-capped (no open tube mouths above the board)', () => {
    // unit: any leg end above the board gets a sphere cap; ends in the hole
    // (y ≤ 0) stay uncapped (buried in the plug)
    const leg = legMesh([v(0, -0.18, 0), v(0, 0.55, 0), v(1, 0.55, 0)])
    const caps = meshesOf(leg).filter((m) => m.geometry.type === 'SphereGeometry')
    expect(caps).toHaveLength(1) // body end only
    // and the built resistor folds tubes + caps into ONE metal mesh
    const built = buildComponentObject(comp('resistor'), entryOf('resistor'), [
      v(0, 0, 0),
      v(4, 0, 0),
    ])
    const metals = meshesOf(built.object).filter(
      (m) => ((m.material as THREE.MeshPhysicalMaterial).metalness ?? 0) === 1.0,
    )
    expect(metals).toHaveLength(1)
    disposeComponentObject(built.object)
  })

  it('electrolytic can bottom is closed (no see-through hole under the can)', () => {
    const built = buildComponentObject(
      comp('capacitor', { polarized: true }),
      entryOf('capacitor'),
      [v(0, 0, 0), v(2, 0, 0)],
    )
    const lathe = meshesOf(built.object).find((m) => m.geometry.type === 'LatheGeometry')
    expect(lathe).toBeDefined()
    const pos = lathe!.geometry.attributes.position
    let reachesAxisAtBottom = false
    for (let i = 0; i < pos.count; i++) {
      if (Math.hypot(pos.getX(i), pos.getZ(i)) < 1e-6 && pos.getY(i) < -0.6) {
        reachesAxisAtBottom = true
        break
      }
    }
    expect(reachesAxisAtBottom).toBe(true)
    disposeComponentObject(built.object)
  })
})

// ---------------------------------------------------------------------------
// DIP packages
// ---------------------------------------------------------------------------

describe('DIP package', () => {
  const pins = dipPins(8)
  const build = () => buildComponentObject(comp('ne555'), entryOf('ne555'), pins)

  it('body is chamfered molded epoxy (#1a1a1c, clearcoat 0.25)', () => {
    const built = build()
    const epoxy = materialsOf(built.object).find(
      (m) => (m as THREE.MeshPhysicalMaterial).clearcoat === 0.25,
    ) as THREE.MeshPhysicalMaterial
    expect(epoxy).toBeDefined()
    expect(epoxy.color.getHex()).toBe(0x1a1a1c)
    // chamfered: RoundedBoxGeometry (subclass of BoxGeometry) tessellates the
    // bevels — far more vertices than a razor-edged 24-vertex box
    const bodies = meshesOf(built.object).filter((m) => m.material === epoxy)
    expect(bodies.length).toBeGreaterThan(0)
    expect(bodies.some((m) => m.geometry.attributes.position.count > 24)).toBe(true)
    disposeComponentObject(built.object)
  })

  it('gull-wing leg unit keeps the stamped shape (bent extrusion + foot)', () => {
    const leg = gullWingLeg(v(0, 0, 1.5), 0, { enterY: 0.57, reach: 0.28, width: 0.34 })
    const wings = meshesOf(leg).filter((m) => m.geometry.type === 'ExtrudeGeometry')
    expect(wings).toHaveLength(1)
    // the wing spans outward (shoulder) AND downward (drop) — not a straight tube
    const bb = new THREE.Box3().setFromObject(wings[0])
    const size = bb.getSize(new THREE.Vector3())
    expect(size.y).toBeGreaterThan(0.3) // vertical drop
    expect(Math.max(size.x, size.z)).toBeGreaterThan(0.25) // horizontal shoulder
  })

  it('all 8 legs merge into ONE metal mesh (draw-call budget), reaching both rows', () => {
    const built = build()
    const metals = meshesOf(built.object).filter(
      (m) => ((m.material as THREE.MeshPhysicalMaterial).metalness ?? 0) === 1.0,
    )
    expect(metals).toHaveLength(1) // 8 wings + 8 feet in a single draw call
    const geo = metals[0].geometry
    expect(geo.attributes.position.count).toBeGreaterThanOrEqual(8 * 30) // every wing present
    const bb = new THREE.Box3().setFromObject(metals[0])
    expect(bb.getSize(new THREE.Vector3()).z).toBeGreaterThan(3.0) // spans rows at z ±1.5
    expect(bb.min.y).toBeLessThan(0.05) // feet drop into the holes
    disposeComponentObject(built.object)
  })

  it('rotation 180 (pin 1 at the right end) mirrors the notch + dimple cues', () => {
    // dipHoles puts a 180-rotated DIP's pin 1 at the package's RIGHT end —
    // the molded cues must follow it (notch + dimple share the recess/rim
    // materials; the end-notch cylinder pokes past the pin-1 end wall)
    const recessBB = (root: THREE.Object3D) => {
      const mesh = meshesOf(root).find(
        (m) => (m.material as THREE.MeshPhysicalMaterial).color?.getHex() === 0x0a0a0c,
      )
      expect(mesh).toBeDefined()
      return new THREE.Box3().setFromObject(mesh!)
    }
    // body ends for dipPins(8): x = 1.5 ± 2.25
    const norm = buildComponentObject(comp('ne555'), entryOf('ne555'), dipPins(8))
    expect(recessBB(norm.object).min.x).toBeLessThan(-0.8) // notch past the LEFT end
    expect(recessBB(norm.object).max.x).toBeLessThan(3.8)
    disposeComponentObject(norm.object)
    const flip = buildComponentObject(comp('ne555'), entryOf('ne555'), dipPins180(8))
    expect(recessBB(flip.object).max.x).toBeGreaterThan(3.8) // notch past the RIGHT end
    expect(recessBB(flip.object).min.x).toBeGreaterThan(-0.8)
    disposeComponentObject(flip.object)
  })

  it('keeps pinWorld at the catalog pin order positions', () => {
    const built = build()
    expect(built.pinWorld).toHaveLength(8)
    built.pinWorld.forEach((p, i) => expect(p.distanceTo(pins[i])).toBeLessThan(1e-9))
    disposeComponentObject(built.object)
  })
})

describe('seven segment', () => {
  it('a 180-rotated display renders its digit upside down (dp moves with it)', () => {
    const entry = entryOf('seven_segment')
    // the decimal point is the only CylinderGeometry left after the static
    // merge (pins/bezel merge into plain BufferGeometries)
    const dpWorld = (root: THREE.Object3D) => {
      const dp = meshesOf(root).find((m) => m.geometry.type === 'CylinderGeometry')
      expect(dp).toBeDefined()
      root.updateMatrixWorld(true)
      return dp!.getWorldPosition(new THREE.Vector3())
    }
    // dipPins(10): cx = 2, zc = 0; dp at (cx + 0.95, zc + 1.05) when upright
    const norm = buildComponentObject(comp('seven_segment'), entry, dipPins(10))
    const p0 = dpWorld(norm.object)
    expect(p0.x).toBeCloseTo(2.95, 3)
    expect(p0.z).toBeCloseTo(1.05, 3)
    disposeComponentObject(norm.object)
    const flip = buildComponentObject(comp('seven_segment'), entry, dipPins180(10))
    const p1 = dpWorld(flip.object)
    expect(p1.x).toBeCloseTo(2 - 0.95, 3) // digit rotated 180° about the package center
    expect(p1.z).toBeCloseTo(-1.05, 3)
    disposeComponentObject(flip.object)
  })

  it('segments light via telemetry', () => {
    const entry = entryOf('seven_segment')
    const built = buildComponentObject(comp('seven_segment'), entry, dipPins(10))
    const before = materialsOf(built.object)
      .map((m) => m as THREE.MeshStandardMaterial)
      .filter((m) => m.emissive && m.emissive.getHex() === 0x550000)
    expect(before.length).toBeGreaterThanOrEqual(8)
    updateComponentVisual(
      built,
      comp('seven_segment'),
      entry,
      telemetry({ segments: { a: true, b: true } }),
    )
    const lit = materialsOf(built.object)
      .map((m) => m as THREE.MeshStandardMaterial)
      .filter((m) => m.emissive && m.emissive.getHex() === 0xff3020)
    expect(lit).toHaveLength(2)
    disposeComponentObject(built.object)
  })
})

// ---------------------------------------------------------------------------
// Dispose safety: shared WeakSet discipline
// ---------------------------------------------------------------------------

describe('dispose safety', () => {
  it('disposes per-instance resources but never shared/cached ones', () => {
    const disposed: THREE.Material[] = []
    const orig = THREE.Material.prototype.dispose
    THREE.Material.prototype.dispose = function (this: THREE.Material) {
      disposed.push(this)
      orig.call(this)
    }
    try {
      const pins = [v(0, 0, 0), v(2, 0, 0)]
      const a = buildComponentObject(comp('led'), entryOf('led'), pins)
      const b = buildComponentObject(comp('led'), entryOf('led'), pins)
      const aPerInstance = materialsOf(a.object).filter((m) => !isSharedResource(m))
      expect(aPerInstance.length).toBeGreaterThan(0) // glass + die
      disposeComponentObject(a.object)
      // every disposed material is per-instance; shared ones untouched
      expect(disposed.length).toBeGreaterThan(0)
      for (const m of disposed) expect(isSharedResource(m)).toBe(false)
      // second instance unaffected
      for (const m of materialsOf(b.object)) expect(disposed.includes(m)).toBe(false)
      disposeComponentObject(b.object)
    } finally {
      THREE.Material.prototype.dispose = orig
    }
  })

  it('every catalog type builds and disposes without touching shared resources', () => {
    const disposed: object[] = []
    const origMat = THREE.Material.prototype.dispose
    const origGeo = THREE.BufferGeometry.prototype.dispose
    THREE.Material.prototype.dispose = function (this: THREE.Material) {
      disposed.push(this)
      origMat.call(this)
    }
    THREE.BufferGeometry.prototype.dispose = function (this: THREE.BufferGeometry) {
      disposed.push(this)
      origGeo.call(this)
    }
    try {
      for (const type of Object.keys(CATALOG)) {
        const entry = CATALOG[type]
        const n = Math.max(1, entry.pins.length)
        const pins =
          entry.placement === 'dip' ? dipPins(n) : entry.pins.map((_, i) => v(i * 2, 0, 0))
        const built = buildComponentObject(comp(type), entry, pins)
        expect(built.pinWorld, type).toHaveLength(pins.length)
        disposeComponentObject(built.object)
      }
      for (const r of disposed) expect(isSharedResource(r)).toBe(false)
    } finally {
      THREE.Material.prototype.dispose = origMat
      THREE.BufferGeometry.prototype.dispose = origGeo
    }
  })

  it('markShared resources are reported by isSharedResource', () => {
    const g = new THREE.BufferGeometry()
    expect(isSharedResource(g)).toBe(false)
    markShared(g)
    expect(isSharedResource(g)).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Triangle budget
// ---------------------------------------------------------------------------

describe('triangle budget', () => {
  it('every catalog component stays under ~4k triangles', () => {
    for (const type of Object.keys(CATALOG)) {
      const entry = CATALOG[type]
      const n = Math.max(1, entry.pins.length)
      const pins =
        entry.placement === 'dip' ? dipPins(n) : entry.pins.map((_, i) => v(i * 2, 0, 0))
      const built = buildComponentObject(comp(type), entry, pins)
      expect(triangleCount(built.object), `${type} triangle budget`).toBeLessThanOrEqual(4000)
      disposeComponentObject(built.object)
    }
  })

  it('heavy builders stay statically merged (draw-call budget)', () => {
    // node has no DOM, so canvas labels/screens are absent — these caps bound
    // the GEOMETRY meshes; the browser adds a handful of label planes only.
    // Pre-merge these were ~36 (DIP-14), ~26 (7-seg) and 33 (PSU) meshes.
    const cap = (type: string, max: number) => {
      const entry = CATALOG[type]
      const n = Math.max(1, entry.pins.length)
      const pins =
        entry.placement === 'dip' ? dipPins(n) : entry.pins.map((_, i) => v(i * 2, 0, 0))
      const built = buildComponentObject(comp(type), entry, pins)
      expect(meshesOf(built.object).length, `${type} mesh count`).toBeLessThanOrEqual(max)
      disposeComponentObject(built.object)
    }
    cap('sn74193', 8) // 16-pin DIP: body + 4 merged detail/leg meshes (+label)
    cap('seven_segment', 15) // body + merged shell/pins + 8 wafers + glass
    cap('power_supply', 20) // shell/plate + merged trim/posts + knob bits
    // Phase D merge pass (draw-call budget; node-measured census values +1)
    cap('resistor', 5) // body+collars / flat bands / gold band / legs
    cap('diode', 6) // glass / band / die / merged slugs+whisker / legs
    cap('pushbutton', 5) // merged base+stakes / plate / legs + movable cap
    cap('slide_switch', 8) // base / shell+ears / cavity / plate / pins + knob×2
    cap('dip_switch_8', 12) // body + wells + legs + 8 movable levers (was 49)
    cap('scope_probe', 4) // boot / channel ring / hook
    cap('buzzer', 4) // body / sound hole / merged leads
    cap('photoresistor', 6) // coat shell / substrate / track / window / legs
  })
})

// ---------------------------------------------------------------------------
// GLTF overrides
// ---------------------------------------------------------------------------

describe('gltf overrides', () => {
  const pins = [v(0, 0, 0), v(4, 0, 0)]

  it('ships empty: nothing registered, procedural build is synchronous', () => {
    expect(hasModelOverride('resistor')).toBe(false)
    const built = buildComponentObject(comp('resistor'), entryOf('resistor'), pins)
    expect(meshesOf(built.object).length).toBeGreaterThan(0) // procedural, immediately
    disposeComponentObject(built.object)
  })

  it('loadModelOverride resolves null when unregistered (no fetch attempted)', async () => {
    await expect(loadModelOverride('resistor')).resolves.toBeNull()
  })

  it('registered override defers to the model and falls back to procedural on load failure', async () => {
    registerModelOverride('resistor', '/models/does-not-exist.glb')
    expect(hasModelOverride('resistor')).toBe(true)
    const built = buildComponentObject(comp('resistor'), entryOf('resistor'), pins)
    // async path: starts empty (model pending), pin positions intact
    expect(built.pinWorld).toHaveLength(2)
    expect(meshesOf(built.object)).toHaveLength(0)
    // the bogus URL cannot load in node → fallback kicks in
    await loadModelOverride('resistor')
    await new Promise((r) => setTimeout(r, 0))
    expect(meshesOf(built.object).length).toBeGreaterThan(0)
    disposeComponentObject(built.object)
  })

  it('tryModelOverride returns null for unregistered types', () => {
    const result = tryModelOverride(comp('resistor'), entryOf('resistor'), pins, () => {
      throw new Error('must not build')
    })
    expect(result).toBeNull()
  })

  it('clearModelOverrides removes registrations', () => {
    registerModelOverride('led', '/models/led.glb')
    expect(hasModelOverride('led')).toBe(true)
    clearModelOverrides()
    expect(hasModelOverride('led')).toBe(false)
  })
})
