// SPDX-License-Identifier: GPL-2.0-or-later
// @vitest-environment jsdom

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, act } from '@testing-library/react'

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

vi.mock('../../keyboard/KeyboardWidget', () => ({
  KeyboardWidget: (props: Record<string, unknown>) => {
    capturedWidgetProps.push(props)
    return <div data-testid="keyboard-widget">KeyboardWidget</div>
  },
}))

vi.mock('../../keycodes/TabbedKeycodes', () => ({
  TabbedKeycodes: () => <div data-testid="tabbed-keycodes">TabbedKeycodes</div>,
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

describe('KeymapEditor — multi-select & copy', () => {
  const onSetKey = vi.fn().mockResolvedValue(undefined)
  const onSetKeysBulk = vi.fn().mockResolvedValue(undefined)
  const onDualModeChange = vi.fn()
  const onActivePaneChange = vi.fn()

  const defaultProps = {
    layout: makeLayout(),
    layers: 4,
    currentLayer: 0,
    keymap: new Map([
      ['0,0,0', 10],
      ['0,0,1', 11],
      ['0,0,2', 12],
      ['0,0,3', 13],
      ['1,0,0', 20],
      ['1,0,1', 21],
      ['1,0,2', 22],
      ['1,0,3', 23],
    ]),
    encoderLayout: new Map<string, number>(),
    encoderCount: 0,
    layoutOptions: new Map<number, number>(),
    onSetKey,
    onSetKeysBulk,
    onSetEncoder: vi.fn().mockResolvedValue(undefined),
    onDualModeChange,
    onActivePaneChange,
    dualMode: true,
    activePane: 'primary' as const,
    primaryLayer: 0,
    secondaryLayer: 1,
  }

  beforeEach(() => {
    vi.clearAllMocks()
    capturedWidgetProps = []
  })

  function getActiveOnKeyClick() {
    // Get the onKeyClick from the active pane's KeyboardWidget
    // In primary-active dual mode, the first widget gets the click handler
    const widget = capturedWidgetProps.find((p) => p.onKeyClick != null)
    return widget?.onKeyClick as ((key: KleKey, maskClicked: boolean, event?: { ctrlKey: boolean; shiftKey: boolean }) => void) | undefined
  }

  it('adds key to multiSelectedKeys on Ctrl+click in dual mode', () => {
    render(<KeymapEditor {...defaultProps} />)
    const onKeyClick = getActiveOnKeyClick()!
    expect(onKeyClick).toBeDefined()

    act(() => {
      onKeyClick({ row: 0, col: 1 } as KleKey, false, { ctrlKey: true, shiftKey: false })
    })

    // After re-render, check the widget props
    const lastWidget = capturedWidgetProps[capturedWidgetProps.length - 2] // primary widget
    const ms = lastWidget?.multiSelectedKeys as Set<string> | undefined
    expect(ms?.has('0,1')).toBe(true)
  })

  it('removes key from multiSelectedKeys on second Ctrl+click (toggle)', () => {
    render(<KeymapEditor {...defaultProps} />)
    const onKeyClick = getActiveOnKeyClick()!

    // First Ctrl+click: add
    act(() => {
      onKeyClick({ row: 0, col: 1 } as KleKey, false, { ctrlKey: true, shiftKey: false })
    })

    // Get the updated onKeyClick (may have changed due to rerender)
    const updatedWidget = capturedWidgetProps.find(
      (p, i) => i >= 2 && p.onKeyClick != null,
    )
    const updatedClick = (updatedWidget?.onKeyClick ?? onKeyClick) as typeof onKeyClick

    // Second Ctrl+click: remove
    act(() => {
      updatedClick({ row: 0, col: 1 } as KleKey, false, { ctrlKey: true, shiftKey: false })
    })

    const lastWidget = capturedWidgetProps[capturedWidgetProps.length - 2]
    const ms = lastWidget?.multiSelectedKeys as Set<string> | undefined
    expect(ms?.has('0,1')).toBeFalsy()
  })

  it('selects range on Shift+click after Ctrl+click anchor', () => {
    render(<KeymapEditor {...defaultProps} />)
    const onKeyClick = getActiveOnKeyClick()!

    // Set anchor with Ctrl+click
    act(() => {
      onKeyClick({ row: 0, col: 0 } as KleKey, false, { ctrlKey: true, shiftKey: false })
    })

    // Shift+click to select range
    const updatedWidget = capturedWidgetProps.filter((p) => p.onKeyClick != null).pop()
    const updatedClick = (updatedWidget?.onKeyClick ?? onKeyClick) as typeof onKeyClick

    act(() => {
      updatedClick({ row: 0, col: 2 } as KleKey, false, { ctrlKey: false, shiftKey: true })
    })

    const lastWidget = capturedWidgetProps[capturedWidgetProps.length - 2]
    const ms = lastWidget?.multiSelectedKeys as Set<string> | undefined
    expect(ms?.has('0,0')).toBe(true)
    expect(ms?.has('0,1')).toBe(true)
    expect(ms?.has('0,2')).toBe(true)
  })

  it('clears multiSelectedKeys on normal click', () => {
    render(<KeymapEditor {...defaultProps} />)
    const onKeyClick = getActiveOnKeyClick()!

    // Ctrl+click to select
    act(() => {
      onKeyClick({ row: 0, col: 1 } as KleKey, false, { ctrlKey: true, shiftKey: false })
    })

    // Normal click to deselect
    const updatedWidget = capturedWidgetProps.filter((p) => p.onKeyClick != null).pop()
    const updatedClick = (updatedWidget?.onKeyClick ?? onKeyClick) as typeof onKeyClick

    act(() => {
      updatedClick({ row: 0, col: 0 } as KleKey, false, { ctrlKey: false, shiftKey: false })
    })

    const lastWidget = capturedWidgetProps[capturedWidgetProps.length - 2]
    const ms = lastWidget?.multiSelectedKeys as Set<string> | undefined
    expect(ms?.size ?? 0).toBe(0)
  })

  it('preserves multiSelectedKeys when activePane changes (for click-to-paste)', () => {
    const { rerender } = render(<KeymapEditor {...defaultProps} />)
    const onKeyClick = getActiveOnKeyClick()!

    act(() => {
      onKeyClick({ row: 0, col: 1 } as KleKey, false, { ctrlKey: true, shiftKey: false })
    })

    capturedWidgetProps = []
    rerender(<KeymapEditor {...defaultProps} activePane="secondary" />)

    // Selection should be preserved on the source pane (primary)
    const primaryWidget = capturedWidgetProps.find((p) => {
      const ms = p.multiSelectedKeys as Set<string> | undefined
      return ms != null && ms.size > 0
    })
    const ms = primaryWidget?.multiSelectedKeys as Set<string> | undefined
    expect(ms?.has('0,1')).toBe(true)
  })

  it('clears multiSelectedKeys when layer changes', () => {
    const { rerender } = render(<KeymapEditor {...defaultProps} />)
    const onKeyClick = getActiveOnKeyClick()!

    act(() => {
      onKeyClick({ row: 0, col: 1 } as KleKey, false, { ctrlKey: true, shiftKey: false })
    })

    capturedWidgetProps = []
    rerender(<KeymapEditor {...defaultProps} currentLayer={1} />)

    // After layer change, the final render should have no multiSelectedKeys on any pane
    // (selectionSourcePane is cleared to null, so both panes receive undefined)
    const finalWidgets = capturedWidgetProps.slice(-2) // last 2 widgets (primary + secondary)
    for (const w of finalWidgets) {
      const ms = w.multiSelectedKeys as Set<string> | undefined
      expect(ms?.size ?? 0).toBe(0)
    }
  })

  it('clears multiSelectedKeys when dualMode turns off', () => {
    const { rerender } = render(<KeymapEditor {...defaultProps} />)
    const onKeyClick = getActiveOnKeyClick()!

    act(() => {
      onKeyClick({ row: 0, col: 1 } as KleKey, false, { ctrlKey: true, shiftKey: false })
    })

    capturedWidgetProps = []
    rerender(<KeymapEditor {...defaultProps} dualMode={false} />)

    const lastWidget = capturedWidgetProps[capturedWidgetProps.length - 1]
    const ms = lastWidget?.multiSelectedKeys as Set<string> | undefined
    expect(ms?.size ?? 0).toBe(0)
  })

  it('shows Copy All button in dual mode active pane', () => {
    render(<KeymapEditor {...defaultProps} />)
    expect(screen.getByTestId('copy-all-button')).toBeInTheDocument()
    expect(screen.getByTestId('copy-all-button')).toHaveTextContent('Copy All')
  })

  it('does not show Copy All button when not in dual mode', () => {
    render(<KeymapEditor {...defaultProps} dualMode={false} />)
    expect(screen.queryByTestId('copy-all-button')).not.toBeInTheDocument()
  })

  it('does not show Copy Selected button (removed in favor of click-to-paste)', () => {
    render(<KeymapEditor {...defaultProps} />)
    const onKeyClick = getActiveOnKeyClick()!

    act(() => {
      onKeyClick({ row: 0, col: 1 } as KleKey, false, { ctrlKey: true, shiftKey: false })
    })

    expect(screen.queryByTestId('copy-selected-button')).not.toBeInTheDocument()
  })

  it('Copy All requires two clicks (confirmation)', async () => {
    render(<KeymapEditor {...defaultProps} />)
    const btn = screen.getByTestId('copy-all-button')

    // First click: shows confirmation, does NOT call onSetKeysBulk
    await act(async () => {
      fireEvent.click(btn)
    })
    expect(onSetKeysBulk).not.toHaveBeenCalled()
    expect(btn).toHaveTextContent('Confirm Copy All?')

    // Second click: executes copy
    await act(async () => {
      fireEvent.click(btn)
    })

    expect(onSetKeysBulk).toHaveBeenCalledTimes(1)
    const entries = onSetKeysBulk.mock.calls[0][0]
    expect(entries).toEqual(expect.arrayContaining([
      { layer: 1, row: 0, col: 0, keycode: 10 },
      { layer: 1, row: 0, col: 1, keycode: 11 },
      { layer: 1, row: 0, col: 2, keycode: 12 },
      { layer: 1, row: 0, col: 3, keycode: 13 },
    ]))
    expect(entries.length).toBe(4)
  })

  it('Copy All confirmation resets after timeout', async () => {
    vi.useFakeTimers()
    render(<KeymapEditor {...defaultProps} />)
    const btn = screen.getByTestId('copy-all-button')

    // First click: pending
    await act(async () => {
      fireEvent.click(btn)
    })
    expect(btn).toHaveTextContent('Confirm Copy All?')

    // Advance past 3s timeout
    await act(async () => {
      vi.advanceTimersByTime(3000)
    })
    expect(btn).toHaveTextContent('Copy All')

    vi.useRealTimers()
  })

  it('copies from active layer to inactive layer (source/target correct)', async () => {
    // activePane=secondary means currentLayer follows secondary, inactive is primary
    render(
      <KeymapEditor
        {...defaultProps}
        activePane="secondary"
        primaryLayer={0}
        secondaryLayer={1}
        currentLayer={1}
      />,
    )

    const btn = screen.getByTestId('copy-all-button')
    // Two clicks: first to confirm, second to execute
    await act(async () => { fireEvent.click(btn) })
    await act(async () => { fireEvent.click(btn) })

    // Source is currentLayer=1, target is inactivePaneLayer=primaryLayer=0
    expect(onSetKeysBulk).toHaveBeenCalledTimes(1)
    const entries = onSetKeysBulk.mock.calls[0][0]
    expect(entries).toEqual(expect.arrayContaining([
      { layer: 0, row: 0, col: 0, keycode: 20 },
      { layer: 0, row: 0, col: 1, keycode: 21 },
      { layer: 0, row: 0, col: 2, keycode: 22 },
      { layer: 0, row: 0, col: 3, keycode: 23 },
    ]))
  })

  it('hides copy buttons when both panes show the same layer', () => {
    render(
      <KeymapEditor
        {...defaultProps}
        primaryLayer={0}
        secondaryLayer={0}
        currentLayer={0}
      />,
    )
    expect(screen.queryByTestId('copy-all-button')).not.toBeInTheDocument()
  })

  it('does not clear multiSelectedKeys when Ctrl is held on pane background click', () => {
    render(<KeymapEditor {...defaultProps} />)
    const onKeyClick = getActiveOnKeyClick()!

    // Ctrl+click to select a key
    act(() => {
      onKeyClick({ row: 0, col: 1 } as KleKey, false, { ctrlKey: true, shiftKey: false })
    })

    // Click pane background with Ctrl held — should NOT clear
    const pane = screen.getByTestId('primary-pane')
    fireEvent.click(pane, { ctrlKey: true })

    const lastWidget = capturedWidgetProps.filter((p) => p.multiSelectedKeys != null).pop()
    const ms = lastWidget?.multiSelectedKeys as Set<string> | undefined
    expect(ms?.has('0,1')).toBe(true)
  })

  it('clears multiSelectedKeys on pane background click without modifiers', () => {
    render(<KeymapEditor {...defaultProps} />)
    const onKeyClick = getActiveOnKeyClick()!

    // Ctrl+click to select a key
    act(() => {
      onKeyClick({ row: 0, col: 1 } as KleKey, false, { ctrlKey: true, shiftKey: false })
    })

    // Click pane background without modifiers — should clear
    const pane = screen.getByTestId('primary-pane')
    fireEvent.click(pane)

    // After clear, selectionSourcePane is null so both panes get undefined multiSelectedKeys
    const finalWidgets = capturedWidgetProps.slice(-2)
    for (const w of finalWidgets) {
      const ms = w.multiSelectedKeys as Set<string> | undefined
      expect(ms?.size ?? 0).toBe(0)
    }
  })
})
