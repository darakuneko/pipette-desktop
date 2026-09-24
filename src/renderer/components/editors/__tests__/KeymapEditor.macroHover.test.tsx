// SPDX-License-Identifier: GPL-2.0-or-later
// @vitest-environment jsdom

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, act } from '@testing-library/react'
import type { ReactNode } from 'react'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) => {
      const map: Record<string, string> = {
        'common.loading': 'Loading...',
        'editor.keymap.selectKey': 'Click a key to edit',
        'editor.viewMatrix.label': 'View Matrix',
        'editor.viewMatrix.edit': 'Edit',
        'editor.viewMatrix.done': 'Done',
        'keyLabels.qwertyDefaultName': 'QWERTY (Default)',
        'keyLabels.qwertyDefaultShort': 'Default',
      }
      if (key === 'editor.keymap.layer' && opts) return `Layer ${opts.number ?? ''}`
      if (key === 'editor.keymap.layerN' && opts) return `Layer ${opts.n ?? ''}`
      if (key === 'editor.keymap.layerPreview' && opts) return `Preview - ${String(opts.label ?? '')}`
      if (key === 'editorSettings.layerHoverPreview') return 'Auto Layer Preview'
      if (key === 'editorSettings.macroHoverPreview') return 'Macro Hover Preview'
      return map[key] ?? key
    },
  }),
}))

vi.mock('../../../hooks/useAppConfig', () => ({
  useAppConfig: () => ({ config: { maxKeymapHistory: 100 }, loading: false, set: () => {} }),
}))

// A shallow stand-in for the real KeyboardWidget that hands the test its
// key and encoder hover callbacks.
let hoverKey: ((key: KleKey, keycode: string, rect: DOMRect) => void) | undefined
let hoverEncoder: ((encoderIdx: number, dir: number, rect: DOMRect) => void) | undefined
vi.mock('../../keyboard/KeyboardWidget', () => ({
  KeyboardWidget: (props: {
    keycodes: Map<string, string>
    onKeyHover?: (key: KleKey, keycode: string, rect: DOMRect) => void
    onEncoderHover?: (encoderIdx: number, dir: number, rect: DOMRect) => void
  }) => {
    hoverKey = props.onKeyHover
    hoverEncoder = props.onEncoderHover
    return <div data-testid="keyboard-widget">{props.keycodes.get('0,1')}</div>
  },
}))

// Renders the real overlay (panelOverlay) so the Settings / Import
// toggle is reachable.
vi.mock('../../keycodes/TabbedKeycodes', () => ({
  TabbedKeycodes: (props: { panelOverlay?: ReactNode }) => (
    <div data-testid="tabbed-keycodes">{props.panelOverlay}</div>
  ),
}))

vi.mock('../../keycodes/KeyPopover', () => ({
  KeyPopover: () => <div data-testid="key-popover" />,
}))

