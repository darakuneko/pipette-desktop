// SPDX-License-Identifier: GPL-2.0-or-later
// Rust → TypeScript check for src-tauri/crates/pipette-pack-stores: the
// crate's test tests/rust_user_data.rs (`cargo test -p pipette-pack-stores
// --test rust_user_data`) writes a userData tree with the Rust stores and
// records what they answer on it. This runs the real handlers of the
// Electron build on a copy of that tree and checks that they answer the
// same, byte for byte, and write nothing:
//
// - I18N_PACK_STORE_LIST / I18N_PACK_STORE_GET of every live language pack
//   (the list makes sure of the built-in English entry, which the crate
//   already wrote);
// - THEME_PACK_STORE_LIST / THEME_PACK_STORE_GET of every live theme pack;
// - I18N_PACK_STORE_HAS_NAME / THEME_PACK_STORE_HAS_NAME;
// - the pending units restorePendingFromDisk (sync-pending-store.ts) reads
//   from local/sync-pending.json.
//
// Run: pnpm run verify:pack-store-rust-user-data

import { afterAll, describe, expect, it, vi } from 'vitest'
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { cargoTargetTmpDir } from '../fixture-files'
import { readTree } from '../rust-user-data-tree'

const { handlers, notified, paths } = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  notified: [] as string[],
  paths: { userData: '' },
}))

vi.mock('electron', () => ({
  app: { getPath: () => paths.userData },
  BrowserWindow: { getAllWindows: () => [], fromWebContents: () => ({}) },
  dialog: {},
}))
vi.mock('../../src/main/ipc-guard', () => ({
  secureHandle: (channel: string, handler: (...args: unknown[]) => unknown) => handlers.set(channel, handler),
}))
vi.mock('../../src/main/sync/sync-service', () => ({ notifyChange: (unit: string) => notified.push(unit) }))

import { setupI18nPackStore } from '../../src/main/i18n-pack-ipc'
import { setupThemePackStore } from '../../src/main/theme-pack-ipc'
import { restorePendingFromDisk, resetPendingStoreForTests } from '../../src/main/sync/sync-pending-store'
import { pendingSnapshot } from '../../src/main/sync/sync-runtime-state'
import { IpcChannels } from '../../src/shared/ipc/channels'

const RUST_DIR = resolve(cargoTargetTmpDir('pipette-pack-stores'), 'rust_user_data')

/** A store's answers as JSON text: the list, and each live pack's get by id. */
interface StoreAnswers {
  list: string
  gets: Record<string, string>
}

interface Answers {
  i18n: StoreAnswers
  themes: StoreAnswers
  hasName: { i18n: string; themes: string }
  /** The units the stores reported, in the order first reported. */
  pendingUnits: string[]
}

function readAnswers(): Answers {
  const path = join(RUST_DIR, 'answers.json')
  if (!existsSync(path)) {
    throw new Error(`${path} is missing; run cargo test -p pipette-pack-stores --test rust_user_data first`)
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

describe('the userData tree the Rust pack stores write', () => {
  const answers = readAnswers()
  copy = mkdtempSync(join(tmpdir(), 'rust-pack-user-data-'))
  cpSync(join(RUST_DIR, 'user-data'), copy, { recursive: true })
  paths.userData = copy
  setupI18nPackStore()
  setupThemePackStore()
  const before = readTree(copy)

  it('lists and reads the language packs as the crate does', async () => {
    const rust = answers.i18n
    expect(JSON.stringify(await handler(IpcChannels.I18N_PACK_STORE_LIST)({}))).toBe(rust.list)
    // English, the two sample packs and the hand-made one.
    expect(Object.keys(rust.gets)).toHaveLength(4)
    for (const [id, get] of Object.entries(rust.gets)) {
      expect(JSON.stringify(await handler(IpcChannels.I18N_PACK_STORE_GET)({}, id))).toBe(get)
    }
    expect(JSON.stringify(await handler(IpcChannels.I18N_PACK_STORE_HAS_NAME)({}, ' custom 😀 '))).toBe(answers.hasName.i18n)
  })

  it('lists and reads the theme packs as the crate does', async () => {
    const rust = answers.themes
    expect(JSON.stringify(await handler(IpcChannels.THEME_PACK_STORE_LIST)({}))).toBe(rust.list)
    expect(Object.keys(rust.gets)).toHaveLength(2)
    for (const [id, get] of Object.entries(rust.gets)) {
      expect(JSON.stringify(await handler(IpcChannels.THEME_PACK_STORE_GET)({}, id))).toBe(get)
    }
    expect(JSON.stringify(await handler(IpcChannels.THEME_PACK_STORE_HAS_NAME)({}, 'モカ 😀'))).toBe(answers.hasName.themes)
  })

  it('wrote and reported nothing while reading', () => {
    expect(notified).toEqual([])
    expect(readTree(copy)).toEqual(before)
  })

  it('restores the pending units in the order the crate reported them', () => {
    restorePendingFromDisk()
    expect(pendingSnapshot()).toEqual({ owner: null, units: answers.pendingUnits, held: {} })
  })
})
