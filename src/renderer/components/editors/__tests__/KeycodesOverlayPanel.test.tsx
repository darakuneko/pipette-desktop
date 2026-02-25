// SPDX-License-Identifier: GPL-2.0-or-later
// @vitest-environment jsdom

import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { KeycodesOverlayPanel } from '../KeycodesOverlayPanel'
import { KEYBOARD_LAYOUTS } from '../../../data/keyboard-layouts'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => {
      const map: Record<string, string> = {
        'editorSettings.tabTools': 'Tools',
        'editorSettings.tabLayout': 'Layout',
        'layout.keyboardLayout': 'Layout',
        'editor.autoAdvance': 'Auto Move',
        'editor.matrixTester.title': 'Key Tester',
        'settings.security': 'Security',
        'security.lock': 'Lock',
        'statusBar.locked': 'Locked',
        'statusBar.unlocked': 'Unlocked',
      }
      return map[key] ?? key
    },
  }),
}))

const DEFAULT_PROPS = {
  hasLayoutOptions: false,
  keyboardLayout: 'qwerty' as const,
  onKeyboardLayoutChange: vi.fn(),
  autoAdvance: true,
  onAutoAdvanceChange: vi.fn(),
  matrixMode: false,
  hasMatrixTester: false,
  unlocked: true,
  onLock: vi.fn(),
}

