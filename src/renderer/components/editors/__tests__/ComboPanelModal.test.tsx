// SPDX-License-Identifier: GPL-2.0-or-later
// @vitest-environment jsdom

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react'
import { ComboPanelModal } from '../ComboPanelModal'
import type { ComboEntry } from '../../../../shared/types/protocol'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) => {
      const map: Record<string, string> = {
        'editor.combo.title': 'Combo',
        'editor.combo.output': 'Output',
        'editor.combo.timeout': 'Timeout (ms)',
        'editor.combo.selectEntry': 'Select an entry to edit',
        'common.noEntries': 'No entries',
        'common.notConfigured': 'N/C',
        'common.save': 'Save',
        'common.close': 'Close',
        'common.back': 'Back',
      }
      if (key === 'editor.combo.key') return `Key ${opts?.number}`
      if (key === 'editor.combo.editTitle') return `Combo - ${opts?.index}`
      return map[key] ?? key
    },
  }),
}))

vi.mock('../../../../shared/keycodes/keycodes', () => ({
  serialize: (code: number) => `KC_${code}`,
  deserialize: (val: string) => Number(val.replace('KC_', '')),
  keycodeLabel: (qmkId: string) => qmkId,
  keycodeTooltip: (qmkId: string) => qmkId,
  isResetKeycode: () => false,
  isModifiableKeycode: () => false,
  extractModMask: () => 0,
  extractBasicKey: (code: number) => code & 0xff,
  buildModMaskKeycode: (mask: number, key: number) => (mask << 8) | key,
}))

vi.mock('../../keycodes/TabbedKeycodes', () => ({
  TabbedKeycodes: ({ onKeycodeSelect }: { onKeycodeSelect?: (kc: { qmkId: string }) => void }) => (
    <div data-testid="tabbed-keycodes">
      <button data-testid="pick-kc-a" onClick={() => onKeycodeSelect?.({ qmkId: 'KC_7' })}>
        KC_A
      </button>
    </div>
  ),
}))

vi.mock('../FavoriteStoreContent', () => ({
  FavoriteStoreContent: () => <div data-testid="favorite-store-content" />,
}))

const makeEntry = (overrides?: Partial<ComboEntry>): ComboEntry => ({
  key1: 0,
  key2: 0,
  key3: 0,
  key4: 0,
  output: 0,
  ...overrides,
})

