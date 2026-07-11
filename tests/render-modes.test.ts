/**
 * Render-mode engine tests (node-testable surface):
 * - capability/mode-selection logic + persisted-override fallback
 * - localStorage helper hardening
 * - budgets (studio render scale, enhanced shadow size)
 * - the REQUIRED lazy-chunk invariant: three-gpu-pathtracer is only
 *   referenced from studio.ts and only reached via dynamic import
 * - the bundled HDRI asset exists, is a real Radiance file, and stays small
 *
 * Visual behavior (composer stack, path-traced stills) is verified with the
 * screenshot harnesses once the scene integrator wires the manager up.
 */
import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as THREE from 'three'
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js'
import { bakeInstancedMeshGeometry } from '../src/three/render-modes/studio'

const HERE = dirname(fileURLToPath(import.meta.url))
import {
  RENDER_MODES,
  RENDER_MODE_IDS,
  RENDER_MODE_STORAGE_KEY,
  FULL_CAPS,
  defaultMode,
  enhancedShadowMapSize,
  isPhoneLike,
  readStoredMode,
  resolveMode,
  studioRenderScale,
  studioTargetSamples,
  studioTiles,
  supportedModes,
  supportsMode,
  writeStoredMode,
  type RenderCaps,
  type StorageLike,
} from '../src/three/render-modes/capability'

const caps = (over: Partial<RenderCaps> = {}): RenderCaps => ({ ...FULL_CAPS, ...over })
const PHONE = caps({ coarsePointer: true })
const NO_GL2 = caps({ webgl2: false })
const NO_FLOAT_LINEAR = caps({ floatLinear: false })
const NO_FLOAT_TARGETS = caps({ floatTargets: false })

describe('render mode metadata', () => {
  it('exposes exactly the three modes, in picker order', () => {
    expect(RENDER_MODE_IDS).toEqual(['performance', 'enhanced', 'studio'])
  })

  it('has non-empty label/description/badge for every mode', () => {
    for (const id of RENDER_MODE_IDS) {
      const meta = RENDER_MODES[id]
      expect(meta.id).toBe(id)
      expect(meta.label.length).toBeGreaterThan(0)
      expect(meta.description.length).toBeGreaterThan(10)
      expect(meta.badge.length).toBeGreaterThan(0)
    }
  })

  it('persists under the agreed key', () => {
    expect(RENDER_MODE_STORAGE_KEY).toBe('bb.renderMode')
  })
})

describe('capability gating', () => {
  it('performance runs anywhere', () => {
    expect(supportsMode('performance', NO_GL2)).toBe(true)
    expect(
      supportsMode('performance', caps({ webgl2: false, floatTargets: false, floatLinear: false })),
    ).toBe(true)
  })

  it('enhanced needs WebGL2 + float render targets', () => {
    expect(supportsMode('enhanced', FULL_CAPS)).toBe(true)
    expect(supportsMode('enhanced', NO_GL2)).toBe(false)
    expect(supportsMode('enhanced', NO_FLOAT_TARGETS)).toBe(false)
    expect(supportsMode('enhanced', NO_FLOAT_LINEAR)).toBe(true) // linear float is studio-only
  })

  it('studio additionally needs linear float sampling', () => {
    expect(supportsMode('studio', FULL_CAPS)).toBe(true)
    expect(supportsMode('studio', NO_FLOAT_LINEAR)).toBe(false)
    expect(supportsMode('studio', NO_GL2)).toBe(false)
  })

  it('supportedModes filters in picker order', () => {
    expect(supportedModes(FULL_CAPS)).toEqual(['performance', 'enhanced', 'studio'])
    expect(supportedModes(NO_FLOAT_LINEAR)).toEqual(['performance', 'enhanced'])
    expect(supportedModes(NO_GL2)).toEqual(['performance'])
  })
})

describe('device auto-select default', () => {
  it('phone (coarse pointer) defaults to performance', () => {
    expect(isPhoneLike(PHONE)).toBe(true)
    expect(defaultMode(PHONE)).toBe('performance')
  })

  it('desktop defaults to enhanced', () => {
    expect(defaultMode(FULL_CAPS)).toBe('enhanced')
  })

  it('desktop without the enhanced prerequisites falls back to performance', () => {
    expect(defaultMode(NO_GL2)).toBe('performance')
    expect(defaultMode(NO_FLOAT_TARGETS)).toBe('performance')
  })
})

