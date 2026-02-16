// SPDX-License-Identifier: GPL-2.0-or-later
// @vitest-environment jsdom

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, fireEvent } from '@testing-library/react'
import { KeyWidget } from '../KeyWidget'
import {
  KEY_BG_COLOR,
  KEY_SELECTED_COLOR,
  KEY_PRESSED_COLOR,
  KEY_EVER_PRESSED_COLOR,
  KEY_HIGHLIGHT_COLOR,
  KEY_BORDER_COLOR,
  KEY_MASK_RECT_COLOR,
  KEY_TEXT_COLOR,
} from '../constants'
import type { KleKey } from '../../../../shared/kle/types'

let mockIsMask = false

vi.mock('../../../../shared/keycodes/keycodes', () => ({
  keycodeLabel: (kc: string) => kc,
  isMask: () => mockIsMask,
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

describe('KeyWidget', () => {
  beforeEach(() => {
    mockIsMask = false
  })

  it('renders default fill when no state props set', () => {
    const { container } = render(
      <svg>
        <KeyWidget kleKey={makeKey()} keycode="KC_A" />
      </svg>,
    )
    const rect = container.querySelector('rect')!
    expect(rect.getAttribute('fill')).toBe(KEY_BG_COLOR)
  })

  it('renders highlighted fill when highlighted=true', () => {
    const { container } = render(
      <svg>
        <KeyWidget kleKey={makeKey()} keycode="KC_A" highlighted />
      </svg>,
    )
    const rect = container.querySelector('rect')!
    expect(rect.getAttribute('fill')).toBe(KEY_HIGHLIGHT_COLOR)
  })

  it('renders inverse text color when highlighted=true', () => {
    const { container } = render(
      <svg>
        <KeyWidget kleKey={makeKey()} keycode="KC_A" highlighted />
      </svg>,
    )
    const text = container.querySelector('text')!
    expect(text.getAttribute('fill')).toBe('var(--content-inverse)')
  })

  it('renders pressed color over highlighted (pressed takes priority)', () => {
    const { container } = render(
      <svg>
        <KeyWidget kleKey={makeKey()} keycode="KC_A" pressed highlighted />
      </svg>,
    )
    const rect = container.querySelector('rect')!
    expect(rect.getAttribute('fill')).toBe(KEY_PRESSED_COLOR)
  })

  it('does not invert text when pressed overrides highlighted', () => {
    const { container } = render(
      <svg>
        <KeyWidget kleKey={makeKey()} keycode="KC_A" pressed highlighted />
      </svg>,
    )
    const text = container.querySelector('text')!
    expect(text.getAttribute('fill')).toBe('var(--key-label)')
  })

  it('renders selected color over highlighted (selected takes priority)', () => {
    const { container } = render(
      <svg>
        <KeyWidget kleKey={makeKey()} keycode="KC_A" selected highlighted />
      </svg>,
    )
    const rect = container.querySelector('rect')!
    expect(rect.getAttribute('fill')).toBe(KEY_SELECTED_COLOR)
  })

  it('renders highlighted color over everPressed', () => {
    const { container } = render(
      <svg>
        <KeyWidget kleKey={makeKey()} keycode="KC_A" highlighted everPressed />
      </svg>,
    )
    const rect = container.querySelector('rect')!
    expect(rect.getAttribute('fill')).toBe(KEY_HIGHLIGHT_COLOR)
  })

  it('renders everPressed color when only everPressed=true', () => {
    const { container } = render(
      <svg>
        <KeyWidget kleKey={makeKey()} keycode="KC_A" everPressed />
      </svg>,
    )
    const rect = container.querySelector('rect')!
    expect(rect.getAttribute('fill')).toBe(KEY_EVER_PRESSED_COLOR)
  })

  describe('masked key split-click', () => {
    it('renders inner rect for masked key', () => {
      mockIsMask = true
      const { container } = render(
        <svg>
          <KeyWidget kleKey={makeKey()} keycode="LT0(KC_A)" />
        </svg>,
      )
      const innerRect = container.querySelector('[data-testid="mask-inner-rect"]')
      expect(innerRect).not.toBeNull()
      expect(innerRect!.getAttribute('fill')).toBe(KEY_MASK_RECT_COLOR)
    })

    it('does not render inner rect for non-masked key', () => {
      mockIsMask = false
      const { container } = render(
        <svg>
          <KeyWidget kleKey={makeKey()} keycode="KC_A" />
        </svg>,
      )
      const innerRect = container.querySelector('[data-testid="mask-inner-rect"]')
      expect(innerRect).toBeNull()
    })

    it('calls onClick with maskClicked=true when inner rect is clicked', () => {
      mockIsMask = true
      const handleClick = vi.fn()
      const key = makeKey({ row: 1, col: 2 })
      const { container } = render(
        <svg>
          <KeyWidget kleKey={key} keycode="LT0(KC_A)" onClick={handleClick} />
        </svg>,
      )
      const innerRect = container.querySelector('[data-testid="mask-inner-rect"]')!
      fireEvent.click(innerRect)
      expect(handleClick).toHaveBeenCalledTimes(1)
      expect(handleClick).toHaveBeenCalledWith(key, true, { ctrlKey: false, shiftKey: false })
    })

    it('calls onClick with maskClicked=false when outer area is clicked', () => {
      mockIsMask = true
      const handleClick = vi.fn()
      const key = makeKey({ row: 1, col: 2 })
      const { container } = render(
        <svg>
          <KeyWidget kleKey={key} keycode="LT0(KC_A)" onClick={handleClick} />
        </svg>,
      )
      // Click the <g> element (outer area)
      const g = container.querySelector('g')!
      fireEvent.click(g)
      expect(handleClick).toHaveBeenCalledTimes(1)
      expect(handleClick).toHaveBeenCalledWith(key, false, { ctrlKey: false, shiftKey: false })
    })

    it('calls onClick with maskClicked=false for non-masked key', () => {
      mockIsMask = false
      const handleClick = vi.fn()
      const key = makeKey({ row: 0, col: 0 })
      const { container } = render(
        <svg>
          <KeyWidget kleKey={key} keycode="KC_A" onClick={handleClick} />
        </svg>,
      )
      const g = container.querySelector('g')!
      fireEvent.click(g)
      expect(handleClick).toHaveBeenCalledWith(key, false, { ctrlKey: false, shiftKey: false })
    })

    it('passes modifier keys from click event', () => {
      mockIsMask = false
      const handleClick = vi.fn()
      const key = makeKey({ row: 0, col: 0 })
      const { container } = render(
        <svg>
          <KeyWidget kleKey={key} keycode="KC_A" onClick={handleClick} />
        </svg>,
      )
      const g = container.querySelector('g')!
      fireEvent.click(g, { ctrlKey: true, shiftKey: false })
      expect(handleClick).toHaveBeenCalledWith(key, false, { ctrlKey: true, shiftKey: false })
    })

    it('calls onDoubleClick with maskClicked=true on inner rect double-click', () => {
      mockIsMask = true
      const handleDoubleClick = vi.fn()
      const key = makeKey({ row: 1, col: 3 })
      const { container } = render(
        <svg>
          <KeyWidget kleKey={key} keycode="LT0(KC_A)" onDoubleClick={handleDoubleClick} />
        </svg>,
      )
      const innerRect = container.querySelector('[data-testid="mask-inner-rect"]')!
      fireEvent.doubleClick(innerRect)
      expect(handleDoubleClick).toHaveBeenCalledTimes(1)
      expect(handleDoubleClick.mock.calls[0][0]).toBe(key)
      expect(handleDoubleClick.mock.calls[0][2]).toBe(true)
    })

    it('shows accent border only on inner rect when selectedMaskPart=true', () => {
      mockIsMask = true
      const { container } = render(
        <svg>
          <KeyWidget kleKey={makeKey()} keycode="LT0(KC_A)" selected selectedMaskPart={true} />
        </svg>,
      )
      const innerRect = container.querySelector('[data-testid="mask-inner-rect"]')!
      expect(innerRect.getAttribute('stroke')).toBe(KEY_SELECTED_COLOR)
      expect(innerRect.getAttribute('stroke-width')).toBe('2')
      // Outer rect is fully default (no accent, no fill)
      const outerRect = container.querySelector('rect:not([data-testid])')!
      expect(outerRect.getAttribute('stroke')).toBe(KEY_BORDER_COLOR)
      expect(outerRect.getAttribute('fill')).toBe(KEY_BG_COLOR)
    })

    it('shows accent border on outer rect when selectedMaskPart=false', () => {
      mockIsMask = true
      const { container } = render(
        <svg>
          <KeyWidget kleKey={makeKey()} keycode="LT0(KC_A)" selected selectedMaskPart={false} />
        </svg>,
      )
      const outerRect = container.querySelector('rect:not([data-testid])')!
      expect(outerRect.getAttribute('stroke')).toBe(KEY_SELECTED_COLOR)
      expect(outerRect.getAttribute('stroke-width')).toBe('2')
      // Inner rect should NOT have accent border
      const innerRect = container.querySelector('[data-testid="mask-inner-rect"]')!
      expect(innerRect.getAttribute('stroke')).toBe(KEY_BORDER_COLOR)
    })

    it('uses normal text color for inner label even when outer is selected', () => {
      mockIsMask = true
      const { container } = render(
        <svg>
          <KeyWidget kleKey={makeKey()} keycode="LT0(KC_A)" selected selectedMaskPart={false} />
        </svg>,
      )
      const texts = container.querySelectorAll('text')
      // Outer label uses inverted color (on blue fill)
      expect(texts[0].getAttribute('fill')).toBe('var(--content-inverse)')
      // Inner label always uses normal color (on inner rect bg)
      expect(texts[1].getAttribute('fill')).toBe(KEY_TEXT_COLOR)
    })

    it('uses normal text color for both labels when inner is selected (no fill inversion)', () => {
      mockIsMask = true
      const { container } = render(
        <svg>
          <KeyWidget kleKey={makeKey()} keycode="LT0(KC_A)" selected selectedMaskPart={true} />
        </svg>,
      )
      const texts = container.querySelectorAll('text')
      // Both labels use normal text color since outer has no fill
      expect(texts[0].getAttribute('fill')).toBe(KEY_TEXT_COLOR)
      expect(texts[1].getAttribute('fill')).toBe(KEY_TEXT_COLOR)
    })

    it('shows accent border on non-masked key even if selectedMaskPart leaks true', () => {
      mockIsMask = false
      const { container } = render(
        <svg>
          <KeyWidget kleKey={makeKey()} keycode="KC_A" selected selectedMaskPart={true} />
        </svg>,
      )
      const outerRect = container.querySelector('rect')!
      expect(outerRect.getAttribute('stroke')).toBe(KEY_SELECTED_COLOR)
      expect(outerRect.getAttribute('stroke-width')).toBe('2')
    })
  })
})
