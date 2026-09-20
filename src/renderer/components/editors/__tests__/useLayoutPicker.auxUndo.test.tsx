// SPDX-License-Identifier: GPL-2.0-or-later
// @vitest-environment jsdom

// Middle-click undo must never reach the picker panel's "Keyboard" tab
// (`LayoutPickerContent`'s secondary `KeyboardPane`, built by
// `useLayoutPicker`) — that pane is a copy-source browser, not an edit
// target, so `KeymapPrimaryPane` only wires `auxUndoHandlers` into the
// primary editing `KeyboardPane`. Exercised against the real (unmocked)
// `KeyboardWidget` click path, like the sibling
// `useLayoutPicker.readOnly.test.tsx` does for the left-click handlers.

import { describe, it, expect, vi } from 'vitest'
import { render, fireEvent, act } from '@testing-library/react'
import { useLayoutPicker, type UseLayoutPickerOptions } from '../useLayoutPicker'
import type { KleKey } from '../../../../shared/kle/types'
import type { DeviceInfo } from '../../../../shared/types/protocol'

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

const CONNECTED_DEVICE: DeviceInfo = {
  vendorId: 1, productId: 2, serialNumber: 'abc', productName: 'Test KB', type: 'vial',
}

function dispatchMouse(el: Element, type: string, button: number): MouseEvent {
  const event = new MouseEvent(type, { bubbles: true, cancelable: true, button })
  act(() => { el.dispatchEvent(event) })
  return event
}

function Host(props: Partial<UseLayoutPickerOptions>) {
  const { layoutPickerContent } = useLayoutPicker({
    layout: { keys: [KEY] },
    layers: 1,
    layerNames: [],
    keymap: new Map([['0,0,0', 4]]),
    effectiveLayoutOptions: new Map(),
    advancableKeys: [KEY],
    scale: 1,
    devices: [CONNECTED_DEVICE],
    connectedDevice: CONNECTED_DEVICE,
    onDeviceListActiveChange: vi.fn(),
    selectedKey: null,
    selectedEncoder: null,
    pickerSelectedIndices: new Set(),
    clearPickerSelection: vi.fn(),
    buildKeycodesForLayer: () => ({ keycodes: new Map([['0,0', 'KC_A']]), remapped: new Set() }),
    buildEncoderKeycodesForLayer: () => new Map(),
    ...props,
  })
  return <>{layoutPickerContent}</>
}

describe('useLayoutPicker — the Keyboard tab picker pane never gets middle-click undo', () => {
  it('a middle-button auxclick on the picker key does nothing (no listener attached at all)', () => {
    const { container, getByText } = render(<Host />)
    act(() => { fireEvent.click(getByText('Test KB')) })

    const keyGroup = container.querySelector('[data-key-pos="0,0"]')
    expect(keyGroup).not.toBeNull()

    // No `onKeyAuxClick` reaches this pane's `KeyboardWidget`, so the svg
    // never attaches the mousedown/mouseup/auxclick listeners in the first
    // place — asserted by both defaults surviving, exactly like the
    // `readOnly`/no-handler case in KeyboardWidget.auxClick.test.tsx.
    const svg = container.querySelector('svg')!
    expect(dispatchMouse(svg, 'mousedown', 1).defaultPrevented).toBe(false)
    expect(dispatchMouse(svg, 'mouseup', 1).defaultPrevented).toBe(false)
  })
})
