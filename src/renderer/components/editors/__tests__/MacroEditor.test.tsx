// SPDX-License-Identifier: GPL-2.0-or-later
// @vitest-environment jsdom

import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) => {
      const map: Record<string, string> = {
        'editor.macro.memoryUsage': `Memory: ${opts?.used} / ${opts?.total} bytes`,
        'editor.macro.addAction': 'Add Action',
        'editor.macro.record': 'Record',
        'editor.macro.textEditor': 'Text Editor',
        'common.save': 'Save',
        'common.revert': 'Revert',
      }
      return map[key] ?? key
    },
  }),
}))

vi.mock('../MacroRecorder', () => ({
  MacroRecorder: () => <button>Record</button>,
}))

vi.mock('../MacroTextEditor', () => ({
  MacroTextEditor: ({ onClose }: { onClose: () => void }) => (
    <div data-testid="macro-text-editor">
      <button onClick={onClose} data-testid="macro-text-editor-cancel">Cancel</button>
    </div>
  ),
}))

vi.mock('../../keycodes/TabbedKeycodes', () => ({
  TabbedKeycodes: () => <div data-testid="tabbed-keycodes" />,
}))

vi.mock('../../keycodes/KeyPopover', () => ({
  KeyPopover: () => <div data-testid="key-popover" />,
}))

vi.mock('../../../../preload/macro', () => ({
  deserializeAllMacros: (_buf: number[], _proto: number, count: number) =>
    Array.from({ length: count }, () => []),
  serializeAllMacros: () => [0],
  serializeMacro: () => [],
  macroActionsToJson: () => '[]',
  isValidMacroText: (text: string) => /^[\x20-\x7e]*$/.test(text),
}))

vi.mock('../../../../shared/keycodes/keycodes', () => ({
  deserialize: (_val: string) => 0,
}))

import { MacroEditor } from '../MacroEditor'

describe('MacroEditor', () => {
  const defaultProps = {
    macroCount: 4,
    macroBufferSize: 512,
    macroBuffer: [0],
    vialProtocol: 9,
    onSaveMacros: vi.fn().mockResolvedValue(undefined),
  }

  it('renders the editor', () => {
    render(<MacroEditor {...defaultProps} />)
    expect(screen.getByTestId('editor-macro')).toBeInTheDocument()
  })

  it('renders memory usage', () => {
    render(<MacroEditor {...defaultProps} />)
    expect(screen.getByTestId('macro-memory')).toBeInTheDocument()
  })

  it('renders Text Editor button', () => {
    render(<MacroEditor {...defaultProps} />)
    expect(screen.getByTestId('macro-text-editor-btn')).toBeInTheDocument()
    expect(screen.getByTestId('macro-text-editor-btn').textContent).toBe('Text Editor')
  })

  it('shows text editor dialog when Text Editor button is clicked', () => {
    render(<MacroEditor {...defaultProps} />)
    expect(screen.queryByTestId('macro-text-editor')).not.toBeInTheDocument()
    fireEvent.click(screen.getByTestId('macro-text-editor-btn'))
    expect(screen.getByTestId('macro-text-editor')).toBeInTheDocument()
  })

  it('hides text editor dialog when Cancel is clicked', () => {
    render(<MacroEditor {...defaultProps} />)
    fireEvent.click(screen.getByTestId('macro-text-editor-btn'))
    expect(screen.getByTestId('macro-text-editor')).toBeInTheDocument()
    fireEvent.click(screen.getByTestId('macro-text-editor-cancel'))
    expect(screen.queryByTestId('macro-text-editor')).not.toBeInTheDocument()
  })

  it('renders fav button when isDummy is false', () => {
    render(<MacroEditor {...defaultProps} isDummy={false} />)
    expect(screen.getByTestId('macro-fav-btn')).toBeInTheDocument()
  })

  it('hides fav button when isDummy is true', () => {
    render(<MacroEditor {...defaultProps} isDummy={true} />)
    expect(screen.queryByTestId('macro-fav-btn')).not.toBeInTheDocument()
  })
})
