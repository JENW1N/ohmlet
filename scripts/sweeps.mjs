/**
 * Phase-B/C functional sweep (self-asserting; exits non-zero on failure).
 * Covers what scripts/screenshot.mjs does not:
 *   - placing a part wholly on board module 3 (cols > 126) of a 3-wide rig
 *   - wiring across a module seam
 *   - save/load round-trip of the 3-wide rig (autosave → fresh boot)
 *   - undo/redo across a BOARD operation (plus-paddle growth)
 *   - holographic placement ghost in both valid and INVALID states
 *   - routed wire preview vs the committed wire (identical camera framing)
 *   - Phase C: 2-D grid growth via all FOUR "+" paddles (left-growth content
 *     remap verified + visual sanity shot), drag-to-move (single resistor +
 *     a 3-part shift+drag marquee group), rotate-a-DIP-180-before-placing,
 *     instrument bench drag (PSU to the right of the board) + clean wire
 *     exit from its post, occluded-hole hover/click rejection
 * Writes shots/sweep-*.png for visual review.
 *
 * Usage: npm run build && node scripts/sweeps.mjs
 */
import { spawn } from 'node:child_process'
import { chromium } from 'playwright'

const PORT = 4181
const URL = `http://localhost:${PORT}/`
const ROOT = new globalThis.URL('..', import.meta.url).pathname

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

// model geometry (mirrors src/model/breadboard.ts): strip hole x = col, z = ROW_Z
const ROW_Z = { a: 3, b: 4, c: 5, d: 6, e: 7, f: 9, g: 10, h: 11, i: 12, j: 13 }

