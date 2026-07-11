/**
 * Tests for the collision-free wire router (src/three/internal/wire-router.ts
 * — pure, no three.js) and its consumer plumbing in
 * src/three/internal/wires.ts (obstacle derivation + routed tube geometry).
 */
import { describe, expect, it } from 'vitest'
import * as THREE from 'three'
import {
  routeAll,
  routeOne,
  routeWires,
  toRoutedPose,
  type RoutedComponentPath,
  type RoutedWire,
  type RouteComponentInput,
  type RouteItemInput,
  type RouteObstacle,
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

const resistor = (
  id: string,
  ax: number,
  az: number,
  bx: number,
  bz: number,
  length = 3.2,
  diameter = 0.7,
): RouteComponentInput => ({ id, kind: 'component', ax, az, bx, bz, body: { length, diameter } })

/** any routed item with a waypoint polyline (wire or component) */
interface Pathy {
  waypoints: { x: number; y: number; z: number }[]
}

const maxY = (r: Pathy) => Math.max(...r.waypoints.map((p) => p.y))

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
  const pa = densify(a)
  const pb = densify(b)
  let best = Infinity
  for (const p of pa) {
    for (const q of pb) {
      const d2 = (p.x - q.x) ** 2 + (p.y - q.y) ** 2 + (p.z - q.z) ** 2
      if (d2 < best) best = d2
    }
  }
  return Math.sqrt(best)
}

/** z of the waypoint nearest the plan midpoint (lateral offset probe) */
function midZ(r: RoutedWire, mx: number): number {
  let best = Infinity
  let z = NaN
  for (const p of r.waypoints) {
    const d = Math.abs(p.x - mx)
    if (d < best) {
      best = d
      z = p.z
    }
  }
  return z
}

function hasNaN(r: Pathy): boolean {
  return r.waypoints.some((p) => !Number.isFinite(p.x) || !Number.isFinite(p.y) || !Number.isFinite(p.z))
}

function serialize(m: Map<string, unknown>): string {
  return JSON.stringify([...m.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)))
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

// ------------------------------------------------------------------ shape

describe('wire-router: path shape', () => {
  it('endpoints enter holes vertically (0.5-unit straight drop) on arcs', () => {
    const m = routeWires([wire('w', 0, 0, 10, 0)], [])
    const r = m.get('w')!
    expect(r.style).toBe('arc')
    const wp = r.waypoints
    const first = wp[0]
    const second = wp[1]
    expect(first).toEqual({ x: 0, y: 0, z: 0 })
    expect(second.x).toBe(0)
    expect(second.z).toBe(0)
    expect(second.y).toBeCloseTo(0.5, 5)
    const last = wp[wp.length - 1]
    const penultimate = wp[wp.length - 2]
    expect(last).toEqual({ x: 10, y: 0, z: 0 })
    expect(penultimate.x).toBe(10)
    expect(penultimate.z).toBe(0)
    expect(penultimate.y).toBeCloseTo(0.5, 5)
  })

  it('short hops (< 3 units) become low staples with rise 0.7', () => {
    const m = routeWires([wire('s', 0, 0, 2, 0)], [])
    const r = m.get('s')!
    expect(r.style).toBe('staple')
    expect(maxY(r)).toBeCloseTo(0.7, 5)
    // vertical entries: first two waypoints share the plan position
    expect(r.waypoints[0].x).toBe(r.waypoints[1].x)
    expect(r.waypoints[0].z).toBe(r.waypoints[1].z)
  })

  it('arc apex starts at max(0.9, 0.10·length) capped at 2.2 (board-hugging)', () => {
    const short = routeWires([wire('a', 0, 0, 4, 0)], []).get('a')! // 0.10·4 = 0.4 → 0.9
    expect(maxY(short)).toBeCloseTo(0.9, 5)
    const mid = routeWires([wire('a', 0, 0, 20, 0)], []).get('a')! // 0.10·20 = 2.0
    expect(maxY(mid)).toBeCloseTo(2.0, 5)
    const long = routeWires([wire('a', 0, 0, 40, 0)], []).get('a')! // capped at 2.2
    expect(maxY(long)).toBeCloseTo(2.2, 5)
  })
})

// ------------------------------------------------------- collision avoidance

describe('wire-router: collision avoidance', () => {
  it('crossing wires get distinct apex tiers with >= 0.45 clearance at the crossing', () => {
    const m = routeWires(
      [wire('a', 0, 0, 20, 0), wire('b', 10, -10, 10, 10)],
      [],
    )
    const a = m.get('a')!
    const b = m.get('b')!
    // distinct tiers: apexes separated by (a multiple of) the 0.55 bump
    expect(Math.abs(maxY(a) - maxY(b))).toBeGreaterThanOrEqual(0.5)
    expect(minDistance(a, b)).toBeGreaterThanOrEqual(0.45)
  })

  it('3 parallel same-strip-run wires get distinct lateral offsets', () => {
    const m = routeWires(
      [wire('p1', 0, 4, 10, 4), wire('p2', 2, 4, 12, 4), wire('p3', 4, 4, 14, 4)],
      [],
    )
    const z1 = midZ(m.get('p1')!, 5)
    const z2 = midZ(m.get('p2')!, 7)
    const z3 = midZ(m.get('p3')!, 9)
    // pairwise distinct mid-section lateral positions (±0.35·n alternation)
    expect(Math.abs(z1 - z2)).toBeGreaterThanOrEqual(0.3)
    expect(Math.abs(z1 - z3)).toBeGreaterThanOrEqual(0.3)
    expect(Math.abs(z2 - z3)).toBeGreaterThanOrEqual(0.3)
    // and every adjacent pair keeps wire clearance
    expect(minDistance(m.get('p1')!, m.get('p2')!)).toBeGreaterThanOrEqual(0.45)
    expect(minDistance(m.get('p2')!, m.get('p3')!)).toBeGreaterThanOrEqual(0.45)
  })

  it('a wire spanning a DIP obstacle clears height + 0.35', () => {
    const dip: RouteObstacle = { minX: 4, maxX: 8, minZ: -1, maxZ: 1, height: 1.7 }
    const m = routeWires([wire('w', 0, 0, 12, 0)], [dip])
    const r = m.get('w')!
    // every densified path point over the box footprint clears height + 0.35
    let minOver = Infinity
    for (const p of densify(r)) {
      if (p.x >= dip.minX && p.x <= dip.maxX && p.z >= dip.minZ && p.z <= dip.maxZ) {
        if (p.y < minOver) minOver = p.y
      }
    }
    expect(minOver).toBeGreaterThanOrEqual(1.7 + 0.35 - 0.05)
    // and it actually had to bump above its base apex (0.10·12 = 1.2)
    expect(maxY(r)).toBeGreaterThan(1.2 + 0.5)
  })

  it('a wire whose endpoint sits inside an obstacle box does not escalate against it', () => {
    const box: RouteObstacle = { minX: -1, maxX: 1, minZ: -1, maxZ: 1, height: 1.7 }
    const m = routeWires([wire('w', 0, 0, 6, 0)], [box])
    const r = m.get('w')!
    // endpoint is inside the box → box skipped → base apex kept (0.10·6 = 0.6 → floor 0.9)
    expect(maxY(r)).toBeCloseTo(Math.max(0.9, 0.1 * 6), 5)
  })
})

