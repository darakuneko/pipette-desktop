// SPDX-License-Identifier: GPL-2.0-or-later

import { describe, it, expect } from 'vitest'
import {
  generateKeymapPdf,
  isEmptyCombo,
  isEmptyTapDance,
  isEmptyKeyOverride,
  isEmptyAltRepeatKey,
  isEmptyMacro,
  type PdfExportInput,
  type PdfMacroAction,
} from '../pdf-export'
import type { KleKey } from '../kle/types'
import type { AltRepeatKeyEntry, ComboEntry, KeyOverrideEntry, TapDanceEntry } from '../types/protocol'

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

/** Count PDF pages by counting /Type /Page occurrences (excluding /Type /Pages). */
function countPages(base64: string): number {
  const bytes = decodePdf(base64)
  const text = new TextDecoder('latin1').decode(bytes)
  // Match "/Type /Page" not followed by "s" (to exclude "/Type /Pages")
  const matches = text.match(/\/Type\s+\/Page(?!s)/g)
  return matches?.length ?? 0
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

  it('handles ISO/stepped keys with union polygon', () => {
    const keys: KleKey[] = [
      makeKey({ x: 0, y: 0, row: 0, col: 0 }),
      // ISO Enter: 1.25u wide, 2u tall, secondary rect wider on top
      makeKey({
        x: 1, y: 0, row: 0, col: 1,
        width: 1.25, height: 2,
        x2: -0.25, y2: 0, width2: 1.5, height2: 1,
      }),
      makeKey({ x: 2.5, y: 0, row: 0, col: 2 }),
    ]

    const keymap = new Map<string, number>([
      ['0,0,0', 0x29],
      ['0,0,1', 0x04],
      ['0,0,2', 0x05],
    ])

    const base64 = generateKeymapPdf(createBasicInput({ keys, keymap }))
    expect(typeof base64).toBe('string')
    const bytes = decodePdf(base64)
    expect(pdfSignature(bytes)).toBe('%PDF-')
    expect(bytes.length).toBeGreaterThan(1000)
  })

  it('handles rotated ISO keys', () => {
    const keys: KleKey[] = [
      makeKey({ x: 0, y: 0, row: 0, col: 0 }),
      // Reversed ISO: rotated 180° around (0.6, 3.95)
      makeKey({
        x: 0.6, y: 3.95, row: 0, col: 1,
        width: 1.25, height: 2,
        x2: -0.25, y2: 0, width2: 1.5, height2: 1,
        rotation: 180, rotationX: 0.6, rotationY: 3.95,
      }),
    ]

    const keymap = new Map<string, number>([
      ['0,0,0', 0x29],
      ['0,0,1', 0x04],
    ])

    const base64 = generateKeymapPdf(createBasicInput({ keys, keymap }))
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

  // ── Combo / Tap Dance pages ─────────────────────────────────────────

  it('backward compat: no combo/tapDance fields produces same page count', () => {
    const withoutFields = generateKeymapPdf(createBasicInput())
    const withUndefined = generateKeymapPdf(createBasicInput({
      combo: undefined,
      tapDance: undefined,
    }))
    expect(countPages(withoutFields)).toBe(countPages(withUndefined))
    // Size should be roughly equal (within 5% tolerance for timestamp/ID diffs)
    const sizeA = decodePdf(withoutFields).length
    const sizeB = decodePdf(withUndefined).length
    expect(Math.abs(sizeA - sizeB)).toBeLessThan(sizeA * 0.05)
  })

  it('empty combo/tapDance arrays produce no extra pages', () => {
    const baseline = generateKeymapPdf(createBasicInput())
    const withEmpty = generateKeymapPdf(createBasicInput({
      combo: [],
      tapDance: [],
    }))
    expect(countPages(withEmpty)).toBe(countPages(baseline))
  })

  it('all-zero combo entries are skipped (no extra pages)', () => {
    const emptyCombos: ComboEntry[] = [
      { key1: 0, key2: 0, key3: 0, key4: 0, output: 0 },
      { key1: 0, key2: 0, key3: 0, key4: 0, output: 0 },
    ]
    const baseline = generateKeymapPdf(createBasicInput())
    const withEmptyCombos = generateKeymapPdf(createBasicInput({ combo: emptyCombos }))
    expect(countPages(withEmptyCombos)).toBe(countPages(baseline))
  })

  it('all-zero tapDance entries are skipped (no extra pages)', () => {
    const emptyTds: TapDanceEntry[] = [
      { onTap: 0, onHold: 0, onDoubleTap: 0, onTapHold: 0, tappingTerm: 0 },
      { onTap: 0, onHold: 0, onDoubleTap: 0, onTapHold: 0, tappingTerm: 0 },
    ]
    const baseline = generateKeymapPdf(createBasicInput())
    const withEmptyTds = generateKeymapPdf(createBasicInput({ tapDance: emptyTds }))
    expect(countPages(withEmptyTds)).toBe(countPages(baseline))
  })

  it('configured combos add extra pages', () => {
    const combos: ComboEntry[] = [
      { key1: 0x04, key2: 0x05, key3: 0, key4: 0, output: 0x29 },
    ]
    const baseline = generateKeymapPdf(createBasicInput())
    const withCombos = generateKeymapPdf(createBasicInput({ combo: combos }))
    expect(countPages(withCombos)).toBeGreaterThan(countPages(baseline))
    expect(decodePdf(withCombos).length).toBeGreaterThan(decodePdf(baseline).length)
  })

  it('configured tap dances add extra pages', () => {
    const tapDances: TapDanceEntry[] = [
      { onTap: 0x04, onHold: 0x05, onDoubleTap: 0x06, onTapHold: 0x29, tappingTerm: 200 },
    ]
    const baseline = generateKeymapPdf(createBasicInput())
    const withTds = generateKeymapPdf(createBasicInput({ tapDance: tapDances }))
    expect(countPages(withTds)).toBeGreaterThan(countPages(baseline))
    expect(decodePdf(withTds).length).toBeGreaterThan(decodePdf(baseline).length)
  })

  it('both combo + tap dance produce more pages than combo only', () => {
    const combos: ComboEntry[] = [
      { key1: 0x04, key2: 0x05, key3: 0, key4: 0, output: 0x29 },
    ]
    const tapDances: TapDanceEntry[] = [
      { onTap: 0x04, onHold: 0x05, onDoubleTap: 0x06, onTapHold: 0x29, tappingTerm: 200 },
    ]
    const comboOnly = generateKeymapPdf(createBasicInput({ combo: combos }))
    const both = generateKeymapPdf(createBasicInput({ combo: combos, tapDance: tapDances }))
    expect(countPages(both)).toBeGreaterThan(countPages(comboOnly))
  })

  it('empty keys with configured combos still generates combo pages', () => {
    const combos: ComboEntry[] = [
      { key1: 0x04, key2: 0x05, key3: 0, key4: 0, output: 0x29 },
    ]
    const base64 = generateKeymapPdf(createBasicInput({
      keys: [],
      keymap: new Map(),
      combo: combos,
    }))
    const bytes = decodePdf(base64)
    expect(pdfSignature(bytes)).toBe('%PDF-')
    // Should have at least 2 pages: empty keymap page + combo page
    expect(countPages(base64)).toBeGreaterThanOrEqual(2)
  })

  it('many entries cause pagination (40 combos, 30 tap dances)', () => {
    const combos: ComboEntry[] = Array.from({ length: 40 }, (_, i) => ({
      key1: 0x04, key2: 0x05 + (i % 3), key3: 0, key4: 0, output: 0x29,
    }))
    const tapDances: TapDanceEntry[] = Array.from({ length: 30 }, () => ({
      onTap: 0x04, onHold: 0x05, onDoubleTap: 0x06, onTapHold: 0x29, tappingTerm: 200,
    }))
    const base64 = generateKeymapPdf(createBasicInput({ combo: combos, tapDance: tapDances }))
    const bytes = decodePdf(base64)
    expect(pdfSignature(bytes)).toBe('%PDF-')
    // 1 layer + multiple combo pages + multiple TD pages
    expect(countPages(base64)).toBeGreaterThan(3)
  })
})

describe('isEmptyCombo', () => {
  it('returns true for all-zero entry', () => {
    expect(isEmptyCombo({ key1: 0, key2: 0, key3: 0, key4: 0, output: 0 })).toBe(true)
  })

  it('returns false when any key is set', () => {
    expect(isEmptyCombo({ key1: 0x04, key2: 0, key3: 0, key4: 0, output: 0 })).toBe(false)
    expect(isEmptyCombo({ key1: 0, key2: 0x05, key3: 0, key4: 0, output: 0 })).toBe(false)
    expect(isEmptyCombo({ key1: 0, key2: 0, key3: 0, key4: 0, output: 0x29 })).toBe(false)
  })

  it('returns false for a fully configured entry', () => {
    expect(isEmptyCombo({ key1: 0x04, key2: 0x05, key3: 0, key4: 0, output: 0x29 })).toBe(false)
  })
})

describe('isEmptyTapDance', () => {
  it('returns true for all-zero entry', () => {
    expect(isEmptyTapDance({ onTap: 0, onHold: 0, onDoubleTap: 0, onTapHold: 0, tappingTerm: 0 })).toBe(true)
  })

  it('returns false when any action is set', () => {
    expect(isEmptyTapDance({ onTap: 0x04, onHold: 0, onDoubleTap: 0, onTapHold: 0, tappingTerm: 0 })).toBe(false)
    expect(isEmptyTapDance({ onTap: 0, onHold: 0x05, onDoubleTap: 0, onTapHold: 0, tappingTerm: 0 })).toBe(false)
    expect(isEmptyTapDance({ onTap: 0, onHold: 0, onDoubleTap: 0x06, onTapHold: 0, tappingTerm: 0 })).toBe(false)
    expect(isEmptyTapDance({ onTap: 0, onHold: 0, onDoubleTap: 0, onTapHold: 0x29, tappingTerm: 0 })).toBe(false)
  })

  it('returns true when only tappingTerm is set (no actions)', () => {
    expect(isEmptyTapDance({ onTap: 0, onHold: 0, onDoubleTap: 0, onTapHold: 0, tappingTerm: 200 })).toBe(true)
  })

  it('returns false for a fully configured entry', () => {
    expect(isEmptyTapDance({ onTap: 0x04, onHold: 0x05, onDoubleTap: 0x06, onTapHold: 0x29, tappingTerm: 200 })).toBe(false)
  })
})

// ── Key Override tests ──────────────────────────────────────────────

function makeKo(overrides?: Partial<KeyOverrideEntry>): KeyOverrideEntry {
  return {
    triggerKey: 0, replacementKey: 0, layers: 0,
    triggerMods: 0, negativeMods: 0, suppressedMods: 0,
    options: 0, enabled: true, ...overrides,
  }
}

function makeAr(overrides?: Partial<AltRepeatKeyEntry>): AltRepeatKeyEntry {
  return {
    lastKey: 0, altKey: 0, allowedMods: 0, options: 0, enabled: true, ...overrides,
  }
}

describe('isEmptyKeyOverride', () => {
  it('returns true for all-zero entry', () => {
    expect(isEmptyKeyOverride(makeKo())).toBe(true)
  })

  it('returns false when triggerKey is set', () => {
    expect(isEmptyKeyOverride(makeKo({ triggerKey: 0x04 }))).toBe(false)
  })

  it('returns false when replacementKey is set', () => {
    expect(isEmptyKeyOverride(makeKo({ replacementKey: 0x05 }))).toBe(false)
  })
})

describe('isEmptyAltRepeatKey', () => {
  it('returns true for all-zero entry', () => {
    expect(isEmptyAltRepeatKey(makeAr())).toBe(true)
  })

  it('returns false when lastKey is set', () => {
    expect(isEmptyAltRepeatKey(makeAr({ lastKey: 0x04 }))).toBe(false)
  })

  it('returns false when altKey is set', () => {
    expect(isEmptyAltRepeatKey(makeAr({ altKey: 0x05 }))).toBe(false)
  })
})

describe('generateKeymapPdf - Key Override / Alt Repeat Key', () => {
  it('empty keyOverride/altRepeatKey arrays produce no extra pages', () => {
    const baseline = generateKeymapPdf(createBasicInput())
    const withEmpty = generateKeymapPdf(createBasicInput({
      keyOverride: [],
      altRepeatKey: [],
    }))
    expect(countPages(withEmpty)).toBe(countPages(baseline))
  })

  it('all-zero keyOverride entries are skipped', () => {
    const baseline = generateKeymapPdf(createBasicInput())
    const withZero = generateKeymapPdf(createBasicInput({
      keyOverride: [makeKo(), makeKo()],
    }))
    expect(countPages(withZero)).toBe(countPages(baseline))
  })

  it('all-zero altRepeatKey entries are skipped', () => {
    const baseline = generateKeymapPdf(createBasicInput())
    const withZero = generateKeymapPdf(createBasicInput({
      altRepeatKey: [makeAr(), makeAr()],
    }))
    expect(countPages(withZero)).toBe(countPages(baseline))
  })

  it('configured key overrides add extra pages', () => {
    const entries: KeyOverrideEntry[] = [
      makeKo({ triggerKey: 0x04, replacementKey: 0x05, triggerMods: 0x02, enabled: true }),
    ]
    const baseline = generateKeymapPdf(createBasicInput())
    const withKo = generateKeymapPdf(createBasicInput({ keyOverride: entries }))
    expect(countPages(withKo)).toBeGreaterThan(countPages(baseline))
  })

  it('configured alt repeat keys add extra pages', () => {
    const entries: AltRepeatKeyEntry[] = [
      makeAr({ lastKey: 0x04, altKey: 0x05, enabled: true }),
    ]
    const baseline = generateKeymapPdf(createBasicInput())
    const withAr = generateKeymapPdf(createBasicInput({ altRepeatKey: entries }))
    expect(countPages(withAr)).toBeGreaterThan(countPages(baseline))
  })

  it('disabled entries are still rendered (not skipped)', () => {
    const entries: KeyOverrideEntry[] = [
      makeKo({ triggerKey: 0x04, replacementKey: 0x05, enabled: false }),
    ]
    const baseline = generateKeymapPdf(createBasicInput())
    const withDisabled = generateKeymapPdf(createBasicInput({ keyOverride: entries }))
    expect(countPages(withDisabled)).toBeGreaterThan(countPages(baseline))
  })

  it('all four feature types together produce more pages than any alone', () => {
    const combos: ComboEntry[] = [{ key1: 0x04, key2: 0x05, key3: 0, key4: 0, output: 0x29 }]
    const tapDances: TapDanceEntry[] = [{ onTap: 0x04, onHold: 0x05, onDoubleTap: 0x06, onTapHold: 0x29, tappingTerm: 200 }]
    const keyOverrides: KeyOverrideEntry[] = [makeKo({ triggerKey: 0x04, replacementKey: 0x05 })]
    const altRepeatKeys: AltRepeatKeyEntry[] = [makeAr({ lastKey: 0x04, altKey: 0x05 })]

    const comboOnly = generateKeymapPdf(createBasicInput({ combo: combos }))
    const all = generateKeymapPdf(createBasicInput({
      combo: combos, tapDance: tapDances,
      keyOverride: keyOverrides, altRepeatKey: altRepeatKeys,
    }))
    expect(countPages(all)).toBeGreaterThan(countPages(comboOnly))
  })

  it('many key overrides cause pagination', () => {
    const entries = Array.from({ length: 30 }, (_, i) =>
      makeKo({ triggerKey: 0x04 + (i % 5), replacementKey: 0x29 }),
    )
    const base64 = generateKeymapPdf(createBasicInput({ keyOverride: entries }))
    expect(pdfSignature(decodePdf(base64))).toBe('%PDF-')
    // 1 layer + multiple KO pages
    expect(countPages(base64)).toBeGreaterThan(2)
  })
})

// ── Macro tests ────────────────────────────────────────────────────

describe('isEmptyMacro', () => {
  it('returns true for empty actions array', () => {
    expect(isEmptyMacro([])).toBe(true)
  })

  it('returns false for text action', () => {
    expect(isEmptyMacro([{ type: 'text', text: 'hello' }])).toBe(false)
  })

  it('returns false for tap action', () => {
    expect(isEmptyMacro([{ type: 'tap', keycodes: [0x04] }])).toBe(false)
  })

  it('returns false for delay action', () => {
    expect(isEmptyMacro([{ type: 'delay', delay: 500 }])).toBe(false)
  })
})

describe('generateKeymapPdf - Macros', () => {
  it('empty macros array produces no extra pages', () => {
    const baseline = generateKeymapPdf(createBasicInput())
    const withEmpty = generateKeymapPdf(createBasicInput({ macros: [] }))
    expect(countPages(withEmpty)).toBe(countPages(baseline))
  })

  it('all-empty macros are skipped (no extra pages)', () => {
    const baseline = generateKeymapPdf(createBasicInput())
    const withEmpty = generateKeymapPdf(createBasicInput({ macros: [[], []] }))
    expect(countPages(withEmpty)).toBe(countPages(baseline))
  })

  it('configured macros add extra pages', () => {
    const macros: PdfMacroAction[][] = [
      [{ type: 'text', text: 'Hello' }, { type: 'tap', keycodes: [0x04, 0x05] }],
    ]
    const baseline = generateKeymapPdf(createBasicInput())
    const withMacros = generateKeymapPdf(createBasicInput({ macros }))
    expect(countPages(withMacros)).toBeGreaterThan(countPages(baseline))
    expect(decodePdf(withMacros).length).toBeGreaterThan(decodePdf(baseline).length)
  })

  it('macros with all action types render correctly', () => {
    const macros: PdfMacroAction[][] = [
      [
        { type: 'text', text: 'Hello World' },
        { type: 'tap', keycodes: [0x04, 0x05] },
        { type: 'down', keycodes: [0x06] },
        { type: 'delay', delay: 500 },
        { type: 'up', keycodes: [0x06] },
      ],
    ]
    const base64 = generateKeymapPdf(createBasicInput({ macros }))
    expect(pdfSignature(decodePdf(base64))).toBe('%PDF-')
    expect(countPages(base64)).toBeGreaterThan(1)
  })

  it('all five feature types together produce more pages than four', () => {
    const combos: ComboEntry[] = [{ key1: 0x04, key2: 0x05, key3: 0, key4: 0, output: 0x29 }]
    const tapDances: TapDanceEntry[] = [{ onTap: 0x04, onHold: 0x05, onDoubleTap: 0x06, onTapHold: 0x29, tappingTerm: 200 }]
    const keyOverrides: KeyOverrideEntry[] = [makeKo({ triggerKey: 0x04, replacementKey: 0x05 })]
    const altRepeatKeys: AltRepeatKeyEntry[] = [makeAr({ lastKey: 0x04, altKey: 0x05 })]
    const macros: PdfMacroAction[][] = [[{ type: 'text', text: 'Hello' }]]

    const fourTypes = generateKeymapPdf(createBasicInput({
      combo: combos, tapDance: tapDances,
      keyOverride: keyOverrides, altRepeatKey: altRepeatKeys,
    }))
    const fiveTypes = generateKeymapPdf(createBasicInput({
      combo: combos, tapDance: tapDances,
      keyOverride: keyOverrides, altRepeatKey: altRepeatKeys,
      macros,
    }))
    expect(countPages(fiveTypes)).toBeGreaterThan(countPages(fourTypes))
  })

  it('many macros cause pagination', () => {
    const macros: PdfMacroAction[][] = Array.from({ length: 40 }, () => [
      { type: 'text', text: 'Hello World' },
      { type: 'tap', keycodes: [0x04] },
    ])
    const base64 = generateKeymapPdf(createBasicInput({ macros }))
    expect(pdfSignature(decodePdf(base64))).toBe('%PDF-')
    // 1 layer + multiple macro pages
    expect(countPages(base64)).toBeGreaterThan(2)
  })

  it('empty keys with configured macros still generates macro pages', () => {
    const macros: PdfMacroAction[][] = [
      [{ type: 'text', text: 'Hello' }],
    ]
    const base64 = generateKeymapPdf(createBasicInput({
      keys: [],
      keymap: new Map(),
      macros,
    }))
    expect(pdfSignature(decodePdf(base64))).toBe('%PDF-')
    expect(countPages(base64)).toBeGreaterThanOrEqual(2)
  })
})
