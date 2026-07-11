/**
 * App shell — phone-first "liquid glass" chrome over the full-bleed 3D canvas
 * (DESIGN.md §2). Owns the single BreadboardScene instance and all of the
 * scene↔store glue (placement-by-clicks, DIP ghost, off-board immediate
 * placement, repeat placement, two-click wiring, hover ghost, selection),
 * plus the chrome state machine: StatusBar capsule (run/pause/reset), bottom
 * Dock (Parts · Wire · AI · Scope · More) opening their sheets, the
 * WireColorStrip while wire mode is armed, placement/wire hints as toasts,
 * the EmptyState card, first-launch Onboarding, and the long-press component
 * ActionSheet. Desktop ≥900px: the dock becomes a left rail and the sheets
 * become floating panels (Sheet panel mode).
 *
 * UI chrome state (which sheet is open, onboarding…) lives HERE in React
 * state — never in the store.
 */
import { useEffect, useRef, useState } from 'react'
import type { AppState, GrowDirection, MoveTarget } from './state/types'
import { boardConfigOf } from './model/types'
import type { HoleRef, Rotation } from './model/types'
import { placementValid, setLayoutLoadedSink, setTelemetrySink, useStore } from './state/store'
import { getEntry } from './model/catalog'
import { occludedHoles } from './model/occlusion'
import { validateLayout } from './model/validate'
import { BreadboardScene } from './three/scene'
import type { RenderProgress } from './three/scene-api'
import type { RenderModeId } from './three/render-modes/capability'
import {
  ActionSheet,
  ChipIcon,
  Dock,
  EllipsisIcon,
  SparklesIcon,
  ToastHost,
  WaveformIcon,
  WireIcon,
  dismissToast,
  showToast,
  tick,
  useIsDesktop,
  type ActionSheetAction,
  type DockItem,
} from './ui/kit'
import { EmptyState, Onboarding, StatusBar, WireColorStrip, hintForMode, markOnboarded, needsOnboarding, pushRenderProgress } from './ui/chrome'
import { UndoPill } from './ui/chrome/UndoPill'
import { SelectionPill } from './ui/chrome/SelectionPill'
import { RotateButton } from './ui/chrome/RotateButton'
import { PartsSheet } from './ui/sheets/PartsSheet'
import { AiSheet } from './ui/sheets/AiSheet'
import { ScopeSheet } from './ui/sheets/ScopeSheet'
import { MoreSheet } from './ui/sheets/MoreSheet'
import { PropertiesSheet } from './ui/sheets/PropertiesSheet'
import './app.css'

// ---------------------------------------------------------------------------
// Scene ↔ store glue (pure functions of the store state, no React state)
// ---------------------------------------------------------------------------

/** Keep the ghost footprint and wire-drawing preview in sync with the store. */
function syncOverlays(scene: BreadboardScene, s: AppState): void {
  const mode = s.mode

  if (mode.kind === 'place' && s.hoverHole) {
    const entry = getEntry(mode.type)
    if (entry && entry.placement !== 'offboard') {
      scene.setGhost({
        type: mode.type,
        at: s.hoverHole,
        // rotation-aware (R key cycles mode.rotation for dip/footprint parts)
        valid: placementValid(s.layout, mode.type, s.hoverHole, mode.pickedHoles, mode.rotation),
        // already-picked holes → the scene shows the FULL routed holographic
        // part stretching first-hole → hover for 2-lead leaded parts
        picked: mode.pickedHoles,
        // the hologram renders AT the armed rotation (R / rotate button spins it)
        rotation: mode.rotation,
      })
    } else {
      scene.setGhost(null)
    }
  } else {
    scene.setGhost(null)
  }

  if (mode.kind === 'wire' && mode.from) scene.setWirePreview(mode.from, s.hoverHole)
  else scene.setWirePreview(null, null)
}

