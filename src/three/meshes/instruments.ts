/**
 * Instruments & sounders: off-board power supply / function generator boxes
 * with canvas screens and banana terminals, oscilloscope probe clips, buzzer.
 *
 * Realism notes (judged against bench-instrument reference photos): the boxes
 * are painted-steel enclosures with a brushed-aluminum faceplate (streaked
 * roughness map = anisotropic feel), rubber corner bumpers, a recessed screen
 * behind a slightly reflective glass cover inside a raised bezel, machined
 * binding posts MOUNTED THROUGH the faceplate (hex jam nut flush against the
 * panel, colored insulator barrel, cross-drilled stud whose wire hole IS the
 * terminal attach point), a front-panel knob and printed legends. The scope
 * probe is a grabber clip: molded ribbed boot, channel-colored ID ring and a
 * sprung metal hook curling into the hole.
 */

import * as THREE from 'three'
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js'
import type { ComponentInstance } from '../../model/types'
import type { CatalogEntry } from '../../model/catalog'
import { paramOf } from '../../model/catalog'
import { TERMINAL_TOP_Y } from '../internal/wires'
import {
  BuildResult,
  HOLE_DEPTH,
  cachedGeometry,
  cachedMaterial,
  centroidOf,
  formatHz,
  fromHole,
  labelMaterial,
  legMesh,
  markShared,
  mergeStatic,
  metal,
  nowMs,
  plastic,
} from './shared'

// ---------------------------------------------------------------------------
// Buzzer
// ---------------------------------------------------------------------------

export function buildBuzzer(
  _comp: ComponentInstance,
  _entry: CatalogEntry,
  pins: THREE.Vector3[],
): BuildResult {
  const group = new THREE.Group()
  const c = centroidOf(pins)
  const bodyH = 0.95
  const bodyR = 1.15
  const baseY = 0.18

  const bodyGroup = new THREE.Group()
  bodyGroup.position.set(c.x, baseY + bodyH / 2, c.z)

  const bodyGeo = cachedGeometry('buzzer-body', () => new THREE.CylinderGeometry(bodyR, bodyR, 0.95, 28))
  bodyGroup.add(new THREE.Mesh(bodyGeo, plastic(0x141414, 0.5)))

  // sound hole in the center of the top face
  const holeGeo = cachedGeometry('buzzer-hole', () => new THREE.CylinderGeometry(0.16, 0.16, 0.06, 16))
  const hole = new THREE.Mesh(holeGeo, plastic(0x000000, 0.95))
  hole.position.y = bodyH / 2 + 0.01
  bodyGroup.add(hole)
  group.add(bodyGroup)

  // bent leads connecting each hole to the body (vertical pinLeg stubs used
  // to end mid-air whenever a hole fell outside the r=1.15 footprint): rise
  // out of the hole, run just under the body, then turn up INTO the bottom
  // face so the tube terminates inside it — no orphan stubs, no open seams.
  const runY = 0.12 // horizontal run hugs the body underside (baseY 0.18)
  const entryY = baseY + 0.3 // lead end buried inside the body
  const entryDistMax = bodyR - 0.4 // entry point well inside the footprint
  const legStatics: THREE.Object3D[] = []
  for (const p of pins) {
    const out = new THREE.Vector3(p.x - c.x, 0, p.z - c.z)
    const dist = out.length()
    if (dist <= entryDistMax + 1e-6) {
      // hole already under the body: straight lead up into the bottom face
      legStatics.push(legMesh(fromHole(p, new THREE.Vector3(p.x, entryY, p.z))))
    } else {
      out.multiplyScalar(entryDistMax / dist)
      legStatics.push(
        legMesh(
          fromHole(
            p,
            new THREE.Vector3(p.x, runY, p.z),
            new THREE.Vector3(c.x + out.x, runY, c.z + out.z),
            new THREE.Vector3(c.x + out.x, entryY, c.z + out.z),
          ),
        ),
      )
    }
  }
  // both leads (tubes + caps) fold into one metal mesh (Phase D draw budget)
  for (const m of mergeStatic(legStatics)) group.add(m)

  return {
    object: group,
    pinWorld: pins.map((p) => p.clone()),
    update: (_c2, _e2, telemetry) => {
      if (telemetry?.sounding) {
        const s = 1 + 0.04 * Math.sin(nowMs() * 0.05)
        bodyGroup.scale.setScalar(s)
      } else if (bodyGroup.scale.x !== 1) {
        bodyGroup.scale.setScalar(1)
      }
    },
  }
}

