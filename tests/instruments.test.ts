/**
 * Movable off-board instruments — model layer (explicit `pos` on offboard
 * components: src/model/breadboard.ts + src/model/validate.ts) and
 * instrument-aware routing (src/three/internal/wire-router.ts: instrument
 * obstacle boxes + terminal exit segments).
 */
import { describe, expect, it } from 'vitest'
import {
  offboardBodyPosition,
  offboardBodyRect,
  offboardTerminalPosition,
} from '../src/model/breadboard'
import { validateLayout } from '../src/model/validate'
import {
  routeAll,
  routeOne,
  type InstrumentObstacle,
  type RoutedWire,
  type RouteWireInput,
} from '../src/three/internal/wire-router'

// ---------------------------------------------------------------- helpers

const wire = (id: string, ax: number, az: number, bx: number, bz: number): RouteWireInput => ({
  id,
  ax,
  az,
  bx,
  bz,
})

interface Pathy {
  waypoints: { x: number; y: number; z: number }[]
}

const maxY = (r: Pathy) => Math.max(...r.waypoints.map((p) => p.y))

const hasNaN = (r: Pathy) =>
  r.waypoints.some((p) => !Number.isFinite(p.x) || !Number.isFinite(p.y) || !Number.isFinite(p.z))

/** densify a waypoint polyline with linear interpolation (step ≈ 0.05) */
function densify(r: Pathy): { x: number; y: number; z: number }[] {
  const out: { x: number; y: number; z: number }[] = []
  const wp = r.waypoints
  for (let i = 0; i < wp.length - 1; i++) {
    const a = wp[i]
    const b = wp[i + 1]
    const len = Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z)
    const steps = Math.max(1, Math.ceil(len / 0.05))
    for (let s = 0; s < steps; s++) {
      const t = s / steps
      out.push({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, z: a.z + (b.z - a.z) * t })
    }
  }
  out.push(wp[wp.length - 1])
  return out
}

/** min 3D distance between two densified waypoint polylines */
function minDistance(a: Pathy, b: Pathy): number {
  let best = Infinity
  for (const p of densify(a)) {
    for (const q of densify(b)) {
      const d2 = (p.x - q.x) ** 2 + (p.y - q.y) ** 2 + (p.z - q.z) ** 2
      if (d2 < best) best = d2
    }
  }
  return Math.sqrt(best)
}

function serialize(m: Map<string, unknown>): string {
  return JSON.stringify([...m.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)))
}

// =========================================================================
// MODEL: offboard position derivation (breadboard.ts)
// =========================================================================

describe('offboard positions: legacy slot formula is the default', () => {
  it('without pos, terminal and body positions match the legacy shelf exactly', () => {
    for (const slot of [0, 1, 2]) {
      for (const pin of [0, 1]) {
        // the pre-movable formula, byte for byte: existing layouts render identically
        expect(offboardTerminalPosition(slot, pin)).toEqual({
          x: -8 + pin * 2.5,
          z: 2 + slot * 7,
        })
      }
      expect(offboardBodyPosition(slot)).toEqual({ x: -10, z: slot * 7 })
    }
  })

  it('explicit pos overrides the slot formula; terminals keep their anchor offset', () => {
    const pos = { x: 30, z: -10 }
    expect(offboardBodyPosition(3, pos)).toEqual({ x: 30, z: -10 })
    // pin i sits at anchor + (2 + 2.5·i, 2) — same offset as the legacy shelf
    expect(offboardTerminalPosition(3, 0, pos)).toEqual({ x: 32, z: -8 })
    expect(offboardTerminalPosition(3, 1, pos)).toEqual({ x: 34.5, z: -8 })
  })

  it('offboardBodyRect covers the 6.5-wide enclosure plus the terminal apron', () => {
    expect(offboardBodyRect(0)).toEqual({ minX: -10, maxX: -3.5, minZ: -2, maxZ: 2.5 })
    const rect = offboardBodyRect(5, { x: 30, z: -10 })
    expect(rect).toEqual({ minX: 30, maxX: 36.5, minZ: -12, maxZ: -7.5 })
    // the terminal posts always sit inside their unit's rect
    for (const pin of [0, 1]) {
      const t = offboardTerminalPosition(5, pin, { x: 30, z: -10 })
      expect(t.x).toBeGreaterThanOrEqual(rect.minX)
      expect(t.x).toBeLessThanOrEqual(rect.maxX)
      expect(t.z).toBeGreaterThanOrEqual(rect.minZ)
      expect(t.z).toBeLessThanOrEqual(rect.maxZ)
    }
  })
})

// =========================================================================
// MODEL: validator pos rules (validate.ts)
// =========================================================================

