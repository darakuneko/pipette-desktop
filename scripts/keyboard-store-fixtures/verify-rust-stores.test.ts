// SPDX-License-Identifier: GPL-2.0-or-later
// Rust → TypeScript check for src-tauri/crates/pipette-keyboard-stores: the
// crate's test tests/rust_user_data.rs (`cargo test -p
// pipette-keyboard-stores --test rust_user_data`) writes a userData tree
// with the Rust stores and records what they answer on it. This runs the
// real handlers of the Electron build on a copy of that tree and checks
// that they answer the same, byte for byte:
//
// - SNAPSHOT_STORE_LIST / SNAPSHOT_STORE_LOAD of every keyboard;
// - FAVORITE_STORE_LIST / FAVORITE_STORE_LOAD of every type;
// - KEY_LABEL_STORE_LIST / KEY_LABEL_STORE_LIST_ALL / KEY_LABEL_STORE_GET of
//   every live key label;
// - TYPING_TEST_TEXT_LIST / TYPING_TEST_TEXT_GET of every live typing test
//   text;
// - LIST_STORED_KEYBOARDS, and the keyboard names as keyboard-meta.ts reads
//   them;
// - PIPETTE_SETTINGS_GET and PIPETTE_SETTINGS_LIST_ALL_TYPING_RESULTS,
//   against the shim's members (src/tauri-shim/api/settings.ts) given the
//   crate's answers;
// - the pending units restorePendingFromDisk (sync-pending-store.ts) reads
//   from local/sync-pending.json;
//
// and that reading wrote nothing to the tree.
//
// Run: pnpm run verify:keyboard-store-rust-user-data

import { afterAll, describe, expect, it, vi } from 'vitest'
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { cargoTargetTmpDir } from '../fixture-files'
import { readTree } from '../rust-user-data-tree'

const { handlers, notified, paths, stub, backend } = vi.hoisted(() => {
  /** A module whose exports are `extra`, and a function resolving to
   *  undefined for any other name. */
  function stub(extra: Record<string, unknown> = {}): Record<string, unknown> {
    const resolved = (): Promise<undefined> => Promise.resolve(undefined)
    return new Proxy(extra, {
      has: () => true,
      get: (target, key) => {
        if (typeof key === 'symbol' || key === 'then') return undefined
        return key in target ? target[key] : resolved
      },
    })
  }
  return {
    handlers: new Map<string, (...args: unknown[]) => unknown>(),
    notified: [] as string[],
    paths: { userData: '' },
    stub,
    backend: { answers: new Map<string, unknown>() },
  }
})

vi.mock('electron', () => ({
  app: { getPath: () => paths.userData },
  BrowserWindow: { getAllWindows: () => [], getFocusedWindow: () => null, fromWebContents: () => ({}) },
  dialog: {},
}))
vi.mock('../../src/main/ipc-guard', () => ({
  secureHandle: (channel: string, handler: (...args: unknown[]) => unknown) => handlers.set(channel, handler),
  secureOn: () => {},
}))
vi.mock('../../src/main/sync/sync-service', () => stub({ notifyChange: (unit: string) => notified.push(unit) }))
vi.mock('../../src/main/app-config', () => stub({ loadAppConfig: () => ({}) }))
vi.mock('../../src/main/utils/broadcast', () => stub())
vi.mock('../../src/main/sync/sync-crypto', () => stub())
vi.mock('../../src/main/sync/google-auth', () => stub())
vi.mock('../../src/main/sync/google-drive', () => stub())
vi.mock('../../src/main/sync/sync-reset-ipc', () => stub())
vi.mock('../../src/main/sync/local-data-import', () => stub())
vi.mock('../../src/main/typing-analytics/import-export', () => stub())
vi.mock('../../src/main/typing-analytics/machine-hash', () => stub())
vi.mock('../../src/main/typing-analytics/deleted-ranges-apply', () => stub())
vi.mock('../../src/main/typing-analytics/cache-rebuild', () => stub())
vi.mock('../../src/main/typing-analytics/typing-analytics-service', () => stub())
// The analytics product names are M4's; neither build reads them here.
vi.mock('../../src/main/typing-analytics/db/typing-analytics-db', () => stub({
  getTypingAnalyticsDB: () => {
    throw new Error('no analytics database')
  },
}))
vi.mock('../../src/tauri-shim/ipc', () => ({
  call: (cmd: string, args?: Record<string, unknown>) => {
    const key = cmd === 'pipette_settings_read' ? `${cmd}:${String(args?.uid)}` : cmd
    if (!backend.answers.has(key)) return Promise.reject(new Error(`unexpected command ${key}`))
    return Promise.resolve(structuredClone(backend.answers.get(key)))
  },
}))

