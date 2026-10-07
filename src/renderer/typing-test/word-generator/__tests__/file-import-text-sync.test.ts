// SPDX-License-Identifier: GPL-2.0-or-later
// @vitest-environment jsdom

// A sync merge of `typing-test-texts` reaches the word cache through the
// sync-unit bridge alone — no typing-test hook is mounted in these tests.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

type CacheModule = typeof import('../file-import-text')
type RunStateModule = typeof import('../../run-state')

let emit: ((syncUnit: string) => void) | null = null
const subscribe = vi.fn((cb: (syncUnit: string) => void) => {
  emit = cb
  return () => undefined
})
const mockGet = vi.fn()
const mockList = vi.fn()
const originalVialAPI = window.vialAPI

interface Stored { name: string; text: string; updatedAt: string }
let store: Record<string, Stored> = {}

function meta(id: string, s: Stored): { id: string; name: string; updatedAt: string } {
  return { id, name: s.name, updatedAt: s.updatedAt }
}

async function flush(rounds = 10): Promise<void> {
  for (let i = 0; i < rounds; i++) await Promise.resolve()
}

async function load(): Promise<{ cache: CacheModule; runState: RunStateModule }> {
  // The bridge is a per-window singleton and the cache is module state.
  vi.resetModules()
  const bridge = await import('../../../hooks/use-sync-unit-applied')
  const cache = await import('../file-import-text')
  const runState = await import('../../run-state')
  bridge.ensureSyncUnitAppliedBridge()
  return { cache, runState }
}

beforeEach(() => {
  vi.clearAllMocks()
  emit = null
  store = {
    a: { name: 'A', text: 'a1 a2', updatedAt: '2026-01-01T00:00:00.000Z' },
    b: { name: 'B', text: 'b1 b2', updatedAt: '2026-01-01T00:00:00.000Z' },
    c: { name: 'C', text: 'c1 c2', updatedAt: '2026-01-01T00:00:00.000Z' },
  }
  mockGet.mockImplementation((id: string) => {
    const s = store[id]
    return Promise.resolve(s
      ? { success: true, data: { meta: meta(id, s), data: { name: s.name, text: s.text } } }
      : { success: false, errorCode: 'NOT_FOUND' })
  })
  mockList.mockImplementation(() => Promise.resolve({
    success: true,
    data: Object.entries(store).map(([id, s]) => meta(id, s)),
  }))
  window.vialAPI = {
    ...(window.vialAPI ?? {}),
    typingTestTextStoreGet: mockGet,
    typingTestTextStoreList: mockList,
    syncOnUnitApplied: subscribe,
  } as unknown as typeof window.vialAPI
})

afterEach(() => {
  window.vialAPI = originalVialAPI
})

describe('file-import text cache on a typing-test-texts sync', () => {
  it('drops an overwritten entry (same id) and a vanished one, keeps an unchanged one', async () => {
    const { cache } = await load()
    await cache.getFileImportTextData('a')
    await cache.getFileImportTextData('b')
    await cache.getFileImportTextData('c')

    // Another PC overwrote `a` in place and deleted `b`.
    store.a = { name: 'A', text: 'new1 new2', updatedAt: '2026-02-01T00:00:00.000Z' }
    delete store.b
    emit?.('typing-test-texts')
    await flush()

    expect(cache.getFileImportTextDataSync('a')).toBeUndefined()
    expect(cache.getFileImportTextDataSync('b')).toBeUndefined()
    expect(cache.getFileImportTextDataSync('c')?.words).toEqual(['c1', 'c2'])
    expect((await cache.getFileImportTextData('a'))?.words).toEqual(['new1', 'new2'])
  })

  it('ignores other units', async () => {
    const { cache } = await load()
    await cache.getFileImportTextData('a')
    store.a = { name: 'A', text: 'new1', updatedAt: '2026-02-01T00:00:00.000Z' }
    emit?.('key-labels')
    await flush()
    expect(mockList).not.toHaveBeenCalled()
    expect(cache.getFileImportTextDataSync('a')?.words).toEqual(['a1', 'a2'])
  })

  it('a read in flight when the sync lands does not put its old content back', async () => {
    const { cache } = await load()
    let resolveOld: (v: unknown) => void = () => undefined
    mockGet.mockImplementationOnce(() => new Promise((r) => { resolveOld = r }))
    const pending = cache.getFileImportTextData('a')

    store.a = { name: 'A', text: 'new1', updatedAt: '2026-02-01T00:00:00.000Z' }
    emit?.('typing-test-texts')
    resolveOld({
      success: true,
      data: { meta: { id: 'a', updatedAt: '2026-01-01T00:00:00.000Z' }, data: { name: 'A', text: 'a1 a2' } },
    })
    expect((await pending)?.words).toEqual(['a1', 'a2'])
    await flush()

    expect(cache.getFileImportTextDataSync('a')).toBeUndefined()
  })

  it('a run already started keeps the words it started with', async () => {
    const { cache, runState } = await load()
    await cache.getFileImportTextData('a')
    const state = runState.createInitialState({ mode: 'fileImport', textId: 'a' }, 'english', 'running')
    expect(state.words).toEqual(['a1', 'a2'])

    store.a = { name: 'A', text: 'new1 new2', updatedAt: '2026-02-01T00:00:00.000Z' }
    emit?.('typing-test-texts')
    await flush()
    await cache.getFileImportTextData('a')

    const typed = runState.handleSpace(runState.handleChar(runState.handleChar(state, 'a'), '1'), { mode: 'fileImport', textId: 'a' }, 'english')
    expect(typed.words).toEqual(['a1', 'a2'])
    expect(typed.currentWordIndex).toBe(1)
  })
})
