// SPDX-License-Identifier: GPL-2.0-or-later
// @vitest-environment jsdom

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { FavoriteHubActions } from '../FavoriteHubActions'
import type { FavHubEntryResult } from '../FavoriteHubActions'
import type { SavedFavoriteMeta } from '../../../../shared/types/favorite-store'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}))

const ENTRY: SavedFavoriteMeta = {
  id: 'fav-1',
  label: 'My Config',
  filename: 'tapDance_2026-01-01.json',
  savedAt: '2026-01-01T00:00:00.000Z',
}

const ENTRY_WITH_HUB: SavedFavoriteMeta = {
  ...ENTRY,
  id: 'fav-2',
  hubPostId: 'hub-post-42',
}

describe('FavoriteHubActions', () => {
  beforeEach(() => {
    window.vialAPI = {
      ...window.vialAPI,
      openExternal: vi.fn().mockResolvedValue(undefined),
    }
  })

  it('returns null when no action handlers are provided', () => {
    const { container } = render(<FavoriteHubActions entry={ENTRY} />)
    expect(container.innerHTML).toBe('')
  })

  it('shows Upload button when entry has no hubPostId and onUploadToHub is provided', () => {
    render(
      <FavoriteHubActions
        entry={ENTRY}
        onUploadToHub={vi.fn()}
      />,
    )

    expect(screen.getByTestId('fav-hub-upload-btn')).toBeInTheDocument()
    expect(screen.getByText('hub.uploadToHub')).toBeInTheDocument()
    expect(screen.queryByTestId('fav-hub-update-btn')).not.toBeInTheDocument()
    expect(screen.queryByTestId('fav-hub-remove-btn')).not.toBeInTheDocument()
  })

  it('shows Update and Remove buttons when entry has hubPostId and handlers are provided', () => {
    render(
      <FavoriteHubActions
        entry={ENTRY_WITH_HUB}
        onUploadToHub={vi.fn()}
        onUpdateOnHub={vi.fn()}
        onRemoveFromHub={vi.fn()}
      />,
    )

    expect(screen.getByTestId('fav-hub-update-btn')).toBeInTheDocument()
    expect(screen.getByText('hub.updateOnHub')).toBeInTheDocument()
    expect(screen.getByTestId('fav-hub-remove-btn')).toBeInTheDocument()
    expect(screen.getByText('hub.removeFromHub')).toBeInTheDocument()
    expect(screen.queryByTestId('fav-hub-upload-btn')).not.toBeInTheDocument()
  })

  it('shows Open link when entry has hubPostId and hubOrigin is set', () => {
    render(
      <FavoriteHubActions
        entry={ENTRY_WITH_HUB}
        hubOrigin="https://hub.example.com"
        onUpdateOnHub={vi.fn()}
      />,
    )

    const link = screen.getByTestId('fav-hub-share-link')
    expect(link).toBeInTheDocument()
    expect(link).toHaveAttribute('href', 'https://hub.example.com/post/hub-post-42')
    expect(screen.getByText('hub.openInBrowser')).toBeInTheDocument()
  })

  it('calls openExternal when Open link is clicked', () => {
    render(
      <FavoriteHubActions
        entry={ENTRY_WITH_HUB}
        hubOrigin="https://hub.example.com"
        onUpdateOnHub={vi.fn()}
      />,
    )

    fireEvent.click(screen.getByTestId('fav-hub-share-link'))
    expect(window.vialAPI.openExternal).toHaveBeenCalledWith(
      'https://hub.example.com/post/hub-post-42',
    )
  })

  it('does not show Open link when hubOrigin is not set', () => {
    render(
      <FavoriteHubActions
        entry={ENTRY_WITH_HUB}
        onUpdateOnHub={vi.fn()}
      />,
    )

    expect(screen.queryByTestId('fav-hub-share-link')).not.toBeInTheDocument()
  })

  it('shows needsDisplayName message and hides upload button for non-uploaded entries', () => {
    render(
      <FavoriteHubActions
        entry={ENTRY}
        hubNeedsDisplayName
        onUploadToHub={vi.fn()}
      />,
    )

    expect(screen.getByTestId('fav-hub-needs-display-name')).toBeInTheDocument()
    expect(screen.getByText('hub.needsDisplayName')).toBeInTheDocument()
    expect(screen.queryByTestId('fav-hub-upload-btn')).not.toBeInTheDocument()
  })

  it('shows remove/share but hides update when needsDisplayName is true for uploaded entries', () => {
    render(
      <FavoriteHubActions
        entry={ENTRY_WITH_HUB}
        hubNeedsDisplayName
        hubOrigin="https://hub.example.com"
        onUploadToHub={vi.fn()}
        onUpdateOnHub={vi.fn()}
        onRemoveFromHub={vi.fn()}
      />,
    )

    expect(screen.getByTestId('fav-hub-needs-display-name')).toBeInTheDocument()
    expect(screen.queryByTestId('fav-hub-update-btn')).not.toBeInTheDocument()
    expect(screen.getByTestId('fav-hub-remove-btn')).toBeInTheDocument()
    expect(screen.getByTestId('fav-hub-share-link')).toBeInTheDocument()
  })

  it('shows Uploading indicator when hubUploading matches entry.id', () => {
    render(
      <FavoriteHubActions
        entry={ENTRY}
        hubUploading={ENTRY.id}
        onUploadToHub={vi.fn()}
      />,
    )

    expect(screen.getByTestId('fav-hub-uploading')).toBeInTheDocument()
    expect(screen.getByText('hub.uploading')).toBeInTheDocument()
    expect(screen.queryByTestId('fav-hub-upload-btn')).not.toBeInTheDocument()
  })

  it('does not show Uploading indicator when hubUploading does not match entry.id', () => {
    render(
      <FavoriteHubActions
        entry={ENTRY}
        hubUploading="other-id"
        onUploadToHub={vi.fn()}
      />,
    )

    expect(screen.queryByTestId('fav-hub-uploading')).not.toBeInTheDocument()
    expect(screen.getByTestId('fav-hub-upload-btn')).toBeInTheDocument()
  })

  it('shows success result message when hubUploadResult matches entry.id', () => {
    const result: FavHubEntryResult = {
      kind: 'success',
      message: 'Uploaded successfully',
      entryId: ENTRY.id,
    }

    render(
      <FavoriteHubActions
        entry={ENTRY}
        hubUploadResult={result}
        onUploadToHub={vi.fn()}
      />,
    )

    const el = screen.getByTestId('fav-hub-result')
    expect(el).toBeInTheDocument()
    expect(el.textContent).toBe('Uploaded successfully')
    expect(el.className).toContain('text-accent')
  })

  it('shows error result message when hubUploadResult has error kind', () => {
    const result: FavHubEntryResult = {
      kind: 'error',
      message: 'Upload failed',
      entryId: ENTRY.id,
    }

    render(
      <FavoriteHubActions
        entry={ENTRY}
        hubUploadResult={result}
        onUploadToHub={vi.fn()}
      />,
    )

    const el = screen.getByTestId('fav-hub-result')
    expect(el).toBeInTheDocument()
    expect(el.textContent).toBe('Upload failed')
    expect(el.className).toContain('text-red-400')
  })

  it('does not show result message when hubUploadResult entryId does not match', () => {
    const result: FavHubEntryResult = {
      kind: 'success',
      message: 'Uploaded',
      entryId: 'other-entry',
    }

    render(
      <FavoriteHubActions
        entry={ENTRY}
        hubUploadResult={result}
        onUploadToHub={vi.fn()}
      />,
    )

    expect(screen.queryByTestId('fav-hub-result')).not.toBeInTheDocument()
  })

  it('Remove button shows confirm dialog on click (two-step)', () => {
    const onRemoveFromHub = vi.fn()

    render(
      <FavoriteHubActions
        entry={ENTRY_WITH_HUB}
        onRemoveFromHub={onRemoveFromHub}
        onUpdateOnHub={vi.fn()}
      />,
    )

    // Step 1: click Remove — should show confirm + cancel buttons
    fireEvent.click(screen.getByTestId('fav-hub-remove-btn'))
    expect(screen.queryByTestId('fav-hub-remove-btn')).not.toBeInTheDocument()
    expect(screen.getByTestId('fav-hub-remove-confirm')).toBeInTheDocument()
    expect(screen.getByText('hub.confirmRemove')).toBeInTheDocument()
    expect(screen.getByTestId('fav-hub-remove-cancel')).toBeInTheDocument()
    expect(screen.getByText('common.cancel')).toBeInTheDocument()
    expect(onRemoveFromHub).not.toHaveBeenCalled()

    // Step 2: click confirm — should call handler
    fireEvent.click(screen.getByTestId('fav-hub-remove-confirm'))
    expect(onRemoveFromHub).toHaveBeenCalledWith(ENTRY_WITH_HUB.id)
  })

  it('Remove confirm can be cancelled', () => {
    const onRemoveFromHub = vi.fn()

    render(
      <FavoriteHubActions
        entry={ENTRY_WITH_HUB}
        onRemoveFromHub={onRemoveFromHub}
        onUpdateOnHub={vi.fn()}
      />,
    )

    // Click Remove to enter confirm state
    fireEvent.click(screen.getByTestId('fav-hub-remove-btn'))
    expect(screen.getByTestId('fav-hub-remove-confirm')).toBeInTheDocument()

    // Click Cancel — should go back to normal Remove button
    fireEvent.click(screen.getByTestId('fav-hub-remove-cancel'))
    expect(screen.getByTestId('fav-hub-remove-btn')).toBeInTheDocument()
    expect(screen.queryByTestId('fav-hub-remove-confirm')).not.toBeInTheDocument()
    expect(onRemoveFromHub).not.toHaveBeenCalled()
  })

  it('Upload button calls onUploadToHub with entry.id', () => {
    const onUploadToHub = vi.fn()

    render(
      <FavoriteHubActions
        entry={ENTRY}
        onUploadToHub={onUploadToHub}
      />,
    )

    fireEvent.click(screen.getByTestId('fav-hub-upload-btn'))
    expect(onUploadToHub).toHaveBeenCalledWith(ENTRY.id)
  })

  it('Update button calls onUpdateOnHub with entry.id', () => {
    const onUpdateOnHub = vi.fn()

    render(
      <FavoriteHubActions
        entry={ENTRY_WITH_HUB}
        onUpdateOnHub={onUpdateOnHub}
      />,
    )

    fireEvent.click(screen.getByTestId('fav-hub-update-btn'))
    expect(onUpdateOnHub).toHaveBeenCalledWith(ENTRY_WITH_HUB.id)
  })

  it('buttons are disabled when hubUploading is set', () => {
    render(
      <FavoriteHubActions
        entry={ENTRY_WITH_HUB}
        hubUploading="some-other-entry"
        onUpdateOnHub={vi.fn()}
        onRemoveFromHub={vi.fn()}
      />,
    )

    expect(screen.getByTestId('fav-hub-update-btn')).toBeDisabled()
    expect(screen.getByTestId('fav-hub-remove-btn')).toBeDisabled()
  })

  it('upload button is disabled when hubUploading is set', () => {
    render(
      <FavoriteHubActions
        entry={ENTRY}
        hubUploading="some-other-entry"
        onUploadToHub={vi.fn()}
      />,
    )

    expect(screen.getByTestId('fav-hub-upload-btn')).toBeDisabled()
  })
})