/** Wire-mode click on any endpoint (hole or off-board terminal). */
function wireEndpointClick(endpoint: string): void {
  const st = useStore.getState()
  if (st.mode.kind !== 'wire') return
  const { from, color } = st.mode
  if (!from) {
    st.setMode({ kind: 'wire', from: endpoint, color })
    return
  }
  const before = st.layout.wires.length
  st.addWire(from, endpoint, color)
  if (useStore.getState().layout.wires.length > before) {
    tick() // wire complete (DESIGN.md §1 Haptics)
    st.setMode({ kind: 'wire', from: null, color }) // done — ready for the next wire
  }
  // refused (occupied/duplicate/self): keep `from` so the user can re-aim
}

/** Is `id` a placed dip/footprint package (the only parts rotatePlaced accepts)? */
function isRotatableComponent(st: AppState, id: string): boolean {
  const comp = st.layout.components.find((c) => c.id === id)
  const entry = comp ? getEntry(comp.type) : undefined
  return !!entry && (entry.placement === 'dip' || entry.placement === 'footprint')
}

/**
 * Rotate a placed package via the store (one undo step) with user feedback:
 * haptic tick on success, teaching toast when no other rotation fits. Shared
 * by the long-press ActionSheet "Rotate" row and the R key in select mode.
 */
function rotatePlacedWithFeedback(id: string): void {
  const st = useStore.getState()
  if (st.rotatePlaced(id).ok) tick()
  else showToast(`${id} can't rotate — no other rotation fits here`, { duration: 3200 })
}

function handleHoleClick(hole: HoleRef): void {
  const st = useStore.getState()
  const mode = st.mode

  if (mode.kind === 'wire') {
    wireEndpointClick(hole)
    return
  }

  if (mode.kind === 'place') {
    const entry = getEntry(mode.type)
    if (!entry) return

    if (entry.placement === 'dip' || entry.placement === 'footprint') {
      const before = st.layout.components.length
      st.addComponent(mode.type, { at: hole, rotation: mode.rotation })
      const comps = useStore.getState().layout.components
      if (comps.length > before) {
        tick() // placement commit
        st.setMode({ kind: 'select' })
        st.select(comps[comps.length - 1].id)
      }
      return
    }

    if (entry.placement === 'leads' || entry.placement === 'probe') {
      // ignore clicks on occupied / already-picked holes (ghost shows red)
      if (!placementValid(st.layout, mode.type, hole, mode.pickedHoles)) return
      const picked = [...mode.pickedHoles, hole]
      if (picked.length < entry.pins.length) {
        st.setMode({ kind: 'place', type: mode.type, pickedHoles: picked })
        return
      }
      const before = st.layout.components.length
      st.addComponent(mode.type, { holes: picked })
      const comps = useStore.getState().layout.components
      const added = comps.length > before
      if (added) tick() // placement commit
      if (added && entry.placement === 'leads') {
        // stay in place mode for repeat placement of leads parts
        st.setMode({ kind: 'place', type: mode.type, pickedHoles: [] })
      } else if (added) {
        st.setMode({ kind: 'select' })
        st.select(comps[comps.length - 1].id)
      } else {
        st.setMode({ kind: 'place', type: mode.type, pickedHoles: [] })
      }
      return
    }
    return
  }

  // select mode: clicking a bare hole clears the selection
  if (st.selection.length > 0) st.clearSelection()
}

function handleTerminalClick(ref: string): void {
  const st = useStore.getState()
  if (st.mode.kind === 'wire') {
    wireEndpointClick(ref)
    return
  }
  if (st.mode.kind === 'select') {
    const id = ref.split(':')[0]
    if (st.layout.components.some((c) => c.id === id)) st.select(id)
  }
}

function handleObjectClick(id: string, additive?: boolean): void {
  const st = useStore.getState()
  if (st.mode.kind !== 'select') return
  // additive (desktop shift/cmd/ctrl+click) TOGGLES the part in the
  // selection — the multi-select path beyond the marquee; a plain click
  // keeps the classic replace semantics
  if (additive) st.toggleSelect(id)
  else st.select(id)
}

