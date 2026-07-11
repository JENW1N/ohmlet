/**
 * STUDIO mode — progressive GPU path tracing of the live scene graph via
 * three-gpu-pathtracer (0.0.23, the newest release compatible with
 * three@0.170 — 0.0.24 requires r180+).
 *
 * THIS IS THE ONLY MODULE THAT IMPORTS 'three-gpu-pathtracer'. The manager
 * loads it with a dynamic `import('./studio')`, so the path tracer lives in
 * its own lazy chunk and Performance/Enhanced users never download it.
 *
 * Behavior:
 * - BVH (re)builds only when the manager calls invalidate() — lazily, on the
 *   next idle frame. Builds run on a Web Worker when one can be spun up
 *   (probed once at creation); otherwise synchronously on the main thread.
 * - While the camera moves (or a build is in flight) render() returns false
 *   and the manager draws the Enhanced raster instead. When still, sampling
 *   resumes from zero and the path-traced image fades in over the raster
 *   (the path tracer's own warmup gate rasterizes via the Enhanced composer).
 * - Convergence progress is reported through onProgress (samples/pixel); at
 *   the target the loop stops drawing and the converged still is held.
 *
 * Camera realism: the still is traced through a PhysicalCamera MIRROR of the
 * live raster camera — focus is placed where the view ray meets the
 * component-height plane (orbit framings always aim at the board) with an
 * f/2.8-equivalent aperture, so macro stills get the millimetre-scale depth
 * of field of a real product photo; a fine luminance grain is composited in
 * the final blit (seeded by the sample counter — it freezes with the held
 * still). The raster modes stay pinhole-sharp and grain-free.
 *
 * Scene-graph caveats (full notes in RENDER-MODES.md):
 * - InstancedMesh is NOT expanded by three-gpu-pathtracer 0.0.23 — we bake
 *   visible instanced meshes (board hole collars/plugs) into temporary merged
 *   geometry for the build, within a triangle budget. The bake writes the
 *   transformed copies straight into ONE preallocated buffer per batch
 *   (bakeInstancedMeshGeometry) — the old clone-per-instance + mergeGeometries
 *   bake cost 80–260 ms of main-thread time per BVH rebuild on multi-board
 *   rigs. instanceColor ignored.
 * - ShaderMaterial / ShadowMaterial meshes (holograms, hover FX, the desk
 *   shadow catcher) and anything flagged `userData.bbNoStudio` are hidden
 *   from the path-traced still.
 * - Clearcoat: 0.0.23's clearcoat lobe renders BLACK at grazing view angles,
 *   so the coat cannot be traced directly. Instead of zeroing it (which left
 *   resistor lacquer / wire PVC / molded epoxy reading satin), every
 *   clearcoated material gets the coat FOLDED into its base lobe while
 *   Studio is active — roughness pulled toward the glossier coat roughness,
 *   specularIntensity gaining the coat's added reflectance — and restored on
 *   dispose. The legacy `bbStudioNoClearcoat` board flag is subsumed by this
 *   global handling.
 */
import * as THREE from 'three'
import { WebGLPathTracer, PhysicalCamera } from 'three-gpu-pathtracer'
import { FullScreenQuad } from 'three/examples/jsm/postprocessing/Pass.js'
import {
  STUDIO_PIXEL_BUDGET,
  studioRenderScale,
  studioRestartTiles,
  studioTargetSamples,
  studioTiles,
} from './capability'
import type { RenderContext, StudioProgress } from './types'
import type { EnhancedPipeline } from './enhanced'

/** Worker shape required by WebGLPathTracer.setBVHWorker. */
interface BVHWorkerLike {
  generate(geometry: THREE.BufferGeometry, options?: object): Promise<unknown>
  dispose(): void
}

/** Cap for baking InstancedMesh copies into the path-traced still. */
const MAX_EXPANDED_TRIANGLES = 1_500_000
const WORKER_PROBE_TIMEOUT_MS = 8000
const FADE_DURATION_MS = 350
/** After this many consecutive failed builds, Studio yields to Enhanced. */
const MAX_BUILD_FAILURES = 2

/**
 * Clearcoat fold (see the module docblock): how the suppressed coat is
 * re-expressed through the base specular lobe for the still.
 * - GLOSS: the folded highlight tightness, as a fraction of the coat's own
 *   roughness (the dip-coat window highlight is the coat lobe's, not the
 *   base's — pull the base toward it).
 * - RATE: how quickly the coat lobe dominates the fold as clearcoat rises.
 * - SPECULAR_CAP: ceiling for the folded specularIntensity (a lacquered
 *   dielectric reflects roughly the base F0 plus the coat's F0 again).
 */
const COAT_FOLD_GLOSS = 0.8
const COAT_FOLD_RATE = 1.5
const COAT_SPECULAR_CAP = 2

