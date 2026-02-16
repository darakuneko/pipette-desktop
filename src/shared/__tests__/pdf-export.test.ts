// SPDX-License-Identifier: GPL-2.0-or-later

import { describe, it, expect } from 'vitest'
import { generateKeymapPdf, type PdfExportInput } from '../pdf-export'
import type { KleKey } from '../kle/types'

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

function mockSerialize(code: number): string {
  const names: Record<number, string> = {
    0x00: 'KC_NO',
    0x04: 'KC_A',
    0x05: 'KC_B',
    0x06: 'KC_C',
    0x29: 'KC_ESC',
    0x80: 'KC_VOLD',
    0x81: 'KC_VOLU',
  }
  return names[code] ?? `0x${code.toString(16).toUpperCase().padStart(4, '0')}`
}

function mockKeycodeLabel(qmkId: string): string {
  const labels: Record<string, string> = {
    KC_NO: '',
    KC_A: 'A',
    KC_B: 'B',
    KC_C: 'C',
    KC_ESC: 'Esc',
    KC_VOLD: 'Vol-',
    KC_VOLU: 'Vol+',
    'LCTL(KC_A)': 'Ctrl\n(kc)',
  }
  return labels[qmkId] ?? qmkId
}

function mockIsMask(qmkId: string): boolean {
  return qmkId.startsWith('LCTL(') || qmkId.startsWith('LSFT(')
}

function mockFindOuterKeycode(qmkId: string): { label: string } | undefined {
  if (qmkId.startsWith('LCTL(')) return { label: 'Ctrl\n(kc)' }
  return undefined
}

function mockFindInnerKeycode(qmkId: string): { label: string } | undefined {
  if (qmkId === 'LCTL(KC_A)') return { label: 'A' }
  return undefined
}

function createBasicInput(overrides: Partial<PdfExportInput> = {}): PdfExportInput {
  const keys: KleKey[] = [
    makeKey({ x: 0, y: 0, row: 0, col: 0 }),
    makeKey({ x: 1, y: 0, row: 0, col: 1 }),
    makeKey({ x: 2, y: 0, row: 0, col: 2 }),
  ]

  const keymap = new Map<string, number>([
    ['0,0,0', 0x29],
    ['0,0,1', 0x04],
    ['0,0,2', 0x05],
  ])

  return {
    deviceName: 'Test Keyboard',
    layers: 1,
    keys,
    keymap,
    encoderLayout: new Map(),
    encoderCount: 0,
    layoutOptions: new Map(),
    serializeKeycode: mockSerialize,
    keycodeLabel: mockKeycodeLabel,
    isMask: mockIsMask,
    findOuterKeycode: mockFindOuterKeycode,
    findInnerKeycode: mockFindInnerKeycode,
    ...overrides,
  }
}

function decodePdf(base64: string): Uint8Array {
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i)
  }
  return bytes
}

function pdfSignature(bytes: Uint8Array): string {
  return String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3], bytes[4])
}