describe('validateLayout: instrument pos rules', () => {
  it('a valid off-board pos round-trips export/import', () => {
    const layout = {
      version: 1,
      components: [{ id: 'PS1', type: 'power_supply', pos: { x: 20.5, z: -8 } }],
      wires: [],
    }
    const res = validateLayout(layout)
    expect(res.errors).toEqual([])
    expect(res.ok).toBe(true)
    expect(res.layout!.components[0].pos).toEqual({ x: 20.5, z: -8 })
    // export → import: JSON round-trip re-validates with the pos intact
    const again = validateLayout(JSON.parse(JSON.stringify(res.layout)))
    expect(again.ok).toBe(true)
    expect(again.layout!.components[0].pos).toEqual({ x: 20.5, z: -8 })
  })

  it('absent pos stays absent (default slot rendering, no fabricated field)', () => {
    const res = validateLayout({
      version: 1,
      components: [{ id: 'PS1', type: 'power_supply' }],
      wires: [],
    })
    expect(res.ok).toBe(true)
    expect('pos' in res.layout!.components[0]).toBe(false)
  })

  it('the legacy slot position made explicit is valid', () => {
    const res = validateLayout({
      version: 1,
      components: [{ id: 'PS1', type: 'power_supply', pos: { x: -10, z: 0 } }],
      wires: [],
    })
    expect(res.ok).toBe(true)
    expect(res.layout!.components[0].pos).toEqual({ x: -10, z: 0 })
  })

  it('rejects pos on an on-board component', () => {
    const res = validateLayout({
      version: 1,
      components: [
        { id: 'PS1', type: 'power_supply' },
        { id: 'R1', type: 'resistor', holes: ['a1', 'a5'], pos: { x: 1, z: 1 } },
      ],
      wires: [],
    })
    expect(res.ok).toBe(false)
    expect(res.errors.some((e) => e.includes('"pos" is only for off-board instruments'))).toBe(
      true,
    )
  })

  it('rejects a pos off the 0.5 placement grid', () => {
    const res = validateLayout({
      version: 1,
      components: [{ id: 'PS1', type: 'power_supply', pos: { x: -10.3, z: 0 } }],
      wires: [],
    })
    expect(res.ok).toBe(false)
    expect(res.errors.some((e) => e.includes('snap to 0.5 plan units'))).toBe(true)
  })

  it('rejects malformed pos values with an actionable message', () => {
    for (const pos of ['left', { x: 1 }, { x: Infinity, z: 0 }, [1, 2], { x: '1', z: 0 }]) {
      const res = validateLayout({
        version: 1,
        components: [{ id: 'PS1', type: 'power_supply', pos }],
        wires: [],
      })
      expect(res.ok).toBe(false)
      expect(res.errors.some((e) => e.includes('"pos" must be an object'))).toBe(true)
    }
  })

  it('rejects a pos whose body rect intersects the board', () => {
    const res = validateLayout({
      version: 1,
      components: [{ id: 'PS1', type: 'power_supply', pos: { x: 10, z: 5 } }],
      wires: [],
    })
    expect(res.ok).toBe(false)
    expect(res.errors.some((e) => e.includes('overlaps the Standard board'))).toBe(true)
  })

  it('board intersection respects the ACTIVE rig config', () => {
    // x 70..76.5 sits right of a single Standard board (maxX 64.5)…
    const single = validateLayout({
      version: 1,
      components: [{ id: 'PS1', type: 'power_supply', pos: { x: 70, z: 5 } }],
      wires: [],
    })
    expect(single.ok).toBe(true)
    // …but inside a ×2 rig (maxX 127.5)
    const ganged = validateLayout({
      version: 1,
      boardCount: 2,
      components: [{ id: 'PS1', type: 'power_supply', pos: { x: 70, z: 5 } }],
      wires: [],
    })
    expect(ganged.ok).toBe(false)
    expect(ganged.errors.some((e) => e.includes('overlaps the Standard ×2 board'))).toBe(true)
  })

  it('rejects overlapping instrument bodies (explicit pos vs default slot)', () => {
    const res = validateLayout({
      version: 1,
      components: [
        { id: 'PS1', type: 'power_supply' }, // default slot 0: z -2..2.5
        { id: 'FG1', type: 'function_generator', pos: { x: -10, z: 1 } }, // z -1..3.5
      ],
      wires: [],
    })
    expect(res.ok).toBe(false)
    expect(
      res.errors.some((e) => e.includes('"FG1"') && e.includes('"PS1"') && e.includes('overlaps')),
    ).toBe(true)
    // edge-touching rects are NOT an overlap (z 2.5..7 abuts z -2..2.5)
    const touching = validateLayout({
      version: 1,
      components: [
        { id: 'PS1', type: 'power_supply' },
        { id: 'FG1', type: 'function_generator', pos: { x: -10, z: 4.5 } },
      ],
      wires: [],
    })
    expect(touching.ok).toBe(true)
  })
})

