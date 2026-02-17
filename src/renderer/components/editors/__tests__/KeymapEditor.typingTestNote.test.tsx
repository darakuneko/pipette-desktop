// SPDX-License-Identifier: GPL-2.0-or-later
// @vitest-environment jsdom

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => {
      const map: Record<string, string> = {
        'common.loading': 'Loading...',
        'editor.keymap.layerN': 'Layer',
        'editor.keymap.layerLabel': 'Layer',
        'editor.typingTest.layerNote': 'Only MO / LT / LM layer switches are tracked. Other layer keys and advanced features may not be reflected.',
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

describe('KeymapEditor — typing test layer note', () => {
  const defaultProps = {
    layout: makeLayout(),
    layers: 2,
    currentLayer: 0,
    onLayerChange: vi.fn(),
    keymap: new Map([['0,0,0', 4], ['1,0,0', 5]]),
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

  it('shows layer note when typing test mode is active', () => {
    render(<KeymapEditor {...defaultProps} typingTestMode />)
    expect(screen.getByTestId('typing-test-layer-note')).toBeInTheDocument()
    expect(screen.getByTestId('typing-test-layer-note')).toHaveTextContent('Only MO / LT / LM layer switches are tracked. Other layer keys and advanced features may not be reflected.')
  })

  it('does not show layer note when typing test mode is inactive', () => {
    render(<KeymapEditor {...defaultProps} />)
    expect(screen.queryByTestId('typing-test-layer-note')).not.toBeInTheDocument()
  })
})
