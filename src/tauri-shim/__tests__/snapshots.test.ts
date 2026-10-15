// SPDX-License-Identifier: GPL-2.0-or-later
// @vitest-environment jsdom
// The snapshot store members over the mocked Tauri IPC: the writes of one
// keyboard reach the backend one at a time in the order the renderer made
// them, other keyboards and the reads do not wait for them, and a private
// Hub link crosses as its JSON text.

import { afterEach, describe, expect, it } from 'vitest'
import { clearMocks, mockIPC } from '@tauri-apps/api/mocks'
import { snapshotsApi } from '../api/snapshots'

afterEach(() => {
  clearMocks()
})

async function settle(): Promise<void> {
  for (let i = 0; i < 10; i++) await Promise.resolve()
}

/** Answers every command once released, logging its start and end. */
function heldBackend(): { log: string[]; release: () => void; releaseAll: () => void } {
  const log: string[] = []
  const releases: (() => void)[] = []
  mockIPC((cmd, payload) => {
    const { uid } = payload as { uid: string }
    const name = `${cmd} ${uid}`
    log.push(`start ${name}`)
    return new Promise((resolve) => {
      releases.push(() => {
        log.push(`end ${name}`)
        resolve({ success: true })
      })
    })
  })
  return {
    log,
    release: () => releases.shift()?.(),
    releaseAll: () => releases.splice(0).forEach((release) => release()),
  }
}

describe('snapshotsApi', () => {
  it('sends the writes of one keyboard one at a time, in call order', async () => {
    const { log, release } = heldBackend()
    const save = snapshotsApi.snapshotStoreSave('0xA', '{}', 'KB', 'L', 2)
    const rename = snapshotsApi.snapshotStoreRename('0xA', 'id', 'New')
    const remove = snapshotsApi.snapshotStoreDelete('0xA', 'id')
    await settle()
    expect(log).toEqual(['start snapshot_store_save 0xA'])
    release()
    await save
    await settle()
    release()
    await rename
    await settle()
    release()
    await expect(remove).resolves.toEqual({ success: true })
    expect(log).toEqual([
      'start snapshot_store_save 0xA', 'end snapshot_store_save 0xA',
      'start snapshot_store_rename 0xA', 'end snapshot_store_rename 0xA',
      'start snapshot_store_delete 0xA', 'end snapshot_store_delete 0xA',
    ])
  })

  it('does not hold up another keyboard or a read', async () => {
    const { log, releaseAll } = heldBackend()
    const calls = [
      snapshotsApi.snapshotStoreUpdate('0xA', 'id', '{}', undefined, undefined),
      snapshotsApi.snapshotStoreSetHubPostId('0xB', 'id', 'post'),
      snapshotsApi.snapshotStoreList('0xA'),
      snapshotsApi.snapshotStoreLoad('0xA', 'id'),
    ]
    await settle()
    // All four started before any of them finished.
    expect([...log].sort()).toEqual([
      'start snapshot_store_list 0xA',
      'start snapshot_store_load 0xA',
      'start snapshot_store_set_hub_post_id 0xB',
      'start snapshot_store_update 0xA',
    ])
    releaseAll()
    await Promise.all(calls)
  })

  it('sends a private Hub link as its JSON text, and null as "null"', async () => {
    const links: unknown[] = []
    mockIPC((_cmd, payload) => {
      links.push((payload as { link: unknown }).link)
      return { success: true }
    })
    await snapshotsApi.snapshotStoreSetHubPrivate('0xA', 'id', { id: 'p', url: '/u', expiresAt: null })
    await snapshotsApi.snapshotStoreSetHubPrivate('0xA', 'id', null)
    expect(links).toEqual(['{"id":"p","url":"/u","expiresAt":null}', 'null'])
  })

  it('sends the objects of a queued write as they were when it was called', async () => {
    const sent: unknown[] = []
    mockIPC((_cmd, payload) => {
      sent.push(payload)
      return { success: true }
    })
    const options = { migrateFrom: 'before' }
    const link = { id: 'p', url: '/before', expiresAt: null }
    // Queued behind the rename, so they are sent after the changes below.
    const first = snapshotsApi.snapshotStoreRename('0xA', 'id', 'x')
    const update = snapshotsApi.snapshotStoreUpdate('0xA', 'id', '{}', 2, options)
    const hub = snapshotsApi.snapshotStoreSetHubPrivate('0xA', 'id', link)
    options.migrateFrom = 'after'
    link.url = '/after'
    await Promise.all([first, update, hub])
    expect(sent.slice(1)).toEqual([
      { uid: '0xA', entryId: 'id', json: '{}', vilVersion: 2, options: { migrateFrom: 'before' } },
      { uid: '0xA', entryId: 'id', link: '{"id":"p","url":"/before","expiresAt":null}' },
    ])
  })

  it('runs the next write after a failed one', async () => {
    mockIPC((cmd) => {
      if (cmd === 'snapshot_store_save') throw 'disk full'
      return { success: true }
    })
    await expect(snapshotsApi.snapshotStoreSave('0xA', '{}', 'KB', 'L', undefined)).rejects.toThrow('disk full')
    await expect(snapshotsApi.snapshotStoreDelete('0xA', 'id')).resolves.toEqual({ success: true })
  })
})
