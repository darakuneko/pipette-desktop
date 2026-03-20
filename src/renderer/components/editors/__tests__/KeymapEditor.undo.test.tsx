// SPDX-License-Identifier: GPL-2.0-or-later
// @vitest-environment jsdom

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, act } from '@testing-library/react'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) => {
      const map: Record<string, string> = {
        'common.loading': 'Loading...',
        'editor.keymap.layer': `Layer ${opts?.number ?? ''}`,
        'editor.keymap.selectKey': 'Click a key to edit',
      }
      return map[key] ?? key
    },
  }),
}))

let capturedOnKeyClick: ((key: { row: number; col: number }) => void) | undefined
let capturedOnKeyDoubleClick: ((key: { row: number; col: number }, rect: DOMRect, maskClicked?: boolean) => void) | undefined

vi.mock('../../keyboard/KeyboardWidget', () => ({
  KeyboardWidget: (props: {
    onKeyClick?: (key: { row: number; col: number }) => void
    onKeyDoubleClick?: (key: { row: number; col: number }, rect: DOMRect, maskClicked?: boolean) => void
  }) => {
    capturedOnKeyClick = props.onKeyClick
    capturedOnKeyDoubleClick = props.onKeyDoubleClick
    return <div data-testid="keyboard-widget">KeyboardWidget</div>
  },
}))

vi.mock('../../keycodes/TabbedKeycodes', () => ({
  TabbedKeycodes: (props: {
    onKeycodeSelect?: (kc: { qmkId: string }) => void
  }) => (
    <div data-testid="tabbed-keycodes">
      <button
        data-testid="kc-a"
        onClick={() => props.onKeycodeSelect?.({ qmkId: 'KC_A' })}
      >
        A
      </button>
    </div>
  ),
}))

let capturedPreviousKeycode: number | undefined

vi.mock('../../keycodes/KeyPopover', () => ({
  KeyPopover: (props: {
    previousKeycode?: number
    onUndo?: () => void
    onKeycodeSelect?: (kc: { qmkId: string }) => void
    onRawKeycodeSelect?: (code: number) => void
    onClose?: () => void
  }) => {
    capturedPreviousKeycode = props.previousKeycode
    return (
      <div data-testid="key-popover">
        <button
          data-testid="popover-kc-a"
          onClick={() => props.onKeycodeSelect?.({ qmkId: 'KC_A' })}
        >
          Popover A
        </button>
        {props.previousKeycode != null && props.onUndo && (
          <button data-testid="popover-undo" onClick={props.onUndo}>
            Undo
          </button>
        )}
      </div>
    )
  },
}))

vi.mock('../../../../shared/keycodes/keycodes', () => ({
  serialize: (code: number) => `KC_${code}`,
  deserialize: (val: string) => {
    if (val === 'KC_A') return 4
    return 0
  },
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

describe('KeymapEditor — undo after single-click selection', () => {
  const onSetKey = vi.fn().mockResolvedValue(undefined)
  const onSetEncoder = vi.fn().mockResolvedValue(undefined)

  const mockRect = {
    top: 100, left: 200, bottom: 140, right: 260,
    width: 60, height: 40, x: 200, y: 100, toJSON: () => ({}),
  } as DOMRect

  const defaultProps = {
    layout: makeLayout(),
    layers: 2,
    currentLayer: 0,
    onLayerChange: vi.fn(),
    keymap: new Map([
      ['0,0,0', 5], // KC_B (code 5)
      ['0,0,1', 6], // KC_C (code 6)
    ]),
    encoderLayout: new Map<string, number>(),
    encoderCount: 0,
    layoutOptions: new Map<number, number>(),
    onSetKey,
    onSetKeysBulk: vi.fn().mockResolvedValue(undefined),
    onSetEncoder,
    autoAdvance: false,
  }

  beforeEach(() => {
    vi.clearAllMocks()
    capturedOnKeyClick = undefined
    capturedOnKeyDoubleClick = undefined
    capturedPreviousKeycode = undefined
  })

  it('records undo when assigning keycode via single-click picker flow', async () => {
    render(<KeymapEditor {...defaultProps} />)

    // Single-click key [0,0] to select it
    act(() => capturedOnKeyClick?.({ row: 0, col: 0 }))
    expect(screen.getByText('[0,0]')).toBeInTheDocument()

    // Click KC_A in picker — triggers handleKeycodeSelect → recordUndo
    await act(async () => {
      fireEvent.click(screen.getByTestId('kc-a'))
    })

    // onSetKey should have been called
    expect(onSetKey).toHaveBeenCalledWith(0, 0, 0, 4) // layer 0, row 0, col 0, KC_A (4)

    // Double-click the same key to open popover
    act(() => capturedOnKeyDoubleClick?.({ row: 0, col: 0 }, mockRect))
    expect(screen.getByTestId('key-popover')).toBeInTheDocument()

    // Undo button should appear with previous keycode (5 = KC_B)
    expect(screen.getByTestId('popover-undo')).toBeInTheDocument()
    expect(capturedPreviousKeycode).toBe(5)
  })

  it('does NOT show undo when popover is opened without prior single-click assignment', () => {
    render(<KeymapEditor {...defaultProps} />)

    // Directly double-click key [0,0] — no prior single-click assignment
    act(() => capturedOnKeyDoubleClick?.({ row: 0, col: 0 }, mockRect))
    expect(screen.getByTestId('key-popover')).toBeInTheDocument()

    // Undo button should NOT appear (nothing in undoMap)
    expect(screen.queryByTestId('popover-undo')).not.toBeInTheDocument()
    expect(capturedPreviousKeycode).toBeUndefined()
  })

  it('popover undo reverts keycode via onSetKey', async () => {
    render(<KeymapEditor {...defaultProps} />)

    // Single-click select → assign KC_A
    act(() => capturedOnKeyClick?.({ row: 0, col: 0 }))
    await act(async () => {
      fireEvent.click(screen.getByTestId('kc-a'))
    })
    onSetKey.mockClear()

    // Open popover and click undo
    act(() => capturedOnKeyDoubleClick?.({ row: 0, col: 0 }, mockRect))
    await act(async () => {
      fireEvent.click(screen.getByTestId('popover-undo'))
    })

    // Should revert to previous keycode (5)
    expect(onSetKey).toHaveBeenCalledWith(0, 0, 0, 5)
  })

  it('records undo for popover keycode selection as well', async () => {
    render(<KeymapEditor {...defaultProps} />)

    // Double-click to open popover
    act(() => capturedOnKeyDoubleClick?.({ row: 0, col: 0 }, mockRect))
    expect(screen.getByTestId('key-popover')).toBeInTheDocument()

    // No undo initially
    expect(screen.queryByTestId('popover-undo')).not.toBeInTheDocument()

    // Select keycode via popover — triggers handlePopoverKeycodeSelect → recordUndo
    await act(async () => {
      fireEvent.click(screen.getByTestId('popover-kc-a'))
    })

    // Popover should still be open and now show undo
    expect(screen.getByTestId('key-popover')).toBeInTheDocument()
    expect(screen.getByTestId('popover-undo')).toBeInTheDocument()
    expect(capturedPreviousKeycode).toBe(5)
  })
})
