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
        'editor.keymap.zoomIn': 'Zoom In',
        'editor.keymap.zoomOut': 'Zoom Out',
      }
      return map[key] ?? key
    },
  }),
}))

let capturedScale: number | undefined

vi.mock('../../keyboard/KeyboardWidget', () => ({
  KeyboardWidget: (props: { scale?: number }) => {
    capturedScale = props.scale
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

const makeLayout = () => ({
  keys: [
    { x: 0, y: 0, w: 1, h: 1, height: 1, row: 0, col: 0, encoderIdx: -1, decal: false, labels: [] },
  ],
})

describe('KeymapEditor — zoom controls', () => {
  const onScaleChange = vi.fn()

  const defaultProps = {
    layout: makeLayout(),
    layers: 1,
    currentLayer: 0,
    keymap: new Map([['0,0,0', 4]]),
    encoderLayout: new Map<string, number>(),
    encoderCount: 0,
    layoutOptions: new Map<number, number>(),
    onSetKey: vi.fn().mockResolvedValue(undefined),
    onSetEncoder: vi.fn().mockResolvedValue(undefined),
    onScaleChange,
  }

  beforeEach(() => {
    vi.clearAllMocks()
    capturedScale = undefined
  })

  it('passes default scale of 1 to KeyboardWidget when no scale prop given', () => {
    render(<KeymapEditor {...defaultProps} />)
    expect(capturedScale).toBe(1)
  })

  it('passes scale prop to KeyboardWidget', () => {
    render(<KeymapEditor {...defaultProps} scale={1.5} />)
    expect(capturedScale).toBe(1.5)
  })

  it('calls onScaleChange with +0.1 when clicking zoom in', () => {
    render(<KeymapEditor {...defaultProps} />)

    fireEvent.click(screen.getByTestId('zoom-in-button'))
    expect(onScaleChange).toHaveBeenCalledWith(0.1)
  })

  it('calls onScaleChange with -0.1 when clicking zoom out', () => {
    render(<KeymapEditor {...defaultProps} />)

    fireEvent.click(screen.getByTestId('zoom-out-button'))
    expect(onScaleChange).toHaveBeenCalledWith(-0.1)
  })

  it('renders zoom buttons with correct aria-labels', () => {
    render(<KeymapEditor {...defaultProps} />)

    expect(screen.getByTestId('zoom-in-button')).toHaveAttribute('aria-label', 'Zoom In')
    expect(screen.getByTestId('zoom-out-button')).toHaveAttribute('aria-label', 'Zoom Out')
  })

  it('disables zoom-in button at max scale (2.0)', () => {
    render(<KeymapEditor {...defaultProps} scale={2.0} />)

    expect(screen.getByTestId('zoom-in-button')).toBeDisabled()
    expect(screen.getByTestId('zoom-out-button')).not.toBeDisabled()
  })

  it('disables zoom-out button at min scale (0.3)', () => {
    render(<KeymapEditor {...defaultProps} scale={0.3} />)

    expect(screen.getByTestId('zoom-out-button')).toBeDisabled()
    expect(screen.getByTestId('zoom-in-button')).not.toBeDisabled()
  })

  it('enables both buttons at mid scale', () => {
    render(<KeymapEditor {...defaultProps} scale={1.0} />)

    expect(screen.getByTestId('zoom-in-button')).not.toBeDisabled()
    expect(screen.getByTestId('zoom-out-button')).not.toBeDisabled()
  })
})
