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

describe('KeymapEditor — click-to-paste', () => {
  const onSetKey = vi.fn().mockResolvedValue(undefined)
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
    onSetEncoder: vi.fn().mockResolvedValue(undefined),
    onDualModeChange: vi.fn(),
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
    const widget = capturedWidgetProps.find((p) => p.onKeyClick != null)
    return widget?.onKeyClick as ((key: KleKey, maskClicked: boolean, event?: { ctrlKey: boolean; shiftKey: boolean }) => void) | undefined
  }

  function getLatestOnKeyClick() {
    return capturedWidgetProps.filter((p) => p.onKeyClick != null).pop()?.onKeyClick as ((key: KleKey, maskClicked: boolean, event?: { ctrlKey: boolean; shiftKey: boolean }) => void) | undefined
  }

  it('shows selection on source pane after pane switch (not active pane)', () => {
    const { rerender } = render(<KeymapEditor {...defaultProps} />)
    const onKeyClick = getActiveOnKeyClick()!

    // Ctrl+click to select key on primary pane
    act(() => {
      onKeyClick({ row: 0, col: 1 } as KleKey, false, { ctrlKey: true, shiftKey: false })
    })

    capturedWidgetProps = []
    // Switch to secondary pane
    rerender(<KeymapEditor {...defaultProps} activePane="secondary" currentLayer={1} />)

    // Primary pane (inactive) should still show the selection
    const primaryWidget = capturedWidgetProps.find((p) => {
      const ms = p.multiSelectedKeys as Set<string> | undefined
      return ms != null && ms.size > 0
    })
    expect(primaryWidget).toBeDefined()
    const ms = primaryWidget?.multiSelectedKeys as Set<string>
    expect(ms.has('0,1')).toBe(true)

    // Secondary pane (active) should NOT show selection
    const secondaryWidget = capturedWidgetProps.filter((p) => p.onKeyClick != null).pop()
    const secondaryMs = secondaryWidget?.multiSelectedKeys as Set<string> | undefined
    expect(secondaryMs).toBeUndefined()
  })

  it('fires click-to-paste on normal click when selection exists from another pane', async () => {
    const { rerender } = render(<KeymapEditor {...defaultProps} />)
    const onKeyClick = getActiveOnKeyClick()!

    // Select key [0,1] on primary pane with Ctrl+click
    act(() => {
      onKeyClick({ row: 0, col: 1 } as KleKey, false, { ctrlKey: true, shiftKey: false })
    })

    capturedWidgetProps = []
    // Switch to secondary pane
    rerender(<KeymapEditor {...defaultProps} activePane="secondary" currentLayer={1} />)

    // Normal click on key [0,2] in secondary pane triggers paste
    const secondaryClick = getLatestOnKeyClick()!
    expect(secondaryClick).toBeDefined()

    await act(async () => {
      secondaryClick({ row: 0, col: 2 } as KleKey, false, { ctrlKey: false, shiftKey: false })
      // Flush microtasks for the floating async handleClickToPaste
      await new Promise((resolve) => setTimeout(resolve, 0))
    })

    // Source: primary pane layer 0, key [0,1] = code 11
    // Target: secondary pane layer 1, key [0,2]
    expect(onSetKey).toHaveBeenCalledWith(1, 0, 2, 11)
    expect(onSetKey).toHaveBeenCalledTimes(1)
  })

  it('pastes in selection (click) order for Ctrl selection', async () => {
    const { rerender } = render(<KeymapEditor {...defaultProps} />)
    let onKeyClick = getActiveOnKeyClick()!

    // Ctrl+click in order: [0,2] then [0,0]
    act(() => {
      onKeyClick({ row: 0, col: 2 } as KleKey, false, { ctrlKey: true, shiftKey: false })
    })
    onKeyClick = getLatestOnKeyClick()!
    act(() => {
      onKeyClick({ row: 0, col: 0 } as KleKey, false, { ctrlKey: true, shiftKey: false })
    })

    capturedWidgetProps = []
    rerender(<KeymapEditor {...defaultProps} activePane="secondary" currentLayer={1} />)

    const secondaryClick = getLatestOnKeyClick()!
    await act(async () => {
      secondaryClick({ row: 0, col: 1 } as KleKey, false, { ctrlKey: false, shiftKey: false })
    })

    // Ctrl selection order: [0,2]=12, [0,0]=10
    // Target positions from [0,1]: [0,1], [0,2]
    expect(onSetKey).toHaveBeenCalledTimes(2)
    expect(onSetKey).toHaveBeenNthCalledWith(1, 1, 0, 1, 12) // source [0,2] -> target [0,1]
    expect(onSetKey).toHaveBeenNthCalledWith(2, 1, 0, 2, 10) // source [0,0] -> target [0,2]
  })

  it('pastes in layout order for Shift selection', async () => {
    const { rerender } = render(<KeymapEditor {...defaultProps} />)
    let onKeyClick = getActiveOnKeyClick()!

    // Ctrl+click on [0,0] to set anchor
    act(() => {
      onKeyClick({ row: 0, col: 0 } as KleKey, false, { ctrlKey: true, shiftKey: false })
    })

    // Shift+click on [0,2] to range select
    onKeyClick = getLatestOnKeyClick()!
    act(() => {
      onKeyClick({ row: 0, col: 2 } as KleKey, false, { ctrlKey: false, shiftKey: true })
    })

    capturedWidgetProps = []
    rerender(<KeymapEditor {...defaultProps} activePane="secondary" currentLayer={1} />)

    const secondaryClick = getLatestOnKeyClick()!
    await act(async () => {
      secondaryClick({ row: 0, col: 1 } as KleKey, false, { ctrlKey: false, shiftKey: false })
    })

    // Shift selection -> layout order: [0,0]=10, [0,1]=11, [0,2]=12
    // Target from [0,1]: [0,1], [0,2], [0,3]
    expect(onSetKey).toHaveBeenCalledTimes(3)
    expect(onSetKey).toHaveBeenNthCalledWith(1, 1, 0, 1, 10) // source [0,0] -> target [0,1]
    expect(onSetKey).toHaveBeenNthCalledWith(2, 1, 0, 2, 11) // source [0,1] -> target [0,2]
    expect(onSetKey).toHaveBeenNthCalledWith(3, 1, 0, 3, 12) // source [0,2] -> target [0,3]
  })

  it('clears selection after paste', async () => {
    const { rerender } = render(<KeymapEditor {...defaultProps} />)
    const onKeyClick = getActiveOnKeyClick()!

    act(() => {
      onKeyClick({ row: 0, col: 1 } as KleKey, false, { ctrlKey: true, shiftKey: false })
    })

    capturedWidgetProps = []
    rerender(<KeymapEditor {...defaultProps} activePane="secondary" currentLayer={1} />)

    const secondaryClick = getLatestOnKeyClick()!
    await act(async () => {
      secondaryClick({ row: 0, col: 0 } as KleKey, false, { ctrlKey: false, shiftKey: false })
    })

    // After paste, multiSelectedKeys should be cleared
    const lastWidgets = capturedWidgetProps.slice(-2)
    for (const w of lastWidgets) {
      const ms = w.multiSelectedKeys as Set<string> | undefined
      expect(ms?.size ?? 0).toBe(0)
    }
  })

  it('does not paste when both panes show the same layer (falls back to normal click)', async () => {
    const sameLayerProps = {
      ...defaultProps,
      primaryLayer: 0,
      secondaryLayer: 0,
    }

    const { rerender } = render(<KeymapEditor {...sameLayerProps} />)
    const onKeyClick = getActiveOnKeyClick()!

    act(() => {
      onKeyClick({ row: 0, col: 1 } as KleKey, false, { ctrlKey: true, shiftKey: false })
    })

    capturedWidgetProps = []
    rerender(<KeymapEditor {...sameLayerProps} activePane="secondary" currentLayer={0} />)

    const secondaryClick = getLatestOnKeyClick()!
    await act(async () => {
      secondaryClick({ row: 0, col: 0 } as KleKey, false, { ctrlKey: false, shiftKey: false })
    })

    // No paste should happen
    expect(onSetKey).not.toHaveBeenCalled()

    // Normal click fallback: multi-selection should be cleared
    const finalWidgets = capturedWidgetProps.slice(-2)
    for (const w of finalWidgets) {
      const ms = w.multiSelectedKeys as Set<string> | undefined
      expect(ms?.size ?? 0).toBe(0)
    }
  })

  it('clears selection on background click without paste', () => {
    const { rerender } = render(<KeymapEditor {...defaultProps} />)
    const onKeyClick = getActiveOnKeyClick()!

    act(() => {
      onKeyClick({ row: 0, col: 1 } as KleKey, false, { ctrlKey: true, shiftKey: false })
    })

    capturedWidgetProps = []
    rerender(<KeymapEditor {...defaultProps} activePane="secondary" currentLayer={1} />)

    // Click pane background (not a key) without modifiers
    const pane = screen.getByTestId('secondary-pane')
    fireEvent.click(pane)

    expect(onSetKey).not.toHaveBeenCalled()

    // Selection should be cleared
    const lastWidgets = capturedWidgetProps.slice(-2)
    for (const w of lastWidgets) {
      const ms = w.multiSelectedKeys as Set<string> | undefined
      expect(ms?.size ?? 0).toBe(0)
    }
  })

  it('normal click on same pane clears selection without paste', () => {
    render(<KeymapEditor {...defaultProps} />)
    let onKeyClick = getActiveOnKeyClick()!

    // Ctrl+click to select on primary
    act(() => {
      onKeyClick({ row: 0, col: 1 } as KleKey, false, { ctrlKey: true, shiftKey: false })
    })

    // Normal click on same pane (primary) should clear, NOT paste
    onKeyClick = getLatestOnKeyClick()!
    act(() => {
      onKeyClick({ row: 0, col: 0 } as KleKey, false, { ctrlKey: false, shiftKey: false })
    })

    expect(onSetKey).not.toHaveBeenCalled()

    const lastWidget = capturedWidgetProps[capturedWidgetProps.length - 2]
    const ms = lastWidget?.multiSelectedKeys as Set<string> | undefined
    expect(ms?.size ?? 0).toBe(0)
  })

  it('truncates paste when clicking near layout end (no overflow)', async () => {
    const { rerender } = render(<KeymapEditor {...defaultProps} />)
    let onKeyClick = getActiveOnKeyClick()!

    // Select 3 keys on primary
    act(() => {
      onKeyClick({ row: 0, col: 0 } as KleKey, false, { ctrlKey: true, shiftKey: false })
    })
    onKeyClick = getLatestOnKeyClick()!
    act(() => {
      onKeyClick({ row: 0, col: 1 } as KleKey, false, { ctrlKey: true, shiftKey: false })
    })
    onKeyClick = getLatestOnKeyClick()!
    act(() => {
      onKeyClick({ row: 0, col: 2 } as KleKey, false, { ctrlKey: true, shiftKey: false })
    })

    capturedWidgetProps = []
    rerender(<KeymapEditor {...defaultProps} activePane="secondary" currentLayer={1} />)

    // Click on [0,3] (last key) — only 1 target position available
    const secondaryClick = getLatestOnKeyClick()!
    await act(async () => {
      secondaryClick({ row: 0, col: 3 } as KleKey, false, { ctrlKey: false, shiftKey: false })
    })

    // Only 1 key should be pasted (truncated to available positions)
    expect(onSetKey).toHaveBeenCalledTimes(1)
    expect(onSetKey).toHaveBeenCalledWith(1, 0, 3, 10)
  })

  it('hides Copy All and shows paste hint when paste-ready on target pane', () => {
    const { rerender } = render(<KeymapEditor {...defaultProps} />)
    const onKeyClick = getActiveOnKeyClick()!

    // Ctrl+click to select a key on primary pane
    act(() => {
      onKeyClick({ row: 0, col: 1 } as KleKey, false, { ctrlKey: true, shiftKey: false })
    })

    capturedWidgetProps = []
    // Switch to secondary pane (target)
    rerender(<KeymapEditor {...defaultProps} activePane="secondary" currentLayer={1} />)

    // Copy All should be hidden
    expect(screen.queryByTestId('copy-all-button')).not.toBeInTheDocument()
    // Paste hint should be shown
    expect(screen.getByTestId('paste-hint')).toHaveTextContent('Click a key to paste')
  })

  it('shows Copy All (not paste hint) when no selection exists', () => {
    render(<KeymapEditor {...defaultProps} />)

    // No selection — Copy All should be visible, no paste hint
    expect(screen.getByTestId('copy-all-button')).toBeInTheDocument()
    expect(screen.queryByTestId('paste-hint')).not.toBeInTheDocument()
  })

  it('restores Copy All after paste clears selection', async () => {
    const { rerender } = render(<KeymapEditor {...defaultProps} />)
    const onKeyClick = getActiveOnKeyClick()!

    act(() => {
      onKeyClick({ row: 0, col: 1 } as KleKey, false, { ctrlKey: true, shiftKey: false })
    })

    capturedWidgetProps = []
    rerender(<KeymapEditor {...defaultProps} activePane="secondary" currentLayer={1} />)

    // Paste hint visible before paste
    expect(screen.getByTestId('paste-hint')).toBeInTheDocument()

    // Perform paste
    const secondaryClick = getLatestOnKeyClick()!
    await act(async () => {
      secondaryClick({ row: 0, col: 0 } as KleKey, false, { ctrlKey: false, shiftKey: false })
    })

    // After paste, selection is cleared — Copy All should be back
    expect(screen.getByTestId('copy-all-button')).toBeInTheDocument()
    expect(screen.queryByTestId('paste-hint')).not.toBeInTheDocument()
  })
})
