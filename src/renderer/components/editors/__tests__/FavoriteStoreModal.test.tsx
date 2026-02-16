// SPDX-License-Identifier: GPL-2.0-or-later
// @vitest-environment jsdom

import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
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

    const renameButtons = screen.getAllByTestId('favorite-store-rename-btn')
    fireEvent.click(renameButtons[0])

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

    const renameButtons = screen.getAllByTestId('favorite-store-rename-btn')
    fireEvent.click(renameButtons[0])

    const input = screen.getByTestId('favorite-store-rename-input')
    fireEvent.keyDown(input, { key: 'Escape' })

    expect(onRename).not.toHaveBeenCalled()
    expect(screen.queryByTestId('favorite-store-rename-input')).not.toBeInTheDocument()
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

  it('calls onClose on Escape key', () => {
    const onClose = vi.fn()
    render(
      <FavoriteStoreModal
        entries={MOCK_ENTRIES}
        {...DEFAULT_PROPS}
        onClose={onClose}
      />,
    )

    fireEvent.keyDown(document, { key: 'Escape' })

    expect(onClose).toHaveBeenCalledOnce()
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

  it('enables save button when canSave is true', () => {
    render(
      <FavoriteStoreModal
        entries={[]}
        canSave={true}
        {...DEFAULT_PROPS}
      />,
    )

    expect(screen.getByTestId('favorite-store-save-submit')).not.toBeDisabled()
  })

  it('does not close modal when Escape is pressed during rename', () => {
    const onClose = vi.fn()
    render(
      <FavoriteStoreModal
        entries={MOCK_ENTRIES}
        {...DEFAULT_PROPS}
        onClose={onClose}
      />,
    )

    const renameButtons = screen.getAllByTestId('favorite-store-rename-btn')
    fireEvent.click(renameButtons[0])

    const input = screen.getByTestId('favorite-store-rename-input')
    fireEvent.keyDown(input, { key: 'Escape', bubbles: true })

    expect(screen.queryByTestId('favorite-store-rename-input')).not.toBeInTheDocument()
    expect(onClose).not.toHaveBeenCalled()
  })
})
