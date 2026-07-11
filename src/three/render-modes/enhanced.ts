/**
 * ENHANCED mode — HDRI image-based lighting + a post stack, still raster.
 *
 * - RGBELoader loads the bundled CC0 studio HDRI (public/hdri/) and swaps it
 *   in for the RoomEnvironment while the mode is active (equirect mapping —
 *   the renderer PMREMs it internally and caches the result, and the path
 *   tracer can consume the very same texture for its environment).
 * - EffectComposer stack: RenderPass → SAO (ambient occlusion, estimated at
 *   half resolution with a skip-listed normal pre-pass — see ScaledSAOPass)
 *   → UnrealBloom (threshold ≥ 1 so only HDR emitters — LED glows, hot
 *   speculars — bloom) → OutputPass (ACES + sRGB, once) → SMAA.
 * - Key-light shadow map is bumped to 4096 on desktop while active (still
 *   the single on-demand map; restored on deactivate).
 *
 * Loaded lazily by the manager (dynamic import) so Performance users never
 * pay for the composer code.
 */
import * as THREE from 'three'
import { RGBELoader } from 'three/examples/jsm/loaders/RGBELoader.js'
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js'
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js'
import { SAOPass } from 'three/examples/jsm/postprocessing/SAOPass.js'
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js'
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js'
import { SMAAPass } from 'three/examples/jsm/postprocessing/SMAAPass.js'
import { enhancedShadowMapSize } from './capability'
import type { RenderContext } from './types'

/** CC0 studio HDRI (Poly Haven `studio_small_03`, 1k) — see RENDER-MODES.md. */
export const HDRI_URL = `${import.meta.env.BASE_URL}hdri/studio_small_03_1k.hdr`

// Post-stack tuning (visual pass happens against the screenshot harnesses —
// `npm run build && node scripts/modes.mjs`, view shots/modes-enhanced.png).
const SAO_INTENSITY = 0.018 // SAOPass intensity is extremely hot; keep subtle
const SAO_SCALE = 32 // board is ~63 units long — AO radius in scene scale
const SAO_KERNEL_RADIUS = 24 // FULL-resolution pixels (rescaled to the AO buffer)
/**
 * AO buffer resolution as a fraction of the canvas. SAO was the single
 * biggest Enhanced cost (the Phase D profile attributes ~4.5–5 ms/frame GPU
 * at 5.2 MP plus a full second geometry pass to it — skipping it alone took
 * the orbit from 74.9 → 113.3 fps). AO is low-frequency by nature: estimating
 * it at half resolution and letting the (depth-limited, already-blurring)
 * blur + the linear-filtered composite upsample it back is visually
 * indistinguishable at normal viewing — verified against the closeups/modes
 * harnesses — while cutting the AO estimation + blur fill AND the
 * normal-prepass fill to a quarter. All pixel-unit SAO params (kernel
 * radius, blur radius/stddev) are scaled by this factor so the AO keeps the
 * exact same world-space footprint (SAOShader: `radius = kernelRadius/size`).
 */
const SAO_RESOLUTION_SCALE = 0.5
const SAO_BLUR_RADIUS = 8 // three's default, FULL-resolution pixels
const SAO_BLUR_STDDEV = 4 // three's default, FULL-resolution pixels
/**
 * The SAO normal/depth pre-pass re-renders the whole scene (it is the reason
 * Enhanced draws ~2× the calls of Performance). Meshes whose world bounding
 * sphere is smaller than this radius (scene units; 1 unit = 0.1") — wire end
 * caps, bare tip pins, resistor band rings — sit flush on a larger surface at
 * essentially the same depth, so their absence from the half-res depth/normal
 * buffer is invisible in the AO term; skipping them removes hundreds of
 * draw calls per frame on dense boards. Transparent / non-depth-writing
 * materials (glow shells, labels, the board decal) are skipped too: the
 * override material renders them fully OPAQUE into the depth buffer today,
 * which is wrong anyway (the decal z-fights the board face it sits on).
 */
const SAO_PREPASS_MIN_RADIUS = 0.7
const BLOOM_STRENGTH = 0.16 // glints, not blobs — posts/LEDs glow softly
const BLOOM_RADIUS = 0.22
/**
 * Linear-HDR bloom cutoff. The white ABS board under key+HDRI sits around
 * 1.1–1.4 linear luminance — the threshold must clear it comfortably so ONLY
 * true HDR emitters (lit LED glows, hot speculars) bloom, never the board.
 */
