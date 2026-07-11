/**
 * ScopeSheet — the oscilloscope in a half-height bottom sheet (snap 0.4/0.8).
 *
 * Canvas-rendered (drawing code ported from the old ScopePanel): dark grid,
 * up to 4 autoscaled traces in classic scope channel colors, DPR-aware
 * (capped at 2 per the perf budget). The rAF loop runs ONLY while the sheet
 * is open, and skips the actual draw when nothing changed since the last
 * frame (paused sim → near-zero cost). Window picker is a kit Segmented;
 * channel legend chips light up per live probe presence.
 */
import { useEffect, useRef, useState } from 'react'
import { useStore } from '../../state/store'
import type { ScopeSample } from '../../model/types'
import { Segmented, Sheet, type SegmentedOption } from '../kit'
import './asm-sheets.css'

const SNAP_POINTS = [0.4, 0.8] as const

export const TRACE_COLORS = ['#ffd84a', '#43d9f6', '#ff5dd8', '#62e979'] // ch1..4

const WINDOW_OPTIONS: readonly SegmentedOption<string>[] = [
  { value: '0.1', label: '0.1 s' },
  { value: '1', label: '1 s' },
  { value: '5', label: '5 s' },
  { value: '20', label: '20 s' },
]

const MONO_FONT = "10px 'SF Mono', 'Fira Code', monospace"

export interface ScopeSheetProps {
  open: boolean
  onDismiss: () => void
  desktop?: boolean
}

export function ScopeSheet({ open, onDismiss, desktop = false }: ScopeSheetProps) {
  const timeWindow = useStore((s) => s.scope.timeWindow)
  const setScopeWindow = useStore((s) => s.setScopeWindow)
  const components = useStore((s) => s.layout.components)

  // present at the half (0.4) detent every time; user can drag to 0.8
  const [snap, setSnap] = useState(0)
  useEffect(() => {
    if (open) setSnap(0)
  }, [open])

  // which channels have a probe assigned (for the legend)
  const attached = [false, false, false, false]
  for (const c of components) {
    if (c.type === 'scope_probe') {
      const ch = Math.round(Number(c.params?.channel ?? 1))
      if (ch >= 1 && ch <= 4) attached[ch - 1] = true
    }
  }

  return (
    <Sheet
      open={open}
      onDismiss={onDismiss}
      snapPoints={SNAP_POINTS}
      activeSnap={snap}
      onSnapChange={setSnap}
      desktop={desktop}
      anchor="right"
      ariaLabel="Oscilloscope"
      className="asm-sheet"
    >
      <div className="asm-content">
        <div className="asm-sheet-head">
          <span className="lg-title">Oscilloscope</span>
        </div>

        <div className="asm-scope-legend">
          {TRACE_COLORS.map((color, i) => (
            <span
              key={i}
              className={`asm-scope-chip ${attached[i] ? '' : 'is-off'}`}
              title={attached[i] ? `Channel ${i + 1}` : `Channel ${i + 1} — no probe placed`}
            >
              <span className="asm-scope-chip-dot" style={{ background: color }} />
              CH{i + 1}
            </span>
          ))}
        </div>

        <ScopeCanvas active={open} />

        <Segmented
          value={String(timeWindow)}
          onChange={(v) => setScopeWindow(Number(v))}
          options={WINDOW_OPTIONS}
          aria-label="Scope time window"
        />
      </div>
    </Sheet>
  )
}

/**
 * Inner canvas component — mounted only while the sheet's content exists, so
 * its refs are always live. `active=false` (sheet closing) cancels the loop
 * immediately: no rAF runs while the sheet is closed.
 */
function ScopeCanvas({ active }: { active: boolean }) {
  const wrapRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    if (!active) return
    const wrap = wrapRef.current
    const canvas = canvasRef.current
    if (!wrap || !canvas) return

    let resizeStamp = 0
    const ro = new ResizeObserver(() => {
      const rect = wrap.getBoundingClientRect()
      const dpr = Math.min(window.devicePixelRatio || 1, 2)
      canvas.width = Math.max(1, Math.round(rect.width * dpr))
      canvas.height = Math.max(1, Math.round(rect.height * dpr))
      resizeStamp++
    })
    ro.observe(wrap)

    let raf = 0
    let lastKey = ''
    const loop = () => {
      raf = requestAnimationFrame(loop)
      const st = useStore.getState()
      const samples = st.scope.samples
      const lastT = samples.length > 0 ? samples[samples.length - 1].t : -1
      const key = `${samples.length}:${lastT}:${st.scope.timeWindow}:${resizeStamp}:${canvas.width}x${canvas.height}`
      if (key === lastKey) return // nothing changed since last draw — skip
      lastKey = key
      drawScope(canvas, samples, st.scope.timeWindow)
    }
    raf = requestAnimationFrame(loop)
    return () => {
      ro.disconnect()
      cancelAnimationFrame(raf)
    }
  }, [active])

  return (
    <div ref={wrapRef} className="asm-scope-body">
      <canvas ref={canvasRef} className="asm-scope-canvas" />
    </div>
  )
}

// ---------------------------------------------------------------------------
// Canvas rendering (ported verbatim from the old ScopePanel, DPR capped at 2)
// ---------------------------------------------------------------------------

function niceStep(rough: number): number {
  if (!(rough > 0) || !Number.isFinite(rough)) return 1
  const pow = Math.pow(10, Math.floor(Math.log10(rough)))
  const m = rough / pow
  if (m <= 1) return pow
  if (m <= 2) return 2 * pow
  if (m <= 5) return 5 * pow
  return 10 * pow
}

