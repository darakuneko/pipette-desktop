// SPDX-License-Identifier: GPL-2.0-or-later
// @vitest-environment jsdom

// `isActive` gates the middle-click undo handlers the same way it already
// gates `onKeyClick`/`onEncoderClick` (see KeyboardPane.readOnly.test.tsx
// for the sibling `readOnly` gate) — exercised against the real
// KeyboardWidget/KeyWidget tree so the DOM delegation path is proven
// blocked, not just prop threading.

import { describe, it, expect, vi } from 'vitest'
import { render, act } from '@testing-library/react'
import { KeyboardPane } from '../KeyboardPane'
import type { KleKey } from '../../../../shared/kle/types'

vi.mock('../../../../shared/keycodes/keycodes', () => ({
  keycodeLabel: (kc: string) => kc,
  isMask: () => false,
  findOuterKeycode: () => undefined,
  findInnerKeycode: () => undefined,
}))

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))

const KEY: KleKey = {
  x: 0, y: 0, width: 1, height: 1, row: 0, col: 0,
  encoderIdx: -1, encoderDir: -1, layoutIndex: -1, layoutOption: -1,
  decal: false, labels: [], x2: 0, y2: 0, width2: 1, height2: 1,
  rotation: 0, rotationX: 0, rotationY: 0, color: '',
  textColor: [], textSize: [], nub: false, stepped: false, ghost: false,
}

function baseProps(isActive: boolean) {
  return {
    paneId: 'primary' as const,
    isActive,
    keys: [KEY],
    keycodes: new Map([['0,0', 'KC_A']]),
    encoderKeycodes: new Map<string, [string, string]>(),
    selectedKey: null,
    selectedEncoder: null,
    selectedMaskPart: false,
    selectedKeycode: null,
    remappedKeys: new Set<string>(),
    layoutOptions: new Map<number, number>(),
    scale: 1,
    layerLabelTestId: 'layer-label',
  }
}

function dispatchMouse(el: Element, type: string, button: number): MouseEvent {
  const event = new MouseEvent(type, { bubbles: true, cancelable: true, button })
  act(() => { el.dispatchEvent(event) })
  return event
}

describe('KeyboardPane — isActive gates middle-click undo', () => {
  it('delivers the middle-click position when isActive', () => {
    const onKeyAuxClick = vi.fn()
    const { container } = render(
      <KeyboardPane {...baseProps(true)} onKeyAuxClick={onKeyAuxClick} />,
    )
    const keyGroup = container.querySelector('[data-key-pos="0,0"]')!
    dispatchMouse(keyGroup, 'auxclick', 1)
    expect(onKeyAuxClick).toHaveBeenCalledWith({ row: 0, col: 0 })
  })

  it('does not deliver the middle-click position when isActive is false', () => {
    const onKeyAuxClick = vi.fn()
    const { container } = render(
      <KeyboardPane {...baseProps(false)} onKeyAuxClick={onKeyAuxClick} />,
    )
    const keyGroup = container.querySelector('[data-key-pos="0,0"]')!
    dispatchMouse(keyGroup, 'auxclick', 1)
    expect(onKeyAuxClick).not.toHaveBeenCalled()
  })

  it('does not cancel the middle-button mousedown default when isActive is false', () => {
    const onKeyAuxClick = vi.fn()
    const { container } = render(
      <KeyboardPane {...baseProps(false)} onKeyAuxClick={onKeyAuxClick} />,
    )
    const svg = container.querySelector('svg')!
    const event = dispatchMouse(svg, 'mousedown', 1)
    expect(event.defaultPrevented).toBe(false)
  })
})
