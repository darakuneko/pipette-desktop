// SPDX-License-Identifier: GPL-2.0-or-later
// @vitest-environment jsdom

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { TapDanceModal } from '../TapDanceModal'
import type { TapDanceEntry } from '../../../../shared/types/protocol'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) => {
      const map: Record<string, string> = {
        'editor.tapDance.onTap': 'On Tap',
        'editor.tapDance.onHold': 'On Hold',
        'editor.tapDance.onDoubleTap': 'On Double Tap',
        'editor.tapDance.onTapHold': 'On Tap Hold',
        'editor.tapDance.tappingTerm': 'Tapping Term (ms)',
        'common.save': 'Save',
        'common.close': 'Close',
      }
      if (key === 'editor.tapDance.editTitle') return `TD(${opts?.index})`
      return map[key] ?? key
    },
  }),
}))

vi.mock('../../../../shared/keycodes/keycodes', () => ({
  serialize: (code: number) => `KC_${code}`,
  deserialize: (val: string) => Number(val.replace('KC_', '')),
  keycodeLabel: (qmkId: string) => qmkId,
  keycodeTooltip: (qmkId: string) => qmkId,
}))

vi.mock('../../keycodes/TabbedKeycodes', () => ({
  TabbedKeycodes: ({ onKeycodeSelect, onClose }: { onKeycodeSelect?: (kc: { qmkId: string }) => void; onClose?: () => void }) => (
    <div data-testid="tabbed-keycodes">
      <button data-testid="pick-kc-a" onClick={() => onKeycodeSelect?.({ qmkId: 'KC_4' })}>
        KC_A
      </button>
      {onClose && (
        <button data-testid="tabbed-keycodes-close" onClick={onClose}>Close</button>
      )}
    </div>
  ),
}))

vi.mock('../../keycodes/KeyPopover', () => ({
  KeyPopover: ({
    onKeycodeSelect,
    onRawKeycodeSelect,
    onClose,
  }: {
    anchorRect: DOMRect
    currentKeycode: number
    onKeycodeSelect: (kc: { qmkId: string }) => void
    onRawKeycodeSelect: (code: number) => void
    onClose: () => void
  }) => (
    <div data-testid="key-popover">
      <button data-testid="popover-pick-kc" onClick={() => onKeycodeSelect({ qmkId: 'KC_5' })}>
        Pick
      </button>
      <button data-testid="popover-pick-raw" onClick={() => onRawKeycodeSelect(6)}>
        Raw
      </button>
      <button data-testid="popover-close" onClick={onClose}>
        Close
      </button>
    </div>
  ),
}))

const makeEntry = (overrides?: Partial<TapDanceEntry>): TapDanceEntry => ({
  onTap: 0,
  onHold: 0,
  onDoubleTap: 0,
  onTapHold: 0,
  tappingTerm: 200,
  ...overrides,
})

