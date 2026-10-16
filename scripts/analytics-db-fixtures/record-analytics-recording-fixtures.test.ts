// SPDX-License-Identifier: GPL-2.0-or-later
// Fixture generator for the recording of src-tauri/crates/pipette-typing-analytics
// (pipeline/): scenarios of events, timer advances, explicit flushes and the
// quit, run through the real pipeline (typing-analytics-pipeline.ts) with the
// typingAnalyticsEvent / typingAnalyticsFlush handlers of
// typing-analytics-service.ts, on a userData directory in a temp directory
// and the real better-sqlite3 cache.
//
// recording.json holds, per scenario, the steps and what they left: whether
// work was pending and how many sync units had been announced after each
// step, the sync units announced in order, the
// files under sync/ and local/typing-analytics/, and every cache table.
//
// The clock and the timers are fake: the debounce timer fires only when a
// step advances the time, and the flush it starts runs at the end of that
// advance. After each step the flush chain is let run to its end. The
// machine hash, the OS, the session ids and the application names are fixed.
//
// Run: pnpm run generate:analytics-db-fixtures

import { afterEach, describe, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, rmdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { writeJsonFixture } from '../fixture-files'
import { buildTree, recordTree, type Tree } from '../keyboard-store-fixtures/fixture-tree'
import { dumpTable } from './canonical'
import { ANALYTICS_FIXTURES_DIR } from './paths'

const MACHINE_ID = 'golden-machine'
const INSTALLATION_ID = '0f1e2d3c-4b5a-4697-8877-665544332211'
const OWN_HASH = createHash('sha256').update(MACHINE_ID).update(INSTALLATION_ID).digest('hex')
const OS = { platform: 'linux', release: '6.8.0-golden', arch: 'x64' }

const pinned = vi.hoisted(() => ({
  userData: '',
  appNames: [] as Array<string | null>,
  sessionIds: [] as string[],
}))

vi.mock('electron', () => ({ app: { getPath: () => pinned.userData } }))
vi.mock('../../src/main/logger', () => ({ log: () => undefined }))
vi.mock('../../src/main/typing-analytics/app-monitor', () => ({
  getCurrentAppName: async () => pinned.appNames.shift() ?? null,
}))
vi.mock('../../src/main/typing-analytics/machine-hash', () => ({ getMachineHash: async () => OWN_HASH }))
vi.mock('node:os', async () => {
  const actual = await vi.importActual<typeof import('node:os')>('node:os')
  return { ...actual, platform: () => OS.platform, release: () => OS.release, arch: () => OS.arch }
})
vi.mock('node:crypto', async () => {
  const actual = await vi.importActual<typeof import('node:crypto')>('node:crypto')
  return {
    ...actual,
    randomUUID: () => {
      const id = pinned.sessionIds.shift()
      if (!id) throw new Error('out of session ids')
      return id
    },
  }
})

import {
  closeSessionsForUid,
  flushNow,
  flushTypingAnalyticsBeforeQuit,
  hasTypingAnalyticsPendingWork,
  ingestEvent,
  isValidEvent,
} from '../../src/main/typing-analytics/typing-analytics-pipeline'
import {
  resetTypingAnalyticsForTests,
  setTypingAnalyticsSyncNotifier,
  taState,
} from '../../src/main/typing-analytics/typing-analytics-state'
import { getTypingAnalyticsDB, resetTypingAnalyticsDBForTests } from '../../src/main/typing-analytics/db/typing-analytics-db'
import { DATA_TABLE_NAMES } from '../../src/main/typing-analytics/db/schema'

type Step =
  | { op: 'event'; payload: unknown }
  | { op: 'advance'; ms: number }
  | { op: 'flush'; uid: unknown }
  | { op: 'quit' }
  /** A directory where a file of `path` would go, so writing it fails. */
  | { op: 'block'; path: string }
  | { op: 'unblock'; path: string }

interface Scenario {
  name: string
  /** The clock when the scenario starts. */
  start: number
  appNames: Array<string | null>
  steps: Step[]
}

const KB_A = { uid: '0xAABB', vendorId: 0xfeed, productId: 0, productName: 'Pipette Keyboard' }
const KB_B = { uid: '0xCCDD', vendorId: 0x1234, productId: 1, productName: 'Other "60" 日本' }
const MINUTE = 60_000

function char(keyboard: object, ts: number, key: string, extra: object = {}): Step {
  return { op: 'event', payload: { kind: 'char', key, ts, keyboard, ...extra } }
}

function press(keyboard: object, ts: number, row: number, col: number, keycode: number, extra: object = {}): Step {
  return { op: 'event', payload: { kind: 'matrix', row, col, layer: 0, keycode, ts, keyboard, ...extra } }
}

function release(keyboard: object, ts: number, row: number, col: number, keycode: number, durationMs: number): Step {
  return {
    op: 'event',
    payload: { kind: 'matrix-release', row, col, layer: 0, keycode, ts, durationMs, keyboard },
  }
}

/** 2026-10-15 23:58:10 UTC: the minutes run into the next UTC day. */
const T0 = Date.UTC(2026, 9, 15, 23, 58, 10)

const RECORDING: Scenario = {
  name: 'recording',
  start: T0,
  appNames: ['Code', 'Code', 'Firefox', null, 'Terminal \u0007 ', 'Code'],
  steps: [
    char(KB_A, T0 + 100, 'a'),
    press(KB_A, T0 + 200, 0, 1, 4, { action: 'tap', overlap: false, pollGapMs: 8 }),
    press(KB_A, T0 + 350, 0, 2, 5, { overlap: true, pollGapMs: 12 }),
    press(KB_A, T0 + 350, 0, 3, 6, { overlap: true }),
    press(KB_A, T0 + 500, 1, 0, 0x7000, { action: 'hold', pollGapMs: 15 }),
    press(KB_A, T0 + 700, 0, 1, 4, { action: 'double', overlap: 1, pollGapMs: 250 }),
    press(KB_A, T0 + 900, 0, 2, 5, { overlap: false, pollGapMs: 9 }),
    press(KB_A, T0 + 1100, 0, 3, 6, { overlap: null }),
    release(KB_A, T0 + 1150, 0, 1, 4, 120),
    release(KB_A, T0 + 1160, 0, 2, 5, 45.5),
    { op: 'event', payload: { kind: 'char', key: '', ts: T0 + 1170, keyboard: KB_A } },
    { op: 'event', payload: { kind: 'matrix', row: -1, col: 0, layer: 0, keycode: 4, ts: T0 + 1170, keyboard: KB_A } },
    { op: 'event', payload: { kind: 'matrix-release', row: 0, col: 0, layer: 0, keycode: 4, ts: T0 + 1170, durationMs: 0, keyboard: KB_A } },
    { op: 'event', payload: { kind: 'char', key: 'z', ts: T0 + 1170, keyboard: { ...KB_A, uid: '' } } },
    char(KB_B, T0 + 1200, 'x'),
    press(KB_B, T0 + 1300, 2, 2, 30),
    press(KB_A, T0 + 1400, 0, 1, 4, { runId: 'run-1', typingTest: 'words (english)' }),
    press(KB_A, T0 + 1500, 0, 2, 5, { runId: 'run-1', typingTest: 'words (english)' }),
    press(KB_A, T0 + 1600, 3, 3, 1e21),
    press(KB_A, T0 + 1700, 3, 4, 4.5),
    press(KB_A, T0 + 1750, 3, 5, -0),
    char(KB_A, T0 + 1800, '日'),
    char(KB_A, T0 + 1900, '|'),
    { op: 'advance', ms: 1_000 },
    char(KB_A, T0 + 2_000, 'a'),
    { op: 'advance', ms: 60_000 },
    // A straggler into the minute already written.
    press(KB_A, T0 + 5_000, 0, 1, 4),
    { op: 'advance', ms: 1_000 },
    char(KB_A, T0 + 108_000, 'b'),
    press(KB_A, T0 + 111_000, 0, 1, 4),
    release(KB_A, T0 + 111_500, 0, 1, 4, 300),
    { op: 'flush', uid: '0xAABB' },
    { op: 'flush', uid: '' },
    { op: 'flush', uid: 7 },
    char(KB_A, T0 + 115_000, 'c'),
    { op: 'advance', ms: 6 * MINUTE },
    // Too late for its minute, which the last flush evicted.
    char(KB_A, T0 + 200, 'q'),
    char(KB_B, T0 + 6 * MINUTE + 70_000, 'y'),
    { op: 'advance', ms: 1_000 },
    { op: 'quit' },
    { op: 'quit' },
  ],
}

/** 2026-10-16 12:00:30 UTC. */
const T1 = Date.UTC(2026, 9, 16, 12, 0, 30)
const DAY_DIR = (uid: string): string => `sync/keyboards/${uid}/devices/${OWN_HASH}`

const FAILURE: Scenario = {
  name: 'failed flushes',
  start: T1,
  appNames: ['Code', 'Firefox', 'Code'],
  steps: [
    { op: 'block', path: `${DAY_DIR('0xAABB')}/2026-10-16.jsonl` },
    char(KB_A, T1 + 100, 'a'),
    press(KB_A, T1 + 200, 0, 1, 4),
    press(KB_A, T1 + 300, 0, 2, 5),
    { op: 'flush', uid: '0xAABB' },
    char(KB_A, T1 + 400, 'b'),
    { op: 'advance', ms: 1_000 },
    { op: 'unblock', path: `${DAY_DIR('0xAABB')}/2026-10-16.jsonl` },
    { op: 'advance', ms: 1_000 },
    // One day written, the next one failing: nothing is announced, and the
    // next flush writes both again.
    { op: 'block', path: `${DAY_DIR('0xCCDD')}/2026-10-17.jsonl` },
    char(KB_B, Date.UTC(2026, 9, 16, 23, 59, 50), 'x'),
    char(KB_B, Date.UTC(2026, 9, 17, 0, 0, 5), 'y'),
    { op: 'flush', uid: '0xCCDD' },
    { op: 'unblock', path: `${DAY_DIR('0xCCDD')}/2026-10-17.jsonl` },
    { op: 'advance', ms: 1_000 },
    { op: 'quit' },
  ],
}

const SCENARIOS = [RECORDING, FAILURE]

/** The session ids the scenarios draw, in order. */
const SESSION_IDS = Array.from({ length: 16 }, (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`)

/** The state file a cache that is up to date for this device has. */
const FRESH_SYNC_STATE =
  JSON.stringify({ _rev: 3, my_device_id: OWN_HASH, uploaded: {}, reconciled_at: {}, last_synced_at: 0 }, null, 2)

/** Waits for the flush chain, and whatever it queues while it runs. */
async function settle(): Promise<void> {
  for (;;) {
    const chain = taState.flushChain
    await chain
    if (chain === taState.flushChain) return
  }
}

async function run(step: Step): Promise<void> {
  switch (step.op) {
    case 'event':
      // The typingAnalyticsEvent handler.
      if (isValidEvent(step.payload)) await ingestEvent(step.payload)
      break
    case 'advance':
      vi.advanceTimersByTime(step.ms)
      break
    case 'flush':
      // The typingAnalyticsFlush handler.
      if (typeof step.uid === 'string' && step.uid.length > 0) {
        closeSessionsForUid(step.uid)
        await flushNow({ final: true })
      }
      break
    case 'quit':
      if (hasTypingAnalyticsPendingWork()) await flushTypingAnalyticsBeforeQuit()
      break
    case 'block':
      mkdirSync(join(pinned.userData, step.path), { recursive: true })
      break
    case 'unblock':
      rmdirSync(join(pinned.userData, step.path))
      break
  }
  await settle()
}

/** The files under the subtrees the recording writes. */
function recordedFiles(userData: string): Tree {
  const tree: Tree = {}
  for (const root of ['sync', 'local/typing-analytics']) {
    for (const [path, content] of Object.entries(recordTree(join(userData, root)))) {
      if (content !== null) tree[`${root}/${path}`] = content
    }
  }
  return tree
}

afterEach(() => {
  resetTypingAnalyticsDBForTests()
  resetTypingAnalyticsForTests()
  vi.useRealTimers()
  if (pinned.userData) rmSync(pinned.userData, { recursive: true, force: true })
  pinned.userData = ''
})

describe('recording fixtures', () => {
  it('records the recording scenarios', async () => {
    const results = []
    for (const scenario of SCENARIOS) {
      pinned.userData = mkdtempSync(join(tmpdir(), 'pipette-ta-recording-'))
      buildTree(pinned.userData, { 'local/typing-analytics/sync_state.json': FRESH_SYNC_STATE })
      pinned.appNames = [...scenario.appNames]
      pinned.sessionIds = [...SESSION_IDS]
      resetTypingAnalyticsForTests()
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
      vi.setSystemTime(scenario.start)
      const units: string[] = []
      setTypingAnalyticsSyncNotifier((unit) => units.push(unit))

      const pendingWork: boolean[] = []
      const unitCounts: number[] = []
      for (const step of scenario.steps) {
        await run(step)
        pendingWork.push(hasTypingAnalyticsPendingWork())
        unitCounts.push(units.length)
      }
      const db = getTypingAnalyticsDB().getConnection()
      const tables = Object.fromEntries(DATA_TABLE_NAMES.map((table) => [table, dumpTable(db, table, true)]))
      results.push({
        name: scenario.name,
        start: scenario.start,
        appNames: scenario.appNames,
        steps: scenario.steps,
        expected: { pendingWork, unitCounts, units, files: recordedFiles(pinned.userData), tables },
      })

      resetTypingAnalyticsDBForTests()
      resetTypingAnalyticsForTests()
      vi.useRealTimers()
      rmSync(pinned.userData, { recursive: true, force: true })
      pinned.userData = ''
    }
    writeJsonFixture(join(ANALYTICS_FIXTURES_DIR, 'recording.json'), {
      machineId: MACHINE_ID,
      installationId: INSTALLATION_ID,
      ownHash: OWN_HASH,
      os: OS,
      sessionIds: SESSION_IDS,
      freshSyncState: FRESH_SYNC_STATE,
      scenarios: results,
    })
  })
})
