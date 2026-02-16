// SPDX-License-Identifier: GPL-2.0-or-later
// @vitest-environment jsdom

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) => {
      const map: Record<string, string> = {
        'editor.macro.editTitle': `M${opts?.index ?? ''}`,
        'editor.macro.memoryUsage': `Memory: ${opts?.used} / ${opts?.total} bytes`,
        'editor.macro.addAction': 'Add Action',
        'editor.macro.text': 'Text',
        'editor.macro.record': 'Record',
        'common.save': 'Save',
        'common.close': 'Close',
        'common.revert': 'Revert',
      }
      return map[key] ?? key
    },
  }),
}))

// Mock MacroEditor to verify props are passed through
let capturedInitialMacro: number | undefined
vi.mock('../MacroEditor', () => ({
  MacroEditor: (props: { initialMacro?: number }) => {
    capturedInitialMacro = props.initialMacro
    return <div data-testid="editor-macro">MacroEditor</div>
  },
}))

import { MacroModal } from '../MacroModal'

describe('MacroModal', () => {
  const defaultProps = {
    index: 3,
    macroCount: 16,
    macroBufferSize: 512,
    macroBuffer: [0],
    vialProtocol: 9,
    onSaveMacros: vi.fn().mockResolvedValue(undefined),
    onClose: vi.fn(),
  }

  beforeEach(() => {
    vi.clearAllMocks()
    capturedInitialMacro = undefined
  })

  it('renders with correct title', () => {
    render(<MacroModal {...defaultProps} />)
    expect(screen.getByText('M3')).toBeInTheDocument()
  })

  it('renders MacroEditor with initialMacro', () => {
    render(<MacroModal {...defaultProps} />)
    expect(screen.getByTestId('editor-macro')).toBeInTheDocument()
    expect(capturedInitialMacro).toBe(3)
  })

  it('calls onClose when clicking backdrop', () => {
    render(<MacroModal {...defaultProps} />)
    fireEvent.click(screen.getByTestId('macro-modal-backdrop'))
    expect(defaultProps.onClose).toHaveBeenCalledOnce()
  })

  it('does NOT close when clicking inside the modal', () => {
    render(<MacroModal {...defaultProps} />)
    fireEvent.click(screen.getByTestId('macro-modal'))
    expect(defaultProps.onClose).not.toHaveBeenCalled()
  })

  it('calls onClose when pressing Escape', () => {
    render(<MacroModal {...defaultProps} />)
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(defaultProps.onClose).toHaveBeenCalledOnce()
  })

  it('calls onClose when clicking Close button', () => {
    render(<MacroModal {...defaultProps} />)
    fireEvent.click(screen.getByTestId('macro-modal-close'))
    expect(defaultProps.onClose).toHaveBeenCalledOnce()
  })
})