// ------------------------------------------------------------- determinism

describe('wire-router: determinism', () => {
  const wires = [
    wire('w1', 0, 0, 20, 0),
    wire('w2', 10, -10, 10, 10),
    wire('w3', 0, 2, 20, 2),
    wire('w4', 5, 5, 6, 5),
    wire('w5', 0, 2.2, 20, 2.2),
  ]
  const obstacles: RouteObstacle[] = [{ minX: 8, maxX: 12, minZ: -0.5, maxZ: 2.5, height: 1.7 }]

  it('two runs produce identical results', () => {
    const r1 = routeWires(wires, obstacles)
    const r2 = routeWires(
      wires.map((w) => ({ ...w })),
      obstacles.map((o) => ({ ...o })),
    )
    expect(serialize(r1)).toBe(serialize(r2))
  })

  it('input order does not matter (sorted by span desc, id asc)', () => {
    const r1 = routeWires(wires, obstacles)
    const r2 = routeWires([...wires].reverse(), obstacles)
    expect(serialize(r1)).toBe(serialize(r2))
  })
})

// --------------------------------------------------------------- degenerate

describe('wire-router: degenerate inputs', () => {
  it('zero-length wires route as staples without throwing or NaNs', () => {
    const m = routeWires([wire('z', 5, 5, 5, 5)], [])
    const r = m.get('z')!
    expect(r.style).toBe('staple')
    expect(hasNaN(r)).toBe(false)
    // no two consecutive waypoints coincide (CatmullRom safety)
    for (let i = 1; i < r.waypoints.length; i++) {
      const a = r.waypoints[i - 1]
      const b = r.waypoints[i]
      expect(Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z)).toBeGreaterThan(1e-6)
    }
  })

  it('a pair of wires with identical endpoints does not throw or loop forever', () => {
    const m = routeWires([wire('d1', 0, 0, 6, 0), wire('d2', 0, 0, 6, 0)], [])
    expect(m.size).toBe(2)
    expect(hasNaN(m.get('d1')!)).toBe(false)
    expect(hasNaN(m.get('d2')!)).toBe(false)
  })

  it('an unsatisfiable pile-up accepts the least-bad candidate instead of looping', () => {
    // 8 identical zero-length wires at one point: nothing can ever clear
    const wires = Array.from({ length: 8 }, (_, i) => wire(`q${i}`, 3, 3, 3, 3))
    const m = routeWires(wires, [])
    expect(m.size).toBe(8)
    for (const r of m.values()) expect(hasNaN(r)).toBe(false)
  })
})

// -------------------------------------------------------------- performance

describe('wire-router: performance', () => {
  it('routes 200 random wires in < 500ms with zero NaNs', () => {
    const rand = mulberry32(0xbeef)
    const wires: RouteWireInput[] = []
    for (let i = 0; i < 200; i++) {
      wires.push(
        wire(
          `w${i}`,
          1 + rand() * 62,
          rand() * 16,
          1 + rand() * 62,
          rand() * 16,
        ),
      )
    }
    const obstacles: RouteObstacle[] = []
    for (let i = 0; i < 12; i++) {
      const x = 1 + rand() * 55
      const z = rand() * 14
      obstacles.push({ minX: x, maxX: x + 2 + rand() * 6, minZ: z, maxZ: z + 2, height: 1.2 + rand() * 0.5 })
    }
    const t0 = performance.now()
    const m = routeWires(wires, obstacles)
    const elapsed = performance.now() - t0
    expect(m.size).toBe(200)
    expect(elapsed).toBeLessThan(500)
    for (const r of m.values()) expect(hasNaN(r)).toBe(false)
  })
})

// ----------------------------------------------------- tower suppression

describe('wire-router: escalated wires stay smooth (no vertical towers)', () => {
  // a wide/tall obstacle the wire cannot dodge sideways (z spans ±2 > the
  // ±1.05 max lateral) — forces genuine lift escalation
  const wall = (minX: number, maxX: number, height: number): RouteObstacle => ({
    minX,
    maxX,
    minZ: -2,
    maxZ: 2,
    height,
  })

  it('a staple bumped past 1.5 lift re-shapes as an arc with low vertical entries', () => {
    const m = routeWires([wire('s', 0, 0, 2.5, 0)], [wall(0.8, 1.7, 1.7)])
    const r = m.get('s')!
    expect(r.style).toBe('arc') // squared-off high staples dominated the silhouette
    // entries drop vertically only 0.5 units — not the full lift
    expect(r.waypoints[1].x).toBe(0)
    expect(r.waypoints[1].y).toBeCloseTo(0.5, 5)
    // and it still clears the obstacle body comfortably (the linear densify
    // of the few short-arc waypoints undercuts the analytic sin dome the
    // collision pass checked by up to ~0.1 — well inside the 0.35 clearance)
    let minOver = Infinity
    for (const p of densify(r)) {
      if (p.x >= 0.8 && p.x <= 1.7 && Math.abs(p.z) <= 2) minOver = Math.min(minOver, p.y)
    }
    expect(minOver).toBeGreaterThanOrEqual(1.7 + 0.35 - 0.12)
  })

  it('high-lift arcs climb gently (slope bounded) instead of scaling a wall', () => {
    const m = routeWires([wire('w', 0, 0, 20, 0)], [wall(8, 12, 4)])
    const r = m.get('w')!
    expect(maxY(r)).toBeGreaterThanOrEqual(4 + 0.35 - 0.05) // had to escalate high
    // steepest rendered segment stays under 2:1 (the fixed 1.6 climb run
    // produced ~4.3:1 near-vertical sides at this lift)
    const wp = r.waypoints
    for (let i = 2; i < wp.length - 2; i++) {
      const planD = Math.hypot(wp[i].x - wp[i - 1].x, wp[i].z - wp[i - 1].z)
      if (planD < 1e-6) continue
      expect(Math.abs(wp[i].y - wp[i - 1].y) / planD).toBeLessThanOrEqual(2)
    }
  })

  it('conflicting wires spread laterally before stacking upward', () => {
    // five parallel wires on the same strip line: with lateral dodges cheaper
    // than lift tiers, the bundle must fan out flat — max apex stays within
    // two tiers of the 1.6 base instead of growing a tower
    const wires = Array.from({ length: 5 }, (_, i) => wire(`p${i}`, i, 4, 10 + i, 4))
    const m = routeWires(wires, [])
    let tallest = 0
    for (const r of m.values()) tallest = Math.max(tallest, maxY(r))
    expect(tallest).toBeLessThanOrEqual(1.6 + 2 * 0.55 + 1e-6)
  })
})

