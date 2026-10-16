// SPDX-License-Identifier: GPL-2.0-or-later
// @vitest-environment jsdom
// The key label store members over the mocked Tauri IPC: the writes and the
// lists reach the backend one at a time in the order the renderer made
// them; the read of one label, the name check, the import and the export
// do not wait for them.

import { afterEach, describe, expect, it } from 'vitest'
import { clearMocks, mockIPC } from '@tauri-apps/api/mocks'
import { keyLabelsApi } from '../api/key-labels'

afterEach(() => {
  clearMocks()
})

async function settle(): Promise<void> {
  for (let i = 0; i < 10; i++) await Promise.resolve()
}

/** Answers every command once released, logging its start. */
function heldBackend(): { started: string[]; releaseAll: () => void; release: () => void } {
  const started: string[] = []
  const releases: (() => void)[] = []
  mockIPC((cmd) => {
    started.push(cmd)
    return new Promise((resolve) => {
      releases.push(() => resolve({ success: true }))
    })
  })
  return {
    started,
    release: () => releases.shift()?.(),
    releaseAll: () => releases.splice(0).forEach((release) => release()),
  }
}

describe('keyLabelsApi', () => {
  it('queues the writes and the lists in call order', async () => {
    const { started, release, releaseAll } = heldBackend()
    const calls = [
      keyLabelsApi.keyLabelStoreRename('a', 'New'),
      keyLabelsApi.keyLabelStoreList(),
      keyLabelsApi.keyLabelStoreReorder(['a']),
      keyLabelsApi.keyLabelStoreDelete('a'),
      keyLabelsApi.keyLabelStoreSetHubPostId('a', null),
      keyLabelsApi.keyLabelStoreListAll(),
    ]
    await settle()
    expect(started).toEqual(['key_label_store_rename'])
    for (let i = 1; i < calls.length; i++) {
      release()
      await settle()
    }
    releaseAll()
    await Promise.all(calls)
    expect(started).toEqual([
      'key_label_store_rename',
      'key_label_store_list',
      'key_label_store_reorder',
      'key_label_store_delete',
      'key_label_store_set_hub_post_id',
      'key_label_store_list_all',
    ])
  })

  it('does not hold the reads, the import or the export behind a write', async () => {
    const { started, releaseAll } = heldBackend()
    const calls = [
      keyLabelsApi.keyLabelStoreRename('a', 'New'),
      keyLabelsApi.keyLabelStoreGet('a'),
      keyLabelsApi.keyLabelStoreHasName('New', 'a'),
      keyLabelsApi.keyLabelStoreImport(),
      keyLabelsApi.keyLabelStoreExport('a'),
    ]
    await settle()
    // The queued rename starts a tick later than the calls made directly.
    expect([...started].sort()).toEqual([
      'key_label_store_export',
      'key_label_store_get',
      'key_label_store_has_name',
      'key_label_store_import',
      'key_label_store_rename',
    ])
    releaseAll()
    await Promise.all(calls)
  })
})
