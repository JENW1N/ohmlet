/**
 * RenderModeManager — Performance / Enhanced / Studio render-mode engine.
 *
 * ── Integrator contract (scene.ts) ──────────────────────────────────────────
 *
 *   const modes = new RenderModeManager()
 *
 *   // in mount(), once renderer/scene/camera exist:
 *   modes.init(renderer, scene, camera)
 *
 *   // in the rAF loop, REPLACING the unconditional plain render call:
 *   if (!modes.render(dt)) renderer.render(scene, camera)
 *   // render() returns true iff the manager drew this frame. In Performance
 *   // mode it always returns false — the existing plain renderer.render path
 *   // runs untouched, at zero added cost. It also returns false for the few
 *   // frames a lazily-loaded pipeline is still arriving.
 *
 *   // camera interaction (OrbitControls 'start'/'end', camera tweens):
 *   controls.addEventListener('start', () => modes.onInteractionStart())
 *   controls.addEventListener('end',   () => modes.onInteractionEnd())
 *   // Studio falls back to the Enhanced raster while interacting and
 *   // re-converges when the camera is still. (A built-in camera-matrix guard
 *   // also catches damping tails / tweens that miss the events.)
 *
 *   // scene-graph changes (syncLayout, board rebuild, wires, ghost commits):
 *   modes.invalidate()             // Studio rebuilds its BVH lazily on idle
 *   modes.invalidate('materials')  // cheap path for telemetry-only visual
 *                                  // changes (LED emissive) — no BVH rebuild
 *
 *   // container resize (CSS pixels, after renderer.setSize):
 *   modes.setSize(width, height)
 *
 *   // UI: modes.mode, modes.supported, RENDER_MODES metadata,
 *   modes.setMode('studio')        // persists to localStorage 'bb.renderMode'
 *   const off = modes.on('modechange', (e) => ...)
 *   modes.on('progress', (p) => ...) // Studio spp progress — payload REUSED,
 *                                    // copy if you keep it
 *
 *   // in dispose():
 *   modes.dispose()
 *
 * ── Laziness ────────────────────────────────────────────────────────────────
 * Both pipelines are dynamic imports: Performance users download neither;
 * three-gpu-pathtracer (Studio) is its own chunk and is only fetched when
 * Studio is first selected. Leaving Studio disposes its GPU buffers (BVH +
 * accumulation targets are big); re-entering rebuilds and re-converges.
 */
import type * as THREE from 'three'
import {
  defaultMode,
  resolveMode,
  supportedModes,
  readStoredMode,
  writeStoredMode,
  FULL_CAPS,
  type RenderCaps,
  type RenderModeId,
  type StorageLike,
} from './capability'
import type { RenderContext, RenderModeEvents, StudioProgress } from './types'
import type { EnhancedPipeline } from './enhanced'
import type { StudioPipeline } from './studio'

export type { RenderModeId, RenderCaps } from './capability'
export {
  RENDER_MODES,
  RENDER_MODE_IDS,
  RENDER_MODE_STORAGE_KEY,
  supportedModes,
  defaultMode,
  resolveMode,
} from './capability'
export type { RenderModeEvents, StudioProgress, ModeChangeEvent } from './types'

function safeLocalStorage(): StorageLike | null {
  try {
    return typeof localStorage !== 'undefined' ? localStorage : null
  } catch {
    return null // privacy mode / sandboxed iframe can throw on access
  }
}

/** Probe the real renderer + window once. */
function detectCaps(renderer: THREE.WebGLRenderer): RenderCaps {
  let coarse = false
  try {
    coarse = typeof matchMedia !== 'undefined' && matchMedia('(pointer: coarse)').matches
  } catch {
    coarse = false
  }
  return {
    webgl2: renderer.capabilities.isWebGL2,
    floatTargets: renderer.extensions.has('EXT_color_buffer_float'),
    floatLinear: renderer.extensions.has('OES_texture_float_linear'),
    coarsePointer: coarse,
  }
}

type Listener<K extends keyof RenderModeEvents> = (e: RenderModeEvents[K]) => void

export class RenderModeManager {
  private ctx: RenderContext | null = null
  private caps: RenderCaps = FULL_CAPS
  private current: RenderModeId = 'performance'

  private enhanced: EnhancedPipeline | null = null
  private enhancedLoading: Promise<EnhancedPipeline | null> | null = null
  private studio: StudioPipeline | null = null
  private studioLoading: Promise<void> | null = null