// ------------------------------------------------- obstacle derivation (wires.ts)

describe('obstaclesForLayout: board-size awareness', () => {
  it('derives obstacles for far-column parts on a labxl board', async () => {
    const { obstaclesForLayout } = await import('../src/three/internal/wires')
    const layout = {
      version: 1 as const,
      board: 'labxl' as const,
      components: [
        // beyond the standard board's 63 columns — only valid on labxl
        { id: 'U1', type: 'ne555', at: 'f100' },
        { id: 'R1', type: 'resistor', params: { resistance: 330 }, holes: ['a90', 'a96'] },
      ],
      wires: [],
    }
    const obstacles = obstaclesForLayout(layout)
    // SPEC CHANGE (scene integration): the resistor no longer yields an
    // obstacle BOX — axial leaded parts route as first-class router
    // components with fat collision-sampled bodies instead. Only the DIP box
    // remains.
    expect(obstacles.length).toBe(1)
    // the DIP body box must straddle its columns (100..103) on the far board
    const dip = obstacles.find((o) => o.height > 1.5)
    expect(dip).toBeDefined()
    expect(dip!.minX).toBeGreaterThan(90)
    expect(dip!.maxX).toBeLessThan(110)

    // the identical layout claiming a standard board reads as malformed
    // (cols > 63) and yields no obstacle boxes — the pre-fix behavior
    const onStandard = obstaclesForLayout({ ...layout, board: undefined })
    expect(onStandard.length).toBe(0)
  })

  it('routes the far-column resistor as a first-class component instead', async () => {
    const { planRoutes, routedComponentPose, routedComponentSignature } = await import(
      '../src/three/internal/wires'
    )
    const layout = {
      version: 1 as const,
      board: 'labxl' as const,
      components: [
        { id: 'U1', type: 'ne555', at: 'f100' },
        { id: 'R1', type: 'resistor', params: { resistance: 330 }, holes: ['a90', 'a96'] },
      ],
      wires: [],
    }
    planRoutes(layout)
    const pose = routedComponentPose('R1')
    expect(pose).not.toBeNull()
    expect(pose!.pose).toBe('span') // 6-unit span → level body run
    expect(pose!.waypoints).toHaveLength(2) // one lead path per pin
    // lead paths start at their exact holes (a90 → x=90, a96 → x=96, z=3)
    expect(pose!.waypoints[0][0].x).toBeCloseTo(90, 6)
    expect(pose!.waypoints[0][0].z).toBeCloseTo(3, 6)
    expect(pose!.waypoints[1][0].x).toBeCloseTo(96, 6)
    expect(routedComponentSignature('R1')).not.toBe('')
    // the DIP stays un-routed (no pose, empty signature)
    expect(routedComponentPose('U1')).toBeNull()
    expect(routedComponentSignature('U1')).toBe('')
  })

  it('plans a vertical mount for a short-span resistor and exposes routeOne previews', async () => {
    const { planRoutes, routedComponentPose, previewComponentPose, previewWireGeometry } =
      await import('../src/three/internal/wires')
    const layout = {
      version: 1 as const,
      components: [
        { id: 'R1', type: 'resistor', params: { resistance: 330 }, holes: ['e10', 'f10'] },
      ],
      wires: [],
    }
    planRoutes(layout)
    const pose = routedComponentPose('R1')
    expect(pose).not.toBeNull()
    expect(pose!.pose).toBe('vertical') // span 2 < 3 → stand-up mount
    expect(pose!.bodyDir.y).toBeGreaterThan(0.9)

    // ghost preview: a routed candidate against the planned world
    const ghost = previewComponentPose('resistor', { x: 20, z: 3 }, { x: 26, z: 3 })
    expect(ghost).not.toBeNull()
    expect(ghost!.pose).toBe('span')
    // non-routed types never preview a pose
    expect(previewComponentPose('photoresistor', { x: 20, z: 3 }, { x: 22, z: 3 })).toBeNull()
    // SPEC CHANGE (packed-LED noclip fix, DESIGN §4b): LEDs are now routed
    // standing span bodies, so they DO preview a pose (preview = commit)
    const ledGhost = previewComponentPose('led', { x: 20, z: 3 }, { x: 22, z: 3 })
    expect(ledGhost).not.toBeNull()
    expect(ledGhost!.pose).toBe('span') // standing bodies always span-route

    // wire-drag preview: routed tube geometry (non-degenerate, owned by caller)
    const a = new THREE.Vector3(30, 0, 3)
    const b = new THREE.Vector3(40, 0, 13)
    const geo = previewWireGeometry(a, b, 0.07)
    expect(geo.attributes.position.count).toBeGreaterThan(0)
    geo.dispose()
  })
})

