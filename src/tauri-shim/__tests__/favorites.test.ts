// SPDX-License-Identifier: GPL-2.0-or-later
// @vitest-environment jsdom
// The favorite members over the mocked Tauri IPC, with the transfer worker
// answering in this module (its requests run as the worker runs them): the
// writes of a type reach the backend one at a time in the renderer's order,
// and the export and the import check, convert and answer.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { clearMocks, mockIPC } from '@tauri-apps/api/mocks'
import { runFavoriteTransfer } from '../workers/favorite-transfer-requests'

vi.mock('../workers/favorite-transfer-client', () => ({
  transfer: vi.fn((request: Parameters<typeof runFavoriteTransfer>[0]) => Promise.resolve(runFavoriteTransfer(request))),
}))

import { favoritesApi } from '../api/favorites'
import { transfer } from '../workers/favorite-transfer-client'

type Handler = (payload: Record<string, unknown>) => unknown

/** Answers each command with its handler and records the calls. */
function backend(handlers: Record<string, Handler>): [string, Record<string, unknown>][] {
  const calls: [string, Record<string, unknown>][] = []
  mockIPC((cmd, payload) => {
    const args = payload as Record<string, unknown>
    calls.push([cmd, args])
    const handler = handlers[cmd]
    if (!handler) throw new Error(`unexpected command ${cmd}`)
    return handler(args)
  })
  return calls
}

const NOW = new Date('2026-10-16T12:34:56.789Z')
const TD = { onTap: 4, onHold: 0, onDoubleTap: 0, onTapHold: 0, tappingTerm: 200 }
const tdBody = JSON.stringify({ type: 'tapDance', data: TD })

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(NOW)
})

afterEach(() => {
  vi.useRealTimers()
  vi.mocked(transfer).mockClear()
  clearMocks()
})

describe('favorite store writes', () => {
  it('sends the writes of one type one at a time, in order, and the reads at once', async () => {
    const log: string[] = []
    const releases: (() => void)[] = []
    backend({
      favorite_store_save: ({ label }) => {
        log.push(`start ${String(label)}`)
        return new Promise((resolve) => releases.push(() => resolve({ success: true })))
      },
      favorite_store_rename: ({ newLabel }) => {
        log.push(`start ${String(newLabel)}`)
        return { success: true }
      },
      favorite_store_list: () => {
        log.push('list')
        return { success: true, entries: [] }
      },
    })
    const save = favoritesApi.favoriteStoreSave('tapDance', '{}', 'a')
    const rename = favoritesApi.favoriteStoreRename('tapDance', 'id', 'b')
    const other = favoritesApi.favoriteStoreRename('macro', 'id', 'c')
    const list = favoritesApi.favoriteStoreList('tapDance')
    await list
    await other
    expect(log).toEqual(['list', 'start a', 'start c'])
    releases.shift()?.()
    await save
    await rename
    expect(log).toEqual(['list', 'start a', 'start c', 'start b'])
  })

  it('sends a private link as its JSON text and the other arguments as they are', async () => {
    const calls = backend({ favorite_store_set_hub_private: () => ({ success: true }), favorite_store_set_hub_post_id: () => ({ success: true }) })
    await favoritesApi.favoriteStoreSetHubPrivate('combo', 'id', { id: 'p', url: '/u', expiresAt: null })
    await favoritesApi.favoriteStoreSetHubPrivate('combo', 'id', null)
    await favoritesApi.favoriteStoreSetHubPostId('combo', 'id', null)
    expect(calls).toEqual([
      ['favorite_store_set_hub_private', { favoriteType: 'combo', entryId: 'id', link: '{"id":"p","url":"/u","expiresAt":null}' }],
      ['favorite_store_set_hub_private', { favoriteType: 'combo', entryId: 'id', link: 'null' }],
      ['favorite_store_set_hub_post_id', { favoriteType: 'combo', entryId: 'id', hubPostId: null }],
    ])
  })
})

