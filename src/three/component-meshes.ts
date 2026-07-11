/**
 * Procedural 3D component visuals (meshes agent).
 *
 * Contract: build/refresh THREE.Object3D visuals for components.
 *
 * Coordinate conventions (see src/model/breadboard.ts):
 *  - 1 unit = one hole pitch (0.1"). Board top surface is y = 0.
 *  - `pinPositions` are world positions of each pin's hole top (y=0) in
 *    catalog pin order; off-board components get their terminal posts.
 *  - The returned object must be positioned in world space by the builder
 *    itself (use the pin positions); the scene adds it unmodified.
 *  - obj.userData.componentId is set by the scene after build.
 *
 * Implementation lives in src/three/meshes/*; this module dispatches on
 * `entry.visual.shape` and keeps per-instance update closures in a WeakMap so
 * the public BuiltComponent shape stays exactly as the contract requires.
 */

import * as THREE from 'three'
import type { ComponentInstance, ComponentTelemetry } from '../model/types'
import type { CatalogEntry } from '../model/catalog'
import type { RoutedComponent } from './internal/wire-router'
import {
  BuildResult,
  VisualUpdater,
  centroidOf,
  isSharedResource,
  plastic,
  topLabel,
} from './meshes/shared'
import {
  buildCapacitor,
  buildDiode,
  buildInductor,
  buildPhotoresistor,
  buildPotentiometer,
  buildResistor,
} from './meshes/passives'
import { buildLed, buildTo92 } from './meshes/semis'
import { buildButton, buildDipSwitch, buildSlideSwitch } from './meshes/switches'
import { buildDip, buildSevenSeg } from './meshes/ics'
import { buildBuzzer, buildInstrumentBox, buildProbe } from './meshes/instruments'
import { tryModelOverride } from './meshes/gltf-overrides'

export interface BuiltComponent {
  object: THREE.Object3D
  /** world position of each pin (for wire attachment), catalog pin order */
  pinWorld: THREE.Vector3[]
}

/** Per-instance refresh closures, keyed by the built root object. */
const updaters = new WeakMap<THREE.Object3D, VisualUpdater>()

export function buildComponentObject(
  comp: ComponentInstance,
  entry: CatalogEntry,
  pinPositions: THREE.Vector3[],
  /**
   * Optional router-planned pose for 2/3-lead leaded parts (see
   * internal/wire-router): body at bodyCenter along bodyDir, leads following
   * the planned waypoints into their exact holes. Malformed/absent poses fall
   * back to the pins-derived placement.
   */
  routed?: RoutedComponent,
): BuiltComponent {
  // authored .glb override first (no-op unless registered — see gltf-overrides)
  const result =
    tryModelOverride(comp, entry, pinPositions, () =>
      dispatch(comp, entry, pinPositions, routed),
    ) ?? dispatch(comp, entry, pinPositions, routed)
  if (result.update) updaters.set(result.object, result.update)
  return { object: result.object, pinWorld: result.pinWorld }
}

export function updateComponentVisual(
  built: BuiltComponent,
  comp: ComponentInstance,
  entry: CatalogEntry,
  telemetry: ComponentTelemetry | null,
): void {
  updaters.get(built.object)?.(comp, entry, telemetry)
}

const TEXTURE_SLOTS = [
  'map',
  'normalMap',
  'roughnessMap',
  'metalnessMap',
  'emissiveMap',
  'aoMap',
  'alphaMap',
  'bumpMap',
  'lightMap',
] as const

/**
 * Dispose the per-instance GPU resources of an object returned by
 * `buildComponentObject`. Geometries/materials/textures cached module-wide by
 * the meshes module are shared across ALL component instances and are skipped
 * (they live for the page lifetime — see meshes/shared.ts).
 */
