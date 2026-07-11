/**
 * adapt.ts — backdrop-luminance adaptation for the Liquid Glass material
 * (DESIGN.md §1). Apple's regular variant "knows how bright or dark the
 * background is, so the platter and the symbols on top of it flip between
 * light and dark to stay visible" and its shadows modulate with the content
 * behind. The browser equivalent here: a singleton sampler reads the live
 * WebGL scene behind each registered platter at low frequency and writes
 * two things per surface:
 *
 *   --lg-lum            0..1 mean backdrop luminance (continuous; drives
 *                       the adaptive ambient-shadow alpha in kit.css, and
 *                       transitions via the registered @property)
 *   .is-tone-light      flipped with hysteresis + a 2-sample vote — the
 *                       light-glass state (light platter paint fades in on
 *                       the .lg-tone child layer; ink/separator custom
 *                       props flip dark; see kit.css)
 *
 * How the read works: the scene renderer draws each frame inside its own
 * rAF callback and the drawing buffer is cleared at composite
 * (preserveDrawingBuffer is off — DESIGN.md §7 forbids paying for it). So
 * the sampler schedules from a TIMER task: a requestAnimationFrame issued
 * between frames lands AFTER the scene's already-queued callback, i.e. our
 * drawImage() runs in the same frame right after renderer.render(), while
 * the buffer is still valid. Each registered surface's backdrop rect is
 * blitted into one tiny strip canvas (a 12×8 patch per surface, single
 * getImageData per sample — one small GPU readback every SAMPLE_MS, never
 * per frame). All-black frames (missed render, paused loop) are detected
 * and skipped, freezing the last known tone.
 *
 * Scope (the tone tier): the floating platters that orbit over wildly
 * varying scene content — dock, status capsule, empty-state card. Sheets,
 * panels and nested cards stay the regular dark glass (they are content
 * surfaces, like iOS sheets). Registration is per-component
 * (attachToneAdapt in an effect), no App.tsx hook required.
 *
 * Opt-outs: prefers-reduced-transparency (the material flattens; tone
 * never engages — same gate as the lens) and the `?tone=off` verification
 * flag. Hidden documents pause sampling.
 */

/** ms between samples (~2.6Hz — reaction feels live, cost stays nil). */
const SAMPLE_MS = 380
/** Hysteresis thresholds on mean sRGB luminance (0..1). */
const LIGHT_ON = 0.58
const LIGHT_OFF = 0.46
/** Consecutive agreeing samples required before the tone flips. */
const FLIP_VOTES = 2
/** Strip-canvas patch size per registered surface. */
const PATCH_W = 12
const PATCH_H = 8

interface ToneEntry {
  light: boolean
  votes: number
}

const entries = new Map<HTMLElement, ToneEntry>()
let timer = 0
let strip: HTMLCanvasElement | null = null
let stripCtx: CanvasRenderingContext2D | null = null
let sceneCanvas: HTMLCanvasElement | null = null
let enabled: boolean | null = null

function toneEnabled(): boolean {
  if (enabled !== null) return enabled
  if (typeof window === 'undefined' || typeof document === 'undefined') return (enabled = false)
  try {
    if (new URLSearchParams(window.location.search).get('tone') === 'off')
      return (enabled = false)
  } catch {
    /* no usable location (tests) — fall through */
  }
  if (window.matchMedia?.('(prefers-reduced-transparency: reduce)').matches)
    return (enabled = false)
  return (enabled = true)
}

/** The live scene canvas (re-queried when remounted). */
function findSceneCanvas(): HTMLCanvasElement | null {
  if (sceneCanvas?.isConnected) return sceneCanvas
  sceneCanvas =
    document.querySelector<HTMLCanvasElement>('.app-canvas canvas') ??
    document.querySelector<HTMLCanvasElement>('canvas')
  return sceneCanvas
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))

function visible(el: HTMLElement): boolean {
  interface WithCheckVisibility {
    checkVisibility?: (o?: object) => boolean
  }
  const cv = (el as WithCheckVisibility).checkVisibility
  if (typeof cv === 'function')
    return cv.call(el, { visibilityProperty: true, checkVisibilityCSS: true })
  return el.offsetParent !== null || getComputedStyle(el).position === 'fixed'
}

