// SPDX-License-Identifier: GPL-2.0-or-later
// @vitest-environment jsdom

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { TypingAnalyticsContent } from '../data-modal/TypingAnalyticsContent'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}))

const summaries = [
  { date: '2026-10-01', keystrokes: 10, activeMs: 1_000 },
  { date: '2026-10-02', keystrokes: 20, activeMs: 2_000 },
]

const mockListItemsLocal = vi.fn()
const mockListItemsForHash = vi.fn()
const mockDeleteItems = vi.fn()
const mockDeleteAll = vi.fn()
const mockDeleteRemoteDays = vi.fn()
const mockImport = vi.fn()

Object.defineProperty(window, 'vialAPI', {
  value: {
    typingAnalyticsListItemsLocal: mockListItemsLocal,
    typingAnalyticsListItemsForHash: mockListItemsForHash,
    typingAnalyticsListRemoteCloudDays: vi.fn(async () => []),
    typingAnalyticsListLocalDeviceDays: vi.fn(async () => []),
    typingAnalyticsFetchRemoteDay: vi.fn(async () => true),
    typingAnalyticsDeleteItems: mockDeleteItems,
    typingAnalyticsDeleteAll: mockDeleteAll,
    typingAnalyticsDeleteRemoteDays: mockDeleteRemoteDays,
    typingAnalyticsImport: mockImport,
    typingAnalyticsExport: vi.fn(),
  },
  writable: true,
})

async function confirmDeleteAll(): Promise<void> {
  fireEvent.click(await screen.findByTestId('typing-delete-all'))
  fireEvent.click(screen.getByTestId('typing-delete-all-confirm'))
}

describe('TypingAnalyticsContent deletes', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockListItemsLocal.mockResolvedValue(summaries)
    mockListItemsForHash.mockResolvedValue(summaries)
    mockDeleteItems.mockResolvedValue({ success: true })
    mockDeleteAll.mockResolvedValue({ success: true })
    mockDeleteRemoteDays.mockResolvedValue({ success: true })
    mockImport.mockResolvedValue({ success: true, result: { imported: 0, rejections: [] }, cancelled: true })
  })

  it('shows the busy message and keeps the confirmation when the delete is refused', async () => {
    mockDeleteAll.mockResolvedValueOnce({ success: false, error: 'sync.deleteBusy' })
    const onDeleted = vi.fn()
    render(<TypingAnalyticsContent uid="uid1" onDeleted={onDeleted} />)

    await confirmDeleteAll()

    expect(await screen.findByTestId('typing-error')).toHaveTextContent('sync.deleteBusy')
    expect(screen.getByTestId('typing-delete-all-confirm')).toBeInTheDocument()
    expect(onDeleted).not.toHaveBeenCalled()
  })

  it('shows the fallback message when the delete call rejects', async () => {
    mockDeleteItems.mockRejectedValueOnce(new Error('ipc failed'))
    render(<TypingAnalyticsContent uid="uid1" />)

    fireEvent.click(await screen.findByLabelText('dataModal.typing.selectAll'))
    fireEvent.click(screen.getByTestId('typing-delete-selected'))
    fireEvent.click(screen.getByTestId('typing-delete-selected-confirm'))

    expect(await screen.findByTestId('typing-error')).toHaveTextContent('statusBar.sync.error')
  })

  it('clears the error and reports the delete when a retry succeeds', async () => {
    mockDeleteAll.mockResolvedValueOnce({ success: false, error: 'sync.deleteBusy' })
    const onDeleted = vi.fn()
    render(<TypingAnalyticsContent uid="uid1" onDeleted={onDeleted} />)
    await confirmDeleteAll()
    await screen.findByTestId('typing-error')

    fireEvent.click(screen.getByTestId('typing-delete-all-confirm'))

    await waitFor(() => expect(onDeleted).toHaveBeenCalledTimes(1))
    expect(screen.queryByTestId('typing-error')).toBeNull()
  })

  it('deletes every remote day with one call in the sync view', async () => {
    render(<TypingAnalyticsContent uid="uid1" mode="sync" machineHash="hash1" />)

    await confirmDeleteAll()

    await waitFor(() => expect(mockDeleteRemoteDays).toHaveBeenCalledTimes(1))
    expect(mockDeleteRemoteDays).toHaveBeenCalledWith('uid1', 'hash1', ['2026-10-01', '2026-10-02'])
  })

  it('shows the busy message when the import is refused', async () => {
    mockImport.mockResolvedValueOnce({ success: false, error: 'sync.importBusy' })
    render(<TypingAnalyticsContent uid="uid1" />)

    fireEvent.click(await screen.findByTestId('typing-import'))

    expect(await screen.findByTestId('typing-error')).toHaveTextContent('sync.importBusy')
    expect(screen.queryByTestId('typing-import-status')).toBeNull()
  })
})
