/**
 * Pooled touchdown dust FX for the board grow/remove animations (scene.ts).
 *
 * A tiny, SUBLIMINAL puff: 10–14 soft warm-gray sprites burst radially
 * outward from the perimeter of the landed slab's base, expanding and fading
 * over ~420ms with a slight upward drift. Additive-soft (low peak opacity on
 * additive blending) so it reads as displaced dust catching the key light,
 * never a cartoon explosion.
 *
 * Perf rules (the 120fps budget is untouchable):
 *  - ONE fixed pool of sprites + materials + one shared CanvasTexture, built
 *    at mount and reused for every burst — nothing allocates per burst or
 *    per frame (tick() is pure number writes off preallocated arrays).
 *  - tick() early-returns when no sprite is live; the caller additionally
 *    gates on `live`. The scene's rAF loop pauses while the tab is hidden,
 *    and the scene never starts a burst on a hidden tab.
 *  - Sprites never cast/receive shadows and are flagged `bbNoStudio` (UI-
 *    grade FX — excluded from path-traced stills, composited raster-side).
 *
 * Headless-safe: without a DOM (node tests) the texture degrades away and
 * burst() becomes a no-op.
 */

import * as THREE from 'three'

/** pool size = the largest spawn burst (removal puffs use fewer) */
const POOL_SIZE = 14
/** puff lifetime (ms) — expansion + fade */
const PUFF_MS = 420
/** peak sprite opacity (additive — keep faint) */
const PEAK_OPACITY = 0.2
/** outward speed (plan units / s) and upward drift (units / s) */
const OUT_SPEED = 3.2
const UP_SPEED = 1.1
/** sprite scale: start → growth multiple over the lifetime */
const START_SCALE = 1.05
const GROW = 1.9

/** plan rect of a slab base — the burst rings its perimeter */
export interface PuffRect {
  minX: number
  maxX: number
  minZ: number
  maxZ: number
}

/** soft radial dust blob (white core → transparent), tinted by the material */
function makeDustTexture(): THREE.CanvasTexture | null {
  if (typeof document === 'undefined') return null
  const size = 64
  const canvas = document.createElement('canvas')
  canvas.width = size
  canvas.height = size
  const ctx = canvas.getContext('2d')
  if (!ctx) return null
  const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2)
  g.addColorStop(0, 'rgba(255,255,255,0.85)')
  g.addColorStop(0.45, 'rgba(255,255,255,0.32)')
  g.addColorStop(1, 'rgba(255,255,255,0)')
  ctx.fillStyle = g
  ctx.fillRect(0, 0, size, size)
  const tex = new THREE.CanvasTexture(canvas)
  tex.colorSpace = THREE.SRGBColorSpace
  return tex
}

export class SpawnFX {
  /** add to the scene once; all sprites live inside */
  readonly group: THREE.Group
  private readonly sprites: THREE.Sprite[] = []
  private readonly mats: THREE.SpriteMaterial[] = []
  private readonly tex: THREE.CanvasTexture | null
  // per-sprite state (parallel arrays — no allocation after construction)
  private readonly born = new Float64Array(POOL_SIZE) // 0 = free
  private readonly ox = new Float64Array(POOL_SIZE)
  private readonly oz = new Float64Array(POOL_SIZE)
  private readonly vx = new Float64Array(POOL_SIZE)
  private readonly vy = new Float64Array(POOL_SIZE)
  private readonly vz = new Float64Array(POOL_SIZE)
  private readonly size0 = new Float64Array(POOL_SIZE)
  private liveCount = 0

  constructor() {
    this.group = new THREE.Group()
    this.group.name = 'spawn-dust'
    // UI-grade FX: never in a Studio still (composited raster-side like the
    // paddles); never a shadow caster
    this.group.userData.bbNoStudio = true
    this.tex = makeDustTexture()
    for (let i = 0; i < POOL_SIZE; i++) {
      const mat = new THREE.SpriteMaterial({
        map: this.tex ?? undefined,
        color: 0xcfc8ba, // warm board-dust gray
        transparent: true,
        opacity: 0,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      })
      const sprite = new THREE.Sprite(mat)
      sprite.visible = false
      sprite.renderOrder = 3
      this.mats.push(mat)
      this.sprites.push(sprite)
      this.group.add(sprite)
    }
  }

  /** any sprite mid-puff? (lets the scene skip tick() entirely when idle) */
  get live(): boolean {
    return this.liveCount > 0
  }

