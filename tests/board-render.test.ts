/**
 * Tests for the scene agent's size-aware board layer:
 * HoleIndex (pointer→hole snapping, rebuildable per board preset) and
 * buildBoard (board mesh: instanced hole rims/insets, extents, shadows,
 * dispose). Runs in node — the decal CanvasTextures degrade away by design.
 */
import { describe, expect, it } from 'vitest'
import * as THREE from 'three'
import { BOARD_SIZES, type BoardSizeId } from '../src/model/types'
import { BOARD_ROW_PITCH, boardExtents } from '../src/model/breadboard'
import { HoleIndex } from '../src/three/internal/hole-index'
import { buildBoard } from '../src/three/internal/board'

const SIZES: BoardSizeId[] = ['half', 'standard', 'labxl']

describe('HoleIndex (size-aware)', () => {
  it('defaults to the standard board', () => {
    const idx = new HoleIndex()
    expect(idx.size).toBe('standard')
    expect(idx.count).toBe(BOARD_SIZES.standard.points) // 830
  })

  it('indexes exactly the preset point count for every size', () => {
    for (const size of SIZES) {
      const idx = new HoleIndex(size)
      expect(idx.size).toBe(size)
      expect(idx.count).toBe(BOARD_SIZES[size].points)
    }
  })

  it('snaps to strip and rail holes at their breadboard.ts positions', () => {
    const idx = new HoleIndex('standard')
    expect(idx.nearest(1, 3, 0.55)).toBe('a1') // col 1, row a (z=3)
    expect(idx.nearest(63.2, 13.1, 0.55)).toBe('j63')
    expect(idx.nearest(2.5, 0, 0.55)).toBe('top+0')
    // rail index 49: x = 2.5 + 49 + floor(49/5) = 60.5
    expect(idx.nearest(60.5, 16, 0.55)).toBe('bot+49')
  })

  it('rebuild() switches presets: labxl gains far columns, half loses them', () => {
    const idx = new HoleIndex('standard')
    expect(idx.nearest(100, 3, 0.55)).toBeNull() // col 100 not on standard
    idx.rebuild('labxl')
    expect(idx.size).toBe('labxl')
    expect(idx.nearest(100, 3, 0.55)).toBe('a100')
    // last labxl rail hole: index 99 → x = 2.5 + 99 + 19 = 120.5
    expect(idx.nearest(120.5, 0, 0.55)).toBe('top+99')
    idx.rebuild('half')
    expect(idx.count).toBe(BOARD_SIZES.half.points) // 400
    expect(idx.nearest(31, 3, 0.55)).toBeNull() // col 31 off the half board
    expect(idx.nearest(30, 3, 0.55)).toBe('a30')
  })

  it('respects the max snap distance', () => {
    const idx = new HoleIndex('standard')
    expect(idx.nearest(1.4, 3, 0.3)).toBeNull()
    expect(idx.nearest(1.4, 3, 0.55)).toBe('a1')
  })
})

function instancedByName(group: THREE.Group, name: string): THREE.InstancedMesh {
  let found: THREE.InstancedMesh | null = null
  group.traverse((o) => {
    if (o.name === name && (o as THREE.InstancedMesh).isInstancedMesh) {
      found = o as THREE.InstancedMesh
    }
  })
  if (!found) throw new Error(`instanced mesh missing: ${name}`)
  return found
}

