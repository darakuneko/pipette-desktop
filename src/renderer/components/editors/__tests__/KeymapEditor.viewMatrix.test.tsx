// SPDX-License-Identifier: GPL-2.0-or-later
// @vitest-environment jsdom

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, act } from '@testing-library/react'
import type { ReactNode } from 'react'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) => {
      const map: Record<string, string> = {
        'common.loading': 'Loading...',
        'common.save': 'Save',
        'common.cancel': 'Cancel',
        'common.confirmReset': 'Reset?',
        'editor.keymap.selectKey': 'Click a key to edit',
        'editor.viewMatrix.label': 'View Matrix',
        'editor.viewMatrix.edit': 'Edit',
        'editor.viewMatrix.done': 'Done',
        'editor.viewMatrix.reset': 'Reset View Matrix',
        'editor.viewMatrix.modalTitle': 'Edit View Position',
        'editor.viewMatrix.physicalLabel': 'Matrix',
        'editor.viewMatrix.rowLabel': 'Row',
        'editor.viewMatrix.colLabel': 'Col',
      }
      if (key === 'editor.keymap.layer' && opts) return `Layer ${opts.number ?? ''}`
      if (key === 'editor.keymap.layerN' && opts) return `Layer ${opts.n ?? ''}`
      return map[key] ?? key
    },
  }),
}))

vi.mock('../../../hooks/useAppConfig', () => ({
  useAppConfig: () => ({ config: { maxKeymapHistory: 100 }, loading: false, set: () => {} }),
}))

let capturedOnKeyClick: ((key: { row: number; col: number; decal?: boolean; encoderIdx?: number }) => void) | undefined

vi.mock('../../keyboard/KeyboardWidget', () => ({
  KeyboardWidget: (props: {
    onKeyClick?: (key: { row: number; col: number; decal?: boolean; encoderIdx?: number }) => void
  }) => {
    capturedOnKeyClick = props.onKeyClick
    return <div data-testid="keyboard-widget">KeyboardWidget</div>
  },
}))

// Renders the real overlay (panelOverlay) so the View Matrix Edit/Done
// button and Reset panel can be interacted with, unlike the lighter
// TabbedKeycodes stub used by the autoAdvance test suite.
vi.mock('../../keycodes/TabbedKeycodes', () => ({
  TabbedKeycodes: (props: { panelOverlay?: ReactNode; onKeycodeSelect?: (kc: { qmkId: string }) => void }) => (
    <div data-testid="tabbed-keycodes">
      <button data-testid="kc-a" onClick={() => props.onKeycodeSelect?.({ qmkId: 'KC_A' })}>A</button>
      {props.panelOverlay}
    </div>
  ),
}))

vi.mock('../../keycodes/KeyPopover', () => ({
  KeyPopover: () => <div data-testid="key-popover" />,
}))

