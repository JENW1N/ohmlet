/**
 * Store editing contract (Phase C refactor): multi-select semantics, group
 * delete as ONE undo step, all-or-nothing moves (+ undo), growGrid left/up
 * remapping with exact single-step undo, rotation cycling validity,
 * instrument position validation, body-occlusion awareness of
 * placementValid/addComponent/addWire, setBoardRows shrink protection and
 * the persisted render-mode preference.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { CircuitLayout } from '../src/model/types'
import {
  __resetHistoryForTests,
  occupiedHoles,
  placementValid,
  useStore,
} from '../src/state/store'

function resetStore(layout?: CircuitLayout): void {
  useStore.getState().resetSim()
  __resetHistoryForTests()
  useStore.setState({
    layout: layout ?? { version: 1, components: [], wires: [] },
    selection: [],
    mode: { kind: 'select' },
    canUndo: false,
    canRedo: false,
  })
}

const st = () => useStore.getState()

/** Two resistors + a wire on a fresh standard board; returns their ids. */
function twoResistorsAndAWire(): { r1: string; r2: string; w: string } {
  st().addComponent('resistor', { holes: ['a1', 'a5'] })
  st().addComponent('resistor', { holes: ['a10', 'a14'] })
  st().addWire('j1', 'top-0')
  const comps = st().layout.components
  return { r1: comps[0].id, r2: comps[1].id, w: st().layout.wires[0].id }
}

// ---------------------------------------------------------------------------
// Multi-select semantics
// ---------------------------------------------------------------------------

describe('multi-select semantics', () => {
  beforeEach(() => resetStore())

  it('select replaces, select(null) clears', () => {
    const { r1, r2 } = twoResistorsAndAWire()
    st().select(r1)
    expect(st().selection).toEqual([r1])
    st().select(r2)
    expect(st().selection).toEqual([r2])
    st().select(null)
    expect(st().selection).toEqual([])
  })

  it('toggleSelect adds and removes; clearSelection empties', () => {
    const { r1, r2, w } = twoResistorsAndAWire()
    st().toggleSelect(r1)
    st().toggleSelect(r2)
    st().toggleSelect(w)
    expect(st().selection).toEqual([r1, r2, w])
    st().toggleSelect(r2)
    expect(st().selection).toEqual([r1, w])
    st().clearSelection()
    expect(st().selection).toEqual([])
  })

  it('marqueeSelect replaces with a deduped set', () => {
    const { r1, r2, w } = twoResistorsAndAWire()
    st().select(w)
    st().marqueeSelect([r1, r2, r1])
    expect(st().selection).toEqual([r1, r2])
  })

  it('undo prunes only the selected ids that vanished', () => {
    const { r1, r2 } = twoResistorsAndAWire()
    st().marqueeSelect([r1, r2])
    st().undo() // un-adds the wire — both resistors survive
    expect(st().selection).toEqual([r1, r2])
    st().undo() // un-adds R2
    expect(st().selection).toEqual([r1])
  })
})

// ---------------------------------------------------------------------------
// Group delete = ONE undo step
// ---------------------------------------------------------------------------

