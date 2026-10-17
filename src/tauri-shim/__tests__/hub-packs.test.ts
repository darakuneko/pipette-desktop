// SPDX-License-Identifier: GPL-2.0-or-later
// @vitest-environment jsdom
// The language and theme pack Hub members over the mocked Tauri IPC: the
// pack of an upload or update crosses as the text of `JSON.stringify` (key
// order kept, `undefined` as null), the other parameters as they are, a
// value that is not an object goes as it is for the backend to refuse, and
// the answers come back untouched.

import { afterEach, describe, expect, it } from 'vitest'
import { clearMocks, mockIPC } from '@tauri-apps/api/mocks'
import { hubPacksApi, packArgs } from '../api/hub-packs'

afterEach(() => {
  clearMocks()
})

function recordingBackend(answer: unknown): Array<{ cmd: string; payload: unknown }> {
  const calls: Array<{ cmd: string; payload: unknown }> = []
  mockIPC((cmd, payload) => {
    calls.push({ cmd, payload })
    return answer
  })
  return calls
}

describe('hubPacksApi', () => {
  it('sends the pack of an upload as JSON text in its key order', async () => {
    const calls = recordingBackend({ success: true, postId: 'p1' })
    const pack = { name: 'Japanese', version: '1.2.0', z: 'last', a: 'first', 1: 'one' }
    const answer = await hubPacksApi.hubUploadI18nPost({ entryId: 'pack-ja', pack })
    expect(answer).toEqual({ success: true, postId: 'p1' })
    expect(calls).toEqual([
      {
        cmd: 'hub_upload_i18n_post',
        payload: { params: { entryId: 'pack-ja' }, pack: '{"1":"one","name":"Japanese","version":"1.2.0","z":"last","a":"first"}' },
      },
    ])
  })

  it('sends the post id of an update with the other parameters', async () => {
    const calls = recordingBackend({ success: true, postId: 'p1' })
    await hubPacksApi.hubUpdateThemePost({ entryId: 't1', postId: 'p1', pack: { name: 'Nord', version: '1.0.0', colorScheme: 'dark', colors: {} } })
    expect(calls[0]).toEqual({
      cmd: 'hub_update_theme_post',
      payload: { params: { entryId: 't1', postId: 'p1' }, pack: '{"name":"Nord","version":"1.0.0","colorScheme":"dark","colors":{}}' },
    })
  })

  it('leaves the refusal of a value that is not an object to the backend', () => {
    expect(packArgs(null)).toEqual({ params: null, pack: null })
    expect(packArgs(undefined)).toEqual({ params: null, pack: null })
    expect(packArgs('params')).toEqual({ params: 'params', pack: null })
    expect(packArgs({ entryId: 'x' })).toEqual({ params: { entryId: 'x' }, pack: null })
    expect(packArgs({ entryId: 'x', pack: null })).toEqual({ params: { entryId: 'x' }, pack: 'null' })
  })

  it('passes the list, download, delete and timestamps arguments by name', async () => {
    const calls = recordingBackend({ success: false, error: 'x' })
    await hubPacksApi.hubListThemePosts({ q: 'nord', page: 2 })
    await hubPacksApi.hubDownloadI18nPost('p1')
    await hubPacksApi.hubDeleteI18nPost('p1', 'pack-ja')
    await hubPacksApi.themePackHubTimestamps(['a', 'b'])
    expect(calls).toEqual([
      { cmd: 'hub_list_theme_posts', payload: { params: { q: 'nord', page: 2 } } },
      { cmd: 'hub_download_i18n_post', payload: { postId: 'p1' } },
      { cmd: 'hub_delete_i18n_post', payload: { postId: 'p1', localPackId: 'pack-ja' } },
      { cmd: 'theme_pack_hub_timestamps', payload: { ids: ['a', 'b'] } },
    ])
  })
})