export function disposeComponentObject(root: THREE.Object3D): void {
  const geos = new Set<THREE.BufferGeometry>()
  const mats = new Set<THREE.Material>()
  root.traverse((o) => {
    const any = o as unknown as {
      geometry?: THREE.BufferGeometry
      material?: THREE.Material | THREE.Material[]
    }
    const geo = any.geometry
    if (geo && typeof geo.dispose === 'function' && !isSharedResource(geo)) geos.add(geo)
    const mat = any.material
    if (Array.isArray(mat)) {
      for (const m of mat) {
        if (m && m.isMaterial && !isSharedResource(m)) mats.add(m)
      }
    } else if (mat && mat.isMaterial && !isSharedResource(mat)) {
      mats.add(mat)
    }
  })
  for (const geo of geos) geo.dispose()
  for (const mat of mats) {
    const anyMat = mat as unknown as Record<string, unknown>
    for (const slot of TEXTURE_SLOTS) {
      const tex = anyMat[slot] as THREE.Texture | null | undefined
      if (tex && tex.isTexture && !isSharedResource(tex)) tex.dispose()
    }
    mat.dispose()
  }
}

// ---------------------------------------------------------------------------

function dispatch(
  comp: ComponentInstance,
  entry: CatalogEntry,
  pins: THREE.Vector3[],
  routed?: RoutedComponent,
): BuildResult {
  const shape = entry.visual?.shape
  try {
    switch (shape) {
      case 'resistor':
        if (pins.length >= 2) return buildResistor(comp, entry, pins, routed)
        break
      case 'capacitor':
        if (pins.length >= 2) return buildCapacitor(comp, entry, pins, routed)
        break
      case 'inductor':
        if (pins.length >= 2) return buildInductor(comp, entry, pins, routed)
        break
      case 'pot':
      case 'potentiometer':
        if (pins.length >= 3) return buildPotentiometer(comp, entry, pins)
        break
      case 'ldr':
      case 'photoresistor':
        if (pins.length >= 2) return buildPhotoresistor(comp, entry, pins, routed)
        break
      case 'diode':
        if (pins.length >= 2) return buildDiode(comp, entry, pins, routed)
        break
      case 'led':
        if (pins.length >= 2) return buildLed(comp, entry, pins, routed)
        break
      case 'to92':
        if (pins.length >= 2) return buildTo92(comp, entry, pins, routed)
        break
      case 'button':
        if (pins.length >= 1) return buildButton(comp, entry, pins)
        break
      case 'slide':
        if (pins.length >= 2) return buildSlideSwitch(comp, entry, pins)
        break
      case 'dipswitch':
        if (pins.length >= 2) return buildDipSwitch(comp, entry, pins)
        break
      case 'dip':
        if (pins.length >= 2) return buildDip(comp, entry, pins)
        break
      case 'sevenseg':
        if (pins.length >= 2) return buildSevenSeg(comp, entry, pins)
        break
      case 'buzzer':
        if (pins.length >= 1) return buildBuzzer(comp, entry, pins)
        break
      case 'psu':
        if (pins.length >= 1) return buildInstrumentBox(comp, entry, pins, 'psu')
        break
      case 'fungen':
        if (pins.length >= 1) return buildInstrumentBox(comp, entry, pins, 'fungen')
        break
      case 'probe':
        if (pins.length >= 1) return buildProbe(comp, entry, pins)
        break
    }
  } catch {
    // never let a bad layout crash the scene — fall back to the labeled box
  }
  return buildFallback(comp, entry, pins)
}

/** Default: a labeled box over the centroid (placeholder behavior + label). */
function buildFallback(
  _comp: ComponentInstance,
  entry: CatalogEntry,
  pins: THREE.Vector3[],
): BuildResult {
  const center = centroidOf(pins)
  const w = Math.max(1.5, pins.length)
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, 1.2, 1.2), plastic(0x6688aa, 0.6))
  mesh.position.set(center.x, 0.9, center.z)
  const group = new THREE.Group()
  group.add(mesh)
  const lblW = Math.min(w - 0.2, 3.2)
  const lbl = topLabel(entry.label.split(/\s+/)[0] ?? entry.type, lblW, lblW / 3.2, {
    w: 256,
    h: 80,
    fg: '#e6e6e6',
  })
  if (lbl) {
    lbl.position.set(center.x, 1.52, center.z)
    group.add(lbl)
  }
  return { object: group, pinWorld: pins.map((p) => p.clone()) }
}
