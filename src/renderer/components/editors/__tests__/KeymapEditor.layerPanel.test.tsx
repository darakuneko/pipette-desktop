// SPDX-License-Identifier: GPL-2.0-or-later
// @vitest-environment jsdom

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, act } from '@testing-library/react'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) => {
      const map: Record<string, string> = {
        'common.loading': 'Loading...',
        'editor.keymap.layerN': `Layer ${opts?.n ?? ''}`,
        'editor.keymap.layerLabel': 'Layer',
      }
      return map[key] ?? key
    },
  }),
}))

vi.mock('../../keyboard/KeyboardWidget', () => ({
  KeyboardWidget: () => <div data-testid="keyboard-widget">KeyboardWidget</div>,
}))

vi.mock('../../keycodes/TabbedKeycodes', () => ({
  TabbedKeycodes: () => <div data-testid="tabbed-keycodes" />,
}))

vi.mock('../../../../shared/keycodes/keycodes', () => ({
  serialize: (code: number) => `KC_${code}`,
  deserialize: () => 0,
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
  ],
})

describe('KeymapEditor — LayerListPanel', () => {
  const onSetKey = vi.fn().mockResolvedValue(undefined)
  const onSetEncoder = vi.fn().mockResolvedValue(undefined)
  const onLayerChange = vi.fn()
  const onSetLayerName = vi.fn()

  const defaultProps = {
    layout: makeLayout(),
    layers: 4,
    currentLayer: 0,
    onLayerChange,
    keymap: new Map([['0,0,0', 4], ['1,0,0', 5], ['2,0,0', 6], ['3,0,0', 7]]),
    encoderLayout: new Map<string, number>(),
    encoderCount: 0,
    layoutOptions: new Map<number, number>(),
    onSetKey,
    onSetKeysBulk: vi.fn().mockResolvedValue(undefined),
    onSetEncoder,
    layerNames: ['Base', 'Nav', '', 'Num'],
    onSetLayerName,
  }

  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('renders layer list panel with all layers', () => {
    render(<KeymapEditor {...defaultProps} />)

    expect(screen.getByTestId('layer-list-panel')).toBeInTheDocument()
    expect(screen.getByTestId('layer-panel-layer-0')).toBeInTheDocument()
    expect(screen.getByTestId('layer-panel-layer-1')).toBeInTheDocument()
    expect(screen.getByTestId('layer-panel-layer-2')).toBeInTheDocument()
    expect(screen.getByTestId('layer-panel-layer-3')).toBeInTheDocument()
  })

  it('displays custom layer names when provided', () => {
    render(<KeymapEditor {...defaultProps} />)

    expect(screen.getByTestId('layer-panel-layer-name-0')).toHaveTextContent('Base')
    expect(screen.getByTestId('layer-panel-layer-name-1')).toHaveTextContent('Nav')
    expect(screen.getByTestId('layer-panel-layer-name-2')).toHaveTextContent('Layer 2')
    expect(screen.getByTestId('layer-panel-layer-name-3')).toHaveTextContent('Num')
  })

  it('highlights the current layer', () => {
    render(<KeymapEditor {...defaultProps} currentLayer={1} />)

    const layerNum = screen.getByTestId('layer-panel-layer-num-1')
    expect(layerNum.className).toContain('border-accent')
  })

  it('calls onLayerChange when a layer number is clicked', () => {
    render(<KeymapEditor {...defaultProps} />)

    fireEvent.click(screen.getByTestId('layer-panel-layer-num-2'))
    expect(onLayerChange).toHaveBeenCalledWith(2)
  })

  it('does not render layer panel when isDummy', () => {
    render(<KeymapEditor {...defaultProps} isDummy />)

    expect(screen.queryByTestId('layer-list-panel')).not.toBeInTheDocument()
  })

  it('does not render layer panel when layers is 1', () => {
    render(<KeymapEditor {...defaultProps} layers={1} />)

    expect(screen.queryByTestId('layer-list-panel')).not.toBeInTheDocument()
  })

  describe('accordion collapse/expand', () => {
    it('shows collapse button when expanded', () => {
      render(<KeymapEditor {...defaultProps} />)

      expect(screen.getByTestId('layer-panel-collapse-btn')).toBeInTheDocument()
      expect(screen.queryByTestId('layer-panel-expand-btn')).not.toBeInTheDocument()
    })

    it('collapses to number-only view when collapse button clicked', () => {
      render(<KeymapEditor {...defaultProps} />)

      fireEvent.click(screen.getByTestId('layer-panel-collapse-btn'))

      expect(screen.getByTestId('layer-list-panel-collapsed')).toBeInTheDocument()
      expect(screen.queryByTestId('layer-list-panel')).not.toBeInTheDocument()
      expect(screen.getByTestId('layer-panel-expand-btn')).toBeInTheDocument()
      // Layer numbers still visible
      expect(screen.getByTestId('layer-panel-layer-num-0')).toBeInTheDocument()
      // Layer names not visible
      expect(screen.queryByTestId('layer-panel-layer-name-0')).not.toBeInTheDocument()
    })

    it('expands back when expand button clicked', () => {
      render(<KeymapEditor {...defaultProps} />)

      fireEvent.click(screen.getByTestId('layer-panel-collapse-btn'))
      fireEvent.click(screen.getByTestId('layer-panel-expand-btn'))

      expect(screen.getByTestId('layer-list-panel')).toBeInTheDocument()
      expect(screen.queryByTestId('layer-list-panel-collapsed')).not.toBeInTheDocument()
    })

    it('still allows layer switching when collapsed', () => {
      render(<KeymapEditor {...defaultProps} />)

      fireEvent.click(screen.getByTestId('layer-panel-collapse-btn'))
      fireEvent.click(screen.getByTestId('layer-panel-layer-num-2'))

      expect(onLayerChange).toHaveBeenCalledWith(2)
    })
  })

  describe('layer rename inline editing', () => {
    afterEach(() => {
      vi.restoreAllMocks()
    })

    it('enters edit mode when clicking layer name box', () => {
      render(<KeymapEditor {...defaultProps} />)

      fireEvent.click(screen.getByTestId('layer-panel-layer-name-box-0'))

      expect(screen.getByTestId('layer-panel-layer-name-input-0')).toBeInTheDocument()
    })

    it('saves layer rename on Enter', () => {
      render(<KeymapEditor {...defaultProps} />)

      fireEvent.click(screen.getByTestId('layer-panel-layer-name-box-0'))

      const input = screen.getByTestId('layer-panel-layer-name-input-0')
      fireEvent.change(input, { target: { value: 'NewName' } })
      fireEvent.keyDown(input, { key: 'Enter' })

      expect(onSetLayerName).toHaveBeenCalledWith(0, 'NewName')
    })

    it('cancels layer rename on blur', () => {
      render(<KeymapEditor {...defaultProps} />)

      fireEvent.click(screen.getByTestId('layer-panel-layer-name-box-0'))

      const input = screen.getByTestId('layer-panel-layer-name-input-0')
      fireEvent.change(input, { target: { value: 'NewName' } })
      fireEvent.blur(input)

      expect(onSetLayerName).not.toHaveBeenCalled()
      expect(screen.queryByTestId('layer-panel-layer-name-input-0')).not.toBeInTheDocument()
    })

    it('cancels layer rename on Escape', () => {
      render(<KeymapEditor {...defaultProps} />)

      fireEvent.click(screen.getByTestId('layer-panel-layer-name-box-0'))

      const input = screen.getByTestId('layer-panel-layer-name-input-0')
      fireEvent.change(input, { target: { value: 'NewName' } })
      fireEvent.keyDown(input, { key: 'Escape' })

      expect(onSetLayerName).not.toHaveBeenCalled()
      expect(screen.queryByTestId('layer-panel-layer-name-input-0')).not.toBeInTheDocument()
    })

    it('does not save when Enter is pressed without changes', () => {
      render(<KeymapEditor {...defaultProps} />)

      fireEvent.click(screen.getByTestId('layer-panel-layer-name-box-0'))

      const input = screen.getByTestId('layer-panel-layer-name-input-0')
      fireEvent.keyDown(input, { key: 'Enter' })

      expect(onSetLayerName).not.toHaveBeenCalled()
    })

    it('shows confirm flash after Enter rename', () => {
      vi.useFakeTimers()
      render(<KeymapEditor {...defaultProps} />)

      fireEvent.click(screen.getByTestId('layer-panel-layer-name-box-0'))

      const input = screen.getByTestId('layer-panel-layer-name-input-0')
      fireEvent.change(input, { target: { value: 'NewName' } })
      fireEvent.keyDown(input, { key: 'Enter' })

      act(() => { vi.advanceTimersByTime(0) })

      const nameBox = screen.getByTestId('layer-panel-layer-name-box-0')
      expect(nameBox.className).toContain('confirm-flash')

      act(() => { vi.advanceTimersByTime(1200) })
      expect(nameBox.className).not.toContain('confirm-flash')

      vi.useRealTimers()
    })

    it('does not enter edit mode without onSetLayerName', () => {
      render(<KeymapEditor {...defaultProps} onSetLayerName={undefined} />)

      fireEvent.click(screen.getByTestId('layer-panel-layer-name-box-0'))

      expect(screen.queryByTestId('layer-panel-layer-name-input-0')).not.toBeInTheDocument()
    })
  })
})