/**
 * Photographic lens model for the still (path-traced frames only):
 * - DOF_APERTURE_FRACTION: aperture DIAMETER as a fraction of the focus
 *   distance. Scaling with subject distance keeps the image-space blur (the
 *   "f/2.8 look": subject crisp, a board-width behind clearly soft)
 *   consistent between macro and full-board framings.
 * - DOF_FOCUS_PLANE_Y: orbit framings aim at parts seated just above the
 *   board face (y = 0); the view ray's hit on this plane ≈ subject distance.
 * - GRAIN_AMOUNT: peak luminance offset of the final-blit grain (subtle —
 *   fine sensor grain, not film stock).
 */
const DOF_APERTURE_FRACTION = 0.025
const DOF_FOCUS_PLANE_Y = 0.55
const DOF_MIN_FOCUS = 2
const DOF_MAX_FOCUS = 120
const GRAIN_AMOUNT = 0.04

function isExcludedMesh(o: THREE.Object3D): boolean {
  if (o.userData.bbNoStudio === true) return true
  const mesh = o as THREE.Mesh
  if (!mesh.isMesh) return false
  // instanced meshes are baked separately (see buildInstanceExpansion)
  if ((o as THREE.InstancedMesh).isInstancedMesh) return true
  const mat = mesh.material
  const mats = Array.isArray(mat) ? mat : [mat]
  return mats.some(
    (m) =>
      !!m &&
      ((m as THREE.ShaderMaterial).isShaderMaterial === true ||
        (m as THREE.ShadowMaterial).isShadowMaterial === true),
  )
}

function triangleCount(geo: THREE.BufferGeometry): number {
  const index = geo.getIndex()
  if (index) return index.count / 3
  const pos = geo.getAttribute('position')
  return pos ? pos.count / 3 : 0
}

/** Resolve to a plain BufferAttribute (deinterleaves the BASE template once). */
function plainAttribute(
  attr: THREE.BufferAttribute | THREE.InterleavedBufferAttribute | undefined,
): THREE.BufferAttribute | null {
  if (!attr) return null
  if ((attr as THREE.InterleavedBufferAttribute).isInterleavedBufferAttribute === true) {
    // InterleavedBufferAttribute.clone() without args deinterleaves into a
    // plain BufferAttribute — done once per template, never per instance.
    return (attr as THREE.InterleavedBufferAttribute).clone() as unknown as THREE.BufferAttribute
  }
  return attr as THREE.BufferAttribute
}

/** Tile an untransformed channel (uv/color) once per instance. */
function tileAttribute(attr: THREE.BufferAttribute, instCount: number): THREE.BufferAttribute {
  const src = attr.array
  const Ctor = src.constructor as new (len: number) => typeof src
  const dst = new Ctor(src.length * instCount)
  for (let i = 0; i < instCount; i++) dst.set(src, i * src.length)
  return new THREE.BufferAttribute(dst, attr.itemSize, attr.normalized)
}

/**
 * Bake every instance of an InstancedMesh into ONE merged BufferGeometry by
 * writing the transformed copies straight into preallocated buffers.
 *
 * This replaces the old per-instance `geometry.clone()` + `mergeGeometries()`
 * bake, whose allocation churn cost ~80 ms (3-wide rig, 2,490 holes) to
 * ~260 ms (3×4 grid) of synchronous main-thread time on EVERY Studio BVH
 * rebuild; direct writes do the same work in a few milliseconds.
 *
 * Only the channels the path tracer consumes are baked: position (world
 * transform), normal (normal matrix, renormalized), tangent (rotated,
 * handedness preserved), uv and color (tiled). Exotic layouts (non-float
 * transform channels) return null and stay raster-only — the board's hole
 * collar/shaft/plug instancing is plain float geometry.
 *
 * Exported for the vitest parity test (pure geometry — no renderer needed).
 */
