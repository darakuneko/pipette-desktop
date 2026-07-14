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
        'editor.viewMatrix.rowLabel': 'Row',
        'editor.viewMatrix.colLabel': 'Col',
        'editor.viewMatrix.blankOption': '—',
      }
      if (key === 'editor.keymap.layer' && opts) return `Layer ${opts.number ?? ''}`
      if (key === 'editor.keymap.layerN' && opts) return `Layer ${opts.n ?? ''}`
      if (key === 'editor.viewMatrix.duplicateWarning' && opts) return `${opts.count} key(s) share the same view position.`
      return map[key] ?? key
    },
  }),
}))

vi.mock('../../../hooks/useAppConfig', () => ({
  useAppConfig: () => ({ config: { maxKeymapHistory: 100 }, loading: false, set: () => {} }),
}))

type CapturedKey = { row: number; col: number; decal?: boolean; encoderIdx?: number }
type CapturedEvent = { ctrlKey: boolean; shiftKey: boolean }

let capturedOnKeyClick: ((key: CapturedKey, maskClicked?: boolean, event?: CapturedEvent) => void) | undefined
let capturedMultiSelectedKeys: Set<string> | undefined

vi.mock('../../keyboard/KeyboardWidget', () => ({
  KeyboardWidget: (props: {
    onKeyClick?: (key: CapturedKey, maskClicked?: boolean, event?: CapturedEvent) => void
    multiSelectedKeys?: Set<string>
  }) => {
    capturedOnKeyClick = props.onKeyClick
    capturedMultiSelectedKeys = props.multiSelectedKeys
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
    { x: 2, y: 0, w: 1, h: 1, row: 0, col: 2, encoderIdx: -1, decal: false, labels: [] },
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
      ['0,0,2', 6],
    ]),
    encoderLayout: new Map<string, number>(),
    encoderCount: 0,
    layoutOptions: new Map<number, number>(),
    onSetKey,
    onSetKeysBulk: vi.fn().mockResolvedValue(undefined),
    onSetEncoder,
    onViewMatrixChange,
    // Matrix dimensions independent of the 3-key layout above, so the
    // select-option-range test can tell them apart from key count.
    rows: 3,
    cols: 5,
  }

  beforeEach(() => {
    vi.clearAllMocks()
    capturedOnKeyClick = undefined
    capturedMultiSelectedKeys = undefined
  })

  function enterMode() {
    render(<KeymapEditor {...defaultProps} />)
    fireEvent.click(screen.getByTestId('overlay-view-matrix-edit-button'))
  }

  it('starts with normal editing: layer list and keycode picker shown, Edit button present', () => {
    render(<KeymapEditor {...defaultProps} />)

    expect(screen.getByTestId('layer-list-panel')).toBeInTheDocument()
    expect(screen.getByTestId('tabbed-keycodes')).toBeInTheDocument()
    expect(screen.queryByTestId('view-matrix-reset-panel')).not.toBeInTheDocument()
    expect(screen.getByTestId('overlay-view-matrix-edit-button')).toHaveTextContent('Edit')
  })

  it('entering the mode hides the layer selector and the entire keycode picker, and shows the panel', () => {
    enterMode()

    // The picker (tabs, tiles, overlay panel incl. its own Edit/Done button)
    // is unmounted entirely — nothing of it should remain in the DOM.
    expect(screen.queryByTestId('tabbed-keycodes')).not.toBeInTheDocument()
    expect(screen.queryByTestId('overlay-view-matrix-edit-button')).not.toBeInTheDocument()
    expect(screen.queryByTestId('layer-list-panel')).not.toBeInTheDocument()

    // The left pane shows the ON-state toggle + the keyboard is still shown.
    expect(screen.getByTestId('view-matrix-reset-panel')).toBeInTheDocument()
    expect(screen.getByTestId('view-matrix-mode-toggle')).toHaveTextContent('Done')
    expect(screen.getByTestId('keyboard-widget')).toBeInTheDocument()
  })

  it('clicking the mode toggle in the left pane exits back to normal mode and the picker returns', () => {
    enterMode()
    expect(screen.getByTestId('view-matrix-reset-panel')).toBeInTheDocument()

    fireEvent.click(screen.getByTestId('view-matrix-mode-toggle'))

    expect(screen.queryByTestId('view-matrix-reset-panel')).not.toBeInTheDocument()
    expect(screen.getByTestId('tabbed-keycodes')).toBeInTheDocument()
    expect(screen.getByTestId('layer-list-panel')).toBeInTheDocument()
    expect(screen.getByTestId('overlay-view-matrix-edit-button')).toHaveTextContent('Edit')
  })

  it('keeps the zoom toolbar mounted and functional while the mode is active', () => {
    const onScaleChange = vi.fn()
    render(<KeymapEditor {...defaultProps} scale={1} onScaleChange={onScaleChange} />)

    fireEvent.click(screen.getByTestId('overlay-view-matrix-edit-button'))

    const zoomInButton = screen.getByTestId('zoom-in-button')
    expect(zoomInButton).toBeInTheDocument()
    fireEvent.click(zoomInButton)
    expect(onScaleChange).toHaveBeenCalledWith(0.1)
  })

  it('selects are disabled with a blank value when no key is selected', () => {
    enterMode()

    expect(screen.getByTestId('view-matrix-row-select')).toBeDisabled()
    expect(screen.getByTestId('view-matrix-col-select')).toBeDisabled()
    expect(screen.getByTestId('view-matrix-row-select')).toHaveValue('')
    expect(screen.getByTestId('view-matrix-col-select')).toHaveValue('')
  })

  it('the Row/Col select options span the definition matrix dimensions (rows/cols props)', () => {
    enterMode()
    act(() => capturedOnKeyClick?.({ row: 0, col: 0, decal: false, encoderIdx: -1 }))

    const rowOptions = screen.getByTestId('view-matrix-row-select').querySelectorAll('option')
    const colOptions = screen.getByTestId('view-matrix-col-select').querySelectorAll('option')
    // rows=3, cols=5 in defaultProps — independent of the 3-key layout.
    expect(Array.from(rowOptions).map((o) => o.textContent)).toEqual(['0', '1', '2'])
    expect(Array.from(colOptions).map((o) => o.textContent)).toEqual(['0', '1', '2', '3', '4'])
  })

  it('key click in the mode selects it — the key gets the selected highlight and selects show its effective position', () => {
    enterMode()

    act(() => capturedOnKeyClick?.({ row: 0, col: 1, decal: false, encoderIdx: -1 }))

    expect(capturedMultiSelectedKeys).toEqual(new Set(['0,1']))
    expect(screen.getByTestId('view-matrix-row-select')).not.toBeDisabled()
    expect(screen.getByTestId('view-matrix-row-select')).toHaveValue('0')
    expect(screen.getByTestId('view-matrix-col-select')).toHaveValue('1')
  })

  it('changing the Row select saves immediately through the sparse-override semantics', () => {
    enterMode()
    act(() => capturedOnKeyClick?.({ row: 0, col: 0, decal: false, encoderIdx: -1 }))

    fireEvent.change(screen.getByTestId('view-matrix-row-select'), { target: { value: '2' } })

    expect(onViewMatrixChange).toHaveBeenCalledWith({ '0,0': { row: 2, col: 0 } })
  })

  it('reflects the override value, not the physical position, when a key with a saved override is selected', () => {
    render(<KeymapEditor {...defaultProps} viewMatrix={{ '0,0': { row: 2, col: 4 } }} />)
    fireEvent.click(screen.getByTestId('overlay-view-matrix-edit-button'))
    act(() => capturedOnKeyClick?.({ row: 0, col: 0, decal: false, encoderIdx: -1 }))

    expect(screen.getByTestId('view-matrix-row-select')).toHaveValue('2')
    expect(screen.getByTestId('view-matrix-col-select')).toHaveValue('4')
  })

  it('picking the value equal to the physical position removes the override (no Save button)', () => {
    // Col already matches the key's physical col — only Row carries an
    // override, so setting Row back to its physical value drops it.
    render(<KeymapEditor {...defaultProps} viewMatrix={{ '0,0': { row: 2, col: 0 } }} />)
    fireEvent.click(screen.getByTestId('overlay-view-matrix-edit-button'))
    act(() => capturedOnKeyClick?.({ row: 0, col: 0, decal: false, encoderIdx: -1 }))

    fireEvent.change(screen.getByTestId('view-matrix-row-select'), { target: { value: '0' } })

    expect(onViewMatrixChange).toHaveBeenCalledWith(undefined)
  })

  it('reset requires a 2-step confirm before calling onViewMatrixChange(undefined)', () => {
    enterMode()

    fireEvent.click(screen.getByTestId('view-matrix-reset-button'))
    expect(onViewMatrixChange).not.toHaveBeenCalled()

    fireEvent.click(screen.getByTestId('view-matrix-reset-confirm-button'))
    expect(onViewMatrixChange).toHaveBeenCalledWith(undefined)
  })

  it('exiting the mode restores the layer selector and normal key click selection', () => {
    enterMode()
    // The overlay's own toggle is hidden along with the rest of the picker
    // once the mode is active — exit through the left pane's toggle instead.
    fireEvent.click(screen.getByTestId('view-matrix-mode-toggle'))

    expect(screen.getByTestId('overlay-view-matrix-edit-button')).toHaveTextContent('Edit')
    expect(screen.getByTestId('layer-list-panel')).toBeInTheDocument()
    expect(screen.queryByTestId('view-matrix-reset-panel')).not.toBeInTheDocument()

    act(() => capturedOnKeyClick?.({ row: 0, col: 0, decal: false, encoderIdx: -1 }))
    expect(screen.getByText('[0,0]')).toBeInTheDocument()
  })

  it('does not select a decal or encoder position', () => {
    enterMode()

    act(() => capturedOnKeyClick?.({ row: 0, col: 0, decal: true, encoderIdx: -1 }))
    expect(capturedMultiSelectedKeys).toEqual(new Set())

    act(() => capturedOnKeyClick?.({ row: 0, col: 0, decal: false, encoderIdx: 0 }))
    expect(capturedMultiSelectedKeys).toEqual(new Set())
  })

  it('Ctrl-click adds a second key to the selection and both selects go blank', () => {
    enterMode()
    act(() => capturedOnKeyClick?.({ row: 0, col: 0, decal: false, encoderIdx: -1 }))
    act(() => capturedOnKeyClick?.({ row: 0, col: 1, decal: false, encoderIdx: -1 }, false, { ctrlKey: true, shiftKey: false }))

    expect(capturedMultiSelectedKeys).toEqual(new Set(['0,0', '0,1']))
    expect(screen.getByTestId('view-matrix-row-select')).toHaveValue('')
    expect(screen.getByTestId('view-matrix-col-select')).toHaveValue('')
    // Blank while multi-selected, but still interactive (not disabled).
    expect(screen.getByTestId('view-matrix-row-select')).not.toBeDisabled()
  })

  it('Shift-click extends a contiguous range across the visible key order', () => {
    enterMode()
    act(() => capturedOnKeyClick?.({ row: 0, col: 0, decal: false, encoderIdx: -1 }))
    act(() => capturedOnKeyClick?.({ row: 0, col: 2, decal: false, encoderIdx: -1 }, false, { ctrlKey: false, shiftKey: true }))

    expect(capturedMultiSelectedKeys).toEqual(new Set(['0,0', '0,1', '0,2']))
  })

  it('choosing a Row value bulk-applies it to every selected key in one save, each keeping its own col', () => {
    enterMode()
    act(() => capturedOnKeyClick?.({ row: 0, col: 0, decal: false, encoderIdx: -1 }))
    act(() => capturedOnKeyClick?.({ row: 0, col: 1, decal: false, encoderIdx: -1 }, false, { ctrlKey: true, shiftKey: false }))

    fireEvent.change(screen.getByTestId('view-matrix-row-select'), { target: { value: '2' } })

    expect(onViewMatrixChange).toHaveBeenCalledTimes(1)
    expect(onViewMatrixChange).toHaveBeenCalledWith({
      '0,0': { row: 2, col: 0 },
      '0,1': { row: 2, col: 1 },
    })
  })

  it('choosing a Col value bulk-applies it to every selected key, each keeping its own row', () => {
    enterMode()
    act(() => capturedOnKeyClick?.({ row: 0, col: 0, decal: false, encoderIdx: -1 }))
    act(() => capturedOnKeyClick?.({ row: 0, col: 1, decal: false, encoderIdx: -1 }, false, { ctrlKey: true, shiftKey: false }))

    fireEvent.change(screen.getByTestId('view-matrix-col-select'), { target: { value: '4' } })

    expect(onViewMatrixChange).toHaveBeenCalledWith({
      '0,0': { row: 0, col: 4 },
      '0,1': { row: 0, col: 4 },
    })
  })

  it('shows no duplicate warning when every key has a distinct view position', () => {
    enterMode()

    expect(screen.queryByTestId('view-matrix-duplicate-warning')).not.toBeInTheDocument()
  })

  it('shows a persistent duplicate warning while two keys resolve to the same view position', () => {
    // (0,1)'s override collides with (0,0)'s physical position.
    render(<KeymapEditor {...defaultProps} viewMatrix={{ '0,1': { row: 0, col: 0 } }} />)
    fireEvent.click(screen.getByTestId('overlay-view-matrix-edit-button'))

    expect(screen.getByTestId('view-matrix-duplicate-warning')).toHaveTextContent('2 key(s) share the same view position.')
  })

  it('clears the duplicate warning once the collision is resolved', () => {
    const { rerender } = render(<KeymapEditor {...defaultProps} viewMatrix={{ '0,1': { row: 0, col: 0 } }} />)
    fireEvent.click(screen.getByTestId('overlay-view-matrix-edit-button'))
    expect(screen.getByTestId('view-matrix-duplicate-warning')).toBeInTheDocument()

    rerender(<KeymapEditor {...defaultProps} viewMatrix={undefined} />)
    expect(screen.queryByTestId('view-matrix-duplicate-warning')).not.toBeInTheDocument()
  })
})
