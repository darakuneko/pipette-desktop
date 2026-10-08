// SPDX-License-Identifier: GPL-2.0-or-later
// @vitest-environment jsdom

// A saved snapshot with no label is listed by its file name in the
// picker's file-browse view. The stored name may end in `_${id}`, which
// is left out of what the user sees. Driven through `useLayoutPicker`
// (it owns every prop `LayoutPickerContent` takes).

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, fireEvent, screen, waitFor } from '@testing-library/react'
import { useLayoutPicker, type UseLayoutPickerOptions } from '../useLayoutPicker'
import type { KleKey } from '../../../../shared/kle/types'

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

const NEW_ID = '0b9f6f1e-3c1a-4e0e-9d7a-2f1d5f6b8a90'
const SAVED_AT = '2026-10-08T12:00:00.000Z'

beforeEach(() => {
  window.vialAPI = {
    ...(window.vialAPI ?? {}),
    listStoredKeyboards: vi.fn(async () => [{ uid: 'kb', name: 'Stored KB' }]),
    snapshotStoreList: vi.fn(async () => ({
      success: true,
      entries: [
        { id: NEW_ID, label: '', filename: `KB_2026-10-08T12-00-00.000Z_${NEW_ID}.pipette`, savedAt: SAVED_AT, vilVersion: 2 },
        { id: 'old-id', label: '', filename: 'KB_2026-10-07T09-00-00.000Z.pipette', savedAt: SAVED_AT, vilVersion: 2 },
      ],
    })),
  } as unknown as typeof window.vialAPI
})

describe('LayoutPickerContent — unlabelled snapshot names', () => {
  it('shows the file name without the id, and an id-less name as it is', async () => {
    render(<Host />)
    fireEvent.click(screen.getByText('editor.keymap.pickerSourceFile'))
    await waitFor(() => expect(screen.getByText('Stored KB')).toBeInTheDocument())
    fireEvent.click(screen.getByText('Stored KB'))

    await waitFor(() => expect(screen.getByText('KB_2026-10-08T12-00-00.000Z.pipette')).toBeInTheDocument())
    expect(screen.getByText('KB_2026-10-07T09-00-00.000Z.pipette')).toBeInTheDocument()
    expect(screen.queryByText(new RegExp(NEW_ID))).not.toBeInTheDocument()
  })
})