vi.mock('../../../../shared/keycodes/keycodes', () => ({
  serialize: (code: number) => `KC_${code}`,
  deserialize: (val: string) => (val === 'KC_A' ? 4 : 0),
  isMask: () => false,
  isLMKeycode: () => false,
  resolve: () => 0,
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

vi.mock('../TapDanceModal', () => ({ TapDanceModal: () => null }))
vi.mock('../MacroModal', () => ({ MacroModal: () => null }))

import { KeymapEditor } from '../KeymapEditor'

const makeLayout = () => ({
  keys: [
    { x: 0, y: 0, w: 1, h: 1, row: 0, col: 0, encoderIdx: -1, decal: false, labels: [] },
    { x: 1, y: 0, w: 1, h: 1, row: 0, col: 1, encoderIdx: -1, decal: false, labels: [] },
  ],
})

describe('KeymapEditor — View Matrix mode', () => {
  const onSetKey = vi.fn().mockResolvedValue(undefined)
  const onSetEncoder = vi.fn().mockResolvedValue(undefined)
  const onLayerChange = vi.fn()
  const onViewMatrixChange = vi.fn()

  const defaultProps = {
    layout: makeLayout(),
    layers: 2,
    currentLayer: 0,
    onLayerChange,
    keymap: new Map([
      ['0,0,0', 4],
      ['0,0,1', 5],
    ]),
    encoderLayout: new Map<string, number>(),
    encoderCount: 0,
    layoutOptions: new Map<number, number>(),
    onSetKey,
    onSetKeysBulk: vi.fn().mockResolvedValue(undefined),
    onSetEncoder,
    onViewMatrixChange,
  }

  beforeEach(() => {
    vi.clearAllMocks()
    capturedOnKeyClick = undefined
  })

  it('starts with normal editing: layer list shown, Edit button present', () => {
    render(<KeymapEditor {...defaultProps} />)

    expect(screen.getByTestId('layer-list-panel')).toBeInTheDocument()
    expect(screen.queryByTestId('view-matrix-reset-panel')).not.toBeInTheDocument()
    expect(screen.getByTestId('overlay-view-matrix-edit-button')).toHaveTextContent('Edit')
  })

  it('entering the mode hides the layer selector and shows the Reset panel', () => {
    render(<KeymapEditor {...defaultProps} />)

    fireEvent.click(screen.getByTestId('overlay-view-matrix-edit-button'))

    expect(screen.getByTestId('overlay-view-matrix-edit-button')).toHaveTextContent('Done')
    expect(screen.queryByTestId('layer-list-panel')).not.toBeInTheDocument()
    expect(screen.getByTestId('view-matrix-reset-panel')).toBeInTheDocument()
  })

  it('key click in the mode opens the edit modal instead of selecting the key', () => {
    render(<KeymapEditor {...defaultProps} />)
    fireEvent.click(screen.getByTestId('overlay-view-matrix-edit-button'))

    act(() => capturedOnKeyClick?.({ row: 0, col: 0, decal: false, encoderIdx: -1 }))

    expect(screen.getByTestId('view-matrix-modal')).toBeInTheDocument()
    // No normal single-key selection indicator should appear.
    expect(screen.queryByText('[0,0]')).not.toBeInTheDocument()
  })

  it('saving the modal persists the override via onViewMatrixChange', () => {
    render(<KeymapEditor {...defaultProps} />)
    fireEvent.click(screen.getByTestId('overlay-view-matrix-edit-button'))
    act(() => capturedOnKeyClick?.({ row: 0, col: 0, decal: false, encoderIdx: -1 }))

    fireEvent.change(screen.getByTestId('view-matrix-row-input'), { target: { value: '3' } })
    fireEvent.change(screen.getByTestId('view-matrix-col-input'), { target: { value: '1' } })
    fireEvent.click(screen.getByTestId('view-matrix-save-button'))

    expect(onViewMatrixChange).toHaveBeenCalledWith({ '0,0': { row: 3, col: 1 } })
    expect(screen.queryByTestId('view-matrix-modal')).not.toBeInTheDocument()
  })

  it('reset requires a 2-step confirm before calling onViewMatrixChange(undefined)', () => {
    render(<KeymapEditor {...defaultProps} />)
    fireEvent.click(screen.getByTestId('overlay-view-matrix-edit-button'))

    fireEvent.click(screen.getByTestId('view-matrix-reset-button'))
    expect(onViewMatrixChange).not.toHaveBeenCalled()

    fireEvent.click(screen.getByTestId('view-matrix-reset-confirm-button'))
    expect(onViewMatrixChange).toHaveBeenCalledWith(undefined)
  })

  it('exiting the mode restores the layer selector and normal key click selection', () => {
    render(<KeymapEditor {...defaultProps} />)
    fireEvent.click(screen.getByTestId('overlay-view-matrix-edit-button'))
    fireEvent.click(screen.getByTestId('overlay-view-matrix-edit-button'))

    expect(screen.getByTestId('overlay-view-matrix-edit-button')).toHaveTextContent('Edit')
    expect(screen.getByTestId('layer-list-panel')).toBeInTheDocument()
    expect(screen.queryByTestId('view-matrix-reset-panel')).not.toBeInTheDocument()

    act(() => capturedOnKeyClick?.({ row: 0, col: 0, decal: false, encoderIdx: -1 }))
    expect(screen.getByText('[0,0]')).toBeInTheDocument()
    expect(screen.queryByTestId('view-matrix-modal')).not.toBeInTheDocument()
  })

  it('does not open the edit modal for a decal or encoder position', () => {
    render(<KeymapEditor {...defaultProps} />)
    fireEvent.click(screen.getByTestId('overlay-view-matrix-edit-button'))

    act(() => capturedOnKeyClick?.({ row: 0, col: 0, decal: true, encoderIdx: -1 }))
    expect(screen.queryByTestId('view-matrix-modal')).not.toBeInTheDocument()

    act(() => capturedOnKeyClick?.({ row: 0, col: 0, decal: false, encoderIdx: 0 }))
    expect(screen.queryByTestId('view-matrix-modal')).not.toBeInTheDocument()
  })
})
