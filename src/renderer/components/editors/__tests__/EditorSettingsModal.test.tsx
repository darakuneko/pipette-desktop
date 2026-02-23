// SPDX-License-Identifier: GPL-2.0-or-later
// @vitest-environment jsdom

import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { EditorSettingsModal } from '../EditorSettingsModal'
import { KEYBOARD_LAYOUTS } from '../../../data/keyboard-layouts'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, params?: Record<string, unknown>) => {
      const map: Record<string, string> = {
        'editorSettings.title': 'Settings',
        'editorSettings.tabData': 'Data',
        'editorSettings.tabTools': 'Tools',
        'editor.autoAdvance': 'Auto Move',
        'layout.keyboardLayout': 'Layout',
        'settings.security': 'Security',
        'security.lock': 'Lock',
        'statusBar.locked': 'Locked',
        'statusBar.unlocked': 'Unlocked',
        'editor.keymap.zoomLabel': 'Zoom',
        'editor.keymap.zoomIn': 'Zoom In',
        'editor.keymap.zoomOut': 'Zoom Out',
        'sync.resetKeyboardData': 'Reset Keyboard Data',
        'sync.resetKeyboardDataConfirm': "{{name}}'s data will be deleted.",
        'common.cancel': 'Cancel',
        'common.reset': 'Reset',
        'sync.resetDisabledWhileSyncing': 'Cannot reset while sync is in progress',
      }
      if (key === 'editor.keymap.layerN' && params) return `Layer ${params.n}`
      return map[key] ?? key
    },
  }),
}))

const DEFAULT_PROPS = {
  entries: [],
  onSave: vi.fn(),
  onLoad: vi.fn(),
  onRename: vi.fn(),
  onDelete: vi.fn(),
  onClose: vi.fn(),
  activeTab: 'tools' as const,
  onTabChange: vi.fn(),
  keyboardLayout: 'qwerty',
  onKeyboardLayoutChange: vi.fn(),
  autoAdvance: true,
  onAutoAdvanceChange: vi.fn(),
  unlocked: true,
  onLock: vi.fn(),
}

