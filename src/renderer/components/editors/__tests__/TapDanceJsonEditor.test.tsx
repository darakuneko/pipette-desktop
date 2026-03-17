// SPDX-License-Identifier: GPL-2.0-or-later
// @vitest-environment jsdom

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { TapDanceJsonEditor } from '../TapDanceJsonEditor'
import type { TapDanceEntry } from '../../../../shared/types/protocol'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) => {
      const map: Record<string, string> = {
        'editor.tapDance.jsonEditorTitle': 'Edit JSON',
        'editor.tapDance.invalidJson': 'Invalid JSON format',
        'editor.tapDance.invalidTappingTerm': 'Tapping term must be a number between 0 and 10000',
        'editor.tapDance.applyFailed': 'Failed to apply changes',
        'common.cancel': 'Cancel',
        'common.apply': 'Apply',
        'common.save': 'Save',
        'common.close': 'Close',
      }
      if (key === 'editor.tapDance.unknownKeycode') return `Unknown keycode: ${opts?.keycode}`
      return map[key] ?? key
    },
  }),
}))

const KNOWN_KEYCODES: Record<string, number> = { KC_NO: 0, KC_4: 4, KC_5: 5 }
const REVERSE_KEYCODES: Record<number, string> = { 0: 'KC_NO', 4: 'KC_4', 5: 'KC_5' }

vi.mock('../../../../shared/keycodes/keycodes', () => ({
  serialize: (code: number) => REVERSE_KEYCODES[code] ?? `0x${code.toString(16).padStart(4, '0').toUpperCase()}`,
  deserialize: (val: string) => KNOWN_KEYCODES[val] ?? 0,
}))

const makeEntry = (overrides?: Partial<TapDanceEntry>): TapDanceEntry => ({
  onTap: 0,
  onHold: 0,
  onDoubleTap: 0,
  onTapHold: 0,
  tappingTerm: 150,
  ...overrides,
})

