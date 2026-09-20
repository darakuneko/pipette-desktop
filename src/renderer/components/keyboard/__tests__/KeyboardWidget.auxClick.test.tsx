// SPDX-License-Identifier: GPL-2.0-or-later
// @vitest-environment jsdom

// Middle-click undo delegation on the root <svg> — see
// `use-keymap-history-actions.test.ts` for the matching/undo logic this
// feeds into. `isMask` here (unlike the sibling KeyboardWidget.test.tsx
// file, which always returns false) treats the sentinel keycode
// 'LT_MASK' as a masked key/encoder so both the masked and unmasked
// EncoderWidget branches can be exercised in the same file.

import { describe, it, expect, vi } from 'vitest'
import { render, act } from '@testing-library/react'
import { KeyboardWidget } from '../KeyboardWidget'
import type { KleKey } from '../../../../shared/kle/types'
import { makeKey } from './kle-test-keys'

vi.mock('../../../../shared/keycodes/keycodes', () => ({
  keycodeLabel: (kc: string) => kc,
  isMask: (kc: string) => kc === 'LT_MASK',
  findOuterKeycode: () => ({ qmkId: 'LT0' }),
  findInnerKeycode: () => ({ qmkId: 'KC_A' }),
}))

function dispatchMouse(el: Element, type: string, button: number): MouseEvent {
  const event = new MouseEvent(type, { bubbles: true, cancelable: true, button })
  act(() => { el.dispatchEvent(event) })
  return event
}

const KEY: KleKey = makeKey({ x: 0, y: 0, row: 0, col: 0 })
const NO_POS_KEY: KleKey = makeKey({ x: 1, y: 0, row: -1, col: -1 })
const ENCODER_KEY: KleKey = makeKey({ x: 2, y: 0, row: -1, col: -1, encoderIdx: 0, encoderDir: 0 })

function renderWidget(props: Partial<Parameters<typeof KeyboardWidget>[0]> = {}) {
  const keys = [KEY, NO_POS_KEY, ENCODER_KEY]
  const keycodes = new Map([['0,0', 'KC_A']])
  const encoderKeycodes = new Map<string, [string, string]>([['0', ['KC_B', 'KC_NO']]])
  return render(
    <KeyboardWidget keys={keys} keycodes={keycodes} encoderKeycodes={encoderKeycodes} {...props} />,
  )
}

