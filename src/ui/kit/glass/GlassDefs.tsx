/**
 * GlassDefs — one-time SVG filter definitions for the Liquid Glass lens
 * (DESIGN.md §1). The real WWDC25 material BENDS the background at the
 * surface's edges; the browser equivalent is an SVG displacement map driven
 * through `backdrop-filter: blur() saturate() url(#lg-lens-*)`.
 *
 * How it works
 * - For each surface tier (capsule / dock / card / sheet) we bake a
 *   displacement map on a canvas at the tier's nominal CSS-pixel size:
 *   a rounded-rect SDF whose outward normal is encoded in R(x)/G(y) around
 *   a neutral 128, with magnitude concentrated in a thin BEZEL band at the
 *   edge (profile (1-t)^2.2 — refraction lives at the rim, the center stays
 *   perfectly readable). Verified against `scripts/glass-probe.mjs visual`.
 * - Filters use primitiveUnits="objectBoundingBox" so the map stretches to
 *   whatever element wears the class — surfaces within ~±25% of the tier's
 *   nominal size degrade gracefully (the bezel scales with them).
 * - Maps are baked off the critical path (idle callback); only once every
 *   feImage has its href does <html> get the `lg-lens-on` class that
 *   enables the lens rules in kit.css (an unmapped feDisplacementMap would
 *   shift the whole backdrop by -scale/2).
 *
 * Engine gating: only Chromium renders SVG references inside
 * backdrop-filter. Safari and Firefox PARSE `backdrop-filter: url()` (so
 * @supports lies) but then drop the whole declaration at paint time — they
 * must never get the lens class or they'd lose blur entirely. We require a
 * real `Chrome/`-family UA on top of CSS.supports. Reduced transparency
 * also opts out (kit.css flattens the material there anyway).
 *
 * Mounting: `ensureGlassDefs()` is called from the kit barrel on import
 * (idempotent, SSR/test safe) so no App.tsx hook is needed; the <GlassDefs/>
 * component is exported for explicit mounting if an agent prefers JSX.
 */
import { useEffect } from 'react'

export interface GlassTier {
  /** SVG filter id AND the CSS class that applies it (kit.css). */
  id: string
  /** Nominal surface size in CSS px the map is baked for. */
  width: number
  height: number
  /** Corner radii [tl, tr, br, bl] in px (sheet: top corners only). */
  radii: [number, number, number, number]
  /** Width of the edge band (px) where refraction is concentrated. */
  bezel: number
  /** Maximum background bend at the very edge, in px at nominal size. */
  displacement: number
  /** Bottom edge stays neutral (no bend): for strips whose bottom meets
   *  another glass surface (the sheet's grabber band) instead of the scene. */
  flatBottom?: boolean
}

/** The surface tiers (DESIGN.md §1 tier budget). Class = filter id. */
export const GLASS_TIERS: readonly GlassTier[] = [
  { id: 'lg-lens-capsule', width: 220, height: 44, radii: [22, 22, 22, 22], bezel: 11, displacement: 26 },
  { id: 'lg-lens-dock', width: 372, height: 61, radii: [26, 26, 26, 26], bezel: 13, displacement: 30 },
  { id: 'lg-lens-card', width: 340, height: 300, radii: [22, 22, 22, 22], bezel: 16, displacement: 36 },
  { id: 'lg-lens-sheet', width: 390, height: 600, radii: [22, 22, 0, 0], bezel: 18, displacement: 40 },
  // the topmost sheet's grabber band (Sheet.tsx): refraction at the top
  // corners + flanks, neutral at the seam where it meets the regular body
  { id: 'lg-lens-band', width: 390, height: 44, radii: [22, 22, 0, 0], bezel: 12, displacement: 26, flatBottom: true },
]

const SVG_NS = 'http://www.w3.org/2000/svg'
const DEFS_ID = 'lg-glass-defs'
/** Set on <html> once every lens filter has a baked map. */
export const LENS_READY_CLASS = 'lg-lens-on'

