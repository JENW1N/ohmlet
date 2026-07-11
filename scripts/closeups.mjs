/**
 * Close-up mesh gate (user acceptance criterion).
 *
 * 1. `npx vite-node scripts/closeup-manifest.ts` script-generates a showcase
 *    layout containing EVERY catalog component type (validated) plus a
 *    per-type close-up camera pose computed from the part's pin holes via the
 *    model helpers.
 * 2. Serves the built dist/, seeds the showcase layout, and drives the
 *    `?shotrig` camera hook through every pose → shots/closeup-<type>.png.
 * 3. Screenshots the date-display and counter examples at standard zoom
 *    (content framing) for the interpenetration review.
 * 4. Stitches the close-ups into contact-sheet grids → shots/closeup-grid-N.png.
 *
 * Usage: npm run build && node scripts/closeups.mjs
 *        CLOSEUPS_MODE=enhanced node scripts/closeups.mjs
 *        (render mode: performance [default, bare filenames] | enhanced —
 *        non-default modes suffix every PNG with -<mode>)
 */
import { spawn, execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { chromium } from 'playwright'

const PORT = 4178
const URL = `http://localhost:${PORT}/`
const ROOT = new globalThis.URL('..', import.meta.url).pathname

const MODE = process.env.CLOSEUPS_MODE || 'performance'
if (!['performance', 'enhanced'].includes(MODE)) {
  throw new Error(`CLOSEUPS_MODE must be performance|enhanced, got "${MODE}"`)
}
/** filename suffix: baseline (performance) keeps the historical bare names */
const SUF = MODE === 'performance' ? '' : `-${MODE}`

function startPreview() {
  const proc = spawn('npm', ['run', 'preview', '--', '--port', String(PORT), '--strictPort'], {
    cwd: ROOT,
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

const settle = (page, ms = 700) => page.waitForTimeout(ms)

async function main() {
  mkdirSync(`${ROOT}shots`, { recursive: true })

  // 1) manifest (layout + camera poses) from the model helpers
  const manifest = JSON.parse(
    execFileSync('npx', ['vite-node', 'scripts/closeup-manifest.ts'], {
      cwd: ROOT,
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024,
    }),
  )
  console.log(`manifest: ${manifest.layout.components.length} components, ${manifest.shots.length} shots`)

  const server = await startPreview()
  // ANGLE Metal = the real GPU in headless (matches scripts/modes.mjs)
  const browser = await chromium.launch({
    args: process.env.MODES_SWIFTSHADER ? [] : ['--use-angle=metal'],
  })
  try {
    // 2) showcase close-ups through the shotrig camera hook
    const ctx = await browser.newContext({
      viewport: { width: 1100, height: 800 },
      deviceScaleFactor: 2,
    })
    const page = await ctx.newPage()
    await page.addInitScript(
      ([l, m]) => {
        localStorage.setItem('bb.onboarded', '1')
        localStorage.setItem('bb.layout', l)
        localStorage.setItem('bb.renderMode', m)
      },
      [JSON.stringify(manifest.layout), MODE],
    )
    await page.goto(`${URL}?shotrig`)
    await page.waitForSelector('canvas')
    await page.waitForFunction(() => typeof window.__shotRig?.setCamera === 'function')
    // boot frameContent tween + shadow settle (+ lazy composer chunk + HDRI)
    await settle(page, MODE === 'enhanced' ? 3200 : 1800)

    for (const shot of manifest.shots) {
      if (shot.cam) {
        await page.evaluate((cam) => window.__shotRig.setCamera(...cam), shot.cam)
        await settle(page, 450)
      }
      await page.screenshot({ path: `${ROOT}shots/closeup-${shot.name}${SUF}.png` })
      console.log(`shot closeup-${shot.name}${SUF}.png`)
    }
    await ctx.close()

    // 3) date-display + counter examples: standard zoom (content framing)
    //    plus shotrig sweep close-ups for the interpenetration review
    for (const ex of manifest.examples) {
      const ectx = await browser.newContext({ viewport: { width: 1440, height: 900 } })
      const epage = await ectx.newPage()
      await epage.addInitScript(
        ([l, m]) => {
          localStorage.setItem('bb.onboarded', '1')
          localStorage.setItem('bb.layout', l)
          localStorage.setItem('bb.renderMode', m)
        },
        [readFileSync(`${ROOT}examples/${ex.file}.json`, 'utf8'), MODE],
      )
      await epage.goto(`${URL}?shotrig`)
      await epage.waitForSelector('canvas')
      await epage.waitForFunction(() => typeof window.__shotRig?.setCamera === 'function')
      await settle(epage, MODE === 'enhanced' ? 3200 : 2000) // frameContent tween (+ lazy chunk)
      for (const shot of ex.shots) {
        if (shot.cam) {
          await epage.evaluate((cam) => window.__shotRig.setCamera(...cam), shot.cam)
          await settle(epage, 450)
        }
        await epage.screenshot({ path: `${ROOT}shots/closeup-${shot.name}${SUF}.png` })
        console.log(`shot closeup-${shot.name}${SUF}.png`)
      }
      await ectx.close()
    }

    // 4) contact-sheet grids (3x3 cells) for fast visual scanning
    const names = manifest.shots.map((s) => `closeup-${s.name}${SUF}.png`)
    const per = 9
    for (let g = 0; g * per < names.length; g++) {
      const cell = names.slice(g * per, (g + 1) * per)
      const html = `<!doctype html><body style="margin:0;background:#111;display:grid;grid-template-columns:repeat(3,1fr);gap:2px">${cell
        .map(
          (n) =>
            `<div style="position:relative"><img src="${n}" style="width:100%;display:block"><span style="position:absolute;left:6px;top:4px;color:#0f0;font:12px monospace">${n}</span></div>`,
        )
        .join('')}</body>`
      const sheetPath = `${ROOT}shots/_sheet.html`
      writeFileSync(sheetPath, html)
      const gctx = await browser.newContext({ viewport: { width: 1650, height: 1200 } })
      const gpage = await gctx.newPage()
      await gpage.goto(`file://${sheetPath}`)
      await gpage.waitForLoadState('networkidle')
      await gpage.screenshot({
        path: `${ROOT}shots/closeup-grid-${g + 1}${SUF}.png`,
        fullPage: true,
      })
      await gctx.close()
      console.log(`shot closeup-grid-${g + 1}${SUF}.png`)
    }
    rmSync(`${ROOT}shots/_sheet.html`, { force: true })

    console.log('close-up shots written to shots/')
  } finally {
    await browser.close()
    server.kill()
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
