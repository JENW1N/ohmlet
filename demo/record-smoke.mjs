/**
 * Smoke test: record 6s of blinky-555 running at 1920x1080, prove the
 * recording rig works end to end (server, sim run, webm out).
 */
import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { chromium } from 'playwright'

const ROOT = '/Users/john/breadboard-studio'
const OUT = '/private/tmp/claude-501/-Users-john-arc/a5b06677-b1c3-4db4-a1f4-93c0ab1ce068/scratchpad/video/raw'
const PORT = 4310
const URL = `http://localhost:${PORT}/`

function startPreview() {
  const proc = spawn('npm', ['run', 'preview', '--', '--port', String(PORT), '--strictPort'], {
    cwd: ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('preview server timed out')), 15000)
    proc.stdout.on('data', (d) => {
      if (String(d).includes('localhost')) { clearTimeout(timer); resolve(proc) }
    })
    proc.on('exit', (code) => reject(new Error(`preview exited early (${code})`)))
  })
}

const layout = readFileSync(`${ROOT}/examples/blinky-555.json`, 'utf8')
const server = await startPreview()
const browser = await chromium.launch({ args: ['--use-angle=metal'] })
try {
  const ctx = await browser.newContext({
    viewport: { width: 1920, height: 1080 },
    recordVideo: { dir: OUT, size: { width: 1920, height: 1080 } },
  })
  const page = await ctx.newPage()
  await page.addInitScript(([l]) => {
    localStorage.setItem('bb.onboarded', '1')
    localStorage.setItem('bb.layout', l)
    localStorage.setItem('bb.renderMode', 'enhanced')
  }, [layout])
  await page.goto(`${URL}?shotrig`)
  await page.waitForSelector('canvas')
  await page.waitForFunction(() => typeof window.__shotRig?.setCamera === 'function')
  await page.waitForTimeout(2500)
  await page.keyboard.press('Space') // run the sim
  await page.waitForTimeout(6000)
  await page.keyboard.press('Space') // pause
  const video = page.video()
  await ctx.close()
  const path = await video.path()
  console.log('VIDEO:', path)
} finally {
  await browser.close()
  server.kill()
}