function fmtTick(v: number, step: number): string {
  const decimals = Math.max(0, Math.min(3, -Math.floor(Math.log10(step))))
  return `${v.toFixed(decimals)}V`
}

function fmtTimeOffset(dt: number, window: number): string {
  if (dt === 0) return '0'
  if (window < 1) return `${Math.round(dt * 1000)}ms`
  return `${dt.toFixed(1)}s`
}

function drawScope(canvas: HTMLCanvasElement, samples: ScopeSample[], timeWindow: number): void {
  const ctx = canvas.getContext('2d')
  if (!ctx) return
  const dpr = Math.min(window.devicePixelRatio || 1, 2)
  const W = canvas.width / dpr
  const H = canvas.height / dpr
  ctx.save()
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  ctx.fillStyle = '#0a0c10'
  ctx.fillRect(0, 0, W, H)

  const padL = 46
  const padR = 8
  const padT = 8
  const padB = 18
  const pw = W - padL - padR
  const ph = H - padT - padB
  if (pw < 20 || ph < 20) {
    ctx.restore()
    return
  }

  const tEnd = samples.length > 0 ? samples[samples.length - 1].t : timeWindow
  const tStart = tEnd - timeWindow

  // first sample index inside the window (samples are time-ordered)
  let i0 = samples.length
  while (i0 > 0 && samples[i0 - 1].t >= tStart) i0--

  // ---- autoscale voltage axis ----
  let vmin = Infinity
  let vmax = -Infinity
  for (let i = i0; i < samples.length; i++) {
    const v = samples[i].v
    for (let c = 0; c < 4; c++) {
      const x = v[c]
      if (Number.isFinite(x)) {
        if (x < vmin) vmin = x
        if (x > vmax) vmax = x
      }
    }
  }
  if (!Number.isFinite(vmin) || vmax - vmin < 1e-6) {
    if (Number.isFinite(vmin) && (vmin < -1 || vmax > 6)) {
      // flat trace outside the default range: center on it
      const mid = (vmin + vmax) / 2
      vmin = mid - 1
      vmax = mid + 1
    } else {
      vmin = -1
      vmax = 6
    }
  } else {
    const pad = (vmax - vmin) * 0.08
    vmin -= pad
    vmax += pad
  }

  const yOf = (v: number) => padT + (1 - (v - vmin) / (vmax - vmin)) * ph
  const xOf = (t: number) => padL + ((t - tStart) / timeWindow) * pw

  // ---- grid ----
  ctx.lineWidth = 1
  ctx.strokeStyle = '#1c212a'
  ctx.beginPath()
  for (let i = 0; i <= 10; i++) {
    const x = padL + (pw * i) / 10
    ctx.moveTo(x, padT)
    ctx.lineTo(x, padT + ph)
  }
  ctx.stroke()

  const step = niceStep((vmax - vmin) / 5)
  const firstTick = Math.ceil(vmin / step) * step
  const ticks: { y: number; v: number }[] = []
  ctx.beginPath()
  for (let v = firstTick; v <= vmax + step * 1e-6; v += step) {
    const y = yOf(v)
    ctx.moveTo(padL, y)
    ctx.lineTo(padL + pw, y)
    ticks.push({ y, v: Math.abs(v) < step * 1e-6 ? 0 : v })
  }
  ctx.stroke()

  // emphasized zero line
  if (vmin < 0 && vmax > 0) {
    ctx.strokeStyle = '#39414f'
    ctx.beginPath()
    const y0 = yOf(0)
    ctx.moveTo(padL, y0)
    ctx.lineTo(padL + pw, y0)
    ctx.stroke()
  }

  // frame
  ctx.strokeStyle = '#2a303b'
  ctx.strokeRect(padL + 0.5, padT + 0.5, pw - 1, ph - 1)

  // ---- axis labels ----
  ctx.fillStyle = '#7d8694'
  ctx.font = MONO_FONT
  ctx.textAlign = 'right'
  ctx.textBaseline = 'middle'
  for (const t of ticks) ctx.fillText(fmtTick(t.v, step), padL - 5, t.y)
  ctx.textAlign = 'center'
  ctx.textBaseline = 'top'
  for (let i = 0; i <= 10; i += 2) {
    const x = padL + (pw * i) / 10
    const dt = -timeWindow * (1 - i / 10)
    ctx.fillText(fmtTimeOffset(dt, timeWindow), x, padT + ph + 4)
  }

  // ---- traces ----
  if (samples.length === 0) {
    ctx.fillStyle = '#5b6471'
    ctx.font = MONO_FONT
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillText('no samples — place a scope probe and press Run', padL + pw / 2, padT + ph / 2)
    ctx.restore()
    return
  }

  const count = samples.length - i0
  const stride = Math.max(1, Math.floor(count / (pw * 2))) // decimate dense buffers
  ctx.lineWidth = 1.5
  ctx.lineJoin = 'round'
  for (let c = 0; c < 4; c++) {
    ctx.strokeStyle = TRACE_COLORS[c]
    ctx.beginPath()
    let pen = false
    let drew = false
    for (let i = i0; i < samples.length; i += stride) {
      const v = samples[i].v[c]
      if (!Number.isFinite(v)) {
        pen = false // NaN = channel unattached / gap → lift the pen
        continue
      }
      const x = xOf(samples[i].t)
      const y = yOf(v)
      if (pen) {
        ctx.lineTo(x, y)
      } else {
        ctx.moveTo(x, y)
        pen = true
        drew = true
      }
    }
    if (drew) ctx.stroke()
  }
  ctx.restore()
}