describe('removeSelected (group delete)', () => {
  beforeEach(() => resetStore())

  it('removes every selected part as one undo step (incl. instrument terminal wires)', () => {
    const { r1, r2, w } = twoResistorsAndAWire()
    st().addComponent('power_supply', {})
    const ps = st().layout.components[2].id
    st().addWire(`${ps}:+`, 'top+0') // terminal wire that must die with the instrument
    const before = st().layout
    expect(before.components).toHaveLength(3)
    expect(before.wires).toHaveLength(2)

    st().marqueeSelect([r1, w, ps])
    st().removeSelected()

    const after = st().layout
    expect(after.components.map((c) => c.id)).toEqual([r2]) // only R2 survives
    expect(after.wires).toHaveLength(0) // selected wire + PS terminal wire both gone
    expect(st().selection).toEqual([])

    st().undo() // ONE step restores the whole group
    expect(st().layout).toEqual(before)
    expect(st().canRedo).toBe(true)
  })

  it('single selection removes exactly that part (parity with the old contract)', () => {
    const { r1 } = twoResistorsAndAWire()
    st().select(r1)
    st().removeSelected()
    expect(st().layout.components).toHaveLength(1)
    expect(st().layout.wires).toHaveLength(1)
    expect(st().selection).toEqual([])
  })

  it('a selection of stale ids records nothing', () => {
    twoResistorsAndAWire()
    const undoBefore = st().canUndo
    st().marqueeSelect(['GHOST9'])
    st().removeSelected()
    expect(st().layout.components).toHaveLength(2)
    expect(st().canUndo).toBe(undoBefore)
    expect(st().selection).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// Move: all-or-nothing + undo
// ---------------------------------------------------------------------------

describe('move (previewMove / commitMove / moveSelection)', () => {
  beforeEach(() => resetStore())

  it('translates a group by columns; ONE undo restores every moved part', () => {
    const { r1, r2 } = twoResistorsAndAWire()
    const before = st().layout
    st().marqueeSelect([r1, r2])
    st().moveSelection(1)
    const comps = st().layout.components
    expect(comps[0].holes).toEqual(['a2', 'a6'])
    expect(comps[1].holes).toEqual(['a11', 'a15'])
    expect(st().selection).toEqual([r1, r2]) // moving keeps the selection
    st().undo()
    expect(st().layout).toEqual(before)
  })

  it('is ALL-OR-NOTHING: one blocked part refuses the whole move', () => {
    const { r1, r2 } = twoResistorsAndAWire()
    st().addComponent('led', { holes: ['a6', 'a8'] }) // a6 blocks R1's +1 target
    const before = st().layout
    expect(st().previewMove([r1, r2], { dCol: 1, dRowLattice: 0 }).valid).toBe(false)
    expect(st().commitMove([r1, r2], { dCol: 1, dRowLattice: 0 })).toEqual({ ok: false })
    expect(st().layout).toBe(before) // nothing moved, nothing recorded
  })

  it('previewMove agrees with commitMove on the valid case', () => {
    const { r1 } = twoResistorsAndAWire()
    expect(st().previewMove([r1], { dCol: 2, dRowLattice: 1 }).valid).toBe(true)
    expect(st().commitMove([r1], { dCol: 2, dRowLattice: 1 })).toEqual({ ok: true })
    expect(st().layout.components[0].holes).toEqual(['b3', 'b7'])
  })

  it('wires stay put when an attached part moves (v1 semantics)', () => {
    st().addComponent('resistor', { holes: ['a1', 'a5'] })
    st().addWire('b1', 'top+0') // same strip as the a1 lead
    const id = st().layout.components[0].id
    st().commitMove([id], { dCol: 1, dRowLattice: 0 })
    expect(st().layout.components[0].holes).toEqual(['a2', 'a6'])
    expect(st().layout.wires[0].from).toBe('b1')
    expect(st().layout.wires[0].to).toBe('top+0')
  })

  it('rail leads shift by index on dCol and refuse any vertical move', () => {
    st().addComponent('resistor', { holes: ['a20', 'top+0'] })
    const id = st().layout.components[0].id
    expect(st().commitMove([id], { dCol: 0, dRowLattice: 1 })).toEqual({ ok: false })
    expect(st().commitMove([id], { dCol: 1, dRowLattice: 0 })).toEqual({ ok: true })
    expect(st().layout.components[0].holes).toEqual(['a21', 'top+1'])
  })

  it('packages move along columns but never vertically; anchor form re-anchors', () => {
    st().addComponent('ne555', { at: 'f10' })
    const id = st().layout.components[0].id
    expect(st().commitMove([id], { dCol: 0, dRowLattice: 1 })).toEqual({ ok: false })
    expect(st().commitMove([id], { dCol: 2, dRowLattice: 0 })).toEqual({ ok: true })
    expect(st().layout.components[0].at).toBe('f12')

    expect(st().commitMove([id], { anchor: 'f20' })).toEqual({ ok: true })
    expect(st().layout.components[0].at).toBe('f20')
    expect(st().commitMove([id], { anchor: 'a20' })).toEqual({ ok: false }) // DIP pin 1 must sit in row f
    expect(st().layout.components[0].at).toBe('f20')
  })

  it('a group containing a package refuses a vertical nudge entirely', () => {
    const { r1 } = twoResistorsAndAWire()
    st().addComponent('ne555', { at: 'f20' })
    const u1 = st().layout.components[2].id
    const before = st().layout
    st().marqueeSelect([r1, u1])
    st().moveSelection(0, 1)
    expect(st().layout).toBe(before) // all-or-nothing
  })

  it('refuses a move landing under another body (occlusion-aware)', () => {
    st().addComponent('potentiometer', { holes: ['a8', 'a9', 'a10'] }) // body covers b7..b11
    st().addComponent('resistor', { holes: ['c8', 'c12'] })
    const r = st().layout.components[1].id
    expect(st().previewMove([r], { dCol: 0, dRowLattice: -1 }).valid).toBe(false) // b8 is covered
    expect(st().commitMove([r], { dCol: 0, dRowLattice: -1 })).toEqual({ ok: false })
    expect(st().commitMove([r], { dCol: 0, dRowLattice: 1 })).toEqual({ ok: true }) // d8 is clear
  })

  it('zero deltas, unknown ids and instruments are not moves', () => {
    st().addComponent('power_supply', {})
    const ps = st().layout.components[0].id
    expect(st().previewMove([ps], { dCol: 1, dRowLattice: 0 }).valid).toBe(false)
    expect(st().previewMove(['NOPE'], { dCol: 1, dRowLattice: 0 }).valid).toBe(false)
    st().addComponent('resistor', { holes: ['a1', 'a5'] })
    const r = st().layout.components[1].id
    expect(st().previewMove([r], { dCol: 0, dRowLattice: 0 }).valid).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// growGrid: left/up remap, right/down append, single-step undo, nudge
// ---------------------------------------------------------------------------

describe('growGrid', () => {
  beforeEach(() => resetStore())

  function populated(): CircuitLayout {
    st().addComponent('resistor', { holes: ['a1', 'a5'] })
    st().addComponent('ne555', { at: 'f10' })
    st().addWire('j1', 'top-0')
    st().addComponent('power_supply', {})
    const ps = st().layout.components[2].id
    st().addWire(`${ps}:+`, 'top+0')
    return st().layout
  }

  it("growGrid('left') adds a module and remaps content right; ONE undo restores exactly", () => {
    const before = populated()
    expect(st().growGrid('left')).toEqual({ ok: true })
    const l = st().layout
    expect(l.boardCount).toBe(2)
    expect(l.components[0].holes).toEqual(['a64', 'a68']) // +63 strip columns
    expect(l.components[1].at).toBe('f73')
    expect(l.wires[0].from).toBe('j64')
    expect(l.wires[0].to).toBe('top-50') // rails shift proportionally (+50)
    expect(l.wires[1].from).toMatch(/^PS\d+:\+$/) // terminal refs pass through
    expect(l.wires[1].to).toBe('top+50')

    st().undo() // ONE step: refs and rig restored together
    expect(st().layout).toEqual(before)
    expect(st().canUndo).toBe(true) // only the populate steps remain
  })

  it("growGrid('up') adds a board-row and prefixes content; ONE undo restores exactly", () => {
    const before = populated()
    expect(st().growGrid('up')).toEqual({ ok: true })
    const l = st().layout
    expect(l.boardRows).toBe(2)
    expect(l.components[0].holes).toEqual(['1:a1', '1:a5'])
    expect(l.components[1].at).toBe('1:f10')
    expect(l.wires[0].from).toBe('1:j1')
    expect(l.wires[0].to).toBe('1:top-0')
    st().undo()
    expect(st().layout).toEqual(before)
  })

  it("growGrid('right'/'down') append without touching any ref", () => {
    populated()
    const holesBefore = st().layout.components[0].holes
    expect(st().growGrid('right')).toEqual({ ok: true })
    expect(st().layout.boardCount).toBe(2)
    expect(st().layout.components[0].holes).toEqual(holesBefore)
    expect(st().growGrid('down')).toEqual({ ok: true })
    expect(st().layout.boardRows).toBe(2)
    expect(st().layout.components[0].holes).toEqual(holesBefore)
  })

  it('refuses to grow past the caps with a user-presentable error', () => {
    resetStore({ version: 1, boardCount: 6, components: [], wires: [] })
    expect(st().growGrid('right').ok).toBe(false)
    expect(st().growGrid('left').error).toMatch(/6 modules/)
    resetStore({ version: 1, boardRows: 4, components: [], wires: [] })
    expect(st().growGrid('down').ok).toBe(false)
    expect(st().growGrid('up').error).toMatch(/4 board-rows/)
  })

  it('keeps absolute instrument positions but auto-nudges one the grown board swallows', () => {
    st().addComponent('power_supply', {})
    const ps = st().layout.components[0].id
    expect(st().setInstrumentPos(ps, { x: 2, z: 20 })).toEqual({ ok: true }) // just past the board edge
    expect(st().growGrid('down')).toEqual({ ok: true }) // board now reaches z = 37.5 (18 + BOARD_ROW_PITCH)
    const moved = st().layout.components[0]
    expect(moved.pos).toEqual({ x: 2, z: 40 }) // re-shelved past the new edge, x kept
  })

  it('setBoardCount growth (the plus paddle) also nudges a swallowed instrument', () => {
    st().addComponent('power_supply', {})
    const ps = st().layout.components[0].id
    expect(st().setInstrumentPos(ps, { x: 66, z: 5 })).toEqual({ ok: true }) // right of board 1
    expect(st().setBoardCount(2)).toEqual({ ok: true }) // board 2 now covers x 64..127
    const moved = st().layout.components[0]
    expect(moved.pos).toEqual({ x: 66, z: 20.5 }) // dropped past the board edge, x kept
    st().undo() // setBoardCount stays one undo step
    expect(st().layout.components[0].pos).toEqual({ x: 66, z: 5 })
    expect(st().layout.boardCount).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// setBoardRows
// ---------------------------------------------------------------------------

describe('setBoardRows', () => {
  beforeEach(() => resetStore())

  it('grows and shrinks with canonical absence at 1, one undo step each', () => {
    expect(st().setBoardRows(3)).toEqual({ ok: true })
    expect(st().layout.boardRows).toBe(3)
    expect(st().setBoardRows(1)).toEqual({ ok: true })
    expect(st().layout.boardRows).toBeUndefined()
    st().undo()
    expect(st().layout.boardRows).toBe(3)
    st().undo()
    expect(st().layout.boardRows).toBeUndefined()
  })

  it('refuses a shrink that would strand parts on removed rows', () => {
    st().setBoardRows(2)
    st().addWire('1:a1', '1:top+0')
    const res = st().setBoardRows(1)
    expect(res.ok).toBe(false)
    expect(res.error).toMatch(/1 part would fall off/)
    expect(st().layout.boardRows).toBe(2)
    st().removeWire(st().layout.wires[0].id)
    expect(st().setBoardRows(1)).toEqual({ ok: true })
  })

  it('rejects non-integers and out-of-range counts', () => {
    expect(st().setBoardRows(0).ok).toBe(false)
    expect(st().setBoardRows(1.5).ok).toBe(false)
    expect(st().setBoardRows(7).ok).toBe(false)
    expect(st().canUndo).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Rotation
// ---------------------------------------------------------------------------

describe('rotation', () => {
  beforeEach(() => resetStore())

  it('rotateArmed cycles quarter turns for footprints and 0↔180 for DIPs', () => {
    st().setMode({ kind: 'place', type: 'pushbutton', pickedHoles: [] })
    const rotations: (number | undefined)[] = []
    for (let i = 0; i < 4; i++) {
      st().rotateArmed()
      const m = st().mode
      rotations.push(m.kind === 'place' ? m.rotation : undefined)
    }
    expect(rotations).toEqual([90, 180, 270, 0])

    st().setMode({ kind: 'place', type: 'ne555', pickedHoles: [] })
    st().rotateArmed()
    expect(st().mode).toMatchObject({ kind: 'place', rotation: 180 })
    st().rotateArmed()
    expect(st().mode).toMatchObject({ kind: 'place', rotation: 0 })
  })

  it('rotateArmed is a no-op for leads parts and outside place mode', () => {
    st().setMode({ kind: 'place', type: 'resistor', pickedHoles: [] })
    st().rotateArmed()
    const m = st().mode
    expect(m.kind === 'place' ? m.rotation : 'x').toBeUndefined()
    st().setMode({ kind: 'select' })
    st().rotateArmed() // must not throw or change mode
    expect(st().mode).toEqual({ kind: 'select' })
  })

  it('addComponent threads rotation (footprint 90 lands rotated; DIP 90 refused)', () => {
    st().addComponent('pushbutton', { at: 'c10', rotation: 90 })
    expect(st().layout.components).toHaveLength(1)
    expect(st().layout.components[0].rotation).toBe(90)
    const used = occupiedHoles(st().layout)
    for (const h of ['c10', 'c11', 'e10', 'e11']) expect(used.has(h)).toBe(true)

    st().addComponent('ne555', { at: 'f20', rotation: 90 }) // DIPs cannot take 90
    expect(st().layout.components).toHaveLength(1)
    st().addComponent('ne555', { at: 'f20', rotation: 180 })
    expect(st().layout.components).toHaveLength(2)
    expect(st().layout.components[1].rotation).toBe(180)
  })

  it('placementValid is rotation-aware and agrees with addComponent', () => {
    st().addWire('e10', 'j30') // blocks the rotated pushbutton's B-row
    expect(placementValid(st().layout, 'pushbutton', 'c10', [], 90)).toBe(false)
    expect(placementValid(st().layout, 'pushbutton', 'c10')).toBe(false) // unrotated anchors only in row f
    expect(placementValid(st().layout, 'pushbutton', 'f12')).toBe(true) // unrotated fits clear of the wire
    const before = st().layout.components.length
    st().addComponent('pushbutton', { at: 'c10', rotation: 90 })
    expect(st().layout.components).toHaveLength(before) // refused, like the ghost said
  })

  it('rotatePlaced toggles a DIP 0↔180 in place (same anchor, one undo step each)', () => {
    st().addComponent('ne555', { at: 'f10' })
    const id = st().layout.components[0].id
    expect(st().rotatePlaced(id)).toEqual({ ok: true })
    expect(st().layout.components[0].rotation).toBe(180)
    expect(st().layout.components[0].at).toBe('f10')
    expect(st().rotatePlaced(id)).toEqual({ ok: true })
    expect(st().layout.components[0].rotation).toBeUndefined() // canonical 0
    st().undo()
    expect(st().layout.components[0].rotation).toBe(180)
  })

  it('rotatePlaced cycles a footprint to the next VALID rotation, or refuses', () => {
    st().addComponent('pushbutton', { at: 'f10' })
    const id = st().layout.components[0].id
    // block 90 (pin h10), 180 (pin g8) and 270 (pin f9)
    st().addWire('h10', 'j20')
    st().addWire('g8', 'j21')
    st().addWire('f9', 'j22')
    expect(st().rotatePlaced(id)).toEqual({ ok: false })
    expect(st().layout.components[0].rotation).toBeUndefined()

    st().removeWire(st().layout.wires[2].id) // free f9 → 270 becomes valid
    expect(st().rotatePlaced(id)).toEqual({ ok: true })
    expect(st().layout.components[0].rotation).toBe(270)
  })

  it('rotatePlaced refuses leads parts and unknown ids', () => {
    st().addComponent('resistor', { holes: ['a1', 'a5'] })
    expect(st().rotatePlaced(st().layout.components[0].id)).toEqual({ ok: false })
    expect(st().rotatePlaced('NOPE')).toEqual({ ok: false })
  })
})

// ---------------------------------------------------------------------------
// Instrument positions
// ---------------------------------------------------------------------------

describe('setInstrumentPos', () => {
  beforeEach(() => resetStore())

  it('validates the model rules: grid snap, clear of the board, clear of instruments', () => {
    st().addComponent('power_supply', {})
    const ps = st().layout.components[0].id
    expect(st().setInstrumentPos(ps, { x: 0.3, z: 0 }).ok).toBe(false) // off the 0.5 grid
    expect(st().setInstrumentPos(ps, { x: 20, z: 5 }).ok).toBe(false) // over the board
    expect(st().layout.components[0].pos).toBeUndefined() // refusals change nothing

    expect(st().setInstrumentPos(ps, { x: 2, z: 25 })).toEqual({ ok: true })
    expect(st().layout.components[0].pos).toEqual({ x: 2, z: 25 })

    st().addComponent('function_generator', {})
    const fg = st().layout.components[1].id
    const res = st().setInstrumentPos(fg, { x: 4, z: 24 }) // overlaps the PSU body
    expect(res.ok).toBe(false)
    expect(res.error).toMatch(/overlaps/)
    expect(st().setInstrumentPos(fg, { x: 2, z: 33 })).toEqual({ ok: true })
  })

  it('is refused for on-board parts', () => {
    st().addComponent('resistor', { holes: ['a1', 'a5'] })
    expect(st().setInstrumentPos(st().layout.components[0].id, { x: 0, z: 25 }).ok).toBe(false)
    expect(st().setInstrumentPos('NOPE', { x: 0, z: 25 }).ok).toBe(false)
  })

  it('a continuous drag coalesces into ONE undo step back to the pre-drag spot', () => {
    st().addComponent('power_supply', {})
    const ps = st().layout.components[0].id
    expect(st().setInstrumentPos(ps, { x: 2, z: 25 })).toEqual({ ok: true })
    expect(st().setInstrumentPos(ps, { x: 4, z: 27 })).toEqual({ ok: true })
    expect(st().setInstrumentPos(ps, { x: 6.5, z: 29 })).toEqual({ ok: true })
    st().undo()
    expect(st().layout.components[0].pos).toBeUndefined() // pre-drag (no pos)
  })
})

// ---------------------------------------------------------------------------
// Occlusion-aware placement / wiring (store ⇄ validator parity)
// ---------------------------------------------------------------------------

describe('body occlusion in store editing', () => {
  beforeEach(() => resetStore())

  it('placementValid and addWire refuse holes under a potentiometer body', () => {
    st().addComponent('potentiometer', { holes: ['a8', 'a9', 'a10'] })
    expect(placementValid(st().layout, 'led', 'b9')).toBe(false) // covered
    expect(placementValid(st().layout, 'led', 'c9')).toBe(true) // clear

    st().addWire('b9', 'j5')
    expect(st().layout.wires).toHaveLength(0)
    st().addWire('c9', 'j5')
    expect(st().layout.wires).toHaveLength(1)
  })

  it('addComponent refuses a lead in a covered hole (whole part, all-or-nothing)', () => {
    st().addComponent('potentiometer', { holes: ['a8', 'a9', 'a10'] })
    st().addComponent('resistor', { holes: ['b8', 'b12'] }) // b8 is covered
    expect(st().layout.components).toHaveLength(1)
  })

  it("refuses placing a part whose OWN body would cover an occupied hole", () => {
    st().addWire('b9', 'j5')
    // the pot's body would overhang the wire end at b9
    expect(placementValid(st().layout, 'potentiometer', 'a10', ['a8', 'a9'])).toBe(false)
    st().addComponent('potentiometer', { holes: ['a8', 'a9', 'a10'] })
    expect(st().layout.components).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// Render-mode preference
// ---------------------------------------------------------------------------

describe('renderMode preference', () => {
  const mem = new Map<string, string>()
  const fakeWindow = {
    localStorage: {
      getItem: (k: string) => mem.get(k) ?? null,
      setItem: (k: string, v: string) => void mem.set(k, v),
      removeItem: (k: string) => void mem.delete(k),
    },
  }

  beforeEach(() => {
    mem.clear()
    ;(globalThis as Record<string, unknown>).window = fakeWindow
    resetStore()
  })
  afterEach(() => {
    delete (globalThis as Record<string, unknown>).window
  })

  it("setRenderMode persists under 'bb.renderMode'; null clears back to auto", () => {
    expect(st().renderMode).toBeNull() // node boot: nothing stored
    st().setRenderMode('studio')
    expect(st().renderMode).toBe('studio')
    expect(mem.get('bb.renderMode')).toBe('studio')

    st().setRenderMode('performance')
    expect(mem.get('bb.renderMode')).toBe('performance')

    st().setRenderMode(null)
    expect(st().renderMode).toBeNull()
    expect(mem.has('bb.renderMode')).toBe(false)
  })
})
