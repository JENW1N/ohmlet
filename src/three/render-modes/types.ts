/**
 * Shared types for the render-mode engine (manager ⇄ mode pipelines).
 *
 * Kept three.js-type-only so importing this module never drags renderer code
 * into a chunk by accident.
 */
import type * as THREE from 'three'
import type { RenderCaps, RenderModeId } from './capability'

/** Everything a mode pipeline needs from the host scene. */
export interface RenderContext {
  renderer: THREE.WebGLRenderer
  scene: THREE.Scene
  camera: THREE.PerspectiveCamera
  caps: RenderCaps
}

/** Studio convergence progress — surfaced to the UI via the 'progress' event. */
export interface StudioProgress {
  /**
   * 'loading'   — the path-tracer chunk is being fetched (first entry only)
   * 'building'  — the scene BVH is being (re)built
   * 'sampling'  — progressive accumulation in flight
   * 'converged' — target samples reached; the still is done
   */
  phase: 'loading' | 'building' | 'sampling' | 'converged'
  /** Accumulated samples per pixel (0 while loading/building). */
  samples: number
  /** Samples-per-pixel goal for a converged still. */
  targetSamples: number
  converged: boolean
}

export interface ModeChangeEvent {
  mode: RenderModeId
  previous: RenderModeId
}

/** Event map for RenderModeManager.on(). */
export interface RenderModeEvents {
  /** The *requested* mode changed (setMode / init resolution). */
  modechange: ModeChangeEvent
  /**
   * Studio status for the UI (spp counter / "building…" spinner).
   * NOTE: the payload object is REUSED between emits — copy it if you keep it.
   */
  progress: StudioProgress
}
