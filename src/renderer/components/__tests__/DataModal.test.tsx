// SPDX-License-Identifier: GPL-2.0-or-later
// @vitest-environment jsdom

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react'
import { DataModal } from '../DataModal'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}))

vi.mock('../editors/ModalCloseButton', () => ({
  ModalCloseButton: ({ testid, onClick }: { testid: string; onClick: () => void }) => (
    <button data-testid={testid} onClick={onClick}>close</button>
  ),
}))

const mockFavoriteStoreList = vi.fn().mockResolvedValue({ success: true, entries: [] })
const mockFavoriteStoreRename = vi.fn().mockResolvedValue({ success: true })
const mockFavoriteStoreDelete = vi.fn().mockResolvedValue({ success: true })
const mockFavoriteStoreExport = vi.fn().mockResolvedValue({ success: true })
const mockFavoriteStoreImport = vi.fn().mockResolvedValue({ success: true, imported: 1, skipped: 0 })
const mockOpenExternal = vi.fn().mockResolvedValue(undefined)

Object.defineProperty(window, 'vialAPI', {
  value: {
    favoriteStoreList: mockFavoriteStoreList,
    favoriteStoreRename: mockFavoriteStoreRename,
    favoriteStoreDelete: mockFavoriteStoreDelete,
    favoriteStoreExport: mockFavoriteStoreExport,
    favoriteStoreImport: mockFavoriteStoreImport,
    openExternal: mockOpenExternal,
  },
  writable: true,
})

function makeProps(overrides?: Partial<Parameters<typeof DataModal>[0]>) {
  return {
    onClose: vi.fn(),
    hubEnabled: false,
    hubAuthenticated: false,
    hubPosts: [] as { id: string; title: string; keyboard_name: string; created_at: string }[],
    onHubRename: vi.fn().mockResolvedValue(undefined),
    onHubDelete: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  }
}

