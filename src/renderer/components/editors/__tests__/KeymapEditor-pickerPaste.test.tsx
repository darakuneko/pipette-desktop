// SPDX-License-Identifier: GPL-2.0-or-later
// @vitest-environment jsdom

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, act } from '@testing-library/react'
import type { Keycode } from '../../../../shared/keycodes/keycodes'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) => {
      const map: Record<string, string> = {
        'common.loading': 'Loading...',
        'editor.keymap.layerN': `Layer ${opts?.n ?? ''}`,
        'editor.keymap.zoomIn': 'Zoom In',
        'editor.keymap.zoomOut': 'Zoom Out',
        'editor.keymap.dualMode': 'Dual View',
        'editor.keymap.copyAll': 'Copy All',
        'editor.keymap.copyAllConfirm': 'Confirm Copy All?',
        'editor.keymap.clickToPaste': 'Click a key to paste',
        'editorSettings.title': 'Settings',
      }
      return map[key] ?? key
    },
  }),
}))

let capturedWidgetProps: Array<Record<string, unknown>> = []
let capturedTabbedProps: Record<string, unknown> = {}

vi.mock('../../keyboard/KeyboardWidget', () => ({
  KeyboardWidget: (props: Record<string, unknown>) => {
    capturedWidgetProps.push(props)
    return <div data-testid="keyboard-widget">KeyboardWidget</div>
  },
}))

