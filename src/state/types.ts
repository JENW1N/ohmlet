/**
 * Application store contract (implemented with zustand in src/state/store.ts).
 * CONTRACT FILE — the UI agent codes against this; the glue agent implements it.
 */

import type {
  BoardSizeId,
  CircuitLayout,
  EndpointRef,
  HoleRef,
  ParamValue,
  Rotation,
  ScopeSample,
  SimIssue,
  SimTelemetry,
} from '../model/types'
import type { RenderModeId } from '../three/render-modes/capability'

export type InteractionMode =
  | { kind: 'select' }
  /**
   * Placing a new component of catalog type `type`; leads placed
   * click-by-click. `rotation` (dip/footprint packages only; absent = 0) is
   * the armed in-plane rotation — cycled by `rotateArmed()` (R key) and
   * threaded into `addComponent` on commit.
   */
  | { kind: 'place'; type: string; pickedHoles: HoleRef[]; rotation?: Rotation }
  /** drawing a wire: `from` is set after the first click */
  | { kind: 'wire'; from: EndpointRef | null; color: string }

/**
 * Where a move lands (`previewMove` / `commitMove`):
 *  - `{ anchor }` re-anchors a SINGLE dip/footprint package: its pin-1 hole
 *    moves to `anchor` (rotation is kept). Valid only for exactly one
 *    selected package — leads parts and groups use the delta form.
 *  - `{ dCol, dRowLattice }` translates a group: every strip hole shifts by
 *    `dCol` columns and `dRowLattice` strip-row-lattice steps (index into
 *    'a'..'j'; the e→f channel hop is ONE lattice step), rail holes shift by
 *    `dCol` rail indices (and refuse any vertical component — rails have no
 *    row lattice), and dip/footprint anchors shift columns only
 *    (`dRowLattice` must be 0: packages stay pinned to their anchor row).
 *
 * Validity is ALL-OR-NOTHING across the moved set: bounds, module seams,
 * occupancy and body occlusion are checked with the moving parts' own old
 * holes vacated; if any moved part would land invalid, nothing moves.
 * Wires always STAY PUT (v1 semantics): moving a part re-plugs its leads
 * into the new holes while attached wires keep their old endpoints.
 */
export type MoveTarget = { anchor: HoleRef } | { dCol: number; dRowLattice: number }

/**
 * `growGrid` direction. 'right' adds a board module, 'down' adds a
 * board-row; 'left'/'up' do the same AND remap every hole ref so the
 * existing content keeps its place relative to the new top-left origin.
 */
export type GrowDirection = 'right' | 'left' | 'up' | 'down'

export interface LlmState {
  apiKey: string
  busy: boolean
  /** human-readable progress line while generating ("thinking…", "validating…", "repairing…") */
  status: string
  /** model's explanation of the generated circuit */
  explanation: string | null
  /** generated layout awaiting Apply/Discard */
  pending: CircuitLayout | null
  error: string | null
}

export interface AppState {
  // --- document ---
  layout: CircuitLayout
  /**
   * Selected component/wire ids (empty = nothing selected). A single id
   * presents the Properties sheet; multiple ids present the compact group
   * view (count + group delete).
   */
  selection: string[]
  mode: InteractionMode
  hoverHole: HoleRef | null
  /** an undo step is available (mirrors the in-memory history; never persisted) */
  canUndo: boolean
  /** a redo step is available */
  canRedo: boolean

  // --- simulation ---
  running: boolean
  simSpeed: number // 0.1 | 1 | 10 ...
  simTime: number
  telemetry: SimTelemetry | null
  issues: SimIssue[]
  scope: { samples: ScopeSample[]; timeWindow: number }

  // --- preferences ---
  /**
   * Render-mode preference, persisted under 'bb.renderMode'. `null` = unset:
   * the scene's RenderModeManager applies the device auto-default
   * (phone → performance, desktop → enhanced). The scene integrator consumes
   * this; the store only owns the persisted choice.
   */
  renderMode: RenderModeId | null

  // --- llm ---
  llm: LlmState

  // --- actions: document ---
  /**
   * Add a part. `rotation` applies to dip/footprint packages only (quarter
   * turns; DIPs accept 0|180) and is ignored for other placements. Refused
   * silently when any pin hole is occupied, body-occluded, off the rig, or
   * the package straddles a module seam.
   */
  addComponent(type: string, opts: { holes?: HoleRef[]; at?: HoleRef; rotation?: Rotation }): void
  /** Remove EVERY selected component and wire as ONE undo step. */
  removeSelected(): void
  removeComponent(id: string): void
  removeWire(id: string): void
  addWire(from: EndpointRef, to: EndpointRef, color?: string): void
  setParam(componentId: string, key: string, value: ParamValue): void
  /** Replace the selection with `[id]`; `null` clears (= clearSelection). */
  select(id: string | null): void
  /** Add `id` to the selection, or remove it when already selected. */
  toggleSelect(id: string): void
  /** Empty the selection. */
  clearSelection(): void
  /** Replace the selection with `ids` (deduped) — marquee/box select. */
  marqueeSelect(ids: string[]): void
  setMode(mode: InteractionMode): void
  setHoverHole(h: HoleRef | null): void
  clearBoard(): void
  /** validate + replace the whole layout (used by import and LLM apply) */
  loadLayout(layout: CircuitLayout): { ok: boolean; errors: string[] }
  exportJson(): string
  /** step back through document history (no-op when canUndo is false) */
  undo(): void
  /** step forward again (no-op when canRedo is false) */
  redo(): void

