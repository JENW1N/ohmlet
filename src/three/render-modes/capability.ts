/**
 * Render-mode capability + selection logic — PURE, node-testable.
 *
 * No three.js (or DOM) imports here: the manager probes the real renderer /
 * window and feeds a `RenderCaps` snapshot into these helpers, so every
 * decision (default mode, persisted-override fallback, studio render scale,
 * shadow budget) is unit-tested without a GPU.
 */

export type RenderModeId = 'performance' | 'enhanced' | 'studio'

export const RENDER_MODE_IDS: readonly RenderModeId[] = [
  'performance',
  'enhanced',
  'studio',
] as const

/** Metadata for the mode-picker UI (labels/descriptions are user-facing). */
export interface RenderModeMeta {
  readonly id: RenderModeId
  readonly label: string
  readonly description: string
  /** Short qualifier the picker can render as a trailing badge. */
  readonly badge: string
}

export const RENDER_MODES: Record<RenderModeId, RenderModeMeta> = {
  performance: {
    id: 'performance',
    label: 'Performance',
    description: 'Fastest. The classic raster pipeline — best battery life and the default on phones.',
    badge: 'fast',
  },
  enhanced: {
    id: 'enhanced',
    label: 'Enhanced',
    description: 'Studio HDRI lighting, ambient occlusion, subtle bloom and anti-aliasing. The desktop default.',
    badge: 'balanced',
  },
  studio: {
    id: 'studio',
    label: 'Studio',
    description: 'Progressive ray tracing for product-photo stills. Converges while the camera is idle; falls back to Enhanced while you move.',
    badge: 'ray traced',
  },
}

/** Snapshot of what the device can actually do (probed once by the manager). */
export interface RenderCaps {
  /** WebGL2 context (required by the composer HDR targets and the path tracer). */
  webgl2: boolean
  /** EXT_color_buffer_float — render-to-float targets (composer + path tracer accumulation). */
  floatTargets: boolean
  /** OES_texture_float_linear — linear sampling of float textures (path tracer env/BVH textures). */
  floatLinear: boolean
  /** Coarse primary pointer (touch) — treat as a phone/tablet. */
  coarsePointer: boolean
}

/** A fully capable desktop, useful as a test baseline / SSR-safe default. */
export const FULL_CAPS: RenderCaps = {
  webgl2: true,
  floatTargets: true,
  floatLinear: true,
  coarsePointer: false,
}

export function isPhoneLike(caps: RenderCaps): boolean {
  return caps.coarsePointer
}

/** Can `mode` run on this device at all? */
export function supportsMode(mode: RenderModeId, caps: RenderCaps): boolean {
  switch (mode) {
    case 'performance':
      return true
    case 'enhanced':
      return caps.webgl2 && caps.floatTargets
    case 'studio':
      return caps.webgl2 && caps.floatTargets && caps.floatLinear
  }
}

/** Picker-ordered list of the modes this device supports. */
export function supportedModes(caps: RenderCaps): RenderModeId[] {
  return RENDER_MODE_IDS.filter((m) => supportsMode(m, caps))
}

/** Device auto-select default: phone → performance, desktop → enhanced. */
export function defaultMode(caps: RenderCaps): RenderModeId {
  if (isPhoneLike(caps)) return 'performance'
  return supportsMode('enhanced', caps) ? 'enhanced' : 'performance'
}

/**
 * Resolve the boot mode: a persisted, *supported* override wins (an explicit
 * user choice beats the device default — e.g. Studio on an iPad); anything
 * unknown or unsupported falls back to the device default.
 */
export function resolveMode(stored: string | null | undefined, caps: RenderCaps): RenderModeId {
  if (stored && (RENDER_MODE_IDS as readonly string[]).includes(stored)) {
    const mode = stored as RenderModeId
    if (supportsMode(mode, caps)) return mode
  }
  return defaultMode(caps)
}

// ------------------------------------------------------------- persistence

export const RENDER_MODE_STORAGE_KEY = 'bb.renderMode'

