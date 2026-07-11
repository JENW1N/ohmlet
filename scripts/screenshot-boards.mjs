/**
 * Board-size + rendering-realism screenshot harness (scene agent).
 *
 * Complements scripts/screenshot.mjs: loads layouts for each board preset
 * (half / standard / labxl) straight into localStorage, frames them, and
 * writes close-up shots so the PBR board/lighting work can be inspected.
 *
 * Usage: node scripts/screenshot-boards.mjs   (run `npm run build` first)
 */
import { spawn } from 'node:child_process'
import { mkdirSync, readFileSync } from 'node:fs'
import { chromium } from 'playwright'

const PORT = 4174
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

const blinky = JSON.parse(
  readFileSync(new globalThis.URL('../examples/blinky-555.json', import.meta.url), 'utf8'),
)

const labxl = {
  version: 1,
  name: 'labxl far-column smoke test',
  board: 'labxl',
  components: [
    { id: 'PS1', type: 'power_supply', params: { voltage: 5 } },
    { id: 'R1', type: 'resistor', params: { resistance: 330 }, holes: ['a100', 'a106'] },
    { id: 'D1', type: 'led', params: { color: 'red' }, holes: ['c106', 'c108'] },
  ],
  wires: [
    { id: 'w1', from: 'PS1:+', to: 'top+80', color: 'red' },
    { id: 'w2', from: 'PS1:-', to: 'top-80', color: 'black' },
    { id: 'w3', from: 'top+82', to: 'b100', color: 'red' },
    { id: 'w4', from: 'b108', to: 'top-83', color: 'black' },
  ],
}

const half = {
  version: 1,
  name: 'half-board smoke test',
  board: 'half',
  components: [
    { id: 'PS1', type: 'power_supply', params: { voltage: 5 } },
    { id: 'R1', type: 'resistor', params: { resistance: 330 }, holes: ['a10', 'a16'] },
    { id: 'D1', type: 'led', params: { color: 'green' }, holes: ['c16', 'c18'] },
  ],
  wires: [
    { id: 'w1', from: 'PS1:+', to: 'top+0', color: 'red' },
    { id: 'w2', from: 'PS1:-', to: 'top-0', 'color': 'black' },
    { id: 'w3', from: 'top+2', to: 'b10', color: 'red' },
    { id: 'w4', from: 'b18', to: 'top-3', color: 'black' },
  ],
}

async function shoot(browser, name, layout, { reframe = true, clip } = {}) {
  const ctx = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 2,
  })
  const page = await ctx.newPage()
  await page.addInitScript(
    ([l]) => {
      localStorage.setItem('bb.onboarded', '1')
      if (l) localStorage.setItem('bb.layout', l)
      else localStorage.removeItem('bb.layout')
    },
    [layout ? JSON.stringify(layout) : null],
  )
  await page.goto(URL)
  await page.waitForSelector('canvas')
  await page.waitForTimeout(1600)
  if (reframe && layout) {
    // double-click empty space → springs the camera to frame the content
    await page.mouse.click(1150, 750)
    await page.waitForTimeout(120)
    await page.mouse.click(1150, 750)
    await page.waitForTimeout(1100)
  }
  await page.waitForTimeout(600)
  await page.screenshot({ path: `shots/${name}.png`, clip })
  await ctx.close()
}

async function main() {
  mkdirSync(new globalThis.URL('../shots', import.meta.url).pathname, { recursive: true })
  const server = await startPreview()
  // ANGLE Metal = the real GPU in headless (matches modes/closeups/sweeps):
  // the ANGLE-OpenGL fallback corrupts the Enhanced composer once hover FX
  // draw (sticky black frames) — a backend artifact absent on Metal.
  const browser = await chromium.launch({
    args: process.env.MODES_SWIFTSHADER ? [] : ['--use-angle=metal'],
  })
  // single small part → reframe gives a tight product-photo crop of the board
  const macro = {
    version: 1,
    board: 'standard',
    components: [
      { id: 'R1', type: 'resistor', params: { resistance: 330 }, holes: ['c30', 'c36'] },
      { id: 'D1', type: 'led', params: { color: 'red' }, holes: ['e36', 'e38'] },
    ],
    wires: [{ id: 'w1', from: 'a30', to: 'top+22', color: 'red' }],
  }

  // part near the top-left corner → reframe centers near the embossed brand
  const brand = {
    version: 1,
    board: 'standard',
    components: [
      { id: 'R1', type: 'resistor', params: { resistance: 330 }, holes: ['a3', 'a9'] },
    ],
    wires: [{ id: 'w1', from: 'b3', to: 'top+0', color: 'red' }],
  }

  try {
    await shoot(browser, 'board-standard-home', null)
    await shoot(browser, 'board-standard-closeup', macro, {
      clip: { x: 320, y: 180, width: 800, height: 560 },
    })
    await shoot(browser, 'board-brand-closeup', brand, {
      clip: { x: 300, y: 120, width: 840, height: 520 },
    })
    await shoot(browser, 'board-standard-circuit', blinky)
    await shoot(browser, 'board-labxl', { ...labxl }, { reframe: false })
    await shoot(browser, 'board-labxl-circuit', labxl)
    await shoot(browser, 'board-half', half, { reframe: false })
    console.log('board screenshots written to shots/')
  } finally {
    await browser.close()
    server.kill()
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