describe('ComboPanelModal', () => {
  const onSetEntry = vi.fn().mockResolvedValue(undefined)
  const onClose = vi.fn()

  beforeEach(() => {
    vi.clearAllMocks()
    vi.useFakeTimers()
    window.vialAPI = {
      ...window.vialAPI,
      favoriteStoreList: vi.fn().mockResolvedValue([]),
    } as unknown as typeof window.vialAPI
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('renders no entries message when empty', () => {
    render(<ComboPanelModal entries={[]} onSetEntry={onSetEntry} onClose={onClose} />)
    expect(screen.getByText('No entries')).toBeInTheDocument()
  })

  it('renders grid tiles for each entry', () => {
    render(
      <ComboPanelModal entries={[makeEntry(), makeEntry()]} onSetEntry={onSetEntry} onClose={onClose} />,
    )
    expect(screen.getByTestId('combo-tile-0')).toHaveTextContent('0')
    expect(screen.getByTestId('combo-tile-0')).toHaveTextContent('N/C')
    expect(screen.getByTestId('combo-tile-1')).toHaveTextContent('1')
  })

  it('renders configured tile with combo key labels', () => {
    render(
      <ComboPanelModal
        entries={[makeEntry({ key1: 4, key2: 5, output: 6 })]}
        onSetEntry={onSetEntry}
        onClose={onClose}
      />,
    )
    const tile = screen.getByTestId('combo-tile-0')
    expect(tile).toHaveTextContent('KC_4 KC_5')
    expect(tile).toHaveTextContent('KC_6')
  })

  it('renders unconfigured tile with muted accent color', () => {
    render(<ComboPanelModal entries={[makeEntry()]} onSetEntry={onSetEntry} onClose={onClose} />)
    const tile = screen.getByTestId('combo-tile-0')
    expect(tile.className).toContain('border-accent/30')
    expect(tile.className).toContain('bg-accent/5')
  })

  it('renders configured tile with accent color', () => {
    render(
      <ComboPanelModal
        entries={[makeEntry({ key1: 4 })]}
        onSetEntry={onSetEntry}
        onClose={onClose}
      />,
    )
    const tile = screen.getByTestId('combo-tile-0')
    expect(tile.className).toContain('border-accent')
    expect(tile.className).toContain('bg-accent/20')
    expect(tile.className).toContain('font-semibold')
  })

  it('shows tile screen initially with no editor visible', () => {
    render(
      <ComboPanelModal entries={[makeEntry()]} onSetEntry={onSetEntry} onClose={onClose} />,
    )
    expect(screen.getByTestId('combo-tile-0')).toBeInTheDocument()
    expect(screen.queryByText('Combo - 0')).not.toBeInTheDocument()
    expect(screen.queryByTestId('combo-favorites-panel')).not.toBeInTheDocument()
  })

  it('shows editor and favorites panel when tile is clicked', () => {
    render(
      <ComboPanelModal entries={[makeEntry()]} onSetEntry={onSetEntry} onClose={onClose} />,
    )
    fireEvent.click(screen.getByTestId('combo-tile-0'))
    expect(screen.getByText('Combo - 0')).toBeInTheDocument()
    expect(screen.getAllByTestId('keycode-field')).toHaveLength(5)
    expect(screen.getByTestId('combo-favorites-panel')).toBeInTheDocument()
    expect(screen.getByTestId('favorite-store-content')).toBeInTheDocument()
  })

  it('navigates back to tile screen when Back button is clicked', () => {
    render(
      <ComboPanelModal entries={[makeEntry()]} onSetEntry={onSetEntry} onClose={onClose} />,
    )
    fireEvent.click(screen.getByTestId('combo-tile-0'))
    expect(screen.getByText('Combo - 0')).toBeInTheDocument()
    fireEvent.click(screen.getByTestId('combo-back-btn'))
    expect(screen.queryByText('Combo - 0')).not.toBeInTheDocument()
    expect(screen.getByTestId('combo-tile-0')).toBeInTheDocument()
  })

  it('shows TabbedKeycodes when a keycode field is clicked', () => {
    render(
      <ComboPanelModal entries={[makeEntry()]} onSetEntry={onSetEntry} onClose={onClose} />,
    )
    fireEvent.click(screen.getByTestId('combo-tile-0'))
    expect(screen.queryByTestId('tabbed-keycodes')).not.toBeInTheDocument()
    fireEvent.click(screen.getAllByTestId('keycode-field')[0])
    act(() => { vi.advanceTimersByTime(300) })
    expect(screen.getByTestId('tabbed-keycodes')).toBeInTheDocument()
  })

  it('Save button is disabled when no changes', () => {
    render(
      <ComboPanelModal entries={[makeEntry()]} onSetEntry={onSetEntry} onClose={onClose} />,
    )
    fireEvent.click(screen.getByTestId('combo-tile-0'))
    expect(screen.getByTestId('combo-modal-save')).toBeDisabled()
  })

  it('Save button enables after editing key1', () => {
    render(
      <ComboPanelModal entries={[makeEntry()]} onSetEntry={onSetEntry} onClose={onClose} />,
    )
    fireEvent.click(screen.getByTestId('combo-tile-0'))
    fireEvent.click(screen.getAllByTestId('keycode-field')[0])
    act(() => { vi.advanceTimersByTime(300) })
    fireEvent.click(screen.getByTestId('pick-kc-a'))
    expect(screen.getByTestId('combo-modal-save')).toBeEnabled()
  })

  it('calls onSetEntry and returns to tile screen on Save', async () => {
    render(
      <ComboPanelModal entries={[makeEntry()]} onSetEntry={onSetEntry} onClose={onClose} />,
    )
    fireEvent.click(screen.getByTestId('combo-tile-0'))
    fireEvent.click(screen.getAllByTestId('keycode-field')[0])
    act(() => { vi.advanceTimersByTime(300) })
    fireEvent.click(screen.getByTestId('pick-kc-a'))
    fireEvent.click(screen.getByTestId('combo-modal-save'))
    vi.useRealTimers()
    await waitFor(() => {
      expect(onSetEntry).toHaveBeenCalledWith(0, expect.objectContaining({ key1: 7 }))
    })
    // After save, should return to tile screen
    expect(screen.getByTestId('combo-tile-0')).toBeInTheDocument()
    expect(screen.queryByText('Combo - 0')).not.toBeInTheDocument()
  })

  it('calls onClose when close button is clicked', () => {
    render(
      <ComboPanelModal entries={[makeEntry()]} onSetEntry={onSetEntry} onClose={onClose} />,
    )
    fireEvent.click(screen.getByTestId('combo-modal-close'))
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('calls onClose when backdrop is clicked', () => {
    render(
      <ComboPanelModal entries={[makeEntry()]} onSetEntry={onSetEntry} onClose={onClose} />,
    )
    fireEvent.click(screen.getByTestId('combo-modal-backdrop'))
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('does not close modal on Escape key', () => {
    render(
      <ComboPanelModal entries={[makeEntry()]} onSetEntry={onSetEntry} onClose={onClose} />,
    )
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(onClose).not.toHaveBeenCalled()
  })

  it('returns to tile screen when entries shrink and selected index is out of bounds', () => {
    const { rerender } = render(
      <ComboPanelModal entries={[makeEntry(), makeEntry()]} onSetEntry={onSetEntry} onClose={onClose} />,
    )
    fireEvent.click(screen.getByTestId('combo-tile-1'))
    expect(screen.getByText('Combo - 1')).toBeInTheDocument()
    // Rerender with fewer entries — selected index 1 no longer exists
    rerender(<ComboPanelModal entries={[makeEntry()]} onSetEntry={onSetEntry} onClose={onClose} />)
    expect(screen.queryByText('Combo - 1')).not.toBeInTheDocument()
    expect(screen.getByTestId('combo-tile-0')).toBeInTheDocument()
  })

  it('shows close button in editor view when picker is closed', () => {
    render(
      <ComboPanelModal entries={[makeEntry()]} onSetEntry={onSetEntry} onClose={onClose} />,
    )
    fireEvent.click(screen.getByTestId('combo-tile-0'))
    expect(screen.getByTestId('combo-modal-close')).toBeInTheDocument()
    fireEvent.click(screen.getByTestId('combo-modal-close'))
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('hides favorites panel when picker is open', () => {
    render(
      <ComboPanelModal entries={[makeEntry()]} onSetEntry={onSetEntry} onClose={onClose} />,
    )
    fireEvent.click(screen.getByTestId('combo-tile-0'))
    expect(screen.getByTestId('combo-favorites-panel').className).not.toContain('hidden')
    fireEvent.click(screen.getAllByTestId('keycode-field')[0])
    act(() => { vi.advanceTimersByTime(300) })
    expect(screen.getByTestId('combo-favorites-panel').className).toContain('hidden')
  })
})
