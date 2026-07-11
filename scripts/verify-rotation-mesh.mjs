/**
 * Adversarial verification harness (temporary): render a 0-rotation and a
 * 180-rotation NE555 plus 0/180 seven-segment displays and screenshot
 * closeups so the notch/dimple/label/digit orientation cues can be inspected.
 *
 * Usage: npm run build && node scripts/verify-rotation-mesh.mjs
 */
import { spawn } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { chromium } from 'playwright'

const PORT = 4191
const URL = `http://localhost:${PORT}/`
const ROOT = new globalThis.URL('..', import.meta.url).pathname

const layout = {
  version: 1,
  name: 'rotation mesh verify',
  description: 'verify-rotation-mesh harness',
  components: [
    { id: 'U1', type: 'ne555', at: 'f10' },
    { id: 'U2', type: 'ne555', at: 'f20', rotation: 180 },
    { id: 'S1', type: 'seven_segment', at: 'f30' },
    { id: 'S2', type: 'seven_segment', at: 'f40', rotation: 180 },
  ],
  wires: [],
}

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

const SHOTS = [
  // [name, camX, camY, camZ, tgtX, tgtY, tgtZ]
  ['verify-rot-dips-both', 16.5, 9, 11, 16.5, 0, 8],
  ['verify-rot-dip-0', 11.5, 4.2, 10.2, 11.5, 0, 8],
  ['verify-rot-dip-180', 21.5, 4.2, 10.2, 21.5, 0, 8],
  ['verify-rot-dip-0-top', 11.5, 6, 8.6, 11.5, 0, 8],
  ['verify-rot-dip-180-top', 21.5, 6, 8.6, 21.5, 0, 8],
  ['verify-rot-7segs-both', 37, 10, 12, 37, 0, 8],
  ['verify-rot-7seg-0-top', 32, 7, 8.6, 32, 0, 8],
  ['verify-rot-7seg-180-top', 42, 7, 8.6, 42, 0, 8],
]

async function main() {
  mkdirSync(`${ROOT}shots`, { recursive: true })
  const server = await startPreview()
  const browser = await chromium.launch({ args: ['--use-angle=metal'] })
  try {
    const ctx = await browser.newContext({
      viewport: { width: 1100, height: 800 },
      deviceScaleFactor: 2,
    })
    const page = await ctx.newPage()
    await page.addInitScript((l) => {
      localStorage.setItem('bb.onboarded', '1')
      localStorage.setItem('bb.layout', l)
      localStorage.setItem('bb.renderMode', 'performance')
    }, JSON.stringify(layout))
    await page.goto(`${URL}?shotrig`)
    await page.waitForSelector('canvas')
    await page.waitForFunction(() => typeof window.__shotRig?.setCamera === 'function')
    await page.waitForTimeout(2000)
    for (const [name, ...cam] of SHOTS) {
      await page.evaluate((c) => window.__shotRig.setCamera(...c), cam)
      await page.waitForTimeout(500)
      await page.screenshot({ path: `${ROOT}shots/${name}.png` })
      console.log(`shot ${name}.png`)
    }
    await ctx.close()
  } finally {
    await browser.close()
    server.kill()
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
