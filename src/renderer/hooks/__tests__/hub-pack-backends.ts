// SPDX-License-Identifier: GPL-2.0-or-later
// The two vialAPI implementations the language and theme pack modals'
// tests run against, both answering from the same VialAPI-shaped spies: a
// plain mock (the spies themselves), and the same spies with the
// Tauri shim's Hub pack members over a mocked Tauri IPC, whose commands
// hand the spies their arguments in the members' order. The pack of an
// upload or update crosses as JSON text and is parsed back here.

import { mockIPC } from '@tauri-apps/api/mocks'
import type { VialAPI } from '../../../shared/types/vial-api'
import { hubPacksApi } from '../../../tauri-shim/api/hub-packs'

type Spy = (...args: unknown[]) => unknown
type HubPackMember = keyof typeof hubPacksApi

export interface HubPackBackend {
  name: string
  /** The members to put on `window.vialAPI`. */
  install: () => Partial<VialAPI>
}

function spy(spies: Record<string, unknown>, member: HubPackMember): Spy {
  const found = spies[member]
  if (typeof found !== 'function') throw new Error(`no spy for ${member}`)
  return found as Spy
}

/** The parameters of an upload or update as the renderer passed them. */
function withPack(params: unknown, pack: unknown): unknown {
  if (!params || typeof params !== 'object') return params
  return typeof pack === 'string' ? { ...params, pack: JSON.parse(pack) as unknown } : params
}

/** The spies, with the shim's Hub pack members over a mocked backend. */
function installShim<T extends Record<string, unknown>>(spies: T): Partial<VialAPI> {
  mockIPC((cmd, payload) => {
    const a = payload as Record<string, unknown>
    switch (cmd) {
      case 'i18n_pack_hub_timestamps': return spy(spies, 'i18nPackHubTimestamps')(a.ids)
      case 'hub_list_i18n_posts': return spy(spies, 'hubListI18nPosts')(a.params)
      case 'hub_download_i18n_post': return spy(spies, 'hubDownloadI18nPost')(a.postId)
      case 'hub_upload_i18n_post': return spy(spies, 'hubUploadI18nPost')(withPack(a.params, a.pack))
      case 'hub_update_i18n_post': return spy(spies, 'hubUpdateI18nPost')(withPack(a.params, a.pack))
      case 'hub_delete_i18n_post': return spy(spies, 'hubDeleteI18nPost')(a.postId, a.localPackId)
      case 'theme_pack_hub_timestamps': return spy(spies, 'themePackHubTimestamps')(a.ids)
      case 'hub_list_theme_posts': return spy(spies, 'hubListThemePosts')(a.params)
      case 'hub_download_theme_post': return spy(spies, 'hubDownloadThemePost')(a.postId)
      case 'hub_upload_theme_post': return spy(spies, 'hubUploadThemePost')(withPack(a.params, a.pack))
      case 'hub_update_theme_post': return spy(spies, 'hubUpdateThemePost')(withPack(a.params, a.pack))
      case 'hub_delete_theme_post': return spy(spies, 'hubDeleteThemePost')(a.postId, a.localPackId)
      default: throw new Error(`unexpected command ${cmd}`)
    }
  })
  const shim: Record<string, unknown> = {}
  for (const member of Object.keys(hubPacksApi) as HubPackMember[]) {
    if (member in spies) shim[member] = hubPacksApi[member]
  }
  return { ...spies, ...shim } as Partial<VialAPI>
}

export function hubPackBackends<T extends Record<string, unknown>>(spies: T): HubPackBackend[] {
  return [
    { name: 'plain mock', install: () => spies as Partial<VialAPI> },
    { name: 'Tauri shim over mockIPC', install: () => installShim(spies) },
  ]
}
