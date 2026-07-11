/**
 * Camera pose scout: screenshot a list of candidate poses for an example
 * layout so the editor can pick hero angles.
 * Usage: node pose-scout.mjs <example.json> <outdir> "px,py,pz,tx,ty,tz" ...
 */
import { spawn } from 'node:child_process'
import { readFileSync, mkdirSync } from 'node:fs'
import { chromium } from 'playwright'

const ROOT = '/Users/john/breadboard-studio'
const PORT = 4312
const URL = `http://localhost:${PORT}/`
const [example, outdir, ...poses] = process.argv.slice(2)
mkdirSync(outdir, { recursive: true })

function startPreview() {
  const proc = spawn('npm', ['run', 'preview', '--', '--port', String(PORT), '--strictPort'], {
    cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'],
  })
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('preview timed out')), 15000)
    proc.stdout.on('data', (d) => { if (String(d).includes('localhost')) { clearTimeout(timer); resolve(proc) } })
    proc.on('exit', (code) => reject(new Error(`preview exited early (${code})`)))
  })
}

const layout = readFileSync(`${ROOT}/examples/${example}`, 'utf8')
const server = await startPreview()
const browser = await chromium.launch({ headless: false, args: ['--use-angle=metal'] })
try {
  const ctx = await browser.newContext({ viewport: { width: 1920, height: 1080 } })
  const page = await ctx.newPage()
  await page.addInitScript(([l]) => {
    localStorage.setItem('bb.onboarded', '1')
    localStorage.setItem('bb.layout', l)
    localStorage.setItem('bb.renderMode', 'enhanced')
  }, [layout])
  await page.goto(`${URL}?shotrig`)
  await page.waitForSelector('canvas')
  await page.waitForFunction(() => typeof window.__shotRig?.setCamera === 'function')
  await page.waitForTimeout(2600)
  for (let i = 0; i < poses.length; i++) {
    const cam = poses[i].split(',').map(Number)
    await page.evaluate((c) => window.__shotRig.setCamera(...c), cam)
    await page.waitForTimeout(700)
    await page.screenshot({ path: `${outdir}/pose_${String(i).padStart(2, '0')}.png` })
    console.log(`pose_${String(i).padStart(2, '0')}: ${poses[i]}`)
  }
} finally {
  await browser.close()
  server.kill()
  process.exit(0)
}
