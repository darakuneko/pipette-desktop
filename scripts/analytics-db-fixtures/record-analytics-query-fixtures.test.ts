// SPDX-License-Identifier: GPL-2.0-or-later
// Fixture generator for the query layer of src-tauri/crates/
// pipette-typing-analytics, from the real IPC handlers
// (typing-analytics-service.ts, -ipc-analyze.ts, -ipc-range.ts) on the
// real better-sqlite3:
//
// - tests/fixtures/queries-seed.jsonl — the seed the cache holds
//   (query-calls.ts).
// - tests/fixtures/queries.json — each member call whose answer does not
//   depend on the time zone: the handler's answer as JSON text, on the
//   seed and the userData tree of query-calls.ts.
// - tests/fixtures/collation.json — `localeCompare` on n-gram ids
//   (query-calls.ts).
// - data/keycodes.rs — the keycode registry the Layout Comparison resolver
//   reads (keycode-source.ts).
//
// The calls that go through local days are recorded per time zone by
// tz-analytics-queries.test.ts.
//
// Run: pnpm run generate:analytics-db-fixtures

import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { writeFixture, writeJsonFixture } from '../fixture-files'
import { buildTree } from '../keyboard-store-fixtures/fixture-tree'

const pinned = vi.hoisted(() => ({
  userData: '',
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
}))

vi.mock('electron', () => ({ app: { getPath: () => pinned.userData } }))
vi.mock('node:os', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:os')>()),
  platform: () => 'linux',
  release: () => '6.8.0-test',
}))
vi.mock('../../src/main/logger', () => ({ log: () => undefined }))
vi.mock('../../src/main/typing-analytics/app-monitor', () => ({ getCurrentAppName: async () => null }))
vi.mock('../../src/main/typing-analytics/machine-hash', () => ({ getMachineHash: async () => 'hash-own' }))
vi.mock('../../src/main/ipc-guard', () => ({
  secureHandle: (channel: string, handler: (...args: unknown[]) => unknown) => {
    pinned.handlers.set(channel, handler)
  },
}))

import { TypingAnalyticsDB, setTypingAnalyticsDBForTests } from '../../src/main/typing-analytics/db/typing-analytics-db'
import { applyRowsToCache } from '../../src/main/typing-analytics/jsonl/apply-to-cache'
import { readRows } from '../../src/main/typing-analytics/jsonl/jsonl-reader'
import { setupTypingAnalyticsIpc } from '../../src/main/typing-analytics/typing-analytics-service'
import { IpcChannels } from '../../src/shared/ipc/channels'
import { buildKeycodeSource } from './keycode-source'
import { GENERATED_KEYCODES_PATH } from './paths'
import { OWN } from './db-methods'
import {
  COLLATION_FIXTURE_PATH, OS, QUERIES_FIXTURE_PATH, QUERY_SEED_PATH, QUERY_TREE,
  buildQuerySeed, channelKey, collationFixture, independentCalls, runCalls,
} from './query-calls'

afterEach(() => {
  if (pinned.userData) rmSync(pinned.userData, { recursive: true, force: true })
  pinned.userData = ''
})

describe('typing-analytics query fixtures', () => {
  it('records the seed, the member answers, the collation and the keycodes', async () => {
    writeFixture(GENERATED_KEYCODES_PATH, buildKeycodeSource())
    writeJsonFixture(COLLATION_FIXTURE_PATH, collationFixture())
    writeFixture(QUERY_SEED_PATH, buildQuerySeed())

    pinned.userData = mkdtempSync(join(tmpdir(), 'pipette-ta-queries-'))
    buildTree(pinned.userData, QUERY_TREE)
    const db = new TypingAnalyticsDB(join(pinned.userData, 'reads.db'))
    applyRowsToCache(db, (await readRows(QUERY_SEED_PATH)).rows)
    setTypingAnalyticsDBForTests(db)
    setupTypingAnalyticsIpc()
    const handler = (member: string) => {
      const channel = (IpcChannels as Record<string, string>)[channelKey(member)]
      const found = channel === undefined ? undefined : pinned.handlers.get(channel)
      if (!found) throw new Error(`no handler for ${member}`)
      return (...args: unknown[]) => found(undefined, ...args)
    }
    try {
      const calls = await runCalls(independentCalls(), handler)
      expect(calls.filter((call) => call.error)).toHaveLength(1)
      writeJsonFixture(QUERIES_FIXTURE_PATH, { ownHash: OWN, os: OS, tree: QUERY_TREE, calls })
    } finally {
      db.close()
    }
  })
})
