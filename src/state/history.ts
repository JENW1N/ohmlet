/**
 * LayoutHistory — pure undo/redo stacks over immutable CircuitLayout
 * references (glue agent). The store's layouts are immutable-by-convention
 * (every mutation builds a fresh object), so entries are plain references —
 * no cloning, no serialization.
 *
 * Semantics:
 * - `push(preMutationLayout, tag?)` is called immediately BEFORE a document
 *   mutation commits. Any push clears the redo stack (the timeline diverged).
 * - Capacity: 100 entries; the oldest entry is dropped beyond that.
 * - Coalescing: a push tagged `param:<compId>:<key>` arriving within 800 ms
 *   of the previous push with the IDENTICAL tag merges into that entry — the
 *   stack keeps the OLDEST pre-mutation snapshot and slides the time window
 *   forward — so a continuous slider drag is ONE undo step that restores the
 *   pre-drag layout. Only `param:` tags coalesce; the clock is injectable
 *   for tests (defaults to Date.now).
 * - `undo(current)` / `redo(current)` pop one stack, push `current` onto the
 *   opposite stack, and return the layout to restore (null when empty).
 *
 * History never persists — the app boots with fresh, empty stacks.
 */
import type { CircuitLayout } from '../model/types'

/** Maximum retained undo entries. */
export const HISTORY_CAP = 100
/** Same-tag `param:` pushes within this window merge into one undo step. */
export const COALESCE_WINDOW_MS = 800

interface HistoryEntry {
  layout: CircuitLayout
  tag?: string
  /** Clock reading of the latest push merged into this entry. */
  at: number
}

export interface LayoutHistoryOptions {
  /** Entry capacity (default HISTORY_CAP = 100). */
  cap?: number
  /** Injectable clock for coalescing tests (default Date.now). */
  now?: () => number
}

export class LayoutHistory {
  private undoStack: HistoryEntry[] = []
  private redoStack: CircuitLayout[] = []
  private readonly cap: number
  private readonly now: () => number

  constructor(opts: LayoutHistoryOptions = {}) {
    this.cap = Math.max(1, opts.cap ?? HISTORY_CAP)
    this.now = opts.now ?? Date.now
  }

  get canUndo(): boolean {
    return this.undoStack.length > 0
  }

  get canRedo(): boolean {
    return this.redoStack.length > 0
  }

  /** Record the pre-mutation layout. Clears redo (the timeline diverged). */
  push(layout: CircuitLayout, tag?: string): void {
    const at = this.now()
    this.redoStack.length = 0

    const top = this.undoStack[this.undoStack.length - 1]
    if (
      tag !== undefined &&
      tag.startsWith('param:') &&
      top !== undefined &&
      top.tag === tag &&
      at - top.at <= COALESCE_WINDOW_MS
    ) {
      // Coalesce: keep the oldest snapshot (undo restores the pre-drag
      // layout) and slide the window so an ongoing drag keeps merging.
      top.at = at
      return
    }

    this.pushEntry({ layout, tag, at })
  }

  /**
   * Step back: returns the layout to restore (the caller's new document) and
   * stashes `current` for redo. Null when there is nothing to undo.
   */
  undo(current: CircuitLayout): CircuitLayout | null {
    const entry = this.undoStack.pop()
    if (!entry) return null
    this.redoStack.push(current)
    return entry.layout
  }

  /**
   * Step forward again: returns the layout to restore and stashes `current`
   * back on the undo stack. Null when there is nothing to redo.
   */
  redo(current: CircuitLayout): CircuitLayout | null {
    const layout = this.redoStack.pop()
    if (layout === undefined) return null
    // untagged: a redone state must never coalesce with later edits
    this.pushEntry({ layout: current, at: this.now() })
    return layout
  }

  clear(): void {
    this.undoStack.length = 0
    this.redoStack.length = 0
  }

  private pushEntry(entry: HistoryEntry): void {
    this.undoStack.push(entry)
    if (this.undoStack.length > this.cap) {
      this.undoStack.splice(0, this.undoStack.length - this.cap)
    }
  }
}
