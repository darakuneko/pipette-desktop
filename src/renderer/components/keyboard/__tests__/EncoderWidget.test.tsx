// SPDX-License-Identifier: GPL-2.0-or-later
// @vitest-environment jsdom

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render } from '@testing-library/react'
import { EncoderWidget } from '../EncoderWidget'
import { KEY_REMAP_COLOR, KEY_TEXT_COLOR } from '../constants'
import type { KleKey } from '../../../../shared/kle/types'

let mockIsMask = false

vi.mock('../../../../shared/keycodes/keycodes', () => ({
  keycodeLabel: (kc: string) => kc,
  isMask: () => mockIsMask,
  findInnerKeycodeText: () => 'KC_A',
}))

function makeEncoderKey(overrides: Partial<KleKey> = {}): KleKey {
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
    encoderIdx: 0,
    encoderDir: 0,
    layoutIndex: -1,
    layoutOption: -1,
    decal: false,
    nub: false,
    stepped: false,
    ghost: false,
    ...overrides,
  }
}

describe('EncoderWidget remap colors', () => {
  beforeEach(() => {
    mockIsMask = false
  })

  it('marks only inner label in remap color for masked encoder keycodes', () => {
    mockIsMask = true
    const { container } = render(
      <svg>
        <EncoderWidget kleKey={makeEncoderKey()} keycode="LT0(KC_A)" remapped />
      </svg>,
    )
    const texts = container.querySelectorAll('text')
    expect(texts[0].getAttribute('fill')).toBe(KEY_TEXT_COLOR)
    expect(texts[1].getAttribute('fill')).toBe(KEY_REMAP_COLOR)
  })
})
