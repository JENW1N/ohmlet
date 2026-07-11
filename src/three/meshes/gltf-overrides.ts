/**
 * Optional authored-model overrides (meshes agent).
 *
 * Lets a hand-authored .glb replace the procedural visual for any catalog
 * type, with zero cost (and zero network requests) when nothing is
 * registered — the GLTFLoader module itself is only dynamically imported on
 * first use.
 *
 * HOW TO USE
 *  1. Drop a glTF binary into `public/models/`, e.g. `public/models/ne555.glb`.
 *     Author it in plan units (1 unit = 0.1" hole pitch), origin at the
 *     centroid of the component's pins, sitting on y = 0 (the board surface),
 *     local +X along the pin row (pin 1 → last pin).
 *  2. Register it once at startup (e.g. in main.tsx or scene setup):
 *
 *        import { registerModelOverride } from './three/meshes/gltf-overrides'
 *        registerModelOverride('ne555', '/models/ne555.glb')
 *
 *  3. `buildComponentObject` consults the registry before procedural
 *     dispatch: the component appears as soon as the model loads (cached —
 *     one fetch per URL, clones afterwards). If the load fails, the
 *     procedural mesh is built as a fallback.
 *
 * Dispose safety: the loaded scene's geometries/materials/textures are marked
 * shared (markShared) because every clone references the same GPU resources;
 * disposeComponentObject skips them by design.
 */

import * as THREE from 'three'
import type { ComponentInstance, ComponentTelemetry } from '../../model/types'
import type { CatalogEntry } from '../../model/catalog'
import {
  BuildResult,
  VisualUpdater,
  centroidOf,
  frameBetween,
  markShared,
} from './shared'

/** type → model URL */
const registry = new Map<string, string>()

/** type → cached load (resolves null on failure; never rejects) */
const loads = new Map<string, Promise<THREE.Group | null>>()

/** Register (or replace) an authored model for a catalog type. */
export function registerModelOverride(type: string, url: string): void {
  if (registry.get(type) !== url) loads.delete(type)
  registry.set(type, url)
}

export function hasModelOverride(type: string): boolean {
  return registry.has(type)
}

/** Remove all registrations (tests / hot-reload hygiene). */
export function clearModelOverrides(): void {
  registry.clear()
  loads.clear()
}

/**
 * Load (once) the registered model for `type`. Resolves null when nothing is
 * registered or the load fails. The resolved group is the cached original —
 * always `.clone(true)` it before adding to a scene.
 */
export function loadModelOverride(type: string): Promise<THREE.Group | null> {
  const url = registry.get(type)
  if (!url) return Promise.resolve(null)
  let p = loads.get(type)
  if (!p) {
    p = loadGltfScene(url).catch(() => null)
    loads.set(type, p)
  }
  return p
}

async function loadGltfScene(url: string): Promise<THREE.Group> {
  // dynamic import: the loader (and anything it pulls in) stays out of the
  // bundle's critical path and is never evaluated unless an override exists
  const { GLTFLoader } = await import('three/examples/jsm/loaders/GLTFLoader.js')
  const gltf = await new GLTFLoader().loadAsync(url)
  const scene = gltf.scene
  scene.traverse((o) => {
    const any = o as unknown as {
      geometry?: THREE.BufferGeometry
      material?: THREE.Material | THREE.Material[]
    }
    if (any.geometry) markShared(any.geometry)
    const mats = Array.isArray(any.material) ? any.material : any.material ? [any.material] : []
    for (const m of mats) {
      markShared(m)
      for (const value of Object.values(m as unknown as Record<string, unknown>)) {
        if (value && (value as THREE.Texture).isTexture) markShared(value as object)
      }
    }
  })
  return scene
}

/**
 * Consulted by buildComponentObject BEFORE procedural dispatch. Returns null
 * when no override is registered (the normal path — completely free).
 * Otherwise returns a root group that fills in asynchronously: the model
 * clone on success, the procedural build on failure.
 */
export function tryModelOverride(
  _comp: ComponentInstance,
  entry: CatalogEntry,
  pins: THREE.Vector3[],
  buildProcedural: () => BuildResult,
): BuildResult | null {
  if (!registry.has(entry.type)) return null
  const root = new THREE.Group()
  let inner: VisualUpdater | null = null

  const c = centroidOf(pins)
  const first = pins[0] ?? new THREE.Vector3()
  const last = pins[pins.length - 1] ?? first
  const angleY = pins.length >= 2 ? frameBetween(first, last).angleY : 0

  void loadModelOverride(entry.type).then((scene) => {
    if (scene) {
      const inst = scene.clone(true)
      inst.position.set(c.x, 0, c.z)
      inst.rotation.y = angleY
      root.add(inst)
    } else {
      try {
        const res = buildProcedural()
        root.add(res.object)
        inner = res.update ?? null
      } catch {
        // leave the group empty rather than crash the scene
      }
    }
  })

  return {
    object: root,
    pinWorld: pins.map((p) => p.clone()),
    update: (c2: ComponentInstance, e2: CatalogEntry, t: ComponentTelemetry | null) => {
      inner?.(c2, e2, t)
    },
  }
}