describe('EditorSettingsModal', () => {
  it('renders with title and two tabs', () => {
    render(<EditorSettingsModal {...DEFAULT_PROPS} />)

    expect(screen.getByText('Settings')).toBeInTheDocument()
    expect(screen.getByTestId('editor-settings-tab-tools')).toHaveTextContent('Tools')
    expect(screen.getByTestId('editor-settings-tab-data')).toHaveTextContent('Data')
  })

  it('has correct dialog semantics', () => {
    render(<EditorSettingsModal {...DEFAULT_PROPS} />)

    const dialog = screen.getByRole('dialog')
    expect(dialog).toHaveAttribute('aria-modal', 'true')
    expect(dialog).toHaveAttribute('aria-labelledby', 'editor-settings-title')
  })

  it('tabs have correct ARIA tab semantics', () => {
    render(<EditorSettingsModal {...DEFAULT_PROPS} />)

    const tablist = screen.getByRole('tablist')
    expect(tablist).toBeInTheDocument()

    const tabs = screen.getAllByRole('tab')
    expect(tabs).toHaveLength(2)
    expect(tabs[0]).toHaveAttribute('aria-selected', 'true')
    expect(tabs[1]).toHaveAttribute('aria-selected', 'false')
  })

  it('shows Data tab content when data tab active', () => {
    render(<EditorSettingsModal {...DEFAULT_PROPS} activeTab="data" />)

    expect(screen.getByTestId('layout-store-empty')).toBeInTheDocument()
  })

  it('calls onTabChange when Tools tab is clicked', () => {
    const onTabChange = vi.fn()
    render(<EditorSettingsModal {...DEFAULT_PROPS} onTabChange={onTabChange} />)

    fireEvent.click(screen.getByTestId('editor-settings-tab-tools'))

    expect(onTabChange).toHaveBeenCalledWith('tools')
  })

  it('shows layout selector and auto-advance toggle on Tools tab', () => {
    render(<EditorSettingsModal {...DEFAULT_PROPS} />)

    const selector = screen.getByTestId('editor-settings-layout-selector')
    expect(selector).toBeInTheDocument()
    const options = selector.querySelectorAll('option')
    expect(options.length).toBe(KEYBOARD_LAYOUTS.length)

    expect(screen.getByTestId('editor-settings-auto-advance-row')).toBeInTheDocument()
    expect(screen.getByTestId('editor-settings-auto-advance-toggle')).toBeInTheDocument()
  })

  it('shows lock button and unlocked status in Tools tab', () => {
    render(<EditorSettingsModal {...DEFAULT_PROPS} activeTab="tools" unlocked={true} />)

    expect(screen.getByTestId('editor-settings-lock-row')).toBeInTheDocument()
    expect(screen.getByTestId('editor-settings-lock-button')).toBeInTheDocument()
    expect(screen.getByTestId('editor-settings-lock-status')).toHaveTextContent('Unlocked')
  })

  it('shows locked status in Tools tab when locked', () => {
    render(<EditorSettingsModal {...DEFAULT_PROPS} activeTab="tools" unlocked={false} />)

    expect(screen.getByTestId('editor-settings-lock-status')).toHaveTextContent('Locked')
  })

  it('calls onLock when lock button is clicked', () => {
    const onLock = vi.fn()
    render(<EditorSettingsModal {...DEFAULT_PROPS} activeTab="tools" onLock={onLock} />)

    fireEvent.click(screen.getByTestId('editor-settings-lock-button'))

    expect(onLock).toHaveBeenCalledOnce()
  })

  it('calls onKeyboardLayoutChange when layout is changed', () => {
    const onKeyboardLayoutChange = vi.fn()
    render(<EditorSettingsModal {...DEFAULT_PROPS} activeTab="tools" onKeyboardLayoutChange={onKeyboardLayoutChange} />)

    fireEvent.change(screen.getByTestId('editor-settings-layout-selector'), { target: { value: 'dvorak' } })

    expect(onKeyboardLayoutChange).toHaveBeenCalledWith('dvorak')
  })

  it('calls onAutoAdvanceChange when toggle is clicked', () => {
    const onAutoAdvanceChange = vi.fn()
    render(<EditorSettingsModal {...DEFAULT_PROPS} activeTab="tools" autoAdvance={true} onAutoAdvanceChange={onAutoAdvanceChange} />)

    fireEvent.click(screen.getByTestId('editor-settings-auto-advance-toggle'))

    expect(onAutoAdvanceChange).toHaveBeenCalledWith(false)
  })

  it('calls onClose when close button clicked', () => {
    const onClose = vi.fn()
    render(<EditorSettingsModal {...DEFAULT_PROPS} onClose={onClose} />)

    fireEvent.click(screen.getByTestId('editor-settings-close'))
    expect(onClose).toHaveBeenCalledOnce()
  })

  it('calls onClose when backdrop clicked', () => {
    const onClose = vi.fn()
    render(<EditorSettingsModal {...DEFAULT_PROPS} onClose={onClose} />)

    fireEvent.click(screen.getByTestId('editor-settings-backdrop'))
    expect(onClose).toHaveBeenCalledOnce()
  })

  it('does not close modal on Escape key', () => {
    const onClose = vi.fn()
    render(<EditorSettingsModal {...DEFAULT_PROPS} onClose={onClose} />)

    fireEvent.keyDown(document, { key: 'Escape' })
    expect(onClose).not.toHaveBeenCalled()
  })

  it('auto-advance toggle has correct aria-checked attribute', () => {
    const { rerender } = render(<EditorSettingsModal {...DEFAULT_PROPS} activeTab="tools" autoAdvance={true} />)

    const toggle = screen.getByTestId('editor-settings-auto-advance-toggle')
    expect(toggle).toHaveAttribute('aria-checked', 'true')
    expect(toggle).toHaveAttribute('aria-label', 'Auto Move')

    rerender(<EditorSettingsModal {...DEFAULT_PROPS} activeTab="tools" autoAdvance={false} />)
    expect(screen.getByTestId('editor-settings-auto-advance-toggle')).toHaveAttribute('aria-checked', 'false')
  })

  it('shows zoom controls on Tools tab with percentage display', () => {
    render(<EditorSettingsModal {...DEFAULT_PROPS} activeTab="tools" scale={1.0} />)

    expect(screen.getByTestId('editor-settings-zoom-row')).toBeInTheDocument()
    expect(screen.getByTestId('editor-settings-zoom-value')).toHaveTextContent('100%')
    expect(screen.getByTestId('editor-settings-zoom-in')).toBeInTheDocument()
    expect(screen.getByTestId('editor-settings-zoom-out')).toBeInTheDocument()
  })

  it('calls onScaleChange when zoom buttons are clicked', () => {
    const onScaleChange = vi.fn()
    render(<EditorSettingsModal {...DEFAULT_PROPS} activeTab="tools" scale={1.0} onScaleChange={onScaleChange} />)

    fireEvent.click(screen.getByTestId('editor-settings-zoom-in'))
    expect(onScaleChange).toHaveBeenCalledWith(0.1)

    fireEvent.click(screen.getByTestId('editor-settings-zoom-out'))
    expect(onScaleChange).toHaveBeenCalledWith(-0.1)
  })

  it('disables zoom-in at max scale and zoom-out at min scale', () => {
    const { rerender } = render(<EditorSettingsModal {...DEFAULT_PROPS} activeTab="tools" scale={2.0} />)

    expect(screen.getByTestId('editor-settings-zoom-in')).toBeDisabled()
    expect(screen.getByTestId('editor-settings-zoom-out')).not.toBeDisabled()

    rerender(<EditorSettingsModal {...DEFAULT_PROPS} activeTab="tools" scale={0.3} />)

    expect(screen.getByTestId('editor-settings-zoom-out')).toBeDisabled()
    expect(screen.getByTestId('editor-settings-zoom-in')).not.toBeDisabled()
  })

  it('displays correct percentage for fractional scales', () => {
    render(<EditorSettingsModal {...DEFAULT_PROPS} activeTab="tools" scale={0.5} />)

    expect(screen.getByTestId('editor-settings-zoom-value')).toHaveTextContent('50%')
  })

  it('renders on left side by default', () => {
    render(<EditorSettingsModal {...DEFAULT_PROPS} />)

    const dialog = screen.getByRole('dialog')
    expect(dialog.className).toContain('left-0')
    expect(dialog.className).toContain('border-r')
  })

  it('renders on left side when panelSide="left"', () => {
    render(<EditorSettingsModal {...DEFAULT_PROPS} panelSide="left" />)

    const dialog = screen.getByRole('dialog')
    expect(dialog.className).toContain('left-0')
    expect(dialog.className).toContain('border-r')
    expect(dialog.className).not.toContain('right-0')
  })

  it('renders on right side when panelSide="right"', () => {
    render(<EditorSettingsModal {...DEFAULT_PROPS} panelSide="right" />)

    const dialog = screen.getByRole('dialog')
    expect(dialog.className).toContain('right-0')
    expect(dialog.className).toContain('border-l')
    expect(dialog.className).not.toContain('left-0')
  })

  describe('isDummy mode', () => {
    it('hides lock row in Tools tab when isDummy is true', () => {
      render(<EditorSettingsModal {...DEFAULT_PROPS} activeTab="tools" isDummy />)

      expect(screen.queryByTestId('editor-settings-lock-row')).not.toBeInTheDocument()
    })

    it('hides save form and history in Data tab when isDummy is true', () => {
      render(<EditorSettingsModal {...DEFAULT_PROPS} activeTab="data" isDummy />)

      expect(screen.queryByTestId('layout-store-save-input')).not.toBeInTheDocument()
      expect(screen.queryByTestId('layout-store-empty')).not.toBeInTheDocument()
    })
  })

  describe('Reset Keyboard Data', () => {
    const RESET_PROPS = {
      ...DEFAULT_PROPS,
      activeTab: 'data' as const,
      onResetKeyboardData: vi.fn().mockResolvedValue(undefined),
    }

    it('does not render reset section when onResetKeyboardData is not provided', () => {
      render(<EditorSettingsModal {...DEFAULT_PROPS} activeTab="data" />)

      expect(screen.queryByTestId('reset-keyboard-data-section')).not.toBeInTheDocument()
    })

    it('renders reset button when onResetKeyboardData is provided', () => {
      render(<EditorSettingsModal {...RESET_PROPS} />)

      expect(screen.getByTestId('reset-keyboard-data-section')).toBeInTheDocument()
      expect(screen.getByTestId('reset-keyboard-data-btn')).toBeInTheDocument()
    })

    it('shows confirmation warning when reset button is clicked', () => {
      render(<EditorSettingsModal {...RESET_PROPS} />)

      fireEvent.click(screen.getByTestId('reset-keyboard-data-btn'))

      expect(screen.getByTestId('reset-keyboard-data-warning')).toBeInTheDocument()
      expect(screen.getByTestId('reset-keyboard-data-cancel')).toBeInTheDocument()
      expect(screen.getByTestId('reset-keyboard-data-confirm')).toBeInTheDocument()
    })

    it('hides confirmation when cancel is clicked', () => {
      render(<EditorSettingsModal {...RESET_PROPS} />)

      fireEvent.click(screen.getByTestId('reset-keyboard-data-btn'))
      fireEvent.click(screen.getByTestId('reset-keyboard-data-cancel'))

      expect(screen.queryByTestId('reset-keyboard-data-warning')).not.toBeInTheDocument()
      expect(screen.getByTestId('reset-keyboard-data-btn')).toBeInTheDocument()
    })

    it('calls onResetKeyboardData when confirm is clicked', () => {
      render(<EditorSettingsModal {...RESET_PROPS} />)

      fireEvent.click(screen.getByTestId('reset-keyboard-data-btn'))
      fireEvent.click(screen.getByTestId('reset-keyboard-data-confirm'))

      expect(RESET_PROPS.onResetKeyboardData).toHaveBeenCalledOnce()
    })

    it('disables reset button when syncStatus is syncing', () => {
      render(<EditorSettingsModal {...RESET_PROPS} syncStatus="syncing" />)

      expect(screen.getByTestId('reset-keyboard-data-btn')).toBeDisabled()
    })

    it('enables reset button when syncStatus is not syncing', () => {
      render(<EditorSettingsModal {...RESET_PROPS} syncStatus="pending" />)

      expect(screen.getByTestId('reset-keyboard-data-btn')).not.toBeDisabled()
    })

    it('disables confirm button when syncStatus changes to syncing', () => {
      const { rerender } = render(<EditorSettingsModal {...RESET_PROPS} />)

      fireEvent.click(screen.getByTestId('reset-keyboard-data-btn'))
      expect(screen.getByTestId('reset-keyboard-data-confirm')).not.toBeDisabled()

      // Sync starts while confirmation dialog is open
      rerender(<EditorSettingsModal {...RESET_PROPS} syncStatus="syncing" />)
      expect(screen.getByTestId('reset-keyboard-data-confirm')).toBeDisabled()
    })
  })
})