/**
 * A place/wire commit aimed at a body-covered hole was rejected by the
 * scene. The red locked chip shows WHERE — this toast explains WHY, naming
 * the covering component (the same occlusion model the validator uses), so
 * even a quick tap (which never sees the aim chip) gets feedback.
 */
let occlusionToastId: number | null = null
function handleHoleOcclusionRejected(hole: HoleRef): void {
  const st = useStore.getState()
  const config = boardConfigOf(st.layout)
  let coverer: string | null = null
  for (const comp of st.layout.components) {
    const entry = getEntry(comp.type)
    if (!entry) continue
    if (occludedHoles(comp, entry, config).has(hole)) {
      coverer = entry.label ? `${comp.id} (${entry.label})` : comp.id
      break
    }
  }
  if (occlusionToastId != null) dismissToast(occlusionToastId) // rapid retaps replace
  occlusionToastId = showToast(
    coverer
      ? `${hole} is covered by ${coverer} — move it or pick a clear hole`
      : `${hole} is covered by a component body — pick a clear hole`,
    { duration: 2800 },
  )
}

function handleBackgroundClick(): void {
  const st = useStore.getState()
  if (st.mode.kind === 'wire' && st.mode.from) {
    st.setMode({ kind: 'wire', from: null, color: st.mode.color }) // cancel the started wire
    return
  }
  if (st.mode.kind === 'select' && st.selection.length > 0) st.clearSelection()
}

/** Legacy plus-paddle tap: grow the rig by one module (scene springs it in). */
function handleAddBoardClick(): void {
  const st = useStore.getState()
  const count = boardConfigOf(st.layout).count
  const res = st.setBoardCount(count + 1)
  if (res.ok) tick() // placement-commit-grade haptic (DESIGN.md §1)
  else if (res.error) showToast(res.error)
}

/** "+" paddle tap on any grid edge: grow the 2-D grid (left/up also remap). */
function handleGrowGrid(direction: GrowDirection): void {
  const res = useStore.getState().growGrid(direction)
  if (res.ok) {
    tick() // placement-commit-grade haptic (DESIGN.md §1)
    maybeHintShrink()
  } else if (res.error) {
    showToast(res.error)
  }
}

/**
 * One-time teaching toast for the TOUCH removal gesture (the desktop "−"
 * chip is hover-discoverable; long-press is not): shown the first time a
 * coarse-pointer user grows the grid past one board — exactly when removal
 * becomes possible and the paddle they just used is the removal surface too.
 */
const SHRINK_HINT_KEY = 'bb.hintShrink'
function maybeHintShrink(): void {
  try {
    if (!window.matchMedia('(pointer: coarse)').matches) return
    if (window.localStorage.getItem(SHRINK_HINT_KEY)) return
    window.localStorage.setItem(SHRINK_HINT_KEY, '1')
  } catch {
    return // no matchMedia / storage: skip the hint rather than nag forever
  }
  showToast('Long-press a + paddle to remove a board', { duration: 3600 })
}

/**
 * "−" chip (desktop hover) / paddle long-press (touch): remove a board from
 * that edge via the EXISTING store shrink — setBoardCount/setBoardRows
 * shrink protection refuses (with its own explanatory error) when any part
 * or wire would be stranded on the removed module/row.
 */
function handleShrinkGrid(direction: GrowDirection): void {
  const st = useStore.getState()
  const config = boardConfigOf(st.layout)
  const res =
    direction === 'right' || direction === 'left'
      ? st.setBoardCount(config.count - 1)
      : st.setBoardRows((config.rows ?? 1) - 1)
  if (res.ok) tick(16) // delete-grade haptic (DESIGN.md §1)
  else if (res.error) showToast(res.error)
}

/** Drag-to-move preview: would the drop commit? (drives the hologram tint) */
function handleMovePreview(ids: string[], target: MoveTarget): boolean {
  return useStore.getState().previewMove(ids, target).valid
}

/** Drag-to-move drop: all-or-nothing commit (one undo step; wires stay put). */
function handleMoveCommit(ids: string[], target: MoveTarget): void {
  if (useStore.getState().commitMove(ids, target).ok) tick()
}

