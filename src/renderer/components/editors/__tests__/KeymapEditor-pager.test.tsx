// SPDX-License-Identifier: GPL-2.0-or-later
// @vitest-environment jsdom

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) => {
      const map: Record<string, string> = {
        'common.loading': 'Loading...',
        'editor.keymap.layerN': `Layer ${opts?.n ?? ''}`,
        'editor.keymap.layerLabel': 'Layer',
        'editor.keymap.previousLayers': 'Previous layers',
        'editor.keymap.nextLayers': 'Next layers',
        'editor.keymap.zoomIn': 'Zoom In',
        'editor.keymap.zoomOut': 'Zoom Out',
        'editor.keymap.dualMode': 'Dual View',
        'editorSettings.title': 'Settings',
      }
      return map[key] ?? key
    },
  }),
}))

vi.mock('../../keyboard/KeyboardWidget', () => ({
  KeyboardWidget: () => <div data-testid="keyboard-widget">KeyboardWidget</div>,
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
}))

vi.mock('../../keycodes/ModifierCheckboxStrip', () => ({
  ModifierCheckboxStrip: () => null,
}))

vi.mock('../../../../preload/macro', () => ({
  deserializeAllMacros: () => [],
}))

import { KeymapEditor } from '../KeymapEditor'

const makeLayout = () => ({
  keys: [
    { x: 0, y: 0, w: 1, h: 1, height: 1, row: 0, col: 0, encoderIdx: -1, decal: false, labels: [] },
  ],
})

describe('KeymapEditor — vertical layer pager', () => {
  const onLayerChange = vi.fn()

  const defaultProps = {
    layout: makeLayout(),
    layers: 4,
    currentLayer: 0,
    onLayerChange,
    keymap: new Map([
      ['0,0,0', 4],
      ['1,0,0', 5],
      ['2,0,0', 6],
      ['3,0,0', 7],
    ]),
    encoderLayout: new Map<string, number>(),
    encoderCount: 0,
    layoutOptions: new Map<number, number>(),
    onSetKey: vi.fn().mockResolvedValue(undefined),
    onSetKeysBulk: vi.fn().mockResolvedValue(undefined),
    onSetEncoder: vi.fn().mockResolvedValue(undefined),
  }

  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('renders the layer pager with layer buttons', () => {
    render(<KeymapEditor {...defaultProps} />)
    expect(screen.getByRole('group', { name: 'Layer' })).toBeInTheDocument()
    // Should render 4 layer buttons (0-3)
    for (let i = 0; i < 4; i++) {
      expect(screen.getByRole('button', { name: `Layer ${i}` })).toBeInTheDocument()
    }
  })

  it('calls onLayerChange when clicking a layer button', () => {
    render(<KeymapEditor {...defaultProps} currentLayer={0} />)
    fireEvent.click(screen.getByRole('button', { name: 'Layer 2' }))
    expect(onLayerChange).toHaveBeenCalledWith(2)
  })

  it('highlights the current layer button', () => {
    render(<KeymapEditor {...defaultProps} currentLayer={1} />)
    const btn = screen.getByRole('button', { name: 'Layer 1' })
    expect(btn.className).toContain('font-semibold')
  })

  it('does not render pager when onLayerChange is not provided', () => {
    const { onLayerChange: _, ...propsWithoutHandler } = defaultProps
    render(<KeymapEditor {...propsWithoutHandler} />)
    expect(screen.queryByRole('group', { name: 'Layer' })).not.toBeInTheDocument()
  })

  it('does not render pager when layers is 1', () => {
    render(<KeymapEditor {...defaultProps} layers={1} />)
    expect(screen.queryByRole('group', { name: 'Layer' })).not.toBeInTheDocument()
  })

  it('marks current layer with aria-current', () => {
    render(<KeymapEditor {...defaultProps} currentLayer={2} />)
    const btn = screen.getByRole('button', { name: 'Layer 2' })
    expect(btn).toHaveAttribute('aria-current', 'true')
    const otherBtn = screen.getByRole('button', { name: 'Layer 0' })
    expect(otherBtn).not.toHaveAttribute('aria-current')
  })

  it('does not call onLayerChange when clicking the current layer', () => {
    render(<KeymapEditor {...defaultProps} currentLayer={1} />)
    fireEvent.click(screen.getByRole('button', { name: 'Layer 1' }))
    expect(onLayerChange).not.toHaveBeenCalled()
  })
})
