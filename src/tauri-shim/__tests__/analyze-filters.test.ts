// SPDX-License-Identifier: GPL-2.0-or-later
// @vitest-environment jsdom
// The Analyze filter members over the mocked Tauri IPC: the writes of one
// keyboard reach the backend one at a time in call order, sharing the
// queue of the keyboard's other store writes, the reads do not wait, and a
// private Hub link crosses as its JSON text at the call.

import { afterEach, describe, expect, it } from 'vitest'
import { clearMocks, mockIPC } from '@tauri-apps/api/mocks'
import { analyzeFiltersApi } from '../api/analyze-filters'
import { snapshotsApi } from '../api/snapshots'

afterEach(() => {
  clearMocks()
})

async function settle(): Promise<void> {
  for (let i = 0; i < 10; i++) await Promise.resolve()
}

describe('analyzeFiltersApi', () => {
  it('sends the writes of one keyboard one at a time, after its snapshot writes, and reads at once', async () => {
    const log: string[] = []
    const releases: (() => void)[] = []
    mockIPC((cmd) => {
      log.push(`start ${cmd}`)
      return new Promise((resolve) => {
        releases.push(() => {
          log.push(`end ${cmd}`)
          resolve({ success: true })
        })
      })
    })
    const writes = [
      snapshotsApi.snapshotStoreDelete('0xA', 'snap'),
      analyzeFiltersApi.analyzeFilterStoreSave('0xA', '{}', 'L', 'S'),
      analyzeFiltersApi.analyzeFilterStoreUpdate('0xA', 'id', '{}'),
      analyzeFiltersApi.analyzeFilterStoreRename('0xA', 'id', 'N'),
      analyzeFiltersApi.analyzeFilterStoreDelete('0xA', 'id'),
      analyzeFiltersApi.analyzeFilterStoreSetHubPostId('0xA', 'id', null),
    ]
    const reads = [analyzeFiltersApi.analyzeFilterStoreList('0xA'), analyzeFiltersApi.analyzeFilterStoreLoad('0xA', 'id')]
    await settle()
    expect([...log].sort()).toEqual([
      'start analyze_filter_store_list',
      'start analyze_filter_store_load',
      'start snapshot_store_delete',
    ])
    for (let i = 0; i < writes.length + reads.length; i++) {
      releases.shift()?.()
      await settle()
    }
    await Promise.all([...writes, ...reads])
    expect(log.filter((line) => line.startsWith('start')).slice(3)).toEqual([
      'start analyze_filter_store_save',
      'start analyze_filter_store_update',
      'start analyze_filter_store_rename',
      'start analyze_filter_store_delete',
      'start analyze_filter_store_set_hub_post_id',
    ])
  })

  it('sends a private Hub link as its JSON text at the call, and null as "null"', async () => {
    const links: unknown[] = []
    mockIPC((_cmd, payload) => {
      links.push((payload as { link: unknown }).link)
      return { success: true }
    })
    const link = { id: 'p', url: '/u', expiresAt: null }
    const first = analyzeFiltersApi.analyzeFilterStoreSetHubPrivate('0xA', 'id', link)
    link.url = '/changed'
    await first
    await analyzeFiltersApi.analyzeFilterStoreSetHubPrivate('0xA', 'id', null)
    expect(links).toEqual(['{"id":"p","url":"/u","expiresAt":null}', 'null'])
  })
})
