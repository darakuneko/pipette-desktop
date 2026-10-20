// SPDX-License-Identifier: GPL-2.0-or-later
// @vitest-environment jsdom
// The language pack members over the mocked Tauri IPC: the list and the
// writes reach the backend one at a time in the order the renderer made
// them, the reads and the dialogs do not wait for them, the pack and the
// options cross as JSON text, the import dialog's file texts are parsed
// here, and i18n-pack:changed reaches the callback until unsubscribed.

import { afterEach, describe, expect, it, vi } from 'vitest'
import { clearMocks, mockIPC } from '@tauri-apps/api/mocks'
import { emit } from '@tauri-apps/api/event'
import { i18nPacksApi } from '../api/i18n-packs'
import { parseImportFiles } from '../api/pack-import'

afterEach(() => {
  clearMocks()
})

async function settle(): Promise<void> {
  for (let i = 0; i < 10; i++) await Promise.resolve()
}

/** Answers every command once released, logging its start. */
function heldBackend(): { log: string[]; payloads: Record<string, unknown>[]; releaseAll: () => void; release: () => void } {
  const log: string[] = []
  const payloads: Record<string, unknown>[] = []
  const releases: (() => void)[] = []
  mockIPC((cmd, payload) => {
    log.push(cmd)
    payloads.push(payload as Record<string, unknown>)
    return new Promise((resolve) => releases.push(() => resolve({ success: true })))
  })
  return {
    log,
    payloads,
    release: () => releases.shift()?.(),
    releaseAll: () => releases.splice(0).forEach((release) => release()),
  }
}

describe('i18nPacksApi', () => {
  it('sends the list and the writes one at a time, in call order', async () => {
    const { log, release } = heldBackend()
    const calls = [
      i18nPacksApi.i18nPackImportApply({ name: 'A', version: '1' }, { enabled: true }),
      i18nPacksApi.i18nPackList(),
      i18nPacksApi.i18nPackRename('id', 'New'),
      i18nPacksApi.i18nPackReorder(['id']),
      i18nPacksApi.i18nPackSetEnabled('id', false),
      i18nPacksApi.i18nPackRefreshCoverage('id', { matchedBaseVersion: '1', coverage: { totalKeys: 1, coveredKeys: 1 }, measuredBodyClock: 'c' }),
      i18nPacksApi.i18nPackSetHubPostId('id', 'post', undefined, undefined),
      i18nPacksApi.i18nPackDelete('id'),
    ]
    for (let i = 1; i <= calls.length; i++) {
      await settle()
      expect(log).toHaveLength(i)
      release()
      await calls[i - 1]
    }
    expect(log).toEqual([
      'i18n_pack_import_apply',
      'i18n_pack_store_list',
      'i18n_pack_store_rename',
      'i18n_pack_store_reorder',
      'i18n_pack_store_set_enabled',
      'i18n_pack_store_refresh_coverage',
      'i18n_pack_store_set_hub_post_id',
      'i18n_pack_store_delete',
    ])
  })

  it('does not hold up the reads and the dialogs', async () => {
    const { log, releaseAll } = heldBackend()
    const calls = [
      i18nPacksApi.i18nPackDelete('id'),
      i18nPacksApi.i18nPackGet('id'),
      i18nPacksApi.i18nPackHasName('Name', undefined),
      i18nPacksApi.i18nPackExport('id'),
    ]
    await settle()
    expect([...log].sort()).toEqual([
      'i18n_pack_export',
      'i18n_pack_store_delete',
      'i18n_pack_store_get',
      'i18n_pack_store_has_name',
    ])
    releaseAll()
    await Promise.all(calls)
  })

  it('sends the pack and the options as JSON text, the options as {} when not given', async () => {
    const { payloads, releaseAll } = heldBackend()
    const raw = { '2': 'index key', name: 'A', version: '1' }
    const options = { coverage: { totalKeys: 2, coveredKeys: 1 }, enabled: true }
    const calls = [i18nPacksApi.i18nPackImportApply(raw, options), i18nPacksApi.i18nPackImportApply(undefined, undefined)]
    // A change after the call does not reach the backend.
    options.enabled = false
    await settle()
    releaseAll()
    await settle()
    releaseAll()
    await Promise.all(calls)
    expect(payloads).toEqual([
      { raw: '{"2":"index key","name":"A","version":"1"}', options: '{"coverage":{"totalKeys":2,"coveredKeys":1},"enabled":true}' },
      { options: '{}' },
    ])
  })

  it('parses each imported file on its own', async () => {
    mockIPC(() => ({
      canceled: false,
      files: [
        { filePath: '/a.json', text: '{"name":"A","version":"1"}', fileSizeBytes: 26 },
        { filePath: '/b.json', text: '{ not json', fileSizeBytes: 10 },
        { filePath: '/c.json', readError: 'Error: no such file' },
      ],
    }))
    const result = await i18nPacksApi.i18nPackImport()
    expect(result.canceled).toBe(false)
    expect(result.files[0]).toEqual({ filePath: '/a.json', raw: { name: 'A', version: '1' }, fileSizeBytes: 26 })
    expect(Object.keys(result.files[1])).toEqual(['filePath', 'fileSizeBytes', 'parseError'])
    expect(result.files[1].parseError).toMatch(/^SyntaxError/)
    expect(result.files[2]).toEqual({ filePath: '/c.json', parseError: 'Error: no such file' })
  })

  it('answers a cancelled import as cancelled with no files', () => {
    expect(parseImportFiles({ canceled: true, files: [] })).toEqual({ canceled: true, files: [] })
  })

  it('passes each i18n-pack:changed event until unsubscribed', async () => {
    mockIPC(() => {}, { shouldMockEvents: true })
    const callback = vi.fn()
    const unsubscribe = i18nPacksApi.i18nPackOnChanged(callback)
    await settle()
    await emit('i18n-pack:changed', { anything: 1 })
    unsubscribe()
    await emit('i18n-pack:changed')
    expect(callback.mock.calls).toEqual([[]])
  })
})