describe('obstaclesForLayout: per-package heights cover the real mesh tops', () => {
  const obstacleFor = async (comp: Record<string, unknown>) => {
    const { obstaclesForLayout } = await import('../src/three/internal/wires')
    const obstacles = obstaclesForLayout({
      version: 1 as const,
      components: [comp as never],
      wires: [],
    })
    expect(obstacles).toHaveLength(1)
    return obstacles[0]
  }

  it('tall leaded parts get per-type heights (≥ their mesh tops)', async () => {
    // mesh tops from src/three/meshes: LED dome 1.83, TO-92 ~1.8, slide-switch
    // lever 1.88, pot knob slot ~1.83, electrolytic can 1.55. The old flat 1.2
    // let the router accept wires THROUGH those bodies (1.2 + 0.35 = 1.55).
    expect((await obstacleFor({ id: 'D1', type: 'led', holes: ['f11', 'j11'] })).height).toBe(1.9)
    expect(
      (await obstacleFor({ id: 'Q1', type: 'npn', holes: ['f20', 'f21', 'f22'] })).height,
    ).toBe(1.85)
    expect(
      (await obstacleFor({ id: 'S1', type: 'slide_switch', holes: ['f30', 'f31', 'f32'] }))
        .height,
    ).toBe(1.9)
    expect(
      (await obstacleFor({ id: 'P1', type: 'potentiometer', holes: ['f40', 'f41', 'f42'] }))
        .height,
    ).toBe(1.9)
  })

  it('electrolytic capacitors get headroom; ceramic discs keep the 1.2 default', async () => {
    const electro = await obstacleFor({
      id: 'C1',
      type: 'capacitor',
      holes: ['f50', 'f53'],
      params: { polarized: true },
    })
    expect(electro.height).toBe(1.6) // can top 1.55 — flat 1.2 left ZERO margin
    const ceramic = await obstacleFor({ id: 'C2', type: 'capacitor', holes: ['f50', 'f53'] })
    expect(ceramic.height).toBe(1.2)
  })

  it('declared heights cover the measured mesh bounding boxes', async () => {
    const { buildComponentObject } = await import('../src/three/component-meshes')
    const { getEntry } = await import('../src/model/catalog')
    const { componentPinHoles, holePosition } = await import('../src/model/breadboard')
    const comps = [
      { id: 'D1', type: 'led', holes: ['f11', 'j11'] },
      { id: 'Q1', type: 'npn', holes: ['f20', 'f21', 'f22'] },
      { id: 'S1', type: 'slide_switch', holes: ['f30', 'f31', 'f32'] },
      { id: 'P1', type: 'potentiometer', holes: ['f40', 'f41', 'f42'] },
      { id: 'C1', type: 'capacitor', holes: ['f50', 'f53'], params: { polarized: true } },
    ]
    for (const comp of comps) {
      const entry = getEntry(comp.type)!
      const pins = (componentPinHoles(comp as never, entry) ?? []).map((h) => {
        const p = holePosition(h!)
        return new THREE.Vector3(p.x, 0, p.z)
      })
      const built = buildComponentObject(comp as never, entry, pins)
      // solid meshes only — glow halo sprites are massless billboards, not bodies
      built.object.updateMatrixWorld(true)
      const box = new THREE.Box3()
      built.object.traverse((obj) => {
        const mesh = obj as THREE.Mesh
        if ((obj as THREE.Sprite).isSprite || !mesh.isMesh || !mesh.geometry) return
        mesh.geometry.computeBoundingBox()
        box.union(mesh.geometry.boundingBox!.clone().applyMatrix4(mesh.matrixWorld))
      })
      const top = box.max.y
      const o = await obstacleFor(comp)
      expect(o.height, `${comp.type} obstacle must cover its mesh top`).toBeGreaterThanOrEqual(
        top - 1e-6,
      )
    }
  })

  it('the router no longer accepts a staple through the LED dome', async () => {
    const { obstaclesForLayout } = await import('../src/three/internal/wires')
    const { parseHole, holePosition } = await import('../src/model/breadboard')
    const obstacles = obstaclesForLayout({
      version: 1 as const,
      components: [{ id: 'D1', type: 'led', holes: ['f11', 'j11'] } as never],
      wires: [],
    })
    // staple h10 → h12 crosses the dome axis (col 11); endpoints sit outside
    // the obstacle box so it is not prefiltered away
    const a = holePosition(parseHole('h10')!)
    const b = holePosition(parseHole('h12')!)
    const r = routeWires([{ id: 'w1', ax: a.x, az: a.z, bx: b.x, bz: b.z }], obstacles).get('w1')!
    // dome: sphere center y = 0.55 + 0.7 = 1.25, radius 0.58 → top 1.83. Every
    // path point over the dome axis must clear the glass + the tube radius.
    for (const p of densify(r)) {
      if (Math.abs(p.x - a.x - 1) < 0.45 && Math.abs(p.z - a.z) < 0.45) {
        expect(p.y).toBeGreaterThanOrEqual(1.83 + 0.16)
      }
    }
  })
})

// =========================================================================
// Leaded components as first-class routed citizens (routeAll / routeOne)
// =========================================================================

const compOf = (m: Map<string, unknown>, id: string): RoutedComponentPath =>
  m.get(id) as RoutedComponentPath

