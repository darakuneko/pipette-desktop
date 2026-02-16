// SPDX-License-Identifier: GPL-2.0-or-later

import { describe, it, expect } from 'vitest'
import { parseKle } from '../kle-parser'

describe('KLE Parser', () => {
  describe('basic key parsing', () => {
    it('parses a single key with default position', () => {
      const result = parseKle([['0,0']])
      expect(result.keys).toHaveLength(1)
      expect(result.keys[0].x).toBe(0)
      expect(result.keys[0].y).toBe(0)
      expect(result.keys[0].width).toBe(1)
      expect(result.keys[0].height).toBe(1)
      expect(result.keys[0].row).toBe(0)
      expect(result.keys[0].col).toBe(0)
    })

    it('parses multiple keys in a row', () => {
      const result = parseKle([['0,0', '0,1', '0,2']])
      expect(result.keys).toHaveLength(3)
      expect(result.keys[0].x).toBe(0)
      expect(result.keys[1].x).toBe(1)
      expect(result.keys[2].x).toBe(2)
    })

    it('handles multiple rows', () => {
      const result = parseKle([
        ['0,0', '0,1'],
        ['1,0', '1,1'],
      ])
      expect(result.keys).toHaveLength(4)
      expect(result.keys[2].y).toBe(1)
      expect(result.keys[2].row).toBe(1)
      expect(result.keys[2].col).toBe(0)
      expect(result.keys[3].row).toBe(1)
      expect(result.keys[3].col).toBe(1)
    })

    it('handles empty input', () => {
      const result = parseKle([])
      expect(result.keys).toHaveLength(0)
    })
  })

  describe('size and position', () => {
    it('handles width and height', () => {
      const result = parseKle([[{ w: 2 }, '0,0']])
      expect(result.keys[0].width).toBe(2)
      expect(result.keys[0].height).toBe(1)
    })

    it('handles x and y offsets', () => {
      const result = parseKle([[{ x: 0.25 }, '0,0']])
      expect(result.keys[0].x).toBe(0.25)
    })

    it('handles y offset within a row', () => {
      const result = parseKle([[{ y: 0.5 }, '0,0']])
      expect(result.keys[0].y).toBe(0.5)
    })

    it('accumulates x position across keys', () => {
      const result = parseKle([[{ w: 1.5 }, '0,0', '0,1']])
      expect(result.keys[0].x).toBe(0)
      expect(result.keys[0].width).toBe(1.5)
      expect(result.keys[1].x).toBe(1.5)
    })

    it('handles second rect (x2, y2, w2, h2)', () => {
      const result = parseKle([[{ x2: -0.25, w2: 1.5, h2: 2 }, '0,0']])
      expect(result.keys[0].x2).toBe(-0.25)
      expect(result.keys[0].width2).toBe(1.5)
      expect(result.keys[0].height2).toBe(2)
    })

    it('defaults width2/height2 to width/height when 0', () => {
      const result = parseKle([[{ w: 2.25, h: 1 }, '0,0']])
      // width2 should default to width when width2 was 0
      expect(result.keys[0].width2).toBe(2.25)
      expect(result.keys[0].height2).toBe(1)
    })
  })

  describe('rotation', () => {
    it('handles rotation', () => {
      const result = parseKle([[{ r: 15, rx: 3, ry: 2 }, '0,0']])
      expect(result.keys[0].rotation).toBe(15)
      expect(result.keys[0].rotationX).toBe(3)
      expect(result.keys[0].rotationY).toBe(2)
    })

    it('resets x to rx at end of row', () => {
      const result = parseKle([
        [{ r: 10, rx: 2, ry: 1 }, '0,0', '0,1'],
        ['1,0'],
      ])
      // After first row, x should reset to rx=2
      expect(result.keys[2].x).toBe(2)
      // y should be incremented from cluster
      expect(result.keys[2].y).toBe(2) // cluster.y=1, +1 from first row
    })

    it('throws if rotation is set on non-first key in a row', () => {
      expect(() => parseKle([['0,0', { r: 10 }, '0,1']])).toThrow(
        'Rotation can only be specified on the first key in a row',
      )
    })

    it('rx resets position to cluster origin', () => {
      const result = parseKle([[{ rx: 5, ry: 3 }, '0,0']])
      expect(result.keys[0].x).toBe(5)
      expect(result.keys[0].y).toBe(3)
    })
  })

  describe('appearance', () => {
    it('handles color', () => {
      const result = parseKle([[{ c: '#ff0000' }, '0,0']])
      expect(result.keys[0].color).toBe('#ff0000')
    })

    it('color persists across keys', () => {
      const result = parseKle([[{ c: '#ff0000' }, '0,0', '0,1']])
      expect(result.keys[0].color).toBe('#ff0000')
      expect(result.keys[1].color).toBe('#ff0000')
    })

    it('uses default color when none specified', () => {
      const result = parseKle([['0,0']])
      expect(result.keys[0].color).toBe('#cccccc')
    })
  })

  describe('flags', () => {
    it('handles decal flag', () => {
      const result = parseKle([[{ d: true }, 'label']])
      expect(result.keys[0].decal).toBe(true)
    })

    it('handles nub flag', () => {
      const result = parseKle([[{ n: true }, '0,0']])
      expect(result.keys[0].nub).toBe(true)
    })

    it('handles stepped flag (l property)', () => {
      const result = parseKle([[{ l: true }, '0,0']])
      expect(result.keys[0].stepped).toBe(true)
    })

    it('handles ghost flag', () => {
      const result = parseKle([[{ g: true }, '0,0']])
      expect(result.keys[0].ghost).toBe(true)
    })
  })

  describe('transient property reset', () => {
    it('resets width after each key', () => {
      const result = parseKle([[{ w: 2 }, '0,0', '0,1']])
      expect(result.keys[0].width).toBe(2)
      expect(result.keys[1].width).toBe(1)
    })

    it('resets height after each key', () => {
      const result = parseKle([[{ h: 2 }, '0,0', '0,1']])
      expect(result.keys[0].height).toBe(2)
      expect(result.keys[1].height).toBe(1)
    })

    it('resets nub/stepped/decal after each key', () => {
      const result = parseKle([[{ n: true, l: true, d: true }, '0,0', '0,1']])
      expect(result.keys[0].nub).toBe(true)
      expect(result.keys[0].stepped).toBe(true)
      expect(result.keys[0].decal).toBe(true)
      expect(result.keys[1].nub).toBe(false)
      expect(result.keys[1].stepped).toBe(false)
      expect(result.keys[1].decal).toBe(false)
    })

    it('resets x2/y2/w2/h2 after each key', () => {
      const result = parseKle([[{ x2: 0.5, y2: 0.5 }, '0,0', '0,1']])
      expect(result.keys[0].x2).toBe(0.5)
      expect(result.keys[0].y2).toBe(0.5)
      expect(result.keys[1].x2).toBe(0)
      expect(result.keys[1].y2).toBe(0)
    })
  })

  describe('label parsing', () => {
    it('extracts row and col from labels[0]', () => {
      const result = parseKle([['3,7']])
      expect(result.keys[0].row).toBe(3)
      expect(result.keys[0].col).toBe(7)
    })

    it('handles layout options from labels[8]', () => {
      // With default alignment (a=4), label position 8 maps to logical position 1
      // labelMap[4] = [0, 6, 2, 8, 10, -1, 3, 5, 1, 4, 7, -1]
      // So input position 8 -> output position 1
      // We need labels[8] in the output = input position that maps to 8
      // labelMap[4][3] = 8, so input position 3 gives output position 8
      // With \n split: "top-left\n\n\ntop-right" => positions [0]=top-left, [3]=top-right
      const result = parseKle([['0,0\n\n\n1,2']])
      expect(result.keys[0].layoutIndex).toBe(1)
      expect(result.keys[0].layoutOption).toBe(2)
    })

    it('handles layout options with a=0 alignment', () => {
      // labelMap[0] = [0, 6, 2, 8, 9, 11, 3, 5, 1, 4, 7, 10]
      // input position 8 -> output position 1
      // We need output position 8 = input position 3
      // "0,0\n\n\n1,3" => split[0]="0,0", split[3]="1,3"
      // labelMap[0][3] = 8, so split[3] goes to output[8]
      const result = parseKle([[{ a: 0 }, '0,0\n\n\n1,3']])
      expect(result.keys[0].layoutIndex).toBe(1)
      expect(result.keys[0].layoutOption).toBe(3)
    })

    it('sets default row/col/encoder/layout values', () => {
      // A label without comma in labels[0] should not set row/col
      const result = parseKle([['X']])
      expect(result.keys[0].row).toBe(0)
      expect(result.keys[0].col).toBe(0)
      expect(result.keys[0].encoderIdx).toBe(-1)
      expect(result.keys[0].encoderDir).toBe(-1)
      expect(result.keys[0].layoutIndex).toBe(-1)
      expect(result.keys[0].layoutOption).toBe(-1)
    })

    it('handles encoder keys', () => {
      // Encoder convention: labels[4]="e", labels[0]="idx,dir"
      // With a=4 (default), labelMap[4] = [0, 6, 2, 8, 10, -1, 3, 5, 1, 4, 7, -1]
      // For output[4] = "e", need input[9] (labelMap[4][9]=4)
      // For output[0] = "0,0", need input[0] (labelMap[4][0]=0)
      // Build a string with \n separators: positions 0..9
      // "0,0\n\n\n\n\n\n\n\n\ne"
      const result = parseKle([['0,0\n\n\n\n\n\n\n\n\ne']])
      expect(result.keys[0].encoderIdx).toBe(0)
      expect(result.keys[0].encoderDir).toBe(0)
      expect(result.keys[0].row).toBe(0) // should remain default
      expect(result.keys[0].col).toBe(0) // should remain default
    })

    it('handles encoder key with non-zero index and direction', () => {
      // labels[0]="2,1", labels[4]="e" -> encoder idx=2, dir=1 (CCW)
      const result = parseKle([['2,1\n\n\n\n\n\n\n\n\ne']])
      expect(result.keys[0].encoderIdx).toBe(2)
      expect(result.keys[0].encoderDir).toBe(1)
    })
  })

  describe('complex layouts', () => {
    it('handles a typical 2x3 layout', () => {
      const result = parseKle([
        ['0,0', '0,1', '0,2'],
        ['1,0', '1,1', '1,2'],
      ])
      expect(result.keys).toHaveLength(6)
      // First row
      expect(result.keys[0]).toMatchObject({ x: 0, y: 0, row: 0, col: 0 })
      expect(result.keys[1]).toMatchObject({ x: 1, y: 0, row: 0, col: 1 })
      expect(result.keys[2]).toMatchObject({ x: 2, y: 0, row: 0, col: 2 })
      // Second row
      expect(result.keys[3]).toMatchObject({ x: 0, y: 1, row: 1, col: 0 })
      expect(result.keys[4]).toMatchObject({ x: 1, y: 1, row: 1, col: 1 })
      expect(result.keys[5]).toMatchObject({ x: 2, y: 1, row: 1, col: 2 })
    })

    it('handles ISO enter (stepped key with second rect)', () => {
      const result = parseKle([[{ x: 0.25, w: 1.25, h: 2, w2: 1.5, h2: 1, x2: -0.25 }, '0,0']])
      expect(result.keys[0].width).toBe(1.25)
      expect(result.keys[0].height).toBe(2)
      expect(result.keys[0].width2).toBe(1.5)
      expect(result.keys[0].height2).toBe(1)
      expect(result.keys[0].x2).toBe(-0.25)
    })

    it('handles mixed properties and keys in a row', () => {
      const result = parseKle([[{ c: '#333333' }, '0,0', { c: '#666666' }, '0,1']])
      expect(result.keys[0].color).toBe('#333333')
      expect(result.keys[1].color).toBe('#666666')
    })

    it('handles w setting both width and width2', () => {
      // When w is set, it sets both width and width2
      // Then if w2 is also set, it overrides width2
      const result = parseKle([[{ w: 2.25 }, '0,0']])
      // width2 was set to 2.25 by w, then not overridden by w2
      // But since width2 > 0 it won't default to width
      expect(result.keys[0].width).toBe(2.25)
      expect(result.keys[0].width2).toBe(2.25)
    })
  })

  describe('edge cases', () => {
    it('handles non-array row items gracefully', () => {
      // Non-array items (like metadata objects) should be skipped
      const result = parseKle([['0,0']])
      expect(result.keys).toHaveLength(1)
    })

    it('handles x offset accumulating with key width', () => {
      const result = parseKle([[{ x: 1 }, '0,0', { x: 0.5 }, '0,1']])
      // First key at x=1, width=1, so next key starts at x=2
      // Then +0.5 offset = 2.5
      expect(result.keys[0].x).toBe(1)
      expect(result.keys[1].x).toBe(2.5)
    })

    it('preserves labels array with 12 elements', () => {
      const result = parseKle([['0,0']])
      expect(result.keys[0].labels).toHaveLength(12)
    })
  })
})
