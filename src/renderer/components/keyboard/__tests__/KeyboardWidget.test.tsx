// SPDX-License-Identifier: GPL-2.0-or-later
// @vitest-environment jsdom

import { describe, it, expect, vi } from 'vitest'
import { render } from '@testing-library/react'
import { rotatePoint, KeyboardWidget } from '../KeyboardWidget'
import { KEY_UNIT, KEY_SPACING, KEYBOARD_PADDING } from '../constants'
import type { KleKey } from '../../../../shared/kle/types'

vi.mock('../../../../shared/keycodes/keycodes', () => ({
  keycodeLabel: (kc: string) => kc,
  isMask: () => false,
  findOuterKeycode: () => ({ qmkId: 'LT0' }),
  findInnerKeycode: () => ({ qmkId: 'KC_A' }),
}))

function makeKey(overrides: Partial<KleKey> = {}): KleKey {
  return {
    x: 0,
    y: 0,
    width: 1,
    height: 1,
    x2: 0,
    y2: 0,
    width2: 1,
    height2: 1,
    rotation: 0,
    rotationX: 0,
    rotationY: 0,
    color: '',
    labels: [],
    textColor: [],
    textSize: [],
    row: 0,
    col: 0,
    encoderIdx: -1,
    encoderDir: -1,
    layoutIndex: -1,
    layoutOption: -1,
    decal: false,
    nub: false,
    stepped: false,
    ghost: false,
    ...overrides,
  }
}

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