describe('KeycodesOverlayPanel', () => {
  it('renders tools content when no layout options', () => {
    render(<KeycodesOverlayPanel {...DEFAULT_PROPS} />)

    expect(screen.getByTestId('keycodes-overlay-panel')).toBeInTheDocument()
    expect(screen.getByTestId('overlay-layout-row')).toBeInTheDocument()
    expect(screen.getByTestId('overlay-auto-advance-row')).toBeInTheDocument()
  })

  it('does not show tabs when no layout options', () => {
    render(<KeycodesOverlayPanel {...DEFAULT_PROPS} />)

    expect(screen.queryByTestId('overlay-tabs')).not.toBeInTheDocument()
  })

  it('shows tabs with proper accessibility when hasLayoutOptions is true', () => {
    render(
      <KeycodesOverlayPanel
        {...DEFAULT_PROPS}
        hasLayoutOptions
        layoutOptions={[{ index: 0, labels: ['Split Backspace'] }]}
        layoutValues={new Map([[0, 0]])}
        onLayoutOptionChange={vi.fn()}
      />,
    )

    const tablist = screen.getByTestId('overlay-tabs')
    expect(tablist).toHaveAttribute('role', 'tablist')

    const layoutTab = screen.getByTestId('overlay-tab-layout')
    expect(layoutTab).toHaveAttribute('role', 'tab')
    expect(layoutTab).toHaveAttribute('aria-selected', 'true')
    expect(layoutTab).toHaveTextContent('Layout')

    const toolsTab = screen.getByTestId('overlay-tab-tools')
    expect(toolsTab).toHaveAttribute('role', 'tab')
    expect(toolsTab).toHaveAttribute('aria-selected', 'false')
    expect(toolsTab).toHaveTextContent('Tools')
  })

  it('defaults to layout tab when hasLayoutOptions is true', () => {
    render(
      <KeycodesOverlayPanel
        {...DEFAULT_PROPS}
        hasLayoutOptions
        layoutOptions={[{ index: 0, labels: ['Split Backspace'] }]}
        layoutValues={new Map([[0, 0]])}
        onLayoutOptionChange={vi.fn()}
      />,
    )

    expect(screen.getByText('Split Backspace')).toBeInTheDocument()
  })

  it('switches to tools tab when clicked', () => {
    render(
      <KeycodesOverlayPanel
        {...DEFAULT_PROPS}
        hasLayoutOptions
        layoutOptions={[{ index: 0, labels: ['Split Backspace'] }]}
        layoutValues={new Map([[0, 0]])}
        onLayoutOptionChange={vi.fn()}
      />,
    )

    fireEvent.click(screen.getByTestId('overlay-tab-tools'))

    expect(screen.getByTestId('overlay-layout-row')).toBeInTheDocument()
    // Layout content is still in DOM (for width stability) but invisible
    expect(screen.getByText('Split Backspace').closest('[inert]')).toBeTruthy()
  })

  it('shows keyboard layout selector with all layouts', () => {
    render(<KeycodesOverlayPanel {...DEFAULT_PROPS} />)

    const selector = screen.getByTestId('overlay-layout-selector')
    const options = selector.querySelectorAll('option')
    expect(options.length).toBe(KEYBOARD_LAYOUTS.length)
  })

  it('calls onKeyboardLayoutChange when layout is changed', () => {
    const onKeyboardLayoutChange = vi.fn()
    render(<KeycodesOverlayPanel {...DEFAULT_PROPS} onKeyboardLayoutChange={onKeyboardLayoutChange} />)

    fireEvent.change(screen.getByTestId('overlay-layout-selector'), { target: { value: 'dvorak' } })
    expect(onKeyboardLayoutChange).toHaveBeenCalledWith('dvorak')
  })

  it('calls onAutoAdvanceChange when toggle is clicked', () => {
    const onAutoAdvanceChange = vi.fn()
    render(<KeycodesOverlayPanel {...DEFAULT_PROPS} onAutoAdvanceChange={onAutoAdvanceChange} />)

    fireEvent.click(screen.getByTestId('overlay-auto-advance-toggle'))
    expect(onAutoAdvanceChange).toHaveBeenCalledWith(false)
  })

  it('shows lock row with unlocked status', () => {
    render(<KeycodesOverlayPanel {...DEFAULT_PROPS} unlocked />)

    expect(screen.getByTestId('overlay-lock-status')).toHaveTextContent('Unlocked')
  })

  it('hides lock row when isDummy', () => {
    render(<KeycodesOverlayPanel {...DEFAULT_PROPS} isDummy />)

    expect(screen.queryByTestId('overlay-lock-row')).not.toBeInTheDocument()
  })

  it('shows matrix tester toggle when hasMatrixTester', () => {
    render(<KeycodesOverlayPanel {...DEFAULT_PROPS} hasMatrixTester onToggleMatrix={vi.fn()} />)

    expect(screen.getByTestId('overlay-matrix-row')).toBeInTheDocument()
  })

  it('resets to tools tab when hasLayoutOptions becomes false', () => {
    const { rerender } = render(
      <KeycodesOverlayPanel
        {...DEFAULT_PROPS}
        hasLayoutOptions
        layoutOptions={[{ index: 0, labels: ['Split Backspace'] }]}
        layoutValues={new Map([[0, 0]])}
        onLayoutOptionChange={vi.fn()}
      />,
    )

    // Starts on layout tab
    expect(screen.getByText('Split Backspace')).toBeInTheDocument()

    // hasLayoutOptions becomes false
    rerender(<KeycodesOverlayPanel {...DEFAULT_PROPS} />)

    // Should switch to tools tab
    expect(screen.queryByText('Split Backspace')).not.toBeInTheDocument()
    expect(screen.getByTestId('overlay-layout-row')).toBeInTheDocument()
  })

  it('calls onLayoutOptionChange when checkbox toggled', () => {
    const onLayoutOptionChange = vi.fn()
    render(
      <KeycodesOverlayPanel
        {...DEFAULT_PROPS}
        hasLayoutOptions
        layoutOptions={[{ index: 0, labels: ['Split Backspace'] }]}
        layoutValues={new Map([[0, 0]])}
        onLayoutOptionChange={onLayoutOptionChange}
      />,
    )

    const checkbox = screen.getByRole('checkbox')
    fireEvent.click(checkbox)
    expect(onLayoutOptionChange).toHaveBeenCalledWith(0, 1)
  })
})