export function bakeInstancedMeshGeometry(im: THREE.InstancedMesh): THREE.BufferGeometry | null {
  const src = im.geometry
  const position = plainAttribute(src.getAttribute('position'))
  if (!position || position.itemSize !== 3 || !(position.array instanceof Float32Array)) {
    return null
  }
  const normal = plainAttribute(src.getAttribute('normal'))
  const tangent = plainAttribute(src.getAttribute('tangent'))
  if (normal && !(normal.array instanceof Float32Array)) return null
  if (tangent && !(tangent.array instanceof Float32Array)) return null

  const instCount = im.count
  const vertCount = position.count
  const merged = new THREE.BufferGeometry()

  // index — tiled with a per-instance vertex offset (non-indexed stays so)
  const srcIndex = src.getIndex()
  if (srcIndex) {
    const idx = srcIndex.array
    const dst =
      vertCount * instCount > 65535
        ? new Uint32Array(srcIndex.count * instCount)
        : new Uint16Array(srcIndex.count * instCount)
    for (let i = 0; i < instCount; i++) {
      const vOff = i * vertCount
      const iOff = i * srcIndex.count
      for (let j = 0; j < srcIndex.count; j++) dst[iOff + j] = idx[j] + vOff
    }
    merged.setIndex(new THREE.BufferAttribute(dst, 1))
  }

  // transformed channels — inline matrix math, no temporaries per vertex
  const posSrc = position.array as Float32Array
  const posDst = new Float32Array(vertCount * instCount * 3)
  const nrmSrc = normal ? (normal.array as Float32Array) : null
  const nrmDst = nrmSrc ? new Float32Array(vertCount * instCount * 3) : null
  const tanSrc = tangent ? (tangent.array as Float32Array) : null
  const tanDst = tanSrc && tangent ? new Float32Array(vertCount * instCount * tangent.itemSize) : null

  const world = new THREE.Matrix4()
  const nmat = new THREE.Matrix3()
  const stride3 = vertCount * 3
  for (let i = 0; i < instCount; i++) {
    im.getMatrixAt(i, world)
    world.premultiply(im.matrixWorld)
    const e = world.elements
    let o = i * stride3
    for (let s = 0; s < stride3; s += 3) {
      const x = posSrc[s]
      const y = posSrc[s + 1]
      const z = posSrc[s + 2]
      posDst[o++] = e[0] * x + e[4] * y + e[8] * z + e[12]
      posDst[o++] = e[1] * x + e[5] * y + e[9] * z + e[13]
      posDst[o++] = e[2] * x + e[6] * y + e[10] * z + e[14]
    }
    if (nrmSrc && nrmDst) {
      const n = nmat.getNormalMatrix(world).elements
      let on = i * stride3
      for (let s = 0; s < stride3; s += 3) {
        const x = nrmSrc[s]
        const y = nrmSrc[s + 1]
        const z = nrmSrc[s + 2]
        const nx = n[0] * x + n[3] * y + n[6] * z
        const ny = n[1] * x + n[4] * y + n[7] * z
        const nz = n[2] * x + n[5] * y + n[8] * z
        const len = Math.sqrt(nx * nx + ny * ny + nz * nz)
        const inv = len > 0 ? 1 / len : 0
        nrmDst[on++] = nx * inv
        nrmDst[on++] = ny * inv
        nrmDst[on++] = nz * inv
      }
    }
    if (tanSrc && tanDst && tangent) {
      // tangents transform as directions (upper 3×3), w keeps handedness
      const k = tangent.itemSize
      const strideT = vertCount * k
      let ot = i * strideT
      for (let s = 0; s < strideT; s += k) {
        const x = tanSrc[s]
        const y = tanSrc[s + 1]
        const z = tanSrc[s + 2]
        const tx = e[0] * x + e[4] * y + e[8] * z
        const ty = e[1] * x + e[5] * y + e[9] * z
        const tz = e[2] * x + e[6] * y + e[10] * z
        const len = Math.sqrt(tx * tx + ty * ty + tz * tz)
        const inv = len > 0 ? 1 / len : 0
        tanDst[ot++] = tx * inv
        tanDst[ot++] = ty * inv
        tanDst[ot++] = tz * inv
        if (k === 4) tanDst[ot++] = tanSrc[s + 3]
      }
    }
  }
  merged.setAttribute('position', new THREE.BufferAttribute(posDst, 3))
  if (nrmDst) merged.setAttribute('normal', new THREE.BufferAttribute(nrmDst, 3))
  if (tanDst && tangent) {
    merged.setAttribute('tangent', new THREE.BufferAttribute(tanDst, tangent.itemSize))
  }

  // untransformed channels the path tracer reads — straight tiles
  const uv = plainAttribute(src.getAttribute('uv'))
  if (uv) merged.setAttribute('uv', tileAttribute(uv, instCount))
  const color = plainAttribute(src.getAttribute('color'))
  if (color) merged.setAttribute('color', tileAttribute(color, instCount))

  return merged
}

/** Final-blit grain overlay: subtle ± luminance noise, fixed per seed. */
function makeGrainMaterial(): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    name: 'StudioGrain',
    uniforms: {
      seed: { value: 1 },
      amount: { value: GRAIN_AMOUNT },
    },
    vertexShader: /* glsl */ `
      void main() {
        gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );
      }
    `,
    fragmentShader: /* glsl */ `
      uniform float seed;
      uniform float amount;
      float hash( vec2 p ) {
        return fract( sin( dot( p, vec2( 12.9898, 78.233 ) ) ) * 43758.5453123 );
      }
      void main() {
        float n = hash( gl_FragCoord.xy + vec2( seed * 17.13, seed * 9.77 ) );
        float s = n * 2.0 - 1.0; // signed grain
        // normal blending toward white/black: ± luminance, zero-mean overall
        gl_FragColor = vec4( vec3( step( 0.0, s ) ), abs( s ) * amount );
      }
    `,
    transparent: true,
    blending: THREE.NormalBlending,
    depthTest: false,
    depthWrite: false,
  })
}

