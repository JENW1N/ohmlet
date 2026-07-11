/**
 * Store placement must be BOARD-AWARE: occupiedHoles / placementValid /
 * addComponent resolve pin holes against boardOf(layout), not the 'standard'
 * default — far columns exist on Lab XL (parts must place beyond column 63,
 * and their leads must count as occupied), while a half board must refuse
 * holes beyond column 30 (and the green/red ghost must agree with the add).
 *
 * Also: the pushbutton's momentary 'pressed' param is transient — it lives in
 * the in-memory document (the Properties HOLD button renders it) but must
 * never escape into persisted documents: history snapshots (undo/redo would
 * restore a stuck-held button) or exports.
 */
import { beforeEach, describe, expect, it } from 'vitest'
import type { BoardSizeId, CircuitLayout } from '../src/model/types'
import {
  __resetHistoryForTests,
  occupiedHoles,
  placementValid,
  stripTransientParams,
  useStore,
} from '../src/state/store'

function fresh(board?: BoardSizeId): CircuitLayout {
  return board
    ? { version: 1, board, components: [], wires: [] }
    : { version: 1, components: [], wires: [] }
}

function resetStore(board?: BoardSizeId): void {
  useStore.getState().resetSim()
  __resetHistoryForTests()
  useStore.setState({
    layout: fresh(board),
    selection: [],
    mode: { kind: 'select' },
    canUndo: false,
    canRedo: false,
  })
}

// ---------------------------------------------------------------------------
// Lab XL: the right half of the board (columns 64..126) must work
// ---------------------------------------------------------------------------