/**
 * Signed distance to a rounded rect centered at the origin, with a
 * per-quadrant corner radius. Negative inside.
 */
function roundedRectSDF(
  px: number,
  py: number,
  hw: number,
  hh: number,
  radii: [number, number, number, number],
): number {
  // quadrant radius: [tl, tr, br, bl] with y growing downward
  const r = px >= 0 ? (py >= 0 ? radii[2] : radii[1]) : py >= 0 ? radii[3] : radii[0]
  const qx = Math.abs(px) - (hw - r)
  const qy = Math.abs(py) - (hh - r)
  const ax = Math.max(qx, 0)
  const ay = Math.max(qy, 0)
  return Math.hypot(ax, ay) + Math.min(Math.max(qx, qy), 0) - r
}

/**
 * Bake one tier's displacement map → PNG data URI. R = x-displacement,
 * G = y-displacement (128 neutral), magnitude (1-t)^2.2 across the bezel.
 */
export function buildDisplacementMap(tier: GlassTier): string {
  const { width: w, height: h, radii, bezel } = tier
  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  const ctx = canvas.getContext('2d')
  if (!ctx) return ''
  const img = ctx.createImageData(w, h)
  const hx = w / 2
  // flatBottom: evaluate the SDF of a rect EXTENDED below the canvas (center
  // shifted down by `pad`, half-height grown by `pad`) — the canvas bottom
  // row then sits 2*pad (> bezel) inside the rect, so the bottom edge bakes
  // neutral 128 while top/side bezels are unchanged.
  const pad = tier.flatBottom ? bezel + 2 : 0
  const hy = h / 2
  const hy2 = hy + pad
  const e = 1 // numeric-gradient epsilon (px)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const px = x + 0.5 - hx
      const py = y + 0.5 - hy - pad
      const inside = -roundedRectSDF(px, py, hx, hy2, radii) // px from edge, >=0 inside
      let nx = 0
      let ny = 0
      if (inside >= 0 && inside < bezel) {
        const t = inside / bezel
        const mag = Math.pow(1 - t, 2.2)
        // outward normal from the SDF gradient (numeric)
        let gx =
          (roundedRectSDF(px + e, py, hx, hy2, radii) - roundedRectSDF(px - e, py, hx, hy2, radii)) /
          (2 * e)
        let gy =
          (roundedRectSDF(px, py + e, hx, hy2, radii) - roundedRectSDF(px, py - e, hx, hy2, radii)) /
          (2 * e)
        const len = Math.hypot(gx, gy) || 1
        gx /= len
        gy /= len
        nx = gx * mag
        ny = gy * mag
      }
      const i = (y * w + x) * 4
      img.data[i] = Math.round(128 + nx * 127)
      img.data[i + 1] = Math.round(128 + ny * 127)
      img.data[i + 2] = 128
      img.data[i + 3] = 255
    }
  }
  ctx.putImageData(img, 0, 0)
  return canvas.toDataURL('image/png')
}

/**
 * feDisplacementMap scale for a tier. With primitiveUnits=objectBoundingBox
 * lengths are fractions of sqrt((w²+h²)/2) of the FILTERED ELEMENT — at the
 * tier's nominal size this lands exactly on `displacement` px (and scales
 * proportionally for off-nominal surfaces, which is what we want).
 */
function tierScale(tier: GlassTier): number {
  return tier.displacement / Math.sqrt((tier.width * tier.width + tier.height * tier.height) / 2)
}

