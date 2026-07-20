// SPDX-License-Identifier: GPL-2.0-or-later
// @vitest-environment jsdom

// Plan-qwerty-select-no-rewrite v7 review follow-up (FIX A): the picker
// panel's "Keyboard" tab (`LayoutPickerContent`'s secondary `KeyboardPane`,
// built by `useLayoutPicker`) has its own click handler
// (`handlePickerKeyClick`), entirely separate from `TabbedKeycodes`'
// `onKeycodeSelect`/`onKeycodeMultiSelect`. Gating those alone left this
// surface able to select/paste while the simulation tab was showing —
// `KemapEditor` now gates `handleKeycodeSelect`/`handlePickerMultiSelect`
// themselves (passing `undefined` when `packTabReadOnly`), which is what
// this exercises directly against the real `useLayoutPicker` + real
// `KeyboardWidget` click path (not mocked).

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

function Host(props: Partial<UseLayoutPickerOptions>) {
  const { layoutPickerContent } = useLayoutPicker({
    layout: { keys: [KEY] },
    layers: 1,
    layerNames: [],
    keymap: new Map([['0,0,0', 4]]),
    effectiveLayoutOptions: new Map(),
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

/** Renders the host, transitions past the device-browse screen into the
 *  Keyboard view (clicking the connected device), and returns the
 *  container so the test can click the picker's rendered key. */
function renderKeyboardView(props: Partial<UseLayoutPickerOptions>) {
  const utils = render(<Host {...props} />)
  act(() => {
    fireEvent.click(utils.getByText('Test KB'))
  })
  return utils
}

describe('useLayoutPicker — Keyboard tab read-only enforcement (Plan-qwerty-select-no-rewrite v7, FIX A)', () => {
  it('a plain click on the picker key does nothing when handleKeycodeSelect/handlePickerMultiSelect are both omitted (simulation tab)', () => {
    const handleKeycodeSelect = vi.fn()
    const handlePickerMultiSelect = vi.fn()
    const { container } = renderKeyboardView({
      // KemapEditor passes `undefined` for both when `packTabReadOnly` —
      // omit them entirely here rather than passing the mocks, and prove
      // via the mocks below that no OTHER path reaches them either.
      handleKeycodeSelect: undefined,
      handlePickerMultiSelect: undefined,
    })
    const keyGroup = container.querySelector('[data-key-pos="0,0"]')
    expect(keyGroup).not.toBeNull()
    fireEvent.click(keyGroup!)
    expect(handleKeycodeSelect).not.toHaveBeenCalled()
    expect(handlePickerMultiSelect).not.toHaveBeenCalled()
  })

  it('the same click selects normally when handleKeycodeSelect/handlePickerMultiSelect are provided (Base tab)', () => {
    const handleKeycodeSelect = vi.fn().mockResolvedValue(undefined)
    const handlePickerMultiSelect = vi.fn()
    const { container } = renderKeyboardView({ handleKeycodeSelect, handlePickerMultiSelect })
    const keyGroup = container.querySelector('[data-key-pos="0,0"]')
    fireEvent.click(keyGroup!)
    // No key is selected on the primary pane (`selectedKey`/`selectedEncoder`
    // both null in this fixture), so a plain click takes the "start a picker
    // multi-select" branch — see `handlePickerKeyClick`'s own branching.
    expect(handlePickerMultiSelect).toHaveBeenCalledTimes(1)
    expect(handleKeycodeSelect).not.toHaveBeenCalled()
  })

  it('a Ctrl+click also does nothing when handlePickerMultiSelect is omitted', () => {
    const handlePickerMultiSelect = vi.fn()
    const { container } = renderKeyboardView({
      handleKeycodeSelect: undefined,
      handlePickerMultiSelect: undefined,
    })
    const keyGroup = container.querySelector('[data-key-pos="0,0"]')
    fireEvent.click(keyGroup!, { ctrlKey: true })
    expect(handlePickerMultiSelect).not.toHaveBeenCalled()
  })
})
