// SPDX-License-Identifier: GPL-2.0-or-later
//
// Focused coverage for `collectAllSyncUnits`'s built-in English
// exclusion (feat/english-pack-sortable): the entry's pack body is a
// trivial placeholder every machine ensures identically, so it must
// never be pushed as its own "i18n/packs/{id}" sync unit — only the
// index unit (which carries its *position*) should include it. No
// pre-existing test file covered `sync-bundle.ts` before this, so this
// file stays scoped to that one behavior rather than attempting full
// bundle coverage in the same pass.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { join } from 'node:path'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'

let mockUserDataPath = ''

vi.mock('electron', () => ({
  app: {
    getPath: (name: string) => {
      if (name === 'userData') return mockUserDataPath
      return `/mock/${name}`
    },
  },
}))

// sync-bundle.ts's typing-analytics imports transitively reach
// app-config.ts's top-level `new Store(...)` (electron-store, which
// needs a real app.getName()/getVersion() this mock doesn't provide).
// Mirrors sync-service.test.ts's mocking of the same modules.
vi.mock('../../app-config', () => ({
  loadAppConfig: vi.fn(async () => ({})),
  saveAppConfig: vi.fn(async () => {}),
}))
vi.mock('../../typing-analytics/db/typing-analytics-db', () => ({
  getTypingAnalyticsDB: vi.fn(),
}))
vi.mock('../../typing-analytics/machine-hash', () => ({
  getMachineHash: vi.fn(async () => 'mock-hash'),
}))
vi.mock('../../logger', () => ({
  log: vi.fn(),
}))

import { bundleSyncUnit, collectAllSyncUnits } from '../sync-bundle'
import { BUILTIN_ENGLISH_PACK_ID, I18N_INDEX_SYNC_UNIT } from '../../../shared/types/i18n-store'

describe('collectAllSyncUnits — built-in English exclusion', () => {
  beforeEach(async () => {
    mockUserDataPath = await mkdtemp(join(tmpdir(), 'sync-bundle-test-'))
  })

  afterEach(async () => {
    await rm(mockUserDataPath, { recursive: true, force: true })
  })

  it('includes i18n/index and every real pack, but excludes the built-in English pack-body unit', async () => {
    const i18nDir = join(mockUserDataPath, 'sync', 'i18n')
    await mkdir(i18nDir, { recursive: true })
    await writeFile(join(i18nDir, 'index.json'), JSON.stringify({
      metas: [
        { id: BUILTIN_ENGLISH_PACK_ID, filename: 'packs/builtin-english.json', name: 'English', version: '0.0.0', enabled: true, savedAt: 'now', updatedAt: 'now' },
        { id: 'p1', filename: 'packs/p1.json', name: 'Japanese', version: '0.1.0', enabled: true, savedAt: 'now', updatedAt: 'now' },
      ],
    }), 'utf-8')

    const units = await collectAllSyncUnits()

    expect(units).toContain(I18N_INDEX_SYNC_UNIT)
    expect(units).toContain('i18n/packs/p1')
    expect(units).not.toContain(`i18n/packs/${BUILTIN_ENGLISH_PACK_ID}`)
  })

  it('emits no i18n units at all when there is no i18n index on disk', async () => {
    const units = await collectAllSyncUnits()
    expect(units.some((u) => u.startsWith('i18n/'))).toBe(false)
  })

  // codex review follow-up (issue 3): bundleSyncUnit itself refuses the
  // built-in body defensively, even if a stale/future call site ever
  // requests it directly (collectAllSyncUnits already never does).
  it('bundleSyncUnit refuses the built-in English pack-body unit even when the file exists on disk', async () => {
    const packsDir = join(mockUserDataPath, 'sync', 'i18n', 'packs')
    await mkdir(packsDir, { recursive: true })
    await writeFile(join(packsDir, `${BUILTIN_ENGLISH_PACK_ID}.json`), JSON.stringify({ name: 'English', version: '0.0.0' }), 'utf-8')

    const bundle = await bundleSyncUnit(`i18n/packs/${BUILTIN_ENGLISH_PACK_ID}`)
    expect(bundle).toBeNull()
  })

  it('bundleSyncUnit still bundles a real pack body normally', async () => {
    const packsDir = join(mockUserDataPath, 'sync', 'i18n', 'packs')
    await mkdir(packsDir, { recursive: true })
    await writeFile(join(packsDir, 'p1.json'), JSON.stringify({ name: 'Japanese', version: '0.1.0' }), 'utf-8')

    const bundle = await bundleSyncUnit('i18n/packs/p1')
    expect(bundle).not.toBeNull()
    expect(bundle!.files['p1.json']).toBeDefined()
  })
})