describe('TapDanceModal', () => {
  const onSave = vi.fn().mockResolvedValue(undefined)
  const onClose = vi.fn()

  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('renders modal with title showing TD index', () => {
    render(
      <TapDanceModal index={3} entry={makeEntry()} onSave={onSave} onClose={onClose} />,
    )
    expect(screen.getByText('TD(3)')).toBeInTheDocument()
  })

  it('renders 4 keycode fields', () => {
    render(
      <TapDanceModal index={0} entry={makeEntry()} onSave={onSave} onClose={onClose} />,
    )
    const fields = screen.getAllByTestId('keycode-field')
    expect(fields).toHaveLength(4)
  })

  it('renders tapping term input', () => {
    render(
      <TapDanceModal
        index={0}
        entry={makeEntry({ tappingTerm: 300 })}
        onSave={onSave}
        onClose={onClose}
      />,
    )
    const input = screen.getByDisplayValue('300') as HTMLInputElement
    expect(input.type).toBe('number')
  })

  it('shows TabbedKeycodes when a field is clicked', () => {
    render(
      <TapDanceModal index={0} entry={makeEntry()} onSave={onSave} onClose={onClose} />,
    )
    expect(screen.queryByTestId('tabbed-keycodes')).not.toBeInTheDocument()
    fireEvent.click(screen.getAllByTestId('keycode-field')[0])
    expect(screen.getByTestId('tabbed-keycodes')).toBeInTheDocument()
  })

  it('Save button is disabled when no changes', () => {
    render(
      <TapDanceModal index={0} entry={makeEntry()} onSave={onSave} onClose={onClose} />,
    )
    expect(screen.getByTestId('td-modal-save')).toBeDisabled()
  })

  it('Save button enables after editing', () => {
    render(
      <TapDanceModal index={0} entry={makeEntry()} onSave={onSave} onClose={onClose} />,
    )
    fireEvent.click(screen.getAllByTestId('keycode-field')[0])
    fireEvent.click(screen.getByTestId('pick-kc-a'))
    expect(screen.getByTestId('td-modal-save')).toBeEnabled()
  })

  it('calls onSave with edited entry', async () => {
    render(
      <TapDanceModal index={2} entry={makeEntry()} onSave={onSave} onClose={onClose} />,
    )
    // Edit onTap
    fireEvent.click(screen.getAllByTestId('keycode-field')[0])
    fireEvent.click(screen.getByTestId('pick-kc-a'))
    // Save
    fireEvent.click(screen.getByTestId('td-modal-save'))
    expect(onSave).toHaveBeenCalledWith(2, expect.objectContaining({ onTap: 4 }))
  })

  it('calls onClose when close icon is clicked', () => {
    render(
      <TapDanceModal index={0} entry={makeEntry()} onSave={onSave} onClose={onClose} />,
    )
    fireEvent.click(screen.getByTestId('td-modal-close'))
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('calls onClose when backdrop is clicked', () => {
    render(
      <TapDanceModal index={0} entry={makeEntry()} onSave={onSave} onClose={onClose} />,
    )
    fireEvent.click(screen.getByTestId('td-modal-backdrop'))
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('does not close when modal content is clicked', () => {
    render(
      <TapDanceModal index={0} entry={makeEntry()} onSave={onSave} onClose={onClose} />,
    )
    fireEvent.click(screen.getByTestId('td-modal'))
    expect(onClose).not.toHaveBeenCalled()
  })

  it('calls onClose when Escape is pressed', () => {
    render(
      <TapDanceModal index={0} entry={makeEntry()} onSave={onSave} onClose={onClose} />,
    )
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('updates tapping term locally', () => {
    render(
      <TapDanceModal
        index={0}
        entry={makeEntry({ tappingTerm: 200 })}
        onSave={onSave}
        onClose={onClose}
      />,
    )
    const input = screen.getByDisplayValue('200')
    fireEvent.change(input, { target: { value: '500' } })
    expect(screen.getByDisplayValue('500')).toBeInTheDocument()
    expect(screen.getByTestId('td-modal-save')).toBeEnabled()
  })

  it('hides non-selected fields when picker is open', () => {
    render(
      <TapDanceModal index={0} entry={makeEntry()} onSave={onSave} onClose={onClose} />,
    )
    expect(screen.getAllByTestId('keycode-field')).toHaveLength(4)
    fireEvent.click(screen.getAllByTestId('keycode-field')[0])
    expect(screen.getAllByTestId('keycode-field')).toHaveLength(1)
  })

  it('hides modal close button and shows picker close button when picker is open', () => {
    render(
      <TapDanceModal index={0} entry={makeEntry()} onSave={onSave} onClose={onClose} />,
    )
    expect(screen.getByTestId('td-modal-close')).toBeInTheDocument()
    expect(screen.queryByTestId('tabbed-keycodes-close')).not.toBeInTheDocument()
    fireEvent.click(screen.getAllByTestId('keycode-field')[0])
    expect(screen.queryByTestId('td-modal-close')).not.toBeInTheDocument()
    expect(screen.getByTestId('tabbed-keycodes-close')).toBeInTheDocument()
  })

  it('hides save button and tapping term when picker is open', () => {
    render(
      <TapDanceModal index={0} entry={makeEntry()} onSave={onSave} onClose={onClose} />,
    )
    expect(screen.getByTestId('td-modal-save')).toBeInTheDocument()
    expect(screen.getByDisplayValue('200')).toBeInTheDocument()
    fireEvent.click(screen.getAllByTestId('keycode-field')[0])
    expect(screen.queryByTestId('td-modal-save')).not.toBeInTheDocument()
    expect(screen.queryByDisplayValue('200')).not.toBeInTheDocument()
  })

  it('closes picker via X button and restores all fields', () => {
    render(
      <TapDanceModal index={0} entry={makeEntry()} onSave={onSave} onClose={onClose} />,
    )
    fireEvent.click(screen.getAllByTestId('keycode-field')[0])
    expect(screen.getAllByTestId('keycode-field')).toHaveLength(1)
    fireEvent.click(screen.getByTestId('tabbed-keycodes-close'))
    expect(screen.getAllByTestId('keycode-field')).toHaveLength(4)
    expect(screen.queryByTestId('tabbed-keycodes')).not.toBeInTheDocument()
  })

  it('renders fav button when isDummy is false', () => {
    render(
      <TapDanceModal index={0} entry={makeEntry()} onSave={onSave} onClose={onClose} isDummy={false} />,
    )
    expect(screen.getByTestId('td-fav-btn')).toBeInTheDocument()
  })

  it('hides fav button when isDummy is true', () => {
    render(
      <TapDanceModal index={0} entry={makeEntry()} onSave={onSave} onClose={onClose} isDummy={true} />,
    )
    expect(screen.queryByTestId('td-fav-btn')).not.toBeInTheDocument()
  })

  it('uses guard-based selection (clicking another field while picker closed selects it)', () => {
    render(
      <TapDanceModal index={0} entry={makeEntry()} onSave={onSave} onClose={onClose} />,
    )
    // Select first field
    fireEvent.click(screen.getAllByTestId('keycode-field')[0])
    expect(screen.getAllByTestId('keycode-field')).toHaveLength(1)
    // Close picker
    fireEvent.click(screen.getByTestId('tabbed-keycodes-close'))
    // Select second field
    fireEvent.click(screen.getAllByTestId('keycode-field')[1])
    expect(screen.getAllByTestId('keycode-field')).toHaveLength(1)
    expect(screen.getByText('On Hold')).toBeInTheDocument()
  })
})
