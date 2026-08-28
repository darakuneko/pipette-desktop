// SPDX-License-Identifier: GPL-2.0-or-later
// @vitest-environment jsdom

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, act, fireEvent } from '@testing-library/react'
import type { ReactNode } from 'react'
import type { Keycode } from '../../../../shared/keycodes/keycodes'
import type { DeviceInfo } from '../../../../shared/types/protocol'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) => {
      const map: Record<string, string> = {
        'common.loading': 'Loading...',
        'editor.keymap.layerN': `Layer ${opts?.n ?? ''}`,
        'editor.keymap.zoomIn': 'Zoom In',
        'editor.keymap.zoomOut': 'Zoom Out',
        'editor.keymap.clickToPaste': 'Click a key to paste',
        'editorSettings.title': 'Settings',
      }
      return map[key] ?? key
    },
  }),
}))

vi.mock('../../../hooks/useAppConfig', () => ({
  useAppConfig: () => ({ config: { maxKeymapHistory: 100 }, loading: false, set: () => {} }),
}))

let capturedWidgetProps: Array<Record<string, unknown>> = []
let capturedTabbedProps: Record<string, unknown> = {}
// Opt-in switch for the Keyboard-tab source-domain tests below: mounting the
// picker's own `<KeyboardPane>` (via `keyboardPickerContent`) pulls in real
// `LayoutPickerContent` chrome (Tooltip, ScaleInput, lucide icons) that the
// rest of this file's tests have no need for, so it stays off by default and
// each test that needs it flips it on in its own `beforeEach`.
let renderKeyboardPickerContent = false

vi.mock('../../keyboard/KeyboardWidget', () => ({
  KeyboardWidget: (props: Record<string, unknown>) => {
    capturedWidgetProps.push(props)
    return <div data-testid="keyboard-widget">KeyboardWidget</div>
  },
}))

vi.mock('../../keycodes/TabbedKeycodes', () => ({
  TabbedKeycodes: (props: Record<string, unknown>) => {
    capturedTabbedProps = props
    return (
      <div data-testid="tabbed-keycodes">
        TabbedKeycodes
        {renderKeyboardPickerContent ? (props.keyboardPickerContent as ReactNode) : null}
      </div>
    )
  },
}))