  /**
   * Fire one puff around `rect`'s perimeter at board level. `count` clamps
   * to the pool (free slots are recycled oldest-first); `scale` shrinks the
   * whole effect for the removal variant. No-op headless. The caller is
   * responsible for reduced-motion / hidden-tab gating.
   */
  burst(rect: PuffRect, now: number, count = 12, scale = 1): void {
    if (!this.tex) return
    const n = Math.min(POOL_SIZE, count)
    const w = rect.maxX - rect.minX
    const d = rect.maxZ - rect.minZ
    const perim = Math.max(0.001, 2 * (w + d))
    const phase = Math.random()
    for (let k = 0; k < n; k++) {
      const i = this.takeSlot()
      // walk the rect perimeter at even spacing + jitter
      let s = ((k + phase + (Math.random() - 0.5) * 0.4) / n) * perim
      s = ((s % perim) + perim) % perim
      let px: number
      let pz: number
      let nx: number
      let nz: number
      if (s < w) {
        px = rect.minX + s
        pz = rect.minZ
        nx = 0
        nz = -1
      } else if (s < w + d) {
        px = rect.maxX
        pz = rect.minZ + (s - w)
        nx = 1
        nz = 0
      } else if (s < w + d + w) {
        px = rect.maxX - (s - w - d)
        pz = rect.maxZ
        nx = 0
        nz = 1
      } else {
        px = rect.minX
        pz = rect.maxZ - (s - w - d - w)
        nx = -1
        nz = 0
      }
      // outward + a touch of tangential shear, slight upward drift
      const out = OUT_SPEED * scale * (0.7 + Math.random() * 0.6)
      const shear = OUT_SPEED * 0.35 * (Math.random() - 0.5)
      this.born[i] = now
      this.ox[i] = px + nx * 0.2
      this.oz[i] = pz + nz * 0.2
      this.vx[i] = nx * out - nz * shear
      this.vz[i] = nz * out + nx * shear
      this.vy[i] = UP_SPEED * scale * (0.6 + Math.random() * 0.8)
      this.size0[i] = START_SCALE * scale * (0.8 + Math.random() * 0.5)
      const sprite = this.sprites[i]
      sprite.position.set(this.ox[i], 0.12, this.oz[i])
      sprite.scale.setScalar(this.size0[i])
      this.mats[i].opacity = 0
      sprite.visible = true
    }
  }

  /** oldest-live slot when the pool is exhausted, else any free slot */
  private takeSlot(): number {
    let oldest = 0
    let oldestBorn = Infinity
    for (let i = 0; i < POOL_SIZE; i++) {
      if (this.born[i] === 0) {
        this.liveCount++
        return i
      }
      if (this.born[i] < oldestBorn) {
        oldestBorn = this.born[i]
        oldest = i
      }
    }
    return oldest // recycled — liveCount unchanged
  }

  /** advance every live sprite (transform/opacity number writes only) */
  tick(now: number): void {
    if (this.liveCount === 0) return
    for (let i = 0; i < POOL_SIZE; i++) {
      if (this.born[i] === 0) continue
      const t = (now - this.born[i]) / PUFF_MS
      if (t >= 1) {
        this.born[i] = 0
        this.sprites[i].visible = false
        this.mats[i].opacity = 0
        this.liveCount--
        continue
      }
      // decelerating outward travel; parametric in t (frame-rate independent)
      const travel = t * (1 - 0.38 * t) * (PUFF_MS / 1000)
      const sprite = this.sprites[i]
      sprite.position.set(
        this.ox[i] + this.vx[i] * travel,
        0.12 + this.vy[i] * travel,
        this.oz[i] + this.vz[i] * travel,
      )
      sprite.scale.setScalar(this.size0[i] * (1 + GROW * t))
      // quick fade-in (first ~12%), smooth fade-out
      const fadeIn = t < 0.12 ? t / 0.12 : 1
      const fadeOut = (1 - t) * (1 - t)
      this.mats[i].opacity = PEAK_OPACITY * fadeIn * fadeOut * (2 - fadeOut)
    }
  }

  /** drop every live sprite immediately (board rebuild mid-puff) */
  reset(): void {
    if (this.liveCount === 0) return
    for (let i = 0; i < POOL_SIZE; i++) {
      this.born[i] = 0
      this.sprites[i].visible = false
      this.mats[i].opacity = 0
    }
    this.liveCount = 0
  }

  dispose(): void {
    for (const m of this.mats) m.dispose()
    this.tex?.dispose()
    this.group.clear()
  }
}
