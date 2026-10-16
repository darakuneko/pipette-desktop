// SPDX-License-Identifier: GPL-2.0-or-later
// The two vialAPI implementations the theme pack hooks' tests run against,
// both answering from the same VialAPI-shaped spies: a preload-like mock
// (the spies themselves), and the Tauri shim's theme pack members over a
// mocked Tauri IPC, whose commands hand the spies their arguments in the
// members' order.
//
// Each backend also sends the main process's THEME_PACK_CHANGED broadcast
// its own way: the preload-like mock calls the callbacks given to
// `themePackOnChanged`, and the shim's backend emits `theme-pack:changed`.
// For the shim, the import dialog's answer crosses as each file's text
// (pack-backends.ts).

import { emit } from '@tauri-apps/api/event'
import { mockIPC } from '@tauri-apps/api/mocks'
import { IpcChannels } from '../../../shared/ipc/channels'
import type { ThemePackImportDialogResult } from '../../../shared/types/theme-store'
import type { VialAPI } from '../../../shared/types/vial-api'
import { themePacksApi } from '../../../tauri-shim/api/theme-packs'
import { asRead, parse } from './pack-backends'

type Spy = (...args: unknown[]) => unknown
type ThemePackMember = Exclude<Extract<keyof VialAPI, `themePack${string}`>, 'themePackOnChanged'>
export type ThemePackSpies = Partial<Record<ThemePackMember, Spy>>

export interface ThemePackBackend {
  name: string
  /** The members to put on `window.vialAPI`. */
  install: () => Partial<VialAPI>
  /** Sends the theme pack change broadcast. */
  broadcast: () => Promise<void>
}

function spy(spies: ThemePackSpies, member: ThemePackMember): Spy {
  const found = spies[member]
  if (!found) throw new Error(`no spy for ${member}`)
  return found
}

/** The Tauri shim's members over a mocked backend. */
function installShim(spies: ThemePackSpies): Partial<VialAPI> {
  mockIPC(
    async (cmd, payload) => {
      const a = payload as Record<string, unknown>
      switch (cmd) {
        case 'theme_pack_store_list': return spy(spies, 'themePackList')()
        case 'theme_pack_store_get': return spy(spies, 'themePackGet')(a.id)
        case 'theme_pack_store_rename': return spy(spies, 'themePackRename')(a.id, a.newName)
        case 'theme_pack_store_delete': return spy(spies, 'themePackDelete')(a.id)
        case 'theme_pack_store_set_hub_post_id':
          return spy(spies, 'themePackSetHubPostId')(a.id, a.hubPostId, a.uploaderName, a.hubUpdatedAt)
        case 'theme_pack_store_has_name': return spy(spies, 'themePackHasName')(a.name, a.excludeId)
        case 'theme_pack_store_reorder': return spy(spies, 'themePackReorder')(a.orderedIds)
        case 'theme_pack_import':
          return asRead((await spy(spies, 'themePackImport')()) as ThemePackImportDialogResult)
        case 'theme_pack_import_apply': return spy(spies, 'themePackImportApply')(parse(a.raw), parse(a.options))
        case 'theme_pack_export': return spy(spies, 'themePackExport')(a.id)
        default: throw new Error(`unexpected command ${cmd}`)
      }
    },
    { shouldMockEvents: true },
  )
  return { ...themePacksApi }
}

/** The preload-like mock: the spies, and `themePackOnChanged` keeping its
 *  callbacks for the broadcast. */
function preloadLike(spies: ThemePackSpies): ThemePackBackend {
  const callbacks = new Set<() => void>()
  return {
    name: 'preload-like mock',
    install: () => {
      callbacks.clear()
      const onChanged = (callback: () => void): (() => void) => {
        callbacks.add(callback)
        return () => callbacks.delete(callback)
      }
      return { ...spies, themePackOnChanged: onChanged } as Partial<VialAPI>
    },
    broadcast: async () => {
      for (const callback of [...callbacks]) callback()
    },
  }
}

export function themePackBackends(spies: ThemePackSpies): ThemePackBackend[] {
  return [
    preloadLike(spies),
    {
      name: 'Tauri shim over mockIPC',
      install: () => installShim(spies),
      broadcast: () => emit(IpcChannels.THEME_PACK_CHANGED),
    },
  ]
}
