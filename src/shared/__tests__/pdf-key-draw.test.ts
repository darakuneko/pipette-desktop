// SPDX-License-Identifier: GPL-2.0-or-later

import { describe, it, expect, vi } from 'vitest'
import { jsPDF } from 'jspdf'
import type { KleKey } from '../kle/types'
import {
  arrayBufferToBase64,
  computeBounds,
  keyCorners,
  degreesToRadians,
  rotatePoint,
  formatTimestamp,
  drawKeyOutline,
  drawEncoderOutline,
  SPACING_FRACTION,
  FACE_INSET_FRACTION,
  ROUNDNESS,
  KAPPA,
} from '../pdf-key-draw'

function makeKey(overrides: Partial<KleKey> = {}): KleKey {
  return {
    x: 0, y: 0,
    width: 1, height: 1,
    x2: 0, y2: 0,
    width2: 1, height2: 1,
    rotation: 0, rotationX: 0, rotationY: 0,
    color: '#cccccc',
    labels: Array(12).fill(null),
    textColor: Array(12).fill(null),
    textSize: Array(12).fill(null),
    row: 0, col: 0,
    encoderIdx: -1, encoderDir: -1,
    layoutIndex: -1, layoutOption: -1,
    decal: false, nub: false, stepped: false, ghost: false,
    ...overrides,
  }
}

describe('pdf-key-draw utilities', () => {
  describe('arrayBufferToBase64', () => {
    it('converts ArrayBuffer to base64 string', () => {
      const buffer = new TextEncoder().encode('hello').buffer
      const result = arrayBufferToBase64(buffer)
      expect(atob(result)).toBe('hello')
    })

    it('handles empty buffer', () => {
      const result = arrayBufferToBase64(new ArrayBuffer(0))
      expect(result).toBe('')
    })
  })

  describe('computeBounds', () => {
    it('returns zero bounds for empty keys', () => {
      const bounds = computeBounds([])
      expect(bounds).toEqual({ minX: 0, minY: 0, width: 0, height: 0 })
    })

    it('computes bounds for single key', () => {
      const bounds = computeBounds([makeKey({ x: 1, y: 2, width: 3, height: 4 })])
      expect(bounds.minX).toBe(1)
      expect(bounds.minY).toBe(2)
      expect(bounds.width).toBe(3)
      expect(bounds.height).toBe(4)
    })

    it('computes bounds for multiple keys', () => {
      const keys = [
        makeKey({ x: 0, y: 0, width: 1, height: 1 }),
        makeKey({ x: 2, y: 3, width: 1, height: 1 }),
      ]
      const bounds = computeBounds(keys)
      expect(bounds.minX).toBe(0)
      expect(bounds.minY).toBe(0)
      expect(bounds.width).toBe(3)
      expect(bounds.height).toBe(4)
    })
  })

  describe('keyCorners', () => {
    it('returns 4 corners for a simple key', () => {
      const corners = keyCorners(makeKey({ x: 0, y: 0, width: 1, height: 1 }))
      expect(corners).toHaveLength(4)
    })

    it('returns 8 corners for key with secondary rect', () => {
      const corners = keyCorners(makeKey({
        x: 0, y: 0, width: 1.25, height: 2,
        x2: -0.25, y2: 0, width2: 1.5, height2: 1,
      }))
      expect(corners).toHaveLength(8)
    })
  })

  describe('degreesToRadians', () => {
    it('converts 0 degrees to 0 radians', () => {
      expect(degreesToRadians(0)).toBe(0)
    })

    it('converts 180 degrees to PI', () => {
      expect(degreesToRadians(180)).toBeCloseTo(Math.PI)
    })
  })

  describe('rotatePoint', () => {
    it('returns same point for 0 rotation', () => {
      const [x, y] = rotatePoint(1, 0, 0, 0, 0)
      expect(x).toBeCloseTo(1)
      expect(y).toBeCloseTo(0)
    })

    it('rotates 90 degrees correctly', () => {
      const [x, y] = rotatePoint(1, 0, 90, 0, 0)
      expect(x).toBeCloseTo(0)
      expect(y).toBeCloseTo(1)
    })
  })

  describe('formatTimestamp', () => {
    it('formats date correctly', () => {
      const date = new Date(2025, 0, 15, 9, 30)
      const result = formatTimestamp(date)
      expect(result).toBe('2025-01-15 09:30')
    })
  })

  describe('constants', () => {
    it('exports expected constant values', () => {
      expect(SPACING_FRACTION).toBeCloseTo(0.0588, 3)
      expect(FACE_INSET_FRACTION).toBeCloseTo(0.0294, 3)
      expect(ROUNDNESS).toBe(0.08)
      expect(KAPPA).toBeCloseTo(0.5523, 3)
    })
  })

  describe('drawKeyOutline', () => {
    it('calls jsPDF drawing methods for a simple key', () => {
      const doc = new jsPDF({ orientation: 'landscape', unit: 'mm', format: 'a4' })
      const roundedRectSpy = vi.spyOn(doc, 'roundedRect')

      drawKeyOutline(doc, makeKey({ x: 0, y: 0, width: 1, height: 1 }), 10, 10, 20)

      expect(roundedRectSpy).toHaveBeenCalled()
    })

    it('handles rotated keys without error', () => {
      const doc = new jsPDF({ orientation: 'landscape', unit: 'mm', format: 'a4' })

      expect(() => {
        drawKeyOutline(doc, makeKey({
          x: 0, y: 0, width: 1, height: 1,
          rotation: 45, rotationX: 0.5, rotationY: 0.5,
        }), 10, 10, 20)
      }).not.toThrow()
    })

    it('handles ISO key with secondary rect', () => {
      const doc = new jsPDF({ orientation: 'landscape', unit: 'mm', format: 'a4' })

      expect(() => {
        drawKeyOutline(doc, makeKey({
          x: 0, y: 0, width: 1.25, height: 2,
          x2: -0.25, y2: 0, width2: 1.5, height2: 1,
        }), 10, 10, 20)
      }).not.toThrow()
    })
  })

  describe('drawEncoderOutline', () => {
    it('calls jsPDF circle method', () => {
      const doc = new jsPDF({ orientation: 'landscape', unit: 'mm', format: 'a4' })
      const circleSpy = vi.spyOn(doc, 'circle')

      drawEncoderOutline(doc, makeKey({
        x: 0, y: 0, width: 1, height: 1,
        encoderIdx: 0, encoderDir: 0,
      }), 10, 10, 20)

      expect(circleSpy).toHaveBeenCalled()
    })

    it('handles rotated encoder without error', () => {
      const doc = new jsPDF({ orientation: 'landscape', unit: 'mm', format: 'a4' })

      expect(() => {
        drawEncoderOutline(doc, makeKey({
          x: 0, y: 0, width: 1, height: 1,
          encoderIdx: 0, encoderDir: 0,
          rotation: 90, rotationX: 0.5, rotationY: 0.5,
        }), 10, 10, 20)
      }).not.toThrow()
    })
  })
})
