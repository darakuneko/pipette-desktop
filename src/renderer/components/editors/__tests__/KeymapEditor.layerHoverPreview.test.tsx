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
      return map[key] ?? key
    },
  }),
}))

vi.mock('../../../hooks/useAppConfig', () => ({
  useAppConfig: () => ({ config: { maxKeymapHistory: 100 }, loading: false, set: () => {} }),
}))

// A shallow stand-in for the real KeyboardWidget that hands the test its
// key hover callback and shows the label it would draw for key (0,1).
let hoverKey: ((key: KleKey, keycode: string, rect: DOMRect) => void) | undefined
vi.mock('../../keyboard/KeyboardWidget', () => ({
  KeyboardWidget: (props: {
    keycodes: Map<string, string>
    onKeyHover?: (key: KleKey, keycode: string, rect: DOMRect) => void
  }) => {
    hoverKey = props.onKeyHover
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
  serialize: (code: number) => (code === 0x5221 ? 'MO(1)' : `KC_${code}`),
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
import { SHARED_BUBBLE_OPEN_DELAY_MS } from '../../../hooks/use-shared-hover-bubble'
import type { KleKey } from '../../../../shared/kle/types'

const KEY_DEFAULTS: KleKey = {
  x: 0, y: 0, width: 1, height: 1, row: 0, col: 0,
  encoderIdx: -1, encoderDir: -1, layoutIndex: -1, layoutOption: -1,
  decal: false, labels: [], x2: 0, y2: 0, width2: 1, height2: 1,
  rotation: 0, rotationX: 0, rotationY: 0, color: '',
  textColor: [], textSize: [], nub: false, stepped: false, ghost: false,
}

const makeKey = (x: number, col: number): KleKey => ({ ...KEY_DEFAULTS, x, col })
const LAYOUT = { keys: [makeKey(0, 0), makeKey(1, 1)] }
// Layer 0: MO(1), KC_5. Layer 1: KC_7, KC_8.
const KEYMAP = new Map([['0,0,0', 0x5221], ['0,0,1', 5], ['1,0,0', 7], ['1,0,1', 8]])
const ENCODERS = new Map<string, number>()

function defaultProps(overrides: Record<string, unknown> = {}) {
  return {
    layout: LAYOUT,
    layers: 2,
    currentLayer: 0,
    onLayerChange: vi.fn(),
    keymap: KEYMAP,
    encoderLayout: ENCODERS,
    encoderCount: 0,
    layoutOptions: new Map<number, number>(),
    onSetKey: vi.fn().mockResolvedValue(undefined),
    onSetKeysBulk: vi.fn().mockResolvedValue(undefined),
    onSetEncoder: vi.fn().mockResolvedValue(undefined),
    rows: 1,
    cols: 2,
    ...overrides,
  }
}

function hoverLayerKeyAndDwell(): void {
  act(() => hoverKey?.(makeKey(0, 0), 'MO(1)', new DOMRect()))
  act(() => { vi.advanceTimersByTime(SHARED_BUBBLE_OPEN_DELAY_MS) })
}

describe('KeymapEditor — Auto Layer Preview setting', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.useFakeTimers()
  })
  afterEach(() => { vi.useRealTimers() })

  it('previews by default when the setting is omitted', () => {
    render(<KeymapEditor {...defaultProps()} />)
    hoverLayerKeyAndDwell()
    expect(screen.getByTestId('layer-label')).toHaveTextContent('Preview - Layer 1')
    expect(screen.getByTestId('keyboard-widget')).toHaveTextContent('KC_8')
  })

  it('does not preview when the setting is off', () => {
    render(<KeymapEditor {...defaultProps({ layerHoverPreview: false })} />)
    hoverLayerKeyAndDwell()
    expect(screen.getByTestId('layer-label')).toHaveTextContent('Layer 0')
    expect(screen.getByTestId('keyboard-widget')).toHaveTextContent('KC_5')
  })

  it('turning it off hides a visible preview, which does not come back when turned on again', () => {
    const { rerender } = render(<KeymapEditor {...defaultProps({ layerHoverPreview: true })} />)
    hoverLayerKeyAndDwell()
    expect(screen.getByTestId('layer-label')).toHaveTextContent('Preview - Layer 1')

    rerender(<KeymapEditor {...defaultProps({ layerHoverPreview: false })} />)
    expect(screen.getByTestId('layer-label')).toHaveTextContent('Layer 0')
    rerender(<KeymapEditor {...defaultProps({ layerHoverPreview: true })} />)
    act(() => { vi.advanceTimersByTime(SHARED_BUBBLE_OPEN_DELAY_MS) })
    expect(screen.getByTestId('layer-label')).toHaveTextContent('Layer 0')
  })

  it('turning it off cancels a pending preview', () => {
    const { rerender } = render(<KeymapEditor {...defaultProps({ layerHoverPreview: true })} />)
    act(() => hoverKey?.(makeKey(0, 0), 'MO(1)', new DOMRect()))
    rerender(<KeymapEditor {...defaultProps({ layerHoverPreview: false })} />)
    rerender(<KeymapEditor {...defaultProps({ layerHoverPreview: true })} />)
    act(() => { vi.advanceTimersByTime(SHARED_BUBBLE_OPEN_DELAY_MS) })
    expect(screen.getByTestId('layer-label')).toHaveTextContent('Layer 0')
  })

  it('shows the setting in the Settings / Import tab and reports changes', () => {
    const onLayerHoverPreviewChange = vi.fn()
    render(<KeymapEditor {...defaultProps({ layerHoverPreview: false, onLayerHoverPreviewChange })} />)
    const toggle = screen.getByTestId('overlay-layer-hover-preview-toggle')
    expect(toggle).toHaveAttribute('aria-checked', 'false')
    fireEvent.click(toggle)
    expect(onLayerHoverPreviewChange).toHaveBeenCalledWith(true)
  })
})