describe('buildBoard (size-aware mesh)', () => {
  it('builds one hole inset + one beveled rim instance per hole, per size', () => {
    for (const size of SIZES) {
      const board = buildBoard(1, size)
      expect(board.size).toBe(size)
      expect(instancedByName(board.group, 'board-holes').count).toBe(BOARD_SIZES[size].points)
      expect(instancedByName(board.group, 'board-hole-rims').count).toBe(BOARD_SIZES[size].points)
      board.dispose()
    }
  })

  it('body spans the preset extents (top at y=0, slab 1.2 thick)', () => {
    for (const size of SIZES) {
      const board = buildBoard(1, size)
      const ext = boardExtents(size)
      const box = new THREE.Box3()
      board.group.traverse((o) => {
        const mesh = o as THREE.Mesh
        if (!mesh.isMesh || mesh.geometry.type !== 'ExtrudeGeometry') return
        mesh.geometry.computeBoundingBox()
        if (mesh.geometry.boundingBox) box.union(mesh.geometry.boundingBox)
      })
      expect(box.isEmpty()).toBe(false)
      expect(box.min.x).toBeCloseTo(ext.minX, 1)
      expect(box.max.x).toBeCloseTo(ext.maxX, 1)
      expect(box.min.z).toBeCloseTo(ext.minZ, 1)
      expect(box.max.z).toBeCloseTo(ext.maxZ, 1)
      expect(box.max.y).toBeCloseTo(0, 1)
      expect(box.min.y).toBeCloseTo(-1.2, 1)
      board.dispose()
    }
  })

  it('slabs cast + receive the scene shadow map; instanced holes receive', () => {
    const board = buildBoard(1, 'standard')
    const extrudes: THREE.Mesh[] = []
    board.group.traverse((o) => {
      const mesh = o as THREE.Mesh
      if (mesh.isMesh && mesh.geometry?.type === 'ExtrudeGeometry') extrudes.push(mesh)
    })
    expect(extrudes.length).toBe(2)
    for (const slab of extrudes) {
      expect(slab.castShadow).toBe(true)
      expect(slab.receiveShadow).toBe(true)
    }
    expect(instancedByName(board.group, 'board-hole-rims').receiveShadow).toBe(true)
    board.dispose()
  })

  it('uses PBR physical materials (molded ABS with clearcoat)', () => {
    const board = buildBoard(1, 'standard')
    const mats = new Set<THREE.Material>()
    board.group.traverse((o) => {
      const mesh = o as THREE.Mesh
      if (mesh.isMesh && !Array.isArray(mesh.material)) mats.add(mesh.material)
    })
    const physical = [...mats].filter(
      (m): m is THREE.MeshPhysicalMaterial => (m as THREE.MeshPhysicalMaterial).isMeshPhysicalMaterial === true,
    )
    expect(physical.length).toBeGreaterThanOrEqual(3) // body, channel, rims, insets
    const body = physical.find((m) => m.clearcoat > 0)
    expect(body).toBeDefined()
    board.dispose()
  })

  it('dispose() is idempotent and frees per-board resources', () => {
    const board = buildBoard(1, 'labxl')
    expect(() => {
      board.dispose()
      board.dispose()
    }).not.toThrow()
  })
})

// ---------------------------------------------------------------------------
// Recessed hole sockets (collar funnel + dark shaft bore + plug)
// ---------------------------------------------------------------------------

function allInstancedByName(group: THREE.Group, name: string): THREE.InstancedMesh[] {
  const found: THREE.InstancedMesh[] = []
  group.traverse((o) => {
    if (o.name === name && (o as THREE.InstancedMesh).isInstancedMesh) {
      found.push(o as THREE.InstancedMesh)
    }
  })
  return found
}

describe('buildBoard hole sockets read with depth', () => {
  it('adds a shaft bore instance per hole between the collar rim and the plug', () => {
    const board = buildBoard(1, 'standard')
    const shafts = instancedByName(board.group, 'board-hole-shafts')
    expect(shafts.count).toBe(BOARD_SIZES.standard.points)

    // collar rim top must sit clearly ABOVE the plug top: that parallax is
    // the socket depth at inspection zoom
    const rims = instancedByName(board.group, 'board-hole-rims')
    const plugs = instancedByName(board.group, 'board-holes')
    const rimMtx = new THREE.Matrix4()
    rims.getMatrixAt(0, rimMtx)
    rims.geometry.computeBoundingBox()
    const rimTop = rims.geometry.boundingBox!.max.y + new THREE.Vector3().setFromMatrixPosition(rimMtx).y
    const plugMtx = new THREE.Matrix4()
    plugs.getMatrixAt(0, plugMtx)
    plugs.geometry.computeBoundingBox()
    const plugTop =
      plugs.geometry.boundingBox!.max.y + new THREE.Vector3().setFromMatrixPosition(plugMtx).y
    expect(rimTop - plugTop).toBeGreaterThanOrEqual(0.045)
    // the bore interior is what the camera sees → BackSide material
    expect((shafts.material as THREE.MeshPhysicalMaterial).side).toBe(THREE.BackSide)
    board.dispose()
  })
})

// ---------------------------------------------------------------------------
// Multi-board rigs (BoardConfig.count > 1)
// ---------------------------------------------------------------------------

describe('HoleIndex (multi-board rigs)', () => {
  it('indexes the full rig and snaps to far-module holes', () => {
    const idx = new HoleIndex({ size: 'standard', count: 2 })
    expect(idx.size).toBe('standard')
    expect(idx.config.count).toBe(2)
    expect(idx.count).toBe(BOARD_SIZES.standard.points * 2)
    expect(idx.nearest(100, 3, 0.55)).toBe('a100') // module 2 column
    // rail numbering continues: index 51 → x = 2.5 + 51 + 10 = 63.5
    expect(idx.nearest(63.5, 0, 0.55)).toBe('top+51')
    idx.rebuild('standard') // bare size id = back to a single board
    expect(idx.count).toBe(BOARD_SIZES.standard.points)
    expect(idx.nearest(100, 3, 0.55)).toBeNull()
  })
})

