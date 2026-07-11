/**
 * PERF PROBE — render-mode FPS / hotspot measurement rig (Phase D).
 *
 * Serves the built dist/ via `vite preview`, then drives a HEADED chromium
 * (headless chromium falls back to software-ish GL paths and lies about GPU
 * perf — this machine is a Mac with a real GPU; a window will open and
 * animate, leave it alone) through the date-display example (the dense
 * realistic workload: 37 parts / 42 wires) in every render mode, at:
 *
 *   - desktop 1440x900 @ deviceScaleFactor 2 (the retina case users hit)
 *   - desktop 1440x900 @ dsf 1               (pixelRatio cost isolation)
 *   - phone   390x844  @ dsf 3, touch        (app caps pixelRatio at 2)
 *
 * Each run: boot → 3s idle window → 8-second programmatic 360° orbit (eight
 * 45° strokes of REAL input events — mouse pointer strokes on desktop
 * contexts, CDP touch-point strokes on hasTouch contexts, so the phone rows
 * exercise OrbitControls' TOUCH.ROTATE path) → 3s post-idle window.
 *
 * WORKLOAD NOTE (hover): the strokes cross the canvas center, so the app
 * receives a pointer/touch move every frame. Since Phase D (hotspots.md B3)
 * the app GATES hover raycasts OFF while the orbit gesture is in flight
 * (scene.ts `controlsInteracting`; hover re-arms on release) — baseline-era
 * builds processed hover on every orbit frame. Rows from the two eras
 * therefore compare the same USER GESTURE, not identical per-frame work;
 * part of the alloc-rate drop vs baseline is that gating, by design.
 *
 * PHONE ROWS are viewport/DPR/touch EMULATION on this machine's GPU/CPU.
 * They verify resolution scaling and the coarse-pointer code paths (pixel
 * cap, studio sample target), NOT real phone performance.
 *
 * REPRODUCIBILITY: single runs on a desktop OS are NOT reproducible (GPU
 * contention, compositor state). Set PERF_REPEAT=N to run every config N
 * times (fresh browser each) — the report row shows the MEDIAN-by-orbit-fps
 * repeat plus the min–max spread, and the JSON keeps every repeat. Verdicts
 * should only be stamped from repeated runs whose spread is small vs the
 * claimed effect. Every artifact records a dist/ content hash + mtime so
 * rows are attributable to an exact build.
 *
 * Measured WITHOUT touching any app source: an init script wraps the page's
 * WebGL2 context before the app boots and keeps per-rAF-frame counters:
 *
 *   - frame times (rAF deltas) → avg FPS, p50/p95 frame time, worst-1%
 *   - draw calls + triangles + instanced draws per frame (renderer.info
 *     equivalents, reconstructed from drawElements/drawArrays interception)
 *   - shader program links (cumulative → mid-orbit recompiles)
 *   - live texture count (createTexture − deleteTexture)
 *   - framebuffer binds per frame (render-pass count proxy)
 *   - shadow-map renders (square 1024/2048/4096 viewport binds)
 *   - JS heap per frame (--enable-precise-memory-info; sum of positive
 *     deltas = allocation rate, big negative deltas = GC events)
 *   - Studio pipeline phase via the existing ?shotrig renderProgress hook
 *     (entries into 'building' = BVH rebuilds; samples = accumulation)
 *
 * Enhanced pass-cost attribution (toggle-and-measure, still no app changes):
 * every shader is fingerprinted at shaderSource() time (SAO / SAO-blur /
 * SAO-normal-prepass / bloom / SMAA markers) and the draw wrappers can SKIP
 * draws for a tag set — eliminating that pass's vertex+fragment work. The
 * canvas may look wrong during skip runs; only the frame times matter.
 *
 * Writes perf/baseline.json + perf/baseline.md.
 *
 * Usage:  npm run build && node scripts/perf.mjs
 *         PERF_ONLY=desktop-enhanced node scripts/perf.mjs   (substring filter)
 *         PERF_STUDIO_TIMEOUT_S=240 node scripts/perf.mjs    (convergence wait)
 *         PERF_OUT=after node scripts/perf.mjs               (perf/after.{json,md})
 *         PERF_REPEAT=3 node scripts/perf.mjs                (repeat + aggregate)
 */
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import { join } from 'node:path'
import { chromium } from 'playwright'

const PORT = 4175
const URL = `http://localhost:${PORT}/`
const ORBIT_SECONDS = 8
const ORBIT_STROKES = 8
const IDLE_MS = 3000
const STUDIO_TIMEOUT_MS = (Number(process.env.PERF_STUDIO_TIMEOUT_S) || 180) * 1000
const OUT_NAME = process.env.PERF_OUT || 'baseline'
const REPEAT = Math.max(1, Math.floor(Number(process.env.PERF_REPEAT) || 1))
const ONLY = (process.env.PERF_ONLY ?? '').split(',').map((s) => s.trim()).filter(Boolean)
const want = (id) => ONLY.length === 0 || ONLY.some((s) => id.includes(s))

