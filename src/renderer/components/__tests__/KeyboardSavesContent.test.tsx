// @vitest-environment jsdom
// SPDX-License-Identifier: GPL-2.0-or-later

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { KeyboardSavesContent } from '../data-modal/KeyboardSavesContent'
import type { UseSyncReturn } from '../../hooks/useSync'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, fallback?: string) => `t(${typeof fallback === 'string' ? fallback : key})`,
  }),
}))

vi.mock('../data-modal/useSnapshotActions', () => ({
  useSnapshotActions: () => ({}),
}))

const mockResetKeyboardData = vi.fn()
const mockSnapshotStoreList = vi.fn()
const mockFetchRemoteBundle = vi.fn()
Object.defineProperty(window, 'vialAPI', {
  value: {
    resetKeyboardData: mockResetKeyboardData,
    snapshotStoreList: mockSnapshotStoreList,
    syncFetchRemoteBundle: mockFetchRemoteBundle,
  },
  writable: true,
})

function syncMock(resetSyncTargets: UseSyncReturn['resetSyncTargets']): UseSyncReturn {
  return { resetSyncTargets } as UseSyncReturn
}

async function confirmDeleteAll(): Promise<void> {
  await waitFor(() => expect(screen.getByTestId('kb-saves-delete-all')).toBeInTheDocument())
  fireEvent.click(screen.getByTestId('kb-saves-delete-all'))
  fireEvent.click(screen.getByTestId('kb-saves-delete-all-confirm'))
}

describe('KeyboardSavesContent Delete All', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockSnapshotStoreList.mockResolvedValue({ success: true, entries: [] })
    mockFetchRemoteBundle.mockResolvedValue(null)
  })

  it('local: reports success through onDeleted', async () => {
    mockResetKeyboardData.mockResolvedValue({ success: true })
    const onDeleted = vi.fn()
    render(<KeyboardSavesContent source="local" uid="uid1" name="KB" onDeleted={onDeleted} />)
    await confirmDeleteAll()

    await waitFor(() => expect(onDeleted).toHaveBeenCalledTimes(1))
    expect(mockResetKeyboardData).toHaveBeenCalledWith('uid1')
    expect(screen.queryByTestId('kb-saves-delete-all-error')).not.toBeInTheDocument()
  })

  it('local: shows the refusal instead of succeeding', async () => {
    mockResetKeyboardData.mockResolvedValue({ success: false, error: 'sync.passwordChange.blockedByOtherDevice' })
    const onDeleted = vi.fn()
    render(<KeyboardSavesContent source="local" uid="uid1" name="KB" onDeleted={onDeleted} />)
    await confirmDeleteAll()

    await waitFor(() =>
      expect(screen.getByTestId('kb-saves-delete-all-error')).toHaveTextContent('t(sync.passwordChange.blockedByOtherDevice)'),
    )
    expect(onDeleted).not.toHaveBeenCalled()
    expect(screen.getByTestId('kb-saves-delete-all-confirm')).toBeInTheDocument()
  })

  it('sync: shows the refusal of resetSyncTargets instead of succeeding', async () => {
    const resetSyncTargets = vi.fn().mockResolvedValue({ success: false, error: 'sync.passwordChange.blockedLocal' })
    const onDeleted = vi.fn()
    render(<KeyboardSavesContent source="sync" uid="uid1" name="KB" sync={syncMock(resetSyncTargets)} onDeleted={onDeleted} />)
    await confirmDeleteAll()

    await waitFor(() =>
      expect(screen.getByTestId('kb-saves-delete-all-error')).toHaveTextContent('t(sync.passwordChange.blockedLocal)'),
    )
    expect(resetSyncTargets).toHaveBeenCalledWith({ keyboards: ['uid1'], favorites: false })
    expect(onDeleted).not.toHaveBeenCalled()
  })

  it('shows a generic error when the call throws, and cancel clears it', async () => {
    mockResetKeyboardData.mockRejectedValue(new Error('ipc'))
    render(<KeyboardSavesContent source="local" uid="uid1" name="KB" />)
    await confirmDeleteAll()

    await waitFor(() => expect(screen.getByTestId('kb-saves-delete-all-error')).toHaveTextContent('t(statusBar.sync.error)'))
    fireEvent.click(screen.getByTestId('kb-saves-delete-all-cancel'))
    expect(screen.queryByTestId('kb-saves-delete-all-error')).not.toBeInTheDocument()
  })
})
