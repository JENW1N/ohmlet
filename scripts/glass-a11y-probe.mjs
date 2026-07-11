/**
 * One-off Phase F a11y-path probe (verification only, safe to delete):
 *   - prefers-reduced-motion: open Parts (morphs must collapse to crossfade
 *     — capture a mid-transition frame + settled sheet)
 *   - prefers-reduced-transparency (via CDP): near-opaque slabs, lens never
 *     arms (html.lg-lens-on must be absent)
 * Usage: npm run build && node scripts/glass-a11y-probe.mjs
 */
import { spawn } from 'node:child_process'
import { chromium } from 'playwright'

const PORT = 4187
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

async function tap(page, locator) {
  const box = await locator.boundingBox()
  if (!box) throw new Error('element not visible for tap')
  await page.touchscreen.tap(box.x + box.width / 2, box.y + box.height / 2)
}

const phoneOpts = {
  viewport: { width: 390, height: 844 },
  deviceScaleFactor: 3,
  isMobile: true,
  hasTouch: true,
}

async function main() {
  const server = await startPreview()
  const browser = await chromium.launch({ args: ['--use-angle=metal'] })
  try {
    // ---- reduced motion ----
    {
      const ctx = await browser.newContext({ ...phoneOpts, reducedMotion: 'reduce' })
      const page = await ctx.newPage()
      await page.addInitScript(() => localStorage.setItem('bb.onboarded', '1'))
      await page.goto(URL)
      await page.waitForSelector('canvas')
      await page.waitForTimeout(1500)
      await tap(page, page.getByRole('tab', { name: 'Parts' }))
      await page.waitForTimeout(90) // mid-crossfade
      await page.screenshot({ path: 'shots/glassf-rm-parts-mid.png' })
      await page.waitForTimeout(900)
      await page.screenshot({ path: 'shots/glassf-rm-parts.png' })
      const anims = await page.evaluate(() =>
        document.getAnimations().map((a) => ({
          name: a.animationName ?? a.transitionProperty ?? 'waapi',
          ms: a.effect?.getTiming?.().duration ?? null,
        })),
      )
      console.log('reduced-motion settled animations:', JSON.stringify(anims))
      await ctx.close()
    }
    // ---- reduced transparency (CDP media feature) ----
    {
      const ctx = await browser.newContext(phoneOpts)
      const page = await ctx.newPage()
      const cdp = await ctx.newCDPSession(page)
      await cdp.send('Emulation.setEmulatedMedia', {
        features: [{ name: 'prefers-reduced-transparency', value: 'reduce' }],
      })
      await page.addInitScript(() => localStorage.setItem('bb.onboarded', '1'))
      await page.goto(URL)
      await page.waitForSelector('canvas')
      await page.waitForTimeout(1500)
      const lensOn = await page.evaluate(() =>
        document.documentElement.classList.contains('lg-lens-on'),
      )
      console.log('reduced-transparency lens armed (must be false):', lensOn)
      await page.screenshot({ path: 'shots/glassf-rt-home.png' })
      await tap(page, page.getByRole('tab', { name: 'Parts' }))
      await page.waitForTimeout(1000)
      const filters = await page.evaluate(() =>
        [...document.querySelectorAll('*')]
          .filter((el) => {
            const f = getComputedStyle(el).backdropFilter
            return f && f !== 'none'
          })
          .map((el) => el.className),
      )
      console.log('reduced-transparency live backdrop-filters (must be []):', JSON.stringify(filters))
      await page.screenshot({ path: 'shots/glassf-rt-parts.png' })
      await ctx.close()
    }
  } finally {
    await browser.close()
    server.kill()
  }
  console.log('wrote shots/glassf-rm-*.png + glassf-rt-*.png')
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