/** The slice of the Storage API we use (lets tests pass a Map-backed fake). */
export interface StorageLike {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

/** Read the persisted override; never throws (private mode, quota, no DOM). */
export function readStoredMode(storage: StorageLike | null | undefined): string | null {
  if (!storage) return null
  try {
    return storage.getItem(RENDER_MODE_STORAGE_KEY)
  } catch {
    return null
  }
}

/** Persist the override; never throws. */
export function writeStoredMode(storage: StorageLike | null | undefined, mode: RenderModeId): void {
  if (!storage) return
  try {
    storage.setItem(RENDER_MODE_STORAGE_KEY, mode)
  } catch {
    /* private mode / quota — the choice just won't persist */
  }
}

// ----------------------------------------------------------------- budgets

/**
 * Absolute pixel budget for the path tracer's internal resolution. The
 * accumulation pipeline allocates THREE full-float RGBA targets at the
 * internal size, and the per-sample kernel cost scales linearly with it — at
 * a 5.2 MP retina canvas (1440×900 css @ pixelRatio 2) the measured result
 * on an M4 Pro was a 4/4-reproducible CHROMIUM GPU-PROCESS CRASH during
 * convergence (Metal watchdog/memory), while the identical run converges
 * fine at 1.3 MP. ~2.6 MP traces a retina canvas at ~0.71× — the still is
 * re-blitted through a linear-filtered fullscreen quad either way, and the
 * converged A/B against a 1× still passed the modes-harness look gate.
 */
export const STUDIO_PIXEL_BUDGET = 2_600_000

/**
 * Studio internal resolution factor: device-class base (full res desktop,
 * 0.75× phones), additionally clamped so the traced pixel count never
 * exceeds STUDIO_PIXEL_BUDGET when the caller passes the canvas's drawing-
 * buffer pixel count (width × height, physical pixels).
 */
export function studioRenderScale(caps: RenderCaps, drawingBufferPixels = 0): number {
  const base = isPhoneLike(caps) ? 0.75 : 1
  if (drawingBufferPixels <= 0) return base
  return Math.min(base, Math.sqrt(STUDIO_PIXEL_BUDGET / drawingBufferPixels))
}

/**
 * Enhanced-mode shadow map size. Desktop gets the 4096 hero map; phones keep
 * the base 2048 (it is still the single on-demand map either way).
 */
export function enhancedShadowMapSize(caps: RenderCaps): number {
  return isPhoneLike(caps) ? 2048 : 4096
}

/**
 * Per-rAF path-trace burst budget (pixels traced per tile). One renderSample
 * call traces exactly ONE tile; the Phase D profile measured ~0.33 MP bursts
 * (1.3 MP canvas / 2×2 tiles) at up to ~50 ms on an M4 Pro during
 * re-convergence — and the first 360 k budget left re-convergence p95 at
 * ~33 ms / max ~50 ms (perf/after-modes.md idle1), i.e. the felt stutter
 * after a camera settle was unchanged. Halved to 180 k so the steady
 * re-convergence burst is ~2× smaller (desktop @1x: 2×2 @ 324 k/tile →
 * 3×3 @ 144 k/tile; retina-clamped 2.6 MP: 3×3 → 4×4 @ 162 k/tile; phones
 * unchanged at 3×3). Cost: more rAF frames per full sample, so convergence
 * wall-time stretches (same total GPU work + per-frame overhead) — the
 * converged still is identical (same samples, same resolution).
 */
export const STUDIO_TILE_PIXEL_BUDGET = 180_000

/**
 * Path-tracer tiling — how many tiles each frame's sample pass is split into
 * per axis. More tiles = smaller GPU bursts = a more responsive main thread
 * (at the cost of slower convergence wall-time). The device-class base
 * (phones tile finer) is raised when the traced pixel count would push a
 * single tile past STUDIO_TILE_PIXEL_BUDGET.
 */
export function studioTiles(caps: RenderCaps, tracedPixels = 0): number {
  const base = isPhoneLike(caps) ? 3 : 2
  if (tracedPixels <= 0) return base
  return Math.max(base, Math.ceil(Math.sqrt(tracedPixels / STUDIO_TILE_PIXEL_BUDGET)))
}

/**
 * Tile ladder for convergence (re)starts: the first samples after the camera
 * settles land while the user may immediately re-grab the orbit — trace them
 * in extra-fine bursts, then relax to the steady tiling for convergence
 * wall-time. (Profile: re-convergence after a settle averaged 82 fps with 26
 * frames >33 ms at 1.3 MP / 2×2 tiles; the ladder spreads those first
 * full-cost tiles across more, lighter frames at a ~3% total-time cost.)
 */
export function studioRestartTiles(baseTiles: number, samples: number): number {
  if (samples < 2) return baseTiles + 2
  if (samples < 6) return baseTiles + 1
  return baseTiles
}

/** Samples-per-pixel at which Studio declares the still converged. */
export function studioTargetSamples(caps: RenderCaps): number {
  return isPhoneLike(caps) ? 120 : 320
}