describe('favoriteStoreExport', () => {
  it('reads the stored favorites, converts them and saves the file', async () => {
    const calls = backend({
      favorite_store_read_for_export: () => ({ success: true, entries: [{ label: 'A', savedAt: 's', body: tdBody }] }),
      favorite_store_save_export: () => ({ success: true, filePath: '/x.json' }),
    })
    await expect(favoritesApi.favoriteStoreExport('tapDance', 6)).resolves.toEqual({ success: true })
    expect(calls[0]).toEqual(['favorite_store_read_for_export', { favoriteType: 'tapDance' }])
    const [command, { defaultFilename, content }] = calls[1]
    expect(command).toBe('favorite_store_save_export')
    expect(defaultFilename).toBe('pipette-fav-td-2026-10-16-123456.json')
    expect(JSON.parse(content as string).categories.td[0]).toEqual({ label: 'A', savedAt: 's', data: { ...TD, onTap: 'KC_A', onHold: 'KC_NO', onDoubleTap: 'KC_NO', onTapHold: 'KC_NO' } })
  })

  it('checks its arguments before reading, as the handler does', async () => {
    const calls = backend({})
    await expect(favoritesApi.favoriteStoreExport('nope', 6)).resolves.toEqual({ success: false, error: 'Invalid scope' })
    await expect(favoritesApi.favoriteStoreExport('macro', Number.NaN)).resolves.toEqual({ success: false, error: 'Invalid vialProtocol' })
    await expect(favoritesApi.favoriteStoreExport('macro', 6, 5 as unknown as string)).resolves.toEqual({ success: false, error: 'Invalid entryId' })
    expect(calls).toEqual([])
  })

  it('answers the read failure, an unreadable single entry and a cancelled dialog', async () => {
    backend({ favorite_store_read_for_export: () => ({ success: false, error: 'Entry not found' }) })
    await expect(favoritesApi.favoriteStoreExport('macro', 6, 'x')).resolves.toEqual({ success: false, error: 'Entry not found' })

    const calls = backend({
      favorite_store_read_for_export: () => ({ success: true, entries: [{ label: 'A', savedAt: 's', body: '{' }] }),
      favorite_store_save_export: () => ({ success: false, error: 'cancelled' }),
    })
    await expect(favoritesApi.favoriteStoreExport('macro', 6, 'x')).resolves.toEqual({ success: false, error: 'Entry unreadable' })
    expect(calls.map(([cmd]) => cmd)).toEqual(['favorite_store_read_for_export'])
    await expect(favoritesApi.favoriteStoreExport('macro', 6)).resolves.toEqual({ success: false, error: 'cancelled' })
  })

  it('answers a failed command as the handler answers a thrown error', async () => {
    backend({ favorite_store_read_for_export: () => { throw 'task failed' } })
    await expect(favoritesApi.favoriteStoreExport('macro', 6)).resolves.toEqual({ success: false, error: 'Error: task failed' })
  })
})

describe('favoriteStoreExportCurrent', () => {
  it('converts the current value and saves it', async () => {
    const calls = backend({ favorite_store_save_export: () => ({ success: true, filePath: '/x.json' }) })
    await expect(favoritesApi.favoriteStoreExportCurrent('tapDance', 6, tdBody)).resolves.toEqual({ success: true })
    expect(calls[0][1].defaultFilename).toBe('pipette-fav-td-current-2026-10-16-123456.json')
  })

  it('answers the handler errors without saving', async () => {
    const calls = backend({})
    await expect(favoritesApi.favoriteStoreExportCurrent('tapDance', 6, 5 as unknown as string)).resolves.toEqual({ success: false, error: 'Invalid data' })
    await expect(favoritesApi.favoriteStoreExportCurrent('tapDance', 6, '{}')).resolves.toEqual({ success: false, error: 'Missing data field' })
    const notJson = await favoritesApi.favoriteStoreExportCurrent('tapDance', 6, 'nope')
    expect(notJson).toEqual({ success: false, error: expect.stringMatching(/^SyntaxError: /) })
    expect(calls).toEqual([])
  })
})

const exportFile = (categories: Record<string, unknown>): string =>
  JSON.stringify({ app: 'pipette', version: 3, scope: 'fav', exportedAt: 'x', vial_protocol: 6, categories })

