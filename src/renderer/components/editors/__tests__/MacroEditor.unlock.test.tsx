// SPDX-License-Identifier: GPL-2.0-or-later
// @vitest-environment jsdom

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, act } from '@testing-library/react'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) => {
      const map: Record<string, string> = {
        'editor.macro.memoryUsage': `Memory: ${opts?.used} / ${opts?.total} bytes`,
        'editor.macro.addAction': 'Add Action',
        'editor.macro.record': 'Record',
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

vi.mock('../../../../preload/macro', () => ({
  deserializeAllMacros: (_buf: number[], _proto: number, count: number) =>
    Array.from({ length: count }, () => [{ type: 'text', text: 'a' }]),
  serializeAllMacros: () => [0x61, 0],
  serializeMacro: () => [0x61],
  macroActionsToJson: () => '[]',
  isValidMacroText: (text: string) => /^[\x20-\x7e]*$/.test(text),
}))

import { MacroEditor } from '../MacroEditor'

describe('MacroEditor unlock', () => {
  let onSaveMacros: ReturnType<typeof vi.fn>
  let onUnlock: ReturnType<typeof vi.fn>

  beforeEach(() => {
    onSaveMacros = vi.fn().mockResolvedValue(undefined)
    onUnlock = vi.fn()
  })

  const baseProps = {
    macroCount: 4,
    macroBufferSize: 512,
    macroBuffer: [0x61, 0],
    vialProtocol: 9,
    isDummy: true,
  }

  it('triggers unlock when saving while locked', async () => {
    render(
      <MacroEditor
        {...baseProps}
        onSaveMacros={onSaveMacros}
        unlocked={false}
        onUnlock={onUnlock}
      />,
    )
    // Mark dirty by adding an action
    await act(async () => {
      fireEvent.change(screen.getByTestId('macro-add-action'), { target: { value: 'text' } })
    })
    // Try to save
    await act(async () => {
      fireEvent.click(screen.getByTestId('macro-save'))
    })
    expect(onUnlock).toHaveBeenCalled()
    expect(onSaveMacros).not.toHaveBeenCalled()
  })

  it('saves immediately when already unlocked', async () => {
    render(
      <MacroEditor
        {...baseProps}
        onSaveMacros={onSaveMacros}
        unlocked={true}
        onUnlock={onUnlock}
      />,
    )
    await act(async () => {
      fireEvent.change(screen.getByTestId('macro-add-action'), { target: { value: 'text' } })
    })
    await act(async () => {
      fireEvent.click(screen.getByTestId('macro-save'))
    })
    expect(onUnlock).not.toHaveBeenCalled()
    expect(onSaveMacros).toHaveBeenCalled()
  })

  it('executes pending save after unlock completes', async () => {
    const { rerender } = render(
      <MacroEditor
        {...baseProps}
        onSaveMacros={onSaveMacros}
        unlocked={false}
        onUnlock={onUnlock}
      />,
    )
    await act(async () => {
      fireEvent.change(screen.getByTestId('macro-add-action'), { target: { value: 'text' } })
    })
    await act(async () => {
      fireEvent.click(screen.getByTestId('macro-save'))
    })
    expect(onSaveMacros).not.toHaveBeenCalled()

    // Simulate unlock completing
    await act(async () => {
      rerender(
        <MacroEditor
          {...baseProps}
          onSaveMacros={onSaveMacros}
          unlocked={true}
          onUnlock={onUnlock}
        />,
      )
    })
    expect(onSaveMacros).toHaveBeenCalled()
  })

  it('saves without unlock props (backwards compatibility)', async () => {
    render(<MacroEditor {...baseProps} onSaveMacros={onSaveMacros} />)
    await act(async () => {
      fireEvent.change(screen.getByTestId('macro-add-action'), { target: { value: 'text' } })
    })
    await act(async () => {
      fireEvent.click(screen.getByTestId('macro-save'))
    })
    expect(onSaveMacros).toHaveBeenCalled()
  })
})
