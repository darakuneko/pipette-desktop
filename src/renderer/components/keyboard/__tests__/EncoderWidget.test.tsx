// SPDX-License-Identifier: GPL-2.0-or-later
// @vitest-environment jsdom

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render } from '@testing-library/react'
import { EncoderWidget } from '../EncoderWidget'
import { KEY_SELECTED_COLOR, KEY_BG_COLOR } from '../constants'
import type { KleKey } from '../../../../shared/kle/types'

let mockIsMask = false
let mockInnerKeycode: { qmkId: string } = { qmkId: 'KC_A' }

vi.mock('../../../../shared/keycodes/keycodes', () => ({
  keycodeLabel: (kc: string) => kc,
  isMask: () => mockIsMask,
  findInnerKeycode: () => mockInnerKeycode,
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
    row: -1,
    col: -1,
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

describe('EncoderWidget', () => {
  beforeEach(() => {
    mockIsMask = false
    mockInnerKeycode = { qmkId: 'KC_A' }
  })

  describe('flashed (post-rewrite / undo-redo flash)', () => {
    it('does not render a flash overlay when flashed is unset', () => {
      const { container } = render(
        <svg>
          <EncoderWidget kleKey={makeKey()} keycode="KC_A" />
        </svg>,
      )
      expect(container.querySelector('[data-testid="flash-overlay"]')).toBeNull()
      expect(container.querySelector('[data-testid="flash-overlay-border"]')).toBeNull()
    })

    it('renders a flash overlay circle with the selected fill and the key-flash animation class when flashed=true', () => {
      const { container } = render(
        <svg>
          <EncoderWidget kleKey={makeKey()} keycode="KC_A" flashed />
        </svg>,
      )
      const overlay = container.querySelector('[data-testid="flash-overlay"]')!
      expect(overlay).not.toBeNull()
      expect(overlay.tagName).toBe('circle')
      expect(overlay.getAttribute('fill')).toBe(KEY_SELECTED_COLOR)
      expect(overlay.classList.contains('key-flash-overlay')).toBe(true)
    })

    it('leaves the outer circle fill untouched by flashed (overlay paints on top)', () => {
      const { container } = render(
        <svg>
          <EncoderWidget kleKey={makeKey()} keycode="KC_A" flashed />
        </svg>,
      )
      const circles = container.querySelectorAll('circle')
      // First circle is the base outer circle, unaffected by `flashed`.
      expect(circles[0].getAttribute('fill')).toBe(KEY_BG_COLOR)
    })

    it('removes the flash overlay once the caller clears flashed', () => {
      const { container, rerender } = render(
        <svg>
          <EncoderWidget kleKey={makeKey()} keycode="KC_A" flashed />
        </svg>,
      )
      expect(container.querySelector('[data-testid="flash-overlay"]')).not.toBeNull()

      rerender(
        <svg>
          <EncoderWidget kleKey={makeKey()} keycode="KC_A" />
        </svg>,
      )
      expect(container.querySelector('[data-testid="flash-overlay"]')).toBeNull()
    })

    it('does not let the flash overlay intercept clicks meant for the encoder', () => {
      const { container } = render(
        <svg>
          <EncoderWidget kleKey={makeKey()} keycode="KC_A" flashed />
        </svg>,
      )
      const overlay = container.querySelector('[data-testid="flash-overlay"]')! as SVGElement
      expect(overlay.style.pointerEvents).toBe('none')
    })

    it('remounts the overlay (restarting its animation) when flashGeneration bumps on a re-apply', () => {
      const { container, rerender } = render(
        <svg>
          <EncoderWidget kleKey={makeKey()} keycode="KC_A" flashed flashGeneration={1} />
        </svg>,
      )
      const firstOverlay = container.querySelector('[data-testid="flash-overlay"]')!
      expect(firstOverlay).not.toBeNull()

      rerender(
        <svg>
          <EncoderWidget kleKey={makeKey()} keycode="KC_A" flashed flashGeneration={2} />
        </svg>,
      )
      const secondOverlay = container.querySelector('[data-testid="flash-overlay"]')!
      expect(secondOverlay).not.toBeNull()
      expect(secondOverlay).not.toBe(firstOverlay)
    })

    it('computes a negative animation-delay from flashStartedAt for a late-mounted overlay', () => {
      const now = Date.now()
      vi.useFakeTimers()
      vi.setSystemTime(now + 500)
      try {
        const { container } = render(
          <svg>
            <EncoderWidget kleKey={makeKey()} keycode="KC_A" flashed flashStartedAt={now} />
          </svg>,
        )
        const overlay = container.querySelector('[data-testid="flash-overlay"]')! as SVGElement
        expect(overlay.style.animationDelay).toBe('-500ms')
      } finally {
        vi.useRealTimers()
      }
    })

    it('clamps animation-delay to the full animation length (700ms) for a stale flashStartedAt', () => {
      const now = Date.now()
      vi.useFakeTimers()
      vi.setSystemTime(now + 5000)
      try {
        const { container } = render(
          <svg>
            <EncoderWidget kleKey={makeKey()} keycode="KC_A" flashed flashStartedAt={now} />
          </svg>,
        )
        const overlay = container.querySelector('[data-testid="flash-overlay"]')! as SVGElement
        expect(overlay.style.animationDelay).toBe('-700ms')
      } finally {
        vi.useRealTimers()
      }
    })

    it('renders a stroke-only border copy on top of the overlay while flashed, matching the outer border', () => {
      const { container } = render(
        <svg>
          <EncoderWidget kleKey={makeKey()} keycode="KC_A" flashed selected />
        </svg>,
      )
      const borderCopy = container.querySelector('[data-testid="flash-overlay-border"]')!
      expect(borderCopy).not.toBeNull()
      expect(borderCopy.getAttribute('fill')).toBe('none')
      expect(borderCopy.getAttribute('stroke')).toBe(KEY_SELECTED_COLOR)
      expect(borderCopy.getAttribute('stroke-width')).toBe('2')
    })

    it('removes the border copy once the caller clears flashed', () => {
      const { container, rerender } = render(
        <svg>
          <EncoderWidget kleKey={makeKey()} keycode="KC_A" flashed />
        </svg>,
      )
      expect(container.querySelector('[data-testid="flash-overlay-border"]')).not.toBeNull()

      rerender(
        <svg>
          <EncoderWidget kleKey={makeKey()} keycode="KC_A" />
        </svg>,
      )
      expect(container.querySelector('[data-testid="flash-overlay-border"]')).toBeNull()
    })

    describe('masked encoder (isMask=true)', () => {
      beforeEach(() => {
        mockIsMask = true
      })

      it('renders the flash overlay and border copy alongside the inner mask rect', () => {
        const { container } = render(
          <svg>
            <EncoderWidget kleKey={makeKey()} keycode="LT0(KC_A)" flashed />
          </svg>,
        )
        expect(container.querySelector('[data-testid="flash-overlay"]')).not.toBeNull()
        expect(container.querySelector('[data-testid="flash-overlay-border"]')).not.toBeNull()
        // The inner mask rect stays visible on top of the (opaque) overlay.
        const innerRect = container.querySelector('rect')
        expect(innerRect).not.toBeNull()
      })

      it('does not render a flash overlay for a masked encoder when flashed is unset', () => {
        const { container } = render(
          <svg>
            <EncoderWidget kleKey={makeKey()} keycode="LT0(KC_A)" />
          </svg>,
        )
        expect(container.querySelector('[data-testid="flash-overlay"]')).toBeNull()
      })
    })
  })
})
