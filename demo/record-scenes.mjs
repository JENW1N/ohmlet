/**
 * Demo-video scene recorder. Each scene records its own webm clip (headed
 * chromium — headless screencasts drop the WebGL canvas) plus stills where
 * needed. Run: node demo/record-scenes.mjs <scene> [<scene> ...] | all
 *
 * Scenes: converge live_reveal build wires run_blink scope ai bench
 *         date_orbit lens
 */
import { spawn } from 'node:child_process'
import { readFileSync, writeFileSync, mkdirSync, renameSync } from 'node:fs'
import { chromium } from 'playwright'

const ROOT = new globalThis.URL('..', import.meta.url).pathname.replace(/\/$/, '')
const OUT = process.env.OUT_DIR ?? `${ROOT}/demo/out`
const PORT = Number(process.env.PORT ?? 4320)
const URL_ = `http://localhost:${PORT}/`
const W = 1920, H = 1080

const POSE_A = [39.4, 10.4, 20.7, 34, 0.5, 8] // date-display digits macro

mkdirSync(OUT, { recursive: true })

function startPreview() {
  const proc = spawn('npm', ['run', 'preview', '--', '--port', String(PORT), '--strictPort'], {
    cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], detached: true,
  })
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('preview timed out')), 15000)
    proc.stdout.on('data', (d) => { if (String(d).includes('localhost')) { clearTimeout(timer); resolve(proc) } })
    proc.on('exit', (code) => reject(new Error(`preview exited early (${code})`)))
  })
}

const readExample = (name) => readFileSync(`${ROOT}/examples/${name}`, 'utf8')
const readDemo = (name) => readFileSync(`${ROOT}/demo/${name}`, 'utf8')

// strip hole ref -> world plan coords (model/breadboard.ts ROW_Z / RAIL_Z)
const ROW_Z = { a: 3, b: 4, c: 5, d: 6, e: 7, f: 9, g: 10, h: 11, i: 12, j: 13 }
const RAIL_Z = { 'top+': 0, 'top-': 1, 'bot-': 15, 'bot+': 16 }
function holeWorld(ref) {
  const rail = ref.match(/^(top\+|top-|bot\+|bot-)(\d+)$/)
  if (rail) {
    const idx = Number(rail[2])
    return { x: 2.5 + idx + Math.floor(idx / 5), y: 0, z: RAIL_Z[rail[1]] }
  }
  const m = ref.match(/^([a-j])(\d+)$/)
  if (!m) throw new Error(`bad hole ref ${ref}`)
  return { x: Number(m[2]), y: 0, z: ROW_Z[m[1]] }
}

/** client px of a hole via the shotrig projector */
async function holePx(page, ref) {
  const w = holeWorld(ref)
  const p = await page.evaluate(({ x, y, z }) => globalThis.__shotRig.project(x, y, z), w)
  if (!p) throw new Error(`hole ${ref} off-screen`)
  return p
}

/** smooth eased camera glide inside the page's own rAF loop */
async function glide(page, from, to, ms, ease = 'inout') {
  await page.evaluate(async ({ from, to, ms, ease }) => {
    const rig = globalThis.__shotRig
    const fns = {
      inout: (t) => (t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2),
      out: (t) => 1 - (1 - t) ** 3,
      linear: (t) => t,
    }
    const f = fns[ease]
    const t0 = performance.now()
    await new Promise((res) => {
      const step = () => {
        const p = Math.min(1, (performance.now() - t0) / ms)
        const e = f(p)
        rig.setCamera(...from.map((v, i) => v + (to[i] - v) * e))
        if (p < 1) requestAnimationFrame(step)
        else res()
      }
      step()
    })
  }, { from, to, ms, ease })
}

const HIDE_CHROME = '.app-root > *:not(.app-canvas) { display: none !important; }'
const HIDE_EMPTY = '.app-root [class*="empty" i] { display: none !important; }'

const ALL_MARKS = {}

async function openScene(browser, { layout, mode = 'enhanced', css, apiKey, beforeGoto }) {
  const ctxCreatedAt = Date.now()
  const ctx = await browser.newContext({
    viewport: { width: W, height: H },
    recordVideo: { dir: OUT, size: { width: W, height: H } },
  })
  const page = await ctx.newPage()
  await page.addInitScript(([l, m, k]) => {
    localStorage.setItem('bb.onboarded', '1')
    localStorage.setItem('bb.renderMode', m)
    if (l) localStorage.setItem('bb.layout', l)
    else localStorage.removeItem('bb.layout')
    if (k) localStorage.setItem('bb.apiKey', k)
  }, [layout ?? null, mode, apiKey ?? null])
  if (beforeGoto) await beforeGoto(page)
  await page.goto(`${URL_}?shotrig`)
  await page.waitForSelector('canvas')
  await page.waitForFunction(() => typeof globalThis.__shotRig?.setCamera === 'function')
  if (css) await page.addStyleTag({ content: css })
  await page.waitForTimeout(2200)
  const t0 = Date.now()
  const marks = { boot: (t0 - ctxCreatedAt) / 1000 }
  const mark = (label) => {
    marks[label] = (Date.now() - t0) / 1000
    console.log(`  MARK ${label} ${marks[label].toFixed(2)}s`)
  }
  return { ctx, page, t0, mark, marks }
}