describe('generateKeymapPdf', () => {
  it('returns a base64 string', () => {
    const result = generateKeymapPdf(createBasicInput())
    expect(typeof result).toBe('string')
    expect(result.length).toBeGreaterThan(0)
  })

  it('decodes to valid PDF (starts with %PDF-)', () => {
    const base64 = generateKeymapPdf(createBasicInput())
    const bytes = decodePdf(base64)
    expect(pdfSignature(bytes)).toBe('%PDF-')
  })

  it('generates PDF for single layer', () => {
    const base64 = generateKeymapPdf(createBasicInput())
    const bytes = decodePdf(base64)
    expect(pdfSignature(bytes)).toBe('%PDF-')
    // Single-layer PDF should be reasonably sized (> 1KB)
    expect(bytes.length).toBeGreaterThan(1000)
  })

  it('generates larger PDF for multiple layers', () => {
    const keymap = new Map<string, number>([
      ['0,0,0', 0x29], ['0,0,1', 0x04], ['0,0,2', 0x05],
      ['1,0,0', 0x06], ['1,0,1', 0x04], ['1,0,2', 0x05],
    ])

    const singleBase64 = generateKeymapPdf(createBasicInput())
    const multiBase64 = generateKeymapPdf(createBasicInput({ layers: 2, keymap }))

    // Multi-layer should produce more content
    expect(multiBase64.length).toBeGreaterThan(singleBase64.length)
  })

  it('handles encoder keys', () => {
    const keys: KleKey[] = [
      makeKey({ x: 0, y: 0, row: 0, col: 0 }),
      makeKey({ x: 1, y: 0, row: 0, col: 1, encoderIdx: 0, encoderDir: 0 }),
      makeKey({ x: 2, y: 0, row: 0, col: 2, encoderIdx: 0, encoderDir: 1 }),
    ]

    const keymap = new Map<string, number>([['0,0,0', 0x29]])
    const encoderLayout = new Map<string, number>([
      ['0,0,0', 0x81],
      ['0,0,1', 0x80],
    ])

    const base64 = generateKeymapPdf(createBasicInput({
      keys,
      keymap,
      encoderCount: 1,
      encoderLayout,
    }))

    expect(typeof base64).toBe('string')
    const bytes = decodePdf(base64)
    expect(pdfSignature(bytes)).toBe('%PDF-')
  })

  it('filters keys by layout options', () => {
    const keys: KleKey[] = [
      makeKey({ x: 0, y: 0, row: 0, col: 0 }),
      makeKey({ x: 1, y: 0, row: 0, col: 1, layoutIndex: 0, layoutOption: 0 }),
      makeKey({ x: 1, y: 0, row: 0, col: 2, layoutIndex: 0, layoutOption: 1 }),
    ]

    const keymap = new Map<string, number>([
      ['0,0,0', 0x29],
      ['0,0,1', 0x04],
      ['0,0,2', 0x05],
    ])

    const base64 = generateKeymapPdf(createBasicInput({
      keys,
      keymap,
      layoutOptions: new Map([[0, 1]]),
    }))
    expect(typeof base64).toBe('string')
    const bytes = decodePdf(base64)
    expect(pdfSignature(bytes)).toBe('%PDF-')
  })

  it('excludes decal keys', () => {
    const keys: KleKey[] = [
      makeKey({ x: 0, y: 0, row: 0, col: 0 }),
      makeKey({ x: 1, y: 0, row: 0, col: 1, decal: true }),
      makeKey({ x: 2, y: 0, row: 0, col: 2 }),
    ]

    const base64 = generateKeymapPdf(createBasicInput({ keys }))
    expect(typeof base64).toBe('string')
    const bytes = decodePdf(base64)
    expect(pdfSignature(bytes)).toBe('%PDF-')
  })

  it('does not crash with empty keys array', () => {
    const base64 = generateKeymapPdf(createBasicInput({
      keys: [],
      keymap: new Map(),
    }))
    expect(typeof base64).toBe('string')
    const bytes = decodePdf(base64)
    expect(pdfSignature(bytes)).toBe('%PDF-')
  })

  it('handles many layers with page breaks', () => {
    const keymap = new Map<string, number>()
    for (let l = 0; l < 8; l++) {
      keymap.set(`${l},0,0`, 0x29)
      keymap.set(`${l},0,1`, 0x04)
      keymap.set(`${l},0,2`, 0x05)
    }

    const base64 = generateKeymapPdf(createBasicInput({ layers: 8, keymap }))
    const bytes = decodePdf(base64)
    expect(pdfSignature(bytes)).toBe('%PDF-')
    // 8-layer PDF should be much larger than 1-layer
    const singleBase64 = generateKeymapPdf(createBasicInput())
    expect(base64.length).toBeGreaterThan(singleBase64.length * 2)
  })

  it('falls back to qmkId for CJK-only labels', () => {
    const keymap = new Map<string, number>([
      ['0,0,0', 0x29],
      ['0,0,1', 0x04],
      ['0,0,2', 0x05],
    ])

    const base64 = generateKeymapPdf(createBasicInput({
      keymap,
      serializeKeycode: (code: number) => {
        if (code === 0x04) return 'KC_HENK'
        if (code === 0x05) return 'KC_LANG1'
        return mockSerialize(code)
      },
      keycodeLabel: (qmkId: string) => {
        if (qmkId === 'KC_HENK') return '\u5909\u63DB'
        if (qmkId === 'KC_LANG1') return '\uD55C\uC601\n\u304B\u306A'
        return mockKeycodeLabel(qmkId)
      },
    }))
    expect(typeof base64).toBe('string')
    const bytes = decodePdf(base64)
    expect(pdfSignature(bytes)).toBe('%PDF-')
  })

  it('handles masked keycodes', () => {
    const keymap = new Map<string, number>([
      ['0,0,0', 0x29],
      ['0,0,1', 0x04],
      ['0,0,2', 0x05],
    ])

    // serializeKeycode returns a mask keycode for one key
    const base64 = generateKeymapPdf(createBasicInput({
      keymap,
      serializeKeycode: (code: number) => {
        if (code === 0x04) return 'LCTL(KC_A)'
        return mockSerialize(code)
      },
    }))
    expect(typeof base64).toBe('string')
    const bytes = decodePdf(base64)
    expect(pdfSignature(bytes)).toBe('%PDF-')
  })
})