vi.mock('../../../../shared/keycodes/keycodes', () => ({
  serialize: (code: number) => `KC_${code}`,
  deserialize: (qmkId: string) => {
    const m = qmkId.match(/^KC_(\d+)$/)
    return m ? Number(m[1]) : 0
  },
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

// Encoder/decal keys keep `parseKle`'s `row: 0, col: 0` defaults (only a
// normal key's `labels[0]` "row,col" pair overwrites them) — pass col 0 with
// the encoder/decal fields in `extra` to mirror that.
function makeKey(x: number, col: number, extra: Partial<KleKey> = {}): KleKey {
  return { ...KEY_DEFAULTS, x, col, ...extra }
}

const makeLayout = () => ({
  keys: [makeKey(0, 0), makeKey(1, 1), makeKey(2, 2), makeKey(3, 3)],
})

// Declared col order (1,2,0,3) disagrees with matrix order (ascending col:
// 0,1,2,3) on which key follows col 0 — shared by the tests below that
// assert paste targets / Shift-range walk matrix order, not KLE declaration
// order.
const makeScrambledLayout = () => ({
  keys: [makeKey(0, 1), makeKey(1, 2), makeKey(2, 0), makeKey(3, 3)],
})
const SCRAMBLED_KEYMAP = new Map([
  ['0,0,0', 0], ['0,0,1', 0], ['0,0,2', 0], ['0,0,3', 0],
])

// Structural stand-in for the Keycode class instances the picker consumes.
function makeKeycode(qmkId: string, label?: string): Keycode {
  return {
    qmkId,
    cExportId: undefined,
    label: label ?? qmkId,
    tooltip: undefined,
    masked: false,
    printable: undefined,
    alias: [qmkId],
    requiresFeature: undefined,
    hidden: false,
    isSupportedBy: () => true,
  }
}

const TAB_KEYCODES = [
  makeKeycode('KC_10', 'A'),
  makeKeycode('KC_11', 'B'),
  makeKeycode('KC_12', 'C'),
  makeKeycode('KC_13', 'D'),
  makeKeycode('KC_14', 'E'),
]

describe('KeymapEditor — picker paste', () => {
  const onSetKey = vi.fn().mockResolvedValue(undefined)
  const onSetKeysBulk = vi.fn().mockResolvedValue(undefined)

  const defaultProps = {
    layout: makeLayout(),
    layers: 4,
    currentLayer: 0,
    keymap: new Map([
      ['0,0,0', 1],
      ['0,0,1', 2],
      ['0,0,2', 3],
      ['0,0,3', 4],
    ]),
    encoderLayout: new Map<string, number>(),
    encoderCount: 0,
    layoutOptions: new Map<number, number>(),
    onSetKey,
    onSetKeysBulk,
    onSetEncoder: vi.fn().mockResolvedValue(undefined),
  }

  beforeEach(() => {
    vi.clearAllMocks()
    capturedWidgetProps = []
    capturedTabbedProps = {}
  })

  const TAB_KEYCODE_NUMBERS = TAB_KEYCODES.map((kc) => parseInt(kc.qmkId.replace(/\D/g, ''), 10))

  function getOnKeycodeMultiSelect() {
    return capturedTabbedProps.onKeycodeMultiSelect as
      ((index: number, keycode: number, event: { ctrlKey: boolean; shiftKey: boolean }, tabKeycodeNumbers: number[]) => void) | undefined
  }

  function getOnKeycodeSelect() {
    return capturedTabbedProps.onKeycodeSelect as ((kc: Keycode) => void) | undefined
  }

  function getPickerSelectedSet() {
    return capturedTabbedProps.pickerSelectedIndices as Set<number> | undefined
  }

  function getActiveOnKeyClick() {
    return capturedWidgetProps.find((p) => p.onKeyClick != null)?.onKeyClick as
      ((key: KleKey, maskClicked: boolean, event?: { ctrlKey: boolean; shiftKey: boolean }) => void) | undefined
  }

  function getLatestOnKeyClick() {
    return capturedWidgetProps.filter((p) => p.onKeyClick != null).pop()?.onKeyClick as
      ((key: KleKey, maskClicked: boolean, event?: { ctrlKey: boolean; shiftKey: boolean }) => void) | undefined
  }

  it('adds keycode to picker selection on Ctrl+click (no key selected)', () => {
    render(<KeymapEditor {...defaultProps} />)
    const multiSelect = getOnKeycodeMultiSelect()!

    act(() => {
      multiSelect(0, TAB_KEYCODE_NUMBERS[0], { ctrlKey: true, shiftKey: false }, TAB_KEYCODE_NUMBERS)
    })

    const selected = getPickerSelectedSet()!
    expect(selected.has(0)).toBe(true)
    expect(selected.size).toBe(1)
  })

  it('toggles off on second Ctrl+click of same keycode (toggle)', () => {
    render(<KeymapEditor {...defaultProps} />)
    const multiSelect = getOnKeycodeMultiSelect()!

    act(() => {
      multiSelect(0, TAB_KEYCODE_NUMBERS[0], { ctrlKey: true, shiftKey: false }, TAB_KEYCODE_NUMBERS)
    })

    act(() => {
      multiSelect(0, TAB_KEYCODE_NUMBERS[0], { ctrlKey: true, shiftKey: false }, TAB_KEYCODE_NUMBERS)
    })

    const selected = getPickerSelectedSet()!
    // Second Ctrl+click of same keycode at same index removes it (toggle)
    expect(selected.has(0)).toBe(false)
    expect(selected.size).toBe(0)
  })

  it('selects range on Shift+click after Ctrl anchor', () => {
    render(<KeymapEditor {...defaultProps} />)

    // Ctrl+click to set anchor at index 1
    act(() => {
      getOnKeycodeMultiSelect()!(1, TAB_KEYCODE_NUMBERS[1], { ctrlKey: true, shiftKey: false }, TAB_KEYCODE_NUMBERS)
    })

    // Shift+click at index 3 (re-get callback to capture updated pickerAnchor)
    act(() => {
      getOnKeycodeMultiSelect()!(3, TAB_KEYCODE_NUMBERS[3], { ctrlKey: false, shiftKey: true }, TAB_KEYCODE_NUMBERS)
    })

    const selected = getPickerSelectedSet()!
    expect(selected.has(1)).toBe(true)
    expect(selected.has(2)).toBe(true)
    expect(selected.has(3)).toBe(true)
    expect(selected.size).toBe(3)
  })

  it('pastes picker selection to keymap on normal click', async () => {
    render(<KeymapEditor {...defaultProps} />)
    const multiSelect = getOnKeycodeMultiSelect()!

    // Select KC_10 and KC_11
    act(() => {
      multiSelect(0, TAB_KEYCODE_NUMBERS[0], { ctrlKey: true, shiftKey: false }, TAB_KEYCODE_NUMBERS)
    })
    act(() => {
      multiSelect(1, TAB_KEYCODE_NUMBERS[1], { ctrlKey: true, shiftKey: false }, TAB_KEYCODE_NUMBERS)
    })

    // Normal click on key [0,1] to paste
    const onKeyClick = getLatestOnKeyClick()!
    await act(async () => {
      onKeyClick({ row: 0, col: 1 } as KleKey, false, { ctrlKey: false, shiftKey: false })
    })

    expect(onSetKeysBulk).toHaveBeenCalledTimes(1)
    expect(onSetKeysBulk).toHaveBeenCalledWith([
      { layer: 0, row: 0, col: 1, keycode: 10 }, // KC_10 -> [0,1]
      { layer: 0, row: 0, col: 2, keycode: 11 }, // KC_11 -> [0,2]
    ])
  })

  it('pastes in click order for Ctrl selection', async () => {
    render(<KeymapEditor {...defaultProps} />)
    const multiSelect = getOnKeycodeMultiSelect()!

    // Ctrl+click in order: KC_12 then KC_10
    act(() => {
      multiSelect(2, TAB_KEYCODE_NUMBERS[2], { ctrlKey: true, shiftKey: false }, TAB_KEYCODE_NUMBERS)
    })
    act(() => {
      multiSelect(0, TAB_KEYCODE_NUMBERS[0], { ctrlKey: true, shiftKey: false }, TAB_KEYCODE_NUMBERS)
    })

    const onKeyClick = getLatestOnKeyClick()!
    await act(async () => {
      onKeyClick({ row: 0, col: 0 } as KleKey, false, { ctrlKey: false, shiftKey: false })
    })

    // Index order (sorted by display position): KC_10 (idx 0), KC_12 (idx 2)
    expect(onSetKeysBulk).toHaveBeenCalledTimes(1)
    expect(onSetKeysBulk).toHaveBeenCalledWith([
      { layer: 0, row: 0, col: 0, keycode: 10 }, // KC_10 (idx 0) -> [0,0]
      { layer: 0, row: 0, col: 1, keycode: 12 }, // KC_12 (idx 2) -> [0,1]
    ])
  })

  it('clears picker selection after paste', async () => {
    render(<KeymapEditor {...defaultProps} />)
    const multiSelect = getOnKeycodeMultiSelect()!

    act(() => {
      multiSelect(0, TAB_KEYCODE_NUMBERS[0], { ctrlKey: true, shiftKey: false }, TAB_KEYCODE_NUMBERS)
    })

    const onKeyClick = getLatestOnKeyClick()!
    await act(async () => {
      onKeyClick({ row: 0, col: 0 } as KleKey, false, { ctrlKey: false, shiftKey: false })
    })

    const selected = getPickerSelectedSet()!
    expect(selected.size).toBe(0)
  })

  it('allows picker multi-select even when a key is selected', () => {
    render(<KeymapEditor {...defaultProps} />)

    // Select a key first
    const onKeyClick = getActiveOnKeyClick()!
    act(() => {
      onKeyClick({ row: 0, col: 0 } as KleKey, false)
    })

    // Ctrl+click picker multi-select — should work (deselects key first)
    const multiSelect = getOnKeycodeMultiSelect()!
    act(() => {
      multiSelect(0, TAB_KEYCODE_NUMBERS[0], { ctrlKey: true, shiftKey: false }, TAB_KEYCODE_NUMBERS)
    })

    const selected = getPickerSelectedSet()!
    expect(selected.size).toBe(1)
    expect(selected.has(0)).toBe(true)
  })

  it('clears picker selection on normal keycode click', () => {
    render(<KeymapEditor {...defaultProps} />)
    const multiSelect = getOnKeycodeMultiSelect()!

    act(() => {
      multiSelect(0, TAB_KEYCODE_NUMBERS[0], { ctrlKey: true, shiftKey: false }, TAB_KEYCODE_NUMBERS)
    })

    expect(getPickerSelectedSet()!.size).toBe(1)

    // Normal click on keycode (no modifier)
    const onKeycodeSelect = getOnKeycodeSelect()!
    act(() => {
      onKeycodeSelect(TAB_KEYCODES[1])
    })

    expect(getPickerSelectedSet()!.size).toBe(0)
  })

  it('clears picker selection on pane Ctrl+click (mutual exclusion)', () => {
    render(<KeymapEditor {...defaultProps} />)
    const multiSelect = getOnKeycodeMultiSelect()!

    act(() => {
      multiSelect(0, TAB_KEYCODE_NUMBERS[0], { ctrlKey: true, shiftKey: false }, TAB_KEYCODE_NUMBERS)
    })
    expect(getPickerSelectedSet()!.size).toBe(1)

    // Ctrl+click on keymap
    const onKeyClick = getLatestOnKeyClick()!
    act(() => {
      onKeyClick({ row: 0, col: 0 } as KleKey, false, { ctrlKey: true, shiftKey: false })
    })

    expect(getPickerSelectedSet()!.size).toBe(0)
  })

  it('clears pane multi-selection on picker Ctrl+click (mutual exclusion)', () => {
    render(<KeymapEditor {...defaultProps} />)

    // Select key on keymap with Ctrl+click
    const onKeyClick = getActiveOnKeyClick()!
    act(() => {
      onKeyClick({ row: 0, col: 0 } as KleKey, false, { ctrlKey: true, shiftKey: false })
    })

    // Verify pane multi-selection exists
    const widgetWithSelection = capturedWidgetProps.find((p) => {
      const ms = p.multiSelectedKeys as Set<string> | undefined
      return ms != null && ms.size > 0
    })
    expect(widgetWithSelection).toBeDefined()

    // Picker Ctrl+click should clear pane selection
    const multiSelect = getOnKeycodeMultiSelect()!
    act(() => {
      multiSelect(0, TAB_KEYCODE_NUMBERS[0], { ctrlKey: true, shiftKey: false }, TAB_KEYCODE_NUMBERS)
    })

    // Pane selection should be cleared
    const finalWidget = capturedWidgetProps.filter((p) => p.onKeyClick != null).pop()
    const ms = finalWidget?.multiSelectedKeys as Set<string> | undefined
    expect(ms?.size ?? 0).toBe(0)
  })

  it('truncates paste at layout end', async () => {
    render(<KeymapEditor {...defaultProps} />)
    const multiSelect = getOnKeycodeMultiSelect()!

    // Select 3 keycodes
    act(() => {
      multiSelect(0, TAB_KEYCODE_NUMBERS[0], { ctrlKey: true, shiftKey: false }, TAB_KEYCODE_NUMBERS)
    })
    act(() => {
      multiSelect(1, TAB_KEYCODE_NUMBERS[1], { ctrlKey: true, shiftKey: false }, TAB_KEYCODE_NUMBERS)
    })
    act(() => {
      multiSelect(2, TAB_KEYCODE_NUMBERS[2], { ctrlKey: true, shiftKey: false }, TAB_KEYCODE_NUMBERS)
    })

    // Click on last key [0,3] — only 1 target position available
    const onKeyClick = getLatestOnKeyClick()!
    await act(async () => {
      onKeyClick({ row: 0, col: 3 } as KleKey, false, { ctrlKey: false, shiftKey: false })
    })

    expect(onSetKeysBulk).toHaveBeenCalledTimes(1)
    expect(onSetKeysBulk).toHaveBeenCalledWith([
      { layer: 0, row: 0, col: 3, keycode: 10 },
    ])
  })

  it('stores picker selection after multi-select', () => {
    render(<KeymapEditor {...defaultProps} />)
    const multiSelect = getOnKeycodeMultiSelect()!

    act(() => {
      multiSelect(0, TAB_KEYCODE_NUMBERS[0], { ctrlKey: true, shiftKey: false }, TAB_KEYCODE_NUMBERS)
    })

    expect(getPickerSelectedSet()!.size).toBe(1)
  })

  it('clears picker selection on layer change', () => {
    const { rerender } = render(<KeymapEditor {...defaultProps} />)
    const multiSelect = getOnKeycodeMultiSelect()!

    act(() => {
      multiSelect(0, TAB_KEYCODE_NUMBERS[0], { ctrlKey: true, shiftKey: false }, TAB_KEYCODE_NUMBERS)
    })
    expect(getPickerSelectedSet()!.size).toBe(1)

    // Change layer
    rerender(<KeymapEditor {...defaultProps} currentLayer={1} />)

    expect(getPickerSelectedSet()!.size).toBe(0)
  })

  it('Shift backward range produces tab order (not reversed)', async () => {
    render(<KeymapEditor {...defaultProps} />)

    // Ctrl+click at index 3 to set anchor
    act(() => {
      getOnKeycodeMultiSelect()!(3, TAB_KEYCODE_NUMBERS[3], { ctrlKey: true, shiftKey: false }, TAB_KEYCODE_NUMBERS)
    })

    // Shift+click at index 1 (backward)
    act(() => {
      getOnKeycodeMultiSelect()!(1, TAB_KEYCODE_NUMBERS[1], { ctrlKey: false, shiftKey: true }, TAB_KEYCODE_NUMBERS)
    })

    // Paste starting at [0,0]
    const onKeyClick = getLatestOnKeyClick()!
    await act(async () => {
      onKeyClick({ row: 0, col: 0 } as KleKey, false, { ctrlKey: false, shiftKey: false })
    })

    // Should paste in tab order: KC_11, KC_12, KC_13 (indices 1-3)
    expect(onSetKeysBulk).toHaveBeenCalledTimes(1)
    expect(onSetKeysBulk).toHaveBeenCalledWith([
      { layer: 0, row: 0, col: 0, keycode: 11 }, // KC_11 -> [0,0]
      { layer: 0, row: 0, col: 1, keycode: 12 }, // KC_12 -> [0,1]
      { layer: 0, row: 0, col: 2, keycode: 13 }, // KC_13 -> [0,2]
    ])
  })

  it('Shift+click after tab switch creates range from anchor index', () => {
    render(<KeymapEditor {...defaultProps} />)

    // Ctrl+click to set anchor at index 0
    act(() => {
      getOnKeycodeMultiSelect()!(0, TAB_KEYCODE_NUMBERS[0], { ctrlKey: true, shiftKey: false }, TAB_KEYCODE_NUMBERS)
    })
    expect(getPickerSelectedSet()!.size).toBe(1)

    // Shift+click at index 1 with different keycode numbers (simulating tab switch)
    const otherNumbers = [99, 100]
    act(() => {
      getOnKeycodeMultiSelect()!(1, otherNumbers[1], { ctrlKey: false, shiftKey: true }, otherNumbers)
    })

    // Index-based range: anchor 0 to click 1 = indices 0, 1
    expect(getPickerSelectedSet()!.size).toBe(2)
    expect(getPickerSelectedSet()!.has(0)).toBe(true)
    expect(getPickerSelectedSet()!.has(1)).toBe(true)
  })

  it('Shift+click without prior anchor selects single keycode and sets anchor', () => {
    render(<KeymapEditor {...defaultProps} />)

    // Shift+click without any prior Ctrl+click
    act(() => {
      getOnKeycodeMultiSelect()!(2, TAB_KEYCODE_NUMBERS[2], { ctrlKey: false, shiftKey: true }, TAB_KEYCODE_NUMBERS)
    })

    // Should select just the clicked keycode
    const selected = getPickerSelectedSet()!
    expect(selected.size).toBe(1)
    expect(selected.has(2)).toBe(true)

    // Subsequent Shift+click should work as range from the anchor
    act(() => {
      getOnKeycodeMultiSelect()!(4, TAB_KEYCODE_NUMBERS[4], { ctrlKey: false, shiftKey: true }, TAB_KEYCODE_NUMBERS)
    })

    const rangeSelected = getPickerSelectedSet()!
    expect(rangeSelected.has(2)).toBe(true)
    expect(rangeSelected.has(3)).toBe(true)
    expect(rangeSelected.has(4)).toBe(true)
    expect(rangeSelected.size).toBe(3)
  })

  it('paste target order follows matrix (view) order, not KLE declaration order, when they differ', async () => {
    render(<KeymapEditor {...defaultProps} layout={makeScrambledLayout()} keymap={SCRAMBLED_KEYMAP} />)
    const multiSelect = getOnKeycodeMultiSelect()!

    act(() => {
      multiSelect(0, TAB_KEYCODE_NUMBERS[0], { ctrlKey: true, shiftKey: false }, TAB_KEYCODE_NUMBERS)
    })
    act(() => {
      multiSelect(1, TAB_KEYCODE_NUMBERS[1], { ctrlKey: true, shiftKey: false }, TAB_KEYCODE_NUMBERS)
    })

    // Paste starting at col 0 — declaration order's next key is col 3
    // (index 3 follows col 0 at index 2), but matrix order's next key is
    // col 1. Only the latter is correct.
    const onKeyClick = getLatestOnKeyClick()!
    await act(async () => {
      onKeyClick({ row: 0, col: 0 } as KleKey, false, { ctrlKey: false, shiftKey: false })
    })

    expect(onSetKeysBulk).toHaveBeenCalledTimes(1)
    expect(onSetKeysBulk).toHaveBeenCalledWith([
      { layer: 0, row: 0, col: 0, keycode: 10 }, // KC_10 -> col 0
      { layer: 0, row: 0, col: 1, keycode: 11 }, // KC_11 -> col 1 (matrix-adjacent), not col 3
    ])
  })

  it('paste target order follows a viewMatrix override over physical matrix order', async () => {
    // The layout's declaration order already equals physical matrix order
    // (col 0..3), but an override moves col 3's effective position to tie
    // with col 0 — Auto Move order becomes col 0, col 3, col 1, col 2 (ties
    // break on physical position, keeping col 0 ahead of col 3).
    const viewMatrix = { '0,3': { row: 0, col: 0 } }
    render(<KeymapEditor {...defaultProps} viewMatrix={viewMatrix} />)
    const multiSelect = getOnKeycodeMultiSelect()!

    act(() => {
      multiSelect(0, TAB_KEYCODE_NUMBERS[0], { ctrlKey: true, shiftKey: false }, TAB_KEYCODE_NUMBERS)
    })
    act(() => {
      multiSelect(1, TAB_KEYCODE_NUMBERS[1], { ctrlKey: true, shiftKey: false }, TAB_KEYCODE_NUMBERS)
    })

    const onKeyClick = getLatestOnKeyClick()!
    await act(async () => {
      onKeyClick({ row: 0, col: 0 } as KleKey, false, { ctrlKey: false, shiftKey: false })
    })

    expect(onSetKeysBulk).toHaveBeenCalledTimes(1)
    expect(onSetKeysBulk).toHaveBeenCalledWith([
      { layer: 0, row: 0, col: 0, keycode: 10 },
      { layer: 0, row: 0, col: 3, keycode: 11 }, // col 3 sorts right after col 0 under the override
    ])
  })

  it('primary-pane Shift-range multi-select spans matrix order, not KLE declaration order', () => {
    render(<KeymapEditor {...defaultProps} layout={makeScrambledLayout()} keymap={SCRAMBLED_KEYMAP} />)

    // Ctrl+click col 0 sets the anchor and starts a multi-selection.
    const firstClick = getActiveOnKeyClick()!
    act(() => {
      firstClick({ ...KEY_DEFAULTS, row: 0, col: 0 }, false, { ctrlKey: true, shiftKey: false })
    })

    // Shift+click col 2 — matrix order between col 0 and col 2 is col 1.
    const secondClick = getLatestOnKeyClick()!
    act(() => {
      secondClick({ ...KEY_DEFAULTS, row: 0, col: 2 }, false, { ctrlKey: false, shiftKey: true })
    })

    const widgetWithSelection = capturedWidgetProps.filter((p) => p.onKeyClick != null).pop()
    const ms = widgetWithSelection?.multiSelectedKeys as Set<string> | undefined
    expect(ms?.has('0,0')).toBe(true)
    expect(ms?.has('0,1')).toBe(true)
    expect(ms?.has('0,2')).toBe(true)
    expect(ms?.size).toBe(3)
  })

  it('clears a stale picker selection when the key domain changes', () => {
    const { rerender } = render(<KeymapEditor {...defaultProps} />)
    const multiSelect = getOnKeycodeMultiSelect()!

    act(() => {
      multiSelect(0, TAB_KEYCODE_NUMBERS[0], { ctrlKey: true, shiftKey: false }, TAB_KEYCODE_NUMBERS)
    })
    expect(getPickerSelectedSet()!.size).toBe(1)

    // A view-matrix override changes `pickerSourceKeys`' sort identity even
    // though the underlying key set is unchanged.
    rerender(<KeymapEditor {...defaultProps} viewMatrix={{ '0,3': { row: 0, col: 0 } }} />)

    expect(getPickerSelectedSet()!.size).toBe(0)
  })

  it('does not clear the picker selection on a rerender with unchanged props', () => {
    const { rerender } = render(<KeymapEditor {...defaultProps} />)
    const multiSelect = getOnKeycodeMultiSelect()!

    act(() => {
      multiSelect(0, TAB_KEYCODE_NUMBERS[0], { ctrlKey: true, shiftKey: false }, TAB_KEYCODE_NUMBERS)
    })
    expect(getPickerSelectedSet()!.size).toBe(1)

    // Same props, same object references — `pickerSourceKeys` keeps its
    // identity, so the clear effect must not fire (pins its dep array).
    rerender(<KeymapEditor {...defaultProps} />)

    expect(getPickerSelectedSet()!.size).toBe(1)
  })
})

// Regression coverage for the Keyboard-tab picker's SOURCE index domain
// (`useLayoutPicker`'s `handlePickerKeyClick`/`pickerTabKeycodeNumbers`) —
// distinct from every test above, which exercises `onKeycodeMultiSelect`
// directly and never touches that source-side index computation at all.
// These render the picker's own `<KeyboardPane>` (via `keyboardPickerContent`,
// opted in through `renderKeyboardPickerContent`) and drive its real
// `onKeyClick` handler, transitioning past the device-browse screen onto the
// live connected device exactly like a user would.
describe('KeymapEditor — picker paste (Keyboard tab source index domain)', () => {
  const onSetKey = vi.fn().mockResolvedValue(undefined)
  const onSetKeysBulk = vi.fn().mockResolvedValue(undefined)

  const PICKER_DEVICE: DeviceInfo = {
    vendorId: 1, productId: 2, serialNumber: 'picker-dev', productName: 'Picker Device', type: 'vial',
  }

  beforeEach(() => {
    vi.clearAllMocks()
    capturedWidgetProps = []
    capturedTabbedProps = {}
    renderKeyboardPickerContent = true
  })

  afterEach(() => {
    renderKeyboardPickerContent = false
  })

  type OnKeyClick = (key: KleKey, maskClicked: boolean, event?: { ctrlKey: boolean; shiftKey: boolean }) => void

  /** The most recent same-commit [primary pane, picker pane] `onKeyClick`
   *  pair — both panes always define `onKeyClick` and always render as a
   *  contiguous pair (primary declared before the picker in `KeymapEditor`'s
   *  JSX), so the last two `onKeyClick`-bearing captures from any render are
   *  exactly this pair. Only valid to call once the picker's Keyboard view
   *  has actually mounted (see `transitionToKeyboardView` below). */
  function latestPair(): { primary?: OnKeyClick; secondary?: OnKeyClick } {
    const withClick = capturedWidgetProps.filter((p) => p.onKeyClick != null)
    return {
      primary: withClick[withClick.length - 2]?.onKeyClick as OnKeyClick | undefined,
      secondary: withClick[withClick.length - 1]?.onKeyClick as OnKeyClick | undefined,
    }
  }

  function transitionToKeyboardView(getByText: (text: string) => HTMLElement) {
    act(() => { fireEvent.click(getByText(PICKER_DEVICE.productName)) })
  }

  it('Shift-range picker selection straddling an encoder pair + decal pastes onto the correct target positions', async () => {
    // KLE declaration order: real key, encoder CW, encoder CCW, decal, then
    // three more real keys — the encoder pair + decal sit strictly between
    // the two keys the test selects.
    const layout = {
      keys: [
        makeKey(0, 0),
        makeKey(1, 0, { encoderIdx: 0, encoderDir: 0 }),
        makeKey(1, 0, { encoderIdx: 0, encoderDir: 1 }),
        makeKey(1, 0, { decal: true }),
        makeKey(2, 1),
        makeKey(3, 2),
        makeKey(4, 3),
      ],
    }
    const keymap = new Map([
      ['0,0,0', 1],
      ['0,0,1', 2],
      ['0,0,2', 3],
      ['0,0,3', 4],
    ])

    const { getByText } = render(
      <KeymapEditor
        layout={layout} layers={4} currentLayer={0} keymap={keymap}
        encoderLayout={new Map<string, number>()} encoderCount={1}
        layoutOptions={new Map<number, number>()}
        onSetKey={onSetKey} onSetKeysBulk={onSetKeysBulk} onSetEncoder={vi.fn().mockResolvedValue(undefined)}
        devices={[PICKER_DEVICE]} connectedDevice={PICKER_DEVICE}
      />,
    )

    transitionToKeyboardView(getByText)
    const pickerClick = latestPair().secondary!

    // Ctrl+click col 0 (anchor), Shift+click col 1 — a plain 2-key range
    // that straddles the encoder pair + decal in KLE order.
    act(() => { pickerClick({ ...KEY_DEFAULTS, row: 0, col: 0 }, false, { ctrlKey: true, shiftKey: false }) })
    act(() => { pickerClick({ ...KEY_DEFAULTS, row: 0, col: 1 }, false, { ctrlKey: false, shiftKey: true }) })

    const targetClick = latestPair().primary!

    // Paste starting at col 2 — two consecutive target slots, distinct from
    // the source positions so a shift really would be visible.
    await act(async () => {
      targetClick({ ...KEY_DEFAULTS, row: 0, col: 2 }, false, { ctrlKey: false, shiftKey: false })
    })

    expect(onSetKeysBulk).toHaveBeenCalledTimes(1)
    expect(onSetKeysBulk).toHaveBeenCalledWith([
      { layer: 0, row: 0, col: 2, keycode: 1 }, // col 0's code
      { layer: 0, row: 0, col: 3, keycode: 2 }, // col 1's code
    ])
  })

  it('Shift-range picker selection straddling an unselected layout-option alternate does not consume an extra index', async () => {
    // KLE declaration order: real key, an UNSELECTED layoutOption alternate
    // sharing the selected variant's (row, col), the selected variant
    // itself, then two more real keys.
    const layout = {
      keys: [
        makeKey(0, 0),
        makeKey(1, 1, { layoutIndex: 0, layoutOption: 1 }), // unselected alternate
        makeKey(1, 1, { layoutIndex: 0, layoutOption: 0 }), // selected variant
        makeKey(2, 2),
        makeKey(3, 3),
      ],
    }
    const keymap = new Map([
      ['0,0,0', 1],
      ['0,0,1', 2],
      ['0,0,2', 3],
      ['0,0,3', 4],
    ])

    const { getByText } = render(
      <KeymapEditor
        layout={layout} layers={4} currentLayer={0} keymap={keymap}
        encoderLayout={new Map<string, number>()} encoderCount={0}
        // Empty map: no explicit selection for layoutIndex 0 → option 0 is
        // the default-selected variant (matches `filterSelectableKeys`).
        layoutOptions={new Map<number, number>()}
        onSetKey={onSetKey} onSetKeysBulk={onSetKeysBulk} onSetEncoder={vi.fn().mockResolvedValue(undefined)}
        devices={[PICKER_DEVICE]} connectedDevice={PICKER_DEVICE}
      />,
    )

    transitionToKeyboardView(getByText)
    const pickerClick = latestPair().secondary!

    // Ctrl+click col 0 (anchor), Shift+click col 2 — a 3-key range (col 0,
    // the selected col 1 variant, col 2) that straddles the unselected
    // col 1 alternate in KLE order.
    act(() => { pickerClick({ ...KEY_DEFAULTS, row: 0, col: 0 }, false, { ctrlKey: true, shiftKey: false }) })
    act(() => { pickerClick({ ...KEY_DEFAULTS, row: 0, col: 2 }, false, { ctrlKey: false, shiftKey: true }) })

    const targetClick = latestPair().primary!

    // Paste back onto col 0 — should round-trip exactly the 3 selected
    // keys' own codes onto themselves, touching nothing past col 2.
    await act(async () => {
      targetClick({ ...KEY_DEFAULTS, row: 0, col: 0 }, false, { ctrlKey: false, shiftKey: false })
    })

    expect(onSetKeysBulk).toHaveBeenCalledTimes(1)
    expect(onSetKeysBulk).toHaveBeenCalledWith([
      { layer: 0, row: 0, col: 0, keycode: 1 },
      { layer: 0, row: 0, col: 1, keycode: 2 },
      { layer: 0, row: 0, col: 2, keycode: 3 },
    ])
  })

  it('picker source domain follows a viewMatrix override end-to-end (source click index pairing -> paste result)', async () => {
    // Same override as the primary-pane viewMatrix paste test above: ties
    // col 3's effective position with col 0, so Auto Move order becomes
    // col 0, col 3, col 1, col 2.
    const viewMatrix = { '0,3': { row: 0, col: 0 } }
    const keymap = new Map([
      ['0,0,0', 1], ['0,0,1', 2], ['0,0,2', 3], ['0,0,3', 4],
    ])

    const { getByText } = render(
      <KeymapEditor
        layout={makeLayout()} layers={4} currentLayer={0} keymap={keymap}
        encoderLayout={new Map<string, number>()} encoderCount={0}
        layoutOptions={new Map<number, number>()}
        onSetKey={onSetKey} onSetKeysBulk={onSetKeysBulk} onSetEncoder={vi.fn().mockResolvedValue(undefined)}
        devices={[PICKER_DEVICE]} connectedDevice={PICKER_DEVICE}
        viewMatrix={viewMatrix}
      />,
    )

    transitionToKeyboardView(getByText)
    const pickerClick = latestPair().secondary!

    // Ctrl+click col 0 (view index 0), then col 3 (view index 1 under the
    // override) — the source selection's indices come entirely from the
    // picker's own `pickerSourceKeys`, which now equals `advancableKeys`.
    act(() => { pickerClick({ ...KEY_DEFAULTS, row: 0, col: 0 }, false, { ctrlKey: true, shiftKey: false }) })
    act(() => { pickerClick({ ...KEY_DEFAULTS, row: 0, col: 3 }, false, { ctrlKey: true, shiftKey: false }) })

    const targetClick = latestPair().primary!

    // Paste starting at col 1 — view order after col 1 is col 2.
    await act(async () => {
      targetClick({ ...KEY_DEFAULTS, row: 0, col: 1 }, false, { ctrlKey: false, shiftKey: false })
    })

    expect(onSetKeysBulk).toHaveBeenCalledTimes(1)
    expect(onSetKeysBulk).toHaveBeenCalledWith([
      { layer: 0, row: 0, col: 1, keycode: 1 }, // col 0's code, view index 0
      { layer: 0, row: 0, col: 2, keycode: 4 }, // col 3's code, view index 1 (tied w/ col 0)
    ])
  })
})