const here = (p) => new globalThis.URL(p, import.meta.url).pathname

// ---------------------------------------------------------------------------
// build provenance — every artifact must be attributable to an exact dist/
// (the repo is not under git; the dist content hash is the build identity)
// ---------------------------------------------------------------------------

function distProvenance() {
  const root = here('../dist')
  const files = []
  const walk = (dir) => {
    for (const name of readdirSync(dir).sort()) {
      const p = join(dir, name)
      const st = statSync(p)
      if (st.isDirectory()) walk(p)
      else files.push(p)
    }
  }
  try {
    walk(root)
  } catch {
    return { hash: 'NO-DIST', newestMtime: null, files: 0 }
  }
  const h = createHash('sha256')
  let newest = 0
  for (const p of files) {
    h.update(p.slice(root.length))
    h.update(readFileSync(p))
    newest = Math.max(newest, statSync(p).mtimeMs)
  }
  return {
    hash: h.digest('hex').slice(0, 16),
    newestMtime: new Date(newest).toISOString(),
    files: files.length,
  }
}

// ---------------------------------------------------------------------------
// preview server (same pattern as the sibling harnesses)
// ---------------------------------------------------------------------------

function startPreview() {
  const proc = spawn('npm', ['run', 'preview', '--', '--port', String(PORT), '--strictPort'], {
    cwd: here('..'),
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('preview server timed out')), 15000)
    proc.stdout.on('data', (d) => {
      if (String(d).includes('localhost')) {
        clearTimeout(timer)
        resolve(proc)
      }
    })
    proc.on('exit', (code) => reject(new Error(`preview exited early (${code})`)))
  })
}

// ---------------------------------------------------------------------------
// In-page instrumentation (addInitScript — runs before any app code)
// ---------------------------------------------------------------------------

