/**
 * Device-viewport screenshot harness (integration verification).
 *
 * Serves the built dist/ via `vite preview`, then drives a phone-sized
 * (390x844 @3x, touch) and a desktop (1440x900) chromium context through the
 * primary chrome surfaces, writing PNGs to shots/.
 *
 * Usage: node scripts/screenshot.mjs   (run `npm run build` first)
 */
import { spawn } from 'node:child_process'
import { mkdirSync, readFileSync } from 'node:fs'
import { chromium } from 'playwright'

const PORT = 4173
const URL = `http://localhost:${PORT}/`

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

/** Tap an element through the touchscreen (real touch events, not click). */
async function tap(page, locator) {
  const box = await locator.boundingBox()
  if (!box) throw new Error('element not visible for tap')
  await page.touchscreen.tap(box.x + box.width / 2, box.y + box.height / 2)
}

const settle = (page, ms = 900) => page.waitForTimeout(ms)

async function main() {
  mkdirSync(new globalThis.URL('../shots', import.meta.url).pathname, { recursive: true })
  const server = await startPreview()
  // ANGLE Metal = the real GPU in headless (matches modes/closeups/sweeps):
  // the ANGLE-OpenGL fallback corrupts the Enhanced composer once hover FX
  // draw (sticky black frames) — a backend artifact absent on Metal.
  const browser = await chromium.launch({
    args: process.env.MODES_SWIFTSHADER ? [] : ['--use-angle=metal'],
  })

  try {
    // ---- phone: 390x844 @3x, touch ----
    const phone = await browser.newContext({
      viewport: { width: 390, height: 844 },
      deviceScaleFactor: 3,
      isMobile: true,
      hasTouch: true,
    })
    const page = await phone.newPage()

    // 1) first launch → onboarding overlay
    await page.goto(URL)
    await page.waitForSelector('canvas')
    await settle(page, 1500)
    await page.screenshot({ path: 'shots/phone-onboarding.png' })

    // 2) home (onboarded, empty board → empty-state card)
    await page.evaluate(() => localStorage.setItem('bb.onboarded', '1'))
    await page.reload()
    await page.waitForSelector('canvas')
    await settle(page, 1500)
    await page.screenshot({ path: 'shots/phone-home.png' })

    // a sheet covers the dock while open (iOS-style); dismiss via scrim tap
    const dismissSheet = async () => {
      await page.touchscreen.tap(195, 170)
      await settle(page, 700)
    }

    // 2b) empty-state "Ask AI" → AI sheet with the date prompt prefilled
    await tap(page, page.getByRole('button', { name: 'Ask AI' }))
    await settle(page)
    await page.screenshot({ path: 'shots/phone-ai-prefill.png' })
    await dismissSheet()

    // 3) Parts sheet
    await tap(page, page.getByRole('tab', { name: 'Parts' }))
    await settle(page)
    await page.screenshot({ path: 'shots/phone-parts.png' })
    await dismissSheet()

    // 4) AI sheet
    await tap(page, page.getByRole('tab', { name: 'AI' }))
    await settle(page)
    await page.screenshot({ path: 'shots/phone-ai.png' })
    await dismissSheet()

    // 5) wire mode armed (color strip + hint toast)
    await tap(page, page.getByRole('tab', { name: 'Wire' }))
    await settle(page, 600)
    await page.screenshot({ path: 'shots/phone-wire.png' })
    await tap(page, page.getByRole('tab', { name: 'Wire' })) // disarm
    await settle(page, 400)

    // 6) More sheet
    await tap(page, page.getByRole('tab', { name: 'More' }))
    await settle(page)
    await page.screenshot({ path: 'shots/phone-more.png' })

    // 7) load the "555 LED blinker" example → sheet dismisses and the camera
    //    springs to frame the loaded circuit (must be visible, not off-screen)
    try {
      // drag the sheet from half to full so the Examples group is reachable
      // (start on the sheet's title area — the top edge sits at ~y398 at the
      // half snap and a press above it would hit the dismissing scrim)
      await page.mouse.move(80, 450)
      await page.mouse.down()
      await page.mouse.move(80, 110, { steps: 12 })
      await page.mouse.up()
      await settle(page, 800)
      // the Examples group sits below the fold (the Board group grew a Boards
      // stepper row) — scroll the sheet content to the example row first
      const example = page.getByText('555 LED blinker', { exact: true })
      await example.scrollIntoViewIfNeeded()
      await settle(page, 400)
      await tap(page, example)
      await settle(page, 1400) // sheet dismissal + camera re-frame tween
      await page.screenshot({ path: 'shots/phone-example.png' })
    } catch (err) {
      console.warn('example flow skipped:', err.message)
    }
    await phone.close()

    // ---- desktop: 1440x900, pointer ----
    const desktop = await browser.newContext({ viewport: { width: 1440, height: 900 } })
    const dpage = await desktop.newPage()
    await dpage.addInitScript(() => localStorage.setItem('bb.onboarded', '1'))
    await dpage.goto(URL)
    await dpage.waitForSelector('canvas')
    await settle(dpage, 1500)
    await dpage.screenshot({ path: 'shots/desktop.png' })

    await dpage.getByRole('tab', { name: 'Parts' }).click()
    await settle(dpage)
    await dpage.screenshot({ path: 'shots/desktop-parts.png' })

    await dpage.getByRole('tab', { name: 'AI' }).click()
    await settle(dpage)
    await dpage.screenshot({ path: 'shots/desktop-ai.png' })

    // place a resistor with two board clicks, then select it → Properties
    try {
      await dpage.getByRole('tab', { name: 'Parts' }).click()
      await settle(dpage)
      await dpage.getByText('Resistor', { exact: true }).first().click()
      await settle(dpage, 500)
      await dpage.keyboard.press('Escape') // close the panel (Esc = topmost surface)
      await settle(dpage, 500)
      await dpage.mouse.click(640, 500) // snaps to nearest hole
      await settle(dpage, 400)
      // follow the board's screen tilt: same hole row is ~6px higher here —
      // (760,500) lands in the row-j/rail dead zone and the click is ignored
      await dpage.mouse.click(744, 494)
      await settle(dpage, 600)
      await dpage.keyboard.press('Escape') // leave repeat-placement mode
      await settle(dpage, 400)
      await dpage.mouse.click(692, 490) // click the resistor body → select
      await settle(dpage)
      await dpage.screenshot({ path: 'shots/desktop-properties.png' })
    } catch (err) {
      console.warn('placement flow skipped:', err.message)
    }
    await desktop.close()

    // ---- integration: dense wiring, board sizes, undo/redo, beauty ----
    const readExample = (name) =>
      readFileSync(new globalThis.URL(`../examples/${name}`, import.meta.url), 'utf8')

    /** Fresh 1440x900 desktop page with an optional layout pre-seeded. */
    const openWith = async (layoutJson, { dsf = 2 } = {}) => {
      const ctx = await browser.newContext({
        viewport: { width: 1440, height: 900 },
        deviceScaleFactor: dsf,
      })
      const p = await ctx.newPage()
      await p.addInitScript(
        ([l]) => {
          localStorage.setItem('bb.onboarded', '1')
          if (l) localStorage.setItem('bb.layout', l)
          else localStorage.removeItem('bb.layout')
        },
        [layoutJson ?? null],
      )
      await p.goto(URL)
      await p.waitForSelector('canvas')
      await settle(p, 1600)
      return { ctx, page: p }
    }

    // (a) date-display: 42-wire routing acid test, two angles
    // (b,c) board size switching on the same dense circuit
    {
      const { ctx, page: ipage } = await openWith(readExample('date-display.json'))

      await ipage.screenshot({ path: 'shots/int-date-display-home.png' })

      // second angle: orbit-drag the camera lower and to the side
      await ipage.mouse.move(720, 430)
      await ipage.mouse.down()
      await ipage.mouse.move(560, 350, { steps: 14 })
      await ipage.mouse.up()
      await settle(ipage, 900)
      await ipage.screenshot({ path: 'shots/int-date-display-angle.png' })

      // (b) grow to Lab XL via the More sheet's Board segmented control
      await ipage.getByRole('tab', { name: 'More' }).click()
      await settle(ipage, 800)
      await ipage.getByRole('radio', { name: 'Lab XL' }).click()
      await settle(ipage, 1200) // board rebuild + shadow refit
      await ipage.screenshot({ path: 'shots/int-board-labxl-sheet.png' })
      await ipage.keyboard.press('Escape') // dismiss the panel
      await settle(ipage, 600)
      // double-click empty space → re-frame the (now larger) board
      await ipage.mouse.click(1240, 800)
      await ipage.waitForTimeout(120)
      await ipage.mouse.click(1240, 800)
      await settle(ipage, 1400)
      await ipage.screenshot({ path: 'shots/int-board-labxl.png' })

      // (c1) shrink to Half must REFUSE (date-display parts don't fit):
      // toast asserted in the DOM here; the toast *screenshot* happens in the
      // fast DSF-1 context below (full-page capture at DSF 2 takes ~2.4s —
      // longer than the toast's remaining 2.2s life, so the frame misses it)
      await ipage.getByRole('tab', { name: 'More' }).click()
      await settle(ipage, 800)
      await ipage.getByRole('radio', { name: 'Half' }).click()
      const toast = ipage.locator('.lg-toast', { hasText: 'would fall off the Half board' })
      await toast.waitFor({ state: 'visible', timeout: 4000 })
      console.log('refusal toast (labxl→half):', (await toast.innerText()).trim())
      // the board must still be Lab XL (refused switch leaves layout untouched)
      const checked = await ipage
        .getByRole('radio', { name: 'Lab XL' })
        .getAttribute('aria-checked')
      if (checked !== 'true') throw new Error('board changed despite refusal toast')
      await ctx.close()
    }

    // (c2) refusal toast screenshot — DSF 1 so capture (~0.9s) lands inside
    // the toast's 2.2s lifetime with the spring-in already finished
    {
      const { ctx, page: tpage } = await openWith(readExample('date-display.json'), { dsf: 1 })
      await tpage.getByRole('tab', { name: 'More' }).click()
      await settle(tpage, 800)
      const toast = tpage.locator('.lg-toast', { hasText: 'would fall off the Half board' })
      let caught = false
      for (let attempt = 0; attempt < 3 && !caught; attempt++) {
        await tpage.getByRole('radio', { name: 'Half' }).click()
        try {
          await toast.waitFor({ state: 'visible', timeout: 2500 })
          console.log('refusal toast (std→half):', (await toast.innerText()).trim())
          await tpage.screenshot({ path: 'shots/int-half-refusal.png' })
          caught = true
        } catch {
          await settle(tpage, 600) // let any missed toast clear, then retry
        }
      }
      if (!caught) {
        await tpage.screenshot({ path: 'shots/int-half-refusal-FAILED.png' })
        throw new Error('Half-board refusal toast never appeared')
      }
      await ctx.close()
    }

    // (d) place a part → undo via the pill → redo (pill state screenshots)
    {
      const { ctx, page: upage } = await openWith(null)
      await upage.getByRole('tab', { name: 'Parts' }).click()
      await settle(upage)
      await upage.getByText('Resistor', { exact: true }).first().click()
      await settle(upage, 500)
      await upage.keyboard.press('Escape')
      await settle(upage, 500)
      await upage.mouse.click(640, 500)
      await settle(upage, 400)
      await upage.mouse.click(744, 494) // second lead (follows the board tilt)
      await settle(upage, 600)
      await upage.keyboard.press('Escape') // leave repeat-placement mode
      await settle(upage, 400)

      const undoBtn = upage.getByRole('button', { name: 'Undo' })
      const redoBtn = upage.getByRole('button', { name: 'Redo' })
      await undoBtn.waitFor({ state: 'visible', timeout: 4000 })
      if (await undoBtn.isDisabled()) throw new Error('Undo disabled after placement')
      if (!(await redoBtn.isDisabled())) throw new Error('Redo enabled before any undo')
      await upage.screenshot({ path: 'shots/int-undo-pill.png' })

      await undoBtn.click()
      await settle(upage, 700)
      if (!(await undoBtn.isDisabled())) throw new Error('Undo still enabled after sole undo')
      if (await redoBtn.isDisabled()) throw new Error('Redo disabled after undo')
      await upage.screenshot({ path: 'shots/int-undo-after-undo.png' })

      await redoBtn.click()
      await settle(upage, 700)
      if (await undoBtn.isDisabled()) throw new Error('Undo disabled after redo')
      if (!(await redoBtn.isDisabled())) throw new Error('Redo enabled after redo')
      await upage.screenshot({ path: 'shots/int-undo-after-redo.png' })
      await ctx.close()
    }

    // (e) blinky-555 beauty shot (default framing, PBR materials + shadows)
    {
      const { ctx, page: bpage } = await openWith(readExample('blinky-555.json'))
      await bpage.screenshot({ path: 'shots/int-blinky-beauty.png' })
      await ctx.close()
    }

    // ---- Phase B: holographic ghost, multi-board paddle, hover FX ----

    // (f) holographic placement ghost: enter place mode (resistor), hover a
    // hole → hologram + pin markers; pick the first hole → the FULL routed
    // part stretches first-hole → hover
    {
      const { ctx, page: gpage } = await openWith(null)
      await gpage.getByRole('tab', { name: 'Parts' }).click()
      await settle(gpage)
      await gpage.getByText('Resistor', { exact: true }).first().click()
      await settle(gpage, 500)
      await gpage.keyboard.press('Escape') // close the panel
      await settle(gpage, 500)
      await gpage.mouse.move(640, 500) // hover a hole → default-span hologram
      await settle(gpage, 700)
      await gpage.screenshot({ path: 'shots/int-holo-ghost-hover.png' })
      await gpage.mouse.click(640, 500) // pick the first hole
      await settle(gpage, 400)
      await gpage.mouse.move(744, 494) // routed ghost stretches to the hover
      await settle(gpage, 700)
      await gpage.screenshot({ path: 'shots/int-holo-ghost-routed.png' })
      // short-span hover → vertical-mount hologram
      await gpage.mouse.move(667, 498)
      await settle(gpage, 700)
      await gpage.screenshot({ path: 'shots/int-holo-ghost-vertical.png' })
      await ctx.close()
    }

    // (g) plus paddle → a 3-wide standard rig (tap the paddle twice). The
    // paddle floats just right of the rig's right edge at board height, but
    // its exact pixel position depends on the aspect-fit home framing — so
    // each tap PROBES a small grid near the right edge and ASSERTS growth via
    // the autosaved layout's boardCount (misses land on empty space / bare
    // holes, which are harmless; probes are spaced > the 450ms double-tap
    // window so they can never read as a re-frame gesture).
    {
      const { ctx, page: ppage } = await openWith(null)
      const boardCount = () =>
        ppage.evaluate(() => {
          try {
            return JSON.parse(localStorage.getItem('bb.layout') ?? 'null')?.boardCount ?? 1
          } catch {
            return 1
          }
        })
      const tapPaddle = async (expect) => {
        const xs = [0.862, 0.84, 0.885, 0.91, 0.815, 0.935]
        const ys = [0.42, 0.46, 0.38, 0.5, 0.34]
        for (const fy of ys) {
          for (const fx of xs) {
            await ppage.mouse.click(Math.round(fx * 1440), Math.round(fy * 900))
            await settle(ppage, 800) // > autosave debounce (500ms)
            if ((await boardCount()) === expect) {
              await settle(ppage, 1600) // module spring-in + camera re-frame
              return
            }
          }
        }
        throw new Error(`plus paddle not hit (rig still ${await boardCount()}×, wanted ${expect}×)`)
      }
      await ppage.screenshot({ path: 'shots/int-paddle-1x.png' })
      await tapPaddle(2)
      await ppage.screenshot({ path: 'shots/int-paddle-2x.png' })
      await tapPaddle(3)
      await ppage.screenshot({ path: 'shots/int-paddle-3x.png' })
      await ctx.close()
    }

    // (h) hover ring + coordinate chip closeup (zoom in, hover a hole). A
    // NON-empty layout is seeded so the empty-state card cannot cover the
    // canvas center (it intercepted the hover in the first harness pass) —
    // and recessed socket depth is judged at this inspection zoom too.
    {
      const { ctx, page: hpage } = await openWith(readExample('blinky-555.json'))
      await hpage.mouse.move(720, 450)
      await hpage.mouse.wheel(0, -2600) // dolly in toward the circuit
      await settle(hpage, 900)
      await hpage.mouse.move(700, 430)
      await settle(hpage, 200)
      await hpage.mouse.move(690, 420) // land on a hole at inspection zoom
      await settle(hpage, 800)
      await hpage.screenshot({ path: 'shots/int-hover-ring-chip.png' })
      await ctx.close()
    }

    console.log('screenshots written to shots/')
  } finally {
    await browser.close()
    server.kill()
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