describe('resolveMode (persisted override + fallback)', () => {
  it('honors a stored, supported override', () => {
    expect(resolveMode('studio', FULL_CAPS)).toBe('studio')
    expect(resolveMode('performance', FULL_CAPS)).toBe('performance')
  })

  it('an explicit user choice beats the phone default when supported', () => {
    expect(resolveMode('enhanced', PHONE)).toBe('enhanced')
    expect(resolveMode('studio', PHONE)).toBe('studio')
  })

  it('falls back to the device default when unsupported or unknown', () => {
    expect(resolveMode('studio', NO_FLOAT_LINEAR)).toBe('enhanced')
    expect(resolveMode('studio', NO_GL2)).toBe('performance')
    expect(resolveMode('ultra', FULL_CAPS)).toBe('enhanced')
    expect(resolveMode('', FULL_CAPS)).toBe('enhanced')
    expect(resolveMode(null, FULL_CAPS)).toBe('enhanced')
    expect(resolveMode(undefined, PHONE)).toBe('performance')
  })
})

describe('storage helpers', () => {
  const fakeStorage = (): StorageLike & { map: Map<string, string> } => {
    const map = new Map<string, string>()
    return {
      map,
      getItem: (k) => map.get(k) ?? null,
      setItem: (k, v) => void map.set(k, v),
    }
  }

  it('round-trips the mode under bb.renderMode', () => {
    const storage = fakeStorage()
    writeStoredMode(storage, 'studio')
    expect(storage.map.get('bb.renderMode')).toBe('studio')
    expect(readStoredMode(storage)).toBe('studio')
  })

  it('tolerates missing storage', () => {
    expect(readStoredMode(null)).toBe(null)
    expect(readStoredMode(undefined)).toBe(null)
    expect(() => writeStoredMode(null, 'enhanced')).not.toThrow()
  })

  it('swallows storage exceptions (private mode / quota)', () => {
    const throwing: StorageLike = {
      getItem: () => {
        throw new Error('denied')
      },
      setItem: () => {
        throw new Error('quota')
      },
    }
    expect(readStoredMode(throwing)).toBe(null)
    expect(() => writeStoredMode(throwing, 'performance')).not.toThrow()
  })
})

describe('budgets', () => {
  it('studio renders full-res on desktop, 0.75x on phones', () => {
    expect(studioRenderScale(FULL_CAPS)).toBe(1)
    expect(studioRenderScale(PHONE)).toBe(0.75)
  })

  it('enhanced shadow map is 4096 desktop / 2048 phone', () => {
    expect(enhancedShadowMapSize(FULL_CAPS)).toBe(4096)
    expect(enhancedShadowMapSize(PHONE)).toBe(2048)
  })

  it('phones tile more and converge to a lower target', () => {
    expect(studioTiles(PHONE)).toBeGreaterThan(studioTiles(FULL_CAPS))
    expect(studioTargetSamples(PHONE)).toBeLessThan(studioTargetSamples(FULL_CAPS))
    expect(studioTargetSamples(PHONE)).toBeGreaterThan(0)
  })
})

describe('lazy-chunk invariants (REQUIRED: pathtracer never ships to Performance users)', () => {
  const dir = join(HERE, '..', 'src', 'three', 'render-modes')
  const sources = readdirSync(dir).filter((f) => f.endsWith('.ts') && !f.endsWith('.d.ts'))
  const read = (f: string) => readFileSync(join(dir, f), 'utf8')

  it('only studio.ts imports three-gpu-pathtracer', () => {
    expect(sources.length).toBeGreaterThanOrEqual(5)
    const importsPathtracer = /from\s+['"]three-gpu-pathtracer['"]|import\(\s*['"]three-gpu-pathtracer['"]\s*\)|require\(\s*['"]three-gpu-pathtracer['"]\s*\)/
    for (const f of sources) {
      const imports = importsPathtracer.test(read(f))
      if (f === 'studio.ts') expect(imports).toBe(true)
      else expect(imports, `${f} must not import three-gpu-pathtracer`).toBe(false)
    }
  })

  it('manager reaches studio + enhanced only via dynamic import()', () => {
    const manager = read('manager.ts')
    expect(manager).toMatch(/import\(\s*'\.\/studio'\s*\)/)
    expect(manager).toMatch(/import\(\s*'\.\/enhanced'\s*\)/)
    // Static VALUE imports of the pipelines would defeat the lazy chunks;
    // `import type` is fine (erased at compile time). Every line that
    // imports from the pipeline modules must therefore be a type import.
    const importLines = manager
      .split('\n')
      .filter((line) => /from\s+'\.\/(studio|enhanced)'/.test(line))
    expect(importLines.length).toBeGreaterThan(0)
    for (const line of importLines) {
      expect(line, `static value import would defeat the lazy chunk: "${line.trim()}"`).toMatch(
        /^import type /,
      )
    }
  })

  it('capability.ts stays pure (no three.js import)', () => {
    expect(read('capability.ts')).not.toMatch(/from\s+'three/)
  })
})