vi.mock('../../../../shared/keycodes/keycodes', () => ({
  serialize: (code: number) => (code === 0x5221 ? 'MO(1)' : code === 0x7700 ? 'M0' : `KC_${code}`),
  deserialize: (val: string) => (val === 'KC_A' ? 4 : 0),
  isMask: () => false,
  isLMKeycode: () => false,
  resolve: () => 0,
  isTapDanceKeycode: () => false,
  getTapDanceIndex: () => -1,
  isMacroKeycode: (code: number) => code === 0x7700,
  getMacroIndex: (code: number) => (code === 0x7700 ? 0 : -1),
  codeToLabel: (code: number) => `KC_${code}`,
  keycodeLabel: (qmkId: string) => qmkId,
  keycodeTooltip: (qmkId: string) => qmkId,
  isResetKeycode: () => false,
  isModifiableKeycode: () => false,
  extractModMask: () => 0,
  extractBasicKey: (code: number) => code & 0xff,
  buildModMaskKeycode: (mask: number, key: number) => (mask << 8) | key,
  findKeycode: (qmkId: string) => ({ qmkId, label: qmkId }),
  findInnerKeycode: () => undefined,
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
import { MacroHoverPreviewContext } from '../../keycodes/macro-hover-context'
import { SHARED_BUBBLE_OPEN_DELAY_MS } from '../../../hooks/use-shared-hover-bubble'
import type { KleKey } from '../../../../shared/kle/types'
import type { MacroAction } from '../../../../preload/macro'

const KEY_DEFAULTS: KleKey = {
  x: 0, y: 0, width: 1, height: 1, row: 0, col: 0,
  encoderIdx: -1, encoderDir: -1, layoutIndex: -1, layoutOption: -1,
  decal: false, labels: [], x2: 0, y2: 0, width2: 1, height2: 1,
  rotation: 0, rotationX: 0, rotationY: 0, color: '',
  textColor: [], textSize: [], nub: false, stepped: false, ghost: false,
}

const makeKey = (x: number, col: number): KleKey => ({ ...KEY_DEFAULTS, x, col })
const LAYOUT = { keys: [makeKey(0, 0), makeKey(1, 1)] }
// Layer 0: MO(1), M0. Encoder 0: CW = KC_5, CCW = M0.
const KEYMAP = new Map([['0,0,0', 0x5221], ['0,0,1', 0x7700], ['1,0,0', 7], ['1,0,1', 8]])
const ENCODERS = new Map([['0,0,0', 5], ['0,0,1', 0x7700]])
const MACROS: MacroAction[][] = [[{ type: 'tap', keycodes: [4] }, { type: 'delay', delay: 20 }]]

function defaultProps(overrides: Record<string, unknown> = {}) {
  return {
    layout: LAYOUT,
    layers: 2,
    currentLayer: 0,
    onLayerChange: vi.fn(),
    keymap: KEYMAP,
    encoderLayout: ENCODERS,
    encoderCount: 1,
    layoutOptions: new Map<number, number>(),
    onSetKey: vi.fn().mockResolvedValue(undefined),
    onSetKeysBulk: vi.fn().mockResolvedValue(undefined),
    onSetEncoder: vi.fn().mockResolvedValue(undefined),
    rows: 1,
    cols: 2,
    parsedMacros: MACROS,
    macroCount: 1,
    unlocked: false,
    ...overrides,
  }
}

function editor(overrides: Record<string, unknown> = {}, enabled: boolean | null = true): JSX.Element {
  const node = <KeymapEditor {...defaultProps(overrides)} />
  return enabled === null ? node : <MacroHoverPreviewContext.Provider value={enabled}>{node}</MacroHoverPreviewContext.Provider>
}

function dwell(): void {
  act(() => { vi.advanceTimersByTime(SHARED_BUBBLE_OPEN_DELAY_MS) })
}

function bubble(): HTMLElement | null {
  return screen.queryByTestId('macro-hover-bubble')
}

describe('KeymapEditor — macro hover bubble', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.useFakeTimers()
  })
  afterEach(() => { vi.useRealTimers() })

  it('shows the macro of a hovered key while the keyboard is locked', () => {
    render(editor())
    act(() => hoverKey?.(makeKey(1, 1), 'M0', new DOMRect()))
    dwell()
    expect(bubble()).toHaveTextContent('M0')
    expect(screen.getAllByTestId('macro-hover-line').map((el) => el.textContent)).toEqual(['TKC_4', 'W20ms'])
  })

  it('shows the macro of a hovered encoder direction', () => {
    render(editor())
    act(() => hoverEncoder?.(0, 0, new DOMRect()))
    dwell()
    expect(bubble()).toBeNull()
    act(() => hoverEncoder?.(0, 1, new DOMRect()))
    dwell()
    expect(bubble()).toHaveTextContent('M0')
  })

  it('still shows the bubble with Auto Layer Preview off', () => {
    render(editor({ layerHoverPreview: false }))
    act(() => hoverKey?.(makeKey(1, 1), 'M0', new DOMRect()))
    dwell()
    expect(bubble()).toHaveTextContent('M0')
  })

  it.each([
    ['the setting is off', false],
    ['there is no provider', null],
  ] as const)('shows nothing when %s', (_label, enabled) => {
    render(editor({}, enabled))
    act(() => hoverKey?.(makeKey(1, 1), 'M0', new DOMRect()))
    act(() => hoverEncoder?.(0, 1, new DOMRect()))
    dwell()
    expect(bubble()).toBeNull()
  })

  it('shows the setting in the Settings / Import tab and reports changes', () => {
    const onMacroHoverPreviewChange = vi.fn()
    render(editor({ macroHoverPreview: false, onMacroHoverPreviewChange }))
    const toggle = screen.getByTestId('overlay-macro-hover-preview-toggle')
    expect(toggle).toHaveAttribute('aria-checked', 'false')
    fireEvent.click(toggle)
    expect(onMacroHoverPreviewChange).toHaveBeenCalledWith(true)
  })
})