describe('routeAll: leaded component spans', () => {
  it('two crossing resistor spans get distinct apexes with >= 0.45 clearance', () => {
    const m = routeAll([resistor('ra', 0, 0, 10, 0), resistor('rb', 5, -5, 5, 5)], [])
    const a = compOf(m, 'ra')
    const b = compOf(m, 'rb')
    expect(a.style).toBe('span')
    expect(b.style).toBe('span')
    // distinct apex tiers — the later span lifts clear of the first body
    // (fat-vs-fat: 0.45 clearance + 2 × body radius forces real separation)
    expect(Math.abs(maxY(a) - maxY(b))).toBeGreaterThanOrEqual(0.5)
    expect(minDistance(a, b)).toBeGreaterThanOrEqual(0.45)
  })

  it('the reserved body segment is straight, level and body-length long', () => {
    const m = routeAll([resistor('ra', 0, 0, 10, 0)], [])
    const a = compOf(m, 'ra')
    const bs = a.waypoints.find((p) => p.marker === 'bodyStart')!
    const be = a.waypoints.find((p) => p.marker === 'bodyEnd')!
    expect(bs).toBeDefined()
    expect(be).toBeDefined()
    // level: both markers at the routed body height
    expect(bs.y).toBeCloseTo(be.y, 6)
    expect(bs.y).toBeCloseTo(a.bodyCenter.y, 6)
    // straight & long enough: the flat segment spans the full body length
    expect(Math.hypot(be.x - bs.x, be.z - bs.z)).toBeGreaterThanOrEqual(3.2 - 1e-6)
    // markers sit symmetric about bodyCenter along the level bodyDir
    expect(a.bodyDir.y).toBe(0)
    expect(Math.hypot(a.bodyDir.x, a.bodyDir.z)).toBeCloseTo(1, 6)
    expect((bs.x + be.x) / 2).toBeCloseTo(a.bodyCenter.x, 6)
    expect((bs.z + be.z) / 2).toBeCloseTo(a.bodyCenter.z, 6)
    // markers appear in path order (A-side first)
    expect(a.waypoints.indexOf(bs)).toBeLessThan(a.waypoints.indexOf(be))
    // hole entries stay vertical
    expect(a.waypoints[0]).toEqual({ x: 0, y: 0, z: 0 })
    expect(a.waypoints[1].x).toBe(0)
    expect(a.waypoints[1].y).toBeCloseTo(0.5, 5)
  })

  it('a resistor span crossing a DIP obstacle clears it, body surface included', () => {
    const dip: RouteObstacle = { minX: 4, maxX: 8, minZ: -1, maxZ: 1, height: 1.7 }
    const m = routeAll([resistor('rc', 0, 0, 12, 0)], [dip])
    const r = compOf(m, 'rc')
    expect(r.style).toBe('span')
    // the body centerline must clear height + 0.35 + its own fat radius
    expect(r.bodyCenter.y).toBeGreaterThanOrEqual(1.7 + 0.35 + 0.45 - 1e-6)
    // every densified path point over the footprint clears height + 0.35
    let minOver = Infinity
    for (const p of densify(r)) {
      if (p.x >= dip.minX && p.x <= dip.maxX && p.z >= dip.minZ && p.z <= dip.maxZ) {
        if (p.y < minOver) minOver = p.y
      }
    }
    expect(minOver).toBeGreaterThanOrEqual(1.7 + 0.35 - 0.1)
    // and it genuinely escalated above the 0.9 base apex
    expect(maxY(r)).toBeGreaterThan(2.4)
  })

  it('wires dodge a routed component body as a fat segment', () => {
    // the wire's 8-unit base apex (1.28) would skim the body axis at 0.9 —
    // only the fat-segment clearance (0.45 + 0.45 body radius) forces a bump,
    // and only if the component was routed FIRST
    const m = routeAll(
      [resistor('rr', 0, 0, 10, 0), wire('w', 5, -4, 5, 4)],
      [],
    )
    const rr = compOf(m, 'rr')
    const w = m.get('w') as RoutedWire
    expect(maxY(w)).toBeGreaterThan(1.28 + 0.4) // escalated past its base apex
    // min distance from the wire to the body axis ≥ 0.45 + body fat radius
    const axis: Pathy = {
      waypoints: [
        {
          x: rr.bodyCenter.x - rr.bodyDir.x * 1.6,
          y: rr.bodyCenter.y,
          z: rr.bodyCenter.z - rr.bodyDir.z * 1.6,
        },
        {
          x: rr.bodyCenter.x + rr.bodyDir.x * 1.6,
          y: rr.bodyCenter.y,
          z: rr.bodyCenter.z + rr.bodyDir.z * 1.6,
        },
      ],
    }
    expect(minDistance(w, axis)).toBeGreaterThanOrEqual(0.45 + 0.45 - 0.12)
  })

  it('a 3-lead span with a mid drop point routes clean and deterministic', () => {
    const to92: RouteItemInput = {
      ...resistor('q1', 0, 0, 6, 0, 1.4, 1.0),
      mid: { x: 3, z: 0 },
    }
    const r1 = routeAll([to92], [])
    const r2 = routeAll([{ ...to92 }], [])
    expect(hasNaN(compOf(r1, 'q1'))).toBe(false)
    expect(serialize(r1)).toBe(serialize(r2))
    // a wire crossing the mid column escalates instead of slicing through it
    const w = routeAll([to92, wire('w', 3, -3, 3, 3)], []).get('w') as RoutedWire
    expect(minDistance(w, compOf(r1, 'q1'))).toBeGreaterThanOrEqual(0.45 - 0.05)
  })
})

describe('routeAll: vertical mounts (span < 3)', () => {
  it('a short resistor stands vertical over endpoint A with a looping top lead', () => {
    const m = routeAll([resistor('rv', 0, 0, 2, 0, 2.2, 0.7)], [])
    const r = compOf(m, 'rv')
    expect(r.style).toBe('vertical')
    // body cylinder: starts y = 0.4, body.length tall, centered over A
    expect(r.bodyCenter.x).toBeCloseTo(0, 6)
    expect(r.bodyCenter.z).toBeCloseTo(0, 6)
    expect(r.bodyCenter.y).toBeCloseTo(0.4 + 2.2 / 2, 6)
    expect(r.bodyDir.x).toBeCloseTo(0, 6)
    expect(r.bodyDir.y).toBeCloseTo(1, 6)
    expect(r.bodyDir.z).toBeCloseTo(0, 6)
    expect(r.tilt).toBeUndefined()
    const bs = r.waypoints.find((p) => p.marker === 'bodyStart')!
    const be = r.waypoints.find((p) => p.marker === 'bodyEnd')!
    expect(bs.y).toBeCloseTo(0.4, 6)
    expect(be.y).toBeCloseTo(0.4 + 2.2, 6)
    // long lead rises to body top + 0.5 before arcing over to B
    const rise = r.waypoints[r.waypoints.indexOf(be) + 1]
    expect(rise.y).toBeCloseTo(0.4 + 2.2 + 0.5, 6)
    expect(rise.x).toBeCloseTo(be.x, 6)
    // and drops vertically into B
    const last = r.waypoints[r.waypoints.length - 1]
    const penultimate = r.waypoints[r.waypoints.length - 2]
    expect(last).toEqual({ x: 2, y: 0, z: 0 })
    expect(penultimate.x).toBe(2)
    expect(penultimate.z).toBe(0)
    expect(penultimate.y).toBeCloseTo(0.5, 5)
  })

  it('span-1 hairpin clears its own body and bands (user-reported self-clip)', () => {
    // 1-hole span: the old half-span loop midpoint sat INSIDE the body
    // envelope, shearing the lead through the proud color bands.
    const m = routeAll([resistor('r1span', 0, 0, 1, 0, 2.2, 0.7)], [])
    const r = compOf(m, 'r1span')
    expect(r.style).toBe('vertical')
    const bodyR = 0.7 / 2 + 0.1 // router fat margin
    const bodyTop = 0.4 + 2.2
    const be = r.waypoints.findIndex((p) => p.marker === 'bodyEnd')
    // walk the long-lead polyline densely; inside the body's height range the
    // lead must stay outside the band envelope (DESIGN.md §4b: legs collide)
    for (let i = be; i < r.waypoints.length - 1; i++) {
      const a = r.waypoints[i]
      const b = r.waypoints[i + 1]
      for (let t = 0; t <= 1.0001; t += 0.05) {
        const x = a.x + (b.x - a.x) * t
        const y = a.y + (b.y - a.y) * t
        const z = a.z + (b.z - a.z) * t
        if (y > 0.5 && y < bodyTop - 0.05) {
          const planDist = Math.hypot(x - 0, z - 0)
          // skip the lead's own final drop into B (outside the body anyway)
          expect(planDist).toBeGreaterThanOrEqual(bodyR + 0.05)
        }
      }
    }
    // the dive into B still lands exactly on B
    const last = r.waypoints[r.waypoints.length - 1]
    expect(last).toEqual({ x: 1, y: 0, z: 0 })
  })

  it('two adjacent vertical resistors tilt apart', () => {
    const m = routeAll(
      [resistor('v1', 0, 0, 2, 0, 2.2, 0.7), resistor('v2', 0, 1, 2, 1, 2.2, 0.7)],
      [],
    )
    const a = compOf(m, 'v1')
    const b = compOf(m, 'v2')
    expect(a.style).toBe('vertical')
    expect(b.style).toBe('vertical')
    // the first routes upright; the second leans AWAY from it (+z here)
    expect(a.bodyDir.y).toBeGreaterThan(0.999)
    expect(b.tilt ?? 0).toBeGreaterThan(0.1)
    expect(b.bodyDir.z).toBeGreaterThan(0.2)
    // the body tops diverge: separation at the top exceeds the 1-unit bases
    const topA = a.waypoints.find((p) => p.marker === 'bodyEnd')!
    const topB = b.waypoints.find((p) => p.marker === 'bodyEnd')!
    expect(Math.hypot(topB.x - topA.x, topB.z - topA.z)).toBeGreaterThan(1.3)
    // bodyDir stays unit-length under tilt
    expect(Math.hypot(b.bodyDir.x, b.bodyDir.y, b.bodyDir.z)).toBeCloseTo(1, 6)
  })
})

