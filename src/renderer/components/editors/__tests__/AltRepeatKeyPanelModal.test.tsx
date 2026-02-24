// SPDX-License-Identifier: GPL-2.0-or-later
// @vitest-environment jsdom

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react'
import { AltRepeatKeyPanelModal } from '../AltRepeatKeyPanelModal'
import type { AltRepeatKeyEntry } from '../../../../shared/types/protocol'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) => {
      const map: Record<string, string> = {
        'editor.altRepeatKey.title': 'Alt Repeat Key',
        'editor.altRepeatKey.lastKey': 'Last Key',
        'editor.altRepeatKey.altKey': 'Alt Key',
        'editor.altRepeatKey.allowedMods': 'Allowed Mods',
        'editor.altRepeatKey.options': 'Options',
        'editor.altRepeatKey.enabled': 'Enabled',
        'editor.altRepeatKey.selectEntry': 'Select an entry to edit',
        'common.noEntries': 'No entries',
        'common.notConfigured': 'N/C',
        'common.save': 'Save',
        'common.close': 'Close',
        'common.back': 'Back',
      }
      if (key === 'editor.altRepeatKey.editTitle') return `Alt Repeat Key - ${opts?.index}`
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
  isMask: () => false,
  findOuterKeycode: () => undefined,
  findInnerKeycode: () => undefined,
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

const makeEntry = (overrides?: Partial<AltRepeatKeyEntry>): AltRepeatKeyEntry => ({
  lastKey: 0,
  altKey: 0,
  allowedMods: 0,
  options: 0,
  enabled: false,
  ...overrides,
})

describe('AltRepeatKeyPanelModal', () => {
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
    render(<AltRepeatKeyPanelModal entries={[]} onSetEntry={onSetEntry} onClose={onClose} />)
    expect(screen.getByText('No entries')).toBeInTheDocument()
  })

  it('renders grid tiles for each entry', () => {
    render(
      <AltRepeatKeyPanelModal entries={[makeEntry(), makeEntry()]} onSetEntry={onSetEntry} onClose={onClose} />,
    )
    expect(screen.getByTestId('ar-tile-0')).toHaveTextContent('0')
    expect(screen.getByTestId('ar-tile-0')).toHaveTextContent('N/C')
    expect(screen.getByTestId('ar-tile-1')).toHaveTextContent('1')
  })

  it('renders configured+enabled tile with active accent style', () => {
    render(
      <AltRepeatKeyPanelModal
        entries={[makeEntry({ lastKey: 4, altKey: 5, enabled: true })]}
        onSetEntry={onSetEntry}
        onClose={onClose}
      />,
    )
    const tile = screen.getByTestId('ar-tile-0')
    expect(tile.className).toContain('border-accent')
    expect(tile.className).toContain('bg-accent/20')
    expect(tile.className).toContain('font-semibold')
  })

  it('renders configured+disabled tile with disabled style', () => {
    render(
      <AltRepeatKeyPanelModal
        entries={[makeEntry({ lastKey: 4, altKey: 5, enabled: false })]}
        onSetEntry={onSetEntry}
        onClose={onClose}
      />,
    )
    const tile = screen.getByTestId('ar-tile-0')
    expect(tile.className).toContain('border-picker-item-border')
  })

  it('renders unconfigured tile with empty style', () => {
    render(<AltRepeatKeyPanelModal entries={[makeEntry()]} onSetEntry={onSetEntry} onClose={onClose} />)
    const tile = screen.getByTestId('ar-tile-0')
    expect(tile.className).toContain('border-accent/30')
    expect(tile.className).toContain('bg-accent/5')
  })

  it('shows tile screen initially with no editor visible', () => {
    render(
      <AltRepeatKeyPanelModal entries={[makeEntry()]} onSetEntry={onSetEntry} onClose={onClose} />,
    )
    expect(screen.getByTestId('ar-tile-0')).toBeInTheDocument()
    expect(screen.queryByText('Alt Repeat Key - 0')).not.toBeInTheDocument()
    expect(screen.queryByTestId('ar-favorites-panel')).not.toBeInTheDocument()
  })

  it('shows editor and favorites panel when tile is clicked', () => {
    render(
      <AltRepeatKeyPanelModal entries={[makeEntry()]} onSetEntry={onSetEntry} onClose={onClose} />,
    )
    fireEvent.click(screen.getByTestId('ar-tile-0'))
    expect(screen.getByText('Alt Repeat Key - 0')).toBeInTheDocument()
    expect(screen.getAllByTestId('keycode-field')).toHaveLength(2)
    expect(screen.getByTestId('ar-favorites-panel')).toBeInTheDocument()
    expect(screen.getByTestId('favorite-store-content')).toBeInTheDocument()
  })

  it('navigates back to tile screen when Back button is clicked', () => {
    render(
      <AltRepeatKeyPanelModal entries={[makeEntry()]} onSetEntry={onSetEntry} onClose={onClose} />,
    )
    fireEvent.click(screen.getByTestId('ar-tile-0'))
    expect(screen.getByText('Alt Repeat Key - 0')).toBeInTheDocument()
    fireEvent.click(screen.getByTestId('ar-back-btn'))
    expect(screen.queryByText('Alt Repeat Key - 0')).not.toBeInTheDocument()
    expect(screen.getByTestId('ar-tile-0')).toBeInTheDocument()
  })

  it('shows enabled checkbox disabled when lastKey is 0', () => {
    render(
      <AltRepeatKeyPanelModal entries={[makeEntry()]} onSetEntry={onSetEntry} onClose={onClose} />,
    )
    fireEvent.click(screen.getByTestId('ar-tile-0'))
    expect(screen.getByTestId('ar-enabled')).toBeDisabled()
  })

  it('shows enabled checkbox enabled when lastKey is nonzero', () => {
    render(
      <AltRepeatKeyPanelModal entries={[makeEntry({ lastKey: 4 })]} onSetEntry={onSetEntry} onClose={onClose} />,
    )
    fireEvent.click(screen.getByTestId('ar-tile-0'))
    expect(screen.getByTestId('ar-enabled')).not.toBeDisabled()
  })

  it('shows TabbedKeycodes when a keycode field is clicked', () => {
    render(
      <AltRepeatKeyPanelModal entries={[makeEntry()]} onSetEntry={onSetEntry} onClose={onClose} />,
    )
    fireEvent.click(screen.getByTestId('ar-tile-0'))
    expect(screen.queryByTestId('tabbed-keycodes')).not.toBeInTheDocument()
    fireEvent.click(screen.getAllByTestId('keycode-field')[0])
    act(() => { vi.advanceTimersByTime(300) })
    expect(screen.getByTestId('tabbed-keycodes')).toBeInTheDocument()
  })

  it('hides advanced fields when picker is open', () => {
    render(
      <AltRepeatKeyPanelModal entries={[makeEntry()]} onSetEntry={onSetEntry} onClose={onClose} />,
    )
    fireEvent.click(screen.getByTestId('ar-tile-0'))
    expect(screen.getByTestId('ar-advanced-fields')).toBeInTheDocument()
    fireEvent.click(screen.getAllByTestId('keycode-field')[0])
    act(() => { vi.advanceTimersByTime(300) })
    expect(screen.queryByTestId('ar-advanced-fields')).not.toBeInTheDocument()
  })

  it('Save button is disabled when no changes', () => {
    render(
      <AltRepeatKeyPanelModal entries={[makeEntry()]} onSetEntry={onSetEntry} onClose={onClose} />,
    )
    fireEvent.click(screen.getByTestId('ar-tile-0'))
    expect(screen.getByTestId('ar-modal-save')).toBeDisabled()
  })

  it('Save button enables after editing lastKey', () => {
    render(
      <AltRepeatKeyPanelModal entries={[makeEntry()]} onSetEntry={onSetEntry} onClose={onClose} />,
    )
    fireEvent.click(screen.getByTestId('ar-tile-0'))
    fireEvent.click(screen.getAllByTestId('keycode-field')[0])
    act(() => { vi.advanceTimersByTime(300) })
    fireEvent.click(screen.getByTestId('pick-kc-a'))
    fireEvent.click(screen.getByTestId('mask-confirm-btn'))
    expect(screen.getByTestId('ar-modal-save')).toBeEnabled()
  })

  it('calls onSetEntry and returns to tile screen on Save', async () => {
    render(
      <AltRepeatKeyPanelModal entries={[makeEntry()]} onSetEntry={onSetEntry} onClose={onClose} />,
    )
    fireEvent.click(screen.getByTestId('ar-tile-0'))
    fireEvent.click(screen.getAllByTestId('keycode-field')[0])
    act(() => { vi.advanceTimersByTime(300) })
    fireEvent.click(screen.getByTestId('pick-kc-a'))
    fireEvent.click(screen.getByTestId('mask-confirm-btn'))
    fireEvent.click(screen.getByTestId('ar-modal-save'))
    vi.useRealTimers()
    await waitFor(() => {
      expect(onSetEntry).toHaveBeenCalledWith(0, expect.objectContaining({ lastKey: 7 }))
    })
    // After save, should return to tile screen
    expect(screen.getByTestId('ar-tile-0')).toBeInTheDocument()
    expect(screen.queryByText('Alt Repeat Key - 0')).not.toBeInTheDocument()
  })

  it('calls onClose when close button is clicked', () => {
    render(
      <AltRepeatKeyPanelModal entries={[makeEntry()]} onSetEntry={onSetEntry} onClose={onClose} />,
    )
    fireEvent.click(screen.getByTestId('ar-modal-close'))
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('calls onClose when backdrop is clicked', () => {
    render(
      <AltRepeatKeyPanelModal entries={[makeEntry()]} onSetEntry={onSetEntry} onClose={onClose} />,
    )
    fireEvent.click(screen.getByTestId('ar-modal-backdrop'))
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('does not close modal on Escape key', () => {
    render(
      <AltRepeatKeyPanelModal entries={[makeEntry()]} onSetEntry={onSetEntry} onClose={onClose} />,
    )
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(onClose).not.toHaveBeenCalled()
  })

  it('returns to tile screen when entries shrink and selected index is out of bounds', () => {
    const { rerender } = render(
      <AltRepeatKeyPanelModal entries={[makeEntry(), makeEntry()]} onSetEntry={onSetEntry} onClose={onClose} />,
    )
    fireEvent.click(screen.getByTestId('ar-tile-1'))
    expect(screen.getByText('Alt Repeat Key - 1')).toBeInTheDocument()
    // Rerender with fewer entries — selected index 1 no longer exists
    rerender(<AltRepeatKeyPanelModal entries={[makeEntry()]} onSetEntry={onSetEntry} onClose={onClose} />)
    expect(screen.queryByText('Alt Repeat Key - 1')).not.toBeInTheDocument()
    expect(screen.getByTestId('ar-tile-0')).toBeInTheDocument()
  })

  it('shows close button in editor view when picker is closed', () => {
    render(
      <AltRepeatKeyPanelModal entries={[makeEntry()]} onSetEntry={onSetEntry} onClose={onClose} />,
    )
    fireEvent.click(screen.getByTestId('ar-tile-0'))
    expect(screen.getByTestId('ar-modal-close')).toBeInTheDocument()
    fireEvent.click(screen.getByTestId('ar-modal-close'))
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('hides favorites panel when picker is open', () => {
    render(
      <AltRepeatKeyPanelModal entries={[makeEntry()]} onSetEntry={onSetEntry} onClose={onClose} />,
    )
    fireEvent.click(screen.getByTestId('ar-tile-0'))
    expect(screen.getByTestId('ar-favorites-panel').className).not.toContain('hidden')
    fireEvent.click(screen.getAllByTestId('keycode-field')[0])
    act(() => { vi.advanceTimersByTime(300) })
    expect(screen.getByTestId('ar-favorites-panel').className).toContain('hidden')
  })
})