  // --- actions: move / rotate ---
  /**
   * Would `commitMove(ids, target)` succeed right now? Pure — no state
   * change. Drives the drag hologram's valid/invalid tint.
   */
  previewMove(ids: string[], target: MoveTarget): { valid: boolean }
  /**
   * Move the components in `ids` to `target` (see MoveTarget). Wire ids in
   * the set are ignored (wires stay put). ALL-OR-NOTHING: if any moved part
   * would land invalid, nothing moves and `ok` is false. One undo step.
   */
  commitMove(ids: string[], target: MoveTarget): { ok: boolean }
  /**
   * Nudge the currently selected components (desktop arrow keys):
   * `commitMove(selection, { dCol, dRowLattice })`. `dRowLattice` shifts
   * leads parts along the strip-row lattice; any selected dip/footprint
   * package makes a vertical nudge invalid (packages stay on their row).
   */
  moveSelection(dCol: number, dRowLattice?: number): void
  /**
   * Cycle the armed place-mode rotation (R key while placing): DIP packages
   * toggle 0↔180, footprints step quarter turns; no-op otherwise.
   */
  rotateArmed(): void
  /**
   * Rotate a placed dip/footprint package to its next VALID rotation
   * (re-validated holes incl. occupancy + occlusion + seams; DIPs toggle
   * 0↔180 in place). No-op (`ok: false`) when no other rotation fits.
   * One undo step.
   */
  rotatePlaced(id: string): { ok: boolean }

  // --- actions: instruments ---
  /**
   * Move an off-board instrument to an explicit bench position (plan units,
   * 0.5 grid). Validated by the model rules (grid snap, body clear of the
   * board and of other instruments); refused with a user-presentable error.
   * Undoable (a continuous drag coalesces into one step). Engine rebuild is
   * NOT needed (positions are visual) but the layout identity bumps so the
   * scene replans wire routes.
   */
  setInstrumentPos(id: string, pos: { x: number; z: number }): { ok: boolean; error?: string }

  // --- actions: board / grid ---
  /**
   * Switch the board size preset (one undoable step), keeping the current
   * module count. Growing always succeeds; shrinking is refused — with a
   * user-presentable `error` — when any component lead or wire endpoint
   * would fall off the smaller rig.
   */
  setBoardSize(size: BoardSizeId): { ok: boolean; error?: string }
  /**
   * Set how many board modules are ganged side by side (integer
   * 1..MAX_BOARD_COUNT, one undoable step). Growing always succeeds;
   * shrinking is refused — with a user-presentable `error` reporting how
   * many parts would be stranded — when any component lead or wire endpoint
   * would fall off the smaller rig.
   */
  setBoardCount(n: number): { ok: boolean; error?: string }
  /**
   * Set how many board-rows are stacked front-to-back (integer
   * 1..MAX_BOARD_ROWS, one undoable step). Shrink-protected like
   * setBoardCount; growth auto-nudges any explicit-position instrument that
   * the deeper board would now overlap.
   */
  setBoardRows(n: number): { ok: boolean; error?: string }
  /**
   * Grow the 2-D grid by one module ('right'/'left') or one board-row
   * ('down'/'up'). 'left'/'up' also remap every hole ref (+1 module of
   * columns / +1 board-row) so the content keeps its place relative to the
   * new top-left origin. Instruments keep their ABSOLUTE `pos` but are
   * auto-nudged to clear bench space when the grown board would overlap
   * them. ONE undo step; refused at the MAX_BOARD_COUNT/MAX_BOARD_ROWS cap.
   */
  growGrid(direction: GrowDirection): { ok: boolean; error?: string }

  // --- actions: preferences ---
  /**
   * Persist + apply the render-mode preference under 'bb.renderMode'
   * (`null` clears it back to the device auto-default).
   */
  setRenderMode(mode: RenderModeId | null): void

  // --- actions: simulation ---
  startSim(): void
  stopSim(): void
  resetSim(): void
  setSimSpeed(x: number): void
  setScopeWindow(seconds: number): void

  // --- actions: llm ---
  setApiKey(k: string): void
  generateFromPrompt(prompt: string): Promise<void>
  /** abort the in-flight generation, if any (no-op while idle) */
  cancelGeneration(): void
  applyPending(): void
  discardPending(): void
}
