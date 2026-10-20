// SPDX-License-Identifier: GPL-2.0-or-later
// The two vialAPI implementations the favorite hooks' tests run against,
// both answering from the same VialAPI-shaped spies: a plain mock
// (the spies themselves), and the Tauri shim's favorite members over a
// mocked Tauri IPC, whose commands and conversion worker hand the spies
// their arguments in the members' order. The test file must mock the
// worker client (src/tauri-shim/workers/favorite-transfer-client.ts) with
// a `transfer` spy, which this module drives.
//
// For the shim, an export calls its spy once the file is built (from the
// save command), and an import or an import into the editor calls its spy
// from the worker step, mapping the spy's answer onto what the backend and
// the worker would answer for it.

import { vi } from 'vitest'
import { mockIPC } from '@tauri-apps/api/mocks'
import type { VialAPI } from '../../../shared/types/vial-api'
import { favoritesApi } from '../../../tauri-shim/api/favorites'
import type { FavoriteTransferRequest } from '../../../tauri-shim/workers/favorite-transfer-requests'
import { transfer } from '../../../tauri-shim/workers/favorite-transfer-client'

type Spy = (...args: unknown[]) => unknown
type FavoriteMember = Extract<keyof VialAPI, `favoriteStore${string}`>
export type FavoriteSpies = Partial<Record<FavoriteMember, Spy>>

export interface FavoriteBackend {
  name: string
  install: () => void
}

function installVialAPI(members: object): void {
  window.vialAPI = { ...(window.vialAPI ?? {}), ...members } as unknown as typeof window.vialAPI
}

function spy(spies: FavoriteSpies, member: FavoriteMember): Spy {
  const found = spies[member]
  if (!found) throw new Error(`no spy for ${member}`)
  return found
}

/** The Tauri shim's members over a mocked backend and worker. */
function installShim(spies: FavoriteSpies): void {
  /** The export the worker last built, for the save command. */
  let exported: { member: FavoriteMember; args: unknown[] } | null = null
  let exportEntryId: unknown
  let importCounts = { imported: 0, skipped: 0 }

  vi.mocked(transfer).mockImplementation(async (request: FavoriteTransferRequest) => {
    switch (request.op) {
      case 'export': {
        const { scope, vialProtocol } = request
        const args = exportEntryId === undefined ? [scope, vialProtocol] : [scope, vialProtocol, exportEntryId]
        exported = { member: 'favoriteStoreExport', args }
        return { defaultFilename: 'f.json', content: '{}' }
      }
      case 'exportCurrent':
        exported = { member: 'favoriteStoreExportCurrent', args: [request.scope, request.vialProtocol, request.dataJson] }
        return { defaultFilename: 'f.json', content: '{}' }
      case 'importToCurrent': {
        const result = (await spy(spies, 'favoriteStoreImportToCurrent')(request.scope)) as { success: boolean; data?: unknown; error?: string }
        return result.success ? { data: result.data } : { error: result.error ?? '' }
      }
      case 'import': {
        const result = (await spy(spies, 'favoriteStoreImport')()) as { success: boolean; imported: number; skipped: number; error?: string }
        if (!result.success) return { error: result.error ?? '' }
        importCounts = { imported: result.imported, skipped: result.skipped }
        return { plan: { batches: [{ type: 'tapDance', entries: [] }], skipped: 0 } }
      }
      case 'hubExport':
        throw new Error('the favorite store members build no Hub post')
    }
  })

  mockIPC((cmd, payload) => {
    const a = payload as Record<string, unknown>
    switch (cmd) {
      case 'favorite_store_list': return spy(spies, 'favoriteStoreList')(a.favoriteType)
      case 'favorite_store_save': return spy(spies, 'favoriteStoreSave')(a.favoriteType, a.json, a.label)
      case 'favorite_store_load': return spy(spies, 'favoriteStoreLoad')(a.favoriteType, a.entryId)
      case 'favorite_store_rename': return spy(spies, 'favoriteStoreRename')(a.favoriteType, a.entryId, a.newLabel)
      case 'favorite_store_delete': return spy(spies, 'favoriteStoreDelete')(a.favoriteType, a.entryId)
      case 'favorite_store_read_for_export':
        exportEntryId = a.entryId
        return { success: true, entries: [] }
      case 'favorite_store_save_export': {
        if (!exported) throw new Error('no export was built')
        const { member, args } = exported
        exported = null
        exportEntryId = undefined
        return spy(spies, member)(...args)
      }
      case 'favorite_store_open_import': return { success: true, data: '{}' }
      case 'favorite_store_import_batch': return { success: true, ...importCounts }
      default: throw new Error(`unexpected command ${cmd}`)
    }
  })
  installVialAPI({ ...favoritesApi })
}

export function favoriteBackends(spies: FavoriteSpies): FavoriteBackend[] {
  return [
    { name: 'plain mock', install: () => installVialAPI(spies) },
    { name: 'Tauri shim over mockIPC', install: () => installShim(spies) },
  ]
}
