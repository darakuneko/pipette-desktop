// SPDX-License-Identifier: GPL-2.0-or-later
// @vitest-environment jsdom

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react'
import { KeyOverridePanelModal } from '../KeyOverridePanelModal'
import type { KeyOverrideEntry } from '../../../../shared/types/protocol'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) => {
      const map: Record<string, string> = {
        'editor.keyOverride.title': 'Key Override',
        'editor.keyOverride.triggerKey': 'Trigger Key',
        'editor.keyOverride.replacementKey': 'Replacement Key',
        'editor.keyOverride.layers': 'Layers',
        'editor.keyOverride.triggerMods': 'Trigger Mods',
        'editor.keyOverride.negativeMods': 'Negative Mods',
        'editor.keyOverride.suppressedMods': 'Suppressed Mods',
        'editor.keyOverride.options': 'Options',
        'editor.keyOverride.enabled': 'Enabled',
        'common.save': 'Save',
        'common.close': 'Close',
      }
      if (key === 'editor.keyOverride.editTitle') return `Key Override - ${opts?.index}`
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

const makeEntry = (overrides?: Partial<KeyOverrideEntry>): KeyOverrideEntry => ({
  triggerKey: 0,
  replacementKey: 0,
  layers: 0xFFFF,
  triggerMods: 0,
  negativeMods: 0,
  suppressedMods: 0,
  options: 0,
  enabled: false,
  ...overrides,
})

describe('KeyOverridePanelModal', () => {
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
      <KeyOverridePanelModal entries={[makeEntry()]} initialIndex={0} onSetEntry={onSetEntry} onClose={onClose} />,
    )
    expect(screen.getByText('Key Override - 0')).toBeInTheDocument()
    expect(screen.getAllByTestId('keycode-field')).toHaveLength(2)
    expect(screen.getByTestId('ko-favorites-panel')).toBeInTheDocument()
    expect(screen.getByTestId('favorite-store-content')).toBeInTheDocument()
  })

  it('shows enabled checkbox disabled when triggerKey and triggerMods are 0', () => {
    render(
      <KeyOverridePanelModal entries={[makeEntry()]} initialIndex={0} onSetEntry={onSetEntry} onClose={onClose} />,
    )
    expect(screen.getByTestId('ko-enabled')).toBeDisabled()
  })

  it('shows enabled checkbox enabled when triggerKey is nonzero', () => {
    render(
      <KeyOverridePanelModal entries={[makeEntry({ triggerKey: 4 })]} initialIndex={0} onSetEntry={onSetEntry} onClose={onClose} />,
    )
    expect(screen.getByTestId('ko-enabled')).not.toBeDisabled()
  })

  it('shows TabbedKeycodes when a keycode field is clicked', () => {
    render(
      <KeyOverridePanelModal entries={[makeEntry()]} initialIndex={0} onSetEntry={onSetEntry} onClose={onClose} />,
    )
    expect(screen.queryByTestId('tabbed-keycodes')).not.toBeInTheDocument()
    fireEvent.click(screen.getAllByTestId('keycode-field')[0])
    act(() => { vi.advanceTimersByTime(300) })
    expect(screen.getByTestId('tabbed-keycodes')).toBeInTheDocument()
  })

  it('hides advanced fields when picker is open', () => {
    render(
      <KeyOverridePanelModal entries={[makeEntry()]} initialIndex={0} onSetEntry={onSetEntry} onClose={onClose} />,
    )
    expect(screen.getByTestId('ko-advanced-fields')).toBeInTheDocument()
    fireEvent.click(screen.getAllByTestId('keycode-field')[0])
    act(() => { vi.advanceTimersByTime(300) })
    expect(screen.queryByTestId('ko-advanced-fields')).not.toBeInTheDocument()
  })

  it('Save button is disabled when no changes', () => {
    render(
      <KeyOverridePanelModal entries={[makeEntry()]} initialIndex={0} onSetEntry={onSetEntry} onClose={onClose} />,
    )
    expect(screen.getByTestId('ko-modal-save')).toBeDisabled()
  })

  it('Save button enables after editing triggerKey', () => {
    render(
      <KeyOverridePanelModal entries={[makeEntry()]} initialIndex={0} onSetEntry={onSetEntry} onClose={onClose} />,
    )
    fireEvent.click(screen.getAllByTestId('keycode-field')[0])
    act(() => { vi.advanceTimersByTime(300) })
    fireEvent.click(screen.getByTestId('pick-kc-a'))
    fireEvent.click(screen.getByTestId('confirm-picker'))
    expect(screen.getByTestId('ko-modal-save')).toBeEnabled()
  })

  it('calls onSetEntry and closes modal on Save', async () => {
    render(
      <KeyOverridePanelModal entries={[makeEntry()]} initialIndex={0} onSetEntry={onSetEntry} onClose={onClose} />,
    )
    fireEvent.click(screen.getAllByTestId('keycode-field')[0])
    act(() => { vi.advanceTimersByTime(300) })
    fireEvent.click(screen.getByTestId('pick-kc-a'))
    fireEvent.click(screen.getByTestId('confirm-picker'))
    fireEvent.click(screen.getByTestId('ko-modal-save'))
    vi.useRealTimers()
    await waitFor(() => {
      expect(onSetEntry).toHaveBeenCalledWith(0, expect.objectContaining({ triggerKey: 7 }))
    })
    expect(onClose).toHaveBeenCalled()
  })

  it('calls onClose when close button is clicked', () => {
    render(
      <KeyOverridePanelModal entries={[makeEntry()]} initialIndex={0} onSetEntry={onSetEntry} onClose={onClose} />,
    )
    fireEvent.click(screen.getByTestId('ko-modal-close'))
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('calls onClose when backdrop is clicked', () => {
    render(
      <KeyOverridePanelModal entries={[makeEntry()]} initialIndex={0} onSetEntry={onSetEntry} onClose={onClose} />,
    )
    fireEvent.click(screen.getByTestId('ko-modal-backdrop'))
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('closes modal on Escape key', () => {
    render(
      <KeyOverridePanelModal entries={[makeEntry()]} initialIndex={0} onSetEntry={onSetEntry} onClose={onClose} />,
    )
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(onClose).toHaveBeenCalled()
  })

  it('hides favorites panel when picker is open', () => {
    render(
      <KeyOverridePanelModal entries={[makeEntry()]} initialIndex={0} onSetEntry={onSetEntry} onClose={onClose} />,
    )
    expect(screen.getByTestId('ko-favorites-panel').className).not.toContain('hidden')
    fireEvent.click(screen.getAllByTestId('keycode-field')[0])
    act(() => { vi.advanceTimersByTime(300) })
    expect(screen.getByTestId('ko-favorites-panel').className).toContain('hidden')
  })
})