// ---------------------------------------------------------------------------
// Off-board instrument boxes (PSU / function generator)
// ---------------------------------------------------------------------------

const SCREEN_W = 256
const SCREEN_H = 128

/** CRT-ish scanlines over the finished screen image (subtle, every 4px). */
function applyScanlines(ctx: CanvasRenderingContext2D): void {
  ctx.fillStyle = 'rgba(0,0,0,0.16)'
  for (let y = 0; y < SCREEN_H; y += 4) ctx.fillRect(0, y, SCREEN_W, 1)
}

/**
 * Full screen image, INCLUDING all static lettering (instrument name). The
 * name used to be a separate floating text plane in front of the faceplate —
 * coplanar with the screen's top edge, so 'DC POWER' visibly noclipped
 * through the glass. Baked into the same canvas the live values redraw on,
 * it can never clip anything.
 */
function drawScreen(
  ctx: CanvasRenderingContext2D,
  kind: 'psu' | 'fungen',
  comp: ComponentInstance,
  entry: CatalogEntry,
): void {
  ctx.fillStyle = '#08131f'
  ctx.fillRect(0, 0, SCREEN_W, SCREEN_H)
  ctx.strokeStyle = '#1d3a55'
  ctx.lineWidth = 4
  ctx.strokeRect(2, 2, SCREEN_W - 4, SCREEN_H - 4)
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  if (kind === 'psu') {
    ctx.fillStyle = '#3d6e8f'
    ctx.font = 'bold 17px Arial, sans-serif'
    ctx.fillText('DC POWER', SCREEN_W / 2, 19)
    const v = Number(paramOf(comp.params, entry, 'voltage') ?? 5)
    ctx.fillStyle = '#6ee7f0'
    ctx.font = 'bold 52px "Courier New", monospace'
    ctx.fillText(`${v.toFixed(1)} V`, SCREEN_W / 2, 64)
    ctx.fillStyle = '#3d6e8f'
    ctx.font = 'bold 20px Arial, sans-serif'
    ctx.fillText('DC OUTPUT', SCREEN_W / 2, 106)
  } else {
    ctx.fillStyle = '#4a7a3c'
    ctx.font = 'bold 17px Arial, sans-serif'
    ctx.fillText('FUNCTION GEN', SCREEN_W / 2, 19)
    const wf = String(paramOf(comp.params, entry, 'waveform') ?? 'square')
    const fr = Number(paramOf(comp.params, entry, 'frequency') ?? 1)
    ctx.fillStyle = '#9ef07a'
    ctx.font = 'bold 40px "Courier New", monospace'
    ctx.fillText(formatHz(fr), SCREEN_W / 2, 56)
    ctx.fillStyle = '#5f9e4a'
    ctx.font = 'bold 20px Arial, sans-serif'
    ctx.fillText(wf.toUpperCase(), SCREEN_W / 2 + 40, 100)
    // waveform glyph
    ctx.strokeStyle = '#9ef07a'
    ctx.lineWidth = 3
    ctx.beginPath()
    const x0 = 34
    const y0 = 100
    const amp = 14
    const period = 30
    if (wf === 'sine') {
      for (let i = 0; i <= 60; i++) {
        const x = x0 + i
        const y = y0 - Math.sin((i / period) * Math.PI * 2) * amp
        if (i === 0) ctx.moveTo(x, y)
        else ctx.lineTo(x, y)
      }
    } else if (wf === 'triangle') {
      ctx.moveTo(x0, y0)
      ctx.lineTo(x0 + 15, y0 - amp)
      ctx.lineTo(x0 + 45, y0 + amp)
      ctx.lineTo(x0 + 60, y0)
    } else {
      ctx.moveTo(x0, y0 + amp)
      ctx.lineTo(x0, y0 - amp)
      ctx.lineTo(x0 + 30, y0 - amp)
      ctx.lineTo(x0 + 30, y0 + amp)
      ctx.lineTo(x0 + 60, y0 + amp)
      ctx.lineTo(x0 + 60, y0 - amp)
    }
    ctx.stroke()
  }
  applyScanlines(ctx)
}