/**
 * Free a WebGLPathTracer's GPU memory for real. 0.0.23's own `dispose()` is
 * BROKEN: its first line reads `this._renderQuad` (the field is `_quad`),
 * throws, and frees NOTHING — and leaving Studio is precisely when the app
 * must return its biggest GPU allocations (three full-float RGBA accumulation
 * targets at the internal resolution plus the packed BVH / vertex-attribute /
 * material / environment-CDF float textures). Reach into the internals and
 * dispose them directly — every step defensive (optional-chained + try/catch)
 * so a future patch release or a lost GL context can't turn teardown into a
 * crash. `keep` guards live app textures (scene environment/background) that
 * may sit in material uniforms.
 */
function disposePathTracerDeep(pt: WebGLPathTracer, keep: ReadonlySet<unknown>): void {
  interface Disposable {
    dispose?: () => void
  }
  const internals = pt as unknown as {
    _pathTracer?: Disposable & { material?: THREE.ShaderMaterial }
    _lowResPathTracer?: Disposable & { material?: THREE.ShaderMaterial }
    _quad?: Disposable & { material?: THREE.Material }
    _colorBackground?: Disposable | null
    _internalBackground?: Disposable | null
  }
  for (const tracer of [internals._pathTracer, internals._lowResPathTracer]) {
    if (!tracer) continue
    try {
      tracer.dispose?.() // accumulation/blend targets, sobol target, quads
    } catch {
      /* lost context / partial construction */
    }
    const material = tracer.material
    if (material?.uniforms) {
      // texture-bearing uniforms: bvh struct, attribute/material/env-CDF
      // textures, stratified sampler... — anything exposing dispose(), plus
      // structs that hold a `.tex` DataTexture without exposing their own
      // dispose (LightsInfoUniformStruct)
      for (const key of Object.keys(material.uniforms)) {
        const value = material.uniforms[key].value as
          | (Disposable & { tex?: Disposable | null })
          | null
        if (!value || keep.has(value)) continue
        try {
          if (typeof value.dispose === 'function') value.dispose()
          else if (value.tex && typeof value.tex.dispose === 'function') value.tex.dispose()
        } catch {
          /* shared or already disposed */
        }
      }
      try {
        material.dispose()
      } catch {
        /* tolerate */
      }
    }
  }
  try {
    internals._quad?.material?.dispose()
    internals._quad?.dispose?.()
    internals._colorBackground?.dispose?.()
    internals._internalBackground?.dispose?.()
  } catch {
    /* tolerate */
  }
}

/** Best-effort BVH worker probe: builds a 1-triangle BVH or returns null. */
async function probeBVHWorker(): Promise<BVHWorkerLike | null> {
  try {
    const mod = await import('three-mesh-bvh/src/workers/GenerateMeshBVHWorker.js')
    const worker = new mod.GenerateMeshBVHWorker()
    const probe = new THREE.BufferGeometry()
    probe.setAttribute(
      'position',
      new THREE.BufferAttribute(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]), 3),
    )
    const timeout = new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error('BVH worker probe timed out')), WORKER_PROBE_TIMEOUT_MS)
    })
    await Promise.race([worker.generate(probe), timeout])
    probe.dispose()
    return worker
  } catch (err) {
    console.warn('[render-modes] BVH worker unavailable — falling back to sync builds', err)
    return null
  }
}

/**
 * Async factory: probes the worker once, then hands back a ready pipeline.
 * (The dynamic-import boundary lives in the manager; this module is the
 * lazy chunk.)
 */
export async function createStudioPipeline(
  ctx: RenderContext,
  enhanced: EnhancedPipeline,
  onProgress: (p: StudioProgress) => void,
): Promise<StudioPipeline> {
  const worker = await probeBVHWorker()
  return new StudioPipeline(ctx, enhanced, worker, onProgress)
}

/** Saved live-material state for the Studio clearcoat fold (restored on dispose). */
interface CoatSnapshot {
  clearcoat: number
  roughness: number
  specularIntensity: number
}

export class StudioPipeline {
  private readonly ctx: RenderContext
  private readonly enhanced: EnhancedPipeline
  private readonly onProgress: (p: StudioProgress) => void
  private worker: BVHWorkerLike | null
  private pathTracer: WebGLPathTracer

  private sceneDirty = true // first render builds
  private building = false
  private hasScene = false
  private disposed = false
  /** Consecutive build failures; past the limit Studio yields to Enhanced. */
  private buildFailures = 0

  readonly targetSamples: number

  // change detection — all preallocated, no per-frame garbage
  private readonly lastCamWorld = new THREE.Matrix4()
  private readonly lastCamProj = new THREE.Matrix4()
  private lastEnv: THREE.Texture | null = null
  private camPrimed = false