/** Instrument bench-drag preview: full model validation of the candidate pos. */
function handleInstrumentMovePreview(id: string, pos: { x: number; z: number }): boolean {
  const layout = useStore.getState().layout
  const components = layout.components.map((c) => (c.id === id ? { ...c, pos } : c))
  return validateLayout({ ...layout, components }).ok
}

/** Instrument bench-drag drop → store.setInstrumentPos (wires replan). */
function handleInstrumentMoveCommit(id: string, pos: { x: number; z: number }): void {
  const res = useStore.getState().setInstrumentPos(id, pos)
  if (res.ok) tick()
  else if (res.error) showToast(res.error)
}

/**
 * Teaching toast for an invalid armed rotation (R key / rotate button): the
 * text comes from validateLayout on a probe placement, so the explanation is
 * the validator's own ("straddles the channel", "covered by ...", ...).
 */
function rotationProblemText(type: string, at: HoleRef, rotation: Rotation): string | null {
  const st = useStore.getState()
  const entry = getEntry(type)
  if (!entry) return null
  // the probe id must itself satisfy the validator's id rules ('__rot__'
  // started with an underscore, so EVERY toast read as the id-rule error
  // instead of the real placement problem — Phase-C verification fix)
  const PROBE_ID = 'ROTATION_PROBE_X9'
  const probe =
    rotation !== 0
      ? { id: PROBE_ID, type, at, rotation }
      : { id: PROBE_ID, type, at }
  const res = validateLayout({ ...st.layout, components: [...st.layout.components, probe] })
  if (res.ok) return null
  const err = res.errors.find((e) => e.includes(PROBE_ID)) ?? res.errors[0]
  return err
    ? err.split(`"${PROBE_ID}"`).join(entry.label).split(PROBE_ID).join(entry.label)
    : null
}

/**
 * One-time toast when Studio is picked on a phone-class (coarse-pointer)
 * device: ray tracing is allowed there, but it runs at reduced internal
 * resolution and is heavy on the GPU/battery — say so exactly once.
 */
const STUDIO_PHONE_WARNED_KEY = 'bb.studioPhoneWarned'
function maybeWarnStudioOnPhone(mode: RenderModeId): void {
  if (mode !== 'studio') return
  try {
    if (!window.matchMedia('(pointer: coarse)').matches) return
    if (window.localStorage.getItem(STUDIO_PHONE_WARNED_KEY)) return
    window.localStorage.setItem(STUDIO_PHONE_WARNED_KEY, '1')
  } catch {
    return // no matchMedia / storage: skip the warning rather than nag forever
  }
  showToast('Studio ray traces at reduced resolution on this device — expect battery drain', {
    duration: 4500,
  })
}

function isEditableTarget(t: EventTarget | null): boolean {
  if (!(t instanceof HTMLElement)) return false
  const tag = t.tagName
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || t.isContentEditable
}

/** Duplicate via re-placement: same type re-enters place mode (the user taps
 *  the holes for the copy); off-board instruments are added immediately with
 *  their params copied. */
function duplicateComponent(id: string): void {
  const st = useStore.getState()
  const comp = st.layout.components.find((c) => c.id === id)
  if (!comp) return
  const entry = getEntry(comp.type)
  if (!entry) return
  if (entry.placement === 'offboard') {
    const before = st.layout.components.length
    st.addComponent(comp.type, {})
    const comps = useStore.getState().layout.components
    if (comps.length > before && comp.params) {
      const newId = comps[comps.length - 1].id
      for (const [k, v] of Object.entries(comp.params)) st.setParam(newId, k, v)
    }
    showToast(`${entry.label} duplicated`)
  } else {
    st.select(null)
    st.setMode({ kind: 'place', type: comp.type, pickedHoles: [] })
  }
}

// ---------------------------------------------------------------------------
// App
// ---------------------------------------------------------------------------

type SheetKey = 'parts' | 'ai' | 'scope' | 'more'
type DockKey = SheetKey | 'wire' | 'none'