import { setupSnapshotStore } from '../../src/main/snapshot-store'
import { setupFavoriteStore } from '../../src/main/favorite-store'
import { setupKeyLabelStore } from '../../src/main/key-label-ipc'
import { setupTypingTestTextStore } from '../../src/main/typing-test-text-ipc'
import { setupPipetteSettingsStore } from '../../src/main/pipette-settings-store'
import { setupSyncIpc } from '../../src/main/sync/sync-ipc'
import { getActiveKeyboardMetaMap, readKeyboardMetaIndex } from '../../src/main/sync/keyboard-meta'
import { restorePendingFromDisk, resetPendingStoreForTests } from '../../src/main/sync/sync-pending-store'
import { hasPendingChanges, pendingSnapshot } from '../../src/main/sync/sync-runtime-state'
import { IpcChannels } from '../../src/shared/ipc/channels'
import { settingsApi } from '../../src/tauri-shim/api/settings'

const RUST_DIR = resolve(cargoTargetTmpDir('pipette-keyboard-stores'), 'rust_user_data')

interface Loaded {
  /** The `{success, entries}` answer of the list, as JSON text. */
  list: string
  /** Entry id → the `{success, data}` answer of its load, as JSON text. */
  loads: Record<string, string>
}

interface Answers {
  snapshots: Record<string, Loaded>
  favorites: Record<string, Loaded>
  /** The key label answers as JSON text: the lists, and each live label's get by id. */
  keyLabels: { list: string; listAll: string; gets: Record<string, string> }
  /** The typing test text answers as JSON text: the list, and each live text's get by id. */
  typingTexts: { list: string; gets: Record<string, string> }
  settings: Record<string, { content: string | null; etag: string }>
  /** The `pipette_settings_read_all` answer, as JSON text. */
  settingsReadAll: string
  /** The `LIST_STORED_KEYBOARDS` answer, as JSON text. */
  storedKeyboards: string
  /** The units the stores reported, in the order first reported. */
  pendingUnits: string[]
}

function readAnswers(): Answers {
  const path = join(RUST_DIR, 'answers.json')
  if (!existsSync(path)) {
    throw new Error(`${path} is missing; run cargo test -p pipette-keyboard-stores --test rust_user_data first`)
  }
  return JSON.parse(readFileSync(path, 'utf-8')) as Answers
}

function handler(channel: string): (...args: unknown[]) => Promise<unknown> {
  const found = handlers.get(channel)
  if (!found) throw new Error(`${channel} is not registered`)
  return found as (...args: unknown[]) => Promise<unknown>
}

let copy = ''
afterAll(() => {
  if (copy) rmSync(copy, { recursive: true, force: true })
  resetPendingStoreForTests()
})