async function main() {
  const server = await startPreview()
  // ANGLE Metal = the real GPU in headless (matches scripts/modes.mjs and
  // closeups.mjs). The ANGLE-OpenGL fallback corrupts the Enhanced composer
  // the moment hover FX draw (sticky black frames) — a backend artifact that
  // never reproduces on Metal; see the Phase-C verification notes.
  const browser = await chromium.launch({
    args: process.env.MODES_SWIFTSHADER ? [] : ['--use-angle=metal'],
  })
  const failures = []
  try {
    const openWith = async (layoutJson, { w = 1100, h = 800, rig = true } = {}) => {
      const ctx = await browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: 2 })
      const page = await ctx.newPage()
      await page.addInitScript(
        ([l]) => {
          localStorage.setItem('bb.onboarded', '1')
          if (l) localStorage.setItem('bb.layout', l)
          else localStorage.removeItem('bb.layout')
        },
        [layoutJson ?? null],
      )
      await page.goto(rig ? `${URL}?shotrig` : URL)
      await page.waitForSelector('canvas')
      if (rig) await page.waitForFunction(() => typeof window.__shotRig?.setCamera === 'function')
      await settle(page, 1600)
      return { ctx, page }
    }
    const saved = (page) =>
      page.evaluate(() => {
        try {
          return JSON.parse(localStorage.getItem('bb.layout') ?? 'null')
        } catch {
          return null
        }
      })
    // aim the shotrig camera at a strip hole; the viewport center then picks it
    const aimAt = async (page, col, row, dist = 8) => {
      const x = col
      const z = ROW_Z[row]
      await page.evaluate(
        ([a]) => window.__shotRig.setCamera(...a),
        [[x + 0.2 * dist, 1.1 * dist, z + 0.62 * dist, x, 0, z]],
      )
      await settle(page, 350)
    }
    const clickCenter = async (page) => {
      await page.mouse.move(549, 399)
      await page.mouse.move(550, 400)
      await settle(page, 250)
      await page.mouse.click(550, 400)
      await settle(page, 400)
    }
    // --- Phase-C helpers: deterministic world→pixel aiming -------------------
    /** world point → viewport px via the scene's harness projector */
    const proj = async (page, x, y, z) => {
      const p = await page.evaluate(([a]) => window.__shotRig.project(a[0], a[1], a[2]), [[x, y, z]])
      if (!p) throw new Error(`project(${x},${y},${z}) is off-screen`)
      return p
    }
    /** the camera pose overview() parks at (matches its setCamera args) */
    const camOf = (cx, cz, d) => ({ x: cx + 0.2 * d, y: d, z: cz + 0.62 * d })
    const overview = async (page, cx, cz, d) => {
      const c = camOf(cx, cz, d)
      await page.evaluate(([a]) => window.__shotRig.setCamera(...a), [[c.x, c.y, c.z, cx, 0, cz]])
      await settle(page, 350)
    }
    /**
     * Plane point (y=0) under the pixel of elevated world point `pt` for a
     * camera at `cam` — exact perspective continuation of the ray through pt.
     * Lets drags express EXACT plane deltas while grabbing a raised body.
     */
    const planeUnder = (pt, cam) => {
      const s = pt.y / (cam.y - pt.y)
      return { x: pt.x + (pt.x - cam.x) * s, z: pt.z + (pt.z - cam.z) * s }
    }
    const clickPt = async (page, p) => {
      await page.mouse.move(p.x - 1, p.y - 1)
      await page.mouse.move(p.x, p.y)
      await settle(page, 250)
      await page.mouse.click(p.x, p.y)
      await settle(page, 500)
    }
    /** pointer-down at `a`, glide to `b`, release (drives the move gestures) */
    const dragPts = async (page, a, b) => {
      await page.mouse.move(a.x, a.y)
      await settle(page, 200)
      await page.mouse.down()
      const steps = 14
      for (let i = 1; i <= steps; i++) {
        await page.mouse.move(a.x + ((b.x - a.x) * i) / steps, a.y + ((b.y - a.y) * i) / steps)
        await page.waitForTimeout(30)
      }
      await settle(page, 350)
      await page.mouse.up()
      await settle(page, 800)
    }

    // ---- 1+2+3: parts on module 3, wire across the seam, round-trip -------
    {
      const seed = JSON.stringify({ version: 1, name: 'sweep rig', boardCount: 3, components: [], wires: [] })
      const { ctx, page } = await openWith(seed)

      // place a resistor wholly on module 3 (cols 127..189)
      await page.getByRole('tab', { name: 'Parts' }).click()
      await settle(page, 600)
      await page.getByText('Resistor', { exact: true }).first().click()
      await settle(page, 400)
      await page.keyboard.press('Escape') // close the panel
      await settle(page, 400)
      await aimAt(page, 150, 'a')
      await clickCenter(page)
      await aimAt(page, 155, 'a')
      await clickCenter(page)
      await page.keyboard.press('Escape') // leave repeat-placement mode
      await settle(page, 900) // > autosave debounce
      let lay = await saved(page)
      const res = (lay?.components ?? []).find((c) => c.type === 'resistor')
      if (!res || JSON.stringify(res.holes) !== JSON.stringify(['a150', 'a155'])) {
        failures.push(`module-3 placement: expected resistor at a150/a155, got ${JSON.stringify(res?.holes)}`)
      }
      await page.evaluate(() => window.__shotRig.setCamera(152.5 + 4, 7, 3 + 9, 152.5, 0.4, 3.5))
      await settle(page, 500)
      await page.screenshot({ path: `${ROOT}shots/sweep-module3-part.png` })

      // wire across the module-2 | module-3 seam (cols 126|127)
      await page.getByRole('tab', { name: 'Wire' }).click()
      await settle(page, 500)
      await aimAt(page, 120, 'e')
      await clickCenter(page)
      await aimAt(page, 135, 'e')
      await clickCenter(page)
      await page.getByRole('tab', { name: 'Wire' }).click() // disarm
      await settle(page, 900)
      lay = await saved(page)
      const seamWire = (lay?.wires ?? []).find(
        (w) => (w.from === 'e120' && w.to === 'e135') || (w.from === 'e135' && w.to === 'e120'),
      )
      if (!seamWire) {
        failures.push(`seam wire: expected e120→e135, wires = ${JSON.stringify(lay?.wires)}`)
      }
      await page.evaluate(() => window.__shotRig.setCamera(127.5 + 5, 9, 7 + 13, 127.5, 0.4, 7))
      await settle(page, 500)
      await page.screenshot({ path: `${ROOT}shots/sweep-seam-wire.png` })

      // save/load round-trip: boot a fresh page from the autosaved 3-wide rig
      const json = JSON.stringify(lay)
      await ctx.close()
      const { ctx: ctx2, page: page2 } = await openWith(json)
      await settle(page2, 900)
      const lay2 = await saved(page2)
      if ((lay2?.boardCount ?? 1) !== 3) failures.push(`round-trip: boardCount ${lay2?.boardCount} != 3`)
      const res2 = (lay2?.components ?? []).find((c) => c.type === 'resistor')
      if (JSON.stringify(res2?.holes) !== JSON.stringify(['a150', 'a155'])) {
        failures.push(`round-trip: resistor holes ${JSON.stringify(res2?.holes)}`)
      }
      const wire2 = (lay2?.wires ?? []).find(
        (w) => (w.from === 'e120' && w.to === 'e135') || (w.from === 'e135' && w.to === 'e120'),
      )
      if (!wire2) failures.push('round-trip: seam wire lost')
      await page2.screenshot({ path: `${ROOT}shots/sweep-roundtrip.png` })
      await ctx2.close()
    }

    // ---- 4: undo/redo across a board operation (plus-paddle growth) -------
    {
      const { ctx, page } = await openWith(null, { w: 1440, h: 900, rig: false })
      const boardCount = async () => (await saved(page))?.boardCount ?? 1
      const tapPaddle = async (expect) => {
        const xs = [0.862, 0.84, 0.885, 0.91, 0.815, 0.935]
        const ys = [0.42, 0.46, 0.38, 0.5, 0.34]
        for (const fy of ys) {
          for (const fx of xs) {
            await page.mouse.click(Math.round(fx * 1440), Math.round(fy * 900))
            await settle(page, 800)
            if ((await boardCount()) === expect) {
              await settle(page, 1600)
              return
            }
          }
        }
        throw new Error(`plus paddle not hit (rig still ${await boardCount()}×)`)
      }
      await tapPaddle(2)
      const undoBtn = page.getByRole('button', { name: 'Undo' })
      const redoBtn = page.getByRole('button', { name: 'Redo' })
      if (await undoBtn.isDisabled()) failures.push('board-undo: Undo disabled after paddle growth')
      await undoBtn.click()
      await settle(page, 1900) // module collapse + autosave
      if ((await boardCount()) !== 1) failures.push('board-undo: boardCount still 2 after undo')
      await page.screenshot({ path: `${ROOT}shots/sweep-undo-board.png` })
      await redoBtn.click()
      await settle(page, 1900)
      if ((await boardCount()) !== 2) failures.push('board-undo: redo did not restore 2×')
      await page.screenshot({ path: `${ROOT}shots/sweep-redo-board.png` })
      await ctx.close()
    }

    // ---- 5: holographic ghost valid + INVALID -----------------------------
    {
      const blinky = await import('node:fs').then((fs) =>
        fs.readFileSync(`${ROOT}examples/blinky-555.json`, 'utf8'),
      )
      const { ctx, page } = await openWith(blinky)
      await page.getByRole('tab', { name: 'Parts' }).click()
      await settle(page, 600)
      await page.getByText('Resistor', { exact: true }).first().click()
      await settle(page, 400)
      await page.keyboard.press('Escape')
      await settle(page, 400)
      // valid: hover an empty hole well right of the circuit
      await aimAt(page, 30, 'c', 10)
      await page.mouse.move(549, 399)
      await page.mouse.move(550, 400)
      await settle(page, 800)
      await page.screenshot({ path: `${ROOT}shots/sweep-holo-valid.png` })
      // invalid: hover f10 = NE555 pin 1 (occupied)
      await aimAt(page, 10, 'f', 10)
      await page.mouse.move(549, 399)
      await page.mouse.move(550, 400)
      await settle(page, 800)
      await page.screenshot({ path: `${ROOT}shots/sweep-holo-invalid.png` })
      await ctx.close()
    }

    // ---- 6: routed wire preview vs committed wire (identical close camera) -
    {
      const { ctx, page } = await openWith(null)
      await page.getByRole('tab', { name: 'Wire' }).click()
      await settle(page, 500)
      await aimAt(page, 25, 'c', 9)
      await clickCenter(page) // first endpoint c25
      // identical framing for both shots: aimed at the second endpoint c32,
      // far enough back that c25..c32 both read
      await aimAt(page, 32, 'c', 14)
      await page.mouse.move(549, 399)
      await page.mouse.move(550, 400) // hover c32 → routed preview
      await settle(page, 800)
      await page.screenshot({ path: `${ROOT}shots/sweep-wire-preview.png` })
      await page.mouse.click(550, 400) // commit
      await settle(page, 400)
      await page.mouse.move(980, 120) // park the pointer off the board
      await settle(page, 900)
      await page.screenshot({ path: `${ROOT}shots/sweep-wire-committed.png` })
      const lay = await saved(page)
      const w = (lay?.wires ?? [])[0]
      if ((lay?.wires ?? []).length !== 1 || !w || w.from !== 'c25' || w.to !== 'c32') {
        failures.push(`wire commit: expected exactly c25→c32, got ${JSON.stringify(lay?.wires)}`)
      }
      await ctx.close()
    }

    // ---- 7 (Phase C): 2-D grid growth via the four "+" paddles -------------
    // right → +module · down → +board-row · left → +module AND content remap
    // (+63 cols) · up → +board-row AND content remap (+1 board-row prefix)
    {
      const seed = JSON.stringify({
        version: 1,
        name: 'grid grow',
        components: [
          { id: 'R1', type: 'resistor', params: { resistance: 1000 }, holes: ['c10', 'c15'] },
        ],
        wires: [{ id: 'W1', from: 'e20', to: 'e25', color: 'green' }],
      })
      const { ctx, page } = await openWith(seed, { w: 1280, h: 860 })
      const COLS = 63 // standard preset
      const grid = async () => {
        const lay = await saved(page)
        return { count: lay?.boardCount ?? 1, rows: lay?.boardRows ?? 1, lay }
      }
      const tapGrow = async (dir, expect) => {
        const { count, rows } = await grid()
        const minX = -0.5
        const maxX = COLS * count + 1.5
        const minZ = -1.5
        const maxZ = 18 + (rows - 1) * 19.5 // BOARD_ROW_PITCH (model/breadboard.ts)
        const cx = (minX + maxX) / 2
        const cz = (minZ + maxZ) / 2
        const off = 1.6 + 1.4 // PADDLE_GAP + PADDLE_SIZE / 2 (scene tunables)
        const pos =
          dir === 'right'
            ? [maxX + off, 1.9, cz]
            : dir === 'left'
              ? [minX - off, 1.9, cz]
              : dir === 'up'
                ? [cx, 1.9, minZ - off]
                : [cx, 1.9, maxZ + off]
        await overview(page, cx, cz, Math.max(90, (maxX - minX) * 1.05))
        await clickPt(page, await proj(page, pos[0], pos[1], pos[2]))
        await settle(page, 2400) // drop-in + deferred fly-home + autosave debounce
        const after = await grid()
        if (after.count !== expect.count || after.rows !== expect.rows) {
          failures.push(
            `grow ${dir}: expected ${expect.count}×${expect.rows}, got ${after.count}×${after.rows}`,
          )
        }
      }
      await tapGrow('right', { count: 2, rows: 1 })
      await page.screenshot({ path: `${ROOT}shots/sweep-grow-right.png` })
      await tapGrow('down', { count: 2, rows: 2 })
      await page.screenshot({ path: `${ROOT}shots/sweep-grow-down.png` })
      await tapGrow('left', { count: 3, rows: 2 })
      let lay = (await grid()).lay
      const r1 = (lay?.components ?? []).find((c) => c.id === 'R1')
      if (JSON.stringify(r1?.holes) !== JSON.stringify(['c73', 'c78'])) {
        failures.push(`grow-left remap: R1 ${JSON.stringify(r1?.holes)} != c73/c78`)
      }
      const w1 = (lay?.wires ?? []).find((w) => w.id === 'W1')
      if (w1?.from !== 'e83' || w1?.to !== 'e88') {
        failures.push(`grow-left remap: W1 ${w1?.from}→${w1?.to} != e83→e88`)
      }
      // visual sanity: the content now sits one module in from the NEW left
      // edge (the new empty module is module 1) — close-up on the remapped part
      await overview(page, 78, 6, 42)
      await page.screenshot({ path: `${ROOT}shots/sweep-grow-left.png` })
      await tapGrow('up', { count: 3, rows: 3 })
      lay = (await grid()).lay
      const r1b = (lay?.components ?? []).find((c) => c.id === 'R1')
      if (JSON.stringify(r1b?.holes) !== JSON.stringify(['1:c73', '1:c78'])) {
        failures.push(`grow-up remap: R1 ${JSON.stringify(r1b?.holes)} != 1:c73/1:c78`)
      }
      await page.screenshot({ path: `${ROOT}shots/sweep-grow-up.png` })
      await ctx.close()
    }

    // ---- 8 (Phase C): drag-to-move — one resistor, then a marquee group ----
    {
      const seed = JSON.stringify({
        version: 1,
        components: [
          { id: 'R1', type: 'resistor', params: { resistance: 1000 }, holes: ['c10', 'c15'] },
          { id: 'R2', type: 'resistor', params: { resistance: 2200 }, holes: ['c20', 'c25'] },
          { id: 'R3', type: 'resistor', params: { resistance: 4700 }, holes: ['c30', 'c35'] },
        ],
        wires: [],
      })
      const { ctx, page } = await openWith(seed, { w: 1440, h: 900 })
      const D = 60
      const cam = camOf(22, 7, D)
      await overview(page, 22, 7, D)
      // select R1 by clicking its routed span body (floats ~1.5 over row c)
      const bc1 = { x: 12.5, y: 0.9, z: 5 } // span body floats at ARC_MIN_APEX 0.9
      await clickPt(page, await proj(page, bc1.x, bc1.y, bc1.z))
      // drag the SELECTED body +3 columns and one row down (c → d): pointer
      // plane-delta equals the move delta exactly (planeUnder math)
      const q1 = planeUnder(bc1, cam)
      await dragPts(
        page,
        await proj(page, bc1.x, bc1.y, bc1.z),
        await proj(page, q1.x + 3, 0, q1.z + 1),
      )
      await settle(page, 900)
      let lay = await saved(page)
      const moved = (lay?.components ?? []).find((c) => c.id === 'R1')
      if (JSON.stringify(moved?.holes) !== JSON.stringify(['d13', 'd18'])) {
        failures.push(`drag-move: R1 ${JSON.stringify(moved?.holes)} != d13/d18`)
      }
      await page.screenshot({ path: `${ROOT}shots/sweep-drag-move.png` })

      // clear the selection, then shift+drag a marquee over all three parts
      await clickPt(page, await proj(page, 22, 0, -7)) // empty desk above the rig
      await page.keyboard.down('Shift')
      await dragPts(page, await proj(page, 6, 0, 0.5), await proj(page, 42, 0, 12))
      await page.keyboard.up('Shift')
      await settle(page, 400)
      // group drag: grab R2's body, +2 columns (all three must move together)
      const bc2 = { x: 22.5, y: 0.9, z: 5 }
      const q2 = planeUnder(bc2, cam)
      await dragPts(
        page,
        await proj(page, bc2.x, bc2.y, bc2.z),
        await proj(page, q2.x + 2, 0, q2.z),
      )
      await settle(page, 900)
      lay = await saved(page)
      const holesOf = (id) =>
        JSON.stringify((lay?.components ?? []).find((c) => c.id === id)?.holes)
      if (holesOf('R1') !== JSON.stringify(['d15', 'd20']))
        failures.push(`group move: R1 ${holesOf('R1')} != d15/d20`)
      if (holesOf('R2') !== JSON.stringify(['c22', 'c27']))
        failures.push(`group move: R2 ${holesOf('R2')} != c22/c27`)
      if (holesOf('R3') !== JSON.stringify(['c32', 'c37']))
        failures.push(`group move: R3 ${holesOf('R3')} != c32/c37`)
      await page.screenshot({ path: `${ROOT}shots/sweep-drag-group.png` })
      await ctx.close()
    }

    // ---- 9 (Phase C): rotate a DIP 180 with R before placing ---------------
    {
      const { ctx, page } = await openWith(null)
      await page.getByRole('tab', { name: 'Parts' }).click()
      await settle(page, 600)
      await page.getByText('NE555 timer', { exact: true }).first().click()
      await settle(page, 400)
      await page.keyboard.press('Escape') // close the panel (place mode stays armed)
      await settle(page, 400)
      await page.keyboard.press('r') // DIP rotation toggles 0 ↔ 180
      await settle(page, 300)
      await aimAt(page, 20, 'f', 10)
      await page.mouse.move(549, 399)
      await page.mouse.move(550, 400)
      await settle(page, 800)
      await page.screenshot({ path: `${ROOT}shots/sweep-rotate-ghost.png` })
      await page.mouse.click(550, 400)
      await settle(page, 1000)
      const lay = await saved(page)
      const u1 = (lay?.components ?? []).find((c) => c.type === 'ne555')
      if (!u1 || u1.at !== 'f20' || u1.rotation !== 180) {
        failures.push(`rotate-place: expected ne555 at f20 rotation 180, got ${JSON.stringify(u1)}`)
      }
      await page.screenshot({ path: `${ROOT}shots/sweep-rotate-dip.png` })
      await ctx.close()
    }

    // ---- 10 (Phase C): PSU bench drag to the right + clean wire exit -------
    {
      const seed = JSON.stringify({
        version: 1,
        components: [{ id: 'PS1', type: 'power_supply', params: { voltage: 5 } }],
        wires: [],
      })
      const { ctx, page } = await openWith(seed, { w: 1440, h: 900 })
      const D = 110
      const cam = camOf(30, 8, D)
      await overview(page, 30, 8, D)
      // select the PSU enclosure, then drag its bench anchor (-10,0) → (70,8)
      const bc = { x: -6.75, y: 1.4, z: -0.4 }
      await clickPt(page, await proj(page, bc.x, bc.y, bc.z))
      const q0 = planeUnder(bc, cam)
      await dragPts(
        page,
        await proj(page, bc.x, bc.y, bc.z),
        await proj(page, q0.x + 80, 0, q0.z + 8),
      )
      await settle(page, 1000)
      let lay = await saved(page)
      const ps = (lay?.components ?? []).find((c) => c.id === 'PS1')
      if (!ps?.pos || ps.pos.x !== 70 || ps.pos.z !== 8) {
        failures.push(`instrument drag: PS1.pos ${JSON.stringify(ps?.pos)} != {x:70,z:8}`)
      }
      // wire from the + post (now at plan 72,10) to j55 — the routed exit must
      // run AWAY from the enclosure face before arcing to the board
      await page.getByRole('tab', { name: 'Wire' }).click()
      await settle(page, 500)
      await overview(page, 62, 10, 40)
      await clickPt(page, await proj(page, 72, 0.5, 10)) // PS1:+ post
      await aimAt(page, 55, 'j', 10)
      await clickCenter(page)
      await page.getByRole('tab', { name: 'Wire' }).click() // disarm
      await settle(page, 900)
      lay = await saved(page)
      const w = (lay?.wires ?? []).find((x) => x.from === 'PS1:+' || x.to === 'PS1:+')
      if (!w) {
        failures.push(`instrument wire: no wire on PS1:+ — ${JSON.stringify(lay?.wires)}`)
      }
      await page.evaluate(() => window.__shotRig.setCamera(76, 6, 20, 71, 0.8, 9))
      await settle(page, 600)
      await page.screenshot({ path: `${ROOT}shots/sweep-psu-exit.png` })
      await ctx.close()
    }

    // ---- 11 (Phase C): occluded-hole rejection (pot body overhang) ---------
    {
      const seed = JSON.stringify({
        version: 1,
        components: [{ id: 'RV1', type: 'potentiometer', holes: ['a8', 'a9', 'a10'] }],
        wires: [],
      })
      const { ctx, page } = await openWith(seed)
      await page.getByRole('tab', { name: 'Wire' }).click()
      await settle(page, 500)
      // b9 sits under RV1's molded body: hover shows the red locked chip, no ring…
      await aimAt(page, 9, 'b', 8)
      await page.mouse.move(549, 399)
      await page.mouse.move(550, 400)
      await settle(page, 800)
      await page.screenshot({ path: `${ROOT}shots/sweep-occluded-hover.png` })
      // …and the wire click is rejected — but never SILENTLY: the occlusion
      // toast must explain why, naming the covering part (scene
      // onHoleOcclusionRejected → App toast)
      await page.mouse.click(550, 400)
      await settle(page, 400)
      try {
        await page
          .getByText(/covered by RV1/)
          .first()
          .waitFor({ state: 'visible', timeout: 2500 })
        await page.screenshot({ path: `${ROOT}shots/sweep-occluded-toast.png` })
      } catch (err) {
        failures.push(`occlusion: rejection toast naming RV1 never appeared (${err.message})`)
      }
      await aimAt(page, 9, 'd', 8)
      await clickCenter(page)
      await aimAt(page, 12, 'd', 8)
      await clickCenter(page)
      await page.getByRole('tab', { name: 'Wire' }).click() // disarm
      await settle(page, 900)
      const lay = await saved(page)
      const wires = lay?.wires ?? []
      if (wires.some((w) => w.from === 'b9' || w.to === 'b9')) {
        failures.push(`occlusion: a wire endpoint landed on covered b9: ${JSON.stringify(wires)}`)
      }
      const good = wires.find(
        (w) => (w.from === 'd9' && w.to === 'd12') || (w.from === 'd12' && w.to === 'd9'),
      )
      if (!good || wires.length !== 1) {
        failures.push(`occlusion: expected exactly d9→d12, got ${JSON.stringify(wires)}`)
      }
      await ctx.close()
    }

    // ---- 11b (Phase C): additive multi-select — shift+click EXTENDS the
    // selection to 2+ parts (toggleSelect path; pill appears) ---------------
    {
      const seed = JSON.stringify({
        version: 1,
        components: [
          { id: 'R1', type: 'resistor', params: { resistance: 1000 }, holes: ['c10', 'c15'] },
          { id: 'R2', type: 'resistor', params: { resistance: 2200 }, holes: ['c20', 'c25'] },
        ],
        wires: [],
      })
      const { ctx, page } = await openWith(seed, { w: 1440, h: 900 })
      await overview(page, 20, 5, 44)
      await clickPt(page, await proj(page, 12.5, 0.7, 5)) // select R1 (replace)
      await page.keyboard.down('Shift')
      await clickPt(page, await proj(page, 22.5, 0.7, 5)) // shift+click EXTENDS to R2
      await page.keyboard.up('Shift')
      await settle(page, 500)
      try {
        await page
          .getByRole('button', { name: 'Delete 2 selected parts' })
          .waitFor({ state: 'visible', timeout: 3000 })
        await page.screenshot({ path: `${ROOT}shots/sweep-multiselect-shiftclick.png` })
      } catch (err) {
        failures.push(`multi-select: shift+click never built a 2-selection (${err.message})`)
      }
      await ctx.close()
    }
    // ---- 12 (Phase C verification): left-growth undo byte-identical ·
    // move undo (single + group) · marquee + pill delete (one undo step) ----
    {
      const seed = JSON.stringify({
        version: 1,
        components: [
          { id: 'R1', type: 'resistor', params: { resistance: 1000 }, holes: ['c10', 'c15'] },
          { id: 'R2', type: 'resistor', params: { resistance: 2200 }, holes: ['c20', 'c25'] },
          { id: 'R3', type: 'resistor', params: { resistance: 4700 }, holes: ['c30', 'c35'] },
        ],
        wires: [],
      })
      const { ctx, page } = await openWith(seed, { w: 1440, h: 900 })
      const rawSave = () => page.evaluate(() => localStorage.getItem('bb.layout'))
      const undoBtn = page.getByRole('button', { name: 'Undo' })

      // (a) grow LEFT via its paddle, then undo → BYTE-identical autosave
      const before = await rawSave()
      {
        const minX = -0.5
        const maxX = 63 + 1.5
        const cz = (-1.5 + 18) / 2
        await overview(page, (minX + maxX) / 2, cz, 90)
        await clickPt(page, await proj(page, minX - 3.0, 1.9, cz))
        await settle(page, 2200) // spring-in + autosave debounce
      }
      let lay = await saved(page)
      if ((lay?.boardCount ?? 1) !== 2) {
        failures.push(`verify-12a: left paddle did not grow (boardCount ${lay?.boardCount})`)
      }
      const r1grown = (lay?.components ?? []).find((c) => c.id === 'R1')
      if (JSON.stringify(r1grown?.holes) !== JSON.stringify(['c73', 'c78'])) {
        failures.push(`verify-12a: grow-left remap R1 ${JSON.stringify(r1grown?.holes)} != c73/c78`)
      }
      await undoBtn.click()
      await settle(page, 2000) // module collapse + autosave debounce
      const after = await rawSave()
      if (after !== before) {
        failures.push(
          `verify-12a: left-growth undo not byte-identical\n    before: ${before}\n    after:  ${after}`,
        )
      }

      // (b) single move +3 cols/+1 row, then undo restores the original holes
      const D = 60
      const cam = camOf(22, 7, D)
      await overview(page, 22, 7, D)
      const bc1 = { x: 12.5, y: 0.9, z: 5 }
      await clickPt(page, await proj(page, bc1.x, bc1.y, bc1.z))
      const q1 = planeUnder(bc1, cam)
      await dragPts(
        page,
        await proj(page, bc1.x, bc1.y, bc1.z),
        await proj(page, q1.x + 3, 0, q1.z + 1),
      )
      await settle(page, 900)
      const holesOf = (l, id) =>
        JSON.stringify((l?.components ?? []).find((c) => c.id === id)?.holes)
      lay = await saved(page)
      if (holesOf(lay, 'R1') !== JSON.stringify(['d13', 'd18'])) {
        failures.push(`verify-12b: single move R1 ${holesOf(lay, 'R1')} != d13/d18`)
      }
      await undoBtn.click()
      await settle(page, 1000)
      lay = await saved(page)
      if (holesOf(lay, 'R1') !== JSON.stringify(['c10', 'c15'])) {
        failures.push(`verify-12b: move undo R1 ${holesOf(lay, 'R1')} != c10/c15`)
      }

      // (c) marquee-select all three, group-drag +2 cols, undo restores all
      await clickPt(page, await proj(page, 22, 0, -7)) // deselect on empty desk
      await page.keyboard.down('Shift')
      await dragPts(page, await proj(page, 6, 0, 0.5), await proj(page, 42, 0, 12))
      await page.keyboard.up('Shift')
      await settle(page, 400)
      const bc2 = { x: 22.5, y: 0.9, z: 5 }
      const q2 = planeUnder(bc2, cam)
      await dragPts(
        page,
        await proj(page, bc2.x, bc2.y, bc2.z),
        await proj(page, q2.x + 2, 0, q2.z),
      )
      await settle(page, 900)
      lay = await saved(page)
      if (holesOf(lay, 'R2') !== JSON.stringify(['c22', 'c27'])) {
        failures.push(`verify-12c: group move R2 ${holesOf(lay, 'R2')} != c22/c27`)
      }
      await undoBtn.click()
      await settle(page, 1000)
      lay = await saved(page)
      for (const [id, holes] of [
        ['R1', ['c10', 'c15']],
        ['R2', ['c20', 'c25']],
        ['R3', ['c30', 'c35']],
      ]) {
        if (holesOf(lay, id) !== JSON.stringify(holes)) {
          failures.push(`verify-12c: group-move undo ${id} ${holesOf(lay, id)} != ${holes}`)
        }
      }

      // (d) marquee again → pill "Delete 3 selected parts" → all gone, ONE undo
      await page.keyboard.down('Shift')
      await dragPts(page, await proj(page, 6, 0, 0.5), await proj(page, 42, 0, 12))
      await page.keyboard.up('Shift')
      await settle(page, 500)
      const delBtn = page.getByRole('button', { name: 'Delete 3 selected parts' })
      try {
        await delBtn.waitFor({ state: 'visible', timeout: 3000 })
        await page.screenshot({ path: `${ROOT}shots/sweep-pill-delete.png` })
        await delBtn.click()
        await settle(page, 1000)
        lay = await saved(page)
        if ((lay?.components ?? []).length !== 0) {
          failures.push(`verify-12d: pill delete left ${(lay?.components ?? []).length} parts`)
        }
        await undoBtn.click()
        await settle(page, 1000)
        lay = await saved(page)
        if ((lay?.components ?? []).length !== 3) {
          failures.push(
            `verify-12d: delete undo restored ${(lay?.components ?? []).length}/3 parts`,
          )
        }
      } catch (err) {
        failures.push(`verify-12d: selection pill delete button never appeared (${err.message})`)
      }
      await ctx.close()
    }

    // ---- 13 (Phase C verification): invalid-90 rotation teaching toast ----
    {
      const { ctx, page } = await openWith(null)
      await page.getByRole('tab', { name: 'Parts' }).click()
      await settle(page, 600)
      await page.getByText('Pushbutton', { exact: false }).first().click()
      await settle(page, 400)
      await page.keyboard.press('Escape') // close the panel, stay armed
      await settle(page, 400)
      // hover j20, then cycle to 90 — the rotated footprint runs off the
      // strip rows there, so the teaching toast must fire (validator text)
      await aimAt(page, 20, 'j', 10)
      await page.mouse.move(549, 399)
      await page.mouse.move(550, 400)
      await settle(page, 500)
      await page.keyboard.press('r')
      const toast = page.locator('.lg-toast')
      try {
        await toast.first().waitFor({ state: 'visible', timeout: 2500 })
        const text = (await toast.first().innerText()).trim()
        console.log('rotation teaching toast:', text)
        await page.screenshot({ path: `${ROOT}shots/sweep-rotate-teaching.png` })
        if (!/pushbutton/i.test(text)) {
          failures.push(`verify-13: teaching toast text lacks the part label: "${text}"`)
        }
        if (/ids must start/i.test(text)) {
          failures.push(`verify-13: toast shows the probe-id artifact, not the real reason: "${text}"`)
        }
      } catch {
        failures.push('verify-13: invalid-90 teaching toast never appeared')
      }
      await ctx.close()
    }

    // ---- 14 (Phase C verification): render-mode switching mid-sim ---------
    {
      const blinky = await import('node:fs').then((fs) =>
        fs.readFileSync(`${ROOT}examples/blinky-555.json`, 'utf8'),
      )
      const { ctx, page } = await openWith(blinky, { w: 1440, h: 900 })
      await page.getByRole('button', { name: 'Run simulation' }).click()
      await settle(page, 800)
      const pause = page.getByRole('button', { name: 'Pause simulation' })
      if (!(await pause.isVisible())) failures.push('verify-14: sim did not start')
      // switch Performance ↔ Enhanced from the More sheet WHILE running
      // (Performance FIRST: the desktop auto-default already shows Enhanced
      // selected, and clicking the selected segment is a no-op)
      await page.getByRole('tab', { name: 'More' }).click()
      await settle(page, 800)
      await page.getByRole('radio', { name: 'Performance' }).click()
      await settle(page, 1200)
      let mode = await page.evaluate(() => localStorage.getItem('bb.renderMode'))
      if (mode !== 'performance') failures.push(`verify-14: mode ${mode} != performance`)
      await page.getByRole('radio', { name: 'Enhanced' }).click()
      await settle(page, 2500) // lazy composer chunk + HDRI swap mid-sim
      mode = await page.evaluate(() => localStorage.getItem('bb.renderMode'))
      if (mode !== 'enhanced') failures.push(`verify-14: mode ${mode} != enhanced`)
      await page.screenshot({ path: `${ROOT}shots/sweep-midsim-enhanced.png` })
      await page.keyboard.press('Escape')
      await settle(page, 500)
      // the sim must still be running after two pipeline swaps
      if (!(await pause.isVisible())) {
        failures.push('verify-14: sim stopped during render-mode switches')
      }
      await page.screenshot({ path: `${ROOT}shots/sweep-midsim-final.png` })
      await ctx.close()
    }
  } finally {
    await browser.close()
    server.kill()
  }
  if (failures.length) {
    console.error('SWEEP FAILURES:\n' + failures.map((f) => `  - ${f}`).join('\n'))
    process.exit(1)
  }
  console.log('functional sweep passed; shots/sweep-*.png written')
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
