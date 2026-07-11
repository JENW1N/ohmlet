/**
 * Liquid-glass material probe (Phase F).
 *
 * Two modes:
 *
 *   node scripts/glass-probe.mjs visual
 *     Static page with a rail-striped backdrop and one capsule per candidate
 *     SVG-filter sizing strategy -> shots/glass-probe-visual.png. Used to
 *     pick the feImage sizing strategy that works inside
 *     `backdrop-filter: url(#...)` in Chromium (the spec is ambiguous; only
 *     a screenshot settles it).
 *
 *   node scripts/glass-probe.mjs perf
 *     Loads the BUILT app (vite preview must serve dist/ -- run
 *     `npm run build` first), injects N lensed surfaces over the live WebGL
 *     canvas while the camera orbits, and reports rAF frame-time stats for
 *     N = 0/1/3/6. Sets the DESIGN.md tier budget.
 */
import { spawn } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { chromium } from 'playwright'

const mode = process.argv[2] ?? 'visual'

/* ---------------------------------------------------------------- visual */

/** Displacement map PNG (data URI) via a canvas drawn INSIDE the page. */
const MAP_BUILDER = `
function buildMap(w, h, radius, bezel) {
  const c = document.createElement('canvas')
  c.width = w; c.height = h
  const ctx = c.getContext('2d')
  const img = ctx.createImageData(w, h)
  const hx = w / 2, hy = h / 2
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const px = x + 0.5 - hx, py = y + 0.5 - hy
      // signed distance to rounded-rect edge (negative inside)
      const qx = Math.abs(px) - (hx - radius), qy = Math.abs(py) - (hy - radius)
      const ax = Math.max(qx, 0), ay = Math.max(qy, 0)
      const d = Math.hypot(ax, ay) + Math.min(Math.max(qx, qy), 0) - radius
      const inside = -d // px from edge, >=0 inside
      let mag = 0
      if (inside >= 0 && inside < bezel) {
        const t = inside / bezel
        mag = Math.pow(1 - t, 2.2)
      }
      // outward normal from SDF gradient (numeric)
      let nx = 0, ny = 0
      if (mag > 0) {
        const e = 1
        const sd = (sx, sy) => {
          const qx2 = Math.abs(sx) - (hx - radius), qy2 = Math.abs(sy) - (hy - radius)
          return Math.hypot(Math.max(qx2, 0), Math.max(qy2, 0)) + Math.min(Math.max(qx2, qy2), 0) - radius
        }
        nx = (sd(px + e, py) - sd(px - e, py)) / (2 * e)
        ny = (sd(px, py + e) - sd(px, py - e)) / (2 * e)
        const len = Math.hypot(nx, ny) || 1
        nx /= len; ny /= len
      }
      const i = (y * w + x) * 4
      img.data[i] = Math.round(128 + nx * mag * 127)
      img.data[i + 1] = Math.round(128 + ny * mag * 127)
      img.data[i + 2] = 128
      img.data[i + 3] = 255
    }
  }
  ctx.putImageData(img, 0, 0)
  return c.toDataURL('image/png')
}
`

