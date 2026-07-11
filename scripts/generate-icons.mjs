/**
 * generate-icons.mjs — dev-time script (no dependencies): rasterizes the flat
 * breadboard glyph to PNG without canvas by drawing into a raw RGBA buffer
 * and hand-encoding the PNG (zlib from node core for IDAT).
 *
 *   node scripts/generate-icons.mjs
 *
 * Writes public/apple-touch-icon.png (180×180, opaque — iOS ignores SVG
 * apple-touch-icons) and public/icon-512.png (512×512, for the manifest).
 */
import { deflateSync } from 'node:zlib'
import { writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

// ---------------------------------------------------------------- raster ops

function makeImage(size, [r, g, b]) {
  const px = new Uint8Array(size * size * 4)
  for (let i = 0; i < size * size; i++) {
    px[i * 4] = r
    px[i * 4 + 1] = g
    px[i * 4 + 2] = b
    px[i * 4 + 3] = 255
  }
  return { size, px }
}

function put(img, x, y, [r, g, b]) {
  if (x < 0 || y < 0 || x >= img.size || y >= img.size) return
  const i = (y * img.size + x) * 4
  img.px[i] = r
  img.px[i + 1] = g
  img.px[i + 2] = b
  img.px[i + 3] = 255
}

/** Filled rounded rectangle (coords in unit space 0..1 of the icon). */
function roundedRect(img, ux, uy, uw, uh, ur, color) {
  const s = img.size
  const x0 = ux * s, y0 = uy * s, w = uw * s, h = uh * s, rad = ur * s
  for (let y = Math.floor(y0); y < y0 + h; y++) {
    for (let x = Math.floor(x0); x < x0 + w; x++) {
      const dx = Math.max(x0 + rad - x, x - (x0 + w - rad), 0)
      const dy = Math.max(y0 + rad - y, y - (y0 + h - rad), 0)
      if (dx * dx + dy * dy <= rad * rad) put(img, x, y, color)
    }
  }
}

function circle(img, ucx, ucy, urad, color) {
  const s = img.size
  const cx = ucx * s, cy = ucy * s, rad = urad * s
  for (let y = Math.floor(cy - rad); y <= cy + rad; y++) {
    for (let x = Math.floor(cx - rad); x <= cx + rad; x++) {
      const dx = x - cx, dy = y - cy
      if (dx * dx + dy * dy <= rad * rad) put(img, x, y, color)
    }
  }
}

/** Thick polyline stroke sampled as stamped circles (good enough for an icon). */
function stroke(img, points, uw, color) {
  for (let i = 0; i < points.length - 1; i++) {
    const [ax, ay] = points[i]
    const [bx, by] = points[i + 1]
    const steps = Math.ceil(Math.hypot(bx - ax, by - ay) * img.size)
    for (let t = 0; t <= steps; t++) {
      const k = t / steps
      circle(img, ax + (bx - ax) * k, ay + (by - ay) * k, uw / 2, color)
    }
  }
}

/** Sample a cubic bezier into a polyline. */
function bezier(p0, p1, p2, p3, n = 48) {
  const pts = []
  for (let i = 0; i <= n; i++) {
    const t = i / n, u = 1 - t
    pts.push([
      u * u * u * p0[0] + 3 * u * u * t * p1[0] + 3 * u * t * t * p2[0] + t * t * t * p3[0],
      u * u * u * p0[1] + 3 * u * u * t * p1[1] + 3 * u * t * t * p2[1] + t * t * t * p3[1],
    ])
  }
  return pts
}

// ------------------------------------------------------------------ the art

const BG = [0x15, 0x17, 0x1c]
const BOARD = [0xe9, 0xe4, 0xd6]
const CHANNEL = [0xd4, 0xce, 0xbc]
const HOLE = [0x3a, 0x3f, 0x4a]
const RED = [0xff, 0x45, 0x3a]
const BLUE = [0x0a, 0x84, 0xff]
const GREEN = [0x30, 0xd1, 0x58]

function drawIcon(size) {
  const img = makeImage(size, BG)
  // board body
  roundedRect(img, 0.148, 0.266, 0.703, 0.469, 0.07, BOARD)
  // rails
  roundedRect(img, 0.21, 0.32, 0.58, 0.02, 0.01, RED)
  roundedRect(img, 0.21, 0.66, 0.58, 0.02, 0.01, BLUE)
  // center channel
  roundedRect(img, 0.148, 0.488, 0.703, 0.024, 0.0, CHANNEL)
  // hole grid (6 cols × 4 rows around the channel)
  const cols = [0.25, 0.348, 0.445, 0.543, 0.64, 0.738]
  const rows = [0.402, 0.46, 0.54, 0.598]
  for (const cy of rows) for (const cx of cols) circle(img, cx, cy, 0.0175, HOLE)
  // green jumper arcing over the channel
  stroke(img, bezier([0.348, 0.46], [0.348, 0.29], [0.64, 0.29], [0.64, 0.54]), 0.036, GREEN)
  return img
}

// ------------------------------------------------------------------ PNG out

const CRC_TABLE = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c >>> 0
  }
  return t
})()

function crc32(buf) {
  let c = 0xffffffff
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function chunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body))
  return Buffer.concat([len, body, crc])
}

function encodePng({ size, px }) {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0)
  ihdr.writeUInt32BE(size, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // RGBA
  // scanlines with filter byte 0
  const raw = Buffer.alloc(size * (size * 4 + 1))
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0
    Buffer.from(px.buffer, y * size * 4, size * 4).copy(raw, y * (size * 4 + 1) + 1)
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

mkdirSync(join(root, 'public'), { recursive: true })
writeFileSync(join(root, 'public/apple-touch-icon.png'), encodePng(drawIcon(180)))
writeFileSync(join(root, 'public/icon-512.png'), encodePng(drawIcon(512)))
console.log('wrote public/apple-touch-icon.png (180) and public/icon-512.png (512)')