  /**
   * The path tracer NEVER sees ctx.camera directly: it renders through this
   * PhysicalCamera mirror so the still gets a real lens (focus + aperture →
   * depth of field) while the raster pipelines keep their pinhole camera.
   * Synced (matrices + lens) whenever the live camera settles.
   */
  private readonly studioCamera = new PhysicalCamera()
  private readonly camPos = new THREE.Vector3()
  private readonly camDir = new THREE.Vector3()

  /** scratch for the per-frame pixel-budget check — no per-frame allocations */
  private readonly drawSize = new THREE.Vector2()
  /** is the Enhanced 4096 shadow bump currently relaxed for GPU headroom? */
  private shadowRelaxed = false

  /** final-blit grain overlay — allocated once, one uniform write per frame */
  private readonly grainMaterial: THREE.ShaderMaterial
  private readonly grainQuad: FullScreenQuad

  /** live material state saved for the clearcoat fold (every coated material) */
  private readonly savedCoat = new Map<THREE.MeshPhysicalMaterial, CoatSnapshot>()
  /** original materials swapped out for the still (bbStudioMatte meshes) */
  private readonly savedMatte = new Map<THREE.Mesh, THREE.Material | THREE.Material[]>()
  /** the matte stand-ins created for bbStudioMatte meshes (disposed on restore) */
  private readonly matteStandIns: THREE.MeshStandardMaterial[] = []

  // reused progress payload (documented: listeners must copy to retain)
  private readonly progress: StudioProgress = {
    phase: 'building',
    samples: 0,
    targetSamples: 0,
    converged: false,
  }
  private lastEmittedSamples = -1
  private lastEmittedPhase: StudioProgress['phase'] | null = null

  constructor(
    ctx: RenderContext,
    enhanced: EnhancedPipeline,
    worker: BVHWorkerLike | null,
    onProgress: (p: StudioProgress) => void,
  ) {
    this.ctx = ctx
    this.enhanced = enhanced
    this.worker = worker
    this.onProgress = onProgress
    this.targetSamples = studioTargetSamples(ctx.caps)
    this.progress.targetSamples = this.targetSamples
    // the mirror's matrices are copied wholesale from the live camera —
    // never recomposed from position/quaternion
    this.studioCamera.matrixAutoUpdate = false
    this.grainMaterial = makeGrainMaterial()
    this.grainQuad = new FullScreenQuad(this.grainMaterial)
    this.pathTracer = this.makePathTracer()
  }

  private makePathTracer(): WebGLPathTracer {
    const { renderer, caps } = this.ctx
    const pt = new WebGLPathTracer(renderer)
    pt.bounces = 6
    pt.transmissiveBounces = 8 // LED epoxy/glass needs a few extra
    pt.filterGlossyFactor = 0.25 // tames speculars/fireflies on the metals
    // device-class base values; updateBudgets() refines both against the live
    // drawing-buffer size every frame BEFORE any sampling happens (the
    // internal targets are allocated lazily on the first renderSample)
    pt.renderScale = studioRenderScale(caps)
    pt.synchronizeRenderSize = true // track canvas size (pixelRatio ≤ 2 cap)
    pt.tiles.set(studioTiles(caps), studioTiles(caps))
    pt.dynamicLowRes = false // we fall back to Enhanced raster ourselves
    pt.renderDelay = 0
    pt.minSamples = 3
    pt.fadeDuration = FADE_DURATION_MS
    pt.renderToCanvas = true // present via the renderer (ACES applied there)
    // While warming up / fading in, the path tracer paints the Enhanced
    // composer frame underneath — seamless raster→ray-traced handoff.
    pt.rasterizeScene = true
    pt.rasterizeSceneCallback = () => {
      this.enhanced.render()
    }
    // Final blit: the library's tone-mapped present of the accumulated
    // target, then the grain overlay. Seeding by the sample counter makes the
    // grain shimmer faintly while converging and FREEZE with the held still
    // (a photo's grain is static) — one tiny fullscreen quad, no allocations.
    pt.renderToCanvasCallback = (_target, renderer2, quad) => {
      const autoClear = renderer2.autoClear
      renderer2.autoClear = false
      quad.render(renderer2)
      this.grainMaterial.uniforms.seed.value = (Math.floor(this.pathTracer.samples) % 256) + 1
      this.grainQuad.render(renderer2)
      renderer2.autoClear = autoClear
    }
    if (this.worker) pt.setBVHWorker(this.worker as Parameters<WebGLPathTracer['setBVHWorker']>[0])
    return pt
  }

  /** Scene content changed — rebuild lazily on the next idle frame. */
  invalidate(): void {
    this.sceneDirty = true
  }

  /** Cheap refresh for material-only edits (LED emissive etc.) — no BVH. */
  refreshMaterials(): void {
    if (this.hasScene && !this.building) {
      this.pathTracer.updateMaterials()
    } else {
      this.sceneDirty = true
    }
  }