const BLOOM_THRESHOLD = 1.6
/**
 * scene.environmentIntensity while the HDRI drives the lighting: the studio
 * HDRI (softboxes) is several times brighter than the PMREM RoomEnvironment
 * it displaces — at the scene's native 0.85 the white board blows out past
 * the bloom threshold and the whole frame halos. Saved/restored alongside
 * the environment texture itself.
 */
const HDRI_ENV_INTENSITY = 0.32

/**
 * SAOPass that keeps its AO / blur / normal-prepass targets at
 * `SAO_RESOLUTION_SCALE` × the composer resolution (the multiply-composite
 * onto the beauty buffer samples the AO target with linear filtering, i.e. a
 * free bilinear upsample), and skips a cached list of meshes during the
 * normal/depth pre-pass (see SAO_PREPASS_MIN_RADIUS).
 */
class ScaledSAOPass extends SAOPass {
  /** Meshes hidden for the normal/depth pre-pass only (cache owned by the pipeline). */
  private prepassSkips: THREE.Object3D[] = []
  /** Parallel scratch of pre-hide visibility — reused, no per-frame allocations. */
  private readonly prepassWasVisible: boolean[] = []

  setSize(width: number, height: number): void {
    super.setSize(
      Math.max(1, Math.round(width * SAO_RESOLUTION_SCALE)),
      Math.max(1, Math.round(height * SAO_RESOLUTION_SCALE)),
    )
  }

  setPrepassSkips(skips: THREE.Object3D[]): void {
    this.prepassSkips = skips
  }

  renderOverride(
    renderer: THREE.WebGLRenderer,
    overrideMaterial: THREE.Material,
    renderTarget: THREE.WebGLRenderTarget,
    clearColor?: THREE.ColorRepresentation,
    clearAlpha?: number,
  ): void {
    // SAOPass calls this exactly once per render — the normal/depth pre-pass.
    // Hide the skip list around it; the beauty RenderPass ran first, so any
    // pending on-demand shadow update has already been consumed with full
    // visibility.
    const skips = this.prepassSkips
    const was = this.prepassWasVisible
    was.length = skips.length
    for (let i = 0; i < skips.length; i++) {
      was[i] = skips[i].visible
      skips[i].visible = false
    }
    super.renderOverride(renderer, overrideMaterial, renderTarget, clearColor, clearAlpha)
    for (let i = 0; i < skips.length; i++) skips[i].visible = was[i]
  }
}

export class EnhancedPipeline {
  private readonly ctx: RenderContext
  private readonly composer: EffectComposer
  private readonly saoPass: ScaledSAOPass
  private readonly bloomPass: UnrealBloomPass
  private readonly smaaPass: SMAAPass
  private readonly outputPass: OutputPass
  private readonly renderPass: RenderPass

  /** Equirect HDR env (null until the .hdr finishes loading). */
  private envTexture: THREE.Texture | null = null
  private envLoadStarted = false
  private active = false
  private disposed = false

  /** What we displaced while active, to restore on deactivate. */
  private savedEnvironment: THREE.Texture | null = null
  private savedEnvIntensity: number | null = null
  private savedShadowSize = 0
  private keyLight: THREE.DirectionalLight | null = null

  /** SAO pre-pass skip cache (see SAO_PREPASS_MIN_RADIUS); rebuilt lazily. */
  private readonly prepassSkips: THREE.Object3D[] = []
  private prepassDirty = true
  /** Studio headroom: the 4096 bump is temporarily undone (see setShadowRelaxed). */
  private shadowRelaxed = false

  constructor(ctx: RenderContext) {
    this.ctx = ctx
    const { renderer, scene, camera } = ctx
    const size = renderer.getSize(new THREE.Vector2())
    const pr = renderer.getPixelRatio()

    // HalfFloat composer target (default since r152) keeps HDR for the bloom
    // threshold; OutputPass applies ACES + sRGB exactly once at the end.
    this.composer = new EffectComposer(renderer)
    this.composer.setPixelRatio(pr)
    this.composer.setSize(size.x, size.y)

    this.renderPass = new RenderPass(scene, camera)

    this.saoPass = new ScaledSAOPass(scene, camera)
    this.saoPass.params.saoIntensity = SAO_INTENSITY
    this.saoPass.params.saoScale = SAO_SCALE
    // pixel-unit params are expressed at full resolution above and rescaled
    // to the half-res AO buffer so the world-space AO footprint is unchanged
    this.saoPass.params.saoKernelRadius = Math.max(
      1,
      Math.round(SAO_KERNEL_RADIUS * SAO_RESOLUTION_SCALE),
    )
    this.saoPass.params.saoBlurRadius = Math.max(
      1,
      Math.round(SAO_BLUR_RADIUS * SAO_RESOLUTION_SCALE),
    )
    this.saoPass.params.saoBlurStdDev = SAO_BLUR_STDDEV * SAO_RESOLUTION_SCALE
    this.saoPass.params.saoBlur = true

    this.bloomPass = new UnrealBloomPass(
      new THREE.Vector2(size.x, size.y),
      BLOOM_STRENGTH,
      BLOOM_RADIUS,
      BLOOM_THRESHOLD,
    )

    this.outputPass = new OutputPass()
    this.smaaPass = new SMAAPass(size.x * pr, size.y * pr)

    this.composer.addPass(this.renderPass)
    this.composer.addPass(this.saoPass)
    this.composer.addPass(this.bloomPass)
    this.composer.addPass(this.outputPass)
    this.composer.addPass(this.smaaPass) // AA on the final LDR/sRGB image

    this.loadEnvironment()
  }