describe('routeOne: single-candidate previews', () => {
  it('matches routeAll with the same wire candidate appended', () => {
    const items: RouteItemInput[] = [
      resistor('ra', 0, 0, 10, 0),
      wire('w1', 0, 2, 14, 2),
      wire('w2', 3, -3, 3, 6),
    ]
    const obstacles: RouteObstacle[] = [{ minX: 4, maxX: 8, minZ: -1, maxZ: 1, height: 1.7 }]
    const world = routeAll(items, obstacles)
    const cand = wire('zz', 5, -2, 5, 3) // shortest span → routes last when appended
    const preview = routeOne(world, cand)
    const appended = routeAll([...items, cand], obstacles)
    expect(JSON.stringify(preview)).toBe(JSON.stringify(appended.get('zz')))
  })

  it('matches routeAll with a component candidate appended (component-only world)', () => {
    const comps: RouteItemInput[] = [resistor('ra', 0, 0, 10, 0), resistor('rb', 5, -5, 5, 5)]
    const world = routeAll(comps, [])
    const cand = resistor('rz', 0, 3, 6, 3) // shortest component span → routes last
    const preview = routeOne(world, cand)
    const appended = routeAll([...comps, cand], [])
    expect(JSON.stringify(preview)).toBe(JSON.stringify(appended.get('rz')))
  })

  it('matches routeAll insertion for a wire candidate LONGER than every routed wire', () => {
    // parallel runs 0.2 apart, both apex-capped at 2.2 → certain conflict. On
    // commit the longer candidate routes FIRST among wires and takes the
    // clean tier-0 path while w1 dodges; the preview must show that exact
    // clean path, not a dodge around w1 (which routes after it).
    const items: RouteItemInput[] = [resistor('ra', 0, -4, 10, -4), wire('w1', 0, 2, 25, 2)]
    const world = routeAll(items, [])
    const cand = wire('zz', -2, 2.2, 28, 2.2) // span 30 > w1's 25
    const preview = routeOne(world, cand) as RoutedWire
    const committed = routeAll([...items, cand], [])
    expect(JSON.stringify(preview)).toBe(JSON.stringify(committed.get('zz')))
    expect(midZ(preview, 13)).toBeCloseTo(2.2, 6) // clean path: no lateral dodge
    expect(maxY(preview)).toBeCloseTo(2.2, 6) // …and no lift tier (cap 2.2)
  })

  it('matches the committed pose for a component candidate on a wired board (ghost = commit)', () => {
    // two wires cross the candidate's span right where its body sits — the
    // old whole-world preview lifted/dodged the ghost, but on commit
    // components route BEFORE all wires and land in the clean base pose
    const items: RouteItemInput[] = [
      wire('w1', 2, -3, 2, 5),
      wire('w2', 4, -3, 4, 5),
    ]
    const world = routeAll(items, [])
    const cand = resistor('rz', 0, 1, 6, 1)
    const preview = routeOne(world, cand)
    const committed = routeAll([...items, cand], [])
    expect(JSON.stringify(preview)).toBe(JSON.stringify(committed.get('rz')))
    const pose = preview as RoutedComponentPath
    expect(pose.style).toBe('span')
    // clean grounded base height (bodyR 0.45 + 0.18 ground clear) — wires ignored
    expect(pose.bodyCenter.y).toBeCloseTo(0.63, 6)
    expect(pose.bodyCenter.z).toBeCloseTo(1, 6)
  })

  it('does not mutate the world (repeatable previews)', () => {
    const items: RouteItemInput[] = [resistor('ra', 0, 0, 10, 0), wire('w1', 0, 2, 14, 2)]
    const world = routeAll(items, [])
    const before = serialize(world)
    const cand = wire('zz', 5, -2, 5, 3)
    const first = JSON.stringify(routeOne(world, cand))
    const second = JSON.stringify(routeOne(world, cand))
    expect(second).toBe(first)
    expect(world.has('zz')).toBe(false)
    expect(serialize(world)).toBe(before)
  })

  it('throws on a world that did not come from routeAll', () => {
    expect(() => routeOne(new Map(), wire('w', 0, 0, 4, 0))).toThrow()
  })
})

describe('routeAll: mixed determinism', () => {
  const items: RouteItemInput[] = [
    resistor('ra', 0, 0, 10, 0),
    resistor('rv', 4, 6, 6, 6, 2.2, 0.7),
    resistor('rb', 5, -5, 5, 5),
    wire('w1', 0, 2, 14, 2),
    wire('w2', 3, -3, 3, 6),
    wire('w3', 5, -4, 5, 4),
  ]
  const obstacles: RouteObstacle[] = [{ minX: 8, maxX: 12, minZ: -0.5, maxZ: 2.5, height: 1.7 }]

  it('two runs produce identical results', () => {
    const r1 = routeAll(items, obstacles)
    const r2 = routeAll(
      items.map((i) => ({ ...i })),
      obstacles.map((o) => ({ ...o })),
    )
    expect(serialize(r1)).toBe(serialize(r2))
  })

  it('input order does not matter (components first, span desc, id asc)', () => {
    const r1 = routeAll(items, obstacles)
    const r2 = routeAll([...items].reverse(), obstacles)
    expect(serialize(r1)).toBe(serialize(r2))
  })
})