describe('favoriteStoreImportToCurrent', () => {
  it('answers the first entry of the type with its keycodes as numbers', async () => {
    backend({ favorite_store_open_import: () => ({ success: true, data: exportFile({ td: [{ label: 'a', savedAt: 's', data: { ...TD, onTap: 'KC_B' } }] }), filePath: '/f' }) })
    await expect(favoritesApi.favoriteStoreImportToCurrent('tapDance')).resolves.toEqual({ success: true, data: { ...TD, onTap: 5 } })
    await expect(favoritesApi.favoriteStoreImportToCurrent('combo')).resolves.toEqual({ success: false, error: 'No matching data found for this type' })
  })

  it('answers a cancelled dialog, an invalid file and an invalid scope', async () => {
    backend({ favorite_store_open_import: () => ({ success: false, error: 'cancelled' }) })
    await expect(favoritesApi.favoriteStoreImportToCurrent('tapDance')).resolves.toEqual({ success: false, error: 'cancelled' })
    await expect(favoritesApi.favoriteStoreImportToCurrent('nope')).resolves.toEqual({ success: false, error: 'Invalid scope' })
    backend({ favorite_store_open_import: () => ({ success: true, data: '{"app":"x"}' }) })
    await expect(favoritesApi.favoriteStoreImportToCurrent('tapDance')).resolves.toEqual({ success: false, error: 'Invalid export file format' })
  })
})

describe('favoriteStoreImport', () => {
  const file = exportFile({
    td: [{ label: 'a', savedAt: 's1', data: TD }, { label: 'bad', savedAt: 's', data: {} }],
    macro: [{ label: 'm', savedAt: 's2', data: [['text', 'x']] }],
  })

  it('stores each type’s batch in the file’s order and adds up the counts', async () => {
    const calls = backend({
      favorite_store_open_import: () => ({ success: true, data: file }),
      favorite_store_import_batch: ({ favoriteType }) => ({ success: true, imported: 1, skipped: favoriteType === 'macro' ? 2 : 0 }),
    })
    await expect(favoritesApi.favoriteStoreImport()).resolves.toEqual({ success: true, imported: 2, skipped: 3 })
    expect(calls.slice(1)).toEqual([
      ['favorite_store_import_batch', { favoriteType: 'tapDance', entries: JSON.stringify([{ label: 'a', savedAt: 's1', body: JSON.stringify({ type: 'tapDance', data: TD }) }]) }],
      ['favorite_store_import_batch', { favoriteType: 'macro', entries: JSON.stringify([{ label: 'm', savedAt: 's2', body: JSON.stringify({ type: 'macro', data: [['text', 'x']] }) }]) }],
    ])
  })

  it('stops at a batch that fails and answers its error with no counts', async () => {
    const calls = backend({
      favorite_store_open_import: () => ({ success: true, data: file }),
      favorite_store_import_batch: () => ({ success: false, error: 'Error: disk full' }),
    })
    await expect(favoritesApi.favoriteStoreImport()).resolves.toEqual({ success: false, imported: 0, skipped: 0, error: 'Error: disk full' })
    expect(calls).toHaveLength(2)
  })

  it('stores the batches before a category that names no store, then fails', async () => {
    const calls = backend({
      favorite_store_open_import: () => ({ success: true, data: exportFile({ td: [], constructor: [] }) }),
      favorite_store_import_batch: () => ({ success: true, imported: 0, skipped: 0 }),
    })
    await expect(favoritesApi.favoriteStoreImport()).resolves.toEqual({ success: false, imported: 0, skipped: 0, error: 'Invalid favorite type' })
    expect(calls.map(([cmd]) => cmd)).toEqual(['favorite_store_open_import', 'favorite_store_import_batch'])
  })

  it('answers a cancelled dialog and a file that is not an export', async () => {
    backend({ favorite_store_open_import: () => ({ success: false, error: 'cancelled' }) })
    await expect(favoritesApi.favoriteStoreImport()).resolves.toEqual({ success: false, imported: 0, skipped: 0, error: 'cancelled' })
    backend({ favorite_store_open_import: () => ({ success: true, data: 'nope' }) })
    const result = await favoritesApi.favoriteStoreImport()
    expect(result).toEqual({ success: false, imported: 0, skipped: 0, error: expect.stringMatching(/^SyntaxError: /) })
  })
})
