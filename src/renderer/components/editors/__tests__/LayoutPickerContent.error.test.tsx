// SPDX-License-Identifier: GPL-2.0-or-later
// @vitest-environment jsdom

// Covers the picker panel's "Keyboard" tab file-browse error box
// (`pickerLoadError`, owned by `useLayoutPicker` and rendered by
// `LayoutPickerContent` via `DismissibleError`) — same Host-wrapper
// pattern as useLayoutPicker.readOnly.test.tsx, driven through the real
// hook rather than mounting `LayoutPickerContent` directly (its prop list
// is entirely internal wiring owned by the hook).

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, fireEvent, screen, act } from '@testing-library/react'
import { useLayoutPicker, type UseLayoutPickerOptions } from '../useLayoutPicker'
import { ERROR_DISMISS_MS } from '../../ui/DismissibleError'
import type { KleKey } from '../../../../shared/kle/types'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))

beforeEach(() => {
  vi.useFakeTimers()
  window.vialAPI = {
    ...(window.vialAPI ?? {}),
    listStoredKeyboards: vi.fn(async () => []),
    loadLayout: vi.fn(async () => ({ success: false, error: 'read error' })),
  } as unknown as typeof window.vialAPI
})

afterEach(() => {
  vi.useRealTimers()
})

const KEY: KleKey = {
  x: 0, y: 0, width: 1, height: 1, row: 0, col: 0,
  encoderIdx: -1, encoderDir: -1, layoutIndex: -1, layoutOption: -1,
  decal: false, labels: [], x2: 0, y2: 0, width2: 1, height2: 1,
  rotation: 0, rotationX: 0, rotationY: 0, color: '',
  textColor: [], textSize: [], nub: false, stepped: false, ghost: false,
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
    devices: [],
    connectedDevice: null,
    onDeviceListActiveChange: vi.fn(),
    selectedKey: null,
    selectedEncoder: null,
    pickerSelectedIndices: new Set(),
    clearPickerSelection: vi.fn(),
    buildKeycodesForLayer: () => ({ keycodes: new Map(), remapped: new Set() }),
    buildEncoderKeycodesForLayer: () => new Map(),
    ...props,
  })
  return <>{layoutPickerContent}</>
}

/** Renders the host, switches the picker source to File (the browse view
 *  where `pickerLoadError` renders), then triggers a file load that the
 *  mocked `loadLayout` fails — leaving the error box on screen. */
async function renderWithLoadError() {
  render(<Host />)
  await act(async () => {
    fireEvent.click(screen.getByText('editor.keymap.pickerSourceFile'))
  })
  await act(async () => {
    fireEvent.click(screen.getByText('editor.keymap.pickerLoadFile'))
  })
}

describe('LayoutPickerContent — pickerLoadError', () => {
  it('shows the error after a failed file load and auto-dismisses after 10 seconds', async () => {
    await renderWithLoadError()
    expect(screen.getByTestId('picker-load-error')).toHaveTextContent('error.loadFailed')

    act(() => { vi.advanceTimersByTime(ERROR_DISMISS_MS) })
    expect(screen.queryByTestId('picker-load-error')).not.toBeInTheDocument()
  })

  it('dismisses immediately via the close button', async () => {
    await renderWithLoadError()

    fireEvent.click(screen.getByTestId('picker-load-error').querySelector('button')!)

    expect(screen.queryByTestId('picker-load-error')).not.toBeInTheDocument()
  })
})