describe('buildBoard (multi-board lab-station rig)', () => {
  it('tiles per-module terminal slabs ABUTTING at every seam + continuous bus strips', () => {
    const config = { size: 'standard' as BoardSizeId, count: 3 }
    const board = buildBoard(1, config)
    expect(board.config).toEqual(config)
    expect(board.modules.length).toBe(3)

    const ext = boardExtents(config)
    const seam1 = BOARD_SIZES.standard.cols + 0.5 // 63.5
    const seam2 = 2 * BOARD_SIZES.standard.cols + 0.5

    // SEAMLESS TILING (user acceptance): module n's hull ends exactly where
    // module n+1's begins — maxX of one slice == minX of the next, with the
    // thin V-groove seam cut INTO the plastic (bevel insets), never a
    // see-through air gap to the desk
    for (let k = 0; k < 3; k++) {
      const sliceX0 = k === 0 ? ext.minX : k * BOARD_SIZES.standard.cols + 0.5
      const sliceX1 = k === 2 ? ext.maxX : (k + 1) * BOARD_SIZES.standard.cols + 0.5
      const box = new THREE.Box3()
      board.modules[k].traverse((o) => {
        const mesh = o as THREE.Mesh
        if (!mesh.isMesh || mesh.geometry.type !== 'ExtrudeGeometry') return
        mesh.geometry.computeBoundingBox()
        box.union(mesh.geometry.boundingBox!)
      })
      expect(box.isEmpty()).toBe(false)
      expect(box.min.x).toBeCloseTo(sliceX0, 2)
      expect(box.max.x).toBeCloseTo(sliceX1, 2)
    }

    // the power-rail bus strips run continuously across the whole rig (the
    // rails are bused into single nets; rail holes land exactly on seams —
    // e.g. top+51 at x = 63.5 — so per-module rail bodies are impossible).
    // They are direct children of the board-ROW group (each board-row of a
    // 2-D grid is a full rig row and springs in/out with its own rails).
    const busBox = new THREE.Box3()
    for (const child of board.rowGroups[0].children) {
      if (child.type !== 'Mesh') continue
      const mesh = child as THREE.Mesh
      if (mesh.geometry.type !== 'ExtrudeGeometry') continue
      mesh.geometry.computeBoundingBox()
      busBox.union(mesh.geometry.boundingBox!)
    }
    expect(busBox.isEmpty()).toBe(false)
    expect(busBox.min.x).toBeCloseTo(ext.minX, 1)
    expect(busBox.max.x).toBeCloseTo(ext.maxX, 1)
    expect(busBox.min.x).toBeLessThan(seam1)
    expect(busBox.max.x).toBeGreaterThan(seam2)

    // one socket per hole across the whole rig (rims + shafts + plugs)
    for (const name of ['board-holes', 'board-hole-rims', 'board-hole-shafts']) {
      const total = allInstancedByName(board.group, name).reduce((n, im) => n + im.count, 0)
      expect(total, name).toBe(BOARD_SIZES.standard.points * 3)
    }

    board.dispose()
  })

  it('single-board builds keep the classic two-slab construction', () => {
    const board = buildBoard(1, { size: 'half', count: 1 })
    expect(board.modules.length).toBe(1)
    const extrudes: THREE.Mesh[] = []
    board.group.traverse((o) => {
      const mesh = o as THREE.Mesh
      if (mesh.isMesh && mesh.geometry?.type === 'ExtrudeGeometry') extrudes.push(mesh)
    })
    expect(extrudes.length).toBe(2)
    board.dispose()
  })

  it('multi-board dispose() is idempotent', () => {
    const board = buildBoard(1, { size: 'half', count: 6 })
    expect(() => {
      board.dispose()
      board.dispose()
    }).not.toThrow()
  })
})

// ---------------------------------------------------------------------------
// Phase C: 2-D board-row grids (rows × count modules)
// ---------------------------------------------------------------------------

