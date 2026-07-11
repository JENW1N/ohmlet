/**
 * One-off: shots/liquid-glass-hero.png — phone framing with the dense
 * date-display board rising behind BOTH the status capsule and the dock,
 * so their displacement lenses visibly bend rails/wires/holes.
 * Camera pose via HERO_CAM="px,py,pz,tx,ty,tz".
 */
import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { chromium } from 'playwright'

const PORT = 4179
const URL = `http://localhost:${PORT}/`
const ROOT = new globalThis.URL('..', import.meta.url).pathname.replace(/\/$/, '')
const CAM = (process.env.HERO_CAM ?? '32,22,26,32,0,6').split(',').map(Number)
const OUT = process.env.HERO_OUT ?? `${ROOT}/shots/liquid-glass-hero.png`

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

const layout = readFileSync(`${ROOT}/examples/date-display.json`, 'utf8')
const server = await startPreview()
const browser = await chromium.launch({ args: ['--use-angle=metal'] })
try {
  const ctx = await browser.newContext({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 3,
    isMobile: true,
    hasTouch: true,
  })
  const page = await ctx.newPage()
  await page.addInitScript(
    ([l]) => {
      localStorage.setItem('bb.onboarded', '1')
      localStorage.setItem('bb.layout', l)
    },
    [layout],
  )
  await page.goto(`${URL}?shotrig`)
  await page.waitForSelector('canvas')
  await page.waitForFunction(() => typeof window.__shotRig?.setCamera === 'function')
  await page.waitForTimeout(2200) // boot + lens arm + tone settle
  const lensOn = await page.evaluate(() =>
    document.documentElement.classList.contains('lg-lens-on'),
  )
  if (!lensOn) throw new Error('lens did not arm')
  await page.evaluate((cam) => window.__shotRig.setCamera(...cam), CAM)
  await page.waitForTimeout(1400) // tone re-sample + specular settle
  await page.screenshot({ path: OUT })
  console.log(`wrote ${OUT} (cam ${CAM.join(',')})`)
} finally {
  await browser.close()
  server.kill()
}