function instrument() {
  if (globalThis.__bbPerf) return
  const TAG_MARKERS = [
    ['scaleDividedByCameraFar', 'sao'], // SAOShader estimation pass
    ['depthCutoff', 'saoBlur'], // DepthLimitedBlurShader (SAO v+h blur)
    // NOTE: the bare definition `packNormalToRGB( const in vec3 … )` lives in
    // the shared <packing> chunk of EVERY lit shader — only the CALL SITE
    // `packNormalToRGB( normal )` is unique to MeshNormalMaterial (the scene
    // pre-pass SAOPass renders).
    ['packNormalToRGB( normal )', 'saoNormal'],
    ['luminosityThreshold', 'bloomHigh'], // UnrealBloom high-pass
    ['gaussianPdf', 'bloomBlur'], // UnrealBloom separable blurs (mip chain)
    ['bloomStrength', 'bloomComposite'], // UnrealBloom composite
    ['SMAA', 'smaa'], // all three SMAA passes
  ]
  const perf = {
    // cumulative GL counters (snapshotted per rAF tick)
    draws: 0,
    instancedDraws: 0,
    skipped: 0,
    tris: 0,
    programs: 0,
    texCreated: 0,
    texDeleted: 0,
    fbBinds: 0,
    shadowViewports: 0,
    // per-frame columnar log
    frames: { t: [], draws: [], tris: [], skipped: [], programs: [], fbBinds: [], shadow: [], heap: [], phase: [], samples: [] },
    marks: [],
    skip: new Set(),
    contexts: 0,
    glInfo: null,
    setSkip(tags) {
      perf.skip = new Set(tags)
    },
    mark(name) {
      perf.marks.push({ name, idx: perf.frames.t.length, t: performance.now() })
    },
    collect() {
      return {
        frames: perf.frames,
        marks: perf.marks,
        totals: {
          draws: perf.draws,
          instancedDraws: perf.instancedDraws,
          skipped: perf.skipped,
          programs: perf.programs,
          texLive: perf.texCreated - perf.texDeleted,
          texCreated: perf.texCreated,
          shadowViewports: perf.shadowViewports,
          contexts: perf.contexts,
        },
        glInfo: perf.glInfo,
        dpr: window.devicePixelRatio,
      }
    },
  }
  globalThis.__bbPerf = perf

  const shaderTag = new WeakMap() // WebGLShader -> tag | null
  const programTags = new WeakMap() // WebGLProgram -> string[] (own tags)
  let currentTags = null // tags of the program in use (string[] | null)

  const PHASES = { loading: 0, building: 1, sampling: 2, converged: 3 }

  function wrap(gl) {
    perf.contexts++
    try {
      const dbg = gl.getExtension('WEBGL_debug_renderer_info')
      perf.glInfo = {
        renderer: dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER),
        vendor: dbg ? gl.getParameter(dbg.UNMASKED_VENDOR_WEBGL) : gl.getParameter(gl.VENDOR),
      }
    } catch {
      /* info only */
    }
    const TRIANGLES = gl.TRIANGLES
    const TRIANGLE_STRIP = gl.TRIANGLE_STRIP
    const TRIANGLE_FAN = gl.TRIANGLE_FAN
    const trisOf = (mode, count) =>
      mode === TRIANGLES ? count / 3 : mode === TRIANGLE_STRIP || mode === TRIANGLE_FAN ? count - 2 : 0
    const skipNow = () => {
      if (perf.skip.size === 0 || !currentTags) return false
      for (const t of currentTags) if (perf.skip.has(t)) return true
      return false
    }

    const g = gl
    const o = {
      shaderSource: g.shaderSource,
      attachShader: g.attachShader,
      linkProgram: g.linkProgram,
      useProgram: g.useProgram,
      drawElements: g.drawElements,
      drawArrays: g.drawArrays,
      drawElementsInstanced: g.drawElementsInstanced,
      drawArraysInstanced: g.drawArraysInstanced,
      createTexture: g.createTexture,
      deleteTexture: g.deleteTexture,
      bindFramebuffer: g.bindFramebuffer,
      viewport: g.viewport,
    }
    g.shaderSource = function (shader, src) {
      let tag = null
      for (const [marker, t] of TAG_MARKERS) {
        if (src.includes(marker)) {
          tag = t
          break
        }
      }
      shaderTag.set(shader, tag)
      return o.shaderSource.call(this, shader, src)
    }
    g.attachShader = function (program, shader) {
      const tag = shaderTag.get(shader)
      if (tag) {
        const list = programTags.get(program) ?? []
        if (!list.includes(tag)) list.push(tag)
        programTags.set(program, list)
      }
      return o.attachShader.call(this, program, shader)
    }
    g.linkProgram = function (program) {
      perf.programs++
      return o.linkProgram.call(this, program)
    }
    g.useProgram = function (program) {
      currentTags = program ? (programTags.get(program) ?? null) : null
      return o.useProgram.call(this, program)
    }
    g.drawElements = function (mode, count, type, offset) {
      if (skipNow()) {
        perf.skipped++
        return
      }
      perf.draws++
      perf.tris += trisOf(mode, count)
      return o.drawElements.call(this, mode, count, type, offset)
    }
    g.drawArrays = function (mode, first, count) {
      if (skipNow()) {
        perf.skipped++
        return
      }
      perf.draws++
      perf.tris += trisOf(mode, count)
      return o.drawArrays.call(this, mode, first, count)
    }
    if (o.drawElementsInstanced) {
      g.drawElementsInstanced = function (mode, count, type, offset, instanceCount) {
        if (skipNow()) {
          perf.skipped++
          return
        }
        perf.draws++
        perf.instancedDraws++
        perf.tris += trisOf(mode, count) * instanceCount
        return o.drawElementsInstanced.call(this, mode, count, type, offset, instanceCount)
      }
    }
    if (o.drawArraysInstanced) {
      g.drawArraysInstanced = function (mode, first, count, instanceCount) {
        if (skipNow()) {
          perf.skipped++
          return
        }
        perf.draws++
        perf.instancedDraws++
        perf.tris += trisOf(mode, count) * instanceCount
        return o.drawArraysInstanced.call(this, mode, first, count, instanceCount)
      }
    }
    g.createTexture = function () {
      perf.texCreated++
      return o.createTexture.call(this)
    }
    g.deleteTexture = function (t) {
      perf.texDeleted++
      return o.deleteTexture.call(this, t)
    }
    g.bindFramebuffer = function (target, fb) {
      perf.fbBinds++
      return o.bindFramebuffer.call(this, target, fb)
    }
    g.viewport = function (x, y, w, h) {
      // the only square pow-2 viewports in this app are shadow-map renders
      if (w === h && (w === 1024 || w === 2048 || w === 4096)) perf.shadowViewports++
      return o.viewport.call(this, x, y, w, h)
    }
  }

  const wrapped = new WeakSet()
  const origGetContext = HTMLCanvasElement.prototype.getContext
  HTMLCanvasElement.prototype.getContext = function (kind, ...args) {
    const ctx = origGetContext.call(this, kind, ...args)
    if (ctx && (kind === 'webgl2' || kind === 'webgl') && !wrapped.has(ctx)) {
      wrapped.add(ctx)
      try {
        wrap(ctx)
      } catch (err) {
        console.warn('[bbPerf] context wrap failed', err)
      }
    }
    return ctx
  }

  // per-frame snapshot loop — registered before the app's rAF loop, so it
  // stays first in callback order; each tick logs everything the app did in
  // the PREVIOUS frame (one-frame attribution offset, irrelevant to stats)
  const f = perf.frames
  const tick = (t) => {
    if (f.t.length < 200000) {
      f.t.push(t)
      f.draws.push(perf.draws)
      f.tris.push(perf.tris)
      f.skipped.push(perf.skipped)
      f.programs.push(perf.programs)
      f.fbBinds.push(perf.fbBinds)
      f.shadow.push(perf.shadowViewports)
      f.heap.push(performance.memory ? performance.memory.usedJSHeapSize : 0)
      const p = globalThis.__shotRig?.renderProgress?.()
      f.phase.push(p ? (PHASES[p.phase] ?? -1) : -1)
      f.samples.push(p ? p.samples : -1)
    }
    requestAnimationFrame(tick)
  }
  requestAnimationFrame(tick)
}

