// SPDX-License-Identifier: GPL-2.0-or-later
// @vitest-environment jsdom

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { MacroTextEditor } from '../MacroTextEditor'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => {
      const map: Record<string, string> = {
        'editor.macro.textEditorTitle': 'Edit Macro (Text)',
        'editor.macro.invalidJson': 'Invalid JSON format',
        'common.cancel': 'Cancel',
        'common.apply': 'Apply',
      }
      return map[key] ?? key
    },
  }),
}))

vi.mock('../../../../preload/macro', () => ({
  jsonToMacroActions: (json: string) => {
    try {
      const parsed = JSON.parse(json)
      if (!Array.isArray(parsed)) return null
      return parsed
    } catch {
      return null
    }
  },
}))

describe('MacroTextEditor', () => {
  const defaultProps = {
    initialJson: '[["text","hello"]]',
    onApply: vi.fn(),
    onClose: vi.fn(),
  }

  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('renders the dialog with initial JSON', () => {
    render(<MacroTextEditor {...defaultProps} />)
    expect(screen.getByTestId('macro-text-editor')).toBeInTheDocument()
    expect(screen.getByText('Edit Macro (Text)')).toBeInTheDocument()
    const textarea = screen.getByTestId('macro-text-editor-textarea') as HTMLTextAreaElement
    expect(textarea.value).toBe('[["text","hello"]]')
  })

  it('enables Apply when JSON is valid', () => {
    render(<MacroTextEditor {...defaultProps} />)
    const applyBtn = screen.getByTestId('macro-text-editor-apply')
    expect(applyBtn).not.toBeDisabled()
  })

  it('disables Apply and shows error when JSON is invalid', () => {
    render(<MacroTextEditor {...defaultProps} />)
    const textarea = screen.getByTestId('macro-text-editor-textarea')
    fireEvent.change(textarea, { target: { value: 'not valid json' } })
    expect(screen.getByTestId('macro-text-editor-error')).toBeInTheDocument()
    expect(screen.getByTestId('macro-text-editor-apply')).toBeDisabled()
  })

  it('calls onApply and onClose when Apply is clicked with valid JSON', () => {
    const onApply = vi.fn()
    const onClose = vi.fn()
    render(<MacroTextEditor {...defaultProps} onApply={onApply} onClose={onClose} />)
    fireEvent.click(screen.getByTestId('macro-text-editor-apply'))
    expect(onApply).toHaveBeenCalledWith([['text', 'hello']])
    expect(onClose).toHaveBeenCalled()
  })

  it('calls onClose when Cancel is clicked', () => {
    const onClose = vi.fn()
    render(<MacroTextEditor {...defaultProps} onClose={onClose} />)
    fireEvent.click(screen.getByTestId('macro-text-editor-cancel'))
    expect(onClose).toHaveBeenCalled()
  })

  it('calls onClose when Escape is pressed', () => {
    const onClose = vi.fn()
    render(<MacroTextEditor {...defaultProps} onClose={onClose} />)
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(onClose).toHaveBeenCalled()
  })

  it('calls onClose when backdrop is clicked', () => {
    const onClose = vi.fn()
    render(<MacroTextEditor {...defaultProps} onClose={onClose} />)
    fireEvent.click(screen.getByTestId('macro-text-editor'))
    expect(onClose).toHaveBeenCalled()
  })

  it('does not call onClose when dialog content is clicked', () => {
    const onClose = vi.fn()
    render(<MacroTextEditor {...defaultProps} onClose={onClose} />)
    fireEvent.click(screen.getByTestId('macro-text-editor-textarea'))
    expect(onClose).not.toHaveBeenCalled()
  })

  it('shows error for non-array JSON', () => {
    render(<MacroTextEditor {...defaultProps} />)
    const textarea = screen.getByTestId('macro-text-editor-textarea')
    fireEvent.change(textarea, { target: { value: '{"type":"text"}' } })
    expect(screen.getByTestId('macro-text-editor-error')).toBeInTheDocument()
    expect(screen.getByTestId('macro-text-editor-apply')).toBeDisabled()
  })

  it('shows error and disables Apply when initialJson is invalid', () => {
    render(<MacroTextEditor {...defaultProps} initialJson="not valid" />)
    expect(screen.getByTestId('macro-text-editor-error')).toBeInTheDocument()
    expect(screen.getByTestId('macro-text-editor-apply')).toBeDisabled()
  })

  it('clears error and enables Apply after fixing invalid JSON', () => {
    render(<MacroTextEditor {...defaultProps} />)
    const textarea = screen.getByTestId('macro-text-editor-textarea')
    fireEvent.change(textarea, { target: { value: 'broken' } })
    expect(screen.getByTestId('macro-text-editor-error')).toBeInTheDocument()
    fireEvent.change(textarea, { target: { value: '[["text","fixed"]]' } })
    expect(screen.queryByTestId('macro-text-editor-error')).not.toBeInTheDocument()
    expect(screen.getByTestId('macro-text-editor-apply')).not.toBeDisabled()
  })

  it('has dialog accessibility attributes', () => {
    render(<MacroTextEditor {...defaultProps} />)
    const dialog = screen.getByRole('dialog')
    expect(dialog).toHaveAttribute('aria-modal', 'true')
    expect(dialog).toHaveAttribute('aria-labelledby')
  })
})
