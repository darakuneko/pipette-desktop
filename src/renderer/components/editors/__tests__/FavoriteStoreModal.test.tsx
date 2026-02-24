// SPDX-License-Identifier: GPL-2.0-or-later
// @vitest-environment jsdom

import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, act } from '@testing-library/react'
import { FavoriteStoreModal } from '../FavoriteStoreModal'
import type { SavedFavoriteMeta } from '../../../../shared/types/favorite-store'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}))

const MOCK_ENTRIES: SavedFavoriteMeta[] = [
  {
    id: 'fav-1',
    label: 'My Tap Dance',
    filename: 'tapDance_2026-01-01.json',
    savedAt: '2026-01-01T00:00:00.000Z',
  },
  {
    id: 'fav-2',
    label: '',
    filename: 'tapDance_2026-01-02.json',
    savedAt: '2026-01-02T12:30:00.000Z',
  },
]

const DEFAULT_PROPS = {
  favoriteType: 'tapDance' as const,
  onSave: vi.fn(),
  onLoad: vi.fn(),
  onRename: vi.fn(),
  onDelete: vi.fn(),
  onExport: vi.fn(),
  onExportEntry: vi.fn(),
  onImport: vi.fn(),
  onClose: vi.fn(),
}

describe('FavoriteStoreModal', () => {
  it('shows empty state when no entries', () => {
    render(
      <FavoriteStoreModal
        entries={[]}
        {...DEFAULT_PROPS}
      />,
    )

    expect(screen.getByTestId('favorite-store-empty')).toBeInTheDocument()
  })

  it('renders entries as cards with labels and dates', () => {
    render(
      <FavoriteStoreModal
        entries={MOCK_ENTRIES}
        {...DEFAULT_PROPS}
      />,
    )

    const items = screen.getAllByTestId('favorite-store-entry')
    expect(items).toHaveLength(2)

    const labels = screen.getAllByTestId('favorite-store-entry-label')
    expect(labels[0].textContent).toBe('My Tap Dance')
    expect(labels[1].textContent).toBe('favoriteStore.noLabel')
  })

  it('displays type badge in title', () => {
    render(
      <FavoriteStoreModal
        entries={[]}
        {...DEFAULT_PROPS}
      />,
    )

    expect(screen.getByText('editor.tapDance.title')).toBeInTheDocument()
  })

  it('renders section headers for save and synced data', () => {
    render(
      <FavoriteStoreModal
        entries={MOCK_ENTRIES}
        {...DEFAULT_PROPS}
      />,
    )

    expect(screen.getByText('favoriteStore.saveCurrentState')).toBeInTheDocument()
    expect(screen.getByText('favoriteStore.history')).toBeInTheDocument()
  })

  it('calls onLoad when load button clicked', () => {
    const onLoad = vi.fn()
    render(
      <FavoriteStoreModal
        entries={MOCK_ENTRIES}
        {...DEFAULT_PROPS}
        onLoad={onLoad}
      />,
    )

    const loadButtons = screen.getAllByTestId('favorite-store-load-btn')
    fireEvent.click(loadButtons[0])

    expect(onLoad).toHaveBeenCalledWith('fav-1')
  })

  it('enters rename mode and submits on Enter', () => {
    const onRename = vi.fn()
    render(
      <FavoriteStoreModal
        entries={MOCK_ENTRIES}
        {...DEFAULT_PROPS}
        onRename={onRename}
      />,
    )

    const labels = screen.getAllByTestId('favorite-store-entry-label')
    fireEvent.click(labels[0])

    const input = screen.getByTestId('favorite-store-rename-input')
    expect(input).toBeInTheDocument()

    fireEvent.change(input, { target: { value: 'New Name' } })
    fireEvent.keyDown(input, { key: 'Enter' })

    expect(onRename).toHaveBeenCalledWith('fav-1', 'New Name')
  })

  it('cancels rename on Escape', () => {
    const onRename = vi.fn()
    render(
      <FavoriteStoreModal
        entries={MOCK_ENTRIES}
        {...DEFAULT_PROPS}
        onRename={onRename}
      />,
    )

    const labels = screen.getAllByTestId('favorite-store-entry-label')
    fireEvent.click(labels[0])

    const input = screen.getByTestId('favorite-store-rename-input')
    fireEvent.keyDown(input, { key: 'Escape' })

    expect(onRename).not.toHaveBeenCalled()
    expect(screen.queryByTestId('favorite-store-rename-input')).not.toBeInTheDocument()
  })

  it('commits rename on blur (clicking outside)', () => {
    const onRename = vi.fn()
    render(
      <FavoriteStoreModal
        entries={MOCK_ENTRIES}
        {...DEFAULT_PROPS}
        onRename={onRename}
      />,
    )

    const labels = screen.getAllByTestId('favorite-store-entry-label')
    fireEvent.click(labels[0])

    const input = screen.getByTestId('favorite-store-rename-input')
    fireEvent.change(input, { target: { value: 'Changed Name' } })
    fireEvent.blur(input)

    expect(onRename).toHaveBeenCalledWith('fav-1', 'Changed Name')
    expect(screen.queryByTestId('favorite-store-rename-input')).not.toBeInTheDocument()
  })

  describe('confirm flash', () => {
    afterEach(() => {
      vi.restoreAllMocks()
    })

    it('shows confirm flash on card after Enter rename', () => {
      vi.useFakeTimers()
      const onRename = vi.fn()
      render(
        <FavoriteStoreModal
          entries={MOCK_ENTRIES}
          {...DEFAULT_PROPS}
          onRename={onRename}
        />,
      )

      const labels = screen.getAllByTestId('favorite-store-entry-label')
      fireEvent.click(labels[0])

      const input = screen.getByTestId('favorite-store-rename-input')
      fireEvent.change(input, { target: { value: 'New Name' } })
      fireEvent.keyDown(input, { key: 'Enter' })

      // Flash is deferred via setTimeout(0) so the class is added after the label mounts
      act(() => { vi.advanceTimersByTime(0) })

      // Card should have confirm flash animation
      const cards = screen.getAllByTestId('favorite-store-entry')
      expect(cards[0].className).toContain('confirm-flash')

      // After 1200ms, animation class should be removed
      act(() => { vi.advanceTimersByTime(1200) })
      expect(cards[0].className).not.toContain('confirm-flash')

      vi.useRealTimers()
    })

    it('does not flash when Enter is pressed without changes', () => {
      const onRename = vi.fn()
      render(
        <FavoriteStoreModal
          entries={MOCK_ENTRIES}
          {...DEFAULT_PROPS}
          onRename={onRename}
        />,
      )

      const labels = screen.getAllByTestId('favorite-store-entry-label')
      fireEvent.click(labels[0])

      const input = screen.getByTestId('favorite-store-rename-input')
      // Press Enter without changing the value
      fireEvent.keyDown(input, { key: 'Enter' })

      expect(onRename).not.toHaveBeenCalled()
      const cards = screen.getAllByTestId('favorite-store-entry')
      expect(cards[0].className).not.toContain('confirm-flash')
    })
  })

  it('shows delete confirmation and calls onDelete', () => {
    const onDelete = vi.fn()
    render(
      <FavoriteStoreModal
        entries={MOCK_ENTRIES}
        {...DEFAULT_PROPS}
        onDelete={onDelete}
      />,
    )

    const deleteButtons = screen.getAllByTestId('favorite-store-delete-btn')
    fireEvent.click(deleteButtons[0])

    const confirmBtn = screen.getByTestId('favorite-store-delete-confirm')
    fireEvent.click(confirmBtn)

    expect(onDelete).toHaveBeenCalledWith('fav-1')
  })

  it('cancels delete confirmation', () => {
    const onDelete = vi.fn()
    render(
      <FavoriteStoreModal
        entries={MOCK_ENTRIES}
        {...DEFAULT_PROPS}
        onDelete={onDelete}
      />,
    )

    const deleteButtons = screen.getAllByTestId('favorite-store-delete-btn')
    fireEvent.click(deleteButtons[0])

    const cancelBtn = screen.getByTestId('favorite-store-delete-cancel')
    fireEvent.click(cancelBtn)

    expect(onDelete).not.toHaveBeenCalled()
    expect(screen.queryByTestId('favorite-store-delete-confirm')).not.toBeInTheDocument()
  })

  it('calls onClose when close button clicked', () => {
    const onClose = vi.fn()
    render(
      <FavoriteStoreModal
        entries={MOCK_ENTRIES}
        {...DEFAULT_PROPS}
        onClose={onClose}
      />,
    )

    fireEvent.click(screen.getByTestId('favorite-store-modal-close'))

    expect(onClose).toHaveBeenCalledOnce()
  })

  it('calls onClose when backdrop clicked', () => {
    const onClose = vi.fn()
    render(
      <FavoriteStoreModal
        entries={MOCK_ENTRIES}
        {...DEFAULT_PROPS}
        onClose={onClose}
      />,
    )

    fireEvent.click(screen.getByTestId('favorite-store-modal-backdrop'))

    expect(onClose).toHaveBeenCalledOnce()
  })

  it('does not close modal on Escape key', () => {
    const onClose = vi.fn()
    render(
      <FavoriteStoreModal
        entries={MOCK_ENTRIES}
        {...DEFAULT_PROPS}
        onClose={onClose}
      />,
    )

    fireEvent.keyDown(document, { key: 'Escape' })

    expect(onClose).not.toHaveBeenCalled()
  })

  it('shows loading state', () => {
    render(
      <FavoriteStoreModal
        entries={[]}
        loading
        {...DEFAULT_PROPS}
      />,
    )

    expect(screen.queryByTestId('favorite-store-empty')).not.toBeInTheDocument()
    expect(screen.getByText('common.loading')).toBeInTheDocument()
  })

  it('renders save form with input and button', () => {
    render(
      <FavoriteStoreModal
        entries={[]}
        {...DEFAULT_PROPS}
      />,
    )

    expect(screen.getByTestId('favorite-store-save-input')).toBeInTheDocument()
    expect(screen.getByTestId('favorite-store-save-submit')).toBeInTheDocument()
  })

  it('calls onSave with trimmed label on form submit', () => {
    const onSave = vi.fn()
    render(
      <FavoriteStoreModal
        entries={[]}
        {...DEFAULT_PROPS}
        onSave={onSave}
      />,
    )

    const input = screen.getByTestId('favorite-store-save-input')
    fireEvent.change(input, { target: { value: '  My Fav  ' } })
    fireEvent.submit(input.closest('form')!)

    expect(onSave).toHaveBeenCalledWith('My Fav')
  })

  it('disables save button when saving', () => {
    render(
      <FavoriteStoreModal
        entries={[]}
        saving
        {...DEFAULT_PROPS}
      />,
    )

    expect(screen.getByTestId('favorite-store-save-submit')).toBeDisabled()
  })

  it('clears input after save submit', () => {
    render(
      <FavoriteStoreModal
        entries={[]}
        {...DEFAULT_PROPS}
      />,
    )

    const input = screen.getByTestId('favorite-store-save-input') as HTMLInputElement
    fireEvent.change(input, { target: { value: 'Test Label' } })
    fireEvent.submit(input.closest('form')!)

    expect(input.value).toBe('')
  })

  it('does not call onSave when saving is true', () => {
    const onSave = vi.fn()
    render(
      <FavoriteStoreModal
        entries={[]}
        saving
        {...DEFAULT_PROPS}
        onSave={onSave}
      />,
    )

    const input = screen.getByTestId('favorite-store-save-input')
    fireEvent.change(input, { target: { value: 'Test' } })
    fireEvent.submit(input.closest('form')!)

    expect(onSave).not.toHaveBeenCalled()
  })

  it('disables save button when canSave is false', () => {
    render(
      <FavoriteStoreModal
        entries={[]}
        canSave={false}
        {...DEFAULT_PROPS}
      />,
    )

    expect(screen.getByTestId('favorite-store-save-submit')).toBeDisabled()
  })

  it('does not call onSave when canSave is false', () => {
    const onSave = vi.fn()
    render(
      <FavoriteStoreModal
        entries={[]}
        canSave={false}
        {...DEFAULT_PROPS}
        onSave={onSave}
      />,
    )

    const input = screen.getByTestId('favorite-store-save-input')
    fireEvent.change(input, { target: { value: 'Test' } })
    fireEvent.submit(input.closest('form')!)

    expect(onSave).not.toHaveBeenCalled()
  })

  it('enables save button when canSave is true and label is non-empty', () => {
    render(
      <FavoriteStoreModal
        entries={[]}
        canSave={true}
        {...DEFAULT_PROPS}
      />,
    )

    const input = screen.getByTestId('favorite-store-save-input')
    fireEvent.change(input, { target: { value: 'Test' } })
    expect(screen.getByTestId('favorite-store-save-submit')).not.toBeDisabled()
  })

  it('disables save button when label is empty', () => {
    render(
      <FavoriteStoreModal
        entries={[]}
        {...DEFAULT_PROPS}
      />,
    )

    expect(screen.getByTestId('favorite-store-save-submit')).toBeDisabled()
  })

  it('disables save button when label is whitespace only', () => {
    render(
      <FavoriteStoreModal
        entries={[]}
        {...DEFAULT_PROPS}
      />,
    )

    const input = screen.getByTestId('favorite-store-save-input')
    fireEvent.change(input, { target: { value: '   ' } })
    expect(screen.getByTestId('favorite-store-save-submit')).toBeDisabled()
  })

  it('does not call onSave when label is empty', () => {
    const onSave = vi.fn()
    render(
      <FavoriteStoreModal
        entries={[]}
        {...DEFAULT_PROPS}
        onSave={onSave}
      />,
    )

    const input = screen.getByTestId('favorite-store-save-input')
    fireEvent.submit(input.closest('form')!)
    expect(onSave).not.toHaveBeenCalled()
  })

  it('does not call onRename when Escape is pressed after changing rename text', () => {
    const onRename = vi.fn()
    render(
      <FavoriteStoreModal
        entries={MOCK_ENTRIES}
        {...DEFAULT_PROPS}
        onRename={onRename}
      />,
    )

    const labels = screen.getAllByTestId('favorite-store-entry-label')
    fireEvent.click(labels[0])

    const input = screen.getByTestId('favorite-store-rename-input')
    fireEvent.change(input, { target: { value: 'Changed Name' } })
    fireEvent.keyDown(input, { key: 'Escape' })

    expect(onRename).not.toHaveBeenCalled()
    expect(screen.queryByTestId('favorite-store-rename-input')).not.toBeInTheDocument()
  })

  it('renders export and import buttons', () => {
    render(
      <FavoriteStoreModal
        entries={[]}
        {...DEFAULT_PROPS}
      />,
    )

    expect(screen.getByTestId('favorite-store-export-btn')).toBeInTheDocument()
    expect(screen.getByTestId('favorite-store-import-btn')).toBeInTheDocument()
  })

  it('calls onExport when export button clicked', () => {
    const onExport = vi.fn()
    render(
      <FavoriteStoreModal
        entries={[]}
        {...DEFAULT_PROPS}
        onExport={onExport}
      />,
    )

    fireEvent.click(screen.getByTestId('favorite-store-export-btn'))
    expect(onExport).toHaveBeenCalledOnce()
  })

  it('calls onImport when import button clicked', () => {
    const onImport = vi.fn()
    render(
      <FavoriteStoreModal
        entries={[]}
        {...DEFAULT_PROPS}
        onImport={onImport}
      />,
    )

    fireEvent.click(screen.getByTestId('favorite-store-import-btn'))
    expect(onImport).toHaveBeenCalledOnce()
  })

  it('disables export button when exporting', () => {
    render(
      <FavoriteStoreModal
        entries={[]}
        exporting
        {...DEFAULT_PROPS}
      />,
    )

    expect(screen.getByTestId('favorite-store-export-btn')).toBeDisabled()
  })

  it('disables import button when importing', () => {
    render(
      <FavoriteStoreModal
        entries={[]}
        importing
        {...DEFAULT_PROPS}
      />,
    )

    expect(screen.getByTestId('favorite-store-import-btn')).toBeDisabled()
  })

  it('shows import success message', () => {
    render(
      <FavoriteStoreModal
        entries={[]}
        importResult={{ imported: 3, skipped: 0 }}
        {...DEFAULT_PROPS}
      />,
    )

    expect(screen.getByTestId('favorite-store-import-result')).toHaveTextContent('favoriteStore.importSuccess')
  })

  it('shows import partial message when skipped > 0', () => {
    render(
      <FavoriteStoreModal
        entries={[]}
        importResult={{ imported: 2, skipped: 1 }}
        {...DEFAULT_PROPS}
      />,
    )

    expect(screen.getByTestId('favorite-store-import-result')).toHaveTextContent('favoriteStore.importPartial')
  })

  it('shows import empty message when imported is 0', () => {
    render(
      <FavoriteStoreModal
        entries={[]}
        importResult={{ imported: 0, skipped: 3 }}
        {...DEFAULT_PROPS}
      />,
    )

    expect(screen.getByTestId('favorite-store-import-result')).toHaveTextContent('favoriteStore.importEmpty')
  })

  it('does not show import result when importResult is null', () => {
    render(
      <FavoriteStoreModal
        entries={[]}
        {...DEFAULT_PROPS}
      />,
    )

    expect(screen.queryByTestId('favorite-store-import-result')).not.toBeInTheDocument()
  })

  it('renders export all button with exportAll key', () => {
    render(
      <FavoriteStoreModal
        entries={[]}
        {...DEFAULT_PROPS}
      />,
    )

    expect(screen.getByTestId('favorite-store-export-btn')).toHaveTextContent('favoriteStore.exportAll')
  })

  it('renders per-entry export buttons for each entry', () => {
    render(
      <FavoriteStoreModal
        entries={MOCK_ENTRIES}
        {...DEFAULT_PROPS}
      />,
    )

    const exportEntryBtns = screen.getAllByTestId('favorite-store-export-entry-btn')
    expect(exportEntryBtns).toHaveLength(2)
  })

  it('calls onExportEntry with entry id when per-entry export clicked', () => {
    const onExportEntry = vi.fn()
    render(
      <FavoriteStoreModal
        entries={MOCK_ENTRIES}
        {...DEFAULT_PROPS}
        onExportEntry={onExportEntry}
      />,
    )

    const exportEntryBtns = screen.getAllByTestId('favorite-store-export-entry-btn')
    fireEvent.click(exportEntryBtns[0])
    expect(onExportEntry).toHaveBeenCalledWith('fav-1')

    fireEvent.click(exportEntryBtns[1])
    expect(onExportEntry).toHaveBeenCalledWith('fav-2')
  })

  it('places import button before export all button', () => {
    render(
      <FavoriteStoreModal
        entries={[]}
        {...DEFAULT_PROPS}
      />,
    )

    const importBtn = screen.getByTestId('favorite-store-import-btn')
    const exportBtn = screen.getByTestId('favorite-store-export-btn')
    const parent = importBtn.parentElement!
    const children = Array.from(parent.children)
    expect(children.indexOf(importBtn)).toBeLessThan(children.indexOf(exportBtn))
  })

  it('disables per-entry export buttons when exporting', () => {
    render(
      <FavoriteStoreModal
        entries={MOCK_ENTRIES}
        exporting
        {...DEFAULT_PROPS}
      />,
    )

    const exportEntryBtns = screen.getAllByTestId('favorite-store-export-entry-btn')
    for (const btn of exportEntryBtns) {
      expect(btn).toBeDisabled()
    }
  })

  it('disables per-entry export buttons when importing', () => {
    render(
      <FavoriteStoreModal
        entries={MOCK_ENTRIES}
        importing
        {...DEFAULT_PROPS}
      />,
    )

    const exportEntryBtns = screen.getAllByTestId('favorite-store-export-entry-btn')
    for (const btn of exportEntryBtns) {
      expect(btn).toBeDisabled()
    }
  })

  it('disables import button when exporting', () => {
    render(
      <FavoriteStoreModal
        entries={[]}
        exporting
        {...DEFAULT_PROPS}
      />,
    )

    expect(screen.getByTestId('favorite-store-import-btn')).toBeDisabled()
  })

  it('disables export all button when importing', () => {
    render(
      <FavoriteStoreModal
        entries={[]}
        importing
        {...DEFAULT_PROPS}
      />,
    )

    expect(screen.getByTestId('favorite-store-export-btn')).toBeDisabled()
  })

})
