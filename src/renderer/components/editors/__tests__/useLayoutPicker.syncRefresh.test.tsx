// SPDX-License-Identifier: GPL-2.0-or-later
// @vitest-environment jsdom

// The picker's saved-file browser follows the keyboard it is browsing
// (`selectedFileUid`), not the connected one, when a sync merge rewrote
// that keyboard's snapshots; the zoom follows the loaded file's keyboard
// when a merge rewrote its settings.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, fireEvent, act, screen, waitFor } from '@testing-library/react'
import { useLayoutPicker, type UseLayoutPickerOptions } from '../useLayoutPicker'
import { dispatchSyncUnitApplied } from '../../../hooks/use-sync-unit-applied'
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

const snapshotList = vi.fn()
const listStoredKeyboards = vi.fn()
const snapshotLoad = vi.fn()
const settingsGet = vi.fn()
const settingsPatch = vi.fn()

beforeEach(() => {
  snapshotList.mockReset()
  listStoredKeyboards.mockReset()
  snapshotLoad.mockReset()
  settingsGet.mockReset().mockResolvedValue(null)
  settingsPatch.mockReset().mockResolvedValue({ success: true })
  Object.defineProperty(window, 'vialAPI', {
    value: {
      ...window.vialAPI,
      snapshotStoreList: snapshotList,
      listStoredKeyboards,
      snapshotStoreLoad: snapshotLoad,
      pipetteSettingsGet: settingsGet,
      pipetteSettingsPatch: settingsPatch,
    },
    writable: true,
    configurable: true,
  })
})

function snap(id: string): { id: string; label: string; filename: string; savedAt: string; vilVersion: number } {
  return { id, label: `label-${id}`, filename: `${id}.pipette`, savedAt: '2026-01-01T00:00:00.000Z', vilVersion: 2 }
}

const OTHER_FILE = {
  version: 2,
  uid: 'other',
  keymap: { '0,0,0': 4 },
  encoderLayout: {},
  macros: [],
  layoutOptions: 0,
  tapDance: [],
  combo: [],
  keyOverride: [],
  altRepeatKey: [],
  qmkSettings: {},
  definition: { name: 'Other', matrix: { rows: 1, cols: 1 }, layouts: { keymap: [['0,0']] } },
}