// ---------------------------------------------------------------------------
// node-side stats
// ---------------------------------------------------------------------------

function quantile(sorted, q) {
  if (sorted.length === 0) return 0
  const i = Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1))
  return sorted[i]
}

function median(arr) {
  if (arr.length === 0) return 0
  const s = [...arr].sort((a, b) => a - b)
  return quantile(s, 0.5)
}

/** Per-frame deltas of a cumulative columnar series within [i0, i1). */
function deltas(series, i0, i1) {
  const out = []
  for (let i = i0 + 1; i < i1; i++) out.push(series[i] - series[i - 1])
  return out
}

function windowStats(data, i0, i1) {
  const f = data.frames
  if (i1 - i0 < 10) return null
  const dts = deltas(f.t, i0, i1).filter((d) => d > 0)
  const sorted = [...dts].sort((a, b) => a - b)
  const durationMs = f.t[i1 - 1] - f.t[i0]
  const p99 = quantile(sorted, 0.99)
  const worst = sorted.filter((d) => d >= p99)
  const drawD = deltas(f.draws, i0, i1)
  const trisD = deltas(f.tris, i0, i1)
  const fbD = deltas(f.fbBinds, i0, i1)
  const heapD = deltas(f.heap, i0, i1)
  const allocBytes = heapD.filter((d) => d > 0).reduce((a, b) => a + b, 0)
  const gcDrops = heapD.filter((d) => d < -1_000_000).length
  const shadowD = deltas(f.shadow, i0, i1)
  let buildingEntries = 0
  for (let i = i0 + 1; i < i1; i++) {
    if (f.phase[i] === 1 && f.phase[i - 1] !== 1) buildingEntries++
  }
  return {
    frames: i1 - i0,
    durationMs: Math.round(durationMs),
    avgFps: +((dts.length * 1000) / durationMs).toFixed(1),
    frameMs: {
      p50: +quantile(sorted, 0.5).toFixed(2),
      p95: +quantile(sorted, 0.95).toFixed(2),
      p99: +p99.toFixed(2),
      worst1pctMean: +(worst.reduce((a, b) => a + b, 0) / Math.max(1, worst.length)).toFixed(2),
      max: +(sorted[sorted.length - 1] ?? 0).toFixed(2),
    },
    jankFramesOver33ms: dts.filter((d) => d > 33.4).length,
    drawCalls: { median: median(drawD), max: Math.max(0, ...drawD) },
    triangles: { median: median(trisD), max: Math.max(0, ...trisD) },
    fbBindsPerFrame: median(fbD),
    programLinks: f.programs[i1 - 1] - f.programs[i0],
    shadowMapRenders: shadowD.filter((d) => d > 0).length,
    allocKBPerFrame: +(allocBytes / Math.max(1, dts.length) / 1024).toFixed(1),
    allocMBPerSec: +(allocBytes / 1048576 / (durationMs / 1000)).toFixed(2),
    gcDrops,
    studioBvhBuilds: buildingEntries,
    studioSamplesStart: f.samples[i0],
    studioSamplesEnd: f.samples[i1 - 1],
  }
}

function markIndex(marks, name) {
  const m = marks.find((m) => m.name === name)
  return m ? m.idx : -1
}

// ---------------------------------------------------------------------------
// drivers
// ---------------------------------------------------------------------------

const settle = (page, ms) => page.waitForTimeout(ms)

/**
 * 360° orbit over ~8s: eight 45° strokes of real pointer events. OrbitControls
 * maps a horizontal drag of one clientHeight to a full 2π, so total dx =
 * canvas CSS height. Strokes run through the canvas center (hover processing
 * included — that IS part of the user-reported workload).
 */