/** One sample pass: blit every live surface's backdrop, read once, apply. */
function sample(): void {
  const canvas = findSceneCanvas()
  if (!canvas || canvas.width === 0 || canvas.height === 0) return
  const live: HTMLElement[] = []
  for (const el of entries.keys()) {
    if (el.isConnected && visible(el)) live.push(el)
  }
  if (live.length === 0) return
  const crect = canvas.getBoundingClientRect()
  if (crect.width === 0 || crect.height === 0) return
  if (!strip) {
    strip = document.createElement('canvas')
    stripCtx = strip.getContext('2d')
  }
  const ctx = stripCtx
  if (!ctx) return
  const w = live.length * PATCH_W
  if (strip.width !== w || strip.height !== PATCH_H) {
    strip.width = w
    strip.height = PATCH_H
  }
  const sx = canvas.width / crect.width
  const sy = canvas.height / crect.height
  for (let i = 0; i < live.length; i++) {
    const r = live[i].getBoundingClientRect()
    const px = clamp((r.left - crect.left) * sx, 0, canvas.width - 2)
    const py = clamp((r.top - crect.top) * sy, 0, canvas.height - 2)
    const pw = clamp(r.width * sx, 1, canvas.width - px)
    const ph = clamp(r.height * sy, 1, canvas.height - py)
    ctx.drawImage(canvas, px, py, pw, ph, i * PATCH_W, 0, PATCH_W, PATCH_H)
  }
  let data: Uint8ClampedArray
  try {
    data = ctx.getImageData(0, 0, w, PATCH_H).data
  } catch {
    return // tainted/unreadable — keep the last tone
  }
  // blank-frame guard: a missed render (or paused loop) reads back pure
  // black across the whole strip — the lit desk never does. Skip it.
  let maxC = 0
  for (let i = 0; i < data.length; i += 4) {
    const m = Math.max(data[i], data[i + 1], data[i + 2])
    if (m > maxC) maxC = m
  }
  if (maxC < 4) return
  for (let i = 0; i < live.length; i++) {
    let sum = 0
    for (let y = 0; y < PATCH_H; y++) {
      const row = (y * w + i * PATCH_W) * 4
      for (let x = 0; x < PATCH_W; x++) {
        const p = row + x * 4
        sum += 0.2126 * data[p] + 0.7152 * data[p + 1] + 0.0722 * data[p + 2]
      }
    }
    const lum = sum / (PATCH_W * PATCH_H * 255)
    const el = live[i]
    const entry = entries.get(el)
    if (!entry) continue
    el.style.setProperty('--lg-lum', lum.toFixed(3))
    const want = entry.light ? lum > LIGHT_OFF : lum > LIGHT_ON
    if (want !== entry.light) {
      if (++entry.votes >= FLIP_VOTES) {
        entry.light = want
        entry.votes = 0
        el.classList.toggle('is-tone-light', want)
      }
    } else {
      entry.votes = 0
    }
  }
}

function tickSample(): void {
  if (document.hidden || entries.size === 0) return
  // issued from a timer task, this rAF queues AFTER the scene loop's own
  // (already-pending) callback — sample() reads the buffer post-render
  requestAnimationFrame(sample)
}

function start(): void {
  if (timer || typeof window === 'undefined') return
  timer = window.setInterval(tickSample, SAMPLE_MS)
  window.setTimeout(tickSample, 60) // first read without the full wait
}

function stop(): void {
  if (!timer) return
  window.clearInterval(timer)
  timer = 0
}

/**
 * Register a floating platter for backdrop-luminance adaptation. Returns
 * the detach function (call on unmount). No-op (noop detach) when tone
 * adaptation is disabled.
 */
export function attachToneAdapt(el: HTMLElement): () => void {
  if (!toneEnabled()) return () => {}
  el.classList.add('lg-tone-adaptive')
  entries.set(el, { light: false, votes: 0 })
  start()
  return () => {
    entries.delete(el)
    el.classList.remove('lg-tone-adaptive', 'is-tone-light')
    el.style.removeProperty('--lg-lum')
    if (entries.size === 0) stop()
  }
}
