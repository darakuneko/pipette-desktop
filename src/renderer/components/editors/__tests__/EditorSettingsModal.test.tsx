// SPDX-License-Identifier: GPL-2.0-or-later
// @vitest-environment jsdom

import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { EditorSettingsModal } from '../EditorSettingsModal'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, params?: Record<string, unknown>) => {
      const map: Record<string, string> = {
        'editorSettings.tabData': 'Data',
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
}

describe('EditorSettingsModal', () => {
  it('renders with Data title', () => {
    render(<EditorSettingsModal {...DEFAULT_PROPS} />)

    expect(screen.getByText('Data')).toBeInTheDocument()
  })

  it('has correct dialog semantics', () => {
    render(<EditorSettingsModal {...DEFAULT_PROPS} />)

    const dialog = screen.getByRole('dialog')
    expect(dialog).toHaveAttribute('aria-modal', 'true')
    expect(dialog).toHaveAttribute('aria-labelledby', 'editor-settings-title')
  })

  it('shows Data content (layout store)', () => {
    render(<EditorSettingsModal {...DEFAULT_PROPS} />)

    expect(screen.getByTestId('layout-store-empty')).toBeInTheDocument()
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

  it('renders on left side by default', () => {
    render(<EditorSettingsModal {...DEFAULT_PROPS} />)

    const dialog = screen.getByRole('dialog')
    expect(dialog.className).toContain('left-0')
    expect(dialog.className).toContain('border-r')
  })

  it('renders on right side when panelSide="right"', () => {
    render(<EditorSettingsModal {...DEFAULT_PROPS} panelSide="right" />)

    const dialog = screen.getByRole('dialog')
    expect(dialog.className).toContain('right-0')
    expect(dialog.className).toContain('border-l')
    expect(dialog.className).not.toContain('left-0')
  })

  describe('isDummy mode', () => {
    it('hides save form and history when isDummy is true', () => {
      render(<EditorSettingsModal {...DEFAULT_PROPS} isDummy />)

      expect(screen.queryByTestId('layout-store-save-input')).not.toBeInTheDocument()
      expect(screen.queryByTestId('layout-store-empty')).not.toBeInTheDocument()
    })
  })

  describe('Reset Keyboard Data', () => {
    const RESET_PROPS = {
      ...DEFAULT_PROPS,
      onResetKeyboardData: vi.fn().mockResolvedValue(undefined),
    }

    it('does not render reset section when onResetKeyboardData is not provided', () => {
      render(<EditorSettingsModal {...DEFAULT_PROPS} />)

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