// =========================================================================
// ROUTER: instrument obstacle boxes + terminal exit segments
// =========================================================================

/** PSU-shaped test instrument: enclosure box (mesh-exact for slot 0) +
 * 2 terminal posts on the front face, exiting +z (away from the face). */
function testInstrument(height = 4): InstrumentObstacle {
  return {
    id: 'PS1',
    minX: -10,
    maxX: -3.5,
    minZ: -2,
    maxZ: 1.2,
    height,
    terminals: [0, 1].map((i) => ({
      ...offboardTerminalPosition(0, i), // (-8, 2) and (-5.5, 2)
      exitDir: { x: 0, z: 1 },
    })),
  }
}

describe('wire-router: instrument boxes are collision obstacles', () => {
  const inst: InstrumentObstacle = {
    id: 'PSU',
    minX: 10,
    maxX: 16.5,
    minZ: 6,
    maxZ: 10.2,
    height: 4,
    terminals: [],
  }

  it('a wire between two boards dodges an instrument box placed in between', () => {
    const m = routeAll([wire('w', 0, 8, 30, 8)], [], [inst])
    const r = m.get('w') as RoutedWire
    // every densified point over the box footprint clears height + 0.35
    // (−0.12: the linear densify of arc waypoints undercuts the analytic
    // dome the collision pass checked — same tolerance the router suite uses)
    let minOver = Infinity
    for (const p of densify(r)) {
      if (p.x >= inst.minX && p.x <= inst.maxX && p.z >= inst.minZ && p.z <= inst.maxZ) {
        if (p.y < minOver) minOver = p.y
      }
    }
    expect(minOver).toBeGreaterThanOrEqual(4 + 0.35 - 0.12)
    // it genuinely escalated above the 4-capped base apex
    expect(maxY(r)).toBeGreaterThan(4)
  })

  it('an instrument with unused terminals routes exactly like a plain obstacle box', () => {
    const viaInstrument = routeAll([wire('w', 0, 8, 30, 8)], [], [inst])
    const viaBox = routeAll(
      [wire('w', 0, 8, 30, 8)],
      [{ minX: 10, maxX: 16.5, minZ: 6, maxZ: 10.2, height: 4 }],
    )
    expect(serialize(viaInstrument)).toBe(serialize(viaBox))
  })
})

