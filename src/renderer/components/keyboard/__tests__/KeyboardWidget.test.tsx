// SPDX-License-Identifier: GPL-2.0-or-later
// @vitest-environment jsdom

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it, expect, vi } from 'vitest'
import { render } from '@testing-library/react'
import { KeyboardWidget } from '../KeyboardWidget'
import { KEY_UNIT, KEY_SPACING, KEY_SIZE_RATIO, KEY_SPACING_RATIO, KEYBOARD_PADDING, KEY_TEXT_COLOR, KEY_REMAP_COLOR, keyLabelFontSize } from '../constants'
import { buildMatrixWires, rowLabelPitch, colLabelPitch } from '../matrix-wires'
import { parseKle } from '../../../../shared/kle/kle-parser'
import { posKey } from '../../../../shared/kle/pos-key'
import { rotatePoint } from '../../../../shared/kle/rotate-point'
import type { KleKey } from '../../../../shared/kle/types'
import { makeKey } from './kle-test-keys'

vi.mock('../../../../shared/keycodes/keycodes', () => ({
  keycodeLabel: (kc: string) => kc,
  isMask: () => false,
  findOuterKeycode: () => ({ qmkId: 'LT0' }),
  findInnerKeycode: () => ({ qmkId: 'KC_A' }),
}))

describe('rotatePoint', () => {
  it('returns same point when angle is 0', () => {
    const [rx, ry] = rotatePoint(10, 20, 0, 0, 0)
    expect(rx).toBeCloseTo(10)
    expect(ry).toBeCloseTo(20)
  })

  it('rotates 90 degrees around origin', () => {
    const [rx, ry] = rotatePoint(1, 0, 90, 0, 0)
    expect(rx).toBeCloseTo(0)
    expect(ry).toBeCloseTo(1)
  })

  it('rotates around a custom center', () => {
    // Rotate (2,0) by 90 degrees around (1,0) => (1,1)
    const [rx, ry] = rotatePoint(2, 0, 90, 1, 0)
    expect(rx).toBeCloseTo(1)
    expect(ry).toBeCloseTo(1)
  })

  it('rotates 180 degrees', () => {
    const [rx, ry] = rotatePoint(3, 0, 180, 0, 0)
    expect(rx).toBeCloseTo(-3)
    expect(ry).toBeCloseTo(0)
  })

  it('rotates negative angle', () => {
    // -90 degrees: (0,1) around origin => (1,0)
    const [rx, ry] = rotatePoint(0, 1, -90, 0, 0)
    expect(rx).toBeCloseTo(1)
    expect(ry).toBeCloseTo(0)
  })
})

describe('KeyboardWidget bounds with rotation', () => {
  it('viewBox includes rotated key positions', () => {
    // A key at (3,0) rotated 90 degrees around origin (0,0)
    // should move to roughly (0,3) area
    const keys: KleKey[] = [
      makeKey({ x: 0, y: 0, row: 0, col: 0 }),
      makeKey({ x: 3, y: 0, row: 0, col: 1, rotation: 90 }),
    ]

    const { container } = render(
      <KeyboardWidget keys={keys} keycodes={new Map([['0,0', 'KC_A'], ['0,1', 'KC_B']])} />,
    )
    const svg = container.querySelector('svg')!
    const viewBox = svg.getAttribute('viewBox')!
    const [, , , vbH] = viewBox.split(' ').map(Number)

    // The rotated key at (3,0) with 90deg rotation around origin
    // should push the bottom of the viewBox well past KEY_UNIT * 1
    // Rotated top-right corner: (s*(3+1)-spacing, 0) rotated 90 => (0, s*4-spacing)
    expect(vbH).toBeGreaterThan(KEY_UNIT * 3)
  })

  it('non-rotated keys produce tight bounds', () => {
    const keys: KleKey[] = [
      makeKey({ x: 0, y: 0, row: 0, col: 0 }),
      makeKey({ x: 1, y: 0, row: 0, col: 1 }),
    ]

    const { container } = render(
      <KeyboardWidget keys={keys} keycodes={new Map([['0,0', 'KC_A'], ['0,1', 'KC_B']])} />,
    )
    const svg = container.querySelector('svg')!
    const viewBox = svg.getAttribute('viewBox')!
    const [, , vbW, vbH] = viewBox.split(' ').map(Number)

    const s = KEY_UNIT
    const spacing = KEY_SPACING
    const pad2 = KEYBOARD_PADDING * 2
    const expectedW = s * 2 - spacing + pad2
    const expectedH = s * 1 - spacing + pad2
    expect(vbW).toBeCloseTo(expectedW)
    expect(vbH).toBeCloseTo(expectedH)
  })

  it('handles split keyboard with opposing rotations', () => {
    // Simulate a split layout: left half rotated +15, right half rotated -15
    const keys: KleKey[] = [
      makeKey({ x: 0, y: 0, row: 0, col: 0, rotation: 15 }),
      makeKey({ x: 5, y: 0, row: 0, col: 1, rotation: -15, rotationX: 6 }),
    ]

    const { container } = render(
      <KeyboardWidget keys={keys} keycodes={new Map([['0,0', 'KC_A'], ['0,1', 'KC_B']])} />,
    )
    const svg = container.querySelector('svg')!
    const viewBox = svg.getAttribute('viewBox')!
    const [, , vbW, vbH] = viewBox.split(' ').map(Number)

    // Non-rotated baseline: 2 keys spanning x=0..6 => width ~ 6*KEY_UNIT
    const s = KEY_UNIT
    const spacing = KEY_SPACING
    const pad2 = KEYBOARD_PADDING * 2
    const unrotatedW = s * 6 - spacing + pad2
    const unrotatedH = s * 1 - spacing + pad2

    // Rotation expands the bounds beyond the unrotated baseline
    expect(vbW).toBeGreaterThan(unrotatedW)
    expect(vbH).toBeGreaterThan(unrotatedH)
  })
})