export default function App() {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const isDesktop = useIsDesktop()

  // --- chrome state machine (React state, never the store) ---
  const [activeSheet, setActiveSheet] = useState<SheetKey | null>(null)
  const [actionTarget, setActionTarget] = useState<string | null>(null)
  const [onboarding, setOnboarding] = useState(needsOnboarding)
  const [aiPrefill, setAiPrefill] = useState<string | undefined>(undefined)

  const mode = useStore((s) => s.mode)
  const selection = useStore((s) => s.selection)
  const boardEmpty = useStore((s) => s.layout.components.length === 0)
  const issueCount = useStore((s) => s.issues.length)
  const select = useStore((s) => s.select)

  const wireArmed = mode.kind === 'wire'
  const lastWireColor = useRef('red')
  if (mode.kind === 'wire') lastWireColor.current = mode.color

  // mount the 3D scene once; keep it in sync with the store
  useEffect(() => {
    const container = containerRef.current
    if (!container) return

    const scene = new BreadboardScene()
    scene.mount(container)
    // latest Studio render progress (COPIED — the engine reuses the payload
    // object); the capsule gets every update, the ?shotrig harness polls it
    // to await a converged still deterministically
    let lastRenderProgress: RenderProgress | null = null
    scene.setCallbacks({
      onHoleClick: handleHoleClick,
      onHoleHover: (h: HoleRef | null) => useStore.getState().setHoverHole(h),
      onObjectClick: handleObjectClick,
      onBackgroundClick: handleBackgroundClick,
      onTerminalClick: handleTerminalClick,
      onHoleOcclusionRejected: handleHoleOcclusionRejected,
      onObjectLongPress: (id: string) => setActionTarget(id),
      onAddBoardClick: handleAddBoardClick, // legacy fallback (onGrowGrid wins)
      onGrowGrid: handleGrowGrid,
      onShrinkGrid: handleShrinkGrid,
      onMovePreview: handleMovePreview,
      onMoveCommit: handleMoveCommit,
      onMarqueeSelect: (ids: string[]) => useStore.getState().marqueeSelect(ids),
      onInstrumentMovePreview: handleInstrumentMovePreview,
      onInstrumentMoveCommit: handleInstrumentMoveCommit,
      onRenderProgress: (p: RenderProgress) => {
        lastRenderProgress = { ...p }
        pushRenderProgress(p) // status capsule: "rendering… N/M samples"
      },
    })

    // initial sync
    const s0 = useStore.getState()
    scene.setLayout(s0.layout)
    scene.setSelection(s0.selection)
    scene.setInteractionMode?.(s0.mode.kind)
    syncOverlays(scene, s0)
    setTelemetrySink((t) => scene.setTelemetry(t)) // also pushes current telemetry

    // Loaded examples / imports / applied AI circuits can sit anywhere on the
    // board, far outside the fixed home framing of a phone viewport — spring
    // the camera to frame them. Same for a restored autosave on boot.
    setLayoutLoadedSink(() => scene.frameContent?.())
    if (s0.layout.components.length > 0 || s0.layout.wires.length > 0) scene.frameContent?.()

    const unsub = useStore.subscribe((s, prev) => {
      if (s.layout !== prev.layout) scene.setLayout(s.layout)
      if (s.selection !== prev.selection) scene.setSelection(s.selection)
      if (s.mode.kind !== prev.mode.kind) scene.setInteractionMode?.(s.mode.kind)
      if (s.mode !== prev.mode || s.hoverHole !== prev.hoverHole || s.layout !== prev.layout) {
        syncOverlays(scene, s)
      }
      // More-sheet graphics picker → the scene's RenderModeManager (the boot
      // value needs no push: the manager reads the same persisted key). On a
      // phone, picking Studio warns once about the reduced-resolution mode.
      if (s.renderMode !== prev.renderMode && s.renderMode) {
        scene.setRenderMode?.(s.renderMode)
        maybeWarnStudioOnPhone(s.renderMode)
      }
    })

    // Screenshot-harness camera rig (scripts/closeups.mjs): exposed ONLY when
    // the page is opened with `?shotrig` — inert in normal use, no UI surface.
    const shotRig =
      typeof window !== 'undefined' && new URLSearchParams(window.location.search).has('shotrig')
    if (shotRig) {
      ;(window as unknown as Record<string, unknown>).__shotRig = {
        setCamera: (px: number, py: number, pz: number, tx: number, ty: number, tz: number) =>
          scene.setCameraPose({ x: px, y: py, z: pz }, { x: tx, y: ty, z: tz }),
        // world point → viewport px (deterministic drag targets for sweeps)
        project: (x: number, y: number, z: number) => scene.projectToScreen({ x, y, z }),
        // latest Studio progress (scripts/modes.mjs awaits `converged`)
        renderProgress: () => lastRenderProgress,
      }
    }

    return () => {
      if (shotRig) delete (window as unknown as Record<string, unknown>).__shotRig
      setLayoutLoadedSink(null)
      setTelemetrySink(null)
      unsub()
      scene.dispose()
    }
  }, [])

  // keyboard (desktop): Esc cancel/deselect, Delete remove, Space run/pause,
  // Cmd/Ctrl+Z undo, Cmd/Ctrl+Shift+Z or Ctrl+Y redo, R = rotate the armed
  // part while placing OR the single selected dip/footprint package in select
  // mode (rotatePlaced — next valid rotation, one undo step), arrow keys =
  // nudge the selection (dCol ±1; Up/Down step leads parts along the
  // strip-row lattice — all-or-nothing)
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (isEditableTarget(e.target)) return
      const st = useStore.getState()
      const key = e.key.toLowerCase()
      if ((e.metaKey || e.ctrlKey) && key === 'z') {
        e.preventDefault()
        if (e.shiftKey) st.redo()
        else st.undo()
        return
      }
      if (e.ctrlKey && key === 'y') {
        e.preventDefault()
        st.redo()
        return
      }
      if (key === 'r' && !e.metaKey && !e.ctrlKey && !e.altKey) {
        if (st.mode.kind === 'place') {
          e.preventDefault()
          st.rotateArmed()
          return
        }
        // select mode: R rotates the single selected dip/footprint package
        if (
          st.mode.kind === 'select' &&
          st.selection.length === 1 &&
          isRotatableComponent(st, st.selection[0])
        ) {
          e.preventDefault()
          rotatePlacedWithFeedback(st.selection[0])
          return
        }
      }
      if (
        st.mode.kind === 'select' &&
        st.selection.length > 0 &&
        (e.key === 'ArrowLeft' || e.key === 'ArrowRight' || e.key === 'ArrowUp' || e.key === 'ArrowDown')
      ) {
        e.preventDefault()
        if (e.key === 'ArrowLeft') st.moveSelection(-1)
        else if (e.key === 'ArrowRight') st.moveSelection(1)
        else if (e.key === 'ArrowUp') st.moveSelection(0, -1)
        else st.moveSelection(0, 1)
        return
      }
      if (e.key === 'Escape') {
        if (st.mode.kind === 'wire' && st.mode.from) {
          st.setMode({ kind: 'wire', from: null, color: st.mode.color })
        } else if (st.mode.kind !== 'select') {
          st.setMode({ kind: 'select' })
        } else if (st.selection.length > 0) {
          st.clearSelection()
        }
      } else if (e.key === 'Delete' || e.key === 'Backspace') {
        if (st.selection.length > 0) {
          e.preventDefault()
          st.removeSelected()
          tick(16)
        }
      } else if (e.key === ' ' || e.code === 'Space') {
        // let focused buttons (incl. the capsule, role="button") activate themselves
        const t = e.target
        if (
          t instanceof HTMLElement &&
          (t.tagName === 'BUTTON' || t.getAttribute('role') === 'button')
        ) {
          return
        }
        e.preventDefault()
        if (st.running) st.stopSim()
        else st.startSim()
        tick()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])

  // teaching toast when cycling to a rotation that cannot fit at the hovered
  // anchor (R key AND the chrome RotateButton both funnel through
  // mode.rotation, so one subscription covers both); text from validateLayout
  const prevRotationRef = useRef<Rotation | null>(null)
  useEffect(() => {
    if (mode.kind !== 'place') {
      prevRotationRef.current = null
      return
    }
    const rot: Rotation = mode.rotation ?? 0
    const prev = prevRotationRef.current
    prevRotationRef.current = rot
    if (prev === null || prev === rot) return // armed fresh / unchanged
    const st = useStore.getState()
    if (!st.hoverHole) return
    if (placementValid(st.layout, mode.type, st.hoverHole, mode.pickedHoles, rot)) return
    const text = rotationProblemText(mode.type, st.hoverHole, rot)
    if (text) showToast(text, { duration: 3200 })
  }, [mode])

  // placement / wire-mode hints as glass toasts above the dock; each mode
  // change replaces the previous hint so stale hints never linger
  const firstModeRef = useRef(true)
  const hintToastRef = useRef<number | null>(null)
  useEffect(() => {
    if (firstModeRef.current) {
      firstModeRef.current = false // no toast for the boot-time select mode
      return
    }
    if (hintToastRef.current != null) dismissToast(hintToastRef.current)
    const hint = hintForMode(mode)
    hintToastRef.current = hint ? showToast(hint, { duration: 3200 }) : null
  }, [mode])

  // toasts sit higher while the wire color strip occupies their spot
  useEffect(() => {
    document.body.classList.toggle('app-wire-armed', wireArmed)
    return () => document.body.classList.remove('app-wire-armed')
  }, [wireArmed])

  // --- dock state machine ---
  const dockActive: DockKey = activeSheet ?? (wireArmed ? 'wire' : 'none')
  const onDock = (key: DockKey) => {
    if (key === 'wire') {
      const st = useStore.getState()
      if (st.mode.kind === 'wire') {
        st.setMode({ kind: 'select' }) // tap again to exit
      } else {
        setActiveSheet(null)
        st.select(null)
        st.setMode({ kind: 'wire', from: null, color: lastWireColor.current })
      }
      return
    }
    if (key === 'none') return
    setActiveSheet((cur) => (cur === key ? null : key))
  }

  const dockItems: readonly DockItem<DockKey>[] = [
    { key: 'parts', icon: <ChipIcon size={26} />, label: 'Parts' },
    { key: 'wire', icon: <WireIcon size={26} />, label: 'Wire' },
    { key: 'ai', icon: <SparklesIcon size={26} />, label: 'AI' },
    { key: 'scope', icon: <WaveformIcon size={26} />, label: 'Scope' },
    {
      key: 'more',
      icon: (
        <span className="app-dock-iconwrap">
          <EllipsisIcon size={26} />
          {issueCount > 0 && (
            <span className="app-dock-badge" aria-label={`${issueCount} issues`}>
              {issueCount > 9 ? '9+' : issueCount}
            </span>
          )}
        </span>
      ),
      label: 'More',
    },
  ]

  // --- long-press action sheet ---
  const layout = useStore((s) => s.layout)
  const targetComp = actionTarget ? layout.components.find((c) => c.id === actionTarget) : undefined
  const targetWire = actionTarget ? layout.wires.find((w) => w.id === actionTarget) : undefined
  const targetEntry = targetComp ? getEntry(targetComp.type) : undefined
  const actionSheetActions: ActionSheetAction[] = []
  if (targetComp) {
    actionSheetActions.push({ label: 'Properties', onSelect: () => select(targetComp.id) })
    // dip/footprint packages only — the rotation feature's placed-part surface
    // (DIPs toggle 0↔180, footprints step to the next VALID quarter turn)
    if (targetEntry && (targetEntry.placement === 'dip' || targetEntry.placement === 'footprint')) {
      actionSheetActions.push({
        label: 'Rotate',
        onSelect: () => rotatePlacedWithFeedback(targetComp.id),
      })
    }
    actionSheetActions.push({ label: 'Duplicate', onSelect: () => duplicateComponent(targetComp.id) })
  }
  if (targetComp || targetWire) {
    // the TOUCH multi-select path (DESIGN §8: everything touch-completable):
    // long-press → toggle into the selection; repeat on other parts/wires to
    // build the group the SelectionPill / group move-drag then operate on
    const targetSelected = actionTarget != null && selection.includes(actionTarget)
    actionSheetActions.push({
      label: targetSelected ? 'Remove from Selection' : 'Add to Selection',
      onSelect: () => {
        if (actionTarget != null) useStore.getState().toggleSelect(actionTarget)
      },
    })
    actionSheetActions.push({
      label: 'Delete',
      destructive: true,
      onSelect: () => {
        const st = useStore.getState()
        if (targetComp) st.removeComponent(targetComp.id)
        else if (targetWire) st.removeWire(targetWire.id)
        tick(16)
        showToast(targetComp ? `${targetComp.id} removed` : 'Wire removed')
      },
    })
  }

  const emptyVisible = boardEmpty && activeSheet === null && mode.kind === 'select' && !onboarding
  const finishOnboarding = () => {
    markOnboarded()
    setOnboarding(false)
  }

  return (
    <div className="app-root">
      {/* full-bleed 3D canvas under everything */}
      <div className="app-canvas" ref={containerRef} />

      {/* top-center run capsule */}
      <StatusBar />

      {/* empty-state card */}
      {emptyVisible && (
        <EmptyState
          onBrowseParts={() => setActiveSheet('parts')}
          onAskAi={() => {
            setAiPrefill('make me a circuit that displays a date')
            setActiveSheet('ai')
          }}
        />
      )}

      {/* wire color swatches above the dock while armed */}
      <WireColorStrip />

      {/* undo/redo glass pill (left edge, above the dock); self-hides */}
      <UndoPill />

      {/* multi-select pill ("N selected · Delete · Clear"); self-hides at ≤1 */}
      <SelectionPill />

      {/* rotate-the-armed-package glass button (touch chrome); self-hides */}
      <RotateButton />

      {/* bottom dock / desktop left rail */}
      <Dock<DockKey>
        items={dockItems}
        activeKey={dockActive}
        onSelect={onDock}
        desktop={isDesktop}
        aria-label="Main"
      />

      {/* sheets (each renders its own kit Sheet; panel mode on desktop) */}
      <PartsSheet
        open={activeSheet === 'parts'}
        onDismiss={() => setActiveSheet(null)}
        desktop={isDesktop}
      />
      <AiSheet
        open={activeSheet === 'ai'}
        onDismiss={() => {
          setActiveSheet(null)
          setAiPrefill(undefined) // prefill is a one-shot (empty-state path only)
        }}
        desktop={isDesktop}
        initialPrompt={aiPrefill}
      />
      <ScopeSheet
        open={activeSheet === 'scope'}
        onDismiss={() => setActiveSheet(null)}
        desktop={isDesktop}
      />
      <MoreSheet
        open={activeSheet === 'more'}
        onDismiss={() => setActiveSheet(null)}
        desktop={isDesktop}
      />

      {/* selection → Properties presents at half snap (single = full editor,
          multi = compact group view); dismiss deselects */}
      <PropertiesSheet
        open={selection.length > 0}
        onDismiss={() => select(null)}
        desktop={isDesktop}
      />

      {/* long-press a component → Properties / Duplicate / Delete */}
      <ActionSheet
        open={actionTarget != null && (targetComp != null || targetWire != null)}
        onDismiss={() => setActionTarget(null)}
        title={
          targetComp
            ? `${targetComp.id} · ${targetEntry?.label ?? targetComp.type}`
            : targetWire
              ? `Wire ${targetWire.id}`
              : undefined
        }
        actions={actionSheetActions}
        desktop={isDesktop}
      />

      {/* glass toast pills above the dock */}
      <ToastHost />

      {/* first-launch coach overlay */}
      {onboarding && <Onboarding onDone={finishOnboarding} />}
    </div>
  )
}