describe('routeAll: performance', () => {
  it('routes 100 components + 200 wires in < 800ms with zero NaNs', () => {
    const rand = mulberry32(0xcafe)
    const items: RouteItemInput[] = []
    for (let i = 0; i < 60; i++) {
      const ax = 1 + rand() * 50
      const az = rand() * 16
      items.push(resistor(`r${i}`, ax, az, ax + 4 + rand() * 5, az)) // span parts
    }
    for (let i = 0; i < 40; i++) {
      const ax = 1 + rand() * 60
      const az = rand() * 16
      items.push(resistor(`v${i}`, ax, az, ax + 2, az, 2.2, 0.7)) // vertical mounts
    }
    for (let i = 0; i < 200; i++) {
      items.push(wire(`w${i}`, 1 + rand() * 62, rand() * 16, 1 + rand() * 62, rand() * 16))
    }
    const obstacles: RouteObstacle[] = []
    for (let i = 0; i < 12; i++) {
      const x = 1 + rand() * 55
      const z = rand() * 14
      obstacles.push({
        minX: x,
        maxX: x + 2 + rand() * 6,
        minZ: z,
        maxZ: z + 2,
        height: 1.2 + rand() * 0.5,
      })
    }
    const t0 = performance.now()
    const m = routeAll(items, obstacles)
    const elapsed = performance.now() - t0
    expect(m.size).toBe(300)
    expect(elapsed).toBeLessThan(800) // CI headroom; target is well under 80ms
    for (const r of m.values()) expect(hasNaN(r as Pathy)).toBe(false)
  })
})

describe('toRoutedPose: render-contract adapter', () => {
  it('splits a span path into per-lead runs from each hole to the body exits', () => {
    const r = compOf(routeAll([resistor('ra', 0, 0, 10, 0)], []), 'ra')
    const pose = toRoutedPose(r)
    expect(pose.pose).toBe('span')
    expect(pose.bodyCenter).toEqual(r.bodyCenter)
    expect(pose.bodyDir).toEqual(r.bodyDir)
    expect(pose.waypoints).toHaveLength(2)
    const [leadA, leadB] = pose.waypoints
    expect(leadA.length).toBeGreaterThanOrEqual(2)
    expect(leadB.length).toBeGreaterThanOrEqual(2)
    // each lead starts at its hole (y = 0) and ends at the body lead exit
    expect(leadA[0].x).toBe(0)
    expect(leadA[0].y).toBe(0)
    expect(leadB[0].x).toBe(10)
    expect(leadB[0].y).toBe(0)
    const bs = r.waypoints.find((p) => p.marker === 'bodyStart')!
    const be = r.waypoints.find((p) => p.marker === 'bodyEnd')!
    expect(leadA[leadA.length - 1].x).toBeCloseTo(bs.x, 6)
    expect(leadA[leadA.length - 1].y).toBeCloseTo(bs.y, 6)
    expect(leadB[leadB.length - 1].x).toBeCloseTo(be.x, 6)
    expect(leadB[leadB.length - 1].y).toBeCloseTo(be.y, 6)
  })

  it('vertical mounts get a short bottom lead and a hairpin top lead', () => {
    const r = compOf(routeAll([resistor('rv', 0, 0, 2, 0, 2.2, 0.7)], []), 'rv')
    const pose = toRoutedPose(r)
    expect(pose.pose).toBe('vertical')
    const [leadA, leadB] = pose.waypoints
    // bottom lead: hole straight up into the body base
    expect(leadA[0]).toEqual({ x: 0, y: 0, z: 0 })
    expect(leadA[leadA.length - 1].y).toBeCloseTo(0.4, 6)
    // top lead: from the B hole up, over the top, ending at the body top
    expect(leadB[0]).toEqual({ x: 2, y: 0, z: 0 })
    const exit = leadB[leadB.length - 1]
    expect(exit.y).toBeCloseTo(0.4 + 2.2, 6)
    expect(Math.max(...leadB.map((p) => p.y))).toBeGreaterThan(0.4 + 2.2 + 0.4)
  })
})

// ------------------------------------- instrument threading (wires.ts, Phase C)

describe('instrumentsForLayout + planRoutes instrument threading', () => {
  const psu = (pos?: { x: number; z: number }) => ({
    id: 'PS1',
    type: 'power_supply',
    params: { voltage: 5 },
    ...(pos ? { pos } : {}),
  })

  it('derives slot-ordered obstacle boxes with +z terminal exits, pos honored', async () => {
    const { instrumentsForLayout } = await import('../src/three/internal/wires')
    const { offboardBodyRect, offboardTerminalPosition, OFFBOARD_BODY_HEIGHT } = await import(
      '../src/model/breadboard'
    )
    const layout = {
      version: 1 as const,
      components: [psu(), { id: 'FG1', type: 'function_generator', pos: { x: 30, z: 24.5 } }],
      wires: [],
    }
    const insts = instrumentsForLayout(layout)
    expect(insts.map((i) => i.id)).toEqual(['PS1', 'FG1'])
    // slot 0, legacy shelf
    const r0 = offboardBodyRect(0)
    expect(insts[0]).toMatchObject({ ...r0, height: OFFBOARD_BODY_HEIGHT })
    const t0 = offboardTerminalPosition(0, 0)
    expect(insts[0].terminals[0]).toMatchObject({ x: t0.x, z: t0.z })
    for (const t of insts[0].terminals) expect(t.exitDir).toEqual({ x: 0, z: 1 })
    // slot 1, explicit bench pos overrides the shelf formula
    const r1 = offboardBodyRect(1, { x: 30, z: 24.5 })
    expect(insts[1]).toMatchObject(r1)
    const t1 = offboardTerminalPosition(1, 1, { x: 30, z: 24.5 })
    expect(insts[1].terminals[1]).toMatchObject({ x: t1.x, z: t1.z })
  })

  it('caches terminal wires against the pos-aware endpoints and replans on instrument moves', async () => {
    const { planRoutes, planVersion, routedWireSignature, TERMINAL_TOP_Y } = await import(
      '../src/three/internal/wires'
    )
    const { offboardTerminalPosition, holePosition, parseHole } = await import(
      '../src/model/breadboard'
    )
    const pos = { x: 20, z: 24 } // explicit bench position right of the shelf
    const layout = {
      version: 1 as const,
      components: [psu(pos)],
      wires: [{ id: 'W1', from: 'PS1:+', to: 'a5', color: 'red' }],
    }
    planRoutes(layout)
    const v1 = planVersion()
    // idempotent: re-planning the identical layout recomputes nothing
    planRoutes(layout)
    expect(planVersion()).toBe(v1)
    // the cached route is keyed on the EXPLICIT-pos terminal endpoint — a
    // shelf-formula resolver would produce a different key and miss here
    const tp = offboardTerminalPosition(0, 0, pos)
    const hp = holePosition(parseHole('a5')!)
    const a = new THREE.Vector3(tp.x, TERMINAL_TOP_Y, tp.z)
    const b = new THREE.Vector3(hp.x, 0, hp.z)
    expect(routedWireSignature('W1', a, b)).not.toBe('')
    // moving the instrument folds into the plan signature → full replan
    const moved = {
      ...layout,
      components: [psu({ x: 40, z: 30 })],
    }
    planRoutes(moved)
    expect(planVersion()).toBe(v1 + 1)
  })
})