async function orbit360(page, seconds = ORBIT_SECONDS, strokes = ORBIT_STROKES) {
  const box = await page.locator('canvas').first().boundingBox()
  if (!box) throw new Error('canvas not found for orbit')
  const dxTotal = box.height // px → 2π
  const dxStroke = dxTotal / strokes
  const cx = box.x + box.width / 2
  const cy = box.y + box.height * 0.5
  const strokeMs = (seconds * 1000) / strokes
  for (let s = 0; s < strokes; s++) {
    const x0 = cx + dxStroke / 2
    const x1 = cx - dxStroke / 2
    await page.mouse.move(x0, cy)
    await page.mouse.down()
    const t0 = Date.now()
    let elapsed = 0
    while (elapsed < strokeMs) {
      const k = Math.min(1, elapsed / strokeMs)
      await page.mouse.move(x0 + (x1 - x0) * k, cy)
      await page.waitForTimeout(8)
      elapsed = Date.now() - t0
    }
    await page.mouse.move(x1, cy)
    await page.mouse.up()
  }
}

/**
 * Same 360° orbit as REAL TOUCH input (CDP Input.dispatchTouchEvent): one
 * finger dragged through the canvas center — chromium synthesizes the
 * pointerType:'touch' events the app and OrbitControls (touches.ONE =
 * TOUCH.ROTATE) actually receive on a phone. page.mouse would measure the
 * desktop input path inside a touch context.
 */
async function orbit360Touch(page, seconds = ORBIT_SECONDS, strokes = ORBIT_STROKES) {
  const box = await page.locator('canvas').first().boundingBox()
  if (!box) throw new Error('canvas not found for orbit')
  const cdp = await page.context().newCDPSession(page)
  const touch = (type, touchPoints) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints })
  const dxTotal = box.height // px → 2π (same OrbitControls mapping as mouse)
  const dxStroke = dxTotal / strokes
  const cx = box.x + box.width / 2
  const cy = box.y + box.height * 0.5
  const strokeMs = (seconds * 1000) / strokes
  try {
    for (let s = 0; s < strokes; s++) {
      const x0 = cx + dxStroke / 2
      const x1 = cx - dxStroke / 2
      await touch('touchStart', [{ x: x0, y: cy, id: 1 }])
      const t0 = Date.now()
      let elapsed = 0
      while (elapsed < strokeMs) {
        const k = Math.min(1, elapsed / strokeMs)
        await touch('touchMove', [{ x: x0 + (x1 - x0) * k, y: cy, id: 1 }])
        await page.waitForTimeout(8)
        elapsed = Date.now() - t0
      }
      await touch('touchMove', [{ x: x1, y: cy, id: 1 }])
      await touch('touchEnd', [])
    }
  } finally {
    await cdp.detach().catch(() => {})
  }
}

async function waitStudioReady(page, timeoutMs) {
  try {
    await page.waitForFunction(
      () => {
        const p = globalThis.__shotRig?.renderProgress?.()
        return p ? p.converged === true : false
      },
      null,
      { timeout: timeoutMs, polling: 250 },
    )
    return 'converged'
  } catch {
    const p = await page.evaluate(() => globalThis.__shotRig?.renderProgress?.() ?? null)
    console.warn(`  studio did not converge in ${timeoutMs / 1000}s (phase=${p?.phase}, samples=${p?.samples}) — orbiting anyway`)
    return p?.phase ?? 'unknown'
  }
}

// ---------------------------------------------------------------------------
// run matrix
// ---------------------------------------------------------------------------

const DESKTOP = { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 }
const DESKTOP_DPR1 = { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 }
const PHONE = {
  viewport: { width: 390, height: 844 },
  deviceScaleFactor: 3,
  isMobile: true,
  hasTouch: true,
}

const SKIP_SAO = ['sao', 'saoBlur', 'saoNormal']
const SKIP_BLOOM = ['bloomHigh', 'bloomBlur', 'bloomComposite']
const SKIP_SMAA = ['smaa']

const RUNS = [
  { id: 'desktop-performance', ctx: DESKTOP, mode: 'performance' },
  { id: 'desktop-enhanced', ctx: DESKTOP, mode: 'enhanced' },
  { id: 'desktop-studio', ctx: DESKTOP, mode: 'studio', studio: true },
  { id: 'phone-performance', ctx: PHONE, mode: 'performance' },
  { id: 'phone-enhanced', ctx: PHONE, mode: 'enhanced' },
  { id: 'phone-studio', ctx: PHONE, mode: 'studio', studio: true },
  { id: 'desktop-performance-dpr1', ctx: DESKTOP_DPR1, mode: 'performance' },
  { id: 'desktop-enhanced-dpr1', ctx: DESKTOP_DPR1, mode: 'enhanced' },
  // diagnostic: desktop Studio at dsf2 (5.2MP accumulation) kills the chromium
  // GPU process during convergence on this machine — dpr1 isolates resolution
  { id: 'desktop-studio-dpr1', ctx: DESKTOP_DPR1, mode: 'studio', studio: true },
  { id: 'desktop-enhanced-noSAO', ctx: DESKTOP, mode: 'enhanced', skip: SKIP_SAO },
  { id: 'desktop-enhanced-noBloom', ctx: DESKTOP, mode: 'enhanced', skip: SKIP_BLOOM },
  { id: 'desktop-enhanced-noSMAA', ctx: DESKTOP, mode: 'enhanced', skip: SKIP_SMAA },
  {
    id: 'desktop-enhanced-noPost',
    ctx: DESKTOP,
    mode: 'enhanced',
    skip: [...SKIP_SAO, ...SKIP_BLOOM, ...SKIP_SMAA],
  },
]