  private interactionDepth = 0
  /** did the most recent render() present the path-traced canvas? */
  private lastFramePathTraced = false
  /** webglcontextlost guard (Studio's converging kernel is the realistic trigger) */
  private contextLostListener: ((e: Event) => void) | null = null
  private readonly listeners = {
    modechange: new Set<Listener<'modechange'>>(),
    progress: new Set<Listener<'progress'>>(),
  }
  // reused payload for the pre-pipeline 'loading' phase
  private readonly loadingProgress: StudioProgress = {
    phase: 'loading',
    samples: 0,
    targetSamples: 0,
    converged: false,
  }

  // ---------------------------------------------------------------- public

  /** Requested mode (what the picker shows). */
  get mode(): RenderModeId {
    return this.current
  }

  /** Modes this device supports, picker-ordered. */
  get supported(): RenderModeId[] {
    return this.ctx ? supportedModes(this.caps) : ['performance']
  }

  /** Device capability snapshot (valid after init). */
  get capabilities(): RenderCaps {
    return this.caps
  }

  /**
   * True iff the most recent render() presented the PATH-TRACED canvas
   * (Studio sampling, or holding/re-blitting a converged still). The scene
   * integrator composites its raster overlays (holograms, hover FX,
   * selection boxes) on top of such frames — Enhanced(-fallback) frames
   * already include the overlays via the composer's RenderPass, so
   * compositing again would double-draw them.
   */
  get pathTracedFrame(): boolean {
    return this.lastFramePathTraced
  }

  /**
   * Hook up to a live renderer/scene/camera. Resolves the boot mode from the
   * persisted 'bb.renderMode' override, clamped to device capability
   * (phone → performance, desktop → enhanced by default).
   */
  init(
    renderer: THREE.WebGLRenderer,
    scene: THREE.Scene,
    camera: THREE.PerspectiveCamera,
  ): void {
    if (this.ctx) this.dispose()
    this.caps = detectCaps(renderer)
    this.ctx = { renderer, scene, camera, caps: this.caps }
    this.current = resolveMode(readStoredMode(safeLocalStorage()), this.caps)
    // A lost GL context while Studio's path-tracing kernel is converging
    // (Metal watchdog / memory pressure) must NOT strand the user on a dead
    // canvas: preventDefault() lets the browser restore the context, and the
    // session falls back to Enhanced (the persisted preference is kept, so
    // Studio returns on the next launch). Raster pipelines rebuild their GPU
    // state lazily after 'webglcontextrestored' — no further action needed.
    this.contextLostListener = (e: Event) => {
      e.preventDefault()
      if (this.current === 'studio') {
        console.warn('[render-modes] WebGL context lost — falling back to Enhanced for this session')
        this.switchTo('enhanced', false)
      }
    }
    renderer.domElement.addEventListener('webglcontextlost', this.contextLostListener)
    this.applyMode()
  }

  /** Switch modes; persists the user's choice. Emits 'modechange'. */
  setMode(mode: RenderModeId): void {
    this.switchTo(resolveMode(mode, this.caps), true)
  }

  /**
   * Draw one frame if the active mode owns drawing.
   * @returns true if the manager drew — false means "do the plain
   *          renderer.render(scene, camera) yourself" (Performance mode,
   *          pre-init, or a pipeline still loading).
   */
  render(_dt: number): boolean {
    this.lastFramePathTraced = false
    const ctx = this.ctx
    if (!ctx) return false

    switch (this.current) {
      case 'performance':
        return false // zero-cost delegate to the caller's plain render

      case 'enhanced':
        return this.renderEnhanced()

      case 'studio': {
        if (this.interactionDepth > 0) return this.renderEnhanced()
        const studio = this.studio
        if (!studio) return this.renderEnhanced() // chunk still loading
        if (studio.render()) {
          this.lastFramePathTraced = true
          return true
        }
        return this.renderEnhanced() // building / camera settling
      }
    }
  }

  /** Camera interaction began (orbit drag, pinch, programmatic tween). */
  onInteractionStart(): void {
    this.interactionDepth++
  }

  /** Camera interaction ended; Studio re-converges once the camera is still. */
  onInteractionEnd(): void {
    if (this.interactionDepth > 0) this.interactionDepth--
  }

  /**
   * Scene changed. 'geometry' (default): Studio lazily rebuilds its BVH on
   * the next idle frame. 'materials': cheap uniform refresh only (LED
   * emissive / telemetry tints). Enhanced needs nothing — it redraws every
   * frame anyway.
   */
  invalidate(kind: 'geometry' | 'materials' = 'geometry'): void {
    // Enhanced keeps a skip cache for its SAO pre-pass — geometry changes
    // re-collect it (materials-only changes can't alter what exists)
    if (kind === 'geometry') this.enhanced?.invalidate()
    if (!this.studio) return
    if (kind === 'materials') this.studio.refreshMaterials()
    else this.studio.invalidate()
  }

