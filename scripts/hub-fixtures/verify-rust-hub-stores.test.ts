// SPDX-License-Identifier: GPL-2.0-or-later
// Rust → TypeScript check for the Hub handlers of src-tauri/crates/
// pipette-hub: the crate's test tests/rust_user_data.rs (`cargo test -p
// pipette-hub --test rust_user_data`) writes a userData tree with the Rust
// Hub handlers against the in-memory Hub (an uploaded key label, language
// pack and theme pack linked to their posts, a key label downloaded and
// refreshed from the Hub, a theme pack unlinked by a delete, a language
// pack the startup update replaced) and records what the stores answer on
// it. This runs the real handlers of the Electron build on copies of that
// tree, inside the Hub fixture harness, and checks that
//
// - KEY_LABEL_STORE_LIST / KEY_LABEL_STORE_LIST_ALL / KEY_LABEL_STORE_GET,
//   I18N_PACK_STORE_LIST / I18N_PACK_STORE_GET and THEME_PACK_STORE_LIST /
//   THEME_PACK_STORE_GET answer as the crate does, byte for byte;
// - Electron's startup update of the Hub-linked language packs, given the
//   Hub's timestamps the crate recorded, finds every pack up to date: it
//   asks for the timestamps only and downloads nothing;
//
// and that neither wrote to the tree or reported a change.
//
// Run: pnpm run verify:hub-rust-user-data

import { cpSync, existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { syncHubI18nPacksOnStartup } from '../../src/main/hub/i18n-startup-sync'
import { setupI18nPackStore } from '../../src/main/i18n-pack-ipc'
import { setupKeyLabelStore } from '../../src/main/key-label-ipc'
import { setupThemePackStore } from '../../src/main/theme-pack-ipc'
import { IpcChannels } from '../../src/shared/ipc/channels'
import { cargoTargetTmpDir } from '../fixture-files'
import { readTree } from '../rust-user-data-tree'
import { seedUserData } from '../sync-fixtures/harness'
import { scriptedFetch, setRules, takeRecorded, unusedRules } from './hub-harness'
import { invokeHandler } from './ipc-handlers'

const RUST_DIR = resolve(cargoTargetTmpDir('pipette-hub'), 'rust_user_data')

/** A store's answers as JSON text: the list, and each live entry's get by id. */
interface StoreAnswers {
  list: string
  gets: Record<string, string>
}

interface Answers {
  keyLabels: StoreAnswers & { listAll: string }
  i18n: StoreAnswers
  themes: StoreAnswers
  /** The `data` of the Hub's timestamps answer for the linked language packs. */
  i18nHubTimestamps: { items: Array<{ id: string; updated_at: string }> }
}

function readAnswers(): Answers {
  const path = join(RUST_DIR, 'answers.json')
  if (!existsSync(path)) {
    throw new Error(`${path} is missing; run cargo test -p pipette-hub --test rust_user_data first`)
  }
  return JSON.parse(readFileSync(path, 'utf-8')) as Answers
}

/** A new harness userData holding a copy of the crate's tree. */
function copyOfRustTree(): string {
  const dir = seedUserData()
  cpSync(join(RUST_DIR, 'user-data'), dir, { recursive: true })
  return dir
}

async function answer(channel: string, ...args: unknown[]): Promise<string> {
  return JSON.stringify(await invokeHandler(channel, args))
}

const guarded = globalThis.fetch

afterEach(() => {
  globalThis.fetch = guarded
})

describe('the userData tree the Rust Hub handlers write', () => {
  const answers = readAnswers()
  setupKeyLabelStore()
  setupI18nPackStore()
  setupThemePackStore()

  it('reads the linked, downloaded and refreshed entries as the crate does, writing nothing', async () => {
    const dir = copyOfRustTree()
    const before = readTree(dir)

    const labels = answers.keyLabels
    expect(await answer(IpcChannels.KEY_LABEL_STORE_LIST)).toBe(labels.list)
    expect(await answer(IpcChannels.KEY_LABEL_STORE_LIST_ALL)).toBe(labels.listAll)
    // QWERTY, the uploaded label and the downloaded one.
    expect(Object.keys(labels.gets)).toHaveLength(3)
    for (const [id, get] of Object.entries(labels.gets)) {
      expect(await answer(IpcChannels.KEY_LABEL_STORE_GET, id)).toBe(get)
    }

    // English, the uploaded pack and the one the startup update replaced.
    expect(Object.keys(answers.i18n.gets)).toHaveLength(3)
    expect(await answer(IpcChannels.I18N_PACK_STORE_LIST)).toBe(answers.i18n.list)
    for (const [id, get] of Object.entries(answers.i18n.gets)) {
      expect(await answer(IpcChannels.I18N_PACK_STORE_GET, id)).toBe(get)
    }
    expect(Object.keys(answers.themes.gets)).toHaveLength(2)
    expect(await answer(IpcChannels.THEME_PACK_STORE_LIST)).toBe(answers.themes.list)
    for (const [id, get] of Object.entries(answers.themes.gets)) {
      expect(await answer(IpcChannels.THEME_PACK_STORE_GET, id)).toBe(get)
    }

    expect(takeRecorded().notified).toEqual([])
    expect(readTree(dir)).toEqual(before)
  })

  it('finds every Hub-linked language pack up to date at startup, downloading and writing nothing', async () => {
    const dir = copyOfRustTree()
    const before = readTree(dir)
    globalThis.fetch = scriptedFetch()
    setRules([
      {
        method: 'POST',
        path: '/api/i18n-packs/timestamps',
        responses: [{ status: 200, json: { ok: true, data: answers.i18nHubTimestamps } }],
      },
    ])

    const result = await syncHubI18nPacksOnStartup()

    expect(result).toEqual({ checked: 2, updated: 0, missingOnHub: 0, errors: [] })
    expect(unusedRules()).toEqual([])
    const recorded = takeRecorded()
    expect(recorded.requests.map((request) => `${request.method} ${request.path}`)).toEqual([
      'POST /api/i18n-packs/timestamps',
    ])
    expect(recorded.notified).toEqual([])
    expect(recorded.events).toEqual([])
    expect(readTree(dir)).toEqual(before)
  })
})
