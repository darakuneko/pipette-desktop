// SPDX-License-Identifier: GPL-2.0-or-later
// @vitest-environment jsdom

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'

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

describe('KeymapEditor — layer name label', () => {
  const onSetKey = vi.fn().mockResolvedValue(undefined)
  const onSetEncoder = vi.fn().mockResolvedValue(undefined)

  const defaultProps = {
    layout: makeLayout(),
    layers: 2,
    currentLayer: 0,
    onLayerChange: vi.fn(),
    keymap: new Map([['0,0,0', 4], ['1,0,0', 5]]),
    encoderLayout: new Map<string, number>(),
    encoderCount: 0,
    layoutOptions: new Map<number, number>(),
    onSetKey,
    onSetKeysBulk: vi.fn().mockResolvedValue(undefined),
    onSetEncoder,
    layerNames: ['Base', ''],
  }

  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('displays custom name when set', () => {
    render(<KeymapEditor {...defaultProps} />)
    expect(screen.getByTestId('layer-label')).toHaveTextContent('Base')
  })

  it('shows default "Layer N" when name is empty', () => {
    render(<KeymapEditor {...defaultProps} layerNames={['', '']} />)
    expect(screen.getByTestId('layer-label')).toHaveTextContent('Layer 0')
  })

  it('shows read-only text without edit controls', () => {
    render(<KeymapEditor {...defaultProps} />)
    expect(screen.getByTestId('layer-label')).toHaveTextContent('Base')
    expect(screen.queryByTestId('layer-name-button')).not.toBeInTheDocument()
    expect(screen.queryByTestId('layer-name-input')).not.toBeInTheDocument()
  })

  it('displays layer name for the current layer', () => {
    render(<KeymapEditor {...defaultProps} currentLayer={1} layerNames={['Base', 'Nav']} />)
    expect(screen.getByTestId('layer-label')).toHaveTextContent('Nav')
  })

  it('falls back to default label when no layerNames provided', () => {
    render(<KeymapEditor {...defaultProps} layerNames={undefined} />)
    expect(screen.getByTestId('layer-label')).toHaveTextContent('Layer 0')
  })
})
