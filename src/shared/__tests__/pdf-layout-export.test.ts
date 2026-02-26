// SPDX-License-Identifier: GPL-2.0-or-later

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'
import type { KleKey } from '../kle/types'
import { parseLayoutLabels } from '../layout-options'
import { parseKle } from '../kle/kle-parser'
import { generateAllLayoutOptionsPdf, generateCurrentLayoutPdf, type LayoutPdfInput } from '../pdf-layout-export'

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

function decodePdf(base64: string): Uint8Array {
  return new Uint8Array(Buffer.from(base64, 'base64'))
}

function pdfSignature(bytes: Uint8Array): string {
  return new TextDecoder('ascii').decode(bytes.slice(0, 5))
}

/** Count pages in a PDF by counting /Type /Page occurrences (excluding /Type /Pages). */
function countPdfPages(bytes: Uint8Array): number {
  const text = new TextDecoder('latin1').decode(bytes)
  // Match "/Type /Page" not followed by "s" (to exclude "/Type /Pages")
  const matches = text.match(/\/Type\s+\/Page(?!s)/g)
  return matches ? matches.length : 0
}

/** Create a realistic-sized keyboard (5 rows × 15 columns = 75 keys). */
function makeRealisticKeys(): KleKey[] {
  const keys: KleKey[] = []
  for (let row = 0; row < 5; row++) {
    for (let col = 0; col < 15; col++) {
      keys.push(makeKey({ x: col, y: row, row, col }))
    }
  }
  return keys
}

function createBasicInput(overrides: Partial<LayoutPdfInput> = {}): LayoutPdfInput {
  return {
    deviceName: 'Test Keyboard',
    keys: makeRealisticKeys(),
    layoutOptions: [],
    currentValues: new Map(),
    ...overrides,
  }
}

describe('generateCurrentLayoutPdf', () => {
  it('returns valid PDF base64 for basic keys', () => {
    const result = generateCurrentLayoutPdf(createBasicInput())
    expect(typeof result).toBe('string')
    expect(result.length).toBeGreaterThan(0)
    const bytes = decodePdf(result)
    expect(pdfSignature(bytes)).toBe('%PDF-')
  })

  it('handles empty keys gracefully', () => {
    const result = generateCurrentLayoutPdf(createBasicInput({ keys: [] }))
    const bytes = decodePdf(result)
    expect(pdfSignature(bytes)).toBe('%PDF-')
  })

  it('filters keys by current layout options', () => {
    const keys: KleKey[] = [
      makeKey({ x: 0, y: 0, row: 0, col: 0 }),
      makeKey({ x: 1, y: 0, row: 0, col: 1, layoutIndex: 0, layoutOption: 0 }),
      makeKey({ x: 1, y: 0, row: 0, col: 2, layoutIndex: 0, layoutOption: 1 }),
    ]

    const result = generateCurrentLayoutPdf(createBasicInput({
      keys,
      currentValues: new Map([[0, 1]]),
    }))
    const bytes = decodePdf(result)
    expect(pdfSignature(bytes)).toBe('%PDF-')
    expect(bytes.length).toBeGreaterThan(1000)
  })
})