  /** The raw equirect HDR texture (Studio reuses it for its env). */
  get environmentTexture(): THREE.Texture | null {
    return this.envTexture
  }

  private loadEnvironment(): void {
    if (this.envLoadStarted) return
    this.envLoadStarted = true
    new RGBELoader().loadAsync(HDRI_URL).then(
      (tex) => {
        if (this.disposed) {
          tex.dispose()
          return
        }
        tex.mapping = THREE.EquirectangularReflectionMapping
        this.envTexture = tex
        // If we're already live, swap the env in now that it exists.
        if (this.active) this.applyEnvironment()
      },
      (err) => {
        // Offline / asset missing: Enhanced still runs on the scene's own
        // RoomEnvironment — degraded but functional.
        console.warn('[render-modes] HDRI load failed; keeping existing environment', err)
      },
    )
  }

  private applyEnvironment(): void {
    const { scene } = this.ctx
    if (!this.envTexture || scene.environment === this.envTexture) return
    if (this.savedEnvironment === null) this.savedEnvironment = scene.environment
    if (this.savedEnvIntensity === null) this.savedEnvIntensity = scene.environmentIntensity
    scene.environment = this.envTexture
    scene.environmentIntensity = HDRI_ENV_INTENSITY
  }

  private findKeyLight(): THREE.DirectionalLight | null {
    let found: THREE.DirectionalLight | null = null
    this.ctx.scene.traverse((o) => {
      if (!found && (o as THREE.DirectionalLight).isDirectionalLight && o.castShadow) {
        found = o as THREE.DirectionalLight
      }
    })
    return found
  }

  /** Swap the HDRI env in and bump the shadow budget. Idempotent. */
  activate(): void {
    if (this.active || this.disposed) return
    this.active = true
    this.applyEnvironment()

    const size = enhancedShadowMapSize(this.ctx.caps)
    const key = this.findKeyLight()
    if (key && key.shadow.mapSize.x < size && !this.shadowRelaxed) {
      this.keyLight = key
      this.savedShadowSize = key.shadow.mapSize.x
      key.shadow.mapSize.set(size, size)
      // force the (single, on-demand) map to re-allocate at the new size
      key.shadow.map?.dispose()
      key.shadow.map = null
      this.ctx.renderer.shadowMap.needsUpdate = true
    }
  }

  /**
   * Studio GPU-memory headroom on huge (over-pixel-budget) canvases: the
   * desktop 4096 hero shadow map costs ~130 MB of GPU memory that the
   * path-traced still never reads (its shadows are traced), and the @2x
   * retina GPU process is exactly the one dying of memory pressure during
   * convergence. While relaxed, the key light runs at the scene's native
   * shadow size (the approved Performance-mode look) — only the raster
   * FALLBACK shown during camera motion in Studio mode is affected, never a
   * still and never Enhanced mode proper. Restored when Studio releases it
   * (dispose) or when Enhanced takes back the frame.
   */
  setShadowRelaxed(relaxed: boolean): void {
    if (this.shadowRelaxed === relaxed) return
    this.shadowRelaxed = relaxed
    if (this.disposed) return
    if (relaxed) {
      if (this.keyLight && this.savedShadowSize > 0) {
        this.keyLight.shadow.mapSize.set(this.savedShadowSize, this.savedShadowSize)
        this.keyLight.shadow.map?.dispose()
        this.keyLight.shadow.map = null
        this.keyLight = null
        this.savedShadowSize = 0
        this.ctx.renderer.shadowMap.needsUpdate = true
      }
    } else if (this.active) {
      // re-bump for Enhanced proper (idempotent via the mapSize guard)
      const size = enhancedShadowMapSize(this.ctx.caps)
      const key = this.findKeyLight()
      if (key && key.shadow.mapSize.x < size) {
        this.keyLight = key
        this.savedShadowSize = key.shadow.mapSize.x
        key.shadow.mapSize.set(size, size)
        key.shadow.map?.dispose()
        key.shadow.map = null
        this.ctx.renderer.shadowMap.needsUpdate = true
      }
    }
  }