const VISUAL_PAGE = `<!doctype html><html><head><style>
  body { margin: 0; background: #b9c0c8; }
  /* breadboard-ish backdrop: white body, colored rails, hole grid */
  .bg {
    position: fixed; inset: 0;
    background:
      radial-gradient(2.5px 2.5px at 12px 12px, #222 98%, transparent) 0 0 / 24px 24px,
      linear-gradient(180deg, transparent 118px, #e33 118px, #e33 124px, transparent 124px,
        transparent 168px, #36e 168px, #36e 174px, transparent 174px),
      linear-gradient(180deg, transparent 418px, #e33 418px, #e33 424px, transparent 424px,
        transparent 468px, #36e 468px, #36e 474px, transparent 474px),
      #f2f3ee;
  }
  .cap {
    position: fixed; width: 340px; height: 64px; border-radius: 32px;
    background: linear-gradient(180deg, rgba(40,44,56,.30), rgba(24,26,34,.26));
    box-shadow: inset 0 1px 0 rgba(255,255,255,.2), 0 12px 40px rgba(0,0,0,.3);
    color: #fff; font: 600 15px system-ui; display: flex; align-items: center;
    justify-content: center;
  }
  .wide { width: 560px; }
  #a  { left: 40px;  top: 90px;  backdrop-filter: url(#lensA); }
  #a2 { left: 40px;  top: 390px; backdrop-filter: url(#lensA); }
  #b  { left: 420px; top: 90px;  backdrop-filter: url(#lensB); }
  #b2 { left: 640px; top: 390px; backdrop-filter: url(#lensB); }
  #c  { left: 800px; top: 90px;  backdrop-filter: url(#lensC); }
  #d  { left: 1180px; top: 90px; backdrop-filter: blur(6px) saturate(1.6) url(#lensC); }
  #e  { left: 1180px; top: 390px; backdrop-filter: blur(22px) saturate(1.8); }
</style></head><body>
<div class="bg"></div>
<div class="cap" id="a">A oBB units</div>
<div class="cap wide" id="a2">A oBB units — WIDE 560px</div>
<div class="cap" id="b">B percent subregion</div>
<div class="cap wide" id="b2">B percent — WIDE 560px</div>
<div class="cap" id="c">C fixed px</div>
<div class="cap" id="d">D blur+sat+url combo</div>
<div class="cap" id="e">E plain blur (ref)</div>
<svg width="0" height="0" style="position:absolute"><defs>
  <filter id="lensA" x="-20%" y="-20%" width="140%" height="140%"
          color-interpolation-filters="sRGB" primitiveUnits="objectBoundingBox">
    <feImage id="imgA" x="0" y="0" width="1" height="1" preserveAspectRatio="none" result="map"/>
    <feDisplacementMap in="SourceGraphic" in2="map" id="dispA"
                       xChannelSelector="R" yChannelSelector="G"/>
  </filter>
  <filter id="lensB" x="-20%" y="-20%" width="140%" height="140%"
          color-interpolation-filters="sRGB">
    <feImage id="imgB" x="0%" y="0%" width="100%" height="100%" preserveAspectRatio="none" result="map"/>
    <feDisplacementMap in="SourceGraphic" in2="map" scale="36"
                       xChannelSelector="R" yChannelSelector="G"/>
  </filter>
  <filter id="lensC" x="-20%" y="-20%" width="140%" height="140%"
          color-interpolation-filters="sRGB">
    <feImage id="imgC" x="0" y="0" width="340" height="64" preserveAspectRatio="none" result="map"/>
    <feDisplacementMap in="SourceGraphic" in2="map" scale="36"
                       xChannelSelector="R" yChannelSelector="G"/>
  </filter>
</defs></svg>
<script>
${MAP_BUILDER}
const uri = buildMap(340, 64, 32, 12)
for (const id of ['imgA', 'imgB', 'imgC']) {
  document.getElementById(id).setAttribute('href', uri)
}
// oBB displacement scale: 36px on the 340x64 nominal -> fraction of diagonal-ish norm
const norm = Math.sqrt((340 * 340 + 64 * 64) / 2)
document.getElementById('dispA').setAttribute('scale', String(36 / norm))
</script>
</body></html>`

async function visual() {
  mkdirSync(new URL('../shots', import.meta.url).pathname, { recursive: true })
  const browser = await chromium.launch({ args: ['--use-angle=metal'] })
  const page = await browser.newPage({
    viewport: { width: 1600, height: 520 },
    deviceScaleFactor: 2,
  })
  await page.setContent(VISUAL_PAGE)
  await page.waitForTimeout(600)
  await page.screenshot({ path: 'shots/glass-probe-visual.png' })
  for (const id of ['a', 'a2', 'b', 'c', 'd']) {
    const box = await page.locator(`#${id}`).boundingBox()
    await page.screenshot({
      path: `shots/glass-probe-${id}.png`,
      clip: {
        x: box.x - 30,
        y: box.y - 30,
        width: box.width + 60,
        height: box.height + 60,
      },
    })
  }
  await browser.close()
  console.log('wrote shots/glass-probe-*.png')
}

/* ------------------------------------------------------------------ perf */

const PORT = 4179
const URL_APP = `http://localhost:${PORT}/`

