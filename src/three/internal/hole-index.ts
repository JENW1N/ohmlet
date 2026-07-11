/**
 * Precomputed hole position index for fast pointer→hole snapping.
 * Built from the breadboard helpers (never re-derives hole math) and
 * RIG-AWARE: rebuild(config) repopulates the index for a board preset or a
 * multi-module rig (BoardConfig) when the active layout's board changes
 * (scene.setLayout drives this). Bare size ids keep meaning "one board".
 */

import { allHoles, formatHole, holePosition } from '../../model/breadboard'
import {
  asBoardConfig,
  boardRowsOf,
  type BoardConfig,
  type BoardSizeId,
  type HoleRef,
} from '../../model/types'

export class HoleIndex {
  private xs: Float64Array = new Float64Array(0)
  private zs: Float64Array = new Float64Array(0)
  private refs: HoleRef[] = []
  private builtKey: string | null = null
  private builtConfig: BoardConfig = { size: 'standard', count: 1 }

  constructor(config: BoardConfig | BoardSizeId = 'standard') {
    this.rebuild(config)
  }

  /** The board size preset the index is currently built for. */
  get size(): BoardSizeId {
    return this.builtConfig.size
  }

  /** The full rig (size × module count) the index is currently built for. */
  get config(): BoardConfig {
    return this.builtConfig
  }

  /** Repopulate for a rig (no-op when already built for it). 2-D grids
   *  (config.rows > 1) index every board-row — allHoles iterates the grid. */
  rebuild(config: BoardConfig | BoardSizeId): void {
    const c = asBoardConfig(config)
    const key = `${c.size}x${c.count}x${boardRowsOf(c)}`
    if (key === this.builtKey) return
    const refs: HoleRef[] = []
    const xs: number[] = []
    const zs: number[] = []
    for (const h of allHoles(c)) {
      refs.push(formatHole(h))
      const p = holePosition(h)
      xs.push(p.x)
      zs.push(p.z)
    }
    this.refs = refs
    this.xs = Float64Array.from(xs)
    this.zs = Float64Array.from(zs)
    this.builtConfig = c
    this.builtKey = key
  }

  /** Number of holes indexed (= the rig's marketing "point" count). */
  get count(): number {
    return this.refs.length
  }

  /** Nearest hole to plan point (x, z) within maxDist units, else null. */
  nearest(x: number, z: number, maxDist: number): HoleRef | null {
    const xs = this.xs
    const zs = this.zs
    let best = -1
    let bestD = maxDist * maxDist
    for (let i = 0; i < xs.length; i++) {
      const dx = xs[i] - x
      const dz = zs[i] - z
      const d = dx * dx + dz * dz
      if (d <= bestD) {
        bestD = d
        best = i
      }
    }
    return best >= 0 ? this.refs[best] : null
  }
}
