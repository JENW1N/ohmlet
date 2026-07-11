/**
 * Test matrix for canvas capture: which (angle backend, headless) combo
 * records the WebGL canvas instead of black frames.
 * Env: ANGLE=metal|gl  HEADED=1|0  TAG=name
 */
import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { chromium } from 'playwright'

const ROOT = '/Users/john/breadboard-studio'
const OUT = process.env.OUT_DIR ?? '/private/tmp/claude-501/-Users-john-arc/a5b06677-b1c3-4db4-a1f4-93c0ab1ce068/scratchpad/video/raw'
const PORT = Number(process.env.PORT ?? 4311)
const URL = `http://localhost:${PORT}/`
const TAG = process.env.TAG ?? 'test'

function startPreview() {
  const proc = spawn('npm', ['run', 'preview', '--', '--port', String(PORT), '--strictPort'], {
    cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'],
  })
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('preview server timed out')), 15000)
    proc.stdout.on('data', (d) => { if (String(d).includes('localhost')) { clearTimeout(timer); resolve(proc) } })
    proc.on('exit', (code) => reject(new Error(`preview exited early (${code})`)))
  })
}

const layout = readFileSync(`${ROOT}/examples/blinky-555.json`, 'utf8')
const server = await startPreview()
const args = []
if (process.env.ANGLE === 'metal') args.push('--use-angle=metal')
const browser = await chromium.launch({ headless: process.env.HEADED !== '1', args })
try {
  const ctx = await browser.newContext({
    viewport: { width: 1280, height: 720 },
    recordVideo: { dir: OUT, size: { width: 1280, height: 720 } },
  })
  const page = await ctx.newPage()
  await page.addInitScript(([l]) => {
    localStorage.setItem('bb.onboarded', '1')
    localStorage.setItem('bb.layout', l)
    localStorage.setItem('bb.renderMode', 'enhanced')
  }, [layout])
  await page.goto(`${URL}?shotrig`)
  await page.waitForSelector('canvas')
  await page.waitForTimeout(2500)
  await page.keyboard.press('Space')
  await page.waitForTimeout(500)
  const running = await page.getByText('Running').count()
  console.log(`${TAG}: capsule Running visible = ${running > 0}`)
  await page.waitForTimeout(2500)
  const video = page.video()
  await ctx.close()
  const p = await video.path()
  console.log(`${TAG} VIDEO: ${p}`)
} finally {
  await browser.close()
  server.kill()
  process.exit(0)
}