function screenKey(kind: 'psu' | 'fungen', comp: ComponentInstance, entry: CatalogEntry): string {
  if (kind === 'psu') return String(paramOf(comp.params, entry, 'voltage') ?? 5)
  return `${paramOf(comp.params, entry, 'waveform') ?? 'square'}|${paramOf(comp.params, entry, 'frequency') ?? 1}`
}

/**
 * Fine horizontal brushing for the faceplate only (the shared
 * brushedRoughnessTexture is reused by every metal() — its repeat must not be
 * touched, so the faceplate gets its own streak map with tighter grain).
 */
let faceBrushTex: THREE.Texture | null | undefined
function faceplateBrush(): THREE.Texture | null {
  if (faceBrushTex !== undefined) return faceBrushTex
  faceBrushTex = null
  if (typeof document !== 'undefined') {
    const canvas = document.createElement('canvas')
    canvas.width = 64
    canvas.height = 256
    const ctx = canvas.getContext('2d')
    if (ctx) {
      let seed = 0xfa11 >>> 0
      const rnd = () => {
        seed = (seed * 1664525 + 1013904223) >>> 0
        return seed / 4294967296
      }
      for (let y = 0; y < 256; y++) {
        const v = 196 + Math.floor(rnd() * 59) // 0.77..1.0 roughness multiplier
        ctx.fillStyle = `rgb(${v},${v},${v})`
        ctx.fillRect(0, y, 64, 1)
      }
      const tex = new THREE.CanvasTexture(canvas)
      tex.wrapS = THREE.RepeatWrapping
      tex.wrapT = THREE.RepeatWrapping
      markShared(tex)
      faceBrushTex = tex
    }
  }
  return faceBrushTex
}

