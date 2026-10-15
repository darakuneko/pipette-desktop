// SPDX-License-Identifier: GPL-2.0-or-later
// @vitest-environment jsdom

// `onDeviceListActiveChange` drives the per-second device listing in
// `useDeviceConnection`, so it may only report `true` while the Keyboard tab
// is actually on screen AND showing the device list.

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

let setVisible: ((visible: boolean) => void) | null = null

function Host(props: Partial<UseLayoutPickerOptions>) {
  const { layoutPickerContent, setKeyboardTabVisible } = useLayoutPicker({
    layout: { keys: [KEY] },
    layers: 1,
    layerNames: [],
    keymap: new Map([['0,0,0', 4]]),
    effectiveLayoutOptions: new Map(),
    advancableKeys: [KEY],
    scale: 1,
    devices: [CONNECTED_DEVICE],
    connectedDevice: CONNECTED_DEVICE,
    selectedKey: null,
    selectedEncoder: null,
    pickerSelectedIndices: new Set(),
    clearPickerSelection: vi.fn(),
    buildKeycodesForLayer: () => ({ keycodes: new Map([['0,0', 'KC_A']]), remapped: new Set() }),
    buildEncoderKeycodesForLayer: () => new Map(),
    ...props,
  })
  setVisible = setKeyboardTabVisible
  return <>{layoutPickerContent}</>
}

describe('useLayoutPicker — device list activity', () => {
  it('reports inactive while the Keyboard tab is not visible, even on the device list', () => {
    const onDeviceListActiveChange = vi.fn()
    render(<Host onDeviceListActiveChange={onDeviceListActiveChange} />)
    expect(onDeviceListActiveChange).toHaveBeenLastCalledWith(false)
    expect(onDeviceListActiveChange).not.toHaveBeenCalledWith(true)
  })

  it('reports active once the Keyboard tab is visible on the device list, and inactive when hidden again', () => {
    const onDeviceListActiveChange = vi.fn()
    render(<Host onDeviceListActiveChange={onDeviceListActiveChange} />)

    act(() => { setVisible!(true) })
    expect(onDeviceListActiveChange).toHaveBeenLastCalledWith(true)

    act(() => { setVisible!(false) })
    expect(onDeviceListActiveChange).toHaveBeenLastCalledWith(false)
  })

  it('reports inactive when the visible Keyboard tab leaves the device list', () => {
    const onDeviceListActiveChange = vi.fn()
    const utils = render(<Host onDeviceListActiveChange={onDeviceListActiveChange} />)
    act(() => { setVisible!(true) })
    expect(onDeviceListActiveChange).toHaveBeenLastCalledWith(true)

    act(() => { fireEvent.click(utils.getByText('Test KB')) })
    expect(onDeviceListActiveChange).toHaveBeenLastCalledWith(false)
  })

  it('reports inactive on unmount', () => {
    const onDeviceListActiveChange = vi.fn()
    const { unmount } = render(<Host onDeviceListActiveChange={onDeviceListActiveChange} />)
    act(() => { setVisible!(true) })
    expect(onDeviceListActiveChange).toHaveBeenLastCalledWith(true)

    unmount()
    expect(onDeviceListActiveChange).toHaveBeenLastCalledWith(false)
  })
})