describe('the userData tree the Rust stores write', () => {
  const answers = readAnswers()
  copy = mkdtempSync(join(tmpdir(), 'rust-user-data-'))
  cpSync(join(RUST_DIR, 'user-data'), copy, { recursive: true })
  paths.userData = copy
  setupSnapshotStore()
  setupFavoriteStore()
  setupKeyLabelStore()
  setupTypingTestTextStore()
  setupPipetteSettingsStore()
  setupSyncIpc()
  const before = readTree(copy)

  it('lists and loads every keyboard’s snapshots as the crate does', async () => {
    expect(Object.keys(answers.snapshots).length).toBeGreaterThan(0)
    for (const [uid, rust] of Object.entries(answers.snapshots)) {
      expect(JSON.stringify(await handler(IpcChannels.SNAPSHOT_STORE_LIST)({}, uid))).toBe(rust.list)
      expect(Object.keys(rust.loads).length).toBeGreaterThan(0)
      for (const [id, load] of Object.entries(rust.loads)) {
        expect(JSON.stringify(await handler(IpcChannels.SNAPSHOT_STORE_LOAD)({}, uid, id))).toBe(load)
      }
    }
  })

  it('lists and loads the favorites of every type as the crate does', async () => {
    expect(Object.keys(answers.favorites)).toEqual(['tapDance', 'macro', 'combo', 'keyOverride', 'altRepeatKey'])
    for (const [type, rust] of Object.entries(answers.favorites)) {
      expect(JSON.stringify(await handler(IpcChannels.FAVORITE_STORE_LIST)({}, type))).toBe(rust.list)
      for (const [id, load] of Object.entries(rust.loads)) {
        expect(JSON.stringify(await handler(IpcChannels.FAVORITE_STORE_LOAD)({}, type, id))).toBe(load)
      }
    }
    // The macro favorite of the older index was migrated by the crate and
    // still loads.
    const macro = JSON.parse(answers.favorites.macro.list) as { entries: { id: string }[] }
    expect(macro.entries.map((e) => e.id)).toContain('legacy-1')
  })

  it('lists and reads the key labels as the crate does, without writing', async () => {
    notified.length = 0
    const rust = answers.keyLabels
    expect(JSON.stringify(await handler(IpcChannels.KEY_LABEL_STORE_LIST)({}))).toBe(rust.list)
    expect(JSON.stringify(await handler(IpcChannels.KEY_LABEL_STORE_LIST_ALL)({}))).toBe(rust.listAll)
    expect(Object.keys(rust.gets)).toHaveLength(3)
    for (const [id, get] of Object.entries(rust.gets)) {
      expect(JSON.stringify(await handler(IpcChannels.KEY_LABEL_STORE_GET)({}, id))).toBe(get)
    }
    // QWERTY already has its author, so the lists wrote nothing.
    expect(notified).toEqual([])
  })

  it('lists and reads the typing test texts as the crate does', async () => {
    notified.length = 0
    const rust = answers.typingTexts
    expect(JSON.stringify(await handler(IpcChannels.TYPING_TEST_TEXT_LIST)({}))).toBe(rust.list)
    expect(Object.keys(rust.gets)).toHaveLength(2)
    for (const [id, get] of Object.entries(rust.gets)) {
      expect(JSON.stringify(await handler(IpcChannels.TYPING_TEST_TEXT_GET)({}, id))).toBe(get)
    }
    expect(notified).toEqual([])
  })

  it('reads the pipette settings and the typing results as the shim does on the crate’s answers', async () => {
    expect(Object.keys(answers.settings).length).toBeGreaterThan(0)
    for (const [uid, file] of Object.entries(answers.settings)) {
      backend.answers.set(`pipette_settings_read:${uid}`, file)
      const electron = await handler(IpcChannels.PIPETTE_SETTINGS_GET)({}, uid)
      expect(electron).not.toBeNull()
      expect(JSON.stringify(await settingsApi.pipetteSettingsGet(uid))).toBe(JSON.stringify(electron))
    }
    backend.answers.set('pipette_settings_read_all', JSON.parse(answers.settingsReadAll))
    const electron = await handler(IpcChannels.PIPETTE_SETTINGS_LIST_ALL_TYPING_RESULTS)({})
    expect((electron as unknown[]).length).toBeGreaterThan(0)
    expect(JSON.stringify(await settingsApi.pipetteSettingsListAllTypingResults())).toBe(JSON.stringify(electron))
  })

  it('lists the stored keyboards with the names the crate recorded', async () => {
    const before = readFileSync(join(copy, 'sync/meta/keyboard-names.json'))
    notified.length = 0
    expect(JSON.stringify(await handler(IpcChannels.LIST_STORED_KEYBOARDS)({}))).toBe(answers.storedKeyboards)
    // Every name was already recorded, so nothing is written.
    expect(notified).toEqual([])
    expect(readFileSync(join(copy, 'sync/meta/keyboard-names.json')).equals(before)).toBe(true)

    const names = getActiveKeyboardMetaMap(await readKeyboardMetaIndex())
    const listed = JSON.parse(answers.storedKeyboards) as { uid: string; name: string }[]
    expect(Object.fromEntries(names)).toEqual(Object.fromEntries(listed.map(({ uid, name }) => [uid, name])))
  })

  it('wrote nothing to the tree while reading', () => {
    expect(readTree(copy)).toEqual(before)
  })

  it('restores the pending units in the order the crate reported them', () => {
    restorePendingFromDisk()
    expect(hasPendingChanges()).toBe(true)
    expect(pendingSnapshot()).toEqual({ owner: null, units: answers.pendingUnits, held: {} })
  })
})