// =========================================================================
// Standing routed bodies (LED) — the packed-LED noclip fix (DESIGN.md §4b:
// "adjacent identical parts at 1-column spacing ... bodies must not touch",
// explicitly including LEDs, which the user reported noclipping)
// =========================================================================

describe('standing LED bodies: packed nesting + dome protection', () => {
  /**
   * Rendered LED solid as bands around the routed center c (semis.ts
   * constants): flange r 0.70 over [c−0.40, c−0.25], epoxy cylinder r 0.62
   * over [c−0.40, c+0.36], dome treated as a full-radius cylinder (taper
   * ignored — conservative) over [c+0.36, c+0.98].
   */
  const LED_BANDS: { r: number; lo: number; hi: number }[] = [
    { r: 0.7, lo: -0.4, hi: -0.25 },
    { r: 0.62, lo: -0.4, hi: 0.36 },
    { r: 0.62, lo: 0.36, hi: 0.98 },
  ]

  it('three LEDs in neighboring columns (parallel spans) nest without touching', async () => {
    const { planRoutes, routedComponentPose } = await import('../src/three/internal/wires')
    const layout = {
      version: 1 as const,
      components: [
        { id: 'D1', type: 'led', params: { color: 'red' }, holes: ['b10', 'b14'] },
        { id: 'D2', type: 'led', params: { color: 'green' }, holes: ['b11', 'b15'] },
        { id: 'D3', type: 'led', params: { color: 'yellow' }, holes: ['b12', 'b16'] },
      ],
      wires: [],
    }
    planRoutes(layout as never)
    const poses = ['D1', 'D2', 'D3'].map((id) => {
      const pose = routedComponentPose(id)
      expect(pose, `${id} must be routed`).not.toBeNull()
      expect(pose!.pose).toBe('span') // standing bodies always span-route
      return pose!
    })
    // ZERO interpenetration of the rendered solids, every pair
    for (let i = 0; i < poses.length; i++) {
      for (let j = i + 1; j < poses.length; j++) {
        const a = poses[i].bodyCenter
        const b = poses[j].bodyCenter
        const plan = Math.hypot(a.x - b.x, a.z - b.z)
        for (const ba of LED_BANDS) {
          for (const bb of LED_BANDS) {
            const overlap =
              Math.min(a.y + ba.hi, b.y + bb.hi) - Math.max(a.y + ba.lo, b.y + bb.lo)
            if (overlap <= 0) continue // vertically disjoint bands cannot touch
            expect(
              plan,
              `D${i + 1}/D${j + 1} bands r${ba.r}/r${bb.r} must not interpenetrate`,
            ).toBeGreaterThanOrEqual(ba.r + bb.r - 1e-6)
          }
        }
      }
    }
    // ...and every LED still reaches its own holes (legs from the holes)
    for (const [i, id] of (['D1', 'D2', 'D3'] as const).entries()) {
      const pose = poses[i]
      expect(pose.waypoints).toHaveLength(2)
      expect(pose.waypoints[0][0].x).toBeCloseTo(10 + i, 6)
      expect(pose.waypoints[1][0].x).toBeCloseTo(14 + i, 6)
    }
  })

  it('a routed LED KEEPS its 1.9-high obstacle box (wires stay walled off the dome)', async () => {
    const { obstaclesForLayout, planRoutes, routedComponentPose } = await import(
      '../src/three/internal/wires'
    )
    const layout = {
      version: 1 as const,
      components: [{ id: 'D1', type: 'led', params: { color: 'red' }, holes: ['b10', 'b14'] }],
      wires: [],
    }
    // dual mechanism: the box for wires AND the routed pose for body nesting
    const obstacles = obstaclesForLayout(layout as never)
    expect(obstacles).toHaveLength(1)
    expect(obstacles[0].height).toBe(1.9)
    planRoutes(layout as never)
    expect(routedComponentPose('D1')).not.toBeNull()
  })

  it('a wire plugged INSIDE the LED box still cannot pass through the dome (column samples)', async () => {
    const { obstaclesForLayout } = await import('../src/three/internal/wires')
    const layout = {
      version: 1 as const,
      components: [{ id: 'D1', type: 'led', params: { color: 'red' }, holes: ['b10', 'b14'] }],
      wires: [],
    }
    const obstacles = obstaclesForLayout(layout as never)
    // both wire endpoints sit inside the LED's box → the box is endpoint-
    // skipped (pre-fix, the wire stapled straight THROUGH the dome). The
    // standing body column must still force it over or around.
    const m = routeAll(
      [
        {
          id: 'D1',
          kind: 'component',
          ax: 10,
          az: 4,
          bx: 14,
          bz: 4,
          body: { length: 1.5, diameter: 0.8, standing: 1.45 },
        },
        wire('w1', 11, 4, 13, 4),
      ],
      obstacles,
    )
    const led = compOf(m, 'D1')
    const w = m.get('w1') as RoutedWire
    const c = led.bodyCenter
    const domeTop = c.y + 0.98
    for (const p of densify(w)) {
      const plan = Math.hypot(p.x - c.x, p.z - c.z)
      if (plan < 0.62) {
        expect(p.y, 'wire point over the dome axis must clear the dome').toBeGreaterThanOrEqual(
          domeTop,
        )
      }
    }
  })
})
