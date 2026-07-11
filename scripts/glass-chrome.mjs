/**
 * Phase F chrome verification probe (Liquid Glass retrofit).
 *
 * Serves dist/ via `vite preview` and captures the retrofitted chrome over
 * the live board in Chromium (ANGLE Metal):
 *   - phone home: dock + capsule lenses (+ dock-edge closeup clip)
 *   - Parts sheet: mid-morph frame (condense-from-tab) + settled band lens
 *   - wire mode: toast pill (rim+specular tier) + clear strip
 *   - More → Clear board: ActionSheet clear-variant cards over the scrim
 *   - `?lens=off`: the cross-engine blur fallback
 *   - STACKED sheets (Parts + auto-presented Properties via marquee
 *     selection, phone AND desktop): the recessed tier must hold the
 *     ≤4-filter / ≤3-lens budget
 *   - tone adaptation: zoom the camera until the dock floats over the
 *     bright board → the platter must flip light (is-tone-light), and back
 *   - perf: rAF deltas while orbiting under the worst real stack
 *     (sheet at peek band+body + dock + capsule, tone sampler live)
 *
 * Every "live backdrop-filters" probe counts via checkVisibility() — NEVER
 * offsetParent, which is null for every position:fixed surface (dock,
 * panels) and silently undercounts. The budget caps (≤4 filters, ≤3
 * lenses — DESIGN.md §1/§7) are HARD asserts here, not just logs.
 *
 * Usage: npm run build && node scripts/glass-chrome.mjs
 */
import { spawn } from 'node:child_process'
import { mkdirSync, readFileSync } from 'node:fs'
import { chromium } from 'playwright'

const PORT = 4181
const URL = `http://localhost:${PORT}/`

const MAX_FILTERS = 4
const MAX_LENSES = 3

/** In-page audit of LIVE backdrop-filters (visibility-aware, fixed-position
 *  included) — runs inside page.evaluate. */
function auditFilters() {
  const live = Array.from(document.querySelectorAll('*')).filter((el) => {
    const bf = getComputedStyle(el).backdropFilter
    if (!bf || bf === 'none') return false
    // offsetParent is null for position:fixed (dock, panels, capsule) —
    // checkVisibility is the only honest liveness test
    return el.checkVisibility({ checkVisibilityCSS: true, visibilityProperty: true })
  })
  return {
    filters: live.length,
    lenses: live.filter((el) => getComputedStyle(el).backdropFilter.includes('url(')).length,
    list: live.map(
      (el) =>
        `${el.tagName.toLowerCase()}.${String(el.className).trim().split(/\s+/).slice(0, 3).join('.')}`,
    ),
  }
}

/** Audit + hard budget assert (≤4 filters, ≤3 lenses). */
async function assertBudget(page, label) {
  const audit = await page.evaluate(auditFilters)
  console.log(`${label}: filters ${audit.filters} lenses ${audit.lenses} — ${JSON.stringify(audit.list)}`)
  if (audit.filters > MAX_FILTERS || audit.lenses > MAX_LENSES) {
    throw new Error(
      `${label}: budget busted (${audit.filters} filters / ${audit.lenses} lenses; caps ${MAX_FILTERS}/${MAX_LENSES})`,
    )
  }
  return audit
}

/** Shift+drag marquee over the board → selection → Properties presents. */
async function marqueeSelect(page, x0, y0, x1, y1) {
  await page.keyboard.down('Shift')
  await page.mouse.move(x0, y0)
  await page.mouse.down()
  await page.mouse.move(x1, y1, { steps: 24 })
  await page.mouse.up()
  await page.keyboard.up('Shift')
}

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

async function tap(page, locator) {
  const box = await locator.boundingBox()
  if (!box) throw new Error('element not visible for tap')
  await page.touchscreen.tap(box.x + box.width / 2, box.y + box.height / 2)
}

const settle = (page, ms = 900) => page.waitForTimeout(ms)