async function runOne(browser, layoutJson, run) {
  const ctx = await browser.newContext(run.ctx)
  const page = await ctx.newPage()
  page.on('pageerror', (e) => console.warn(`  [pageerror] ${e.message}`))
  page.on('crash', () => console.warn('  [crash] page crashed (GPU process death?)'))
  page.on('close', () => console.warn('  [close] page closed'))
  await page.addInitScript(
    ([mode, layout]) => {
      localStorage.setItem('bb.onboarded', '1')
      localStorage.setItem('bb.renderMode', mode)
      localStorage.setItem('bb.layout', layout)
    },
    [run.mode, layoutJson],
  )
  await page.addInitScript(instrument)
  await page.goto(`${URL}?shotrig`)
  await page.waitForSelector('canvas')
  await page.bringToFront()
  await settle(page, run.mode === 'performance' ? 2000 : 3200) // boot + lazy chunks + HDRI

  let studioState = null
  if (run.studio) studioState = await waitStudioReady(page, STUDIO_TIMEOUT_MS)

  if (run.skip) await page.evaluate((tags) => globalThis.__bbPerf.setSkip(tags), run.skip)
  // clean heap baseline so the orbit's allocation slope is the loop's own
  await page.evaluate(() => {
    globalThis.gc?.()
  })
  await settle(page, 300)

  await page.evaluate(() => globalThis.__bbPerf.mark('idle0:start'))
  await settle(page, IDLE_MS)
  await page.evaluate(() => globalThis.__bbPerf.mark('idle0:end'))

  await page.evaluate(() => globalThis.__bbPerf.mark('orbit:start'))
  await (run.ctx.hasTouch ? orbit360Touch : orbit360)(page)
  await page.evaluate(() => globalThis.__bbPerf.mark('orbit:end'))

  await page.evaluate(() => globalThis.__bbPerf.mark('idle1:start'))
  await settle(page, run.studio ? IDLE_MS + 3000 : IDLE_MS) // studio: watch re-convergence kick in
  await page.evaluate(() => globalThis.__bbPerf.mark('idle1:end'))

  const data = await page.evaluate(() => globalThis.__bbPerf.collect())
  await ctx.close()

  const windows = {}
  for (const w of ['idle0', 'orbit', 'idle1']) {
    const i0 = markIndex(data.marks, `${w}:start`)
    const i1 = markIndex(data.marks, `${w}:end`)
    if (i0 >= 0 && i1 > i0) windows[w] = windowStats(data, i0, i1)
  }
  return {
    id: run.id,
    mode: run.mode,
    viewport: `${run.ctx.viewport.width}x${run.ctx.viewport.height}@${run.ctx.deviceScaleFactor}x`,
    input: run.ctx.hasTouch ? 'touch' : 'mouse',
    skippedPasses: run.skip ?? null,
    studioState,
    glRenderer: data.glInfo?.renderer ?? null,
    devicePixelRatio: data.dpr,
    totals: data.totals,
    windows,
  }
}

// ---------------------------------------------------------------------------
// repeat aggregation — a single run on a desktop OS is not evidence
// ---------------------------------------------------------------------------

const spread3 = (values) => {
  const s = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b)
  if (s.length === 0) return null
  return { min: s[0], med: s[Math.floor((s.length - 1) / 2)], max: s[s.length - 1] }
}

/**
 * Collapse N repeats of one config into a single report row: the
 * representative row is the MEDIAN-by-orbit-avgFps repeat (all its windows
 * verbatim), `spread` carries min/med/max for the headline metrics, and
 * `repeatRuns` keeps every repeat (including failures) for the JSON.
 */
