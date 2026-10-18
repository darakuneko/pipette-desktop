// SPDX-License-Identifier: GPL-2.0-or-later
//
// The little PNG handling the capture needs, on node:zlib alone: reading the
// 8-bit RGB / RGBA, non-interlaced PNG a WebDriver screenshot is, cutting a
// rectangle out of it, writing it back, and telling a screenshot of one
// solid colour (a frame that was never painted) from a real one.

import { deflateSync, inflateSync } from 'node:zlib'

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

/** A decoded image: `width * height` RGBA pixels, row by row. */
export interface RgbaImage {
  width: number
  height: number
  data: Buffer
}

/** A rectangle in pixels of an image. */
export interface PixelRect {
  x: number
  y: number
  width: number
  height: number
}

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c
  const pa = Math.abs(p - a)
  const pb = Math.abs(p - b)
  const pc = Math.abs(p - c)
  if (pa <= pb && pa <= pc) return a
  return pb <= pc ? b : c
}

/** Decodes an 8-bit RGB or RGBA, non-interlaced PNG into RGBA pixels.
 *  Throws for any other PNG. */
export function decodePng(png: Buffer): RgbaImage {
  if (!png.subarray(0, 8).equals(SIGNATURE)) throw new Error('not a PNG')
  let offset = 8
  let width = 0
  let height = 0
  let channels = 0
  const idat: Buffer[] = []
  while (offset + 8 <= png.length) {
    const length = png.readUInt32BE(offset)
    const type = png.toString('latin1', offset + 4, offset + 8)
    const body = png.subarray(offset + 8, offset + 8 + length)
    if (type === 'IHDR') {
      width = body.readUInt32BE(0)
      height = body.readUInt32BE(4)
      const [depth, colorType, , , interlace] = [body[8], body[9], body[10], body[11], body[12]]
      if (depth !== 8 || (colorType !== 2 && colorType !== 6) || interlace !== 0) {
        throw new Error(`unsupported PNG (bit depth ${depth}, colour type ${colorType}, interlace ${interlace})`)
      }
      channels = colorType === 6 ? 4 : 3
    } else if (type === 'IDAT') {
      idat.push(body)
    } else if (type === 'IEND') {
      break
    }
    offset += 12 + length
  }
  if (channels === 0) throw new Error('the PNG has no IHDR')
  const raw = inflateSync(Buffer.concat(idat))
  const stride = width * channels
  if (raw.length < height * (stride + 1)) throw new Error('the PNG data is truncated')
  const pixels = Buffer.alloc(height * stride)
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)]
    const src = y * (stride + 1) + 1
    const row = y * stride
    for (let i = 0; i < stride; i++) {
      const left = i >= channels ? pixels[row + i - channels] : 0
      const up = y > 0 ? pixels[row - stride + i] : 0
      const upLeft = y > 0 && i >= channels ? pixels[row - stride + i - channels] : 0
      const value = raw[src + i]
      let predicted: number
      switch (filter) {
        case 0: predicted = 0; break
        case 1: predicted = left; break
        case 2: predicted = up; break
        case 3: predicted = (left + up) >> 1; break
        case 4: predicted = paeth(left, up, upLeft); break
        default: throw new Error(`unknown PNG filter ${filter}`)
      }
      pixels[row + i] = (value + predicted) & 0xff
    }
  }
  if (channels === 4) return { width, height, data: pixels }
  const data = Buffer.alloc(width * height * 4)
  for (let p = 0; p < width * height; p++) {
    pixels.copy(data, p * 4, p * 3, p * 3 + 3)
    data[p * 4 + 3] = 0xff
  }
  return { width, height, data }
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  return c >>> 0
})

function crc32(buf: Buffer): number {
  let c = 0xffffffff
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function chunk(type: string, body: Buffer): Buffer {
  const head = Buffer.alloc(8)
  head.writeUInt32BE(body.length, 0)
  head.write(type, 4, 'latin1')
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), body])), 0)
  return Buffer.concat([head, body, crc])
}

/** Encodes RGBA pixels as an 8-bit RGBA PNG. */
export function encodePng(image: RgbaImage): Buffer {
  const header = Buffer.alloc(13)
  header.writeUInt32BE(image.width, 0)
  header.writeUInt32BE(image.height, 4)
  header[8] = 8
  header[9] = 6
  const stride = image.width * 4
  const raw = Buffer.alloc(image.height * (stride + 1))
  for (let y = 0; y < image.height; y++) image.data.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride)
  return Buffer.concat([SIGNATURE, chunk('IHDR', header), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))])
}

/** The part of `image` inside `rect`, clipped to the image. Throws when
 *  nothing of it is inside. */
export function cropImage(image: RgbaImage, rect: PixelRect): RgbaImage {
  const x0 = Math.max(0, Math.round(rect.x))
  const y0 = Math.max(0, Math.round(rect.y))
  const x1 = Math.min(image.width, Math.round(rect.x + rect.width))
  const y1 = Math.min(image.height, Math.round(rect.y + rect.height))
  if (x1 <= x0 || y1 <= y0) throw new Error('the rectangle is outside the image')
  const width = x1 - x0
  const height = y1 - y0
  const data = Buffer.alloc(width * height * 4)
  for (let y = 0; y < height; y++) {
    image.data.copy(data, y * width * 4, ((y0 + y) * image.width + x0) * 4, ((y0 + y) * image.width + x1) * 4)
  }
  return { width, height, data }
}

/** Whether every pixel of `image` is the same colour. */
export function isSolidColour(image: RgbaImage): boolean {
  const first = image.data.readUInt32BE(0)
  for (let i = 4; i < image.data.length; i += 4) {
    if (image.data.readUInt32BE(i) !== first) return false
  }
  return true
}