describe('generateAllLayoutOptionsPdf', () => {
  it('returns valid PDF for no layout options (falls back to current)', () => {
    const result = generateAllLayoutOptionsPdf(createBasicInput())
    const bytes = decodePdf(result)
    expect(pdfSignature(bytes)).toBe('%PDF-')
  })

  it('generates 1 page for a single boolean layout option', () => {
    const keys = makeRealisticKeys()
    // Add layout option keys: option 0 toggles between 2 key variants
    keys.push(makeKey({ x: 13, y: 4, row: 4, col: 13, layoutIndex: 0, layoutOption: 0 }))
    keys.push(makeKey({ x: 13, y: 4, row: 4, col: 14, width: 2, layoutIndex: 0, layoutOption: 1 }))

    const layoutOptions = parseLayoutLabels(['Split Backspace'])

    const result = generateAllLayoutOptionsPdf(createBasicInput({
      keys,
      layoutOptions,
      currentValues: new Map([[0, 0]]),
    }))
    const bytes = decodePdf(result)
    expect(pdfSignature(bytes)).toBe('%PDF-')
    // Boolean with 2 variants on a realistic keyboard fits on 1 page
    expect(countPdfPages(bytes)).toBe(1)
  })

  it('generates pages for select layout options', () => {
    const keys = makeRealisticKeys()
    keys.push(makeKey({ x: 0, y: 4, row: 4, col: 0, layoutIndex: 0, layoutOption: 0 }))
    keys.push(makeKey({ x: 0, y: 4, row: 4, col: 1, layoutIndex: 0, layoutOption: 1 }))
    keys.push(makeKey({ x: 0, y: 4, row: 4, col: 2, layoutIndex: 0, layoutOption: 2 }))

    const layoutOptions = parseLayoutLabels([['Bottom Row', '6.25U', '7U', 'Split']])

    const result = generateAllLayoutOptionsPdf(createBasicInput({
      keys,
      layoutOptions,
      currentValues: new Map([[0, 0]]),
    }))
    const bytes = decodePdf(result)
    expect(pdfSignature(bytes)).toBe('%PDF-')
    expect(bytes.length).toBeGreaterThan(1000)
  })

  it('handles mixed boolean and select options', () => {
    const keys = makeRealisticKeys()
    keys.push(makeKey({ x: 13, y: 0, row: 0, col: 13, layoutIndex: 0, layoutOption: 0 }))
    keys.push(makeKey({ x: 13, y: 0, row: 0, col: 14, width: 2, layoutIndex: 0, layoutOption: 1 }))
    keys.push(makeKey({ x: 0, y: 4, row: 4, col: 0, layoutIndex: 1, layoutOption: 0 }))
    keys.push(makeKey({ x: 0, y: 4, row: 4, col: 1, layoutIndex: 1, layoutOption: 1 }))
    keys.push(makeKey({ x: 0, y: 4, row: 4, col: 2, layoutIndex: 1, layoutOption: 2 }))

    const layoutOptions = parseLayoutLabels([
      'Split Backspace',
      ['Bottom Row', '6.25U', '7U', 'Split'],
    ])

    const result = generateAllLayoutOptionsPdf(createBasicInput({
      keys,
      layoutOptions,
      currentValues: new Map([[0, 0], [1, 0]]),
    }))
    const bytes = decodePdf(result)
    expect(pdfSignature(bytes)).toBe('%PDF-')
    // 2 layout options: boolean (2 variants → 1 page) + select (3 variants → 1-2 pages)
    expect(countPdfPages(bytes)).toBeGreaterThanOrEqual(2)
  })

  it('splits many-choice select option across multiple pages', () => {
    const keys = makeRealisticKeys()
    // 1 select option with 8 choices — too many for a single page
    const choiceKeys = Array.from({ length: 8 }, (_, i) =>
      makeKey({ x: i, y: 4, row: 4, col: i, layoutIndex: 0, layoutOption: i }),
    )
    keys.push(...choiceKeys)

    const layoutOptions = parseLayoutLabels([
      ['Gesture', 'A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'],
    ])

    const result = generateAllLayoutOptionsPdf(createBasicInput({
      keys,
      layoutOptions,
      currentValues: new Map([[0, 0]]),
    }))
    const bytes = decodePdf(result)
    expect(pdfSignature(bytes)).toBe('%PDF-')
    // 8 choices on a realistic keyboard should split across multiple pages
    expect(countPdfPages(bytes)).toBeGreaterThan(1)
  })
})

describe('generateAllLayoutOptionsPdf with e2e fixture', () => {
  function loadFixtureInput(): LayoutPdfInput {
    const fixturePath = join(__dirname, '../../..', 'e2e/fixtures/e2e_test_001_32layers.json')
    const fixture = JSON.parse(readFileSync(fixturePath, 'utf-8'))
    const parsedLayout = parseKle(fixture.layouts.keymap)
    const layoutOptions = parseLayoutLabels(fixture.layouts.labels)
    const currentValues = new Map<number, number>()
    for (let i = 0; i < layoutOptions.length; i++) {
      currentValues.set(i, 0)
    }
    return {
      deviceName: fixture.name,
      keys: parsedLayout.keys,
      layoutOptions,
      currentValues,
    }
  }

  it('generates valid PDF from 32-layer test fixture', () => {
    const input = loadFixtureInput()
    const result = generateAllLayoutOptionsPdf(input)
    const bytes = decodePdf(result)
    expect(pdfSignature(bytes)).toBe('%PDF-')
    // At least 1 page per option; select options with many choices may split across pages
    expect(countPdfPages(bytes)).toBeGreaterThanOrEqual(input.layoutOptions.length)
  })

  it('generates valid current layout PDF from 32-layer test fixture', () => {
    const result = generateCurrentLayoutPdf(loadFixtureInput())
    const bytes = decodePdf(result)
    expect(pdfSignature(bytes)).toBe('%PDF-')
    expect(bytes.length).toBeGreaterThan(1000)
  })

  it('current layout PDF header contains select option choices (all defaults = 0)', () => {
    const input = loadFixtureInput()
    const result = generateCurrentLayoutPdf(input)
    const bytes = decodePdf(result)
    const text = new TextDecoder('latin1').decode(bytes)
    // With all values = 0: booleans are OFF (skipped), selects show first choice
    // Expected select entries: "Bottom Section: Full Grid (3 rows)", "Top Row: ANSI", etc.
    expect(text).toContain('Bottom Section')
    expect(text).toContain('Top Row')
    // Boolean options (val=0 = OFF) should NOT appear in header
    expect(text).not.toMatch(/\(Macro Pad\)/)  // Macro Pad is boolean, should be excluded
  })
})