describe('wire-router: terminal exit segments', () => {
  it('a wire from a terminal rises from the post and runs >= 1.5 along exitDir', () => {
    const inst = testInstrument()
    const m = routeAll([wire('w', -8, 2, 10, 8)], [], [inst])
    const r = m.get('w') as RoutedWire
    // starts at the terminal, rises vertically
    expect(r.waypoints[0]).toEqual({ x: -8, y: 0, z: 2 })
    expect(r.waypoints[1].x).toBeCloseTo(-8, 6)
    expect(r.waypoints[1].z).toBeCloseTo(2, 6)
    expect(r.waypoints[1].y).toBeCloseTo(0.5, 6)
    // …then stays on the exitDir line (x = -8, low) until 1.5 units out
    for (const p of r.waypoints) {
      if (p.z < 3.5 - 1e-6) {
        expect(p.x).toBeCloseTo(-8, 6)
        expect(p.y).toBeLessThanOrEqual(0.5 + 1e-6)
      }
    }
    // the exit-run end is an explicit waypoint (the arc begins there)
    expect(
      r.waypoints.some((p) => Math.abs(p.x + 8) < 1e-6 && Math.abs(p.z - 3.5) < 1e-6),
    ).toBe(true)
    // and no densified sample sits inside its own enclosure box
    for (const p of densify(r)) {
      const inside =
        p.x >= inst.minX && p.x <= inst.maxX && p.z >= inst.minZ && p.z <= inst.maxZ && p.y < 4
      expect(inside).toBe(false)
    }
  })

  it('a terminal wire to a point BEHIND the instrument climbs over the box (noclip regression)', () => {
    // height 3.5 keeps the needed clearance inside the 8-tier lift ladder for
    // this short span; the box would otherwise be cleared only least-bad
    const inst = testInstrument(3.5)
    const m = routeAll([wire('w', -8, 2, -8, -4)], [], [inst])
    const r = m.get('w') as RoutedWire
    let minOver = Infinity
    for (const p of densify(r)) {
      if (p.x >= inst.minX && p.x <= inst.maxX && p.z >= inst.minZ && p.z <= inst.maxZ) {
        if (p.y < minOver) minOver = p.y
      }
    }
    // the user bug: this wire used to slice straight through the PSU box
    expect(minOver).toBeGreaterThanOrEqual(3.5 + 0.35 - 0.12)
    expect(hasNaN(r)).toBe(false)
  })

  it('a terminal-to-terminal wire on one instrument exits both posts and avoids the enclosure', () => {
    const inst = testInstrument()
    const m = routeAll([wire('w', -8, 2, -5.5, 2)], [], [inst])
    const r = m.get('w') as RoutedWire
    expect(hasNaN(r)).toBe(false)
    expect(r.waypoints[0]).toEqual({ x: -8, y: 0, z: 2 })
    expect(r.waypoints[r.waypoints.length - 1]).toEqual({ x: -5.5, y: 0, z: 2 })
    for (const p of densify(r)) {
      const inside =
        p.x >= inst.minX && p.x <= inst.maxX && p.z >= inst.minZ && p.z <= inst.maxZ && p.y < 4
      expect(inside).toBe(false)
    }
  })

  it('later wires dodge a terminal wire’s fixed exit run', () => {
    const inst = testInstrument()
    // w2 crosses the exit run of t1 exactly at its end point (-8, 3.5)
    const items = [wire('t1', -8, 2, 10, 8), wire('w2', -10, 3.5, -6, 3.5)]
    const m = routeAll(items, [], [inst])
    const t1 = m.get('t1') as RoutedWire
    const w2 = m.get('w2') as RoutedWire
    // un-dodged, w2 would route clean (apex 0.9, z exactly 3.5) straight over
    // the prefix at 0.5 — 0.4 < the 0.45 clearance. It must escalate or shift.
    const cleanApex = Math.max(0.9, 0.16 * 4)
    const escalated = maxY(w2) > cleanApex + 1e-6
    const midpoint = w2.waypoints[Math.floor(w2.waypoints.length / 2)]
    const shifted = Math.abs(midpoint.z - 3.5) > 0.2
    expect(escalated || shifted).toBe(true)
    expect(minDistance(t1, w2)).toBeGreaterThanOrEqual(0.45 - 0.1)
  })

  it('degenerate inputs stay safe: zero exitDir and sub-0.5 effective spans', () => {
    const zeroDir: InstrumentObstacle = {
      ...testInstrument(),
      terminals: [{ x: -8, z: 2, exitDir: { x: 0, z: 0 } }],
    }
    const r1 = routeAll([wire('w', -8, 2, 10, 8)], [], [zeroDir]).get('w') as RoutedWire
    expect(hasNaN(r1)).toBe(false)
    expect(r1.waypoints[1].x).toBeCloseTo(-8, 6) // legacy vertical entry kept

    // endpoint 0.1 from the exit-run end → exits suppressed, legacy shape
    const r2 = routeAll([wire('w', -8, 2, -8, 3.4)], [], [testInstrument()]).get(
      'w',
    ) as RoutedWire
    expect(hasNaN(r2)).toBe(false)
    expect(r2.waypoints[0]).toEqual({ x: -8, y: 0, z: 2 })
    expect(r2.waypoints[r2.waypoints.length - 1]).toEqual({ x: -8, y: 0, z: 3.4 })
  })
})

describe('wire-router: instrument determinism + previews', () => {
  const inst = testInstrument()
  const items = [
    wire('t1', -8, 2, 10, 8),
    wire('t2', -5.5, 2, 5, 12),
    wire('w1', -10, 3.5, -6, 3.5),
    wire('w2', 0, 8, 30, 8),
  ]

  it('two runs and reversed input order produce identical results', () => {
    const r1 = routeAll(items, [], [inst])
    const r2 = routeAll(
      items.map((i) => ({ ...i })),
      [],
      [{ ...inst, terminals: inst.terminals.map((t) => ({ ...t, exitDir: { ...t.exitDir } }))}],
    )
    const r3 = routeAll([...items].reverse(), [], [inst])
    expect(serialize(r1)).toBe(serialize(r2))
    expect(serialize(r1)).toBe(serialize(r3))
  })

  it('routeOne previews a terminal wire exactly as routeAll commits it', () => {
    const world = routeAll([wire('t1', -8, 2, 10, 8)], [], [inst])
    const cand = wire('t2', -5.5, 2, 5, 12) // shorter effective span → routes last
    const preview = routeOne(world, cand)
    const committed = routeAll([wire('t1', -8, 2, 10, 8), cand], [], [inst])
    expect(JSON.stringify(preview)).toBe(JSON.stringify(committed.get('t2')))
    // the preview carries the exit prefix too
    const pw = preview as RoutedWire
    expect(pw.waypoints[0]).toEqual({ x: -5.5, y: 0, z: 2 })
    expect(pw.waypoints[1].y).toBeCloseTo(0.5, 6)
    // and the world is untouched
    expect(world.has('t2')).toBe(false)
  })
})
