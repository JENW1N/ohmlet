/**
 * 3D scene contract. CONTRACT FILE.
 * Implemented by src/three/scene.ts (scene agent); driven by the store/App
 * (glue agent); component visuals come from src/three/component-meshes.ts
 * (meshes agent).
 */

import type { CircuitLayout, HoleRef, Rotation, SimTelemetry } from '../model/types'
import type { RenderModeId } from './render-modes/capability'
import type { StudioProgress } from './render-modes/types'

/**
 * Studio render-mode progress (chunk load / BVH build / samples-per-pixel /
 * converged) surfaced to the host UI — see src/three/render-modes/types.ts.
 */
export type RenderProgress = StudioProgress

/** App interaction mode relevant to the scene's touch ergonomics. */
export type SceneInteractionMode = 'select' | 'place' | 'wire'

/**
 * Direction the 2-D board grid grows when a "+" paddle is tapped:
 * 'right'/'left' add a module to every board-row, 'down'/'up' add a
 * board-row. Structurally identical to the store's GrowDirection
 * (state/types.ts) — the host forwards it to store.growGrid.
 */
export type GridGrowDirection = 'right' | 'left' | 'up' | 'down'

/**
 * Where a scene move-drag wants to land — structurally identical to the
 * store's MoveTarget (state/types.ts):
 *  - `{ anchor }`: a SINGLE selected dip/footprint package re-anchors its
 *    pin-1 hole (free drag, may hop rows/board-rows).
 *  - `{ dCol, dRowLattice }`: a group / leads selection translates by whole
 *    columns and strip-row-lattice steps.
 */
export type SceneMoveTarget = { anchor: HoleRef } | { dCol: number; dRowLattice: number }

export interface SceneCallbacks {
  /** a board hole was clicked (placement / wiring) */
  onHoleClick(hole: HoleRef): void
  /** pointer hovers a hole (or left all holes → null) */
  onHoleHover(hole: HoleRef | null): void
  /**
   * a component body or wire was clicked. `additive` (ADDITIVE contract
   * extension — desktop shift/cmd/ctrl+click) asks the host to TOGGLE the
   * object in the selection instead of replacing it (store.toggleSelect);
   * absent/false keeps the classic replace semantics.
   */
  onObjectClick(id: string, additive?: boolean): void
  /** click on empty space */
  onBackgroundClick(): void
  /** off-board terminal clicked, ref = "ID:PIN" (for wiring) */
  onTerminalClick(ref: string): void
  /**
   * OPTIONAL (additive): a place/wire commit aimed at `hole` was REJECTED
   * because a component body covers it (occlusion). Fired for quick taps and
   * fingertip lift-commits alike — the host should explain WHY (toast naming
   * the covering part); the scene itself only pins the red locked chip.
   */
  onHoleOcclusionRejected?(hole: HoleRef): void
  /**
   * OPTIONAL (additive): a component body or wire was long-pressed (~500ms
   * hold within 10px — DESIGN.md §4 action-sheet gesture). The scene
   * suppresses the tap that would otherwise fire on the matching pointerup.
   */
  onObjectLongPress?(id: string): void
  /**
   * OPTIONAL (additive): the "add board" plus paddle (shown at the right edge
   * of the last module while in select mode with the sim stopped and fewer
   * than MAX_BOARD_COUNT modules) was tapped. The host grows the rig via
   * store.setBoardCount(count + 1). Superseded by onGrowGrid — when both are
   * set, the right paddle reports through onGrowGrid('right') only.
   */
  onAddBoardClick?(): void
  /**
   * OPTIONAL (additive): one of the FOUR "+" paddles (right/left/top/bottom
   * edges of the 2-D grid; hidden at the axis cap, while the sim runs, and in
   * non-select modes) was tapped. The host grows the grid via
   * store.growGrid(direction).
   */
  onGrowGrid?(direction: GridGrowDirection): void
  /**
   * OPTIONAL (additive): the quiet board-removal affordance. Fired by the
   * small "−" chip revealed beneath a hovered "+" paddle (desktop) or by a
   * long-press on the paddle (touch), only on edges the store can shrink:
   * 'right' drops the rightmost module column, 'down' the deepest board-row.
   * The host shrinks via store.setBoardCount/setBoardRows — their shrink
   * protection already refuses (with a user-presentable error) when parts
   * would be stranded; on success the scene lifts the removed boards away.
   */
  onShrinkGrid?(direction: GridGrowDirection): void
  /**
   * OPTIONAL (additive): a move-drag of the selected part(s) is hovering
   * `target` — return whether the drop would commit (drives the cyan/red
   * hologram tint). Pure; the host answers from store.previewMove. Missing
   * callback = the scene assumes valid.
   */
  onMovePreview?(ids: string[], target: SceneMoveTarget): boolean
  /**
   * OPTIONAL (additive): a move-drag of the selected part(s) dropped on a
   * valid `target`. The host commits via store.commitMove (all-or-nothing,
   * one undo step; wires stay put).
   */
  onMoveCommit?(ids: string[], target: SceneMoveTarget): void
  /**
   * OPTIONAL (additive): a desktop shift+drag marquee finished; `ids` are the
   * components/wires whose screen-projected centers fell inside the rectangle
   * (empty = clear). The host replaces the selection via store.marqueeSelect.
   */
  onMarqueeSelect?(ids: string[]): void
  /**
   * OPTIONAL (additive): an instrument drag is hovering bench position `pos`
   * (plan units, snapped to the 0.5 grid) — return whether the drop would
   * commit (validity tint). Missing callback = assumed valid.
   */
  onInstrumentMovePreview?(id: string, pos: { x: number; z: number }): boolean
  /**
   * OPTIONAL (additive): a selected off-board instrument was dropped at bench
   * position `pos` (0.5-grid snapped). The host commits via
   * store.setInstrumentPos; committed layouts replan wire routes.
   */
  onInstrumentMoveCommit?(id: string, pos: { x: number; z: number }): void
  /**
   * OPTIONAL (additive): Studio render-mode progress for the status capsule
   * (loading the ray-tracer chunk / building the BVH / "rendering… N/M
   * samples" / converged). Fired from the scene's render loop; the payload
   * object is REUSED between calls — copy it if you keep it.
   */
  onRenderProgress?(progress: RenderProgress): void
}