export function buildInstrumentBox(
  comp: ComponentInstance,
  entry: CatalogEntry,
  pins: THREE.Vector3[],
  kind: 'psu' | 'fungen',
): BuildResult {
  const group = new THREE.Group()
  const c = centroidOf(pins)
  const postZ = c.z
  const bodyW = 6.5
  const bodyH = 3.2
  const bodyD = 3.2
  const frontZ = postZ - 0.8 // front face, posts stand 0.8 in front of it

  // painted-steel enclosure with rounded edges
  const shellGeo = cachedGeometry('inst-shell', () => new RoundedBoxGeometry(6.5, 3.2, 3.2, 2, 0.12))
  const shellMat = cachedMaterial('inst-shell-mat', () =>
    new THREE.MeshPhysicalMaterial({ color: 0x282c33, roughness: 0.55, metalness: 0.25 }),
  )
  const body = new THREE.Mesh(shellGeo, shellMat)
  body.position.set(c.x, bodyH / 2, frontZ - bodyD / 2)
  group.add(body)

  // brushed-aluminum face plate covering the front panel. NOT metalness 1.0:
  // a pure metal is invisible without a bright env to mirror, and both raster
  // modes run the env dim (Enhanced 0.32 for the bloom threshold) — the plate
  // collapsed to a charcoal slab (sweep-psu-exit.png). Backing off to 0.8
  // with a bright alloy albedo + an env lift keeps a diffuse response under
  // the key light in every mode (Studio's path tracer included), which is
  // exactly how anodized/brushed aluminum behaves anyway.
  const faceplateMat = cachedMaterial('inst-faceplate', () => {
    const m = new THREE.MeshPhysicalMaterial({ color: 0xc2c7cd, metalness: 0.8, roughness: 0.38 })
    m.envMapIntensity = 1.9
    const r = faceplateBrush()
    if (r) m.roughnessMap = r
    return m
  })
  const faceplate = new THREE.Mesh(
    cachedGeometry('inst-faceplate-geo', () => new THREE.BoxGeometry(6.2, 2.96, 0.08)),
    faceplateMat,
  )
  faceplate.position.set(c.x, bodyH / 2, frontZ + 0.04)
  group.add(faceplate)
  const faceZ = frontZ + 0.08 + 0.02 // overlays sit clearly proud of the plate

  // static trim (bumpers, bezel, post metalwork) builds detached and merges
  // into one mesh per material at the end — the box dropped from 33 meshes
  // to ~18 (draw-call budget at 100 parts, DESIGN §7)
  const statics: THREE.Object3D[] = []

  // rubber corner bumpers, front AND rear (real bench boxes are stackable)
  const rubber = cachedMaterial('inst-rubber', () =>
    new THREE.MeshPhysicalMaterial({ color: 0x141416, roughness: 0.9, metalness: 0 }),
  )
  const bumperGeo = cachedGeometry('inst-bumper', () => new RoundedBoxGeometry(0.62, 0.62, 0.4, 1, 0.14))
  for (const sx of [-1, 1]) {
    for (const sy of [0, 1]) {
      for (const zPos of [frontZ + 0.04, frontZ - bodyD + 0.12]) {
        const b = new THREE.Mesh(bumperGeo, rubber)
        b.position.set(c.x + sx * (bodyW / 2 - 0.3), sy === 0 ? 0.31 : bodyH - 0.31, zPos)
        statics.push(b)
      }
    }
  }

  // raised screen bezel; the canvas screen is RECESSED behind a glass cover
  const bezelMat = cachedMaterial('inst-bezel', () =>
    new THREE.MeshPhysicalMaterial({ color: 0x101114, roughness: 0.6, metalness: 0 }),
  )
  const screenW = 3.6
  const screenH = 1.6
  const screenY = 2.05
  const bezelD = 0.16
  const bzTopGeo = cachedGeometry('inst-bz-top', () => new THREE.BoxGeometry(4.0, 0.15, bezelD))
  const bzSideGeo = cachedGeometry('inst-bz-side', () => new THREE.BoxGeometry(0.15, 1.6, bezelD))
  for (const sy of [-1, 1]) {
    const rail = new THREE.Mesh(bzTopGeo, bezelMat)
    rail.position.set(c.x, screenY + sy * (1.9 / 2 + 0.07), faceZ + bezelD / 2 - 0.02)
    statics.push(rail)
  }
  for (const sx of [-1, 1]) {
    const rail = new THREE.Mesh(bzSideGeo, bezelMat)
    rail.position.set(c.x + sx * (4.0 / 2 - 0.075), screenY, faceZ + bezelD / 2 - 0.02)
    statics.push(rail)
  }

  // screen (per-instance canvas so params can be redrawn live)
  let redraw: ((c2: ComponentInstance, e2: CatalogEntry) => void) | null = null
  if (typeof document !== 'undefined') {
    const canvas = document.createElement('canvas')
    canvas.width = SCREEN_W
    canvas.height = SCREEN_H
    const ctx = canvas.getContext('2d')
    if (ctx) {
      const tex = new THREE.CanvasTexture(canvas)
      tex.colorSpace = THREE.SRGBColorSpace
      tex.anisotropy = 4
      const screen = new THREE.Mesh(
        new THREE.PlaneGeometry(screenW, screenH),
        new THREE.MeshStandardMaterial({
          color: 0x000000,
          emissive: 0xffffff,
          emissiveMap: tex,
          emissiveIntensity: 1.0,
          roughness: 0.4,
          metalness: 0,
        }),
      )
      screen.position.set(c.x, screenY, faceZ + 0.01)
      group.add(screen)
      let lastKey = ''
      redraw = (c2, e2) => {
        const key = screenKey(kind, c2, e2)
        if (key === lastKey) return
        lastKey = key
        drawScreen(ctx, kind, c2, e2)
        tex.needsUpdate = true
      }
      redraw(comp, entry)
    }
  }

  // glass cover: inside the bezel, in front of the recessed screen — its low
  // roughness picks up the IBL for the slight reflection of a real display
  const glassMat = cachedMaterial('inst-screen-glass', () =>
    new THREE.MeshPhysicalMaterial({
      color: 0x0a0c10,
      roughness: 0.06,
      metalness: 0,
      transparent: true,
      opacity: 0.18,
      depthWrite: false,
    }),
  )
  const glass = new THREE.Mesh(
    cachedGeometry('inst-screen-glass-geo', () => new THREE.PlaneGeometry(3.7, 1.7)),
    glassMat,
  )
  glass.position.set(c.x, screenY, faceZ + 0.09)
  group.add(glass)

  // printed panel legends: model name + power LED share the narrow free band
  // between the corner bumper, the bezel's bottom rail and the left binding
  // post's hex nut (the post hardware owns the lower-left panel now)
  const model = kind === 'psu' ? 'BS-3005  DC SUPPLY' : 'BS-FG20  FUNCTION GEN'
  const modelMat = labelMaterial(model, { w: 256, h: 32, fg: '#2a2d31' })
  if (modelMat) {
    const lbl = new THREE.Mesh(
      cachedGeometry('inst-model-geo-sm', () => new THREE.PlaneGeometry(0.95, 0.12)),
      modelMat,
    )
    lbl.position.set(c.x - 2.1, 0.9, faceZ)
    group.add(lbl)
  }
  const ledMat = cachedMaterial('inst-pwr-led', () =>
    new THREE.MeshStandardMaterial({ color: 0x0a2012, emissive: 0x35d158, emissiveIntensity: 1.6, roughness: 0.4 }),
  )
  const led = new THREE.Mesh(
    cachedGeometry('inst-pwr-led-geo', () => {
      const g = new THREE.CylinderGeometry(0.06, 0.06, 0.06, 12)
      g.rotateX(Math.PI / 2)
      return g
    }),
    ledMat,
  )
  led.position.set(c.x - 2.7, 0.95, faceZ + 0.02)
  group.add(led)

  // front-panel adjust knob: machined aluminum with a printed pointer line
  const knobX = c.x + 2.45
  const knobBase = new THREE.Mesh(
    cachedGeometry('inst-knob-base', () => {
      const g = new THREE.CylinderGeometry(0.52, 0.52, 0.08, 24)
      g.rotateX(Math.PI / 2)
      return g
    }),
    bezelMat,
  )
  knobBase.position.set(knobX, 1.0, faceZ + 0.03)
  statics.push(knobBase)
  const knob = new THREE.Mesh(
    cachedGeometry('inst-knob', () => {
      const g = new THREE.CylinderGeometry(0.44, 0.46, 0.42, 24)
      g.rotateX(Math.PI / 2)
      return g
    }),
    metal(0xb9bec5, 0.3),
  )
  knob.position.set(knobX, 1.0, faceZ + 0.27)
  group.add(knob)
  const pointer = new THREE.Mesh(
    cachedGeometry('inst-knob-ptr', () => new THREE.BoxGeometry(0.05, 0.3, 0.03)),
    cachedMaterial('inst-knob-ptr-mat', () =>
      new THREE.MeshPhysicalMaterial({ color: 0xe8eaee, roughness: 0.4, metalness: 0 }),
    ),
  )
  pointer.position.set(knobX, 1.22, faceZ + 0.485)
  group.add(pointer)
  const knobLbl = labelMaterial(kind === 'psu' ? 'VOLTAGE' : 'FREQUENCY', { w: 128, h: 32, fg: '#2a2d31' })
  if (knobLbl) {
    const lbl = new THREE.Mesh(
      cachedGeometry('inst-knob-lbl-geo', () => new THREE.PlaneGeometry(0.9, 0.22)),
      knobLbl,
    )
    lbl.position.set(knobX, 0.32, faceZ)
    group.add(lbl)
  }

  // machined binding posts MOUNTED THROUGH the faceplate (pin 0 red, pin 1
  // black), axis horizontal along +z like a real bench supply: hex jam nut
  // flush against the plate (no air gap), colored insulator barrel with grip
  // grooves, then the exposed cross-drilled stud whose vertical wire hole
  // sits EXACTLY at the terminal attach point — (p.x, TERMINAL_TOP_Y, p.z),
  // the same spot the scene's wire endpoints, the router's terminal exits and
  // the fingertip snap all target — finished with a small dome tip nut.
  const plateFront = frontZ + 0.08 // faceplate front surface (plate depth 0.08)
  const studR = 0.1
  const axisY = TERMINAL_TOP_Y - studR // stud TOP carries the wire attach point
  const hexGeo = cachedGeometry('inst-post-hex-z', () => {
    const g = new THREE.CylinderGeometry(0.32, 0.32, 0.2, 6)
    g.rotateX(Math.PI / 2)
    return g
  })
  const barrelGeo = cachedGeometry('inst-post-barrel-z', () => {
    const g = new THREE.CylinderGeometry(0.21, 0.21, 0.48, 18)
    g.rotateX(Math.PI / 2)
    return g
  })
  // a torus already lies in the xy plane (hole facing +z) — no rotation needed
  const grooveGeo = cachedGeometry('inst-post-groove', () => new THREE.TorusGeometry(0.21, 0.022, 6, 18))
  const studGeo = cachedGeometry('inst-post-stud-z', () => {
    const g = new THREE.CylinderGeometry(0.1, 0.1, 0.29, 14)
    g.rotateX(Math.PI / 2)
    return g
  })
  // cross-drilled wire hole: a dark VERTICAL bore through the stud — its top
  // mouth is the attach point, so a plugged wire's end cap seats right on it
  const crossGeo = cachedGeometry('inst-post-cross-v', () => new THREE.CylinderGeometry(0.045, 0.045, 0.26, 8))
  const domeGeo = cachedGeometry('inst-post-dome-z', () => {
    const g = new THREE.CylinderGeometry(0.13, 0.16, 0.12, 14)
    g.rotateX(Math.PI / 2) // narrow end faces +z (the outward tip)
    return g
  })
  const darkMat = cachedMaterial('inst-post-dark', () =>
    new THREE.MeshPhysicalMaterial({ color: 0x0c0c0e, roughness: 0.8, metalness: 0 }),
  )
  const postLabels = kind === 'psu' ? ['+', '−'] : ['OUT', 'GND']
  pins.forEach((p, i) => {
    const insulator = plastic(i === 0 ? 0xc02020 : 0x1a1a1d, 0.32)
    const hex = new THREE.Mesh(hexGeo, metal(0xc9ccd1, 0.28))
    hex.position.set(p.x, axisY, plateFront + 0.06) // base buried in the plate
    statics.push(hex)
    const barrel = new THREE.Mesh(barrelGeo, insulator)
    barrel.position.set(p.x, axisY, plateFront + 0.38)
    statics.push(barrel)
    for (const gz of [0.3, 0.48]) {
      const groove = new THREE.Mesh(grooveGeo, insulator)
      groove.position.set(p.x, axisY, plateFront + gz)
      statics.push(groove)
    }
    const stud = new THREE.Mesh(studGeo, metal(0xd8dadd, 0.25))
    stud.position.set(p.x, axisY, p.z - 0.025) // spans the wire hole at p.z
    statics.push(stud)
    const cross = new THREE.Mesh(crossGeo, darkMat)
    cross.position.set(p.x, axisY, p.z)
    statics.push(cross)
    const dome = new THREE.Mesh(domeGeo, metal(0xd8dadd, 0.25))
    dome.position.set(p.x, axisY, p.z + 0.16)
    statics.push(dome)
    const lblMat = labelMaterial(postLabels[i] ?? '', { w: 128, h: 64, fg: i === 0 ? '#8c1f1f' : '#2b2e33' })
    if (lblMat && postLabels[i]) {
      // printed on the faceplate INBOARD of each post at axis height (the
      // bezel owns the band above the posts, the hex nut the area around)
      const lbl = new THREE.Mesh(new THREE.PlaneGeometry(0.8, 0.36), lblMat)
      lbl.position.set(p.x + (i === 0 ? 0.78 : -0.78), axisY, faceZ)
      group.add(lbl)
    }
  })
  for (const m of mergeStatic(statics)) group.add(m)

  // wires attach at the stud top, over the cross-drilled hole — exactly the
  // (x, TERMINAL_TOP_Y, z) point the scene and the wire router use, so wire
  // ends always seat on the visible post
  const pinWorld = pins.map((p) => new THREE.Vector3(p.x, TERMINAL_TOP_Y, p.z))

  return {
    object: group,
    pinWorld,
    update: (c2, e2) => {
      redraw?.(c2, e2)
    },
  }
}