function aggregate(run, repeats) {
  const ok = repeats.filter((r) => !r.error && r.windows?.orbit)
  if (ok.length === 0) {
    return {
      id: run.id,
      error: repeats.map((r) => r.error ?? 'no orbit window').join(' | '),
      repeatsTotal: repeats.length,
      repeatsOk: 0,
      repeatRuns: repeats,
      windows: {},
    }
  }
  const byFps = [...ok].sort((a, b) => a.windows.orbit.avgFps - b.windows.orbit.avgFps)
  const rep = byFps[Math.floor((byFps.length - 1) / 2)]
  const spread = {
    orbit: {
      avgFps: spread3(ok.map((r) => r.windows.orbit.avgFps)),
      p95: spread3(ok.map((r) => r.windows.orbit.frameMs.p95)),
      worst1pctMean: spread3(ok.map((r) => r.windows.orbit.frameMs.worst1pctMean)),
      jankFramesOver33ms: spread3(ok.map((r) => r.windows.orbit.jankFramesOver33ms)),
    },
    idle1: {
      avgFps: spread3(ok.map((r) => r.windows.idle1?.avgFps)),
      p95: spread3(ok.map((r) => r.windows.idle1?.frameMs.p95)),
      max: spread3(ok.map((r) => r.windows.idle1?.frameMs.max)),
    },
  }
  return {
    ...rep,
    repeatsTotal: repeats.length,
    repeatsOk: ok.length,
    studioStates: repeats.map((r) => r.studioState ?? null),
    spread,
    repeatRuns: repeats,
  }
}

// ---------------------------------------------------------------------------
// report
// ---------------------------------------------------------------------------

const fmtSpread = (s, digits = 1) =>
  s && s.min !== s.max ? `${s.med} (${s.min.toFixed(digits)}–${s.max.toFixed(digits)})` : s ? `${s.med}` : '—'

function fmtRow(r) {
  const o = r.windows.orbit
  const i = r.windows.idle0
  if (!o) return `| ${r.id} | — boot failed (${r.repeatsTotal ?? 1}/${r.repeatsTotal ?? 1} repeats) — |`
  const multi = (r.repeatsOk ?? 1) > 1
  const fps = multi ? fmtSpread(r.spread.orbit.avgFps) : `${o.avgFps}`
  const p95 = multi ? fmtSpread(r.spread.orbit.p95) : `${o.frameMs.p95}`
  return (
    `| ${r.id} | ${r.viewport} | ${fps} | ${o.frameMs.p50} | ${p95} | ` +
    `${o.frameMs.worst1pctMean} | ${o.jankFramesOver33ms} | ${o.drawCalls.median} | ` +
    `${(o.triangles.median / 1000).toFixed(0)}k | ${o.allocKBPerFrame} | ${i ? i.avgFps : '—'} |`
  )
}

function toMarkdown(report) {
  const lines = [
    '# Perf — date-display orbit probe',
    '',
    `- generated: ${report.generatedAt}`,
    `- machine: ${report.machine}`,
    `- build: dist sha256:${report.dist.hash} (${report.dist.files} files, newest ${report.dist.newestMtime}) — rows are attributable to exactly this build`,
    `- gl: ${report.runs.find((r) => r.glRenderer)?.glRenderer ?? 'unknown'}`,
    `- repeats: ${report.repeat} per config${report.repeat > 1 ? ' (fps/p95 cells show median (min–max) across repeats; full per-repeat rows in the JSON)' : ' — SINGLE RUNS, treat absolute numbers as non-reproducible; use PERF_REPEAT=3 for verdicts'}`,
    `- workload: examples/date-display.json (37 components / 42 wires, standard board, sim stopped)`,
    `- gesture: 8s programmatic 360° orbit — 8×45° strokes of real mouse-pointer events (desktop rows) / real CDP touch points (phone rows)`,
    `- hover note: builds since Phase D (B3) gate hover raycasts OFF during the orbit gesture (re-armed on release); baseline-era builds processed hover every orbit frame — same user gesture, NOT identical per-frame work`,
    `- phone rows are viewport/DPR/touch EMULATION on this machine — they verify resolution scaling + coarse-pointer code paths, NOT real phone performance`,
    '',
    '## Orbit window (the user-reported gesture)',
    '',
    '| run | viewport | avg FPS | p50 ms | p95 ms | worst-1% ms | jank>33ms | draws/frame | tris/frame | alloc KB/frame | idle FPS |',
    '|---|---|---|---|---|---|---|---|---|---|---|',
    ...report.runs.map(fmtRow),
    '',
    '## Detail per run',
    '',
  ]
  for (const r of report.runs) {
    lines.push(`### ${r.id}`)
    lines.push('')
    if (r.error) {
      lines.push(`- RUN FAILED (all ${r.repeatsTotal ?? 1} repeats): ${r.error}`)
      lines.push('')
      continue
    }
    lines.push(
      `- mode=${r.mode} viewport=${r.viewport} dpr=${r.devicePixelRatio} input=${r.input ?? 'mouse'}` +
        (r.skippedPasses ? ` skipped=[${r.skippedPasses.join(', ')}]` : '') +
        (r.studioState ? ` studio=${r.studioState}` : ''),
    )
    if ((r.repeatsTotal ?? 1) > 1) {
      lines.push(
        `- repeats: ${r.repeatsOk}/${r.repeatsTotal} ok — orbit fps ${fmtSpread(r.spread.orbit.avgFps)} · ` +
          `p95 ${fmtSpread(r.spread.orbit.p95)} ms · worst-1% ${fmtSpread(r.spread.orbit.worst1pctMean)} ms · ` +
          `idle1 max ${fmtSpread(r.spread.idle1.max)} ms (detail lines below = the median repeat)` +
          (r.studioStates?.some((s) => s) ? ` · studio states [${r.studioStates.join(', ')}]` : ''),
      )
    }
    lines.push(
      `- totals: programsLinked=${r.totals.programs} texturesLive=${r.totals.texLive} ` +
        `instancedDraws=${r.totals.instancedDraws} skippedDraws=${r.totals.skipped}`,
    )
    for (const [name, w] of Object.entries(r.windows)) {
      if (!w) continue
      lines.push(
        `- ${name}: ${w.avgFps} fps over ${w.frames}f/${w.durationMs}ms · ` +
          `frame p50/p95/p99/max = ${w.frameMs.p50}/${w.frameMs.p95}/${w.frameMs.p99}/${w.frameMs.max} ms · ` +
          `draws ${w.drawCalls.median} (max ${w.drawCalls.max}) · tris ${(w.triangles.median / 1000).toFixed(0)}k · ` +
          `fbBinds ${w.fbBindsPerFrame} · progLinks ${w.programLinks} · shadowRenders ${w.shadowMapRenders} · ` +
          `alloc ${w.allocKBPerFrame} KB/f (${w.allocMBPerSec} MB/s, ${w.gcDrops} GC drops)` +
          (w.studioSamplesStart >= 0
            ? ` · studio samples ${w.studioSamplesStart}→${w.studioSamplesEnd}, bvhBuilds ${w.studioBvhBuilds}`
            : ''),
      )
    }
    lines.push('')
  }
  return lines.join('\n')
}