describe('KeyboardWidget — middle-click undo delegation', () => {
  it('cancels the default on a middle-button mousedown when an aux handler is provided', () => {
    const onKeyAuxClick = vi.fn()
    const { container } = renderWidget({ onKeyAuxClick })
    const svg = container.querySelector('svg')!
    const event = dispatchMouse(svg, 'mousedown', 1)
    expect(event.defaultPrevented).toBe(true)
  })

  it('cancels the default on a middle-button mouseup (PRIMARY-selection paste runs on mouseup, not mousedown)', () => {
    const onKeyAuxClick = vi.fn()
    const { container } = renderWidget({ onKeyAuxClick })
    const svg = container.querySelector('svg')!
    const event = dispatchMouse(svg, 'mouseup', 1)
    expect(event.defaultPrevented).toBe(true)
  })

  it('leaves a left-button mousedown untouched', () => {
    const onKeyAuxClick = vi.fn()
    const { container } = renderWidget({ onKeyAuxClick })
    const svg = container.querySelector('svg')!
    const event = dispatchMouse(svg, 'mousedown', 0)
    expect(event.defaultPrevented).toBe(false)
  })

  it('delivers the key position on a middle-button auxclick', () => {
    const onKeyAuxClick = vi.fn()
    const { container } = renderWidget({ onKeyAuxClick })
    const keyGroup = container.querySelector('[data-key-pos="0,0"]')!
    dispatchMouse(keyGroup, 'auxclick', 1)
    expect(onKeyAuxClick).toHaveBeenCalledWith({ row: 0, col: 0 })
  })

  it('ignores an auxclick whose button is not the middle button', () => {
    const onKeyAuxClick = vi.fn()
    const { container } = renderWidget({ onKeyAuxClick })
    const keyGroup = container.querySelector('[data-key-pos="0,0"]')!
    dispatchMouse(keyGroup, 'auxclick', 2)
    expect(onKeyAuxClick).not.toHaveBeenCalled()
  })

  it('delivers the encoder position on a middle-button auxclick (unmasked encoder)', () => {
    const onEncoderAuxClick = vi.fn()
    const { container } = renderWidget({ onEncoderAuxClick })
    const encGroup = container.querySelector('[data-encoder-pos="0,0"]')!
    dispatchMouse(encGroup, 'auxclick', 1)
    expect(onEncoderAuxClick).toHaveBeenCalledWith({ idx: 0, dir: 0 })
  })

  it('delivers the encoder position on a middle-button auxclick (masked encoder)', () => {
    const onEncoderAuxClick = vi.fn()
    const encoderKeycodes = new Map<string, [string, string]>([['0', ['LT_MASK', 'KC_NO']]])
    const { container } = renderWidget({ onEncoderAuxClick, encoderKeycodes })
    const encGroup = container.querySelector('[data-encoder-pos="0,0"]')!
    dispatchMouse(encGroup, 'auxclick', 1)
    expect(onEncoderAuxClick).toHaveBeenCalledWith({ idx: 0, dir: 0 })
  })

  it('does not deliver an aux click for a key with no matrix position (row/col -1)', () => {
    const onKeyAuxClick = vi.fn()
    const onEncoderAuxClick = vi.fn()
    const { container, getByText } = renderWidget({ onKeyAuxClick, onEncoderAuxClick })
    // NO_POS_KEY is the only key without a `keycodes` entry (only "0,0"
    // has one), so it renders the 'KC_NO' fallback label — that text
    // node's own <g> is the group to dispatch on. It carries no
    // `data-key-pos` (KeyWidget only sets that when row/col are both
    // >= 0) and it isn't an encoder either, so it has no `data-encoder-pos`
    // ancestor — confirmed below before using it as the dispatch target.
    const noPosGroup = getByText('KC_NO').closest('g')!
    const svg = container.querySelector('svg')!
    expect(svg.contains(noPosGroup)).toBe(true)
    expect(noPosGroup.closest('[data-key-pos]')).toBeNull()
    expect(noPosGroup.closest('[data-encoder-pos]')).toBeNull()
    dispatchMouse(noPosGroup, 'auxclick', 1)
    expect(onKeyAuxClick).not.toHaveBeenCalled()
    expect(onEncoderAuxClick).not.toHaveBeenCalled()
  })

  it('readOnly suppresses both the mousedown preventDefault and the auxclick delivery', () => {
    const onKeyAuxClick = vi.fn()
    const { container } = renderWidget({ onKeyAuxClick, readOnly: true })
    const svg = container.querySelector('svg')!
    const mousedown = dispatchMouse(svg, 'mousedown', 1)
    expect(mousedown.defaultPrevented).toBe(false)
    const keyGroup = container.querySelector('[data-key-pos="0,0"]')!
    dispatchMouse(keyGroup, 'auxclick', 1)
    expect(onKeyAuxClick).not.toHaveBeenCalled()
  })

  it('does nothing when neither aux handler is provided', () => {
    const { container } = renderWidget()
    const svg = container.querySelector('svg')!
    const mousedown = dispatchMouse(svg, 'mousedown', 1)
    expect(mousedown.defaultPrevented).toBe(false)
    const keyGroup = container.querySelector('[data-key-pos="0,0"]')!
    // No handler to call — this just asserts nothing throws.
    expect(() => dispatchMouse(keyGroup, 'auxclick', 1)).not.toThrow()
  })
})
