/**
 * Render-mode visual harness (scene-integration verification).
 *
 * Serves the built dist/ via `vite preview`, then captures the SAME
 * blinky-555 scene in all three render modes — Performance / Enhanced /
 * Studio — plus a Studio CONVERGED close-up of the date-display digits and a
 * live-overlay-over-held-still proof, writing PNGs to shots/:
 *
 *   modes-performance.png        plain raster pipeline (the byte-equivalent default)
 *   modes-enhanced.png           HDRI + SAO + bloom + SMAA composer stack
 *   modes-studio.png             path-traced, fully converged (320 spp desktop)
 *   modes-studio-overlay.png     hover ring + chip composited OVER the held still
 *   modes-studio-dateclose.png   converged close-up of the date-display digits
 *
 * Also proves the lazy-chunk invariant at the NETWORK level: the Performance
 * session must never request the studio (path tracer) or enhanced (composer)
 * chunks nor the HDRI; the Enhanced session must never request the studio
 * chunk.
 *
 * Headless chromium runs on the real GPU via ANGLE Metal (macOS) — pass
 * MODES_SWIFTSHADER=1 to force the software rasterizer (much slower; the
 * convergence wait can be relaxed with MODES_STUDIO_TIMEOUT_S).
 *
 * Usage: npm run build && node scripts/modes.mjs
 *        MODES_ONLY=enhanced node scripts/modes.mjs   (tuning loop: one section
 *        of performance|enhanced|studio|dateclose)
 */
import { spawn } from 'node:child_process'
import { mkdirSync, readFileSync } from 'node:fs'
import { chromium } from 'playwright'

const PORT = 4174
const URL = `http://localhost:${PORT}/`
const STUDIO_TIMEOUT_MS = (Number(process.env.MODES_STUDIO_TIMEOUT_S) || 300) * 1000
/** run a single section while tuning constants (default: all) */
const want = (section) => !process.env.MODES_ONLY || process.env.MODES_ONLY === section