describe('generateCurrentLayoutPdf header text', () => {
  it('shows select choices and active booleans in header (dummy keyboard scenario)', () => {
    const keys = makeRealisticKeys()
    // Boolean (index 0): "Split Backspace"
    keys.push(makeKey({ x: 13, y: 0, row: 0, col: 13, layoutIndex: 0, layoutOption: 0 }))
    keys.push(makeKey({ x: 13, y: 0, row: 0, col: 14, width: 2, layoutIndex: 0, layoutOption: 1 }))
    // Select (index 1): "Bottom Row" with choices "6.25U", "7U", "Split"
    keys.push(makeKey({ x: 0, y: 4, row: 4, col: 0, layoutIndex: 1, layoutOption: 0 }))
    keys.push(makeKey({ x: 0, y: 4, row: 4, col: 1, layoutIndex: 1, layoutOption: 1 }))
    keys.push(makeKey({ x: 0, y: 4, row: 4, col: 2, layoutIndex: 1, layoutOption: 2 }))

    const layoutOptions = parseLayoutLabels([
      'Split Backspace',
      ['Bottom Row', '6.25U', '7U', 'Split'],
    ])

    // Simulate dummy keyboard: all values = 0 (boolean OFF, first select choice)
    const currentValues = new Map<number, number>([[0, 0], [1, 0]])
    const result = generateCurrentLayoutPdf({
      deviceName: 'Dummy Keyboard',
      keys,
      layoutOptions,
      currentValues,
    })
    const bytes = decodePdf(result)
    const text = new TextDecoder('latin1').decode(bytes)
    // Header should contain "Bottom Row: 6.25U" (select with first choice)
    // Boolean OFF is skipped, so "Split Backspace" should NOT appear
    expect(text).toContain('Bottom Row: 6.25U')
    expect(text).not.toMatch(/Split Backspace/)
  })

  it('includes active boolean names in header', () => {
    const keys = makeRealisticKeys()
    keys.push(makeKey({ x: 13, y: 0, row: 0, col: 13, layoutIndex: 0, layoutOption: 0 }))
    keys.push(makeKey({ x: 13, y: 0, row: 0, col: 14, width: 2, layoutIndex: 0, layoutOption: 1 }))
    keys.push(makeKey({ x: 0, y: 4, row: 4, col: 0, layoutIndex: 1, layoutOption: 0 }))
    keys.push(makeKey({ x: 0, y: 4, row: 4, col: 1, layoutIndex: 1, layoutOption: 1 }))
    keys.push(makeKey({ x: 0, y: 4, row: 4, col: 2, layoutIndex: 1, layoutOption: 2 }))

    const layoutOptions = parseLayoutLabels([
      'Split Backspace',
      ['Bottom Row', '6.25U', '7U', 'Split'],
    ])

    // Boolean ON (val=1), select second choice (val=1 → "7U")
    const currentValues = new Map<number, number>([[0, 1], [1, 1]])
    const result = generateCurrentLayoutPdf({
      deviceName: 'Test Keyboard',
      keys,
      layoutOptions,
      currentValues,
    })
    const bytes = decodePdf(result)
    const text = new TextDecoder('latin1').decode(bytes)
    // Header should contain both: "Split Backspace / Bottom Row: 7U"
    expect(text).toContain('Split Backspace')
    expect(text).toContain('Bottom Row: 7U')
  })

  it('falls back to device name when all booleans are OFF and no selects', () => {
    const keys = makeRealisticKeys()
    keys.push(makeKey({ x: 13, y: 0, row: 0, col: 13, layoutIndex: 0, layoutOption: 0 }))
    keys.push(makeKey({ x: 13, y: 0, row: 0, col: 14, width: 2, layoutIndex: 0, layoutOption: 1 }))

    const layoutOptions = parseLayoutLabels(['Split Backspace'])
    const currentValues = new Map<number, number>([[0, 0]])
    const result = generateCurrentLayoutPdf({
      deviceName: 'My Keyboard',
      keys,
      layoutOptions,
      currentValues,
    })
    const bytes = decodePdf(result)
    const text = new TextDecoder('latin1').decode(bytes)
    // Only boolean options, all OFF → falls back to device name
    expect(text).toContain('My Keyboard')
  })
})