  /** Is the path-traced still fully converged (and being held)? */
  get converged(): boolean {
    return this.hasScene && !this.building && this.pathTracer.samples >= this.targetSamples
  }

  private emit(phase: StudioProgress['phase'], samples: number): void {
    const s = Math.floor(samples)
    if (phase === this.lastEmittedPhase && s === this.lastEmittedSamples) return
    this.lastEmittedPhase = phase
    this.lastEmittedSamples = s
    this.progress.phase = phase
    this.progress.samples = s
    this.progress.converged = phase === 'converged'
    this.onProgress(this.progress)
  }

  /**
   * Mirror the live camera into the PhysicalCamera the path tracer renders
   * through, and place the lens: focus where the view ray meets the
   * component-height plane (orbit framings always look down at the board),
   * aperture scaled with the focus distance for a consistent f/2.8-equivalent
   * depth of field across macro and full-board framings.
   */
  private syncStudioCamera(): void {
    const cam = this.ctx.camera
    const pc = this.studioCamera
    pc.fov = cam.fov
    pc.aspect = cam.aspect
    pc.near = cam.near
    pc.far = cam.far
    pc.matrix.copy(cam.matrixWorld)
    pc.matrixWorld.copy(cam.matrixWorld)
    pc.projectionMatrix.copy(cam.projectionMatrix)
    pc.projectionMatrixInverse.copy(cam.projectionMatrixInverse)

    this.camPos.setFromMatrixPosition(cam.matrixWorld)
    this.camDir.set(0, 0, -1).transformDirection(cam.matrixWorld)
    let focus = this.camPos.length() // fallback: distance to the rig center
    if (Math.abs(this.camDir.y) > 1e-4) {
      const t = (DOF_FOCUS_PLANE_Y - this.camPos.y) / this.camDir.y
      if (t > 0) focus = t
    }
    focus = THREE.MathUtils.clamp(focus, DOF_MIN_FOCUS, DOF_MAX_FOCUS)
    pc.focusDistance = focus
    // shader: world-space aperture diameter = bokehSize × 1e-3
    pc.bokehSize = focus * DOF_APERTURE_FRACTION * 1e3
  }

  /**
   * Bake visible InstancedMeshes (hole collars/plugs) into one temporary
   * merged mesh group so they appear in the still — 0.0.23 treats an
   * InstancedMesh as a single un-instanced copy otherwise. The per-batch
   * bake is a straight preallocated-buffer write (bakeInstancedMeshGeometry).
   */
  private buildInstanceExpansion(): THREE.Group | null {
    const group = new THREE.Group()
    group.name = 'studio-instance-expansion'
    let budget = MAX_EXPANDED_TRIANGLES
    this.ctx.scene.traverse((o) => {
      const im = o as THREE.InstancedMesh
      if (!im.isInstancedMesh || im.count === 0 || im.userData.bbNoStudio === true) return
      // skip subtrees the scene has hidden
      for (let p: THREE.Object3D | null = im; p; p = p.parent) if (!p.visible) return
      const tris = triangleCount(im.geometry) * im.count
      if (tris > budget) return // over budget — this batch stays raster-only
      const merged = bakeInstancedMeshGeometry(im)
      if (!merged) return // exotic attribute layout — this batch stays raster-only
      budget -= tris
      group.add(new THREE.Mesh(merged, im.material))
    })
    return group.children.length > 0 ? group : null
  }

