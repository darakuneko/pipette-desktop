// Draws the macOS menu-bar icon: a black eyedropper silhouette on a
// transparent canvas, used as a template image (macOS keeps only its alpha
// and tints it to match the menu bar).
// Usage: pnpm run generate:tray-template-icon
//
// The tray (src-tauri/src/tray.rs) draws any icon 18pt high, so the canvas
// is 18pt at 2x: 36x36 pixels, with 1pt left clear on each side.

import { writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { deflateSync } from 'node:zlib'

const SIZE = 36
const MARGIN = 2
/** Samples per pixel along each axis: the alpha is the covered fraction. */
const SUPERSAMPLE = 16

const OUTPUT = join(dirname(fileURLToPath(import.meta.url)), '../src-tauri/icons/tray-template.png')

/**
 * The dropper in its own frame: `u` runs along it from the tip (0) to the
 * end of the bulb (100), `v` across it. Each part is the set of points
 * within `radius` of the segment from `u0` to `u1` on the axis, with the
 * ends cut square when `square` is set.
 */
interface Part {
  u0: number
  u1: number
  radius: number
  square?: boolean
}

const PARTS: Part[] = [
  // the narrow tip of the glass
  { u0: 2.2, u1: 14, radius: 2.2 },
  // the glass tube
  { u0: 12, u1: 58, radius: 5 },
  // the collar
  { u0: 53, u1: 69, radius: 13, square: true },
  // the neck of the bulb
  { u0: 68, u1: 78, radius: 7.5, square: true },
  // the bulb
  { u0: 80, u1: 89, radius: 11 },
]

function inside(u: number, v: number): boolean {
  return PARTS.some(({ u0, u1, radius, square }) => {
    if (square) return u >= u0 && u <= u1 && Math.abs(v) <= radius
    const along = Math.min(Math.max(u, u0), u1)
    return (u - along) ** 2 + v ** 2 <= radius ** 2
  })
}

// The dropper lies on the diagonal, the tip at the bottom left and the bulb
// at the top right, as on the app icon. Image y grows downwards.
const AXIS = { x: Math.SQRT1_2, y: -Math.SQRT1_2 }
const ACROSS = { x: Math.SQRT1_2, y: Math.SQRT1_2 }

function toImage(u: number, v: number): { x: number; y: number } {
  return { x: u * AXIS.x + v * ACROSS.x, y: u * AXIS.y + v * ACROSS.y }
}

function fromImage(x: number, y: number): { u: number; v: number } {
  return { u: x * AXIS.x + y * AXIS.y, v: x * ACROSS.x + y * ACROSS.y }
}

/** The bounds of the dropper in image units (before scaling). */
function bounds(): { minX: number; maxX: number; minY: number; maxY: number } {
  const b = { minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity }
  for (let u = -20; u <= 120; u += 0.05) {
    for (let v = -20; v <= 20; v += 0.05) {
      if (!inside(u, v)) continue
      const { x, y } = toImage(u, v)
      b.minX = Math.min(b.minX, x)
      b.maxX = Math.max(b.maxX, x)
      b.minY = Math.min(b.minY, y)
      b.maxY = Math.max(b.maxY, y)
    }
  }
  return b
}

function render(): Uint8Array {
  const b = bounds()
  const scale = (SIZE - 2 * MARGIN) / Math.max(b.maxX - b.minX, b.maxY - b.minY)
  const centerX = (b.minX + b.maxX) / 2
  const centerY = (b.minY + b.maxY) / 2
  const alpha = new Uint8Array(SIZE * SIZE)
  for (let py = 0; py < SIZE; py++) {
    for (let px = 0; px < SIZE; px++) {
      let covered = 0
      for (let sy = 0; sy < SUPERSAMPLE; sy++) {
        for (let sx = 0; sx < SUPERSAMPLE; sx++) {
          const x = (px + (sx + 0.5) / SUPERSAMPLE - SIZE / 2) / scale + centerX
          const y = (py + (sy + 0.5) / SUPERSAMPLE - SIZE / 2) / scale + centerY
          const { u, v } = fromImage(x, y)
          if (inside(u, v)) covered++
        }
      }
      alpha[py * SIZE + px] = Math.round((covered * 255) / SUPERSAMPLE ** 2)
    }
  }
  return alpha
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  return c >>> 0
})

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff
  for (const byte of bytes) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function chunk(type: string, data: Uint8Array): Buffer {
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const out = Buffer.alloc(body.length + 8)
  out.writeUInt32BE(data.length, 0)
  body.copy(out, 4)
  out.writeUInt32BE(crc32(body), body.length + 4)
  return out
}

/** An 8-bit RGBA PNG, black everywhere, with `alpha` as its alpha. */
function encodePng(alpha: Uint8Array): Buffer {
  const header = Buffer.alloc(13)
  header.writeUInt32BE(SIZE, 0)
  header.writeUInt32BE(SIZE, 4)
  header.set([8, 6, 0, 0, 0], 8)
  const rows = Buffer.alloc(SIZE * (1 + SIZE * 4))
  for (let y = 0; y < SIZE; y++) {
    const row = y * (1 + SIZE * 4)
    for (let x = 0; x < SIZE; x++) rows[row + 1 + x * 4 + 3] = alpha[y * SIZE + x]
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(rows, { level: 9 })),
    chunk('IEND', new Uint8Array()),
  ])
}

writeFileSync(OUTPUT, encodePng(render()))
console.log(`wrote ${OUTPUT}`)
