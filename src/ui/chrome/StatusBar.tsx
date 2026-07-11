/**
 * StatusBar — the top-center Dynamic-Island-style run control, built on the
 * kit StatusCapsule (DESIGN.md §2).
 *
 * - Run-state dot: pulses green while the sim runs (transform/opacity only).
 * - Tabular-nums sim clock.
 * - Tap = Run/Pause (haptic comes from the capsule itself).
 * - Long-press = Reset, two-step: the first long-press shows a confirm toast,
 *   a second long-press within 3 s actually resets.
 * - Auto-expands for 3 s to show a second line whenever a NEW sim issue or a
 *   new LLM status/error arrives.
 * - Studio render mode: stays expanded while the path tracer loads / builds /
 *   samples ("rendering… N/M samples"), flashes the converged line, then
 *   auto-collapses — fed by pushRenderProgress (scene → App → here).
 */
import { useEffect, useRef, useState } from 'react'
import { useStore } from '../../state/store'
import type { RenderProgress } from '../../three/scene-api'
import { StatusCapsule, showToast, tick } from '../kit'

const EXPAND_MS = 3000
const RESET_CONFIRM_MS = 3000
/** sampling updates reach React at most this often (perf budget: ≤10Hz) */
const PROGRESS_THROTTLE_MS = 250

// --- Studio render progress (module-level sink, like the kit's showToast) ---
// The scene's RenderModeManager emits progress from inside the rAF loop; the
// App glue routes it here and the mounted StatusBar renders it through the
// capsule's existing expansion mechanism. Throttled so per-sample events
// can't drive 60Hz React renders; phase changes always pass through.
let renderProgressSink: ((p: RenderProgress) => void) | null = null
let lastProgressPhase: RenderProgress['phase'] | null = null
let lastProgressPushMs = 0

/** Feed Studio convergence progress into the status capsule (safe pre-mount). */
export function pushRenderProgress(p: RenderProgress): void {
  if (p.phase === lastProgressPhase && p.phase === 'sampling') {
    const now = performance.now()
    if (now - lastProgressPushMs < PROGRESS_THROTTLE_MS) return
    lastProgressPushMs = now
  }
  lastProgressPhase = p.phase
  renderProgressSink?.(p)
}

/** Capsule line for a Studio progress payload. */
export function renderProgressText(p: RenderProgress): string {
  switch (p.phase) {
    case 'loading':
      return 'Studio: loading ray tracer…'
    case 'building':
      return 'Studio: preparing scene…'
    case 'sampling':
      return `Studio: rendering… ${p.samples}/${p.targetSamples} samples`
    case 'converged':
      return `Studio render complete · ${p.samples} samples`
  }
}

/** Compact tabular clock: seconds with 2 decimals, m:ss.s past a minute. */
export function formatSimTime(t: number): string {
  if (!Number.isFinite(t) || t < 0) return '0.00 s'
  if (t < 60) return `${t.toFixed(2)} s`
  const m = Math.floor(t / 60)
  const s = t - m * 60
  return `${m}:${s < 10 ? '0' : ''}${s.toFixed(1)}`
}

export function StatusBar() {
  const running = useStore((s) => s.running)
  const simTime = useStore((s) => s.simTime)
  const issues = useStore((s) => s.issues)
  const llm = useStore((s) => s.llm)

  const [detail, setDetail] = useState<string | null>(null)
  const expandTimer = useRef<number | null>(null)
  const flash = (text: string) => {
    setDetail(text)
    if (expandTimer.current != null) window.clearTimeout(expandTimer.current)
    expandTimer.current = window.setTimeout(() => {
      expandTimer.current = null
      setDetail(null)
    }, EXPAND_MS)
  }
  useEffect(
    () => () => {
      if (expandTimer.current != null) window.clearTimeout(expandTimer.current)
    },
    [],
  )

  // expand when a message we haven't shown yet appears in the issue list
  const prevIssuesRef = useRef<string[]>([])
  useEffect(() => {
    const msgs = issues.map((i) => i.message)
    const fresh = msgs.find((m) => !prevIssuesRef.current.includes(m))
    prevIssuesRef.current = msgs
    if (fresh) flash(fresh)
  }, [issues])

  // Studio render-mode progress: every update re-arms the 3s collapse timer,
  // so the capsule stays open while sampling and collapses after convergence
  useEffect(() => {
    renderProgressSink = (p) => flash(renderProgressText(p))
    return () => {
      renderProgressSink = null
    }
  }, [])

  // expand on LLM progress / errors / a finished generation
  const prevLlmRef = useRef<{ status: string; error: string | null; pending: boolean }>({
    status: '',
    error: null,
    pending: false,
  })
  useEffect(() => {
    const prev = prevLlmRef.current
    prevLlmRef.current = { status: llm.status, error: llm.error, pending: llm.pending != null }
    if (llm.status && llm.status !== prev.status) flash(`AI: ${llm.status}`)
    else if (llm.error && llm.error !== prev.error) flash(`AI: ${llm.error}`)
    else if (llm.pending != null && !prev.pending) flash('AI circuit ready — open AI to apply')
  }, [llm])

  // two-step destructive reset on long-press
  const resetArmRef = useRef(0)
  const onLongPress = () => {
    const now = Date.now()
    if (now - resetArmRef.current < RESET_CONFIRM_MS) {
      resetArmRef.current = 0
      useStore.getState().resetSim()
      tick(16)
      showToast('Simulation reset')
    } else {
      resetArmRef.current = now
      showToast('Long-press again to reset the simulation')
    }
  }

  const onTap = () => {
    const st = useStore.getState()
    if (st.running) st.stopSim()
    else st.startSim()
  }

  return (
    <StatusCapsule
      aria-label={running ? 'Pause simulation' : 'Run simulation'}
      dot={<span className={`app-run-dot ${running ? 'is-running' : ''}`} />}
      expanded={detail != null}
      expandedContent={detail}
      onTap={onTap}
      onLongPress={onLongPress}
    >
      <span className="lg-tabular">{formatSimTime(simTime)}</span>
      <span className="app-run-word">{running ? 'Running' : 'Paused'}</span>
    </StatusCapsule>
  )
}