export interface GhostSpec {
  type: string
  /** anchor hole under the cursor */
  at: HoleRef
  valid: boolean
  /**
   * OPTIONAL (additive): holes already picked for a multi-click leaded part
   * (store place-mode pickedHoles). With one hole picked for a 2-lead part
   * the scene shows the FULL routed holographic part stretching from the
   * picked hole to the hovered anchor — vertical mounts included.
   */
  picked?: HoleRef[]
  /**
   * OPTIONAL (additive): armed in-plane rotation for dip/footprint packages
   * (store place-mode `mode.rotation`; absent = 0). The hologram renders at
   * this rotation — cycling it (R key / rotate button) spins the hologram
   * with a quick spring — and `valid` should already account for it.
   */
  rotation?: Rotation
}

export interface IBreadboardScene {
  mount(container: HTMLElement): void
  dispose(): void
  setCallbacks(cb: Partial<SceneCallbacks>): void

  /** diff & rebuild meshes to match the layout */
  setLayout(layout: CircuitLayout): void
  /** apply live electrical state (LED glow, 7-seg segments...); null = sim stopped */
  setTelemetry(t: SimTelemetry | null): void
  /** translucent preview of the component being placed; null = none */
  setGhost(ghost: GhostSpec | null): void
  /** highlight selected object ids */
  setSelection(ids: string[]): void
  /** wire-drawing preview from a fixed endpoint to the hovered hole */
  setWirePreview(from: HoleRef | string | null, to: HoleRef | null): void
  /**
   * OPTIONAL (additive): report the app's interaction mode so the scene can
   * adapt touch ergonomics (fingertip ghost-cursor during place/wire; a
   * one-finger touch drag then aims the cursor instead of orbiting). Safe to
   * never call — the scene falls back to inferring the mode from
   * setGhost/setWirePreview.
   */
  setInteractionMode?(mode: SceneInteractionMode): void
  /**
   * OPTIONAL (additive): spring the camera (DESIGN.md spring, reduced-motion
   * jump) to frame the current layout's content. Called by the host after a
   * wholesale layout load (example, JSON import, AI apply) so circuits placed
   * anywhere on the board become visible — the fixed home framing crops phone
   * portrait viewports to a fraction of the board. Falls back to the home
   * framing when the board is empty. Safe to never call.
   */
  frameContent?(): void
  /**
   * OPTIONAL (additive): apply the user's render-mode preference (the
   * Performance / Enhanced / Studio picker in the More sheet →
   * store.renderMode). The scene's RenderModeManager clamps unsupported
   * modes to the device's best fallback and persists the choice under
   * 'bb.renderMode'. Safe to never call — the scene boots from the persisted
   * preference / device auto-default on its own.
   */
  setRenderMode?(mode: RenderModeId): void
}