async function closeScene(ctx, page, name, marks) {
  const video = page.video()
  await ctx.close()
  const p = await video.path()
  renameSync(p, `${OUT}/${name}.webm`)
  if (marks) ALL_MARKS[name] = marks
  console.log(`scene ${name}: ${OUT}/${name}.webm`)
}

// ---------------------------------------------------------------------------
const scenes = {
  /** S12 (+S1 still): Studio path-trace convergence at pose A, no chrome */
  async converge(browser) {
    const { ctx, page, mark, marks } = await openScene(browser, {
      layout: readExample('date-display.json'), mode: 'studio', css: HIDE_CHROME,
    })
    await page.evaluate((c) => globalThis.__shotRig.setCamera(...c), POSE_A)
    await page.waitForTimeout(600) // camera move resets accumulation; noise visible
    const t0 = Date.now()
    await page.waitForFunction(
      () => globalThis.__shotRig?.renderProgress()?.converged === true,
      null, { timeout: 600000, polling: 250 },
    )
    mark('converged')
    console.log(`  converged in ${((Date.now() - t0) / 1000).toFixed(1)}s`)
    await page.waitForTimeout(1200) // hold the still
    await page.screenshot({ path: `${OUT}/still_pose_a.png` }) // S1 source
    await closeScene(ctx, page, 'converge', marks)
  },

  /** S2: same pose, live enhanced render, sim running, orbit drag proof */
  async live_reveal(browser) {
    const { ctx, page, mark, marks } = await openScene(browser, {
      layout: readExample('date-display.json'), mode: 'enhanced',
    })
    await page.evaluate((c) => globalThis.__shotRig.setCamera(...c), POSE_A)
    mark('camera')
    await page.waitForTimeout(500)
    await page.keyboard.press('Space') // run — digits tick
    mark('run')
    await page.waitForTimeout(1500)
    // gentle orbit drag: prove it is a live 3D scene
    mark('drag')
    await page.mouse.move(1350, 700)
    await page.mouse.down()
    await page.mouse.move(1240, 655, { steps: 45 })
    await page.mouse.up()
    await page.waitForTimeout(1400)
    await closeScene(ctx, page, 'live_reveal', marks)
  },

  /** S3: hologram placement — 555, then LED, then resistor */
  async build(browser) {
    const { ctx, page, mark, marks } = await openScene(browser, { css: HIDE_EMPTY })
    // closeup on the placement area (cols ~10-25)
    await page.evaluate(() => globalThis.__shotRig.setCamera(25, 9, 19, 16, 0, 8.5))
    mark('camera')
    await page.waitForTimeout(400)

    const place = async (partText, refs, { hoverMs = 900 } = {}) => {
      await page.getByRole('tab', { name: 'Parts' }).click()
      await page.waitForTimeout(650)
      await page.getByText(partText, { exact: true }).first().click()
      await page.waitForTimeout(350)
      await page.keyboard.press('Escape') // close panel, keep place mode
      await page.waitForTimeout(300)
      for (let i = 0; i < refs.length; i++) {
        const px = await holePx(page, refs[i])
        // drift toward the hole so the hologram ghost tracks on camera
        await page.mouse.move(px.x - 120, px.y + 60)
        await page.waitForTimeout(200)
        await page.mouse.move(px.x, px.y, { steps: 30 })
        await page.waitForTimeout(i === 0 ? hoverMs : 500)
        await page.mouse.click(px.x, px.y)
        await page.waitForTimeout(350)
      }
      await page.keyboard.press('Escape') // leave repeat placement
      await page.waitForTimeout(250)
    }

    mark('place555')
    await place('NE555 timer', ['f15'], { hoverMs: 1100 })
    mark('placeLED')
    await place('LED', ['h18', 'h21'])
    mark('placeR')
    await place('Resistor', ['c15', 'c19'])
    await page.waitForTimeout(700)
    await closeScene(ctx, page, 'build', marks)
  },

  /** S4: wire mode — routed previews snake, commit with color pop */
  async wires(browser) {
    const { ctx, page, mark, marks } = await openScene(browser, { layout: readDemo('blinky-partial.json') })
    await page.evaluate(() => globalThis.__shotRig.setCamera(26, 12, 24, 14, 0, 7))
    await page.waitForTimeout(400)
    await page.getByRole('tab', { name: 'Wire' }).click()
    await page.waitForTimeout(600)

    const wire = async (fromRef, toRef) => {
      const a = await holePx(page, fromRef)
      const b = await holePx(page, toRef)
      await page.mouse.move(a.x - 80, a.y + 40)
      await page.mouse.move(a.x, a.y, { steps: 20 })
      await page.waitForTimeout(250)
      await page.mouse.click(a.x, a.y)
      await page.waitForTimeout(300)
      await page.mouse.move(b.x, b.y, { steps: 55 }) // preview snakes along
      await page.waitForTimeout(650)
      await page.mouse.click(b.x, b.y)
      await page.waitForTimeout(500)
    }

    mark('wire1')
    await wire('g11', 'c12') // the 555 feedback wire (routes around the chip)
    mark('wire2')
    await wire('g13', 'top+2') // out to the + rail
    await page.waitForTimeout(600)
    await closeScene(ctx, page, 'wires', marks)
  },

  /** S5: hit run — LED blinks at ~0.99 Hz (117 BPM downbeats) */
  async run_blink(browser) {
    const { ctx, page, mark, marks } = await openScene(browser, { layout: readDemo('blinky-beat.json') })
    // frame the LED (h15..top-3 area) close
    await page.evaluate(() => globalThis.__shotRig.setCamera(22, 8, 16, 14, 0.5, 6))
    mark('camera')
    await page.waitForTimeout(800)
    await page.keyboard.press('Space')
    mark('run')
    await page.waitForTimeout(7000) // ~7 blinks
    await closeScene(ctx, page, 'run_blink', marks)
  },

  /** S6: oscilloscope over the running blinker */
  async scope(browser) {
    const { ctx, page, mark, marks } = await openScene(browser, { layout: readDemo('blinky-beat.json') })
    await page.evaluate(() => globalThis.__shotRig.setCamera(24, 10, 20, 15, 0.5, 7))
    mark('camera')
    await page.waitForTimeout(500)
    await page.keyboard.press('Space')
    mark('run')
    await page.waitForTimeout(1200)
    await page.getByRole('tab', { name: 'Scope' }).click()
    mark('scope')
    await page.waitForTimeout(5000) // waveform scrolls
    await closeScene(ctx, page, 'scope', marks)
  },

  /** S7+S8: AI sheet — typed prompt, mocked Claude, real verify, apply, run */
  async ai(browser) {
    const envelope = readDemo('mock-envelope.json')
    const sse = (() => {
      const chunks = []
      const text = envelope
      const CH = 800
      for (let i = 0; i < text.length; i += CH) chunks.push(text.slice(i, i + CH))
      const ev = (event, data) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
      let body = ev('message_start', {
        type: 'message_start',
        message: {
          id: 'msg_demo', type: 'message', role: 'assistant', content: [],
          model: 'claude-opus-4-8', stop_reason: null, stop_sequence: null,
          usage: { input_tokens: 100, output_tokens: 1 },
        },
      })
      body += ev('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } })
      for (const c of chunks) body += ev('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: c } })
      body += ev('content_block_stop', { type: 'content_block_stop', index: 0 })
      body += ev('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 900 } })
      body += ev('message_stop', { type: 'message_stop' })
      return body
    })()

    const { ctx, page, mark, marks } = await openScene(browser, {
      css: HIDE_EMPTY,
      apiKey: 'sk-ant-demo-000000000000000000000000',
      beforeGoto: async (p) => {
        await p.route('**/v1/messages**', async (route) => {
          if (route.request().method() === 'OPTIONS') {
            return route.fulfill({
              status: 204,
              headers: {
                'access-control-allow-origin': '*',
                'access-control-allow-methods': 'POST, OPTIONS',
                'access-control-allow-headers': '*',
              },
            })
          }
          await new Promise((r) => setTimeout(r, 1600)) // "thinking…" beat
          return route.fulfill({
            status: 200,
            headers: {
              'content-type': 'text/event-stream; charset=utf-8',
              'access-control-allow-origin': '*',
              'access-control-expose-headers': '*',
            },
            body: sse,
          })
        })
      },
    })
    await page.waitForTimeout(300)
    await page.getByRole('tab', { name: 'AI' }).click()
    mark('sheet')
    await page.waitForTimeout(900)
    await page.locator('.asm-textarea').click()
    await page.waitForTimeout(300)
    mark('type')
    await page.keyboard.type('a counter driving a 7-segment display', { delay: 52 })
    await page.waitForTimeout(450)
    mark('generate')
    await page.getByRole('button', { name: /Generate/ }).click()
    // thinking… → designing… → validating → machine-testing → result card
    await page.getByRole('button', { name: 'Apply' }).waitFor({ timeout: 30000 })
    mark('verified')
    await page.waitForTimeout(1400) // hold the verified card
    await page.getByRole('button', { name: 'Apply' }).click()
    mark('apply')
    await page.waitForTimeout(700)
    await page.keyboard.press('Escape') // dismiss the sheet, camera frames circuit
    await page.waitForTimeout(1400)
    await page.keyboard.press('Space') // run — the digit counts
    mark('run')
    await page.waitForTimeout(1200)
    // push in on the 7-segment display (DS1 at f24) for the counting payoff
    mark('pushin')
    await glide(page, [30, 14, 30, 20, 0, 9], [31, 6.5, 15.5, 26, 0.5, 10.5], 2600, 'inout')
    await page.waitForTimeout(2600)
    await closeScene(ctx, page, 'ai', marks)
  },

  /** S9: grow the bench via the "+" paddles (world-space deterministic) */
  async bench(browser) {
    const { ctx, page, mark, marks } = await openScene(browser, { layout: readExample('date-display.json') })
    await page.waitForTimeout(600)
    const COLS = 63
    const paddle = async (dir) => {
      const lay = await page.evaluate(() => JSON.parse(localStorage.getItem('bb.layout') ?? '{}'))
      const count = lay.boardCount ?? 1
      const rows = lay.boardRows ?? 1
      const minX = -0.5, maxX = COLS * count + 1.5, minZ = -1.5, maxZ = 18 + (rows - 1) * 19.5
      const cx = (minX + maxX) / 2, cz = (minZ + maxZ) / 2
      const off = 3.0
      const pos = dir === 'right' ? [maxX + off, 1.9, cz] : [cx, 1.9, maxZ + off]
      const p = await page.evaluate(([x, y, z]) => globalThis.__shotRig.project(x, y, z), pos)
      if (!p) throw new Error('paddle off-screen')
      await page.mouse.click(p.x, p.y)
      await page.waitForTimeout(2600) // drop-in + camera glide home
    }
    mark('grow1')
    await paddle('right') // 2 wide
    mark('grow2')
    await paddle('down') // 2x2
    mark('settle')
    await page.waitForTimeout(1000)
    await closeScene(ctx, page, 'bench', marks)
  },

  /** S10: slow orbit around the running date-display machine */
  async date_orbit(browser) {
    const { ctx, page, mark, marks } = await openScene(browser, { layout: readExample('date-display.json') })
    await page.keyboard.press('Space')
    const a = [52, 16, 30, 32, 0, 8]
    const b = [16, 22, 34, 32, 0, 8]
    await page.evaluate((c) => globalThis.__shotRig.setCamera(...c), a)
    mark('camera')
    await page.waitForTimeout(700)
    mark('orbit')
    await glide(page, a, b, 6000, 'inout')
    await page.waitForTimeout(500)
    await closeScene(ctx, page, 'date_orbit', marks)
  },

  /** S11: liquid-glass lensing — board slides under the scope panel */
  async lens(browser) {
    const { ctx, page, mark, marks } = await openScene(browser, { layout: readExample('date-display.json') })
    await page.keyboard.press('Space')
    await page.waitForTimeout(400)
    await page.getByRole('tab', { name: 'Scope' }).click()
    await page.waitForTimeout(1200)
    const a = [46, 9, 18, 40, 0.5, 8]
    const b = [26, 9, 18, 20, 0.5, 8]
    await page.evaluate((c) => globalThis.__shotRig.setCamera(...c), a)
    mark('camera')
    await page.waitForTimeout(600)
    mark('glide')
    await glide(page, a, b, 5000, 'inout')
    await page.waitForTimeout(600)
    await closeScene(ctx, page, 'lens', marks)
  },
}

// ---------------------------------------------------------------------------
const wanted = process.argv.slice(2)
const names = wanted.length === 0 || wanted[0] === 'all' ? Object.keys(scenes) : wanted
const server = await startPreview()
const browser = await chromium.launch({ headless: false, args: ['--use-angle=metal'] })
let failed = false
try {
  for (const name of names) {
    if (!scenes[name]) throw new Error(`unknown scene ${name}`)
    console.log(`recording ${name}…`)
    await scenes[name](browser)
  }
} catch (err) {
  failed = true
  console.error('RECORD FAILED:', err)
} finally {
  try {
    let prev = {}
    try { prev = JSON.parse(readFileSync(`${OUT}/marks.json`, 'utf8')) } catch {}
    writeFileSync(`${OUT}/marks.json`, JSON.stringify({ ...prev, ...ALL_MARKS }, null, 2))
    console.log('marks.json updated')
  } catch (e) { console.error('marks write failed', e) }
  await browser.close()
  try { process.kill(-server.pid) } catch { server.kill() }
  process.exit(failed ? 1 : 0)
}