/** True when this engine actually renders url() filters in backdrop-filter. */
function lensCapable(): boolean {
  if (typeof window === 'undefined' || typeof document === 'undefined') return false
  // verification escape hatch: `?lens=off` forces the cross-engine blur
  // fallback so the non-Chromium material can be screenshotted in Chromium
  try {
    if (new URLSearchParams(window.location.search).get('lens') === 'off') return false
  } catch {
    /* no usable location (tests) — fall through */
  }
  if (typeof CSS === 'undefined' || typeof CSS.supports !== 'function') return false
  if (!CSS.supports('backdrop-filter', 'url(#lg-probe)')) return false
  // Safari/Firefox parse url() but drop the whole backdrop-filter at paint
  // time — require a real Chromium UA (CriOS/FxiOS are WebKit and excluded).
  const ua = navigator.userAgent
  if (!/chrome\/|chromium|headlesschrome|edg\//i.test(ua)) return false
  if (/crios|fxios|firefox/i.test(ua)) return false
  if (window.matchMedia?.('(prefers-reduced-transparency: reduce)').matches) return false
  return true
}

let injected = false

function inject(): void {
  if (document.getElementById(DEFS_ID)) return
  if (!lensCapable()) return
  const svg = document.createElementNS(SVG_NS, 'svg')
  svg.setAttribute('id', DEFS_ID)
  svg.setAttribute('width', '0')
  svg.setAttribute('height', '0')
  svg.setAttribute('aria-hidden', 'true')
  svg.style.position = 'absolute'
  const defs = document.createElementNS(SVG_NS, 'defs')
  const images: { tier: GlassTier; fe: SVGFEImageElement }[] = []
  for (const tier of GLASS_TIERS) {
    const filter = document.createElementNS(SVG_NS, 'filter')
    filter.setAttribute('id', tier.id)
    filter.setAttribute('x', '-20%')
    filter.setAttribute('y', '-20%')
    filter.setAttribute('width', '140%')
    filter.setAttribute('height', '140%')
    filter.setAttribute('color-interpolation-filters', 'sRGB')
    filter.setAttribute('primitiveUnits', 'objectBoundingBox')
    const fe = document.createElementNS(SVG_NS, 'feImage') as SVGFEImageElement
    fe.setAttribute('x', '0')
    fe.setAttribute('y', '0')
    fe.setAttribute('width', '1')
    fe.setAttribute('height', '1')
    fe.setAttribute('preserveAspectRatio', 'none')
    fe.setAttribute('result', 'lg-map')
    const disp = document.createElementNS(SVG_NS, 'feDisplacementMap')
    disp.setAttribute('in', 'SourceGraphic')
    disp.setAttribute('in2', 'lg-map')
    disp.setAttribute('xChannelSelector', 'R')
    disp.setAttribute('yChannelSelector', 'G')
    disp.setAttribute('scale', tierScale(tier).toFixed(6))
    filter.appendChild(fe)
    filter.appendChild(disp)
    defs.appendChild(filter)
    images.push({ tier, fe })
  }
  svg.appendChild(defs)
  document.body.appendChild(svg)

  // Bake the maps off the critical path (~0.4 Mpx of JS loops ≈ 10–20ms),
  // then arm the lens. Until then surfaces run the blur fallback — never a
  // half-initialized displacement.
  const bake = () => {
    for (const { tier, fe } of images) {
      fe.setAttribute('href', buildDisplacementMap(tier))
    }
    document.documentElement.classList.add(LENS_READY_CLASS)
  }
  if (typeof window.requestIdleCallback === 'function') {
    window.requestIdleCallback(bake, { timeout: 300 })
  } else {
    window.setTimeout(bake, 50)
  }
}

/**
 * Inject the lens filter defs once (no-op outside the browser, on
 * non-Chromium engines, under reduced transparency, or when already done).
 */
export function ensureGlassDefs(): void {
  if (injected || typeof document === 'undefined') return
  injected = true
  if (document.body) {
    inject()
  } else {
    document.addEventListener('DOMContentLoaded', () => inject(), { once: true })
  }
}

/** JSX mounting alternative — renders nothing, injects the defs once. */
export function GlassDefs(): null {
  useEffect(() => {
    ensureGlassDefs()
  }, [])
  return null
}
