/**
 * Net extraction for the simulator: union-find over static net ids.
 * Owned by the sim-core agent.
 *
 * Seeds a net for every hole actually used by components/wires plus the four
 * power rails, then merges nets across wires and catalog `internalBridges`.
 */

import type {
  BoardConfig,
  CircuitLayout,
  ComponentInstance,
  EndpointRef,
  Hole,
} from '../model/types'
import { isBoardCount, isBoardRows, isBoardSizeId, RAILS } from '../model/types'
import {
  componentPinHoles,
  netIdForHole,
  netIdForTerminal,
  parseHole,
  parseTerminalRef,
} from '../model/breadboard'
import { getEntry } from '../model/catalog'
import type { CatalogEntry } from '../model/catalog'

export interface Netlist {
  /**
   * Resolved (merged) net id of an endpoint ref. Accepts hole refs ("a12",
   * "top+5") and off-board terminal refs ("PS1:+"). Returns null for refs
   * that do not parse, reference unknown terminals, or holes whose strip is
   * not used by the circuit.
   */
  netOf(ref: EndpointRef): string | null
  /** All distinct net ids after merging (sorted, deterministic). */
  nets: string[]
  /** Net used as the 0V reference (null only when the board has no nets). */
  ground: string | null
  warnings: string[]
}

class UnionFind {
  private readonly parent = new Map<string, string>()

  add(id: string): void {
    if (!this.parent.has(id)) this.parent.set(id, id)
  }

  has(id: string): boolean {
    return this.parent.has(id)
  }

  find(id: string): string | null {
    const parent = this.parent
    if (!parent.has(id)) return null
    let root = id
    for (;;) {
      const p = parent.get(root)!
      if (p === root) break
      root = p
    }
    // path compression
    let cur = id
    while (cur !== root) {
      const next = parent.get(cur)!
      parent.set(cur, root)
      cur = next
    }
    return root
  }

  union(a: string, b: string): void {
    this.add(a)
    this.add(b)
    const ra = this.find(a)!
    const rb = this.find(b)!
    if (ra === rb) return
    // Deterministic net naming: the lexicographically smaller id is the root.
    if (ra < rb) this.parent.set(rb, ra)
    else this.parent.set(ra, rb)
  }

  roots(): string[] {
    const set = new Set<string>()
    for (const id of this.parent.keys()) set.add(this.find(id)!)
    return [...set].sort()
  }
}

/** Static net id of one pin of a component (hole net or off-board terminal net). */
function pinNetId(
  comp: ComponentInstance,
  entry: CatalogEntry,
  holes: (Hole | null)[] | null,
  pinName: string,
): string | null {
  const idx = entry.pins.indexOf(pinName)
  if (idx < 0) return null
  if (entry.placement === 'offboard') return netIdForTerminal(comp.id, pinName)
  if (!holes) return null
  const h = holes[idx]
  return h ? netIdForHole(h) : null
}

export function buildNetlist(layout: CircuitLayout): Netlist {
  const uf = new UnionFind()
  const warnings: string[] = []
  // boardConfigOf(layout), hardened: never throw on weird layouts (engine contract).
  const board: BoardConfig = {
    size: isBoardSizeId(layout?.board) ? layout.board : 'standard',
    count: isBoardCount(layout?.boardCount) ? layout.boardCount : 1,
    // 2-D grids: without `rows`, every pin on board-row >= 1 resolved to null
    // and the ENGINE silently treated grid-row parts as malformed even though
    // they validated, rendered and routed fine (Phase-C verification fix)
    rows: isBoardRows(layout?.boardRows) ? layout.boardRows : 1,
  }
  const components: ComponentInstance[] = Array.isArray(layout?.components)
    ? layout.components
    : []
  const wires = Array.isArray(layout?.wires) ? layout.wires : []

  const byId = new Map<string, ComponentInstance>()
  for (const c of components) {
    if (c && typeof c.id === 'string' && !byId.has(c.id)) byId.set(c.id, c)
  }

  // The four power rails are always present as nets.
  for (const rail of RAILS) uf.add(netIdForHole({ kind: 'rail', rail, index: 0 }))

  /** Static (pre-merge) net id of an endpoint ref, or null if invalid. */
  const staticNetId = (ref: EndpointRef): string | null => {
    if (typeof ref !== 'string') return null
    const hole = parseHole(ref)
    if (hole) return netIdForHole(hole)
    const term = parseTerminalRef(ref)
    if (!term) return null
    const comp = byId.get(term.componentId)
    if (!comp) return null
    const entry = getEntry(comp.type)
    if (!entry || entry.placement !== 'offboard' || !entry.pins.includes(term.pin)) return null
    return netIdForTerminal(term.componentId, term.pin)
  }

  // Seed nets for every hole / terminal actually used by a component, and
  // merge the component's internal bridges.
  for (const comp of components) {
    if (!comp || typeof comp.type !== 'string') continue
    const entry = getEntry(comp.type)
    if (!entry) continue // engine reports unknown types
    let holes: (Hole | null)[] | null = null
    if (entry.placement === 'offboard') {
      for (const pin of entry.pins) uf.add(netIdForTerminal(comp.id, pin))
    } else {
      holes = componentPinHoles(comp, entry, board)
      if (!holes) continue // engine reports malformed components
      for (const h of holes) if (h) uf.add(netIdForHole(h))
    }
    if (entry.internalBridges) {
      for (const [pa, pb] of entry.internalBridges) {
        const na = pinNetId(comp, entry, holes, pa)
        const nb = pinNetId(comp, entry, holes, pb)
        if (na && nb) uf.union(na, nb)
      }
    }
  }

  // Merge nets across wires (seeding both endpoints — a wire counts as use).
  for (const wire of wires) {
    if (!wire) continue
    const a = staticNetId(wire.from)
    const b = staticNetId(wire.to)
    if (!a) warnings.push(`wire ${wire.id}: invalid endpoint "${String(wire.from)}"`)
    if (!b) warnings.push(`wire ${wire.id}: invalid endpoint "${String(wire.to)}"`)
    if (a && b) uf.union(a, b)
  }

  const nets = uf.roots()

  // Ground = net of the first power supply's '-' terminal, else the first
  // function generator's 'gnd' terminal, else the first net (with a warning).
  let ground: string | null = null
  const ps = components.find((c) => c && c.type === 'power_supply')
  if (ps) ground = uf.find(netIdForTerminal(ps.id, '-'))
  if (!ground) {
    const fg = components.find((c) => c && c.type === 'function_generator')
    if (fg) ground = uf.find(netIdForTerminal(fg.id, 'gnd'))
  }
  if (!ground) {
    ground = nets.length > 0 ? nets[0] : null
    warnings.push('no ground')
  }

  return {
    netOf: (ref: EndpointRef): string | null => {
      const id = staticNetId(ref)
      return id ? uf.find(id) : null
    },
    nets,
    ground,
    warnings,
  }
}
