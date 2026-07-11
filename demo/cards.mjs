/**
 * Caption + end-card renderer. Renders 1920x1080 transparent PNGs via
 * chromium (no drawtext in this ffmpeg build — and CSS typography is nicer
 * anyway: glass pills, glowing LED dots, SF-style type).
 * Usage: node demo/cards.mjs
 */
import { chromium } from 'playwright'
import { mkdirSync } from 'node:fs'

const ROOT = new globalThis.URL('..', import.meta.url).pathname.replace(/\/$/, '')
const OUT = `${ROOT}/demo/out/cards`
mkdirSync(OUT, { recursive: true })

const FONT = `-apple-system, 'SF Pro Display', 'Helvetica Neue', sans-serif`

/** lower-third glass pill with a glowing LED dot */
const pill = (text, led = '#ffb03a') => `
  <div style="position:absolute;left:0;right:0;bottom:96px;display:flex;justify-content:center">
    <div style="display:flex;align-items:center;gap:22px;padding:26px 44px;
                background:rgba(16,17,20,0.62);border:1.5px solid rgba(255,255,255,0.22);
                border-radius:999px;box-shadow:0 18px 60px rgba(0,0,0,0.55), inset 0 1px 0 rgba(255,255,255,0.25);">
      <span style="width:22px;height:22px;border-radius:50%;background:${led};
                   box-shadow:0 0 18px 4px ${led}AA, inset 0 -2px 4px rgba(0,0,0,0.35)"></span>
      <span style="font:700 54px/1.1 ${FONT};color:#fff;letter-spacing:-0.5px;
                   text-shadow:0 2px 12px rgba(0,0,0,0.5)">${text}</span>
    </div>
  </div>`

/** big centered display caption (hook + drop) */
const display = (text, sub = '') => `
  <div style="position:absolute;left:0;right:0;top:0;bottom:0;display:flex;flex-direction:column;
              align-items:center;justify-content:flex-end;padding-bottom:140px">
    <div style="font:800 96px/1.05 ${FONT};color:#fff;letter-spacing:-2.5px;text-align:center;
                text-shadow:0 4px 18px rgba(0,0,0,0.75),0 24px 90px rgba(0,0,0,0.6)">${text}</div>
    ${sub ? `<div style="font:600 42px/1.2 ${FONT};color:rgba(255,255,255,0.85);margin-top:18px;
                letter-spacing:-0.5px;text-shadow:0 2px 14px rgba(0,0,0,0.8)">${sub}</div>` : ''}
  </div>`

const CARDS = {
  c01_not_a_photo: display('This is not a photo.'),
  c02_live: pill('It&rsquo;s a live circuit. In your browser.', '#4dd06a'),
  c03_parts: pill('Real parts. Hologram previews.', '#5ec8ff'),
  c04_wires: pill('Wires route themselves.', '#ffd23a'),
  c05_alive: display('It&rsquo;s alive.'),
  c06_scope: pill('Built-in scope. Real analog math.', '#ffd23a'),
  c07_describe: pill('Or just describe it&hellip;', '#c792ff'),
  c08_ai: pill('Claude builds it. Machine-verified.', '#c792ff'),
  c09_bench: pill('Need more room? Grow the bench.', '#5ec8ff'),
  c10_date: pill('A working date display. Zero microcontrollers.', '#ff5c49'),
  c11_glass: pill('The UI refracts the scene.', '#8be9fd'),
  c12_pathtraced: display('Path-traced.', 'Yes, in your browser.'),
}

// end card: layered over the blurred converged still in ffmpeg; this PNG is
// the type layer only (transparent bg)
const END_CARD = `
  <div style="position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;background:rgba(8,9,12,0.44)">
    <div style="display:flex;align-items:baseline;gap:6px">
      <span style="font:800 172px/1 ${FONT};color:#fff;letter-spacing:-6px;
                   text-shadow:0 6px 40px rgba(0,0,0,0.7)">ohmlet</span>
      <span style="font:800 100px/1 ${FONT};color:#ffb03a;text-shadow:0 0 34px #ffb03aBB">.io</span>
    </div>
    <div style="font:600 52px/1.2 ${FONT};color:rgba(255,255,255,0.92);margin-top:26px;letter-spacing:-1px;
                text-shadow:0 2px 16px rgba(0,0,0,0.7)">Hardware without the hardware.</div>
    <div style="display:flex;align-items:center;gap:20px;margin-top:64px;padding:22px 42px;
                background:rgba(16,17,20,0.66);border:1.5px solid rgba(255,255,255,0.22);border-radius:999px;
                box-shadow:0 18px 60px rgba(0,0,0,0.5), inset 0 1px 0 rgba(255,255,255,0.25)">
      <span style="width:18px;height:18px;border-radius:50%;background:#ff3b30;
                   box-shadow:0 0 16px 4px #ff3b30AA"></span>
      <span style="font:700 44px/1 ${FONT};color:#fff;letter-spacing:-0.5px">github.com/JENW1N/ohmlet</span>
    </div>
    <div style="font:500 34px/1 ${FONT};color:rgba(255,255,255,0.75);margin-top:30px;letter-spacing:0">
      Free &amp; open source&ensp;&middot;&ensp;runs entirely in your browser</div>
  </div>`

const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } })
for (const [name, html] of Object.entries({ ...CARDS, c13_end: END_CARD })) {
  await page.setContent(
    `<style>html,body{margin:0;background:transparent}</style>
     <div style="position:relative;width:1920px;height:1080px">${html}</div>`,
  )
  await page.waitForTimeout(120)
  await page.screenshot({ path: `${OUT}/${name}.png`, omitBackground: true })
  console.log(`card ${name}`)
}
await browser.close()
