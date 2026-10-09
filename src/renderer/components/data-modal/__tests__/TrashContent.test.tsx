// SPDX-License-Identifier: GPL-2.0-or-later
// @vitest-environment jsdom

import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { TrashContent } from '../TrashContent'
import type { UseSyncReturn } from '../../../hooks/useSync'
import type { SyncTrashFile } from '../../../../shared/types/sync'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown> | string) =>
      typeof opts === 'object' && opts && 'date' in opts ? `${key}:${String(opts.date)}` : key,
  }),
}))

const FILE: SyncTrashFile = {
  fileId: 't1',
  originalName: 'favorites_macro.enc',
  syncUnit: 'favorites/macro',
  updatedAt: new Date(2026, 9, 1, 12, 30).getTime(),
  expiresAt: new Date(2026, 10, 8, 9, 5).getTime(),
  restorable: true,
}

type TrashSync = Pick<UseSyncReturn, 'listTrash' | 'restoreTrash' | 'deleteTrash'>

function makeSync(overrides?: Partial<TrashSync>): UseSyncReturn {
  return {
    listTrash: vi.fn().mockResolvedValue({ success: true, files: [FILE] }),
    restoreTrash: vi.fn().mockResolvedValue({ success: true }),
    deleteTrash: vi.fn().mockResolvedValue({ success: true, deleted: ['t1'], skipped: [] }),
    ...overrides,
  } as unknown as UseSyncReturn
}

describe('TrashContent', () => {
  it('lists Drive when it opens and shows the unit, the updated date and the auto-delete date', async () => {
    const sync = makeSync()
    render(<TrashContent sync={sync} />)

    expect(screen.getByText('sync.scanning')).toBeInTheDocument()
    await waitFor(() => expect(screen.getByTestId('trash-row-t1')).toBeInTheDocument())
    expect(sync.listTrash).toHaveBeenCalledTimes(1)
    expect(screen.getByText('favorites/macro')).toBeInTheDocument()
    expect(screen.getByText('sync.trash.updated:2026-10-01 12:30')).toBeInTheDocument()
    expect(screen.getByText('sync.trash.autoDelete:2026-11-08 09:05')).toBeInTheDocument()
  })

  it('falls back to the original name when the file has no sync unit', async () => {
    render(<TrashContent sync={makeSync({
      listTrash: vi.fn().mockResolvedValue({ success: true, files: [{ ...FILE, syncUnit: null }] }),
    })} />)

    await waitFor(() => expect(screen.getByText('favorites_macro.enc')).toBeInTheDocument())
  })

  it('shows the empty state', async () => {
    render(<TrashContent sync={makeSync({ listTrash: vi.fn().mockResolvedValue({ success: true, files: [] }) })} />)

    await waitFor(() => expect(screen.getByTestId('trash-empty')).toBeInTheDocument())
  })

  it('shows a listing failure without the empty state', async () => {
    render(<TrashContent sync={makeSync({
      listTrash: vi.fn().mockResolvedValue({ success: false, error: 'sync.updateRequired' }),
    })} />)

    await waitFor(() => expect(screen.getByTestId('trash-error')).toHaveTextContent('sync.updateRequired'))
    expect(screen.queryByTestId('trash-empty')).not.toBeInTheDocument()
  })

  it('restores with one click, then lists again', async () => {
    const sync = makeSync()
    render(<TrashContent sync={sync} />)
    await waitFor(() => expect(screen.getByTestId('trash-restore-t1')).toBeInTheDocument())

    fireEvent.click(screen.getByTestId('trash-restore-t1'))

    await waitFor(() => expect(sync.restoreTrash).toHaveBeenCalledWith('t1'))
    await waitFor(() => expect(sync.listTrash).toHaveBeenCalledTimes(2))
  })

  it('shows a restore refusal and still lists again', async () => {
    const sync = makeSync({ restoreTrash: vi.fn().mockResolvedValue({ success: false, error: 'sync.trashBusy' }) })
    render(<TrashContent sync={sync} />)
    await waitFor(() => expect(screen.getByTestId('trash-restore-t1')).toBeInTheDocument())

    fireEvent.click(screen.getByTestId('trash-restore-t1'))

    await waitFor(() => expect(screen.getByTestId('trash-error')).toHaveTextContent('sync.trashBusy'))
    expect(sync.listTrash).toHaveBeenCalledTimes(2)
  })

  it('deletes only after the second step, then lists again', async () => {
    const sync = makeSync()
    render(<TrashContent sync={sync} />)
    await waitFor(() => expect(screen.getByTestId('trash-delete-t1')).toBeInTheDocument())

    fireEvent.click(screen.getByTestId('trash-delete-t1'))
    expect(sync.deleteTrash).not.toHaveBeenCalled()
    expect(screen.queryByTestId('trash-restore-t1')).not.toBeInTheDocument()
    fireEvent.click(screen.getByTestId('trash-delete-confirm-t1'))

    await waitFor(() => expect(sync.deleteTrash).toHaveBeenCalledWith(['t1']))
    await waitFor(() => expect(sync.listTrash).toHaveBeenCalledTimes(2))
  })

  it('cancel returns to the row without deleting', async () => {
    const sync = makeSync()
    render(<TrashContent sync={sync} />)
    await waitFor(() => expect(screen.getByTestId('trash-delete-t1')).toBeInTheDocument())

    fireEvent.click(screen.getByTestId('trash-delete-t1'))
    fireEvent.click(screen.getByTestId('trash-delete-cancel-t1'))

    expect(screen.getByTestId('trash-restore-t1')).toBeInTheDocument()
    expect(sync.deleteTrash).not.toHaveBeenCalled()
  })

  it('offers only Delete for a file that cannot be restored', async () => {
    render(<TrashContent sync={makeSync({
      listTrash: vi.fn().mockResolvedValue({ success: true, files: [{ ...FILE, restorable: false }] }),
    })} />)

    await waitFor(() => expect(screen.getByTestId('trash-delete-t1')).toBeInTheDocument())
    expect(screen.queryByTestId('trash-restore-t1')).not.toBeInTheDocument()
  })

  it('says so when the file left Trash before the delete', async () => {
    const sync = makeSync({ deleteTrash: vi.fn().mockResolvedValue({ success: true, deleted: [], skipped: ['t1'] }) })
    render(<TrashContent sync={sync} />)
    await waitFor(() => expect(screen.getByTestId('trash-delete-t1')).toBeInTheDocument())

    fireEvent.click(screen.getByTestId('trash-delete-t1'))
    fireEvent.click(screen.getByTestId('trash-delete-confirm-t1'))

    await waitFor(() => expect(screen.getByTestId('trash-error')).toHaveTextContent('sync.trash.notFound'))
  })
})
