/**
 * Undo/redo: pure LayoutHistory semantics (push/undo/redo, the 100-entry
 * cap, param-tag coalescing with an injected clock, divergence clearing
 * redo) plus store-level integration — the store imports cleanly in node
 * (its window/localStorage/rAF access is guarded), so the document actions
 * are exercised against the real zustand store.
 */
import { beforeEach, describe, expect, it } from 'vitest'
import type { CircuitLayout } from '../src/model/types'
import { boardOf } from '../src/model/types'
import { COALESCE_WINDOW_MS, HISTORY_CAP, LayoutHistory } from '../src/state/history'
import { __resetHistoryForTests, useStore } from '../src/state/store'

/** Distinct empty-ish layouts so reference identity can be asserted. */
function L(name: string): CircuitLayout {
  return { version: 1, name, components: [], wires: [] }
}

// ---------------------------------------------------------------------------
// Pure LayoutHistory
// ---------------------------------------------------------------------------

describe('LayoutHistory (pure)', () => {
  it('starts empty: no undo, no redo, both return null', () => {
    const h = new LayoutHistory()
    expect(h.canUndo).toBe(false)
    expect(h.canRedo).toBe(false)
    expect(h.undo(L('cur'))).toBeNull()
    expect(h.redo(L('cur'))).toBeNull()
  })

  it('push/undo/redo round-trips the exact layout references', () => {
    const h = new LayoutHistory()
    const l0 = L('0')
    const l1 = L('1')

    h.push(l0, 'add:resistor') // mutating l0 -> l1
    expect(h.canUndo).toBe(true)
    expect(h.canRedo).toBe(false)

    const undone = h.undo(l1)
    expect(undone).toBe(l0)
    expect(h.canUndo).toBe(false)
    expect(h.canRedo).toBe(true)

    const redone = h.redo(l0)
    expect(redone).toBe(l1)
    expect(h.canUndo).toBe(true)
    expect(h.canRedo).toBe(false)

    // and back again — the redo round-trip re-armed undo
    expect(h.undo(l1)).toBe(l0)
  })

  it('multi-step undo pops in LIFO order; redo replays in order', () => {
    const h = new LayoutHistory()
    const l0 = L('0')
    const l1 = L('1')
    const l2 = L('2')
    h.push(l0) // -> l1
    h.push(l1) // -> l2

    expect(h.undo(l2)).toBe(l1)
    expect(h.undo(l1)).toBe(l0)
    expect(h.canUndo).toBe(false)
    expect(h.redo(l0)).toBe(l1)
    expect(h.redo(l1)).toBe(l2)
    expect(h.canRedo).toBe(false)
  })

  it('a divergent push clears the redo stack', () => {
    const h = new LayoutHistory()
    const l0 = L('0')
    const l1 = L('1')
    h.push(l0) // -> l1
    expect(h.undo(l1)).toBe(l0)
    expect(h.canRedo).toBe(true)

    h.push(l0, 'wire') // new timeline from l0
    expect(h.canRedo).toBe(false)
    expect(h.redo(L('x'))).toBeNull()
  })

  it('caps at 100 entries by default, dropping the oldest', () => {
    const h = new LayoutHistory()
    const layouts = Array.from({ length: HISTORY_CAP + 5 }, (_, i) => L(String(i)))
    for (const l of layouts) h.push(l)

    let count = 0
    let cur: CircuitLayout = L('cur')
    const seen: CircuitLayout[] = []
    for (;;) {
      const prev = h.undo(cur)
      if (!prev) break
      seen.push(prev)
      cur = prev
      count++
    }
    expect(count).toBe(100)
    // most recent first; the 5 oldest snapshots were dropped
    expect(seen[0]).toBe(layouts[layouts.length - 1])
    expect(seen[seen.length - 1]).toBe(layouts[5])
  })

  it('honors a custom cap', () => {
    const h = new LayoutHistory({ cap: 2 })
    h.push(L('a'))
    h.push(L('b'))
    h.push(L('c'))
    expect(h.undo(L('cur'))).not.toBeNull()
    expect(h.undo(L('cur'))).not.toBeNull()
    expect(h.undo(L('cur'))).toBeNull() // 'a' fell off the bottom
  })

  describe('param-tag coalescing (injected clock)', () => {
    function clocked(start = 0) {
      let t = start
      const h = new LayoutHistory({ now: () => t })
      return { h, tick: (ms: number) => (t += ms) }
    }

    it('same param tag within 800ms merges into ONE step keeping the oldest snapshot', () => {
      const { h, tick } = clocked()
      const preDrag = L('pre-drag')
      h.push(preDrag, 'param:R1:resistance')
      tick(300)
      h.push(L('mid-1'), 'param:R1:resistance')
      tick(300)
      h.push(L('mid-2'), 'param:R1:resistance')

      const final = L('final')
      expect(h.undo(final)).toBe(preDrag) // whole drag = one step
      expect(h.canUndo).toBe(false)
      expect(h.redo(preDrag)).toBe(final)
    })

    it('the window slides: a long drag with <800ms ticks stays one step', () => {
      const { h, tick } = clocked()
      const pre = L('pre')
      h.push(pre, 'param:RV1:position')
      tick(700)
      h.push(L('m1'), 'param:RV1:position')
      tick(700)
      h.push(L('m2'), 'param:RV1:position') // 1400ms after the first push
      expect(h.undo(L('end'))).toBe(pre)
      expect(h.canUndo).toBe(false)
    })

    it(`a gap beyond ${COALESCE_WINDOW_MS}ms starts a new step`, () => {
      const { h, tick } = clocked()
      const a = L('a')
      const b = L('b')
      h.push(a, 'param:R1:resistance')
      tick(COALESCE_WINDOW_MS + 1)
      h.push(b, 'param:R1:resistance')
      expect(h.undo(L('end'))).toBe(b)
      expect(h.undo(b)).toBe(a)
    })

    it('different param tags never coalesce', () => {
      const { h, tick } = clocked()
      const a = L('a')
      const b = L('b')
      h.push(a, 'param:R1:resistance')
      tick(10)
      h.push(b, 'param:R2:resistance')
      expect(h.undo(L('end'))).toBe(b)
      expect(h.undo(b)).toBe(a)
    })

    it('non-param and untagged pushes never coalesce, even when identical/rapid', () => {
      const { h, tick } = clocked()
      const a = L('a')
      const b = L('b')
      const c = L('c')
      h.push(a, 'wire')
      tick(10)
      h.push(b, 'wire')
      tick(10)
      h.push(c)
      tick(10)
      h.push(L('d'))
      expect(h.canUndo).toBe(true)
      expect(h.undo(L('end'))).not.toBeNull()
      expect(h.undo(L('e'))).toBe(c)
      expect(h.undo(c)).toBe(b)
      expect(h.undo(b)).toBe(a)
    })

    it('a coalesced push still clears redo (it is a divergent edit)', () => {
      const { h, tick } = clocked()
      const p1 = L('p1')
      h.push(p1, 'param:R1:resistance')
      tick(10)
      h.push(L('w'), 'wire')
      h.undo(L('cur')) // pops the wire step; redo now holds one entry
      expect(h.canRedo).toBe(true)
      tick(10)
      h.push(L('p2'), 'param:R1:resistance') // coalesces into the p1 entry…
      expect(h.canRedo).toBe(false) // …but still invalidates redo
      expect(h.undo(L('end'))).toBe(p1) // one merged step
      expect(h.canUndo).toBe(false)
    })
  })

  it('clear() empties both stacks', () => {
    const h = new LayoutHistory()
    h.push(L('a'))
    h.undo(L('b'))
    h.push(L('c'))
    h.clear()
    expect(h.canUndo).toBe(false)
    expect(h.canRedo).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Store integration (real zustand store; node-safe — window access is guarded)
// ---------------------------------------------------------------------------

const FRESH: CircuitLayout = { version: 1, components: [], wires: [] }

function resetStore(): void {
  useStore.getState().resetSim()
  __resetHistoryForTests()
  useStore.setState({
    layout: FRESH,
    selection: [],
    mode: { kind: 'select' },
    canUndo: false,
    canRedo: false,
  })
}

describe('store undo/redo integration', () => {
  beforeEach(resetStore)

  it('addComponent is undoable and redoable, with live can* flags', () => {
    const st = useStore.getState()
    st.addComponent('resistor', { holes: ['a1', 'a5'] })
    expect(useStore.getState().layout.components).toHaveLength(1)
    expect(useStore.getState().canUndo).toBe(true)
    expect(useStore.getState().canRedo).toBe(false)

    useStore.getState().undo()
    expect(useStore.getState().layout.components).toHaveLength(0)
    expect(useStore.getState().canUndo).toBe(false)
    expect(useStore.getState().canRedo).toBe(true)

    useStore.getState().redo()
    expect(useStore.getState().layout.components).toHaveLength(1)
    expect(useStore.getState().canRedo).toBe(false)
  })

  it('undo/redo with empty stacks is a harmless no-op', () => {
    const before = useStore.getState().layout
    useStore.getState().undo()
    useStore.getState().redo()
    expect(useStore.getState().layout).toBe(before)
  })

  it('undo clears the selection when the selected id no longer exists', () => {
    useStore.getState().addComponent('resistor', { holes: ['a1', 'a5'] })
    const id = useStore.getState().layout.components[0].id
    useStore.getState().select(id)
    useStore.getState().undo()
    expect(useStore.getState().selection).toEqual([])
  })

  it('undo keeps the selection when the selected id survives', () => {
    useStore.getState().addComponent('resistor', { holes: ['a1', 'a5'] })
    const id = useStore.getState().layout.components[0].id
    useStore.getState().select(id)
    useStore.getState().setParam(id, 'resistance', 2200)
    useStore.getState().undo() // reverts the param edit; the resistor remains
    expect(useStore.getState().selection).toEqual([id])
    expect(useStore.getState().layout.components).toHaveLength(1)
  })

  it('rapid setParam calls on the same knob coalesce into ONE undo step', () => {
    useStore.getState().addComponent('resistor', { holes: ['a1', 'a5'] })
    const id = useStore.getState().layout.components[0].id

    // simulated slider drag (same tick — well inside the 800ms window)
    useStore.getState().setParam(id, 'resistance', 470)
    useStore.getState().setParam(id, 'resistance', 1000)
    useStore.getState().setParam(id, 'resistance', 4700)
    expect(useStore.getState().layout.components[0].params?.resistance).toBe(4700)

    useStore.getState().undo() // ONE step back = pre-drag value (catalog default)
    expect(useStore.getState().layout.components[0].params?.resistance).toBeUndefined()
    useStore.getState().undo() // next step removes the resistor itself
    expect(useStore.getState().layout.components).toHaveLength(0)
    expect(useStore.getState().canUndo).toBe(false)
  })

  it("the transient 'pressed' param is never recorded", () => {
    useStore.getState().addComponent('pushbutton', { at: 'f10' })
    const id = useStore.getState().layout.components[0].id
    useStore.getState().setParam(id, 'pressed', true)
    expect(useStore.getState().layout.components[0].params?.pressed).toBe(true)

    useStore.getState().undo() // skips the press — goes straight to the add
    expect(useStore.getState().layout.components).toHaveLength(0)
    expect(useStore.getState().canUndo).toBe(false)
  })

  it('addWire / removeWire / removeComponent are individual undo steps', () => {
    const st = useStore.getState()
    st.addComponent('resistor', { holes: ['a1', 'a5'] })
    st.addWire('b1', 'top+0', 'red')
    expect(useStore.getState().layout.wires).toHaveLength(1)
    const wireId = useStore.getState().layout.wires[0].id

    useStore.getState().removeWire(wireId)
    expect(useStore.getState().layout.wires).toHaveLength(0)
    useStore.getState().undo() // un-remove the wire
    expect(useStore.getState().layout.wires).toHaveLength(1)
    useStore.getState().undo() // un-add the wire
    expect(useStore.getState().layout.wires).toHaveLength(0)
    expect(useStore.getState().layout.components).toHaveLength(1)
    useStore.getState().undo() // un-add the resistor
    expect(useStore.getState().layout.components).toHaveLength(0)
  })

  it('refused mutations (e.g. duplicate wire) do not pollute the history', () => {
    const st = useStore.getState()
    st.addWire('a1', 'a5', 'red')
    expect(useStore.getState().layout.wires).toHaveLength(1)
    st.addWire('a1', 'a5', 'red') // duplicate — refused
    st.addWire('a5', 'a1', 'red') // reverse duplicate — refused
    expect(useStore.getState().layout.wires).toHaveLength(1)

    useStore.getState().undo()
    expect(useStore.getState().layout.wires).toHaveLength(0)
    expect(useStore.getState().canUndo).toBe(false)
  })

  it('clearBoard is a single undo step restoring everything', () => {
    const st = useStore.getState()
    st.addComponent('resistor', { holes: ['a1', 'a5'] })
    st.addComponent('led', { holes: ['a10', 'a12'] })
    st.addWire('b1', 'top+0')
    const full = useStore.getState().layout

    useStore.getState().clearBoard()
    expect(useStore.getState().layout.components).toHaveLength(0)
    expect(useStore.getState().layout.wires).toHaveLength(0)

    useStore.getState().undo()
    expect(useStore.getState().layout).toBe(full)
  })

  it('clearBoard on an already-empty board records nothing', () => {
    useStore.getState().clearBoard()
    expect(useStore.getState().canUndo).toBe(false)
  })

  it('loadLayout is a single undo step back to the previous document', () => {
    useStore.getState().addComponent('resistor', { holes: ['a1', 'a5'] })
    const before = useStore.getState().layout

    const incoming: CircuitLayout = {
      version: 1,
      name: 'imported',
      components: [{ id: 'R9', type: 'resistor', holes: ['a20', 'a24'] }],
      wires: [],
    }
    const res = useStore.getState().loadLayout(incoming)
    expect(res.ok).toBe(true)
    expect(useStore.getState().layout.components[0].id).toBe('R9')

    useStore.getState().undo()
    expect(useStore.getState().layout).toBe(before)
    expect(useStore.getState().canRedo).toBe(true)
  })

  it('a failed loadLayout records nothing', () => {
    const res = useStore.getState().loadLayout({
      version: 1,
      components: [{ id: 'X1', type: 'definitely-not-a-type' }],
      wires: [],
    } as CircuitLayout)
    expect(res.ok).toBe(false)
    expect(useStore.getState().canUndo).toBe(false)
  })
})

describe('store setBoardSize', () => {
  beforeEach(resetStore)

  it('growing always succeeds and is one undoable step', () => {
    useStore.getState().addComponent('resistor', { holes: ['a1', 'a5'] })
    const res = useStore.getState().setBoardSize('labxl')
    expect(res).toEqual({ ok: true })
    expect(useStore.getState().layout.board).toBe('labxl')

    useStore.getState().undo()
    expect(boardOf(useStore.getState().layout)).toBe('standard')
    expect(useStore.getState().layout.components).toHaveLength(1) // parts untouched

    useStore.getState().redo()
    expect(boardOf(useStore.getState().layout)).toBe('labxl')
  })

  it('selecting the current size is an ok no-op (nothing recorded)', () => {
    const res = useStore.getState().setBoardSize('standard')
    expect(res).toEqual({ ok: true })
    expect(useStore.getState().canUndo).toBe(false)
    expect(useStore.getState().layout.board).toBeUndefined()
  })

  it('shrinking with parts off-board is refused with a counted, board-named error', () => {
    const st = useStore.getState()
    st.addComponent('resistor', { holes: ['a40', 'a45'] }) // beyond half's 30 cols
    st.addWire('a50', 'b55', 'green') // both endpoints beyond half
    const before = useStore.getState().layout
    const undoBefore = useStore.getState().canUndo

    const res = useStore.getState().setBoardSize('half')
    expect(res.ok).toBe(false)
    expect(res.error).toBe('2 parts would fall off the Half board')
    expect(useStore.getState().layout).toBe(before) // untouched
    expect(useStore.getState().canUndo).toBe(undoBefore)
  })

  it('uses singular phrasing for a single offender', () => {
    useStore.getState().addComponent('resistor', { holes: ['a40', 'a45'] })
    const res = useStore.getState().setBoardSize('half')
    expect(res.error).toBe('1 part would fall off the Half board')
  })

  it('shrinking succeeds when everything fits the smaller board', () => {
    const st = useStore.getState()
    st.addComponent('resistor', { holes: ['a1', 'a5'] })
    st.addWire('b1', 'top+0')
    const res = useStore.getState().setBoardSize('half')
    expect(res).toEqual({ ok: true })
    expect(useStore.getState().layout.board).toBe('half')
  })

  it('off-board instruments and terminal wires never block a shrink', () => {
    const st = useStore.getState()
    st.addComponent('power_supply', {})
    const psId = useStore.getState().layout.components[0].id
    st.addWire(`${psId}:+`, 'top+0')
    const res = useStore.getState().setBoardSize('half')
    expect(res).toEqual({ ok: true })
  })
})
