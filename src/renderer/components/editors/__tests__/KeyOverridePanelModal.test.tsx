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
        'editor.keyOverride.modsOnly': 'Mods',
        'editor.keyOverride.selectEntry': 'Select an entry to edit',
        'common.noEntries': 'No entries',
        'common.notConfigured': 'N/C',
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
  keycodeTooltip: (qmkId: string) => qmkId,
  isResetKeycode: () => false,
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
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('renders no entries message when empty', () => {
    render(<KeyOverridePanelModal entries={[]} onSetEntry={onSetEntry} onClose={onClose} />)
    expect(screen.getByText('No entries')).toBeInTheDocument()
  })

  it('renders grid tiles for each entry', () => {
    render(
      <KeyOverridePanelModal entries={[makeEntry(), makeEntry()]} onSetEntry={onSetEntry} onClose={onClose} />,
    )
    expect(screen.getByTestId('ko-tile-0')).toHaveTextContent('0')
    expect(screen.getByTestId('ko-tile-0')).toHaveTextContent('N/C')
    expect(screen.getByTestId('ko-tile-1')).toHaveTextContent('1')
  })

  it('renders configured+enabled tile with active accent style', () => {
    render(
      <KeyOverridePanelModal
        entries={[makeEntry({ triggerKey: 4, replacementKey: 5, enabled: true })]}
        onSetEntry={onSetEntry}
        onClose={onClose}
      />,
    )
    const tile = screen.getByTestId('ko-tile-0')
    expect(tile.className).toContain('border-accent')
    expect(tile.className).toContain('bg-accent/20')
    expect(tile.className).toContain('font-semibold')
  })

  it('renders configured+disabled tile with disabled style', () => {
    render(
      <KeyOverridePanelModal
        entries={[makeEntry({ triggerKey: 4, replacementKey: 5, enabled: false })]}
        onSetEntry={onSetEntry}
        onClose={onClose}
      />,
    )
    const tile = screen.getByTestId('ko-tile-0')
    expect(tile.className).toContain('border-picker-item-border')
  })

  it('renders unconfigured tile with empty style', () => {
    render(<KeyOverridePanelModal entries={[makeEntry()]} onSetEntry={onSetEntry} onClose={onClose} />)
    const tile = screen.getByTestId('ko-tile-0')
    expect(tile.className).toContain('border-accent/30')
    expect(tile.className).toContain('bg-accent/5')
  })

  it('shows placeholder text when no tile is selected', () => {
    render(
      <KeyOverridePanelModal entries={[makeEntry()]} onSetEntry={onSetEntry} onClose={onClose} />,
    )
    expect(screen.getByText('Select an entry to edit')).toBeInTheDocument()
  })

  it('shows detail editor when tile is clicked', () => {
    render(
      <KeyOverridePanelModal entries={[makeEntry()]} onSetEntry={onSetEntry} onClose={onClose} />,
    )
    fireEvent.click(screen.getByTestId('ko-tile-0'))
    expect(screen.getByText('Key Override - 0')).toBeInTheDocument()
    expect(screen.getAllByTestId('keycode-field')).toHaveLength(2)
  })

  it('highlights selected tile with ring', () => {
    render(
      <KeyOverridePanelModal entries={[makeEntry(), makeEntry()]} onSetEntry={onSetEntry} onClose={onClose} />,
    )
    fireEvent.click(screen.getByTestId('ko-tile-0'))
    expect(screen.getByTestId('ko-tile-0').className).toContain('ring-2')
    expect(screen.getByTestId('ko-tile-1').className).not.toContain('ring-2')
  })

  it('shows enabled checkbox disabled when triggerKey and triggerMods are 0', () => {
    render(
      <KeyOverridePanelModal entries={[makeEntry()]} onSetEntry={onSetEntry} onClose={onClose} />,
    )
    fireEvent.click(screen.getByTestId('ko-tile-0'))
    expect(screen.getByTestId('ko-enabled')).toBeDisabled()
  })

  it('shows enabled checkbox enabled when triggerKey is nonzero', () => {
    render(
      <KeyOverridePanelModal entries={[makeEntry({ triggerKey: 4 })]} onSetEntry={onSetEntry} onClose={onClose} />,
    )
    fireEvent.click(screen.getByTestId('ko-tile-0'))
    expect(screen.getByTestId('ko-enabled')).not.toBeDisabled()
  })

  it('shows TabbedKeycodes when a keycode field is clicked', () => {
    render(
      <KeyOverridePanelModal entries={[makeEntry()]} onSetEntry={onSetEntry} onClose={onClose} />,
    )
    fireEvent.click(screen.getByTestId('ko-tile-0'))
    expect(screen.queryByTestId('tabbed-keycodes')).not.toBeInTheDocument()
    fireEvent.click(screen.getAllByTestId('keycode-field')[0])
    act(() => { vi.advanceTimersByTime(300) })
    expect(screen.getByTestId('tabbed-keycodes')).toBeInTheDocument()
  })

  it('hides advanced fields when picker is open', () => {
    render(
      <KeyOverridePanelModal entries={[makeEntry()]} onSetEntry={onSetEntry} onClose={onClose} />,
    )
    fireEvent.click(screen.getByTestId('ko-tile-0'))
    expect(screen.getByTestId('ko-advanced-fields')).toBeInTheDocument()
    fireEvent.click(screen.getAllByTestId('keycode-field')[0])
    act(() => { vi.advanceTimersByTime(300) })
    expect(screen.queryByTestId('ko-advanced-fields')).not.toBeInTheDocument()
  })

  it('Save button is disabled when no changes', () => {
    render(
      <KeyOverridePanelModal entries={[makeEntry()]} onSetEntry={onSetEntry} onClose={onClose} />,
    )
    fireEvent.click(screen.getByTestId('ko-tile-0'))
    expect(screen.getByTestId('ko-modal-save')).toBeDisabled()
  })

  it('Save button enables after editing triggerKey', () => {
    render(
      <KeyOverridePanelModal entries={[makeEntry()]} onSetEntry={onSetEntry} onClose={onClose} />,
    )
    fireEvent.click(screen.getByTestId('ko-tile-0'))
    fireEvent.click(screen.getAllByTestId('keycode-field')[0])
    act(() => { vi.advanceTimersByTime(300) })
    fireEvent.click(screen.getByTestId('pick-kc-a'))
    expect(screen.getByTestId('ko-modal-save')).toBeEnabled()
  })

  it('calls onSetEntry with edited entry on Save', async () => {
    render(
      <KeyOverridePanelModal entries={[makeEntry()]} onSetEntry={onSetEntry} onClose={onClose} />,
    )
    fireEvent.click(screen.getByTestId('ko-tile-0'))
    fireEvent.click(screen.getAllByTestId('keycode-field')[0])
    act(() => { vi.advanceTimersByTime(300) })
    fireEvent.click(screen.getByTestId('pick-kc-a'))
    fireEvent.click(screen.getByTestId('ko-modal-save'))
    vi.useRealTimers()
    await waitFor(() => {
      expect(onSetEntry).toHaveBeenCalledWith(0, expect.objectContaining({ triggerKey: 7 }))
    })
  })

  it('calls onClose when close button is clicked', () => {
    render(
      <KeyOverridePanelModal entries={[makeEntry()]} onSetEntry={onSetEntry} onClose={onClose} />,
    )
    fireEvent.click(screen.getByTestId('ko-modal-close'))
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('calls onClose when backdrop is clicked', () => {
    render(
      <KeyOverridePanelModal entries={[makeEntry()]} onSetEntry={onSetEntry} onClose={onClose} />,
    )
    fireEvent.click(screen.getByTestId('ko-modal-backdrop'))
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('calls onClose when Escape is pressed', () => {
    render(
      <KeyOverridePanelModal entries={[makeEntry()]} onSetEntry={onSetEntry} onClose={onClose} />,
    )
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('shows mods-only label when triggerMods is set but triggerKey is 0', () => {
    render(
      <KeyOverridePanelModal
        entries={[makeEntry({ triggerMods: 0x01, enabled: true })]}
        onSetEntry={onSetEntry}
        onClose={onClose}
      />,
    )
    const tile = screen.getByTestId('ko-tile-0')
    expect(tile).toHaveTextContent('Mods')
  })
})
