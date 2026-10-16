// SPDX-License-Identifier: GPL-2.0-or-later
// Fixture generator for the query layer of src-tauri/crates/
// pipette-typing-analytics: the member calls that go through local days
// (query-calls.ts), answered by the real IPC handlers in the zone this
// process runs in (run-time-zones.ts), on the seed and tree
// record-analytics-query-fixtures.test.ts wrote, to
// tests/fixtures/queries_tz/<zone>.json.
//
// Run: pnpm run generate:analytics-db-fixtures

import { afterEach, describe, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { writeJsonFixture } from '../fixture-files'
import { buildTree } from '../keyboard-store-fixtures/fixture-tree'

const pinned = vi.hoisted(() => ({
  userData: '',
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
}))

vi.mock('electron', () => ({ app: { getPath: () => pinned.userData } }))
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
import { QUERIES_TZ_FIXTURES_DIR, QUERY_SEED_PATH, QUERY_TREE, channelKey, localTimeCalls, runCalls } from './query-calls'
import { recordingTimeZone, zoneSlug } from './time-zones'

afterEach(() => {
  if (pinned.userData) rmSync(pinned.userData, { recursive: true, force: true })
  pinned.userData = ''
})

describe('typing-analytics query local-time fixtures', () => {
  it('records the local-time member answers of this time zone', async () => {
    const timeZone = recordingTimeZone()
    pinned.userData = mkdtempSync(join(tmpdir(), 'pipette-ta-queries-tz-'))
    buildTree(pinned.userData, QUERY_TREE)
    const db = new TypingAnalyticsDB(join(pinned.userData, 'reads.db'))
    applyRowsToCache(db, (await readRows(QUERY_SEED_PATH)).rows)
    setTypingAnalyticsDBForTests(db)
    setupTypingAnalyticsIpc()
    const handler = (member: string) => {
      const found = pinned.handlers.get((IpcChannels as Record<string, string>)[channelKey(member)])
      if (!found) throw new Error(`no handler for ${member}`)
      return (...args: unknown[]) => found(undefined, ...args)
    }
    try {
      const calls = await runCalls(localTimeCalls(), handler)
      writeJsonFixture(join(QUERIES_TZ_FIXTURES_DIR, `${zoneSlug(timeZone)}.json`), { timeZone, calls })
    } finally {
      db.close()
    }
  })
})