// ---------------------------------------------------------------------------

async function main() {
  mkdirSync(here('../perf'), { recursive: true })
  const layoutJson = readFileSync(here('../examples/date-display.json'), 'utf8')
  const server = await startPreview()

  // HEADED — a real window on the real GPU. headless chromium underclocks /
  // software-paths GL and reports fantasy frame times for this workload.
  // One BROWSER PER RUN + one retry: the chromium GPU process occasionally
  // dies (SIGTERM) under heavy WebGL churn, which would otherwise take every
  // remaining run down with it.
  const launch = () =>
    chromium.launch({
      headless: false,
      args: ['--use-angle=metal', '--enable-precise-memory-info', '--js-flags=--expose-gc'],
    })

  const dist = distProvenance()
  console.log(`build under test: dist sha256:${dist.hash} (${dist.files} files, newest ${dist.newestMtime})`)

  const runs = []
  try {
    for (const run of RUNS) {
      if (!want(run.id)) continue
      console.log(`▶ ${run.id} …${REPEAT > 1 ? ` (×${REPEAT})` : ''}`)
      const repeats = []
      for (let rep = 0; rep < REPEAT; rep++) {
        let result = null
        for (let attempt = 0; attempt < 2 && !result; attempt++) {
          if (attempt > 0) console.log('  retrying with a fresh browser…')
          const browser = await launch()
          try {
            result = await runOne(browser, layoutJson, run)
          } catch (err) {
            console.error(`  repeat ${rep + 1} attempt ${attempt + 1} failed: ${err.message}`)
            if (attempt === 1) repeats.push({ error: String(err.message), windows: {} })
          } finally {
            await browser.close().catch(() => {})
          }
        }
        if (result) {
          repeats.push(result)
          const o = result.windows.orbit
          console.log(
            `  ${REPEAT > 1 ? `[${rep + 1}/${REPEAT}] ` : ''}orbit: ${o?.avgFps} fps · p95 ${o?.frameMs.p95}ms · ` +
              `worst1% ${o?.frameMs.worst1pctMean}ms · draws ${o?.drawCalls.median} · ` +
              `tris ${((o?.triangles.median ?? 0) / 1000).toFixed(0)}k`,
          )
        }
      }
      runs.push(aggregate(run, repeats))
    }
  } finally {
    server.kill()
  }

  const report = {
    generatedAt: new Date().toISOString(),
    machine: `${os.type()} ${os.release()} · ${os.cpus()[0]?.model ?? '?'} · ${Math.round(os.totalmem() / 2 ** 30)} GB`,
    dist,
    repeat: REPEAT,
    workload: 'examples/date-display.json · 8s 360° orbit · sim stopped',
    runs,
  }
  writeFileSync(here(`../perf/${OUT_NAME}.json`), JSON.stringify(report, null, 2))
  writeFileSync(here(`../perf/${OUT_NAME}.md`), toMarkdown(report))
  console.log(`\nwrote perf/${OUT_NAME}.json + perf/${OUT_NAME}.md`)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