// ---------------------------------------------------------------------------
// Oscilloscope probe (grabber clip: metal hook + molded boot)
// ---------------------------------------------------------------------------

const CHANNEL_COLORS: Record<number, number> = {
  1: 0xf2c41d, // yellow
  2: 0x18c5c5, // cyan
  3: 0xd024d0, // magenta
  4: 0x27b53c, // green
}

export function buildProbe(
  comp: ComponentInstance,
  entry: CatalogEntry,
  pins: THREE.Vector3[],
): BuildResult {
  const group = new THREE.Group()
  const p = pins[0] ?? new THREE.Vector3()
  const ch = Math.round(Number(paramOf(comp.params, entry, 'channel') ?? 1))
  const color = CHANNEL_COLORS[ch] ?? CHANNEL_COLORS[1]

  // the whole clip is static → everything merges per material at the end
  // (boot plastic / channel ring / hook metal = 3 draws, down from 11)
  const statics: THREE.Object3D[] = []

  // sprung metal hook: out of the hole, bulges toward +z, sweeps back up into
  // the molded nose (the grabber-clip silhouette from the reference photo)
  statics.push(
    legMesh(
      [
        new THREE.Vector3(p.x, HOLE_DEPTH + 0.04, p.z),
        new THREE.Vector3(p.x, 0.22, p.z),
        new THREE.Vector3(p.x, 0.36, p.z + 0.14),
        new THREE.Vector3(p.x, 0.47, p.z + 0.07),
        new THREE.Vector3(p.x, 0.52, p.z - 0.05),
        new THREE.Vector3(p.x, 0.62, p.z - 0.14), // buried inside the nose
      ],
      0.04,
      metal(0xd8dadd, 0.25),
    ),
  )

  // angled molded body leaning toward −z
  const lean = new THREE.Group()
  lean.position.set(p.x, 0.42, p.z)
  lean.rotation.x = -0.7 // +Y axis tips toward −z

  const boot = plastic(0x26262a, 0.5)

  // tapered nose the hook retracts into
  const noseGeo = cachedGeometry('probe-nose', () => new THREE.CylinderGeometry(0.17, 0.06, 0.5, 14))
  const nose = new THREE.Mesh(noseGeo, boot)
  nose.position.y = 0.35
  lean.add(nose)

  // flared collar where the nose meets the boot
  const collarGeo = cachedGeometry('probe-collar', () => new THREE.CylinderGeometry(0.24, 0.19, 0.2, 14))
  const collar = new THREE.Mesh(collarGeo, boot)
  collar.position.y = 0.7
  lean.add(collar)

  // main molded boot with grip ribs
  const bodyGeo = cachedGeometry('probe-body', () => new THREE.CylinderGeometry(0.24, 0.24, 1.0, 14))
  const bodyMesh = new THREE.Mesh(bodyGeo, boot)
  bodyMesh.position.y = 1.3
  lean.add(bodyMesh)
  const ribGeo = cachedGeometry('probe-rib', () => new THREE.TorusGeometry(0.245, 0.022, 6, 14))
  for (const ry of [1.0, 1.14, 1.28]) {
    const rib = new THREE.Mesh(ribGeo, boot)
    rib.rotation.x = Math.PI / 2
    rib.position.y = ry
    lean.add(rib)
  }

  // channel-ID ring (scope channel color lives here, like real probe rings)
  const ringGeo = cachedGeometry('probe-ring', () => new THREE.CylinderGeometry(0.25, 0.25, 0.16, 14))
  const ring = new THREE.Mesh(ringGeo, plastic(color, 0.4))
  ring.position.y = 1.62
  lean.add(ring)

  // rear strain relief tapering to the (implied) cable
  const tailGeo = cachedGeometry('probe-tail', () => new THREE.CylinderGeometry(0.1, 0.17, 0.6, 12))
  const tail = new THREE.Mesh(tailGeo, boot)
  tail.position.y = 2.05
  lean.add(tail)
  const tipGeo = cachedGeometry('probe-tip-ball', () => new THREE.SphereGeometry(0.1, 10, 8))
  const ball = new THREE.Mesh(tipGeo, boot)
  ball.position.y = 2.36
  lean.add(ball)

  statics.push(lean) // mergeStatic bakes the lean transform into the vertices
  for (const m of mergeStatic(statics)) group.add(m)

  return { object: group, pinWorld: pins.map((q) => q.clone()) }
}
