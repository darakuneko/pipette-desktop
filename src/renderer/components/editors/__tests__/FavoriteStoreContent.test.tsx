// SPDX-License-Identifier: GPL-2.0-or-later
// @vitest-environment jsdom

import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { FavoriteStoreContent } from '../FavoriteStoreContent'
import type { SavedFavoriteMeta } from '../../../../shared/types/favorite-store'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}))

vi.mock('../FavoriteHubActions', () => ({
  FavoriteHubActions: () => null,
}))

const ENTRIES_WITH_HUB: SavedFavoriteMeta[] = [
  {
    id: 'fav-1',
    label: 'My Tap Dance',
    filename: 'tapDance_2026-01-01.json',
    savedAt: '2026-01-01T00:00:00.000Z',
    hubPostId: 'hub-post-99',
  },
]

const ENTRIES_WITHOUT_HUB: SavedFavoriteMeta[] = [
  {
    id: 'fav-2',
    label: 'Local Only',
    filename: 'tapDance_2026-01-02.json',
    savedAt: '2026-01-02T12:30:00.000Z',
  },
]

const DEFAULT_PROPS = {
  entries: [] as SavedFavoriteMeta[],
  onSave: vi.fn(),
  onLoad: vi.fn(),
  onRename: vi.fn().mockResolvedValue(true),
  onDelete: vi.fn(),
  onExport: vi.fn(),
  onExportEntry: vi.fn(),
  onImport: vi.fn(),
}

describe('FavoriteStoreContent', () => {
  describe('hub rename sync', () => {
    it('calls onRenameOnHub when renaming entry with hubPostId', async () => {
      const onRename = vi.fn().mockResolvedValue(true)
      const onRenameOnHub = vi.fn()
      render(
        <FavoriteStoreContent
          {...DEFAULT_PROPS}
          entries={ENTRIES_WITH_HUB}
          onRename={onRename}
          onRenameOnHub={onRenameOnHub}
        />,
      )

      const label = screen.getByTestId('favorite-store-entry-label')
      fireEvent.click(label)

      const input = screen.getByTestId('favorite-store-rename-input')
      fireEvent.change(input, { target: { value: 'Renamed Entry' } })
      fireEvent.keyDown(input, { key: 'Enter' })

      expect(onRename).toHaveBeenCalledWith('fav-1', 'Renamed Entry')
      await waitFor(() => {
        expect(onRenameOnHub).toHaveBeenCalledWith('fav-1', 'hub-post-99', 'Renamed Entry')
      })
    })

    it('does not call onRenameOnHub when entry has no hubPostId', async () => {
      const onRename = vi.fn().mockResolvedValue(true)
      const onRenameOnHub = vi.fn()
      render(
        <FavoriteStoreContent
          {...DEFAULT_PROPS}
          entries={ENTRIES_WITHOUT_HUB}
          onRename={onRename}
          onRenameOnHub={onRenameOnHub}
        />,
      )

      const label = screen.getByTestId('favorite-store-entry-label')
      fireEvent.click(label)

      const input = screen.getByTestId('favorite-store-rename-input')
      fireEvent.change(input, { target: { value: 'New Name' } })
      fireEvent.keyDown(input, { key: 'Enter' })

      expect(onRename).toHaveBeenCalledWith('fav-2', 'New Name')
      // Wait a tick to ensure async commitRename resolves
      await waitFor(() => {
        expect(onRenameOnHub).not.toHaveBeenCalled()
      })
    })

    it('calls onRenameOnHub on blur when entry has hubPostId', async () => {
      const onRename = vi.fn().mockResolvedValue(true)
      const onRenameOnHub = vi.fn()
      render(
        <FavoriteStoreContent
          {...DEFAULT_PROPS}
          entries={ENTRIES_WITH_HUB}
          onRename={onRename}
          onRenameOnHub={onRenameOnHub}
        />,
      )

      const label = screen.getByTestId('favorite-store-entry-label')
      fireEvent.click(label)

      const input = screen.getByTestId('favorite-store-rename-input')
      fireEvent.change(input, { target: { value: 'Blur Rename' } })
      fireEvent.blur(input)

      expect(onRename).toHaveBeenCalledWith('fav-1', 'Blur Rename')
      await waitFor(() => {
        expect(onRenameOnHub).toHaveBeenCalledWith('fav-1', 'hub-post-99', 'Blur Rename')
      })
    })

    it('does not call onRenameOnHub when onRenameOnHub is not provided', async () => {
      const onRename = vi.fn().mockResolvedValue(true)
      render(
        <FavoriteStoreContent
          {...DEFAULT_PROPS}
          entries={ENTRIES_WITH_HUB}
          onRename={onRename}
        />,
      )

      const label = screen.getByTestId('favorite-store-entry-label')
      fireEvent.click(label)

      const input = screen.getByTestId('favorite-store-rename-input')
      fireEvent.change(input, { target: { value: 'No Callback' } })
      fireEvent.keyDown(input, { key: 'Enter' })

      expect(onRename).toHaveBeenCalledWith('fav-1', 'No Callback')
      // Should not throw even though onRenameOnHub is undefined
    })

    it('does not call onRenameOnHub when local rename fails', async () => {
      const onRename = vi.fn().mockResolvedValue(false)
      const onRenameOnHub = vi.fn()
      render(
        <FavoriteStoreContent
          {...DEFAULT_PROPS}
          entries={ENTRIES_WITH_HUB}
          onRename={onRename}
          onRenameOnHub={onRenameOnHub}
        />,
      )

      const label = screen.getByTestId('favorite-store-entry-label')
      fireEvent.click(label)

      const input = screen.getByTestId('favorite-store-rename-input')
      fireEvent.change(input, { target: { value: 'Will Fail' } })
      fireEvent.keyDown(input, { key: 'Enter' })

      expect(onRename).toHaveBeenCalledWith('fav-1', 'Will Fail')
      // Wait a tick to ensure async commitRename resolves
      await waitFor(() => {
        expect(onRenameOnHub).not.toHaveBeenCalled()
      })
    })
  })
})
