// SPDX-License-Identifier: GPL-2.0-or-later
// @vitest-environment jsdom

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, act } from '@testing-library/react'

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

function makeKey(x: number, col: number): KleKey {
  return { ...KEY_DEFAULTS, x, col }
}

const makeLayout = () => ({
  keys: [makeKey(0, 0), makeKey(1, 1), makeKey(2, 2), makeKey(3, 3)],
})

describe('KeymapEditor — multi-select', () => {
  const onSetKey = vi.fn().mockResolvedValue(undefined)
  const onSetKeysBulk = vi.fn().mockResolvedValue(undefined)
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
  }

  beforeEach(() => {
    vi.clearAllMocks()
    capturedWidgetProps = []
  })

  function getActiveOnKeyClick() {
    const widget = capturedWidgetProps.find((p) => p.onKeyClick != null)
    return widget?.onKeyClick as ((key: KleKey, maskClicked: boolean, event?: { ctrlKey: boolean; shiftKey: boolean }) => void) | undefined
  }

  it('adds key to multiSelectedKeys on Ctrl+click', () => {
    render(<KeymapEditor {...defaultProps} />)
    const onKeyClick = getActiveOnKeyClick()!
    expect(onKeyClick).toBeDefined()

    act(() => {
      onKeyClick({ row: 0, col: 1 } as KleKey, false, { ctrlKey: true, shiftKey: false })
    })

    // After re-render, check the widget props
    const lastWidget = capturedWidgetProps[capturedWidgetProps.length - 1] // primary widget
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

    const lastWidget = capturedWidgetProps[capturedWidgetProps.length - 1]
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

    const lastWidget = capturedWidgetProps[capturedWidgetProps.length - 1]
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

    const lastWidget = capturedWidgetProps[capturedWidgetProps.length - 1]
    const ms = lastWidget?.multiSelectedKeys as Set<string> | undefined
    expect(ms?.size ?? 0).toBe(0)
  })

  it('clears multiSelectedKeys when layer changes', () => {
    const { rerender } = render(<KeymapEditor {...defaultProps} />)
    const onKeyClick = getActiveOnKeyClick()!

    act(() => {
      onKeyClick({ row: 0, col: 1 } as KleKey, false, { ctrlKey: true, shiftKey: false })
    })

    capturedWidgetProps = []
    rerender(<KeymapEditor {...defaultProps} currentLayer={1} />)

    // After layer change, multiSelectedKeys should be cleared
    const lastWidget = capturedWidgetProps[capturedWidgetProps.length - 1]
    const ms = lastWidget?.multiSelectedKeys as Set<string> | undefined
    expect(ms?.size ?? 0).toBe(0)
  })

})