describe('useLayoutPicker sync refresh', () => {
  it('re-reads the browsed keyboard\'s entries and keeps the entries view', async () => {
    listStoredKeyboards.mockResolvedValue([{ uid: 'other', name: 'Other KB' }])
    snapshotList.mockResolvedValue({ success: true, entries: [snap('e1')] })
    render(<Host />)
    fireEvent.click(screen.getByText('editor.keymap.pickerSourceFile'))
    await waitFor(() => expect(screen.getByText('Other KB')).toBeInTheDocument())
    fireEvent.click(screen.getByText('Other KB'))
    await waitFor(() => expect(screen.getByText('label-e1')).toBeInTheDocument())
    expect(snapshotList).toHaveBeenCalledTimes(1)

    act(() => { dispatchSyncUnitApplied('keyboards/connected/snapshots') })
    expect(snapshotList).toHaveBeenCalledTimes(1)

    snapshotList.mockResolvedValue({ success: true, entries: [snap('e1'), snap('e2')] })
    act(() => { dispatchSyncUnitApplied('keyboards/other/snapshots') })
    await waitFor(() => expect(screen.getByText('label-e2')).toBeInTheDocument())
    expect(snapshotList).toHaveBeenLastCalledWith('other')
    expect(screen.getByText('label-e1')).toBeInTheDocument()
  })

  it('re-reads the stored keyboard list on a keyboard-name change', async () => {
    listStoredKeyboards.mockResolvedValueOnce([{ uid: 'other', name: 'Other KB' }])
    render(<Host />)
    fireEvent.click(screen.getByText('editor.keymap.pickerSourceFile'))
    await waitFor(() => expect(screen.getByText('Other KB')).toBeInTheDocument())

    listStoredKeyboards.mockResolvedValueOnce([{ uid: 'other', name: 'Renamed KB' }])
    act(() => { dispatchSyncUnitApplied('meta/keyboard-names') })
    await waitFor(() => expect(screen.getByText('Renamed KB')).toBeInTheDocument())
  })

  it('re-reads the loaded keyboard\'s zoom and saves only a user zoom', async () => {
    listStoredKeyboards.mockResolvedValue([{ uid: 'other', name: 'Other KB' }])
    snapshotList.mockResolvedValue({ success: true, entries: [snap('e1')] })
    snapshotLoad.mockResolvedValue({ success: true, data: JSON.stringify(OTHER_FILE) })
    settingsGet.mockResolvedValueOnce({ keymapScale: 1.2 })
    render(<Host />)
    fireEvent.click(screen.getByText('editor.keymap.pickerSourceFile'))
    await waitFor(() => expect(screen.getByText('Other KB')).toBeInTheDocument())
    fireEvent.click(screen.getByText('Other KB'))
    await waitFor(() => expect(screen.getByText('label-e1')).toBeInTheDocument())
    fireEvent.click(screen.getByText('label-e1'))
    await waitFor(() => expect(screen.getByTestId('scale-display')).toHaveTextContent('120'))
    // Reading the zoom never writes it back.
    expect(settingsPatch).not.toHaveBeenCalled()

    act(() => { dispatchSyncUnitApplied('keyboards/connected/settings') })
    expect(settingsGet).toHaveBeenCalledTimes(1)

    settingsGet.mockResolvedValueOnce({ keymapScale: 1.5 })
    act(() => { dispatchSyncUnitApplied('keyboards/other/settings') })
    await waitFor(() => expect(screen.getByTestId('scale-display')).toHaveTextContent('150'))
    expect(settingsGet).toHaveBeenLastCalledWith('other')
    expect(settingsPatch).not.toHaveBeenCalled()

    fireEvent.click(screen.getByLabelText('editor.keymap.zoomIn'))
    await waitFor(() => expect(settingsPatch).toHaveBeenCalledWith('other', { keymapScale: 1.6 }))
  })

  it('does not write the current zoom into a newly loaded keyboard', async () => {
    listStoredKeyboards.mockResolvedValue([{ uid: 'other', name: 'Other KB' }, { uid: 'third', name: 'Third KB' }])
    snapshotList.mockImplementation(async (uid: string) => ({ success: true, entries: [snap(`${uid}-e`)] }))
    snapshotLoad.mockImplementation(async (uid: string) => ({ success: true, data: JSON.stringify({ ...OTHER_FILE, uid }) }))
    settingsGet.mockImplementation(async (uid: string) => ({ keymapScale: uid === 'other' ? 1.2 : 0.8 }))
    render(<Host />)
    fireEvent.click(screen.getByText('editor.keymap.pickerSourceFile'))
    await waitFor(() => expect(screen.getByText('Other KB')).toBeInTheDocument())
    fireEvent.click(screen.getByText('Other KB'))
    fireEvent.click(await screen.findByText('label-other-e'))
    await waitFor(() => expect(screen.getByTestId('scale-display')).toHaveTextContent('120'))

    fireEvent.click(screen.getByText('editor.keymap.pickerBackToFiles'))
    await waitFor(() => expect(screen.getByText('Third KB')).toBeInTheDocument())
    fireEvent.click(screen.getByText('Third KB'))
    fireEvent.click(await screen.findByText('label-third-e'))
    await waitFor(() => expect(screen.getByTestId('scale-display')).toHaveTextContent('80'))
    expect(settingsPatch).not.toHaveBeenCalled()
  })

  it('keeps a newer zoom when the load\'s own settings read finishes late', async () => {
    listStoredKeyboards.mockResolvedValue([{ uid: 'other', name: 'Other KB' }])
    snapshotList.mockResolvedValue({ success: true, entries: [snap('e1')] })
    snapshotLoad.mockResolvedValue({ success: true, data: JSON.stringify(OTHER_FILE) })
    let resolveLoad!: (prefs: { keymapScale: number }) => void
    settingsGet.mockReturnValueOnce(new Promise((res) => { resolveLoad = res }))
    render(<Host />)
    fireEvent.click(screen.getByText('editor.keymap.pickerSourceFile'))
    await waitFor(() => expect(screen.getByText('Other KB')).toBeInTheDocument())
    fireEvent.click(screen.getByText('Other KB'))
    fireEvent.click(await screen.findByText('label-e1'))
    await waitFor(() => expect(screen.getByTestId('scale-display')).toHaveTextContent('100'))

    settingsGet.mockResolvedValueOnce({ keymapScale: 1.5 })
    act(() => { dispatchSyncUnitApplied('keyboards/other/settings') })
    await waitFor(() => expect(screen.getByTestId('scale-display')).toHaveTextContent('150'))
    await act(async () => { resolveLoad({ keymapScale: 1.2 }) })
    expect(screen.getByTestId('scale-display')).toHaveTextContent('150')
  })

  it('keeps a user zoom made while the load\'s settings read is pending', async () => {
    listStoredKeyboards.mockResolvedValue([{ uid: 'other', name: 'Other KB' }])
    snapshotList.mockResolvedValue({ success: true, entries: [snap('e1')] })
    snapshotLoad.mockResolvedValue({ success: true, data: JSON.stringify(OTHER_FILE) })
    let resolveLoad!: (prefs: { keymapScale: number }) => void
    settingsGet.mockReturnValueOnce(new Promise((res) => { resolveLoad = res }))
    render(<Host />)
    fireEvent.click(screen.getByText('editor.keymap.pickerSourceFile'))
    await waitFor(() => expect(screen.getByText('Other KB')).toBeInTheDocument())
    fireEvent.click(screen.getByText('Other KB'))
    fireEvent.click(await screen.findByText('label-e1'))
    await waitFor(() => expect(screen.getByTestId('scale-display')).toHaveTextContent('100'))

    fireEvent.click(screen.getByLabelText('editor.keymap.zoomIn'))
    await waitFor(() => expect(settingsPatch).toHaveBeenCalledWith('other', { keymapScale: 1.1 }))
    await act(async () => { resolveLoad({ keymapScale: 1.2 }) })
    expect(screen.getByTestId('scale-display')).toHaveTextContent('110')
  })
})