describe('manager contract (node-safe surface)', () => {
  it('render() pre-init returns false and never claims a path-traced frame', async () => {
    const { RenderModeManager } = await import('../src/three/render-modes/manager')
    const m = new RenderModeManager()
    expect(m.render(0.016)).toBe(false) // caller plain-renders — universal fallback
    expect(m.pathTracedFrame).toBe(false)
    expect(m.mode).toBe('performance')
    expect(m.supported).toEqual(['performance'])
    // interaction depth + invalidate are safe before init and after dispose
    m.onInteractionStart()
    m.onInteractionEnd()
    expect(() => m.invalidate()).not.toThrow()
    expect(() => m.invalidate('materials')).not.toThrow()
    expect(() => m.dispose()).not.toThrow()
    expect(m.pathTracedFrame).toBe(false)
  })
})

describe('scene integration (render-pipeline wiring invariants)', () => {
  const sceneSrc = readFileSync(join(HERE, '..', 'src', 'three', 'scene.ts'), 'utf8')

  it('the rAF loop delegates to the manager, plain render as the fallback', () => {
    // `if (!modes.render(dt)) renderer.render(scene, camera)` — Performance
    // stays byte-equivalent to the pre-render-modes loop
    expect(sceneSrc).toMatch(/if \(!this\.modes\.render\(dt\)\)/)
    expect(sceneSrc).toMatch(/m\.renderer\.render\(m\.scene, m\.camera\)/)
  })

  it('raster overlays composite on top of PATH-TRACED frames only', () => {
    expect(sceneSrc).toMatch(/this\.modes\.pathTracedFrame/)
    expect(sceneSrc).toMatch(/renderStudioOverlays/)
  })

  it('excludes the overlay subtree and grow paddles from the still', () => {
    expect((sceneSrc.match(/userData\.bbNoStudio = true/g) ?? []).length).toBeGreaterThanOrEqual(2)
  })

  it('invalidates on layout sync (geometry) and telemetry/selection (materials)', () => {
    expect(sceneSrc).toMatch(/this\.modes\.invalidate\(\)/)
    expect(sceneSrc).toMatch(/this\.modes\.invalidate\('materials'\)/)
    expect(sceneSrc).toMatch(/materialsRefreshPending/) // throttled refresh path
  })

  it('wires interaction events from OrbitControls AND pointer activity', () => {
    expect(sceneSrc).toMatch(/addEventListener\('start', onControlsStart\)/)
    expect(sceneSrc).toMatch(/addEventListener\('end', onControlsEnd\)/)
    expect(sceneSrc).toMatch(/onInteractionStart\(\)/)
    expect(sceneSrc).toMatch(/onInteractionEnd\(\)/)
    expect(sceneSrc).toMatch(/beginPointerInteraction/)
    expect(sceneSrc).toMatch(/endPointerInteraction/)
  })

  it('studio re-presents a converged still every frame (overlay compositing)', () => {
    const studio = readFileSync(
      join(HERE, '..', 'src', 'three', 'render-modes', 'studio.ts'),
      'utf8',
    )
    expect(studio).toMatch(/pausePathTracing = true/)
  })

  it('suppresses clearcoat on flagged materials (0.0.23 grazing-angle bug)', () => {
    // the board slab flags itself; studio.ts honors the flag and restores the
    // saved value on dispose — see the clearcoat caveat in RENDER-MODES.md
    const board = readFileSync(join(HERE, '..', 'src', 'three', 'internal', 'board.ts'), 'utf8')
    const studio = readFileSync(
      join(HERE, '..', 'src', 'three', 'render-modes', 'studio.ts'),
      'utf8',
    )
    expect(board).toMatch(/bbStudioNoClearcoat = true/)
    expect(studio).toMatch(/bbStudioNoClearcoat/)
    expect(studio).toMatch(/restoreMaterialOverrides/)
  })
})

describe('studio photographic still (source invariants)', () => {
  const studio = readFileSync(join(HERE, '..', 'src', 'three', 'render-modes', 'studio.ts'), 'utf8')

  it('path-traces through a PhysicalCamera mirror with focus + aperture engaged', () => {
    expect(studio).toMatch(/PhysicalCamera/)
    expect(studio).toMatch(/focusDistance/)
    expect(studio).toMatch(/bokehSize/)
    // the pinhole raster camera must never be handed to the path tracer
    expect(studio).not.toMatch(/setScene(?:Async)?\(scene,\s*camera\)/)
  })

  it('adds final-blit grain via the renderToCanvas hook', () => {
    expect(studio).toMatch(/renderToCanvasCallback/)
    expect(studio).toMatch(/GRAIN_AMOUNT/)
  })

  it('folds the clearcoat into the base lobe instead of plain-zeroing it', () => {
    // the 0.0.23 grazing-angle bug still forces clearcoat = 0, but the coat's
    // gloss/reflectance must be re-expressed through the base specular lobe
    expect(studio).toMatch(/specularIntensity/)
    expect(studio).toMatch(/clearcoatRoughness/)
    expect(studio).toMatch(/roughness\s*=\s*THREE\.MathUtils\.lerp/)
  })
})