vi.mock('../../keycodes/TabbedKeycodes', () => ({
  TabbedKeycodes: (props: Record<string, unknown>) => {
    capturedTabbedProps = props
    return <div data-testid="tabbed-keycodes">TabbedKeycodes</div>
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

function makeKey(x: number, col: number): KleKey {
  return { ...KEY_DEFAULTS, x, col }
}

const makeLayout = () => ({
  keys: [makeKey(0, 0), makeKey(1, 1), makeKey(2, 2), makeKey(3, 3)],
})

function makeKeycode(qmkId: string, label?: string): Keycode {
  return { qmkId, label: label ?? qmkId, hidden: false }
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
    onSetEncoder: vi.fn().mockResolvedValue(undefined),
    onDualModeChange: vi.fn(),
    onActivePaneChange: vi.fn(),
    activePane: 'primary' as const,
  }

  beforeEach(() => {
    vi.clearAllMocks()
    capturedWidgetProps = []
    capturedTabbedProps = {}
  })

  function getOnKeycodeMultiSelect() {
    return capturedTabbedProps.onKeycodeMultiSelect as
      ((kc: Keycode, event: { ctrlKey: boolean; shiftKey: boolean }, tabKeycodes: Keycode[]) => void) | undefined
  }

  function getOnKeycodeSelect() {
    return capturedTabbedProps.onKeycodeSelect as ((kc: Keycode) => void) | undefined
  }

  function getPickerSelectedSet() {
    return capturedTabbedProps.pickerSelectedKeycodes as Set<string> | undefined
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
      multiSelect(TAB_KEYCODES[0], { ctrlKey: true, shiftKey: false }, TAB_KEYCODES)
    })

    const selected = getPickerSelectedSet()!
    expect(selected.has('KC_10')).toBe(true)
    expect(selected.size).toBe(1)
  })

  it('toggles picker selection off on second Ctrl+click', () => {
    render(<KeymapEditor {...defaultProps} />)
    const multiSelect = getOnKeycodeMultiSelect()!

    act(() => {
      multiSelect(TAB_KEYCODES[0], { ctrlKey: true, shiftKey: false }, TAB_KEYCODES)
    })

    act(() => {
      multiSelect(TAB_KEYCODES[0], { ctrlKey: true, shiftKey: false }, TAB_KEYCODES)
    })

    const selected = getPickerSelectedSet()!
    expect(selected.has('KC_10')).toBe(false)
    expect(selected.size).toBe(0)
  })

  it('selects range on Shift+click after Ctrl anchor', () => {
    render(<KeymapEditor {...defaultProps} />)

    // Ctrl+click to set anchor at index 1
    act(() => {
      getOnKeycodeMultiSelect()!(TAB_KEYCODES[1], { ctrlKey: true, shiftKey: false }, TAB_KEYCODES)
    })

    // Shift+click at index 3 (re-get callback to capture updated pickerAnchor)
    act(() => {
      getOnKeycodeMultiSelect()!(TAB_KEYCODES[3], { ctrlKey: false, shiftKey: true }, TAB_KEYCODES)
    })

    const selected = getPickerSelectedSet()!
    expect(selected.has('KC_11')).toBe(true)
    expect(selected.has('KC_12')).toBe(true)
    expect(selected.has('KC_13')).toBe(true)
    expect(selected.size).toBe(3)
  })

  it('pastes picker selection to keymap on normal click', async () => {
    render(<KeymapEditor {...defaultProps} />)
    const multiSelect = getOnKeycodeMultiSelect()!

    // Select KC_10 and KC_11
    act(() => {
      multiSelect(TAB_KEYCODES[0], { ctrlKey: true, shiftKey: false }, TAB_KEYCODES)
    })
    act(() => {
      multiSelect(TAB_KEYCODES[1], { ctrlKey: true, shiftKey: false }, TAB_KEYCODES)
    })

    // Normal click on key [0,1] to paste
    const onKeyClick = getLatestOnKeyClick()!
    await act(async () => {
      onKeyClick({ row: 0, col: 1 } as KleKey, false, { ctrlKey: false, shiftKey: false })
    })

    expect(onSetKey).toHaveBeenCalledTimes(2)
    expect(onSetKey).toHaveBeenNthCalledWith(1, 0, 0, 1, 10) // KC_10 -> [0,1]
    expect(onSetKey).toHaveBeenNthCalledWith(2, 0, 0, 2, 11) // KC_11 -> [0,2]
  })

  it('pastes in click order for Ctrl selection', async () => {
    render(<KeymapEditor {...defaultProps} />)
    const multiSelect = getOnKeycodeMultiSelect()!

    // Ctrl+click in order: KC_12 then KC_10
    act(() => {
      multiSelect(TAB_KEYCODES[2], { ctrlKey: true, shiftKey: false }, TAB_KEYCODES)
    })
    act(() => {
      multiSelect(TAB_KEYCODES[0], { ctrlKey: true, shiftKey: false }, TAB_KEYCODES)
    })

    const onKeyClick = getLatestOnKeyClick()!
    await act(async () => {
      onKeyClick({ row: 0, col: 0 } as KleKey, false, { ctrlKey: false, shiftKey: false })
    })

    // Ctrl order: KC_12, KC_10
    expect(onSetKey).toHaveBeenCalledTimes(2)
    expect(onSetKey).toHaveBeenNthCalledWith(1, 0, 0, 0, 12) // KC_12 -> [0,0]
    expect(onSetKey).toHaveBeenNthCalledWith(2, 0, 0, 1, 10) // KC_10 -> [0,1]
  })

  it('clears picker selection after paste', async () => {
    render(<KeymapEditor {...defaultProps} />)
    const multiSelect = getOnKeycodeMultiSelect()!

    act(() => {
      multiSelect(TAB_KEYCODES[0], { ctrlKey: true, shiftKey: false }, TAB_KEYCODES)
    })

    const onKeyClick = getLatestOnKeyClick()!
    await act(async () => {
      onKeyClick({ row: 0, col: 0 } as KleKey, false, { ctrlKey: false, shiftKey: false })
    })

    const selected = getPickerSelectedSet()!
    expect(selected.size).toBe(0)
  })

  it('does not allow picker multi-select when a key is selected', () => {
    render(<KeymapEditor {...defaultProps} />)

    // Select a key first
    const onKeyClick = getActiveOnKeyClick()!
    act(() => {
      onKeyClick({ row: 0, col: 0 } as KleKey, false)
    })

    // Try picker multi-select
    const multiSelect = getOnKeycodeMultiSelect()!
    act(() => {
      multiSelect(TAB_KEYCODES[0], { ctrlKey: true, shiftKey: false }, TAB_KEYCODES)
    })

    const selected = getPickerSelectedSet()!
    expect(selected.size).toBe(0)
  })

  it('clears picker selection on normal keycode click', () => {
    render(<KeymapEditor {...defaultProps} />)
    const multiSelect = getOnKeycodeMultiSelect()!

    act(() => {
      multiSelect(TAB_KEYCODES[0], { ctrlKey: true, shiftKey: false }, TAB_KEYCODES)
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
    render(<KeymapEditor {...defaultProps} dualMode activePane="primary" primaryLayer={0} secondaryLayer={1} />)
    const multiSelect = getOnKeycodeMultiSelect()!

    act(() => {
      multiSelect(TAB_KEYCODES[0], { ctrlKey: true, shiftKey: false }, TAB_KEYCODES)
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
    render(<KeymapEditor {...defaultProps} dualMode activePane="primary" primaryLayer={0} secondaryLayer={1} />)

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
      multiSelect(TAB_KEYCODES[0], { ctrlKey: true, shiftKey: false }, TAB_KEYCODES)
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
      multiSelect(TAB_KEYCODES[0], { ctrlKey: true, shiftKey: false }, TAB_KEYCODES)
    })
    act(() => {
      multiSelect(TAB_KEYCODES[1], { ctrlKey: true, shiftKey: false }, TAB_KEYCODES)
    })
    act(() => {
      multiSelect(TAB_KEYCODES[2], { ctrlKey: true, shiftKey: false }, TAB_KEYCODES)
    })

    // Click on last key [0,3] — only 1 target position available
    const onKeyClick = getLatestOnKeyClick()!
    await act(async () => {
      onKeyClick({ row: 0, col: 3 } as KleKey, false, { ctrlKey: false, shiftKey: false })
    })

    expect(onSetKey).toHaveBeenCalledTimes(1)
    expect(onSetKey).toHaveBeenCalledWith(0, 0, 3, 10)
  })

  it('shows paste hint in single pane mode when picker selection exists', () => {
    render(<KeymapEditor {...defaultProps} />)
    const multiSelect = getOnKeycodeMultiSelect()!

    act(() => {
      multiSelect(TAB_KEYCODES[0], { ctrlKey: true, shiftKey: false }, TAB_KEYCODES)
    })

    expect(screen.getByTestId('paste-hint')).toHaveTextContent('Click a key to paste')
  })

  it('clears picker selection on layer change', () => {
    const { rerender } = render(<KeymapEditor {...defaultProps} />)
    const multiSelect = getOnKeycodeMultiSelect()!

    act(() => {
      multiSelect(TAB_KEYCODES[0], { ctrlKey: true, shiftKey: false }, TAB_KEYCODES)
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
      getOnKeycodeMultiSelect()!(TAB_KEYCODES[3], { ctrlKey: true, shiftKey: false }, TAB_KEYCODES)
    })

    // Shift+click at index 1 (backward)
    act(() => {
      getOnKeycodeMultiSelect()!(TAB_KEYCODES[1], { ctrlKey: false, shiftKey: true }, TAB_KEYCODES)
    })

    // Paste starting at [0,0]
    const onKeyClick = getLatestOnKeyClick()!
    await act(async () => {
      onKeyClick({ row: 0, col: 0 } as KleKey, false, { ctrlKey: false, shiftKey: false })
    })

    // Should paste in tab order: KC_11, KC_12, KC_13 (indices 1-3)
    expect(onSetKey).toHaveBeenCalledTimes(3)
    expect(onSetKey).toHaveBeenNthCalledWith(1, 0, 0, 0, 11) // KC_11 -> [0,0]
    expect(onSetKey).toHaveBeenNthCalledWith(2, 0, 0, 1, 12) // KC_12 -> [0,1]
    expect(onSetKey).toHaveBeenNthCalledWith(3, 0, 0, 2, 13) // KC_13 -> [0,2]
  })

  it('Shift+click with stale anchor (not in tab) is a no-op', () => {
    render(<KeymapEditor {...defaultProps} />)

    // Ctrl+click to set anchor with TAB_KEYCODES
    act(() => {
      getOnKeycodeMultiSelect()!(TAB_KEYCODES[0], { ctrlKey: true, shiftKey: false }, TAB_KEYCODES)
    })
    expect(getPickerSelectedSet()!.size).toBe(1)

    // Shift+click with a different tabKeycodes list (simulating tab switch)
    const otherTab = [makeKeycode('KC_99', 'X'), makeKeycode('KC_100', 'Y')]
    act(() => {
      getOnKeycodeMultiSelect()!(otherTab[1], { ctrlKey: false, shiftKey: true }, otherTab)
    })

    // Anchor KC_10 is not in otherTab, so no range should be added; original Ctrl selection remains
    expect(getPickerSelectedSet()!.size).toBe(1)
    expect(getPickerSelectedSet()!.has('KC_10')).toBe(true)
  })

  it('Shift+click without prior anchor selects single keycode and sets anchor', () => {
    render(<KeymapEditor {...defaultProps} />)

    // Shift+click without any prior Ctrl+click
    act(() => {
      getOnKeycodeMultiSelect()!(TAB_KEYCODES[2], { ctrlKey: false, shiftKey: true }, TAB_KEYCODES)
    })

    // Should select just the clicked keycode
    const selected = getPickerSelectedSet()!
    expect(selected.size).toBe(1)
    expect(selected.has('KC_12')).toBe(true)

    // Subsequent Shift+click should work as range from the anchor
    act(() => {
      getOnKeycodeMultiSelect()!(TAB_KEYCODES[4], { ctrlKey: false, shiftKey: true }, TAB_KEYCODES)
    })

    const rangeSelected = getPickerSelectedSet()!
    expect(rangeSelected.has('KC_12')).toBe(true)
    expect(rangeSelected.has('KC_13')).toBe(true)
    expect(rangeSelected.has('KC_14')).toBe(true)
    expect(rangeSelected.size).toBe(3)
  })
})
