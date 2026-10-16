// SPDX-License-Identifier: GPL-2.0-or-later
// Rust → TypeScript check for src-tauri/crates/pipette-typing-datasets: the
// crate's test tests/rust_user_data.rs (`cargo test -p
// pipette-typing-datasets --test rust_user_data`) writes a userData tree
// with the Rust language store (the Hub overrides of every provider, the
// downloaded word lists, one moved from the legacy flat directory) and an
// Aozora Bunko import into the typing test texts, and records what the
// store answers on it. This runs the real handlers of the Electron build on
// a copy of that tree, with `net.fetch` answering the Hub's recorded
// replies, and checks that they answer the same, byte for byte, and write
// nothing:
//
// - LANG_LIST of every provider, LANG_GET of the downloaded lists and of a
//   bundled one;
// - TYPING_DATASET_CHECK of every provider (the overrides' versions are
//   the Hub's);
// - TYPING_TEST_TEXT_LIST / TYPING_TEST_TEXT_GET of the imported work.
//
// Run: pnpm run verify:typing-dataset-rust-user-data

import { afterAll, describe, expect, it, vi } from 'vitest'
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { cargoTargetTmpDir } from '../fixture-files'
import { readTree } from '../rust-user-data-tree'

const { handlers, notified, state } = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  notified: [] as string[],
  state: { userData: '', replies: {} as Record<string, string>, urls: [] as string[] },
}))

vi.mock('electron', () => ({
  app: { getPath: () => state.userData },
  net: {
    fetch: async (url: string) => {
      state.urls.push(url)
      const hex = state.replies[url]
      if (hex === undefined) throw new Error(`no reply recorded for ${url}`)
      return new Response(Buffer.from(hex, 'hex'), { status: 200 })
    },
  },
}))
vi.mock('../../src/main/logger', () => ({ log: () => {} }))
vi.mock('../../src/main/ipc-guard', () => ({
  secureHandle: (channel: string, handler: (...args: unknown[]) => unknown) => handlers.set(channel, handler),
}))
vi.mock('../../src/main/sync/sync-service', () => ({ notifyChange: (unit: string) => notified.push(unit) }))

import { setupLanguageStore } from '../../src/main/language-store'
import { setupTypingTestTextStore } from '../../src/main/typing-test-text-ipc'
import { IpcChannels } from '../../src/shared/ipc/channels'

const RUST_DIR = resolve(cargoTargetTmpDir('pipette-typing-datasets'), 'rust_user_data')

interface Answers {
  /** Provider → the LANG_LIST answer as JSON text. */
  lists: Record<string, string>
  /** `{provider}/{name}` → the LANG_GET answer as JSON text. */
  gets: Record<string, string>
  /** Provider → updateAvailable of TYPING_DATASET_CHECK. */
  checks: Record<string, boolean>
  typingTexts: { list: string; gets: Record<string, string> }
}

function readJson<T>(name: string): T {
  const path = join(RUST_DIR, name)
  if (!existsSync(path)) {
    throw new Error(`${path} is missing; run cargo test -p pipette-typing-datasets --test rust_user_data first`)
  }
  return JSON.parse(readFileSync(path, 'utf-8')) as T
}

function handler(channel: string): (...args: unknown[]) => Promise<unknown> {
  const found = handlers.get(channel)
  if (!found) throw new Error(`${channel} is not registered`)
  return found as (...args: unknown[]) => Promise<unknown>
}

let copy = ''
afterAll(() => {
  if (copy) rmSync(copy, { recursive: true, force: true })
})

describe('the userData tree the Rust language store writes', () => {
  const answers = readJson<Answers>('answers.json')
  state.replies = readJson<Record<string, string>>('replies.json')
  copy = mkdtempSync(join(tmpdir(), 'rust-dataset-user-data-'))
  cpSync(join(RUST_DIR, 'user-data'), copy, { recursive: true })
  state.userData = copy
  const before = readTree(copy)
  setupLanguageStore()
  setupTypingTestTextStore()

  it('lists every provider’s word lists as the crate does', async () => {
    expect(Object.keys(answers.lists)).toEqual(['monkeytype', 'tatoeba', 'aozora'])
    for (const [provider, list] of Object.entries(answers.lists)) {
      expect(JSON.stringify(await handler(IpcChannels.LANG_LIST)({}, provider))).toBe(list)
    }
  })

  it('reads the downloaded word lists as the crate does', async () => {
    expect(Object.keys(answers.gets)).toHaveLength(4)
    for (const [key, text] of Object.entries(answers.gets)) {
      const [provider, name] = key.split('/')
      // The command answers the file's text, which the shim parses.
      expect(JSON.stringify(await handler(IpcChannels.LANG_GET)({}, name, provider))).toBe(JSON.stringify(JSON.parse(text)))
    }
  })

  it('finds no update of a dataset the crate stored the Hub’s version of', async () => {
    for (const [provider, updateAvailable] of Object.entries(answers.checks)) {
      expect(await handler(IpcChannels.TYPING_DATASET_CHECK)({}, provider)).toEqual({ provider, updateAvailable })
    }
    expect(state.urls).toHaveLength(Object.keys(answers.checks).length)
  })

  it('lists and reads the imported Aozora Bunko work as the crate does', async () => {
    const rust = answers.typingTexts
    expect(JSON.stringify(await handler(IpcChannels.TYPING_TEST_TEXT_LIST)({}))).toBe(rust.list)
    expect(Object.keys(rust.gets)).toHaveLength(1)
    for (const [id, get] of Object.entries(rust.gets)) {
      expect(JSON.stringify(await handler(IpcChannels.TYPING_TEST_TEXT_GET)({}, id))).toBe(get)
    }
  })

  it('wrote and reported nothing while reading', () => {
    expect(notified).toEqual([])
    expect(readTree(copy)).toEqual(before)
  })
})