describe('board-aware placement (Lab XL far columns)', () => {
  beforeEach(() => resetStore('labxl'))

  it('addComponent accepts leads beyond column 63', () => {
    useStore.getState().addComponent('resistor', { holes: ['a100', 'a105'] })
    expect(useStore.getState().layout.components).toHaveLength(1)
    expect(useStore.getState().layout.components[0].holes).toEqual(['a100', 'a105'])
  })

  it('addComponent accepts a DIP anchored beyond column 63', () => {
    useStore.getState().addComponent('ne555', { at: 'f100' })
    expect(useStore.getState().layout.components).toHaveLength(1)
    expect(useStore.getState().layout.components[0].at).toBe('f100')
  })

  it('placementValid agrees with addComponent on far columns (green ghost ⇒ add succeeds)', () => {
    const layout = useStore.getState().layout
    expect(placementValid(layout, 'resistor', 'a100')).toBe(true)
    expect(placementValid(layout, 'ne555', 'f100')).toBe(true)
  })

  it('occupiedHoles sees far-column leads; addWire enforces one-lead-per-hole there', () => {
    useStore.getState().addComponent('resistor', { holes: ['a100', 'a105'] })
    expect(occupiedHoles(useStore.getState().layout).has('a100')).toBe(true)

    useStore.getState().addWire('a100', 'j100') // a100 already holds R1's lead
    expect(useStore.getState().layout.wires).toHaveLength(0)

    useStore.getState().addWire('b100', 'j100') // both free — fine
    expect(useStore.getState().layout.wires).toHaveLength(1)
  })

  it('a far-column hole holding a lead is no longer placement-valid', () => {
    useStore.getState().addComponent('resistor', { holes: ['a100', 'a105'] })
    expect(placementValid(useStore.getState().layout, 'led', 'a100')).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Half board: columns 31..63 parse as syntax but do not exist on this board
// ---------------------------------------------------------------------------

describe('board-aware placement (half board bounds)', () => {
  beforeEach(() => resetStore('half'))

  it('addComponent refuses leads beyond column 30, and the ghost agrees', () => {
    useStore.getState().addComponent('resistor', { holes: ['a40', 'a45'] })
    expect(useStore.getState().layout.components).toHaveLength(0)
    expect(placementValid(useStore.getState().layout, 'resistor', 'a40')).toBe(false)
  })

  it('refuses a DIP running off column 30 but accepts one that just fits', () => {
    useStore.getState().addComponent('ne555', { at: 'f28' }) // spans 28..31
    expect(useStore.getState().layout.components).toHaveLength(0)
    expect(placementValid(useStore.getState().layout, 'ne555', 'f28')).toBe(false)

    expect(placementValid(useStore.getState().layout, 'ne555', 'f27')).toBe(true)
    useStore.getState().addComponent('ne555', { at: 'f27' }) // spans 27..30
    expect(useStore.getState().layout.components).toHaveLength(1)
  })

  it('addWire refuses endpoints that parse but do not exist on this board', () => {
    useStore.getState().addWire('a40', 'a1') // a40 is beyond half's 30 columns
    useStore.getState().addWire('a1', 'a40') // either side
    useStore.getState().addWire('top+30', 'a1') // rail index past half's 0..24
    expect(useStore.getState().layout.wires).toHaveLength(0)
    expect(useStore.getState().canUndo).toBe(false) // refusals record nothing

    useStore.getState().addWire('a1', 'top+0') // in bounds — fine
    expect(useStore.getState().layout.wires).toHaveLength(1)
  })
})

// ---------------------------------------------------------------------------
// Stale wire-mode `from` must not survive a rig shrink (or commit off-rig)
// ---------------------------------------------------------------------------

describe('stale wire-mode `from` after a rig change', () => {
  beforeEach(() => resetStore())

  it('addWire refuses a hole stranded by a board-count shrink (no off-rig wire is ever committed)', () => {
    useStore.getState().setBoardCount(2)
    expect(useStore.getState().setBoardCount(1)).toEqual({ ok: true })
    useStore.getState().addWire('j120', 'a5') // j120 parses but no longer exists on this rig
    expect(useStore.getState().layout.wires).toHaveLength(0)
    expect(useStore.getState().layout.boardCount).toBeUndefined() // still the shrunk rig
  })

  it('setBoardCount shrink clears a pending `from` off the smaller rig (mode + color survive)', () => {
    useStore.getState().setBoardCount(2)
    useStore.getState().setMode({ kind: 'wire', from: 'j120', color: 'green' })
    expect(useStore.getState().setBoardCount(1)).toEqual({ ok: true })
    expect(useStore.getState().mode).toEqual({ kind: 'wire', from: null, color: 'green' })
  })

  it('setBoardSize shrink clears a pending `from` off the smaller board', () => {
    useStore.getState().setMode({ kind: 'wire', from: 'a40', color: 'yellow' })
    expect(useStore.getState().setBoardSize('half')).toEqual({ ok: true })
    expect(useStore.getState().mode).toEqual({ kind: 'wire', from: null, color: 'yellow' })
  })

  it('undoing a board grow clears a pending `from` on the vanished module', () => {
    useStore.getState().setBoardCount(2)
    useStore.getState().setMode({ kind: 'wire', from: 'j120', color: 'red' })
    useStore.getState().undo()
    expect(useStore.getState().layout.boardCount).toBeUndefined()
    expect(useStore.getState().mode).toEqual({ kind: 'wire', from: null, color: 'red' })
  })

  it('an in-bounds pending `from` survives shrinks and undo untouched', () => {
    useStore.getState().setBoardCount(2)
    useStore.getState().setMode({ kind: 'wire', from: 'a5', color: 'blue' })
    expect(useStore.getState().setBoardCount(1)).toEqual({ ok: true })
    expect(useStore.getState().mode).toEqual({ kind: 'wire', from: 'a5', color: 'blue' })
    useStore.getState().undo() // back to ×2 — a5 still exists
    expect(useStore.getState().mode).toEqual({ kind: 'wire', from: 'a5', color: 'blue' })
  })
})

// ---------------------------------------------------------------------------
// Transient 'pressed' never persists
// ---------------------------------------------------------------------------

describe("transient 'pressed' never persists", () => {
  beforeEach(() => resetStore())

  it('undo after a mid-hold history push does not restore a stuck-pressed button', () => {
    useStore.getState().addComponent('pushbutton', { at: 'f10' })
    const id = useStore.getState().layout.components[0].id

    useStore.getState().setParam(id, 'pressed', true) // HOLD down
    useStore.getState().addWire('a1', 'top+0') // history push while held
    useStore.getState().setParam(id, 'pressed', false) // release

    useStore.getState().undo() // un-add the wire → lands on the mid-hold snapshot
    const pb = useStore.getState().layout.components.find((c) => c.id === id)
    expect(pb?.params?.pressed).toBeUndefined()
    expect(useStore.getState().layout.wires).toHaveLength(0)
  })

  it('redo does not restore the document stashed while the button was held', () => {
    useStore.getState().addComponent('pushbutton', { at: 'f10' })
    const id = useStore.getState().layout.components[0].id

    useStore.getState().addWire('a1', 'top+0')
    useStore.getState().setParam(id, 'pressed', true) // hold…
    useStore.getState().undo() // …and undo mid-hold (stashes current for redo)
    useStore.getState().redo()

    const pb = useStore.getState().layout.components.find((c) => c.id === id)
    expect(pb?.params?.pressed).toBeUndefined()
    expect(useStore.getState().layout.wires).toHaveLength(1)
  })

  it('exportJson strips a held pressed while the live document keeps it for the UI', () => {
    useStore.getState().addComponent('pushbutton', { at: 'f10' })
    const id = useStore.getState().layout.components[0].id
    useStore.getState().setParam(id, 'pressed', true)

    // the in-memory document still shows the hold (Properties HOLD button)
    expect(useStore.getState().layout.components[0].params?.pressed).toBe(true)

    const exported = JSON.parse(useStore.getState().exportJson()) as CircuitLayout
    expect(exported.components[0].params?.pressed).toBeUndefined()
  })

  it('stripTransientParams: same reference when clean; drops only the transient key', () => {
    const clean: CircuitLayout = {
      version: 1,
      components: [
        { id: 'R1', type: 'resistor', params: { resistance: 470 }, holes: ['a1', 'a5'] },
      ],
      wires: [],
    }
    expect(stripTransientParams(clean)).toBe(clean)

    const held: CircuitLayout = {
      version: 1,
      components: [
        { id: 'PB1', type: 'pushbutton', at: 'f10', params: { pressed: true } },
        { id: 'R1', type: 'resistor', params: { resistance: 470, pressed: false }, holes: ['a1', 'a5'] },
      ],
      wires: [],
    }
    const stripped = stripTransientParams(held)
    expect(stripped).not.toBe(held)
    expect(stripped.components[0].params).toBeUndefined() // pressed was the only param
    expect(stripped.components[1].params).toEqual({ resistance: 470 })
    // the input document is untouched (layouts are immutable)
    expect(held.components[0].params).toEqual({ pressed: true })
  })
})