function startPreview() {
  const proc = spawn('npm', ['run', 'preview', '--', '--port', String(PORT), '--strictPort'], {
    cwd: new URL('..', import.meta.url).pathname,
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

async function perf() {
  const server = await startPreview()
  const browser = await chromium.launch({ args: ['--use-angle=metal'] })
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
    await page.addInitScript(() => localStorage.setItem('bb.onboarded', '1'))
    await page.goto(URL_APP)
    await page.waitForSelector('canvas')
    await page.waitForTimeout(1800)

    // measure rAF deltas for `ms` while the camera orbits (mouse drag loops)
    const measure = async (label) => {
      const dragLoop = (async () => {
        for (let i = 0; i < 4; i++) {
          await page.mouse.move(720, 450)
          await page.mouse.down()
          await page.mouse.move(520, 380, { steps: 25 })
          await page.mouse.move(900, 500, { steps: 25 })
          await page.mouse.up()
        }
      })()
      const stats = await page.evaluate(
        () =>
          new Promise((resolve) => {
            const deltas = []
            let last = performance.now()
            let frames = 0
            const loop = (t) => {
              deltas.push(t - last)
              last = t
              if (++frames < 150) requestAnimationFrame(loop)
              else {
                deltas.sort((a, b) => a - b)
                const p = (q) => deltas[Math.min(deltas.length - 1, Math.floor(q * deltas.length))]
                resolve({
                  avg: deltas.reduce((a, b) => a + b, 0) / deltas.length,
                  p50: p(0.5),
                  p95: p(0.95),
                  max: deltas[deltas.length - 1],
                })
              }
            }
            requestAnimationFrame(loop)
          }),
      )
      await dragLoop
      console.log(
        `${label}: avg ${stats.avg.toFixed(2)}ms p50 ${stats.p50.toFixed(2)} p95 ${stats.p95.toFixed(2)} max ${stats.max.toFixed(2)}`,
      )
      return stats
    }

    // inject N lensed surfaces (uses the app's own GlassDefs filters)
    const setLenses = (n) =>
      page.evaluate((count) => {
        document.querySelectorAll('.glass-probe-lens').forEach((el) => el.remove())
        for (let i = 0; i < count; i++) {
          const el = document.createElement('div')
          el.className = 'lg-surface lg-lens lg-lens-dock glass-probe-lens'
          el.style.cssText = `position:fixed;left:${80 + (i % 3) * 420}px;top:${140 + Math.floor(i / 3) * 240}px;width:360px;height:64px;z-index:99;border-radius:26px;pointer-events:none;`
          document.body.appendChild(el)
        }
      }, n)

    for (const n of [0, 1, 3, 6]) {
      await setLenses(n)
      await page.waitForTimeout(400)
      await measure(`lensed surfaces x${n}`)
    }
    await setLenses(0)

    // sheet-tier lens: one big surface (the worst real case — a sheet/panel
    // over the orbiting scene), alone and with dock+capsule-size lenses
    const setSheetLens = (withSmall) =>
      page.evaluate((extra) => {
        document.querySelectorAll('.glass-probe-lens').forEach((el) => el.remove())
        const sheet = document.createElement('div')
        sheet.className = 'lg-surface lg-lens lg-lens-sheet glass-probe-lens'
        sheet.style.cssText =
          'position:fixed;left:24px;top:140px;width:380px;height:620px;z-index:99;border-radius:22px;pointer-events:none;'
        document.body.appendChild(sheet)
        if (extra) {
          for (const [cls, w, h, x, y] of [
            ['lg-lens-dock', 372, 61, 480, 760],
            ['lg-lens-capsule', 220, 44, 560, 60],
          ]) {
            const el = document.createElement('div')
            el.className = `lg-surface lg-lens ${cls} glass-probe-lens`
            el.style.cssText = `position:fixed;left:${x}px;top:${y}px;width:${w}px;height:${h}px;z-index:99;border-radius:26px;pointer-events:none;`
            document.body.appendChild(el)
          }
        }
      }, withSmall)
    await setSheetLens(false)
    await page.waitForTimeout(400)
    await measure('sheet lens x1')
    await setSheetLens(true)
    await page.waitForTimeout(400)
    await measure('sheet + dock + capsule lenses')
    await setLenses(0)

    // reference: same N with plain blur-only surfaces (no displacement)
    const setBlurs = (n) =>
      page.evaluate((count) => {
        document.querySelectorAll('.glass-probe-lens').forEach((el) => el.remove())
        for (let i = 0; i < count; i++) {
          const el = document.createElement('div')
          el.className = 'glass-probe-lens'
          el.style.cssText = `position:fixed;left:${80 + (i % 3) * 420}px;top:${140 + Math.floor(i / 3) * 240}px;width:360px;height:64px;z-index:99;border-radius:26px;pointer-events:none;backdrop-filter:blur(22px) saturate(1.8);background:rgba(30,32,40,.5);`
          document.body.appendChild(el)
        }
      }, n)
    for (const n of [3, 6]) {
      await setBlurs(n)
      await page.waitForTimeout(400)
      await measure(`blur-only surfaces x${n}`)
    }
  } finally {
    await browser.close()
    server.kill()
  }
}

if (mode === 'visual') await visual()
else if (mode === 'perf') await perf()
else {
  console.error('usage: node scripts/glass-probe.mjs [visual|perf]')
  process.exit(1)
}