  /** Call after the renderer resizes (CSS pixel size). */
  setSize(width: number, height: number): void {
    this.enhanced?.setSize(width, height)
    // Studio tracks the canvas size itself (synchronizeRenderSize)
  }

  /** Subscribe; returns the unsubscribe function. */
  on<K extends keyof RenderModeEvents>(type: K, fn: Listener<K>): () => void {
    const set = this.listeners[type] as Set<Listener<K>>
    set.add(fn)
    return () => set.delete(fn)
  }

  dispose(): void {
    if (this.ctx && this.contextLostListener) {
      this.ctx.renderer.domElement.removeEventListener('webglcontextlost', this.contextLostListener)
    }
    this.contextLostListener = null
    this.studio?.dispose()
    this.studio = null
    this.studioLoading = null
    this.enhanced?.dispose()
    this.enhanced = null
    this.enhancedLoading = null
    this.ctx = null
    this.interactionDepth = 0
    this.lastFramePathTraced = false
  }

  // --------------------------------------------------------------- internal

  private emit<K extends keyof RenderModeEvents>(type: K, e: RenderModeEvents[K]): void {
    for (const fn of this.listeners[type] as Set<Listener<K>>) fn(e)
  }

  private switchTo(mode: RenderModeId, persist: boolean): void {
    if (persist) writeStoredMode(safeLocalStorage(), mode)
    if (mode === this.current) return
    const previous = this.current
    this.current = mode
    this.applyMode()
    this.emit('modechange', { mode, previous })
  }

  /** Activate/deactivate pipelines for the current mode. */
  private applyMode(): void {
    if (!this.ctx) return
    if (this.current === 'performance') {
      this.enhanced?.deactivate()
    } else if (this.enhanced) {
      // RE-entering after a deactivate: the load path below only activates on
      // first construction. Without this, a performance → enhanced/studio
      // round trip kept the RoomEnvironment PMREM in place (visibly degraded
      // Enhanced, and Studio's env preprocessing requires the equirect HDR's
      // CPU data — its BVH build died on the render-target texture).
      this.enhanced.activate()
    } else {
      void this.ensureEnhanced()
    }
    if (this.current === 'studio') {
      void this.ensureStudio()
    } else if (this.studio || this.studioLoading) {
      // leaving Studio: free the BVH/accumulation GPU memory
      this.studio?.dispose()
      this.studio = null
      this.studioLoading = null
    }
  }

  private renderEnhanced(): boolean {
    if (!this.enhanced) return false // still loading — caller plain-renders
    this.enhanced.render()
    return true
  }

  private ensureEnhanced(): Promise<EnhancedPipeline | null> {
    if (this.enhanced) return Promise.resolve(this.enhanced)
    if (this.enhancedLoading) return this.enhancedLoading
    const ctx = this.ctx
    if (!ctx) return Promise.resolve(null)
    this.enhancedLoading = import('./enhanced').then(
      (mod) => {
        this.enhancedLoading = null
        if (this.ctx !== ctx) return null // disposed/re-inited meanwhile
        this.enhanced = new mod.EnhancedPipeline(ctx)
        if (this.current !== 'performance') this.enhanced.activate()
        return this.enhanced
      },
      (err) => {
        this.enhancedLoading = null
        console.warn('[render-modes] enhanced pipeline failed to load', err)
        if (this.ctx === ctx && this.current !== 'performance') {
          this.switchTo('performance', false) // session fallback, keep choice
        }
        return null
      },
    )
    return this.enhancedLoading
  }

  private ensureStudio(): Promise<void> {
    if (this.studio) return Promise.resolve()
    if (this.studioLoading) return this.studioLoading
    const ctx = this.ctx
    if (!ctx) return Promise.resolve()
    this.emit('progress', this.loadingProgress)
    // Studio leans on Enhanced for its raster fallback + HDRI environment,
    // so that pipeline loads first; three-gpu-pathtracer stays a separate
    // lazy chunk fetched only here.
    this.studioLoading = this.ensureEnhanced()
      .then((enhanced) => {
        if (!enhanced || this.ctx !== ctx || this.current !== 'studio') return
        return import('./studio').then((mod) =>
          mod
            .createStudioPipeline(ctx, enhanced, (p) => this.emit('progress', p))
            .then((studio) => {
              if (this.ctx !== ctx || this.current !== 'studio') {
                studio.dispose()
                return
              }
              this.studio = studio
            }),
        )
      })
      .catch((err) => {
        console.warn('[render-modes] studio pipeline failed to load', err)
        if (this.ctx === ctx && this.current === 'studio') {
          this.switchTo('enhanced', false) // session fallback, keep choice
        }
      })
      .finally(() => {
        this.studioLoading = null
      })
    return this.studioLoading
  }
}