describe('DataModal', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  describe('tabs', () => {
    it('renders 5 favorite tabs when hub is not enabled', () => {
      render(<DataModal {...makeProps()} />)

      expect(screen.getByTestId('data-modal-tab-tapDance')).toBeInTheDocument()
      expect(screen.getByTestId('data-modal-tab-macro')).toBeInTheDocument()
      expect(screen.getByTestId('data-modal-tab-combo')).toBeInTheDocument()
      expect(screen.getByTestId('data-modal-tab-keyOverride')).toBeInTheDocument()
      expect(screen.getByTestId('data-modal-tab-altRepeatKey')).toBeInTheDocument()
      expect(screen.queryByTestId('data-modal-tab-hubPost')).not.toBeInTheDocument()
    })

    it('renders 6 tabs including hubPost when hub is enabled and authenticated', () => {
      render(<DataModal {...makeProps({ hubEnabled: true, hubAuthenticated: true })} />)

      expect(screen.getByTestId('data-modal-tab-tapDance')).toBeInTheDocument()
      expect(screen.getByTestId('data-modal-tab-hubPost')).toBeInTheDocument()
    })

    it('does not show hubPost tab when hub is enabled but not authenticated', () => {
      render(<DataModal {...makeProps({ hubEnabled: true })} />)

      expect(screen.queryByTestId('data-modal-tab-hubPost')).not.toBeInTheDocument()
    })
  })

  describe('modal controls', () => {
    it('calls onClose when backdrop is clicked', () => {
      const onClose = vi.fn()
      render(<DataModal {...makeProps({ onClose })} />)

      fireEvent.click(screen.getByTestId('data-modal-backdrop'))
      expect(onClose).toHaveBeenCalledOnce()
    })

    it('does not call onClose when modal content is clicked', () => {
      const onClose = vi.fn()
      render(<DataModal {...makeProps({ onClose })} />)

      fireEvent.click(screen.getByTestId('data-modal'))
      expect(onClose).not.toHaveBeenCalled()
    })

    it('calls onClose when close button is clicked', () => {
      const onClose = vi.fn()
      render(<DataModal {...makeProps({ onClose })} />)

      fireEvent.click(screen.getByTestId('data-modal-close'))
      expect(onClose).toHaveBeenCalledOnce()
    })
  })

  describe('favorite tab content', () => {
    it('shows empty state when no entries exist', async () => {
      render(<DataModal {...makeProps()} />)

      await waitFor(() => {
        expect(screen.getByTestId('data-modal-fav-empty')).toBeInTheDocument()
      })
    })

    it('shows entries when they exist', async () => {
      mockFavoriteStoreList.mockResolvedValueOnce({
        success: true,
        entries: [
          { id: 'e1', label: 'My Tap Dance', savedAt: Date.now() },
          { id: 'e2', label: 'Another TD', savedAt: Date.now() },
        ],
      })

      render(<DataModal {...makeProps()} />)

      await waitFor(() => {
        expect(screen.getByTestId('data-modal-fav-list')).toBeInTheDocument()
      })
      expect(screen.getAllByTestId('data-modal-fav-entry')).toHaveLength(2)
    })

    it('shows import and export buttons', async () => {
      render(<DataModal {...makeProps()} />)

      await waitFor(() => {
        expect(screen.getByTestId('data-modal-fav-import-btn')).toBeInTheDocument()
        expect(screen.getByTestId('data-modal-fav-export-all-btn')).toBeInTheDocument()
      })
    })

    it('enters rename mode when label is clicked', async () => {
      mockFavoriteStoreList.mockResolvedValueOnce({
        success: true,
        entries: [{ id: 'e1', label: 'Entry 1', savedAt: Date.now() }],
      })

      render(<DataModal {...makeProps()} />)

      await waitFor(() => {
        expect(screen.getByTestId('data-modal-fav-list')).toBeInTheDocument()
      })

      fireEvent.click(screen.getByTestId('data-modal-fav-entry-label'))
      expect(screen.getByTestId('data-modal-fav-rename-input')).toBeInTheDocument()
    })

    it('commits rename on blur (clicking outside)', async () => {
      mockFavoriteStoreList.mockResolvedValueOnce({
        success: true,
        entries: [{ id: 'e1', label: 'Entry 1', savedAt: Date.now() }],
      })

      render(<DataModal {...makeProps()} />)
      await waitFor(() => {
        expect(screen.getByTestId('data-modal-fav-list')).toBeInTheDocument()
      })

      fireEvent.click(screen.getByTestId('data-modal-fav-entry-label'))
      const input = screen.getByTestId('data-modal-fav-rename-input')
      fireEvent.change(input, { target: { value: 'Changed' } })
      fireEvent.blur(input)

      expect(screen.queryByTestId('data-modal-fav-rename-input')).not.toBeInTheDocument()
      expect(mockFavoriteStoreRename).toHaveBeenCalledWith('tapDance', 'e1', 'Changed')
    })

    it('cancels rename on Escape', async () => {
      mockFavoriteStoreList.mockResolvedValueOnce({
        success: true,
        entries: [{ id: 'e1', label: 'Entry 1', savedAt: Date.now() }],
      })

      render(<DataModal {...makeProps()} />)
      await waitFor(() => {
        expect(screen.getByTestId('data-modal-fav-list')).toBeInTheDocument()
      })

      fireEvent.click(screen.getByTestId('data-modal-fav-entry-label'))
      const input = screen.getByTestId('data-modal-fav-rename-input')
      fireEvent.change(input, { target: { value: 'Changed' } })
      fireEvent.keyDown(input, { key: 'Escape' })

      expect(screen.queryByTestId('data-modal-fav-rename-input')).not.toBeInTheDocument()
      expect(mockFavoriteStoreRename).not.toHaveBeenCalled()
    })

    describe('confirm flash', () => {
      afterEach(() => {
        vi.useRealTimers()
        vi.restoreAllMocks()
      })

      it('shows confirm flash on card after Enter rename', async () => {
        vi.useFakeTimers()
        mockFavoriteStoreList.mockResolvedValueOnce({
          success: true,
          entries: [{ id: 'e1', label: 'Entry 1', savedAt: Date.now() }],
        })
        mockFavoriteStoreRename.mockResolvedValueOnce({ success: true })

        render(<DataModal {...makeProps()} />)
        await vi.waitFor(() => {
          expect(screen.getByTestId('data-modal-fav-list')).toBeInTheDocument()
        })

        fireEvent.click(screen.getByTestId('data-modal-fav-entry-label'))
        const input = screen.getByTestId('data-modal-fav-rename-input')
        fireEvent.change(input, { target: { value: 'New Name' } })
        fireEvent.keyDown(input, { key: 'Enter' })

        act(() => { vi.advanceTimersByTime(0) })

        const card = screen.getByTestId('data-modal-fav-entry')
        expect(card.className).toContain('confirm-flash')

        act(() => { vi.advanceTimersByTime(1200) })
        expect(card.className).not.toContain('confirm-flash')
      })

      it('does not flash when Enter is pressed without changes', async () => {
        vi.useFakeTimers()
        mockFavoriteStoreList.mockResolvedValueOnce({
          success: true,
          entries: [{ id: 'e1', label: 'Entry 1', savedAt: Date.now() }],
        })

        render(<DataModal {...makeProps()} />)
        await vi.waitFor(() => {
          expect(screen.getByTestId('data-modal-fav-list')).toBeInTheDocument()
        })

        fireEvent.click(screen.getByTestId('data-modal-fav-entry-label'))
        const input = screen.getByTestId('data-modal-fav-rename-input')
        fireEvent.keyDown(input, { key: 'Enter' })

        act(() => { vi.advanceTimersByTime(0) })

        expect(mockFavoriteStoreRename).not.toHaveBeenCalled()
        const card = screen.getByTestId('data-modal-fav-entry')
        expect(card.className).not.toContain('confirm-flash')
      })
    })

    it('shows delete confirmation when delete button is clicked', async () => {
      mockFavoriteStoreList.mockResolvedValueOnce({
        success: true,
        entries: [{ id: 'e1', label: 'Entry 1', savedAt: Date.now() }],
      })

      render(<DataModal {...makeProps()} />)

      await waitFor(() => {
        expect(screen.getByTestId('data-modal-fav-list')).toBeInTheDocument()
      })

      fireEvent.click(screen.getByTestId('data-modal-fav-delete-btn'))
      expect(screen.getByTestId('data-modal-fav-delete-confirm')).toBeInTheDocument()
      expect(screen.getByTestId('data-modal-fav-delete-cancel')).toBeInTheDocument()
    })

    it('calls onFavRenameOnHub after renaming an entry with hubPostId', async () => {
      const onFavRenameOnHub = vi.fn()
      mockFavoriteStoreList.mockResolvedValueOnce({
        success: true,
        entries: [{ id: 'e1', label: 'Entry 1', savedAt: Date.now(), hubPostId: 'hub-post-42' }],
      })
      mockFavoriteStoreRename.mockResolvedValueOnce({ success: true })
      // After rename, refreshEntries is called
      mockFavoriteStoreList.mockResolvedValueOnce({
        success: true,
        entries: [{ id: 'e1', label: 'New Hub Name', savedAt: Date.now(), hubPostId: 'hub-post-42' }],
      })

      render(<DataModal {...makeProps({ onFavRenameOnHub })} />)
      await waitFor(() => {
        expect(screen.getByTestId('data-modal-fav-list')).toBeInTheDocument()
      })

      fireEvent.click(screen.getByTestId('data-modal-fav-entry-label'))
      const input = screen.getByTestId('data-modal-fav-rename-input')
      fireEvent.change(input, { target: { value: 'New Hub Name' } })
      fireEvent.keyDown(input, { key: 'Enter' })

      await waitFor(() => {
        expect(onFavRenameOnHub).toHaveBeenCalledWith('e1', 'hub-post-42', 'New Hub Name')
      })
    })

    it('does not call onFavRenameOnHub when entry has no hubPostId', async () => {
      const onFavRenameOnHub = vi.fn()
      mockFavoriteStoreList.mockResolvedValueOnce({
        success: true,
        entries: [{ id: 'e1', label: 'Entry 1', savedAt: Date.now() }],
      })
      mockFavoriteStoreRename.mockResolvedValueOnce({ success: true })
      // After rename, refreshEntries is called
      mockFavoriteStoreList.mockResolvedValueOnce({
        success: true,
        entries: [{ id: 'e1', label: 'Renamed', savedAt: Date.now() }],
      })

      render(<DataModal {...makeProps({ onFavRenameOnHub })} />)
      await waitFor(() => {
        expect(screen.getByTestId('data-modal-fav-list')).toBeInTheDocument()
      })

      fireEvent.click(screen.getByTestId('data-modal-fav-entry-label'))
      const input = screen.getByTestId('data-modal-fav-rename-input')
      fireEvent.change(input, { target: { value: 'Renamed' } })
      fireEvent.keyDown(input, { key: 'Enter' })

      await waitFor(() => {
        expect(mockFavoriteStoreRename).toHaveBeenCalledWith('tapDance', 'e1', 'Renamed')
      })
      expect(onFavRenameOnHub).not.toHaveBeenCalled()
    })
  })

  describe('hub post tab', () => {
    const HUB_PROPS = { hubEnabled: true, hubAuthenticated: true } as const

    it('shows no posts message when authenticated with no posts', () => {
      render(<DataModal {...makeProps(HUB_PROPS)} />)

      fireEvent.click(screen.getByTestId('data-modal-tab-hubPost'))
      expect(screen.getByTestId('hub-no-posts')).toBeInTheDocument()
    })

    it('renders post list when authenticated with posts', () => {
      const posts = [
        { id: 'p1', title: 'My Layout 1', keyboard_name: 'BoardA', created_at: '2025-01-15T10:30:00Z' },
        { id: 'p2', title: 'My Layout 2', keyboard_name: 'BoardB', created_at: '2025-02-20T14:00:00Z' },
      ]
      render(<DataModal {...makeProps({ ...HUB_PROPS, hubPosts: posts })} />)

      fireEvent.click(screen.getByTestId('data-modal-tab-hubPost'))

      expect(screen.getByTestId('hub-post-p1')).toBeInTheDocument()
      expect(screen.getByTestId('hub-post-p2')).toBeInTheDocument()
      expect(screen.getByTestId('hub-post-p1')).toHaveTextContent('My Layout 1')
      expect(screen.getByTestId('hub-post-p2')).toHaveTextContent('My Layout 2')
    })

    it('shows pagination controls when total_pages > 1', () => {
      const posts = [{ id: 'p1', title: 'Layout 1', keyboard_name: 'Board', created_at: '2025-01-15T10:30:00Z' }]
      const pagination = { total: 25, page: 1, per_page: 10, total_pages: 3 }
      render(<DataModal {...makeProps({ ...HUB_PROPS, hubPosts: posts, hubPostsPagination: pagination })} />)

      fireEvent.click(screen.getByTestId('data-modal-tab-hubPost'))

      expect(screen.getByTestId('hub-pagination')).toBeInTheDocument()
      expect(screen.getByTestId('hub-page-prev')).toBeDisabled()
      expect(screen.getByTestId('hub-page-next')).not.toBeDisabled()
    })

    it('calls onHubRefresh when next page is clicked', () => {
      const onHubRefresh = vi.fn().mockResolvedValue(undefined)
      const posts = [{ id: 'p1', title: 'Layout 1', keyboard_name: 'Board', created_at: '2025-01-15T10:30:00Z' }]
      const pagination = { total: 25, page: 1, per_page: 10, total_pages: 3 }
      render(<DataModal {...makeProps({ ...HUB_PROPS, hubPosts: posts, hubPostsPagination: pagination, onHubRefresh })} />)

      fireEvent.click(screen.getByTestId('data-modal-tab-hubPost'))
      fireEvent.click(screen.getByTestId('hub-page-next'))

      expect(onHubRefresh).toHaveBeenCalledWith({ page: 2, per_page: 10 })
    })

    it('enters rename mode and submits on Enter', async () => {
      const onHubRename = vi.fn().mockResolvedValue(undefined)
      const posts = [{ id: 'p1', title: 'My Layout', keyboard_name: 'TestBoard', created_at: '2025-01-15T10:30:00Z' }]
      render(<DataModal {...makeProps({ ...HUB_PROPS, hubPosts: posts, onHubRename })} />)

      fireEvent.click(screen.getByTestId('data-modal-tab-hubPost'))
      fireEvent.click(screen.getByTestId('hub-title-p1'))

      const input = screen.getByTestId('hub-rename-input-p1')
      expect(input).toHaveValue('My Layout')
      fireEvent.change(input, { target: { value: 'New Name' } })
      fireEvent.keyDown(input, { key: 'Enter' })

      await waitFor(() => {
        expect(onHubRename).toHaveBeenCalledWith('p1', 'New Name')
      })
    })

    it('cancels rename on Escape', () => {
      const posts = [{ id: 'p1', title: 'My Layout', keyboard_name: 'TestBoard', created_at: '2025-01-15T10:30:00Z' }]
      render(<DataModal {...makeProps({ ...HUB_PROPS, hubPosts: posts })} />)

      fireEvent.click(screen.getByTestId('data-modal-tab-hubPost'))
      fireEvent.click(screen.getByTestId('hub-title-p1'))
      expect(screen.getByTestId('hub-rename-input-p1')).toBeInTheDocument()

      fireEvent.keyDown(screen.getByTestId('hub-rename-input-p1'), { key: 'Escape' })
      expect(screen.queryByTestId('hub-rename-input-p1')).not.toBeInTheDocument()
    })

    it('commits hub post rename on blur', () => {
      const onHubRename = vi.fn().mockResolvedValue(undefined)
      const posts = [{ id: 'p1', title: 'My Layout', keyboard_name: 'TestBoard', created_at: '2025-01-15T10:30:00Z' }]
      render(<DataModal {...makeProps({ ...HUB_PROPS, hubPosts: posts, onHubRename })} />)

      fireEvent.click(screen.getByTestId('data-modal-tab-hubPost'))
      fireEvent.click(screen.getByTestId('hub-title-p1'))
      const input = screen.getByTestId('hub-rename-input-p1')
      fireEvent.change(input, { target: { value: 'Changed Title' } })
      fireEvent.blur(input)

      expect(screen.queryByTestId('hub-rename-input-p1')).not.toBeInTheDocument()
      expect(onHubRename).toHaveBeenCalledWith('p1', 'Changed Title')
    })

    describe('hub post confirm flash', () => {
      afterEach(() => {
        vi.useRealTimers()
        vi.restoreAllMocks()
      })

      it('shows confirm flash after hub post Enter rename', async () => {
        vi.useFakeTimers()
        const onHubRename = vi.fn().mockResolvedValue(undefined)
        const posts = [{ id: 'p1', title: 'My Layout', keyboard_name: 'TestBoard', created_at: '2025-01-15T10:30:00Z' }]
        render(<DataModal {...makeProps({ ...HUB_PROPS, hubPosts: posts, onHubRename })} />)

        fireEvent.click(screen.getByTestId('data-modal-tab-hubPost'))
        fireEvent.click(screen.getByTestId('hub-title-p1'))
        const input = screen.getByTestId('hub-rename-input-p1')
        fireEvent.change(input, { target: { value: 'New Title' } })
        fireEvent.keyDown(input, { key: 'Enter' })

        // Flush the async handleSubmitRename (awaits onRename)
        await act(async () => {})

        // Flash class should NOT be present before deferred tick fires
        const postEl = screen.getByTestId('hub-post-p1')
        expect(postEl.querySelector('.confirm-flash')).toBeNull()

        act(() => { vi.advanceTimersByTime(0) })

        const titleSpan = postEl.querySelector('.confirm-flash')
        expect(titleSpan).not.toBeNull()

        act(() => { vi.advanceTimersByTime(1200) })
        expect(postEl.querySelector('.confirm-flash')).toBeNull()
      })

      it('does not flash hub post when Enter is pressed without changes', () => {
        vi.useFakeTimers()
        const onHubRename = vi.fn().mockResolvedValue(undefined)
        const posts = [{ id: 'p1', title: 'My Layout', keyboard_name: 'TestBoard', created_at: '2025-01-15T10:30:00Z' }]
        render(<DataModal {...makeProps({ ...HUB_PROPS, hubPosts: posts, onHubRename })} />)

        fireEvent.click(screen.getByTestId('data-modal-tab-hubPost'))
        fireEvent.click(screen.getByTestId('hub-title-p1'))
        const input = screen.getByTestId('hub-rename-input-p1')
        fireEvent.keyDown(input, { key: 'Enter' })

        act(() => { vi.advanceTimersByTime(0) })

        expect(onHubRename).not.toHaveBeenCalled()
        const postEl = screen.getByTestId('hub-post-p1')
        expect(postEl.querySelector('.confirm-flash')).toBeNull()
      })
    })

    it('shows error when rename fails', async () => {
      const onHubRename = vi.fn().mockRejectedValue(new Error('Rename failed'))
      const posts = [{ id: 'p1', title: 'My Layout', keyboard_name: 'TestBoard', created_at: '2025-01-15T10:30:00Z' }]
      render(<DataModal {...makeProps({ ...HUB_PROPS, hubPosts: posts, onHubRename })} />)

      fireEvent.click(screen.getByTestId('data-modal-tab-hubPost'))
      fireEvent.click(screen.getByTestId('hub-title-p1'))
      const input = screen.getByTestId('hub-rename-input-p1')
      fireEvent.change(input, { target: { value: 'New Name' } })
      fireEvent.keyDown(input, { key: 'Enter' })

      await waitFor(() => {
        expect(screen.getByTestId('hub-error-p1')).toHaveTextContent('hub.renameFailed')
      })
    })

    it('shows delete confirmation and calls onHubDelete when confirmed', async () => {
      const onHubDelete = vi.fn().mockResolvedValue(undefined)
      const posts = [{ id: 'p1', title: 'My Layout', keyboard_name: 'TestBoard', created_at: '2025-01-15T10:30:00Z' }]
      render(<DataModal {...makeProps({ ...HUB_PROPS, hubPosts: posts, onHubDelete })} />)

      fireEvent.click(screen.getByTestId('data-modal-tab-hubPost'))
      fireEvent.click(screen.getByTestId('hub-delete-p1'))
      expect(screen.getByTestId('hub-confirm-delete-p1')).toBeInTheDocument()

      fireEvent.click(screen.getByTestId('hub-confirm-delete-p1'))
      await waitFor(() => {
        expect(onHubDelete).toHaveBeenCalledWith('p1')
      })
    })

    it('cancels delete confirmation', () => {
      const onHubDelete = vi.fn()
      const posts = [{ id: 'p1', title: 'My Layout', keyboard_name: 'TestBoard', created_at: '2025-01-15T10:30:00Z' }]
      render(<DataModal {...makeProps({ ...HUB_PROPS, hubPosts: posts, onHubDelete })} />)

      fireEvent.click(screen.getByTestId('data-modal-tab-hubPost'))
      fireEvent.click(screen.getByTestId('hub-delete-p1'))
      fireEvent.click(screen.getByTestId('hub-cancel-delete-p1'))

      expect(screen.queryByTestId('hub-confirm-delete-p1')).not.toBeInTheDocument()
      expect(onHubDelete).not.toHaveBeenCalled()
    })

    it('shows error when delete fails', async () => {
      const onHubDelete = vi.fn().mockRejectedValue(new Error('Delete failed'))
      const posts = [{ id: 'p1', title: 'My Layout', keyboard_name: 'TestBoard', created_at: '2025-01-15T10:30:00Z' }]
      render(<DataModal {...makeProps({ ...HUB_PROPS, hubPosts: posts, onHubDelete })} />)

      fireEvent.click(screen.getByTestId('data-modal-tab-hubPost'))
      fireEvent.click(screen.getByTestId('hub-delete-p1'))
      fireEvent.click(screen.getByTestId('hub-confirm-delete-p1'))

      await waitFor(() => {
        expect(screen.getByTestId('hub-error-p1')).toHaveTextContent('hub.deleteFailed')
      })
    })

    it('shows open in browser button when hubOrigin is provided', () => {
      const posts = [{ id: 'p1', title: 'My Layout', keyboard_name: 'TestBoard', created_at: '2025-01-15T10:30:00Z' }]
      render(<DataModal {...makeProps({ ...HUB_PROPS, hubPosts: posts, hubOrigin: 'https://hub.example.com' })} />)

      fireEvent.click(screen.getByTestId('data-modal-tab-hubPost'))
      expect(screen.getByTestId('hub-open-p1')).toBeInTheDocument()
    })

    it('does not show open in browser button when hubOrigin is undefined', () => {
      const posts = [{ id: 'p1', title: 'My Layout', keyboard_name: 'TestBoard', created_at: '2025-01-15T10:30:00Z' }]
      render(<DataModal {...makeProps({ ...HUB_PROPS, hubPosts: posts })} />)

      fireEvent.click(screen.getByTestId('data-modal-tab-hubPost'))
      expect(screen.queryByTestId('hub-open-p1')).not.toBeInTheDocument()
    })

    it('calls openExternal with correct URL when open button is clicked', () => {
      const posts = [{ id: 'p1', title: 'My Layout', keyboard_name: 'TestBoard', created_at: '2025-01-15T10:30:00Z' }]
      render(<DataModal {...makeProps({ ...HUB_PROPS, hubPosts: posts, hubOrigin: 'https://hub.example.com' })} />)

      fireEvent.click(screen.getByTestId('data-modal-tab-hubPost'))
      fireEvent.click(screen.getByTestId('hub-open-p1'))

      expect(mockOpenExternal).toHaveBeenCalledWith('https://hub.example.com/post/p1')
    })

    it('does not show pagination when total_pages is 1', () => {
      const posts = [{ id: 'p1', title: 'Layout 1', keyboard_name: 'Board', created_at: '2025-01-15T10:30:00Z' }]
      const pagination = { total: 1, page: 1, per_page: 10, total_pages: 1 }
      render(<DataModal {...makeProps({ ...HUB_PROPS, hubPosts: posts, hubPostsPagination: pagination })} />)

      fireEvent.click(screen.getByTestId('data-modal-tab-hubPost'))

      expect(screen.getByTestId('hub-post-list')).toBeInTheDocument()
      expect(screen.queryByTestId('hub-pagination')).not.toBeInTheDocument()
    })

    it('disables Next on last page', () => {
      const posts = [{ id: 'p1', title: 'Layout 1', keyboard_name: 'Board', created_at: '2025-01-15T10:30:00Z' }]
      const pagination = { total: 25, page: 3, per_page: 10, total_pages: 3 }
      render(<DataModal {...makeProps({ ...HUB_PROPS, hubPosts: posts, hubPostsPagination: pagination })} />)

      fireEvent.click(screen.getByTestId('data-modal-tab-hubPost'))

      expect(screen.getByTestId('hub-page-next')).toBeDisabled()
      expect(screen.getByTestId('hub-page-prev')).not.toBeDisabled()
    })
  })
})
