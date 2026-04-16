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
        'common.save': 'Save',
        'common.close': 'Close',
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
  codeToLabel: (code: number) => `KC_${code}`,
  keycodeTooltip: (qmkId: string) => qmkId,
  isResetKeycode: () => false,
  isModifiableKeycode: () => false,
  extractModMask: () => 0,
  extractBasicKey: (code: number) => code & 0xff,
  buildModMaskKeycode: (mask: number, key: number) => (mask << 8) | key,
  findKeycode: (qmkId: string) => ({ qmkId, label: qmkId }),
  isMask: () => false,
  findOuterKeycode: () => undefined,
  findInnerKeycode: () => undefined,
}))

vi.mock('../../keycodes/TabbedKeycodes', () => ({
  TabbedKeycodes: ({ onKeycodeSelect, onConfirm }: { onKeycodeSelect?: (kc: { qmkId: string }) => void; onConfirm?: () => void }) => (
    <div data-testid="tabbed-keycodes">
      <button data-testid="pick-kc-a" onClick={() => onKeycodeSelect?.({ qmkId: 'KC_7' })}>
        KC_A
      </button>
      {onConfirm && <button data-testid="confirm-picker" onClick={onConfirm}>Confirm</button>}
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

  it('shows editor and favorites panel directly', () => {
    render(
      <ComboPanelModal entries={[makeEntry()]} initialIndex={0} onSetEntry={onSetEntry} onClose={onClose} />,
    )
    expect(screen.getByText('Combo - 0')).toBeInTheDocument()
    expect(screen.getAllByTestId('keycode-field')).toHaveLength(5)
    expect(screen.getByTestId('combo-favorites-panel')).toBeInTheDocument()
    expect(screen.getByTestId('favorite-store-content')).toBeInTheDocument()
  })

  it('shows TabbedKeycodes when a keycode field is clicked', () => {
    render(
      <ComboPanelModal entries={[makeEntry()]} initialIndex={0} onSetEntry={onSetEntry} onClose={onClose} />,
    )
    expect(screen.queryByTestId('tabbed-keycodes')).not.toBeInTheDocument()
    fireEvent.click(screen.getAllByTestId('keycode-field')[0])
    act(() => { vi.advanceTimersByTime(300) })
    expect(screen.getByTestId('tabbed-keycodes')).toBeInTheDocument()
  })

  it('Save button is disabled when no changes', () => {
    render(
      <ComboPanelModal entries={[makeEntry()]} initialIndex={0} onSetEntry={onSetEntry} onClose={onClose} />,
    )
    expect(screen.getByTestId('combo-modal-save')).toBeDisabled()
  })

  it('Save button enables after editing key1', () => {
    render(
      <ComboPanelModal entries={[makeEntry()]} initialIndex={0} onSetEntry={onSetEntry} onClose={onClose} />,
    )
    fireEvent.click(screen.getAllByTestId('keycode-field')[0])
    act(() => { vi.advanceTimersByTime(300) })
    fireEvent.click(screen.getByTestId('pick-kc-a'))
    fireEvent.click(screen.getByTestId('confirm-picker'))
    expect(screen.getByTestId('combo-modal-save')).toBeEnabled()
  })

  it('calls onSetEntry and closes modal on Save', async () => {
    render(
      <ComboPanelModal entries={[makeEntry()]} initialIndex={0} onSetEntry={onSetEntry} onClose={onClose} />,
    )
    fireEvent.click(screen.getAllByTestId('keycode-field')[0])
    act(() => { vi.advanceTimersByTime(300) })
    fireEvent.click(screen.getByTestId('pick-kc-a'))
    fireEvent.click(screen.getByTestId('confirm-picker'))
    fireEvent.click(screen.getByTestId('combo-modal-save'))
    vi.useRealTimers()
    await waitFor(() => {
      expect(onSetEntry).toHaveBeenCalledWith(0, expect.objectContaining({ key1: 7 }))
    })
    // After save, modal should close
    expect(onClose).toHaveBeenCalled()
  })

  it('calls onClose when close button is clicked', () => {
    render(
      <ComboPanelModal entries={[makeEntry()]} initialIndex={0} onSetEntry={onSetEntry} onClose={onClose} />,
    )
    fireEvent.click(screen.getByTestId('combo-modal-close'))
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('calls onClose when backdrop is clicked', () => {
    render(
      <ComboPanelModal entries={[makeEntry()]} initialIndex={0} onSetEntry={onSetEntry} onClose={onClose} />,
    )
    fireEvent.click(screen.getByTestId('combo-modal-backdrop'))
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('closes modal on Escape key', () => {
    render(
      <ComboPanelModal entries={[makeEntry()]} initialIndex={0} onSetEntry={onSetEntry} onClose={onClose} />,
    )
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(onClose).toHaveBeenCalled()
  })

  it('hides favorites panel when picker is open', () => {
    render(
      <ComboPanelModal entries={[makeEntry()]} initialIndex={0} onSetEntry={onSetEntry} onClose={onClose} />,
    )
    expect(screen.getByTestId('combo-favorites-panel').className).not.toContain('hidden')
    fireEvent.click(screen.getAllByTestId('keycode-field')[0])
    act(() => { vi.advanceTimersByTime(300) })
    expect(screen.getByTestId('combo-favorites-panel').className).toContain('hidden')
  })
})
