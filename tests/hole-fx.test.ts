/**
 * Hover-ring motion — the binding DESIGN.md §4 spec (user-tuned):
 *  - appear pop ~0.6 → ~1.12 → settle 1.0 on the house spring, ≤ 220ms
 *  - one-shot squash-and-stretch on landing (a hair wider than tall)
 *  - hopping between adjacent holes retriggers a smaller pop (~1.06)
 *  - on leave: quick fade, NO scale animation
 *  - reduced motion: crossfade only
 */
import { describe, expect, it } from 'vitest'
import type * as THREE from 'three'
import { makeHoverRing } from '../src/three/internal/hole-fx'

const STEP = 0.002 // 2ms sampling — far finer than any pop keyframe

function meshOf(ring: ReturnType<typeof makeHoverRing>): THREE.Mesh {
  return ring.object as THREE.Mesh
}

function fadeOf(ring: ReturnType<typeof makeHoverRing>): number {
  const mat = meshOf(ring).material as THREE.ShaderMaterial
  return mat.uniforms.uFade.value as number
}

/** Tick from t0 to t1, returning the max plan (x) scale seen. */
function maxPlanScale(
  ring: ReturnType<typeof makeHoverRing>,
  t0: number,
  t1: number,
): number {
  let max = -Infinity
  for (let t = t0; t <= t1 + 1e-9; t += STEP) {
    ring.tick(t)
    max = Math.max(max, meshOf(ring).scale.x)
  }
  return max
}

describe('hover ring §4 motion', () => {
  it('appear pop starts small, overshoots to ~1.12 and settles at exactly 1 within 220ms', () => {
    const ring = makeHoverRing()
    ring.show(0)
    ring.tick(0)
    expect(meshOf(ring).scale.x).toBeLessThan(0.75) // starts near 0.6
    const peak = maxPlanScale(ring, STEP, 0.22)
    expect(peak).toBeGreaterThan(1.08) // springy overshoot ~1.12
    expect(peak).toBeLessThan(1.18)
    ring.tick(0.25)
    expect(meshOf(ring).scale.x).toBe(1)
    expect(meshOf(ring).scale.y).toBe(1)
    expect(meshOf(ring).scale.z).toBe(1)
    expect(fadeOf(ring)).toBe(1)
    ring.dispose()
  })

  it('landing carries a one-shot squash-and-stretch: wider (x/z) than tall (y), then relaxed', () => {
    const ring = makeHoverRing()
    ring.show(0)
    let maxAniso = 0
    for (let t = 0; t <= 0.2; t += STEP) {
      ring.tick(t)
      const m = meshOf(ring)
      expect(m.scale.x).toBeCloseTo(m.scale.z, 10) // plan stays round
      maxAniso = Math.max(maxAniso, m.scale.x - m.scale.y)
    }
    expect(maxAniso).toBeGreaterThan(0.05) // a hair wider than tall on landing
    expect(maxAniso).toBeLessThan(0.2) // …a hair, not a cartoon
    ring.tick(0.25) // fully relaxed and round again
    expect(meshOf(ring).scale.x).toBe(meshOf(ring).scale.y)
    ring.dispose()
  })

  it('show() while visible (adjacent-hole hop) retriggers a smaller pop (~1.06)', () => {
    const ring = makeHoverRing()
    ring.show(0)
    const fullPeak = maxPlanScale(ring, 0, 0.3) // settled by now
    ring.show(0.3) // hop to the neighbouring hole
    ring.tick(0.3)
    expect(meshOf(ring).scale.x).toBeLessThan(1) // re-popped from below 1
    const hopPeak = maxPlanScale(ring, 0.3, 0.45)
    expect(hopPeak).toBeGreaterThan(1.02) // still overshoots…
    expect(hopPeak).toBeLessThan(1.09) // …but smaller (~1.06)
    expect(hopPeak).toBeLessThan(fullPeak)
    ring.tick(0.5)
    expect(meshOf(ring).scale.x).toBe(1) // settled again
    ring.dispose()
  })

  it('leave is a quick fade with NO scale animation', () => {
    const ring = makeHoverRing()
    ring.show(0)
    ring.tick(0.05) // freeze mid-pop
    const m = meshOf(ring)
    const frozen = { x: m.scale.x, y: m.scale.y, z: m.scale.z }
    ring.hide(0.06)
    const f0 = fadeOf(ring)
    ring.tick(0.12) // mid-fade
    expect(fadeOf(ring)).toBeLessThan(f0) // fading…
    expect(m.scale.x).toBe(frozen.x) // …but the scale never animates
    expect(m.scale.y).toBe(frozen.y)
    expect(m.scale.z).toBe(frozen.z)
    ring.tick(0.2) // fade complete
    expect(m.visible).toBe(false)
    expect(fadeOf(ring)).toBe(0)
    ring.dispose()
  })

  it('reduced motion: crossfade only — scale pinned at 1, no pops', () => {
    const ring = makeHoverRing()
    ring.setReducedMotion(true)
    ring.show(0)
    ring.tick(0.05)
    const m = meshOf(ring)
    expect(m.scale.x).toBe(1)
    expect(m.scale.y).toBe(1)
    const mid = fadeOf(ring)
    expect(mid).toBeGreaterThan(0) // crossfading in
    expect(mid).toBeLessThan(1)
    ring.show(0.06) // hop never pops either
    ring.tick(0.2)
    expect(m.scale.x).toBe(1)
    expect(fadeOf(ring)).toBe(1)
    ring.dispose()
  })
})
