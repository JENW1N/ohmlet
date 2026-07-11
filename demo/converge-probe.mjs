/** Probe Studio convergence rate at pose A: print samples/target every 15s. */
import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { chromium } from 'playwright'

const ROOT = new globalThis.URL('..', import.meta.url).pathname.replace(/\/$/, '')
const PORT = 4331
const layout = readFileSync(`${ROOT}/examples/date-display.json`, 'utf8')

const proc = spawn('npm', ['run', 'preview', '--', '--port', String(PORT), '--strictPort'],
  { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], detached: true })
await new Promise((res, rej) => {
  proc.stdout.on('data', (d) => String(d).includes('localhost') && res())
  proc.on('exit', () => rej(new Error('preview died')))
})
const browser = await chromium.launch({ headless: false, args: ['--use-angle=metal'] })
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } })
await page.addInitScript(([l]) => {
  localStorage.setItem('bb.onboarded', '1')
  localStorage.setItem('bb.renderMode', 'studio')
  localStorage.setItem('bb.layout', l)
}, [layout])
await page.goto(`http://localhost:${PORT}/?shotrig`)
await page.waitForFunction(() => typeof globalThis.__shotRig?.setCamera === 'function')
await page.waitForTimeout(2200)
await page.evaluate(() => globalThis.__shotRig.setCamera(39.4, 10.4, 20.7, 34, 0.5, 8))
const t0 = Date.now()
for (let i = 0; i < 20; i++) {
  await page.waitForTimeout(15000)
  const p = await page.evaluate(() => globalThis.__shotRig.renderProgress())
  console.log(`${((Date.now() - t0) / 1000).toFixed(0)}s: ${JSON.stringify(p)}`)
  if (p?.converged) break
}
await browser.close()
try { process.kill(-proc.pid) } catch { proc.kill() }
process.exit(0)