  /** Restore the displaced environment + shadow budget. Idempotent. */
  deactivate(): void {
    if (!this.active) return
    this.active = false

    const { scene } = this.ctx
    if (this.envTexture && scene.environment === this.envTexture) {
      scene.environment = this.savedEnvironment
      if (this.savedEnvIntensity !== null) scene.environmentIntensity = this.savedEnvIntensity
    }
    this.savedEnvironment = null
    this.savedEnvIntensity = null

    if (this.keyLight && this.savedShadowSize > 0) {
      this.keyLight.shadow.mapSize.set(this.savedShadowSize, this.savedShadowSize)
      this.keyLight.shadow.map?.dispose()
      this.keyLight.shadow.map = null
      this.ctx.renderer.shadowMap.needsUpdate = true
    }
    this.keyLight = null
    this.savedShadowSize = 0

    // Hand the GPU memory back while another mode owns the frame: the
    // composer's HalfFloat ping-pong targets + the AO/blur/normal targets +
    // the bloom mip chain are ~100 MB at a 5.2 MP retina canvas. A disposed
    // WebGLRenderTarget re-allocates lazily the next time it is rendered to,
    // so re-activating just pays a one-time re-alloc, not a rebuild.
    this.composer.renderTarget1.dispose()
    this.composer.renderTarget2.dispose()
    this.saoPass.saoRenderTarget.dispose()
    this.saoPass.blurIntermediateRenderTarget.dispose()
    this.saoPass.normalRenderTarget.dispose()
    this.bloomPass.renderTargetBright.dispose()
    for (const t of this.bloomPass.renderTargetsHorizontal) t.dispose()
    for (const t of this.bloomPass.renderTargetsVertical) t.dispose()
  }

  /**
   * Scene-graph contents changed (manager.invalidate, geometry kind) — the
   * SAO pre-pass skip cache re-collects on the next frame. Objects added
   * WITHOUT an invalidate (transient hover FX) simply stay in the pre-pass,
   * which is the conservative/correct default.
   */
  invalidate(): void {
    this.prepassDirty = true
  }

  /**
   * Collect the meshes the SAO normal/depth pre-pass can skip: transparent /
   * non-depth-writing materials (glow shells, labels, the flush board decal —
   * the override material would imprint them fully opaque) and meshes whose
   * world bounding sphere is below SAO_PREPASS_MIN_RADIUS (wire end caps, tip
   * pins, band rings — flush against a larger surface at the same depth).
   * Saves hundreds of pre-pass draw calls per frame on dense boards.
   */
  private collectPrepassSkips(): void {
    this.prepassDirty = false
    const skips = this.prepassSkips
    skips.length = 0
    this.ctx.scene.traverse((o) => {
      const mesh = o as THREE.Mesh
      if (!mesh.isMesh || (mesh as unknown as THREE.InstancedMesh).isInstancedMesh) return
      const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material]
      let skip = false
      for (const m of mats) {
        if (m && (m.transparent === true || m.depthWrite === false)) skip = true
      }
      if (!skip) {
        const geo = mesh.geometry
        if (geo.boundingSphere === null) geo.computeBoundingSphere()
        const sphere = geo.boundingSphere
        if (sphere && isFinite(sphere.radius)) {
          skip = sphere.radius * mesh.matrixWorld.getMaxScaleOnAxis() < SAO_PREPASS_MIN_RADIUS
        }
      }
      if (skip) skips.push(mesh)
    })
    this.saoPass.setPrepassSkips(skips)
  }

  /** Draw one composed frame. No steady-state per-frame allocations. */
  render(): void {
    if (this.prepassDirty) this.collectPrepassSkips()
    this.composer.render()
  }

  setSize(width: number, height: number): void {
    this.composer.setPixelRatio(this.ctx.renderer.getPixelRatio())
    this.composer.setSize(width, height)
  }

  dispose(): void {
    if (this.disposed) return
    this.deactivate()
    this.disposed = true
    // EffectComposer.dispose only frees its own targets — passes are ours
    this.renderPass.dispose()
    this.saoPass.dispose()
    this.bloomPass.dispose()
    this.outputPass.dispose()
    this.smaaPass.dispose()
    this.composer.dispose()
    this.envTexture?.dispose()
    this.envTexture = null
  }
}
