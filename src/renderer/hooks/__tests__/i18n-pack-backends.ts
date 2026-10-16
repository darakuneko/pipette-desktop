// SPDX-License-Identifier: GPL-2.0-or-later
// The two vialAPI implementations the language pack hooks' tests run
// against, both answering from the same VialAPI-shaped spies: a
// preload-like mock (the spies themselves), and the Tauri shim's language
// pack members over a mocked Tauri IPC, whose commands hand the spies their
// arguments in the members' order.
//
// For the shim, the import dialog's answer crosses as each file's text: a
// file the spy answers with `raw` crosses as the JSON of it, and one with a
// `parseError` as a file that could not be read, with that error.

import { mockIPC } from '@tauri-apps/api/mocks'
import type { I18nPackImportDialogResult } from '../../../shared/types/i18n-store'
import type { VialAPI } from '../../../shared/types/vial-api'
import { i18nPacksApi } from '../../../tauri-shim/api/i18n-packs'
import type { PackImportRead } from '../../../tauri-shim/generated/PackImportRead'

type Spy = (...args: unknown[]) => unknown
type I18nPackMember = Extract<keyof VialAPI, `i18nPack${string}`>
export type I18nPackSpies = Partial<Record<I18nPackMember, Spy>>

export interface I18nPackBackend {
  name: string
  /** The members to put on `window.vialAPI`. */
  install: () => Partial<VialAPI>
}

function spy(spies: I18nPackSpies, member: I18nPackMember): Spy {
  const found = spies[member]
  if (!found) throw new Error(`no spy for ${member}`)
  return found
}

/** The dialog's answer as the backend sends it. */
function asRead(result: I18nPackImportDialogResult): PackImportRead {
  return {
    canceled: result.canceled,
    files: result.files.map((file) =>
      file.raw === undefined
        ? { filePath: file.filePath, readError: file.parseError }
        : { filePath: file.filePath, text: JSON.stringify(file.raw), fileSizeBytes: file.fileSizeBytes },
    ),
  }
}

function parse(text: unknown): unknown {
  return typeof text === 'string' ? JSON.parse(text) : undefined
}

/** The Tauri shim's members over a mocked backend. */
function installShim(spies: I18nPackSpies): Partial<VialAPI> {
  mockIPC(
    async (cmd, payload) => {
      const a = payload as Record<string, unknown>
      switch (cmd) {
        case 'i18n_pack_store_list': return spy(spies, 'i18nPackList')()
        case 'i18n_pack_store_get': return spy(spies, 'i18nPackGet')(a.id)
        case 'i18n_pack_store_rename': return spy(spies, 'i18nPackRename')(a.id, a.newName)
        case 'i18n_pack_store_set_enabled': return spy(spies, 'i18nPackSetEnabled')(a.id, a.enabled)
        case 'i18n_pack_store_refresh_coverage': return spy(spies, 'i18nPackRefreshCoverage')(a.id, a.values)
        case 'i18n_pack_store_delete': return spy(spies, 'i18nPackDelete')(a.id)
        case 'i18n_pack_store_set_hub_post_id':
          return spy(spies, 'i18nPackSetHubPostId')(a.id, a.hubPostId, a.uploaderName, a.hubUpdatedAt)
        case 'i18n_pack_store_has_name': return spy(spies, 'i18nPackHasName')(a.name, a.excludeId)
        case 'i18n_pack_store_reorder': return spy(spies, 'i18nPackReorder')(a.orderedIds)
        case 'i18n_pack_import':
          return asRead((await spy(spies, 'i18nPackImport')()) as I18nPackImportDialogResult)
        case 'i18n_pack_import_apply': return spy(spies, 'i18nPackImportApply')(parse(a.raw), parse(a.options))
        case 'i18n_pack_export': return spy(spies, 'i18nPackExport')(a.id)
        default: throw new Error(`unexpected command ${cmd}`)
      }
    },
    { shouldMockEvents: true },
  )
  return { ...i18nPacksApi }
}

export function i18nPackBackends(spies: I18nPackSpies): I18nPackBackend[] {
  return [
    { name: 'preload-like mock', install: () => ({ i18nPackOnChanged: () => () => undefined, ...spies }) as Partial<VialAPI> },
    { name: 'Tauri shim over mockIPC', install: () => installShim(spies) },
  ]
}