describe('TapDanceJsonEditor', () => {
  const onApply = vi.fn()
  const onClose = vi.fn()

  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('renders modal with title', () => {
    render(
      <TapDanceJsonEditor entries={[makeEntry()]} onApply={onApply} onClose={onClose} />,
    )
    expect(screen.getByText('Edit JSON')).toBeInTheDocument()
  })

  it('renders textarea with JSON content', () => {
    const entries = [makeEntry({ onTap: 4, tappingTerm: 200 })]
    render(
      <TapDanceJsonEditor entries={entries} onApply={onApply} onClose={onClose} />,
    )
    const textarea = screen.getByTestId('tap-dance-json-editor-textarea') as HTMLTextAreaElement
    const parsed = JSON.parse(textarea.value)
    expect(parsed).toEqual([['KC_4', 'KC_NO', 'KC_NO', 'KC_NO', 200]])
  })

  it('Apply button is enabled for valid JSON', () => {
    render(
      <TapDanceJsonEditor entries={[makeEntry()]} onApply={onApply} onClose={onClose} />,
    )
    expect(screen.getByTestId('tap-dance-json-editor-apply')).toBeEnabled()
  })

  it('shows error and disables Apply for invalid JSON', () => {
    render(
      <TapDanceJsonEditor entries={[makeEntry()]} onApply={onApply} onClose={onClose} />,
    )
    const textarea = screen.getByTestId('tap-dance-json-editor-textarea')
    fireEvent.change(textarea, { target: { value: 'not valid json' } })
    expect(screen.getByTestId('tap-dance-json-editor-error')).toBeInTheDocument()
    expect(screen.getByTestId('tap-dance-json-editor-apply')).toBeDisabled()
  })

  it('shows error when array length does not match', () => {
    const entries = [makeEntry(), makeEntry()]
    render(
      <TapDanceJsonEditor entries={entries} onApply={onApply} onClose={onClose} />,
    )
    const textarea = screen.getByTestId('tap-dance-json-editor-textarea')
    // Only 1 entry instead of 2
    fireEvent.change(textarea, { target: { value: '[["KC_NO","KC_NO","KC_NO","KC_NO",150]]' } })
    expect(screen.getByTestId('tap-dance-json-editor-error')).toBeInTheDocument()
    expect(screen.getByTestId('tap-dance-json-editor-apply')).toBeDisabled()
  })

  it('shows error when inner array has wrong length', () => {
    render(
      <TapDanceJsonEditor entries={[makeEntry()]} onApply={onApply} onClose={onClose} />,
    )
    const textarea = screen.getByTestId('tap-dance-json-editor-textarea')
    fireEvent.change(textarea, { target: { value: '[["KC_NO","KC_NO","KC_NO"]]' } })
    expect(screen.getByTestId('tap-dance-json-editor-error')).toBeInTheDocument()
  })

  it('calls onApply with parsed entries and closes', async () => {
    const entries = [makeEntry()]
    render(
      <TapDanceJsonEditor entries={entries} onApply={onApply} onClose={onClose} />,
    )
    const textarea = screen.getByTestId('tap-dance-json-editor-textarea')
    fireEvent.change(textarea, { target: { value: '[["KC_4","KC_5","KC_NO","KC_NO",200]]' } })
    fireEvent.click(screen.getByTestId('tap-dance-json-editor-apply'))
    expect(onApply).toHaveBeenCalledWith([
      { onTap: 4, onHold: 5, onDoubleTap: 0, onTapHold: 0, tappingTerm: 200 },
    ])
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1))
  })

  it('calls onClose when Cancel is clicked', () => {
    render(
      <TapDanceJsonEditor entries={[makeEntry()]} onApply={onApply} onClose={onClose} />,
    )
    fireEvent.click(screen.getByTestId('tap-dance-json-editor-cancel'))
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('calls onClose when backdrop is clicked', () => {
    render(
      <TapDanceJsonEditor entries={[makeEntry()]} onApply={onApply} onClose={onClose} />,
    )
    fireEvent.click(screen.getByTestId('tap-dance-json-editor'))
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('does not close when dialog content is clicked', () => {
    render(
      <TapDanceJsonEditor entries={[makeEntry()]} onApply={onApply} onClose={onClose} />,
    )
    fireEvent.click(screen.getByRole('dialog'))
    expect(onClose).not.toHaveBeenCalled()
  })

  it('closes on Escape key', () => {
    render(
      <TapDanceJsonEditor entries={[makeEntry()]} onApply={onApply} onClose={onClose} />,
    )
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('does not call onApply when Apply is clicked with invalid JSON', () => {
    render(
      <TapDanceJsonEditor entries={[makeEntry()]} onApply={onApply} onClose={onClose} />,
    )
    const textarea = screen.getByTestId('tap-dance-json-editor-textarea')
    fireEvent.change(textarea, { target: { value: 'invalid' } })
    fireEvent.click(screen.getByTestId('tap-dance-json-editor-apply'))
    expect(onApply).not.toHaveBeenCalled()
  })

  it('validates tapping term range (rejects negative)', () => {
    render(
      <TapDanceJsonEditor entries={[makeEntry()]} onApply={onApply} onClose={onClose} />,
    )
    const textarea = screen.getByTestId('tap-dance-json-editor-textarea')
    fireEvent.change(textarea, { target: { value: '[["KC_NO","KC_NO","KC_NO","KC_NO",-1]]' } })
    expect(screen.getByTestId('tap-dance-json-editor-error')).toBeInTheDocument()
  })

  it('validates tapping term range (rejects over 10000)', () => {
    render(
      <TapDanceJsonEditor entries={[makeEntry()]} onApply={onApply} onClose={onClose} />,
    )
    const textarea = screen.getByTestId('tap-dance-json-editor-textarea')
    fireEvent.change(textarea, { target: { value: '[["KC_NO","KC_NO","KC_NO","KC_NO",10001]]' } })
    expect(screen.getByTestId('tap-dance-json-editor-error')).toBeInTheDocument()
  })

  it('rejects unknown keycodes like KC_AAAA with specific message', () => {
    render(
      <TapDanceJsonEditor entries={[makeEntry()]} onApply={onApply} onClose={onClose} />,
    )
    const textarea = screen.getByTestId('tap-dance-json-editor-textarea')
    fireEvent.change(textarea, { target: { value: '[["KC_AAAA","KC_NO","KC_NO","KC_NO",150]]' } })
    expect(screen.getByText('Unknown keycode: KC_AAAA')).toBeInTheDocument()
    expect(screen.getByTestId('tap-dance-json-editor-apply')).toBeDisabled()
  })

  it('rejects string tapping term with specific message', () => {
    render(
      <TapDanceJsonEditor entries={[makeEntry()]} onApply={onApply} onClose={onClose} />,
    )
    const textarea = screen.getByTestId('tap-dance-json-editor-textarea')
    fireEvent.change(textarea, { target: { value: '[["KC_NO","KC_NO","KC_NO","KC_NO","150"]]' } })
    expect(screen.getByText('Tapping term must be a number between 0 and 10000')).toBeInTheDocument()
    expect(screen.getByTestId('tap-dance-json-editor-apply')).toBeDisabled()
  })

  it('shows tapping term error for out-of-range number', () => {
    render(
      <TapDanceJsonEditor entries={[makeEntry()]} onApply={onApply} onClose={onClose} />,
    )
    const textarea = screen.getByTestId('tap-dance-json-editor-textarea')
    fireEvent.change(textarea, { target: { value: '[["KC_NO","KC_NO","KC_NO","KC_NO",99999]]' } })
    expect(screen.getByText('Tapping term must be a number between 0 and 10000')).toBeInTheDocument()
  })

  it('shows error without closing when onApply throws', async () => {
    const failingApply = vi.fn().mockRejectedValue(new Error('Device write failed'))
    render(
      <TapDanceJsonEditor entries={[makeEntry()]} onApply={failingApply} onClose={onClose} />,
    )
    fireEvent.click(screen.getByTestId('tap-dance-json-editor-apply'))
    await waitFor(() => expect(screen.getByTestId('tap-dance-json-editor-error')).toBeInTheDocument())
    expect(screen.getByText('Device write failed')).toBeInTheDocument()
    expect(onClose).not.toHaveBeenCalled()
  })
})