async function main() {
  mkdirSync(new globalThis.URL('../shots', import.meta.url).pathname, { recursive: true })
  const server = await startPreview()
  const browser = await chromium.launch({ args: ['--use-angle=metal'] })
  const layout = readFileSync(
    new globalThis.URL('../examples/date-display.json', import.meta.url),
    'utf8',
  )

  const phoneCtx = (dsf = 3) =>
    browser.newContext({
      viewport: { width: 390, height: 844 },
      deviceScaleFactor: dsf,
      isMobile: true,
      hasTouch: true,
    })

  try {
    const ctx = await phoneCtx()
    const page = await ctx.newPage()
    await page.addInitScript(
      ([l]) => {
        localStorage.setItem('bb.onboarded', '1')
        localStorage.setItem('bb.layout', l)
      },
      [layout],
    )
    await page.goto(URL)
    await page.waitForSelector('canvas')
    await settle(page, 1800)

    // sanity: lens armed + the band filter exists with a baked map
    const lens = await page.evaluate(() => ({
      armed: document.documentElement.classList.contains('lg-lens-on'),
      bandMap: !!document
        .querySelector('#lg-lens-band feImage')
        ?.getAttribute('href')
        ?.startsWith('data:image/png'),
      tiers: Array.from(document.querySelectorAll('#lg-glass-defs filter')).map((f) => f.id),
    }))
    console.log('lens state:', JSON.stringify(lens))
    if (!lens.armed || !lens.bandMap) throw new Error('lens did not arm with the band tier')

    // 1) home: dock + capsule lenses over the dense board
    await page.screenshot({ path: 'shots/glassf-phone-home.png' })
    await page.screenshot({
      path: 'shots/glassf-dock-closeup.png',
      clip: { x: 0, y: 740, width: 390, height: 104 },
    })

    // 2) Parts: mid-morph frame right after the tab tap, then the settled
    //    sheet with its grabber-band lens
    await tap(page, page.getByRole('tab', { name: 'Parts' }))
    await page.waitForTimeout(120) // inside the 360ms condense
    await page.screenshot({ path: 'shots/glassf-sheet-morph-mid.png' })
    await settle(page)
    await page.screenshot({ path: 'shots/glassf-phone-parts.png' })
    await page.screenshot({
      path: 'shots/glassf-band-closeup.png',
      clip: { x: 0, y: 350, width: 390, height: 120 },
    })
    await page.touchscreen.tap(195, 170) // scrim-dismiss
    await settle(page, 700)

    // 3) wire mode: hint toast (rim+specular pill) + clear strip
    await tap(page, page.getByRole('tab', { name: 'Wire' }))
    await settle(page, 600)
    await page.screenshot({ path: 'shots/glassf-phone-wire.png' })
    await page.screenshot({
      path: 'shots/glassf-toast-closeup.png',
      clip: { x: 0, y: 560, width: 390, height: 180 },
    })
    await tap(page, page.getByRole('tab', { name: 'Wire' })) // disarm
    await settle(page, 400)

    // 4) More → Clear board → ActionSheet (clear-variant cards)
    await tap(page, page.getByRole('tab', { name: 'More' }))
    await settle(page)
    const clearRow = page.getByText('Clear board', { exact: true })
    await clearRow.scrollIntoViewIfNeeded()
    await settle(page, 400)
    await tap(page, clearRow)
    await settle(page, 800)
    await page.screenshot({ path: 'shots/glassf-actionsheet.png' })
    await assertBudget(page, 'action-sheet stack')
    await ctx.close()

    // 5) fallback (?lens=off): rich-blur material, no displacement
    const fb = await phoneCtx()
    const fpage = await fb.newPage()
    await fpage.addInitScript(
      ([l]) => {
        localStorage.setItem('bb.onboarded', '1')
        localStorage.setItem('bb.layout', l)
      },
      [layout],
    )
    await fpage.goto(`${URL}?lens=off`)
    await fpage.waitForSelector('canvas')
    await settle(fpage, 1800)
    const fallbackArmed = await fpage.evaluate(() =>
      document.documentElement.classList.contains('lg-lens-on'),
    )
    if (fallbackArmed) throw new Error('?lens=off failed to disable the lens')
    await fpage.screenshot({ path: 'shots/glassf-fallback-home.png' })
    await tap(fpage, fpage.getByRole('tab', { name: 'Parts' }))
    await settle(fpage)
    await fpage.screenshot({ path: 'shots/glassf-fallback-parts.png' })
    await fb.close()

    // 6) perf: worst real stack on phone — Parts sheet dragged to PEEK
    //    (band lens + body blur + dock lens + capsule lens) while orbiting
    const pctx = await phoneCtx(2)
    const ppage = await pctx.newPage()
    await ppage.addInitScript(
      ([l]) => {
        localStorage.setItem('bb.onboarded', '1')
        localStorage.setItem('bb.layout', l)
      },
      [layout],
    )
    await ppage.goto(URL)
    await ppage.waitForSelector('canvas')
    await settle(ppage, 1800)

    const measure = async (label) => {
      const dragLoop = (async () => {
        for (let i = 0; i < 4; i++) {
          await ppage.mouse.move(195, 300)
          await ppage.mouse.down()
          await ppage.mouse.move(90, 250, { steps: 22 })
          await ppage.mouse.move(300, 330, { steps: 22 })
          await ppage.mouse.up()
        }
      })()
      const stats = await ppage.evaluate(
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
    }

    await measure('baseline orbit (dock + capsule lenses)')
    await tap(ppage, ppage.getByRole('tab', { name: 'Parts' }))
    await settle(ppage)
    // drag the sheet down to peek so the dock returns (worst stack) —
    // gently, so the velocity projection cannot cross the dismiss point
    await ppage.mouse.move(195, 385)
    await ppage.mouse.down()
    await ppage.mouse.move(195, 585, { steps: 30 })
    await ppage.mouse.up()
    await settle(ppage, 800)
    const stack = await ppage.evaluate(() => ({
      sheet: !!document.querySelector('.lg-sheet .lg-sheet-band'),
      dockVisible: !document.body.classList.contains('lg-dock-covered'),
    }))
    console.log('peek stack:', JSON.stringify(stack))
    if (!stack.sheet || !stack.dockVisible) throw new Error('peek stack not established')
    await assertBudget(ppage, 'peek stack (band+body + dock + capsule)')
    await ppage.screenshot({ path: 'shots/glassf-peek-stack.png' })
    await ppage.screenshot({
      path: 'shots/glassf-peek-bubble-closeup.png',
      clip: { x: 0, y: 740, width: 390, height: 104 },
    })
    await measure('worst stack orbit (peek sheet band+body + dock + capsule)')

    // 7) STACKED sheets (the budget-buster reachability the offsetParent
    //    probe used to be blind to): with Parts still at peek, marquee-select
    //    the board → Properties auto-presents at half OVER it. Sheet.tsx must
    //    recess the Parts sheet (no filters) so the stack stays ≤4/≤3.
    await marqueeSelect(ppage, 20, 170, 370, 500)
    await settle(ppage, 900)
    const stacked = await ppage.evaluate(() => {
      const sheets = Array.from(document.querySelectorAll('.lg-sheet'))
      const recessed = document.querySelector('.lg-sheet.lg-glass-recessed')
      const band = recessed?.querySelector('.lg-sheet-band')
      const body = recessed?.querySelector('.lg-sheet-body')
      return {
        sheets: sheets.length,
        recessed: !!recessed,
        recessedBandFilter: band ? getComputedStyle(band).backdropFilter : null,
        recessedBodyFilter: body ? getComputedStyle(body).backdropFilter : null,
      }
    })
    console.log('stacked sheets (phone):', JSON.stringify(stacked))
    if (stacked.sheets < 2) throw new Error('marquee did not present Properties over Parts')
    if (!stacked.recessed || stacked.recessedBandFilter !== 'none' || stacked.recessedBodyFilter !== 'none')
      throw new Error('underlying Parts sheet was not recessed off the filter budget')
    await assertBudget(ppage, 'stacked sheets (Parts recessed + Properties + capsule)')
    await ppage.screenshot({ path: 'shots/glassf-stacked-sheets.png' })
    await pctx.close()

    // 8) desktop: Parts panel + marquee → Properties panel + rail + capsule.
    //    The non-topmost panel must shed its url() lens (blur-only) so the
    //    stack lands exactly on the caps: 4 filters / 3 lenses.
    const dctx = await browser.newContext({ viewport: { width: 1440, height: 900 } })
    const dpage = await dctx.newPage()
    await dpage.addInitScript(
      ([l]) => {
        localStorage.setItem('bb.onboarded', '1')
        localStorage.setItem('bb.layout', l)
      },
      [layout],
    )
    await dpage.goto(URL)
    await dpage.waitForSelector('canvas')
    await settle(dpage, 1800)
    await dpage.getByRole('tab', { name: 'Parts' }).click()
    await settle(dpage, 700)
    await marqueeSelect(dpage, 560, 140, 1280, 760)
    await settle(dpage, 900)
    const dstacked = await dpage.evaluate(() => {
      const panels = Array.from(document.querySelectorAll('.lg-panel'))
      const recessed = document.querySelector('.lg-panel.lg-glass-recessed')
      return {
        panels: panels.length,
        recessed: !!recessed,
        recessedFilter: recessed ? getComputedStyle(recessed).backdropFilter : null,
      }
    })
    console.log('stacked panels (desktop):', JSON.stringify(dstacked))
    if (dstacked.panels < 2) throw new Error('desktop marquee did not present Properties panel')
    if (!dstacked.recessed || !dstacked.recessedFilter || dstacked.recessedFilter.includes('url('))
      throw new Error('non-topmost desktop panel kept its displacement lens')
    await assertBudget(dpage, 'stacked panels (recessed Parts + Properties + rail + capsule)')
    await dpage.screenshot({ path: 'shots/glassf-desktop-stacked.png' })
    await dctx.close()

    // 9) tone adaptation: dolly into the board until the CAPSULE floats
    //    over the bright key-lit surface — that platter must flip light
    //    (dark ink), then flip back over the warm desk on zoom-out. The
    //    dock meanwhile hangs over the board's dark displays/ICs in this
    //    framing — per-platter independence is the point.
    const tctx = await phoneCtx(2)
    const tpage = await tctx.newPage()
    await tpage.addInitScript(
      ([l]) => {
        localStorage.setItem('bb.onboarded', '1')
        localStorage.setItem('bb.layout', l)
      },
      [layout],
    )
    await tpage.goto(URL)
    await tpage.waitForSelector('canvas')
    await settle(tpage, 1800)
    const toneOf = () =>
      tpage.evaluate(() => {
        const caps = document.querySelector('.lg-capsule-hit')
        const dock = document.querySelector('.lg-dock')
        return {
          capsLight: !!caps?.classList.contains('is-tone-light'),
          capsLum: caps?.style.getPropertyValue('--lg-lum') || null,
          dockLight: !!dock?.classList.contains('is-tone-light'),
          dockLum: dock?.style.getPropertyValue('--lg-lum') || null,
        }
      })
    const homeTone = await toneOf()
    console.log('tone at home (warm desk):', JSON.stringify(homeTone))
    if (homeTone.capsLight || homeTone.dockLight)
      throw new Error('a platter flipped light over the dark desk')
    await tpage.mouse.move(195, 420)
    for (let i = 0; i < 24; i++) {
      await tpage.mouse.wheel(0, -480)
      await tpage.waitForTimeout(80)
    }
    await settle(tpage, 1400) // ≥2 sampler votes
    const zoomTone = await toneOf()
    console.log('tone zoomed onto the board:', JSON.stringify(zoomTone))
    if (!zoomTone.capsLight)
      throw new Error(`capsule did not flip light over the bright board (lum ${zoomTone.capsLum})`)
    await tpage.screenshot({ path: 'shots/glassf-tone-light.png' })
    await tpage.screenshot({
      path: 'shots/glassf-tone-capsule-closeup.png',
      clip: { x: 0, y: 0, width: 390, height: 110 },
    })
    for (let i = 0; i < 24; i++) {
      await tpage.mouse.wheel(0, 480)
      await tpage.waitForTimeout(80)
    }
    await settle(tpage, 1400)
    const outTone = await toneOf()
    console.log('tone after zoom-out:', JSON.stringify(outTone))
    if (outTone.capsLight) throw new Error('capsule stayed light back over the desk')
    await tctx.close()

    console.log('wrote shots/glassf-*.png')
  } finally {
    await browser.close()
    server.kill()
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
