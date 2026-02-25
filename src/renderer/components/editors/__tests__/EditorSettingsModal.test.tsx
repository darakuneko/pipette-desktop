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

  describe('isDummy mode', () => {
    it('hides save form and history when isDummy is true', () => {
      render(<EditorSettingsModal {...DEFAULT_PROPS} isDummy />)

      expect(screen.queryByTestId('layout-store-save-input')).not.toBeInTheDocument()
      expect(screen.queryByTestId('layout-store-empty')).not.toBeInTheDocument()
    })
  })
})
