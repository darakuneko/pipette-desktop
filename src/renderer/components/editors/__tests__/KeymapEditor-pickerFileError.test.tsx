// SPDX-License-Identifier: GPL-2.0-or-later
// @vitest-environment jsdom

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, act } from '@testing-library/react'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => {
      const map: Record<string, string> = {
        'editor.keymap.pickerSourceFile': 'File',
        'editor.keymap.pickerLoadFile': 'Load from .pipette…',
        'editor.keymap.pickerSavedFiles': 'Saved files',
        'editor.keymap.pickerNoSavedFiles': 'No saved files',
        'error.vilV1NotSupported': 'Legacy data format.',
        'error.loadFailed': 'Load failed',
      }
      return map[key] ?? key
    },
  }),
}))

vi.mock('../../../hooks/useAppConfig', () => ({
  useAppConfig: () => ({ config: { maxKeymapHistory: 100 }, loading: false, set: () => {} }),
}))

vi.mock('../../keyboard/KeyboardWidget', () => ({
  KeyboardWidget: () => <div data-testid="keyboard-widget">KeyboardWidget</div>,
}))

vi.mock('../../keycodes/TabbedKeycodes', () => ({
  TabbedKeycodes: (props: Record<string, unknown>) => (
    <div data-testid="tabbed-keycodes">
      {props.keyboardPickerContent as React.ReactNode}
    </div>
  ),
}))

vi.mock('../../../../shared/keycodes/keycodes', () => ({
  serialize: (code: number) => `KC_${code}`,
  deserialize: () => 0,
  isMask: () => false,
  isTapDanceKeycode: () => false,
  getTapDanceIndex: () => -1,
  isMacroKeycode: () => false,
  getMacroIndex: () => -1,
  keycodeLabel: (qmkId: string) => qmkId,
  keycodeTooltip: (qmkId: string) => qmkId,
  isResetKeycode: () => false,
  isModifiableKeycode: () => false,
  extractModMask: () => 0,
  extractBasicKey: (code: number) => code & 0xff,
  buildModMaskKeycode: (mask: number, key: number) => (mask << 8) | key,
  findKeycode: (qmkId: string) => ({ qmkId, label: qmkId }),
}))

vi.mock('../../keycodes/ModifierCheckboxStrip', () => ({
  ModifierCheckboxStrip: () => null,
}))

vi.mock('../../../../preload/macro', () => ({
  deserializeAllMacros: () => [],
}))

import { KeymapEditor } from '../KeymapEditor'
import type { KleKey } from '../../../../shared/kle/types'

const KEY_DEFAULTS: KleKey = {
  x: 0, y: 0, width: 1, height: 1, row: 0, col: 0,
  encoderIdx: -1, encoderDir: -1, layoutIndex: -1, layoutOption: -1,
  decal: false, labels: [], x2: 0, y2: 0, width2: 1, height2: 1,
  rotation: 0, rotationX: 0, rotationY: 0, color: '',
  textColor: [], textSize: [], nub: false, stepped: false, ghost: false,
}

const makeLayout = () => ({ keys: [{ ...KEY_DEFAULTS, x: 0, col: 0 }] })

const mockLoadLayout = vi.fn()
const mockListStoredKeyboards = vi.fn().mockResolvedValue([])
const mockSnapshotStoreList = vi.fn().mockResolvedValue({ success: true, entries: [] })
const mockPipetteSettingsGet = vi.fn().mockResolvedValue(null)

beforeEach(() => {
  vi.clearAllMocks()
  Object.defineProperty(window, 'vialAPI', {
    value: {
      loadLayout: mockLoadLayout,
      listStoredKeyboards: mockListStoredKeyboards,
      snapshotStoreList: mockSnapshotStoreList,
      pipetteSettingsGet: mockPipetteSettingsGet,
    },
    writable: true,
    configurable: true,
  })
})

const defaultProps = {
  layout: makeLayout(),
  layers: 4,
  currentLayer: 0,
  keymap: new Map([['0,0,0', 1]]),
  encoderLayout: new Map<string, number>(),
  encoderCount: 0,
  layoutOptions: new Map<number, number>(),
  onSetKey: vi.fn().mockResolvedValue(undefined),
  onSetKeysBulk: vi.fn().mockResolvedValue(undefined),
  onSetEncoder: vi.fn().mockResolvedValue(undefined),
}

function switchToFileTab() {
  const fileBtn = screen.getByText('File')
  fireEvent.click(fileBtn)
}

function makeV1Vil() {
  return {
    uid: '0x1',
    keymap: {},
    encoderLayout: {},
    macros: [],
    layoutOptions: 0,
    tapDance: [],
    combo: [],
    keyOverride: [],
    altRepeatKey: [],
    qmkSettings: {},
  }
}

describe('KeymapEditor — picker file load error', () => {
  it('shows V1 warning when loading a V1 .vil file', async () => {
    const v1File = JSON.stringify(makeV1Vil())
    mockLoadLayout.mockResolvedValue({ success: true, data: v1File })

    render(<KeymapEditor {...defaultProps} />)

    await act(async () => switchToFileTab())

    const loadBtn = screen.getByText('Load from .pipette…')
    await act(async () => fireEvent.click(loadBtn))

    expect(screen.getByText('Legacy data format.')).toBeInTheDocument()
  })

  it('shows load failed error when loading an invalid file', async () => {
    mockLoadLayout.mockResolvedValue({ success: true, data: '{"invalid": true}' })

    render(<KeymapEditor {...defaultProps} />)

    await act(async () => switchToFileTab())

    const loadBtn = screen.getByText('Load from .pipette…')
    await act(async () => fireEvent.click(loadBtn))

    expect(screen.getByText('Load failed')).toBeInTheDocument()
  })

  it('clears error when retrying file load', async () => {
    const v1File = JSON.stringify(makeV1Vil())
    mockLoadLayout
      .mockResolvedValueOnce({ success: true, data: v1File })
      .mockResolvedValueOnce({ success: false, error: 'cancelled' })

    render(<KeymapEditor {...defaultProps} />)

    await act(async () => switchToFileTab())

    const loadBtn = screen.getByText('Load from .pipette…')

    // First load: V1 error
    await act(async () => fireEvent.click(loadBtn))
    expect(screen.getByText('Legacy data format.')).toBeInTheDocument()

    // Retry: error is cleared at start even if load is cancelled
    await act(async () => fireEvent.click(loadBtn))
    expect(screen.queryByText('Legacy data format.')).not.toBeInTheDocument()
  })

  it('shows load failed error when IPC returns failure', async () => {
    mockLoadLayout.mockResolvedValue({ success: false, error: 'read_error' })

    render(<KeymapEditor {...defaultProps} />)

    await act(async () => switchToFileTab())

    const loadBtn = screen.getByText('Load from .pipette…')
    await act(async () => fireEvent.click(loadBtn))

    expect(screen.getByText('Load failed')).toBeInTheDocument()
  })

  it('does not show error when user cancels file dialog', async () => {
    mockLoadLayout.mockResolvedValue({ success: false, error: 'cancelled' })

    render(<KeymapEditor {...defaultProps} />)

    await act(async () => switchToFileTab())

    const loadBtn = screen.getByText('Load from .pipette…')
    await act(async () => fireEvent.click(loadBtn))

    expect(screen.queryByText('Load failed')).not.toBeInTheDocument()
  })
})