describe('KeyboardWidget decal handling', () => {
  it('does not render keys flagged as decal', () => {
    const keys: KleKey[] = [
      makeKey({ x: 0, y: 0, row: 0, col: 0 }),
      makeKey({ x: 1, y: 0, row: 0, col: 1, decal: true }),
      makeKey({ x: 2, y: 0, row: 0, col: 2 }),
    ]

    const { container } = render(
      <KeyboardWidget
        keys={keys}
        keycodes={new Map([['0,0', 'KC_A'], ['0,1', 'KC_B'], ['0,2', 'KC_C']])}
      />,
    )
    const svg = container.querySelector('svg')!
    const renderedKeyGroups = svg.querySelectorAll(':scope > g')
    expect(renderedKeyGroups.length).toBe(2)
  })

  // Regression for issue #129: MB-44 defines its bottom-row Blocker via the
  // KLE `d: true` flag. The widget must skip those keys instead of rendering
  // them as a small unlabelled cap.
  it('does not render Blocker decal from MB-44 fixture (issue #129)', () => {
    const fixturePath = join(
      __dirname,
      '../../../../..',
      'e2e/fixtures/e2e_test_decal_blocker.json',
    )
    const fixture = JSON.parse(readFileSync(fixturePath, 'utf-8')) as {
      layouts: { keymap: unknown[][] }
    }
    const layout = parseKle(fixture.layouts.keymap)

    const decalCount = layout.keys.filter((k) => k.decal).length
    expect(decalCount).toBeGreaterThan(0)
    const expectedVisible = layout.keys.length - decalCount

    const keycodesMap = new Map<string, string>()
    for (const k of layout.keys) {
      keycodesMap.set(`${k.row},${k.col}`, 'KC_A')
    }

    const { container } = render(
      <KeyboardWidget keys={layout.keys} keycodes={keycodesMap} />,
    )
    const svg = container.querySelector('svg')!
    const renderedKeyGroups = svg.querySelectorAll(':scope > g')
    expect(renderedKeyGroups.length).toBe(expectedVisible)
  })
})

// Regression test: KEY_SPACING must match Python's spacing/size ratio (0.2/3.4 ≈ 5.88%)
it('KEY_SPACING matches Python vial-gui ratio', () => {
  const expected = KEY_UNIT * KEY_SPACING_RATIO / (KEY_SIZE_RATIO + KEY_SPACING_RATIO)
  expect(KEY_SPACING).toBeCloseTo(expected)
  expect(KEY_SPACING / KEY_UNIT).toBeCloseTo(0.0588, 3)
})

describe('KeyboardWidget flash threading', () => {
  const keys: KleKey[] = [
    makeKey({ x: 0, y: 0, row: 0, col: 0 }),
    makeKey({ x: 1, y: 0, row: -1, col: -1, encoderIdx: 0, encoderDir: 0 }),
  ]
  const keycodes = new Map([['0,0', 'KC_A']])
  const encoderKeycodes = new Map<string, [string, string]>([['0', ['KC_B', 'KC_NO']]])

  it('flashes the encoder when its "idx,dir" position is in flash.encoders', () => {
    const { container } = render(
      <KeyboardWidget
        keys={keys}
        keycodes={keycodes}
        encoderKeycodes={encoderKeycodes}
        flash={{ keys: new Set(), encoders: new Set(['0,0']), generation: 1, startedAt: Date.now() }}
      />,
    )
    expect(container.querySelector('[data-testid="flash-overlay"]')).not.toBeNull()
  })

  it('does not flash the encoder when its position is absent from flash.encoders', () => {
    const { container } = render(
      <KeyboardWidget
        keys={keys}
        keycodes={keycodes}
        encoderKeycodes={encoderKeycodes}
        // `1,0` doesn't match the rendered encoder's own `idx=0,dir=0` —
        // a non-empty `encoders` set that just doesn't cover this position.
        flash={{ keys: new Set(), encoders: new Set(['1,0']), generation: 1, startedAt: Date.now() }}
      />,
    )
    expect(container.querySelector('[data-testid="flash-overlay"]')).toBeNull()
  })
})