  /**
   * Path-tracer material workarounds (0.0.23 — see the module docblock):
   *
   * (1) Fold the clearcoat of EVERY coated material into its base lobe. The
   * clearcoat lobe renders BLACK at grazing view angles — originally believed
   * limited to large flat surfaces (the board slab, flagged
   * `bbStudioNoClearcoat`), but Phase-C verification stills proved curved
   * bodies suffer identically at wide framings, so the coat is suppressed
   * globally. Plain zeroing, however, lost the lacquer/PVC/epoxy sheen the
   * photoreal mode exists for (the converged resistor macro read satin) — so
   * the coat is folded instead: base roughness is pulled toward the coat's
   * own (glossier) roughness and specularIntensity gains the coat's added
   * reflectance, approximating the crisp dip-coat window highlights with the
   * surviving base specular lobe.
   *
   * (2) Swap meshes flagged `userData.bbStudioMatte` (the unlit desk
   * backdrop, MeshBasicMaterial) to a rough standard stand-in: the path
   * tracer treats basic materials as perfect mirrors, turning the desk into
   * a glossy black mirror that reflects the HDRI softboxes as huge blown
   * white blobs around instruments.
   *
   * Values/materials are saved once and restored in dispose();
   * updateMaterials() re-reads the live (overridden) state, so both
   * overrides survive material refreshes for the whole Studio session.
   */
  private applyMaterialOverrides(): void {
    this.ctx.scene.traverse((o) => {
      const mesh = o as THREE.Mesh
      if (!mesh.isMesh) return
      if (mesh.userData.bbStudioMatte === true && !this.savedMatte.has(mesh)) {
        const orig = mesh.material
        const base = (Array.isArray(orig) ? orig[0] : orig) as THREE.MeshBasicMaterial
        const standIn = new THREE.MeshStandardMaterial({
          map: base.map ?? null,
          color: base.color ? base.color.clone() : new THREE.Color(0xffffff),
          transparent: base.transparent === true,
          depthWrite: base.depthWrite !== false,
          roughness: 1,
          metalness: 0,
        })
        this.savedMatte.set(mesh, orig)
        this.matteStandIns.push(standIn)
        mesh.material = standIn
        return
      }
      const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material]
      for (const m of mats) {
        const phys = m as THREE.MeshPhysicalMaterial
        if (
          phys &&
          phys.isMeshPhysicalMaterial === true &&
          typeof phys.clearcoat === 'number' &&
          phys.clearcoat !== 0 &&
          !this.savedCoat.has(phys)
        ) {
          this.savedCoat.set(phys, {
            clearcoat: phys.clearcoat,
            roughness: phys.roughness,
            specularIntensity: phys.specularIntensity,
          })
          const coat = THREE.MathUtils.clamp(phys.clearcoat, 0, 1)
          const foldedGloss = Math.min(phys.roughness, phys.clearcoatRoughness * COAT_FOLD_GLOSS)
          const weight = Math.min(1, coat * COAT_FOLD_RATE)
          phys.roughness = THREE.MathUtils.lerp(phys.roughness, foldedGloss, weight)
          phys.specularIntensity = Math.min(COAT_SPECULAR_CAP, phys.specularIntensity + coat)
          phys.clearcoat = 0
        }
      }
    })
  }

  private restoreMaterialOverrides(): void {
    for (const [mat, saved] of this.savedCoat) {
      mat.clearcoat = saved.clearcoat
      mat.roughness = saved.roughness
      mat.specularIntensity = saved.specularIntensity
    }
    this.savedCoat.clear()
    for (const [mesh, orig] of this.savedMatte) mesh.material = orig
    this.savedMatte.clear()
    for (const m of this.matteStandIns) m.dispose()
    this.matteStandIns.length = 0
  }

  private startRebuild(): void {
    this.sceneDirty = false
    this.building = true
    this.hasScene = false
    this.emit('building', 0)
    this.applyMaterialOverrides()
    this.syncStudioCamera()

    const { scene } = this.ctx
    // Bake what must (instances — BEFORE hiding them), hide what can't
    // path-trace. The generator traverses synchronously (only the BVH build
    // itself runs on the worker), so the live scene is restored before this
    // function returns.
    const expansion = this.buildInstanceExpansion()
    const hidden: THREE.Object3D[] = []
    scene.traverse((o) => {
      if (o.visible && isExcludedMesh(o)) {
        o.visible = false
        hidden.push(o)
      }
    })
    if (expansion) scene.add(expansion)

    let result: Promise<unknown>
    try {
      result = this.worker
        ? (this.pathTracer.setSceneAsync(scene, this.studioCamera) as unknown as Promise<unknown>)
        : Promise.resolve(this.pathTracer.setScene(scene, this.studioCamera))
    } catch (err) {
      result = Promise.reject(err)
    } finally {
      for (const o of hidden) o.visible = true
      if (expansion) {
        scene.remove(expansion)
        for (const child of expansion.children) {
          ;(child as THREE.Mesh).geometry.dispose() // merged copies are ours
        }
      }
    }

    result.then(
      () => {
        if (this.disposed) return
        this.building = false
        this.hasScene = true
        this.buildFailures = 0
        this.lastEnv = scene.environment
        this.primeCamera()
        this.pathTracer.reset()
        this.emit('sampling', 0)
      },
      (err) => {
        console.warn('[render-modes] studio scene build failed', err)
        if (this.disposed) return
        this.building = false
        this.buildFailures++
        if (this.buildFailures > MAX_BUILD_FAILURES) return // give up: render() yields to Enhanced
        this.sceneDirty = true // retry on the next idle frame…
        if (this.worker) {
          // …without the worker: a failed async build can leave the
          // generator wedged, so rebuild the path tracer in sync mode.
          this.worker.dispose()
          this.worker = null
          disposePathTracerDeep(this.pathTracer, this.liveTextures())
          this.pathTracer = this.makePathTracer()
        }
      },
    )
  }

  private primeCamera(): void {
    const cam = this.ctx.camera
    cam.updateMatrixWorld()
    this.lastCamWorld.copy(cam.matrixWorld)
    this.lastCamProj.copy(cam.projectionMatrix)
    this.camPrimed = true
    // the camera may have moved while the BVH build was in flight — the path
    // tracer holds the MIRROR (never ctx.camera), so re-mirror before sampling
    this.syncStudioCamera()
    this.pathTracer.updateCamera()
  }

  /**
   * Per-frame resolution/tiling budgets (see capability.ts):
   * - renderScale: device-class base clamped by STUDIO_PIXEL_BUDGET — a
   *   5.2 MP retina canvas traces at ~0.71× instead of crashing the GPU
   *   process during convergence. The library applies a scale change on the
   *   next renderSample (an actual size change resets accumulation, exactly
   *   like a window resize already does).
   * - tiles: one renderSample traces ONE tile, so tiles are raised until a
   *   tile fits STUDIO_TILE_PIXEL_BUDGET, and the first samples after every
   *   accumulation restart use the finer studioRestartTiles ladder so a
   *   camera-settle never bursts a >33 ms frame. Tile changes apply at the
   *   next sample round and never reset accumulation.
   */
  private updateBudgets(): void {
    const { renderer, caps } = this.ctx
    const pt = this.pathTracer
    renderer.getDrawingBufferSize(this.drawSize)
    const canvasPixels = this.drawSize.x * this.drawSize.y
    const scale = studioRenderScale(caps, canvasPixels)
    if (pt.renderScale !== scale) pt.renderScale = scale
    const tracedPixels = canvasPixels * scale * scale
    const tiles = studioRestartTiles(studioTiles(caps, tracedPixels), pt.samples)
    if (pt.tiles.x !== tiles || pt.tiles.y !== tiles) pt.tiles.set(tiles, tiles)
    // On over-budget (retina-class) canvases the GPU process is under real
    // memory pressure — give back the 4096 shadow bump while Studio drives
    // (the still's shadows are path-traced; only motion-fallback frames see
    // the scene's native shadow size). Restored on dispose.
    const relax = canvasPixels > STUDIO_PIXEL_BUDGET
    if (relax !== this.shadowRelaxed) {
      this.shadowRelaxed = relax
      this.enhanced.setShadowRelaxed(relax)
    }
  }

  /**
   * Render one progressive step. Returns false when the manager should draw
   * the Enhanced raster instead (camera moving, build in flight).
   */
  render(): boolean {
    if (this.disposed) return false
    this.updateBudgets()
    if (this.sceneDirty && !this.building) this.startRebuild()
    if (!this.hasScene || this.building) return false

    // environment swap (HDRI arriving, mode churn) — cheap identity check
    if (this.ctx.scene.environment !== this.lastEnv) {
      this.lastEnv = this.ctx.scene.environment
      this.pathTracer.updateEnvironment()
    }

    // motion guard: any camera change (orbit damping, tweens, resize) resets
    // accumulation and yields the frame to the Enhanced raster
    const cam = this.ctx.camera
    cam.updateMatrixWorld()
    if (
      !this.camPrimed ||
      !this.lastCamWorld.equals(cam.matrixWorld) ||
      !this.lastCamProj.equals(cam.projectionMatrix)
    ) {
      this.lastCamWorld.copy(cam.matrixWorld)
      this.lastCamProj.copy(cam.projectionMatrix)
      this.camPrimed = true
      this.syncStudioCamera() // re-aim the lens (focus follows the framing)
      this.pathTracer.updateCamera() // resets samples
      return false
    }

    if (this.pathTracer.samples >= this.targetSamples) {
      // converged: hold the still — but keep RE-PRESENTING it every frame.
      // pausePathTracing skips the (expensive) accumulation pass while
      // renderSample still blits the accumulated target through its
      // fullscreen quad, so the canvas has fresh, defined contents each frame
      // and the scene integrator can composite its raster overlays (hover
      // ring, holograms, selection boxes) on top of the held still.
      this.emit('converged', this.pathTracer.samples)
      this.pathTracer.pausePathTracing = true
      this.pathTracer.renderSample()
      this.pathTracer.pausePathTracing = false
      return true
    }

    this.pathTracer.renderSample()
    this.emit('sampling', this.pathTracer.samples)
    return true
  }

  /** Live app textures that may sit in path-tracer uniforms — never dispose. */
  private liveTextures(): ReadonlySet<unknown> {
    return new Set<unknown>([
      this.ctx.scene.environment,
      this.ctx.scene.background,
      this.enhanced.environmentTexture,
    ])
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    if (this.shadowRelaxed) {
      this.shadowRelaxed = false
      this.enhanced.setShadowRelaxed(false) // hand the 4096 bump back
    }
    this.restoreMaterialOverrides() // hand the clearcoat back to the rasters
    this.worker?.dispose()
    this.worker = null
    this.grainQuad.dispose()
    this.grainMaterial.dispose()
    // NOT this.pathTracer.dispose(): broken in 0.0.23 (throws before freeing
    // anything) — see disposePathTracerDeep. Leaving Studio must actually
    // return the accumulation targets + BVH textures to the GPU.
    disposePathTracerDeep(this.pathTracer, this.liveTextures())
  }
}