function startPreview() {
  const proc = spawn('npm', ['run', 'preview', '--', '--port', String(PORT), '--strictPort'], {
    cwd: new globalThis.URL('..', import.meta.url).pathname,
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

const settle = (page, ms = 900) => page.waitForTimeout(ms)

const readExample = (name) =>
  readFileSync(new globalThis.URL(`../examples/${name}`, import.meta.url), 'utf8')

/** Await Studio convergence via the ?shotrig progress hook. */
async function waitConverged(page, timeoutMs = STUDIO_TIMEOUT_MS) {
  const t0 = Date.now()
  await page.waitForFunction(
    () => globalThis.__shotRig?.renderProgress()?.converged === true,
    null,
    { timeout: timeoutMs, polling: 250 },
  )
  const p = await page.evaluate(() => globalThis.__shotRig.renderProgress())
  console.log(
    `  studio converged: ${p.samples}/${p.targetSamples} samples in ${((Date.now() - t0) / 1000).toFixed(1)}s`,
  )
}

async function main() {
  mkdirSync(new globalThis.URL('../shots', import.meta.url).pathname, { recursive: true })
  const server = await startPreview()
  // ANGLE Metal = the real GPU in headless (SwiftShader path-traces glacially)
  const browser = await chromium.launch({
    args: process.env.MODES_SWIFTSHADER ? [] : ['--use-angle=metal'],
  })

  try {
    /** Fresh desktop page: blinky layout seeded, render mode pre-persisted. */
    const openMode = async (mode, layoutJson, { rig = true } = {}) => {
      const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } })
      const page = await ctx.newPage()
      const requests = []
      page.on('request', (r) => requests.push(r.url()))
      await page.addInitScript(
        ([m, l]) => {
          localStorage.setItem('bb.onboarded', '1')
          localStorage.setItem('bb.renderMode', m)
          if (l) localStorage.setItem('bb.layout', l)
          else localStorage.removeItem('bb.layout')
        },
        [mode, layoutJson ?? null],
      )
      await page.goto(rig ? `${URL}?shotrig` : URL)
      await page.waitForSelector('canvas')
      await settle(page, 1800) // boot + camera frame + (lazy pipeline fetch)
      return { ctx, page, requests }
    }

    const blinky = readExample('blinky-555.json')

    // ---- 1) Performance: byte-equivalent classic pipeline + network proof --
    if (want('performance')) {
      const { ctx, page, requests } = await openMode('performance', blinky)
      await settle(page, 800)
      await page.screenshot({ path: 'shots/modes-performance.png' })
      const leaked = requests.filter((u) => /assets\/(studio|enhanced)-|\.hdr(\?|$)/.test(u))
      if (leaked.length > 0) {
        throw new Error(`Performance session fetched lazy render-mode assets:\n  ${leaked.join('\n  ')}`)
      }
      console.log(`performance: OK (${requests.length} requests, zero render-mode chunks)`)
      await ctx.close()
    }

    // ---- 2) Enhanced: composer stack; studio chunk must stay unfetched -----
    if (want('enhanced')) {
      const { ctx, page, requests } = await openMode('enhanced', blinky)
      await settle(page, 1200) // HDRI swap + 4096 shadow re-render
      await page.screenshot({ path: 'shots/modes-enhanced.png' })
      if (!requests.some((u) => /assets\/enhanced-/.test(u))) {
        throw new Error('Enhanced session never fetched the enhanced chunk')
      }
      const leaked = requests.filter((u) => /assets\/studio-/.test(u))
      if (leaked.length > 0) {
        throw new Error(`Enhanced session fetched the path-tracer chunk:\n  ${leaked.join('\n  ')}`)
      }
      console.log('enhanced: OK (composer chunk + HDRI fetched, no path tracer)')
      await ctx.close()
    }

    // ---- 3) Studio: converge the SAME blinky scene, then prove the raster
    //         overlay (hover ring + coordinate chip) draws OVER the held still
    if (want('studio')) {
      const { ctx, page, requests } = await openMode('studio', blinky)
      await waitConverged(page)
      await page.screenshot({ path: 'shots/modes-studio.png' })
      if (!requests.some((u) => /assets\/studio-/.test(u))) {
        throw new Error('Studio session never fetched the path-tracer chunk')
      }
      // hover an exact hole (c10 = plan (10, 0, 5), projected to client px) —
      // the phosphor ring + coordinate chip must appear WITHOUT breaking the
      // converged still (raster overlay compositing, not a re-render)
      const hole = await page.evaluate(() => globalThis.__shotRig.project(10, 0, 5))
      if (!hole) throw new Error('hole c10 projects off-screen')
      await page.mouse.move(hole.x - 10, hole.y - 10)
      await settle(page, 200)
      await page.mouse.move(hole.x, hole.y)
      await settle(page, 700) // hover-pop spring settles; still must hold
      const still = await page.evaluate(() => globalThis.__shotRig.renderProgress())
      if (!still?.converged) {
        throw new Error('hovering a hole broke the converged still (expected overlay compositing)')
      }
      await page.screenshot({ path: 'shots/modes-studio-overlay.png' })
      console.log('studio: OK (converged still + live hover overlay on top)')
      await ctx.close()
    }

    // ---- 4) Studio CONVERGED close-up: the date-display digits -------------
    if (want('dateclose')) {
      const { ctx, page } = await openMode('studio', readExample('date-display.json'))
      // park on the digit row (DS2/DS3 around columns 26..49), low 3/4 view
      await page.evaluate(() => globalThis.__shotRig.setCamera(39.4, 10.4, 20.7, 34, 0.5, 8))
      await settle(page, 400) // camera move resets accumulation
      await waitConverged(page)
      await page.screenshot({ path: 'shots/modes-studio-dateclose.png' })
      console.log('studio close-up: OK (converged date-display digits)')
      await ctx.close()
    }

    console.log('render-mode shots written to shots/modes-*.png')
  } finally {
    await browser.close()
    server.kill()
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
