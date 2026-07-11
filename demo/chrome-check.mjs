/** Fast check: pose A with wire-mode armed + DOM chrome hidden (enhanced). */
import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { chromium } from 'playwright'
const ROOT = new globalThis.URL('..', import.meta.url).pathname.replace(/\/$/, '')
const PORT = 4341
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
  localStorage.setItem('bb.renderMode', 'enhanced')
  localStorage.setItem('bb.layout', l)
}, [layout])
await page.goto(`http://localhost:${PORT}/?shotrig`)
await page.waitForFunction(() => typeof globalThis.__shotRig?.setCamera === 'function')
await page.waitForTimeout(2000)
await page.getByRole('tab', { name: 'Wire' }).click()
await page.waitForTimeout(400)
await page.evaluate(() => {
  let el = document.querySelector('canvas')
  while (el && el.parentElement && el !== document.body) {
    for (const sib of el.parentElement.children) {
      if (sib !== el) sib.style.setProperty('display', 'none', 'important')
    }
    el = el.parentElement
  }
})
await page.mouse.move(5, 5)
await page.evaluate(() => globalThis.__shotRig.setCamera(39.4, 10.4, 20.7, 34, 0.5, 8))
await page.waitForTimeout(1200)
await page.screenshot({ path: `${ROOT}/demo/out/chrome_check.png` })
console.log('wrote chrome_check.png')
await browser.close()
try { process.kill(-proc.pid) } catch { proc.kill() }
process.exit(0)