describe('studio instanced-mesh bake (preallocated-buffer expansion)', () => {
  /** The OLD bake (per-instance clone + mergeGeometries) — the parity oracle. */
  const referenceBake = (im: THREE.InstancedMesh): THREE.BufferGeometry | null => {
    const local = new THREE.Matrix4()
    const world = new THREE.Matrix4()
    const geos: THREE.BufferGeometry[] = []
    for (let i = 0; i < im.count; i++) {
      im.getMatrixAt(i, local)
      world.multiplyMatrices(im.matrixWorld, local)
      const g = im.geometry.clone()
      g.applyMatrix4(world)
      geos.push(g)
    }
    return mergeGeometries(geos, false)
  }

  /** Varied per-instance TRS + a non-identity mesh world transform. */
  const makeInstanced = (geometry: THREE.BufferGeometry, count: number): THREE.InstancedMesh => {
    const im = new THREE.InstancedMesh(geometry, new THREE.MeshStandardMaterial(), count)
    const m = new THREE.Matrix4()
    const q = new THREE.Quaternion()
    const p = new THREE.Vector3()
    const s = new THREE.Vector3()
    const e = new THREE.Euler()
    for (let i = 0; i < count; i++) {
      q.setFromEuler(e.set(i * 0.7, i * 1.3, i * 0.4))
      p.set(i * 1.5 - 3, (i % 3) * 0.4, -i)
      s.set(1, 0.5 + 0.25 * i, 1) // non-uniform — exercises the normal matrix
      im.setMatrixAt(i, m.compose(p, q, s))
    }
    im.position.set(2, 1, -4)
    im.rotation.y = 0.6
    im.updateMatrixWorld(true)
    return im
  }

  const expectClose = (actual: ArrayLike<number>, expected: ArrayLike<number>, eps: number) => {
    expect(actual.length).toBe(expected.length)
    let max = 0
    for (let i = 0; i < actual.length; i++) {
      max = Math.max(max, Math.abs(actual[i] - expected[i]))
    }
    expect(max).toBeLessThanOrEqual(eps)
  }

  const expectParity = (im: THREE.InstancedMesh) => {
    const baked = bakeInstancedMeshGeometry(im)
    const ref = referenceBake(im)
    expect(baked).not.toBeNull()
    expect(ref).not.toBeNull()
    if (!baked || !ref) return
    expectClose(baked.getAttribute('position').array, ref.getAttribute('position').array, 1e-4)
    expectClose(baked.getAttribute('normal').array, ref.getAttribute('normal').array, 1e-4)
    expectClose(baked.getAttribute('uv').array, ref.getAttribute('uv').array, 0)
    const bi = baked.getIndex()
    const ri = ref.getIndex()
    expect(bi === null).toBe(ri === null)
    if (bi && ri) expect(Array.from(bi.array)).toEqual(Array.from(ri.array))
  }

  it('matches the reference clone+merge bake exactly (indexed geometry)', () => {
    expectParity(makeInstanced(new THREE.CylinderGeometry(0.3, 0.35, 0.5, 7), 9))
  })

  it('matches the reference bake on non-indexed geometry', () => {
    const geo = new THREE.CylinderGeometry(0.2, 0.25, 0.3, 5).toNonIndexed()
    const im = makeInstanced(geo, 4)
    expectParity(im)
    expect(bakeInstancedMeshGeometry(im)?.getIndex()).toBeNull()
  })

  it('tiles one merged buffer: counts scale with the instance count', () => {
    const geo = new THREE.CylinderGeometry(0.3, 0.3, 0.4, 6)
    const im = makeInstanced(geo, 11)
    const baked = bakeInstancedMeshGeometry(im)
    expect(baked?.getAttribute('position').count).toBe(geo.getAttribute('position').count * 11)
    expect(baked?.getIndex()?.count).toBe((geo.getIndex()?.count ?? 0) * 11)
  })

  it('returns null without a position attribute (batch stays raster-only)', () => {
    const im = new THREE.InstancedMesh(new THREE.BufferGeometry(), new THREE.MeshBasicMaterial(), 2)
    expect(bakeInstancedMeshGeometry(im)).toBeNull()
  })
})

describe('bundled HDRI asset', () => {
  const hdr = join(HERE, '..', 'public', 'hdri', 'studio_small_03_1k.hdr')

  it('exists, is a Radiance HDR, and stays under 2.5MB', () => {
    const stat = statSync(hdr)
    expect(stat.size).toBeGreaterThan(100_000)
    expect(stat.size).toBeLessThan(2_500_000)
    const magic = readFileSync(hdr).subarray(0, 10).toString('latin1')
    expect(magic.startsWith('#?')).toBe(true) // '#?RADIANCE' family magic
  })
})
