// SPDX-License-Identifier: GPL-2.0-or-later
// The capture's PNG handling: decoding every row filter of RGB and RGBA,
// encoding, cropping, and telling a solid-colour frame from a painted one.

import { deflateSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import { cropImage, decodePng, encodePng, isSolidColour, type RgbaImage } from '../png'

/** A 3x2 RGBA image of distinct pixels. */
function sample(): RgbaImage {
  const data = Buffer.alloc(3 * 2 * 4)
  for (let i = 0; i < data.length; i++) data[i] = (i * 37 + 11) & 0xff
  return { width: 3, height: 2, data }
}

/** A PNG of `rows` (already filtered, each row starting with its filter
 *  byte) with the colour type `colorType`, built by hand. */
function handmadePng(width: number, height: number, colorType: 2 | 6, rows: number[][]): Buffer {
  const header = Buffer.alloc(13)
  header.writeUInt32BE(width, 0)
  header.writeUInt32BE(height, 4)
  header[8] = 8
  header[9] = colorType
  // Chunk CRCs are not checked by the decoder, so zeros do.
  const chunk = (type: string, body: Buffer): Buffer => {
    const head = Buffer.alloc(8)
    head.writeUInt32BE(body.length, 0)
    head.write(type, 4, 'latin1')
    return Buffer.concat([head, body, Buffer.alloc(4)])
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(Buffer.from(rows.flat()))),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

describe('png', () => {
  it('decodes what it encodes', () => {
    const image = sample()
    expect(decodePng(encodePng(image))).toEqual(image)
  })

  it('undoes the Sub, Up, Average and Paeth filters of an RGB image', () => {
    // 2 pixels wide, RGB. Row 0 unfiltered: (10,20,30) (40,50,60).
    const rows = [
      [0, 10, 20, 30, 40, 50, 60],
      [1, 5, 5, 5, 1, 1, 1], // Sub: (5,5,5) (6,6,6)
      [2, 1, 1, 1, 1, 1, 1], // Up: (6,6,6) (7,7,7)
      [3, 4, 4, 4, 0, 0, 0], // Average: (7,7,7) (7,7,7)
      [4, 1, 1, 1, 1, 1, 1], // Paeth: (8,8,8) (9,9,9)
    ]
    const image = decodePng(handmadePng(2, 5, 2, rows))
    const rgb = (x: number, y: number): number[] => [...image.data.subarray((y * 2 + x) * 4, (y * 2 + x) * 4 + 4)]
    expect(rgb(0, 0)).toEqual([10, 20, 30, 255])
    expect(rgb(1, 0)).toEqual([40, 50, 60, 255])
    expect([rgb(0, 1), rgb(1, 1)]).toEqual([[5, 5, 5, 255], [6, 6, 6, 255]])
    expect([rgb(0, 2), rgb(1, 2)]).toEqual([[6, 6, 6, 255], [7, 7, 7, 255]])
    expect([rgb(0, 3), rgb(1, 3)]).toEqual([[7, 7, 7, 255], [7, 7, 7, 255]])
    expect([rgb(0, 4), rgb(1, 4)]).toEqual([[8, 8, 8, 255], [9, 9, 9, 255]])
  })

  it('refuses what is not an 8-bit RGB or RGBA PNG', () => {
    expect(() => decodePng(Buffer.from('not a png at all'))).toThrow(/not a PNG/)
    const grey = handmadePng(1, 1, 6, [[0, 0, 0, 0, 0]])
    grey[8 + 8 + 9] = 0 // IHDR colour type: greyscale
    expect(() => decodePng(grey)).toThrow(/unsupported PNG/)
  })

  it('crops to a rectangle, clipped to the image', () => {
    const image = sample()
    const cropped = cropImage(image, { x: 1, y: 1, width: 5, height: 5 })
    expect([cropped.width, cropped.height]).toEqual([2, 1])
    expect(cropped.data).toEqual(image.data.subarray((3 + 1) * 4, (3 + 3) * 4))
    expect(() => cropImage(image, { x: 3, y: 0, width: 2, height: 2 })).toThrow(/outside/)
  })

  it('tells a single solid colour from a painted image', () => {
    const black: RgbaImage = { width: 4, height: 3, data: Buffer.alloc(4 * 3 * 4, 0) }
    expect(isSolidColour(black)).toBe(true)
    black.data[4 * 3 * 4 - 2] = 1
    expect(isSolidColour(black)).toBe(false)
    expect(isSolidColour(sample())).toBe(false)
  })
})
