// SPDX-License-Identifier: GPL-2.0-or-later
// @vitest-environment jsdom
// The typing test text store members over the mocked Tauri IPC: the
// rename, the delete and the confirmed import reach the backend one at a
// time in the order the renderer made them; the list, the read of one text
// and the import do not wait for them.

import { afterEach, describe, expect, it } from 'vitest'
import { clearMocks, mockIPC } from '@tauri-apps/api/mocks'
import { typingTextsApi } from '../api/typing-texts'

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

describe('typingTextsApi', () => {
  it('queues the writes in call order', async () => {
    const { started, release, releaseAll } = heldBackend()
    const calls = [
      typingTextsApi.typingTestTextStoreRename('a', 'New'),
      typingTextsApi.typingTestTextStoreImportConfirm(),
      typingTextsApi.typingTestTextStoreDelete('a'),
    ]
    await settle()
    expect(started).toEqual(['typing_test_text_store_rename'])
    for (let i = 1; i < calls.length; i++) {
      release()
      await settle()
    }
    releaseAll()
    await Promise.all(calls)
    expect(started).toEqual([
      'typing_test_text_store_rename',
      'typing_test_text_store_import_confirm',
      'typing_test_text_store_delete',
    ])
  })

  it('does not hold the reads or the import behind a write', async () => {
    const { started, releaseAll } = heldBackend()
    const calls = [
      typingTextsApi.typingTestTextStoreRename('a', 'New'),
      typingTextsApi.typingTestTextStoreList(),
      typingTextsApi.typingTestTextStoreGet('a'),
      typingTextsApi.typingTestTextStoreImport(),
    ]
    await settle()
    // The queued rename starts a tick later than the calls made directly.
    expect([...started].sort()).toEqual([
      'typing_test_text_store_get',
      'typing_test_text_store_import',
      'typing_test_text_store_list',
      'typing_test_text_store_rename',
    ])
    releaseAll()
    await Promise.all(calls)
  })
})