describe('HoleIndex (2-D board-row grids)', () => {
  it('indexes rows × points holes and snaps to deep-row holes at their offsets', () => {
    const idx = new HoleIndex({ size: 'half', count: 1, rows: 3 })
    expect(idx.count).toBe(BOARD_SIZES.half.points * 3)
    // row 0 stays canonical-bare; row 2 of the grid sits 2 × 22 units deeper
    expect(idx.nearest(1, 3, 0.55)).toBe('a1')
    expect(idx.nearest(1, 3 + 2 * BOARD_ROW_PITCH, 0.55)).toBe('2:a1')
    expect(idx.nearest(2.5, 2 * BOARD_ROW_PITCH, 0.55)).toBe('2:top+0')
    // nothing lives on the molded seam line between abutting rows (midway
    // between row 0's bot+ rail and row 1's top+ rail)
    expect(idx.nearest(10, 17.75, 0.55)).toBeNull()
  })

  it('rebuild keys on rows: same size × count with different rows repopulates', () => {
    const idx = new HoleIndex({ size: 'half', count: 1 })
    expect(idx.nearest(1, BOARD_ROW_PITCH + 3, 0.55)).toBeNull()
    idx.rebuild({ size: 'half', count: 1, rows: 2 })
    expect(idx.nearest(1, BOARD_ROW_PITCH + 3, 0.55)).toBe('1:a1')
    expect(idx.count).toBe(BOARD_SIZES.half.points * 2)
  })
})

describe('buildBoard (2-D board-row grids)', () => {
  it('builds one full rig row per board-row at its boardRowZs offset', () => {
    const config = { size: 'half' as BoardSizeId, count: 1, rows: 3 }
    const board = buildBoard(1, config)
    expect(board.rowGroups.length).toBe(3)
    expect(board.moduleGroups.length).toBe(3)
    expect(board.modules).toBe(board.moduleGroups[0]) // back-compat alias
    board.rowGroups.forEach((g, r) => {
      expect(g.position.z).toBeCloseTo(r * BOARD_ROW_PITCH, 6)
    })
    // every row carries a full socket set (front-row-local positions)
    for (const name of ['board-holes', 'board-hole-rims', 'board-hole-shafts']) {
      for (let r = 0; r < 3; r++) {
        const rowTotal = allInstancedByName(board.rowGroups[r], name).reduce(
          (n, im) => n + im.count,
          0,
        )
        expect(rowTotal, `${name} row ${r}`).toBe(BOARD_SIZES.half.points)
      }
    }
    board.dispose()
  })

  it('rows share slab geometry: meshes scale with rows, geometries do not', () => {
    const one = buildBoard(1, { size: 'half', count: 1 })
    const oneGeos = new Set<THREE.BufferGeometry>()
    one.group.traverse((o) => {
      const mesh = o as THREE.Mesh
      if (mesh.isMesh && mesh.geometry?.type === 'ExtrudeGeometry') oneGeos.add(mesh.geometry)
    })
    const four = buildBoard(1, { size: 'half', count: 1, rows: 4 })
    const fourGeos = new Set<THREE.BufferGeometry>()
    let fourMeshes = 0
    four.group.traverse((o) => {
      const mesh = o as THREE.Mesh
      if (mesh.isMesh && mesh.geometry?.type === 'ExtrudeGeometry') {
        fourGeos.add(mesh.geometry)
        fourMeshes++
      }
    })
    // geometry stays ROW-COUNT-FREE: at most one extra square-cornered
    // variant per slab kind (interior row edges abut flush — the rounded
    // outline corners survive only on the rig's outer front/back rows)
    expect(fourGeos.size).toBeLessThanOrEqual(oneGeos.size * 2)
    expect(fourMeshes).toBe(oneGeos.size * 4)
    one.dispose()
    four.dispose()
  })

  it('multi-module multi-row grids keep per-row bus strips spanning the rig', () => {
    const config = { size: 'half' as BoardSizeId, count: 2, rows: 2 }
    const board = buildBoard(1, config)
    const ext = boardExtents({ size: 'half', count: 2 }) // one row's extents
    for (let r = 0; r < 2; r++) {
      const busBox = new THREE.Box3()
      for (const child of board.rowGroups[r].children) {
        const mesh = child as THREE.Mesh
        if (!mesh.isMesh || mesh.geometry.type !== 'ExtrudeGeometry') continue
        mesh.geometry.computeBoundingBox()
        busBox.union(mesh.geometry.boundingBox!)
      }
      expect(busBox.isEmpty()).toBe(false)
      expect(busBox.min.x).toBeCloseTo(ext.minX, 1)
      expect(busBox.max.x).toBeCloseTo(ext.maxX, 1)
    }
    expect(board.moduleGroups[1].length).toBe(2)
    board.dispose()
  })

  it('2-D grid dispose() is idempotent', () => {
    const board = buildBoard(1, { size: 'standard', count: 2, rows: 4 })
    expect(() => {
      board.dispose()
      board.dispose()
    }).not.toThrow()
  })
})