// Plan-qwerty-select-no-rewrite "also" follow-up: encoder CW/CCW legends
// gained the same remap tint keymap keys already have.
describe('KeyboardWidget remappedEncoders threading', () => {
  const keys: KleKey[] = [
    makeKey({ x: 0, y: 0, row: -1, col: -1, encoderIdx: 0, encoderDir: 0 }),
  ]
  const encoderKeycodes = new Map<string, [string, string]>([['0', ['KC_B', 'KC_NO']]])

  it('tints the encoder label when its "idx,dir" position is in remappedEncoders', () => {
    const { container } = render(
      <KeyboardWidget
        keys={keys}
        keycodes={new Map()}
        encoderKeycodes={encoderKeycodes}
        remappedEncoders={new Set(['0,0'])}
      />,
    )
    const text = container.querySelector('text')!
    expect(text.getAttribute('fill')).toBe(KEY_REMAP_COLOR)
  })

  it('does not tint the encoder label when its position is absent from remappedEncoders', () => {
    const { container } = render(
      <KeyboardWidget
        keys={keys}
        keycodes={new Map()}
        encoderKeycodes={encoderKeycodes}
        remappedEncoders={new Set(['1,0'])}
      />,
    )
    const text = container.querySelector('text')!
    expect(text.getAttribute('fill')).toBe(KEY_TEXT_COLOR)
  })

  it('does not tint when remappedEncoders is absent', () => {
    const { container } = render(
      <KeyboardWidget keys={keys} keycodes={new Map()} encoderKeycodes={encoderKeycodes} />,
    )
    const text = container.querySelector('text')!
    expect(text.getAttribute('fill')).toBe(KEY_TEXT_COLOR)
  })
})

describe('KeyboardWidget matrixWires prop', () => {
  const keys: KleKey[] = [
    makeKey({ x: 0, y: 0, row: 0, col: 0 }),
    makeKey({ x: 1, y: 0, row: 0, col: 1 }),
  ]
  const keycodes = new Map([['0,0', 'KC_A'], ['0,1', 'KC_B']])
  const scale = 1
  const s = KEY_UNIT * scale
  const spacing = KEY_SPACING * scale
  const pad2 = KEYBOARD_PADDING * 2
  // Same formulas KeyboardWidget itself uses: fontSize is the shared label
  // clamp, and each axis's gutter is the larger of half a key unit or
  // that axis's own stacked label lines (from buildMatrixWires, using this
  // fixture's actual keys/matrixWires) plus one fontSize of breathing room.
  const expectedFontSize = keyLabelFontSize(scale)
  const matrixWiresForBoundsTest = new Map([
    [posKey(0, 0), { row: 0, col: 0 }],
    [posKey(0, 1), { row: 0, col: 1 }],
  ])
  const expectedLayout = buildMatrixWires(keys, matrixWiresForBoundsTest, scale, expectedFontSize)
  const expectedGutterLeft = Math.max(
    KEY_UNIT * 0.5 * scale,
    expectedLayout.rowLineCount * rowLabelPitch(expectedFontSize) + expectedFontSize,
  )
  const expectedGutterTop = Math.max(
    KEY_UNIT * 0.5 * scale,
    expectedLayout.colLineCount * colLabelPitch(expectedFontSize) + expectedFontSize,
  )

  it('leaves bounds numerically identical to the no-overlay case when matrixWires is undefined', () => {
    const { container } = render(<KeyboardWidget keys={keys} keycodes={keycodes} scale={scale} />)
    const svg = container.querySelector('svg')!
    const [originX, originY, width, height] = svg.getAttribute('viewBox')!.split(' ').map(Number)
    expect(originX).toBeCloseTo(-KEYBOARD_PADDING)
    expect(originY).toBeCloseTo(-KEYBOARD_PADDING)
    expect(width).toBeCloseTo(s * 2 - spacing + pad2)
    expect(height).toBeCloseTo(s * 1 - spacing + pad2)
    expect(container.querySelector('[data-testid="matrix-wires"]')).toBeNull()
  })

  it('grows the bounds by each axis\'s own gutter (left horizontally, top vertically) when matrixWires is provided', () => {
    const { container } = render(
      <KeyboardWidget keys={keys} keycodes={keycodes} scale={scale} matrixWires={matrixWiresForBoundsTest} />,
    )
    const svg = container.querySelector('svg')!
    const [originX, originY, width, height] = svg.getAttribute('viewBox')!.split(' ').map(Number)
    expect(originX).toBeCloseTo(-KEYBOARD_PADDING - expectedGutterLeft)
    expect(originY).toBeCloseTo(-KEYBOARD_PADDING - expectedGutterTop)
    expect(width).toBeCloseTo(s * 2 - spacing + pad2 + expectedGutterLeft * 2)
    expect(height).toBeCloseTo(s * 1 - spacing + pad2 + expectedGutterTop * 2)
  })

  it('renders the matrix-wires overlay as the last child of the svg', () => {
    const { container } = render(
      <KeyboardWidget keys={keys} keycodes={keycodes} scale={scale} matrixWires={matrixWiresForBoundsTest} />,
    )
    const svg = container.querySelector('svg')!
    const lastChild = svg.lastElementChild!
    expect(lastChild.getAttribute('data-testid')).toBe('matrix-wires')
  })
})
