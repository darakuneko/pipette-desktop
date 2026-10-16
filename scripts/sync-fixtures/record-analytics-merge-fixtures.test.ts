// SPDX-License-Identifier: GPL-2.0-or-later
// Fixture generator for the typing-analytics merges and the own-hash
// reconcile of src-tauri/crates/pipette-sync. Every value comes from the
// real src/main/sync and src/main/typing-analytics code, run in the sync
// fixture harness (harness.ts) on a seeded userData and the real
// better-sqlite3 cache:
//   - merge scenarios: `mergeDeviceDayBundle` and
//     `mergeTypingDeletedRangesBundle` of a remote bundle (its plaintext),
//     `queueOwnDeletedRangesApply`, and `bundleSyncUnit` of the units; each
//     step records its outcome (the error kind, or whether Drive needs this
//     device's copy), the units the typing analytics announced, the tree
//     left behind and every cache table. Work an own-hash merge queues on
//     the flush chain is waited for before the step is recorded;
//   - reconcile scenarios: `reconcileOwnHashTypingAnalytics` on the listing
//     of the Node fake Drive (scripts/fake-drive), recording
//     `collectRemoteOwnHashDays`, whether Drive changed, the state it
//     returned, the requests it sent, the files left on Drive and the tree.
//     The requests go to www.googleapis.com as google-drive.ts writes them
//     and are sent on to the fake Drive on 127.0.0.1; nothing else is
//     reachable.
//
// Run: pnpm run generate:sync-fixtures

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { writeJsonFixture } from '../fixture-files'
import { REPO_ROOT } from '../fixture-vitest-config'
import { dumpTable } from '../analytics-db-fixtures/canonical'
import { startFakeDrive, type FakeDrive } from '../fake-drive/server'
import { FIXED_INSTALLATION_ID, FIXED_NOW, readTree, seedUserData, type Tree } from './harness'

const OUT = resolve(REPO_ROOT, 'src-tauri/crates/pipette-sync/tests/fixtures/ts_analytics_merge.json')

/** The machine id the Rust test gives its identity; with the harness's
 *  installation id it makes this device's hash. */
const MACHINE_ID = 'golden-machine'
const OWN = createHash('sha256').update(MACHINE_ID).update(FIXED_INSTALLATION_ID).digest('hex')
const REMOTE = 'remote-hash-1'
const OTHER = 'remote-hash-2'

const rec = vi.hoisted(() => ({ notified: [] as string[], warnings: [] as string[] }))

vi.mock('../../src/main/sync/google-auth', () => ({ getAccessToken: async () => 'fixture-token' }))
vi.mock('../../src/main/typing-analytics/machine-hash', async () => {
  const { createHash: hash } = await import('node:crypto')
  const { FIXED_INSTALLATION_ID: id } = await import('./harness')
  return { getMachineHash: vi.fn(async () => hash('sha256').update('golden-machine').update(id).digest('hex')) }
})
vi.mock('../../src/main/logger', () => ({
  log: vi.fn((level: string, message: string) => { if (level === 'warn') rec.warnings.push(message) }),
}))
vi.mock('../../src/main/sync/sync-service', () => ({ notifyChange: vi.fn() }))
vi.mock('../../src/main/utils/broadcast', () => ({ broadcastToAllWindows: vi.fn() }))
vi.mock('../../src/main/app-config', () => ({
  loadAppConfig: vi.fn(() => ({ autoSync: false })),
  saveAppConfig: vi.fn(async () => undefined),
  getAppConfigStore: vi.fn(() => ({ get: () => false })),
}))

import { mergeDeviceDayBundle } from '../../src/main/sync/sync-merge-dispatch'
import { mergeTypingDeletedRangesBundle, queueOwnDeletedRangesApply } from '../../src/main/sync/typing-deleted-ranges-merge'
import { collectRemoteOwnHashDays, reconcileOwnHashTypingAnalytics } from '../../src/main/sync/sync-typing-remote'
import { bundleSyncUnit } from '../../src/main/sync/sync-bundle'
import { driveFileName, listFiles } from '../../src/main/sync/google-drive'
import { syncRuntime } from '../../src/main/sync/sync-runtime-state'
import { TypingAnalyticsDB, resetTypingAnalyticsDBForTests, setTypingAnalyticsDBForTests } from '../../src/main/typing-analytics/db/typing-analytics-db'
import { DATA_TABLE_NAMES } from '../../src/main/typing-analytics/db/schema'
import { applyRowsToCache } from '../../src/main/typing-analytics/jsonl/apply-to-cache'
import { charMinuteRowId, minuteStatsRowId, parseRow, scopeRowId, sessionRowId, type JsonlRow } from '../../src/main/typing-analytics/jsonl/jsonl-row'
import { resetTypingAnalyticsForTests, setTypingAnalyticsSyncNotifier } from '../../src/main/typing-analytics/typing-analytics-state'
import { runOnFlushChain } from '../../src/main/typing-analytics/typing-analytics-pipeline'
import { parseTypingAnalyticsDeviceDaySyncUnit, parseTypingDeletedRangesSyncUnit } from '../../src/main/typing-analytics/sync'
import type { SyncBundle } from '../../src/shared/types/sync'

// ---- Rows ----

const MINUTE = 60_000
const DAY_MS = 86_400_000
/** 2026-10-14 and the days around it. */
const BASE = Date.UTC(2026, 9, 14)
const dayOf = (ms: number): string => new Date(ms).toISOString().slice(0, 10)
const D0 = dayOf(BASE)
const D1 = dayOf(BASE + DAY_MS)
const D2 = dayOf(BASE + 2 * DAY_MS)
const DM1 = dayOf(BASE - DAY_MS)
const DM2 = dayOf(BASE - 2 * DAY_MS)

const scopeIdOf = (hash: string, uid: string): string => `${hash}|linux|${uid}`

/** A day file of `hash` for `uid`: its scope, then a minute-stats and a
 *  char-minute row at each minute (offsets from the day's start), and one
 *  session over them. */
function dayText(hash: string, uid: string, day: string, minutes: number[], updatedAt = 1_000): string {
  const start = Date.parse(`${day}T00:00:00.000Z`)
  const scopeId = scopeIdOf(hash, uid)
  const rows: JsonlRow[] = [{
    id: scopeRowId(scopeId), kind: 'scope', updated_at: updatedAt,
    payload: {
      id: scopeId, machineHash: hash, osPlatform: 'linux', osRelease: '6.8.0', osArch: 'x64',
      keyboardUid: uid, keyboardVendorId: 1, keyboardProductId: 2, keyboardProductName: 'Pipette',
    },
  }]
  for (const m of minutes) {
    const ts = start + m * MINUTE
    rows.push({
      id: minuteStatsRowId(scopeId, ts, ''), kind: 'minute-stats', updated_at: updatedAt,
      payload: {
        scopeId, minuteTs: ts, keystrokes: 3 + m, activeMs: 1_000, intervalAvgMs: 100, intervalMinMs: 50,
        intervalP25Ms: 75, intervalP50Ms: 100, intervalP75Ms: 150, intervalMaxMs: 200,
      },
    })
    rows.push({
      id: charMinuteRowId(scopeId, ts, '', 'a'), kind: 'char-minute', updated_at: updatedAt,
      payload: { scopeId, minuteTs: ts, char: 'a', count: 2 + m },
    })
  }
  if (minutes.length > 0) {
    const sessionId = `${hash}-${day}`
    rows.push({
      id: sessionRowId(sessionId), kind: 'session', updated_at: updatedAt,
      payload: { id: sessionId, scopeId, startMs: start + minutes[0] * MINUTE, endMs: start + (minutes[minutes.length - 1] + 1) * MINUTE },
    })
  }
  return rows.map((row) => JSON.stringify(row)).join('\n') + '\n'
}

const dayPath = (uid: string, hash: string, day: string): string => `sync/keyboards/${uid}/devices/${hash}/${day}.jsonl`
const rangesPath = (uid: string, hash: string): string => `sync/keyboards/${uid}/devices/${hash}/deleted-ranges.json`
const dayUnit = (uid: string, hash: string, day: string): string => `keyboards/${uid}/devices/${hash}/days/${day}`
const rangesUnit = (uid: string, hash: string): string => `keyboards/${uid}/devices/${hash}/deleted-ranges`
const json = (value: unknown): string => JSON.stringify(value, null, 2)

/** A range over `fromMin`..`toMin` minutes of `day`, cut off at its end. */
function range(id: string, day: string, fromMin: number, toMin: number): Record<string, unknown> {
  const start = Date.parse(`${day}T00:00:00.000Z`)
  return { id, startMs: start + fromMin * MINUTE, endMs: start + toMin * MINUTE, cutoffMs: start + toMin * MINUTE }
}

const rangesFile = (entries: unknown[]): string => json({ version: 1, entries })

const FRESH_STATE = json({ _rev: 3, my_device_id: OWN, uploaded: {}, reconciled_at: {}, last_synced_at: 0 })

function dayBundle(uid: string, hash: string, day: string, data: unknown): SyncBundle {
  return { type: 'typing-analytics-device', key: `${uid}|${hash}|${day}`, index: { uid, entries: [] }, files: { 'data.jsonl': data } } as SyncBundle
}

function rangesBundle(uid: string, hash: string, file: unknown): SyncBundle {
  return { type: 'typing-deleted-ranges', key: `${uid}|${hash}`, index: { uid, entries: [] }, files: { 'deleted-ranges.json': file } } as SyncBundle
}

// ---- Merge scenarios ----

type MergeStep =
  | { day: { unit: string; plaintext: string }; holds?: boolean }
  | { ranges: { unit: string; plaintext: string }; holds?: boolean }
  | { queueOwn: true; holds?: boolean }
  | { bundle: string[] }

interface MergeScenario {
  name: string
  tree: Tree
  /** Day files applied to the cache before the steps. The cache is set
   *  here without a rebuild, while the Rust replay opens it from the tree;
   *  every day file of the tree that holds rows is listed here, so both
   *  start from the same rows. */
  cache?: string[]
  steps: MergeStep[]
}

const day = (unit: string, bundle: unknown, holds?: boolean): MergeStep =>
  ({ day: { unit, plaintext: typeof bundle === 'string' ? bundle : JSON.stringify(bundle) }, ...(holds ? { holds } : {}) })
const ranges = (unit: string, bundle: unknown, holds?: boolean): MergeStep =>
  ({ ranges: { unit, plaintext: typeof bundle === 'string' ? bundle : JSON.stringify(bundle) }, ...(holds ? { holds } : {}) })

const REMOTE_D0 = dayText(REMOTE, 'kb1', D0, [600, 601, 602, 700])
const OWN_D0 = dayText(OWN, 'kb1', D0, [600, 601, 602])
const OWN_D1 = dayText(OWN, 'kb1', D1, [10, 11])

const MERGE_SCENARIOS: MergeScenario[] = [
  {
    name: 'a day of another device replays with its deleted ranges hidden',
    tree: {
      'local/typing-analytics/sync_state.json': FRESH_STATE,
      [rangesPath('kb1', REMOTE)]: rangesFile([range('r1', D0, 600, 602), range('r-other-day', D1, 0, 10)]),
      [dayPath('kb1', REMOTE, D0)]: 'old local copy\n',
    },
    steps: [
      day(dayUnit('kb1', REMOTE, D0), dayBundle('kb1', REMOTE, D0, REMOTE_D0)),
      { bundle: [dayUnit('kb1', REMOTE, D0), rangesUnit('kb1', REMOTE)] },
      day(dayUnit('kb1', OTHER, D0), dayBundle('kb1', OTHER, D0, dayText(OTHER, 'kb1', D0, [5]))),
      day(dayUnit('kb2', REMOTE, D1), dayBundle('kb2', REMOTE, D1, 'not rows\n{"id":1}\n')),
    ],
  },
  {
    name: 'an own day is never merged and odd bundles fail or do nothing',
    tree: {
      'local/typing-analytics/sync_state.json': FRESH_STATE,
      [dayPath('kb1', OWN, D0)]: OWN_D0,
    },
    cache: [OWN_D0],
    steps: [
      day(dayUnit('kb1', OWN, D0), dayBundle('kb1', OWN, D0, dayText(OWN, 'kb1', D0, [1]))),
      day(dayUnit('kb1', OWN, D0), 'null'),
      day(dayUnit('kb1', REMOTE, D0), 'null'),
      day(dayUnit('kb1', REMOTE, D0), '"text"'),
      day(dayUnit('kb1', REMOTE, D0), { type: 'typing-analytics-device' }),
      day(dayUnit('kb1', REMOTE, D0), { files: null }),
      day(dayUnit('kb1', REMOTE, D0), { files: 'abc' }),
      day(dayUnit('kb1', REMOTE, D0), { files: {} }),
      day(dayUnit('kb1', REMOTE, D0), dayBundle('kb1', REMOTE, D0, '')),
      day(dayUnit('kb1', REMOTE, D0), dayBundle('kb1', REMOTE, D0, 0)),
      day(dayUnit('kb1', REMOTE, D1), dayBundle('kb1', REMOTE, D1, 5)),
      day(dayUnit('kb1', REMOTE, D2), dayBundle('kb1', REMOTE, D2, { a: 1 })),
      day(dayUnit('kb1', REMOTE, DM1), dayBundle('kb1', REMOTE, DM1, [dayText(REMOTE, 'kb1', DM1, [3]), dayText(REMOTE, 'kb1', DM1, [4])])),
      day(dayUnit('kb1', REMOTE, DM2), dayBundle('kb1', REMOTE, DM2, ['a', 1])),
    ],
  },
  {
    name: 'a day merge without a readable sync state starts an empty one',
    tree: { 'local/typing-analytics/sync_state.json': '{' },
    steps: [day(dayUnit('kb1', REMOTE, D0), dayBundle('kb1', REMOTE, D0, REMOTE_D0))],
  },
  {
    name: 'deleted ranges of another device: the union, the cache tombstones and what Drive lacks',
    tree: {
      'local/typing-analytics/sync_state.json': FRESH_STATE,
      [dayPath('kb1', REMOTE, D0)]: REMOTE_D0,
      [rangesPath('kb1', REMOTE)]: rangesFile([range('local-only', D0, 700, 701)]),
    },
    cache: [REMOTE_D0, OWN_D0],
    steps: [
      ranges(rangesUnit('kb1', REMOTE), rangesBundle('kb1', REMOTE, rangesFile([range('r1', D0, 600, 601), { id: 'bad', startMs: -5 }]))),
      { bundle: [rangesUnit('kb1', REMOTE)] },
      ranges(rangesUnit('kb1', REMOTE), rangesBundle('kb1', REMOTE, rangesFile([range('local-only', D0, 700, 701), range('r1', D0, 600, 601)]))),
      ranges(rangesUnit('kb1', OTHER), rangesBundle('kb1', OTHER, rangesFile([range('o1', D0, 0, 1)]))),
      ranges(rangesUnit('kb1', OTHER), rangesBundle('kb1', OTHER, rangesFile([]))),
    ],
  },
  {
    name: 'broken deleted-ranges bundles keep the local file',
    tree: {
      'local/typing-analytics/sync_state.json': FRESH_STATE,
      [rangesPath('kb1', REMOTE)]: rangesFile([range('keep', D0, 1, 2)]),
      [rangesPath('kb2', REMOTE)]: '{not json',
    },
    steps: [
      ranges(rangesUnit('kb1', REMOTE), rangesBundle('kb1', REMOTE, '{"version":1,"entries":5}')),
      ranges(rangesUnit('kb1', REMOTE), rangesBundle('kb1', REMOTE, '{')),
      ranges(rangesUnit('kb1', REMOTE), rangesBundle('kb1', REMOTE, 7)),
      ranges(rangesUnit('kb1', REMOTE), { files: {} }),
      ranges(rangesUnit('kb1', REMOTE), { index: {} }),
      ranges(rangesUnit('kb1', REMOTE), { files: null }),
      ranges(rangesUnit('kb1', REMOTE), { files: [] }),
      ranges(rangesUnit('kb1', REMOTE), { files: 'text' }),
      ranges(rangesUnit('kb1', REMOTE), 'null'),
      ranges(rangesUnit('kb1', REMOTE), '"text"'),
      ranges(rangesUnit('kb1', REMOTE), rangesBundle('kb1', REMOTE, '[]')),
      ranges(rangesUnit('kb2', REMOTE), rangesBundle('kb2', REMOTE, rangesFile([range('a', D0, 1, 2)]))),
      ranges(rangesUnit('kb2', REMOTE), rangesBundle('kb2', REMOTE, '{')),
      ranges(rangesUnit('kb2', REMOTE), rangesBundle('kb2', REMOTE, '{"version":1,"entries":5}')),
    ],
  },
  {
    name: 'deleted ranges of this device are applied to its own days on the flush chain',
    tree: {
      'local/typing-analytics/sync_state.json': FRESH_STATE,
      [dayPath('kb1', OWN, D0)]: OWN_D0,
      [dayPath('kb1', OWN, D1)]: OWN_D1,
    },
    cache: [OWN_D0, OWN_D1],
    steps: [
      ranges(rangesUnit('kb1', OWN), rangesBundle('kb1', OWN, rangesFile([range('mine', D0, 600, 601)]))),
      ranges(rangesUnit('kb1', OWN), rangesBundle('kb1', OWN, rangesFile([range('mine', D0, 600, 601), range('held', D1, 10, 11)])), true),
      ranges(rangesUnit('kb1', OWN), rangesBundle('kb1', OWN, rangesFile([range('mine', D0, 600, 601), range('held', D1, 10, 11)]))),
      { bundle: [rangesUnit('kb1', OWN), dayUnit('kb1', OWN, D0), dayUnit('kb1', OWN, D1)] },
    ],
  },
  {
    name: 'the apply queued after a pass covers every keyboard with own ranges',
    tree: {
      'local/typing-analytics/sync_state.json': FRESH_STATE,
      [dayPath('kb1', OWN, D0)]: OWN_D0,
      [rangesPath('kb1', OWN)]: rangesFile([range('a', D0, 600, 602)]),
      [dayPath('kb2', OWN, D0)]: dayText(OWN, 'kb2', D0, [5, 6]),
      [rangesPath('kb2', OWN)]: rangesFile([range('b', D0, 5, 6)]),
      [rangesPath('kb3', OWN)]: '{broken',
      [rangesPath('kb4', REMOTE)]: rangesFile([range('c', D0, 5, 6)]),
    },
    cache: [OWN_D0, dayText(OWN, 'kb2', D0, [5, 6])],
    steps: [
      { queueOwn: true, holds: true },
      { queueOwn: true },
      { queueOwn: true },
    ],
  },
]

// ---- Reconcile scenarios ----

/** A file put on Drive before the reconcile, in this order; a trash file
 *  of `trashOf` gets the id the fake Drive gives it. */
type DriveSeed = { name: string } | { trashOf: string }

interface ReconcileScenario {
  name: string
  tree: Tree
  drive: DriveSeed[]
  /** The next delete requests fail with this status. */
  failDeletes?: { status: number; count: number }
}

const dn = (uid: string, hash: string, d: string): string => driveFileName(dayUnit(uid, hash, d))
const state = (uploaded: unknown, reconciled: unknown): string =>
  json({ _rev: 3, my_device_id: OWN, uploaded, reconciled_at: reconciled, last_synced_at: 7 })

const RECONCILE_SCENARIOS: ReconcileScenario[] = [
  {
    name: 'rules 2 and 3 once the orphans are reconciled',
    tree: {
      'local/typing-analytics/sync_state.json': state({ [`kb1|${OWN}`]: [D0, DM1, D1, D1], [`kb9|${REMOTE}`]: [D0] }, { [`kb1|${OWN}`]: 5_000 }),
      [dayPath('kb1', OWN, D0)]: OWN_D0,
      [dayPath('kb1', OWN, D1)]: OWN_D1,
      [dayPath('kb1', OWN, D2)]: OWN_D1,
    },
    drive: [
      { name: dn('kb1', OWN, D0) },
      { name: dn('kb1', OWN, DM1) },
      { name: dn('kb1', OWN, DM1) },
      { trashOf: dn('kb1', OWN, DM1) },
      { name: dn('kb1', OWN, DM2) },
      { name: dn('kb1', REMOTE, D0) },
      { name: driveFileName(rangesUnit('kb1', OWN)) },
    ],
  },
  {
    name: 'orphans of a pending reconcile go, with every copy and trash file',
    tree: {
      'local/typing-analytics/sync_state.json': state({ [`kb1|${OWN}`]: [D0] }, { [`kb1|${OWN}`]: null, [`kb2|${OWN}`]: 9 }),
      [dayPath('kb1', OWN, D0)]: OWN_D0,
      [dayPath('kb1', OWN, D1)]: OWN_D1,
    },
    drive: [
      { name: dn('kb1', OWN, D0) },
      { name: dn('kb1', OWN, D2) },
      { trashOf: dn('kb1', OWN, D2) },
      { name: dn('kb1', OWN, D2) },
      { trashOf: dn('kb3', OWN, DM1) },
      { name: dn('kb2', OWN, DM2) },
      { name: dn('kb1', REMOTE, D2) },
      { trashOf: dn('kb1', OWN, D1) },
    ],
  },
  {
    name: 'nothing to change leaves the state file alone',
    tree: {
      'local/typing-analytics/sync_state.json': state({ [`kb1|${OWN}`]: [D0] }, { [`kb1|${OWN}`]: 5_000 }),
      [dayPath('kb1', OWN, D0)]: OWN_D0,
    },
    drive: [{ name: dn('kb1', OWN, D0) }, { name: dn('kb1', OWN, D1) }],
  },
  {
    name: 'without a state every keyboard is reconciled for the first time',
    tree: {
      [dayPath('kb1', OWN, D0)]: OWN_D0,
      [dayPath('kb1', OWN, 'notaday')]: '',
      [`sync/keyboards/kb1/devices/${OWN}/${D1}.jsonl/`]: null,
      'sync/keyboards/file-not-dir': '',
    },
    drive: [{ name: dn('kb1', OWN, D0) }, { name: dn('kb1', OWN, D2) }, { name: dn('kb5', OWN, D2) }],
  },
  {
    name: 'an uploaded record that is an array is read as empty and written back as it was',
    tree: {
      'local/typing-analytics/sync_state.json': json({ _rev: 3, my_device_id: OWN, uploaded: [[D0]], reconciled_at: [5], last_synced_at: 7 }),
      [dayPath('kb1', OWN, D0)]: OWN_D0,
    },
    drive: [{ name: dn('kb1', OWN, D0) }, { name: dn('kb1', OWN, D2) }],
  },
  {
    name: 'a failed delete is logged and the pass goes on',
    tree: {
      'local/typing-analytics/sync_state.json': state({ [`kb1|${OWN}`]: [D0, D1] }, { [`kb1|${OWN}`]: 5_000 }),
    },
    drive: [{ name: dn('kb1', OWN, D0) }, { name: dn('kb1', OWN, D1) }, { name: dn('kb1', OWN, D1) }],
    failDeletes: { status: 403, count: 1 },
  },
]

// ---- Recording ----

function errorName(err: unknown): string {
  if (err instanceof Error) {
    if (err.name === 'MalformedSyncBundleError') return err.name
    return err instanceof TypeError || err instanceof SyntaxError ? 'TypeError' : 'Error'
  }
  return 'Error'
}

function dumpTables(db: TypingAnalyticsDB): Record<string, string[]> {
  return Object.fromEntries(DATA_TABLE_NAMES.map((table) => [table, dumpTable(db.getConnection(), table, true).rows ?? []]))
}

/** Waits until the flush chain has run everything queued so far, also work
 *  queued after a few awaits. */
async function settleChain(): Promise<void> {
  for (let i = 0; i < 5; i++) {
    await new Promise((r) => setTimeout(r, 5))
    await runOnFlushChain(() => undefined)
  }
}

function rowsOf(text: string): JsonlRow[] {
  return text.split('\n').map((line) => parseRow(line)).filter((row): row is JsonlRow => row !== null)
}

async function runMergeStep(userData: string, db: TypingAnalyticsDB, step: MergeStep): Promise<Record<string, unknown>> {
  rec.notified.length = 0
  if ('bundle' in step) {
    const bundles = []
    for (const unit of step.bundle) {
      const b = await bundleSyncUnit(unit)
      bundles.push({ unit, plaintext: b ? JSON.stringify(b) : null })
    }
    return { bundles }
  }
  const holds = step.holds === true
  if (holds) syncRuntime.resetKeyboards = 'all'
  let outcome: Record<string, unknown>
  try {
    if ('day' in step) {
      const ref = parseTypingAnalyticsDeviceDaySyncUnit(step.day.unit)!
      await mergeDeviceDayBundle(JSON.parse(step.day.plaintext) as SyncBundle, ref, userData, OWN)
      outcome = { ok: null }
    } else if ('ranges' in step) {
      const ref = parseTypingDeletedRangesSyncUnit(step.ranges.unit)!
      outcome = { needsUpload: await mergeTypingDeletedRangesBundle(step.ranges.unit, JSON.parse(step.ranges.plaintext) as SyncBundle, ref, userData, OWN) }
    } else {
      queueOwnDeletedRangesApply()
      outcome = { ok: null }
    }
  } catch (err) {
    outcome = { error: errorName(err) }
  }
  await settleChain()
  if (holds) syncRuntime.resetKeyboards = null
  return { ...outcome, notified: [...rec.notified], tree: readTree(userData), tables: dumpTables(db) }
}

async function recordMerge(scenario: MergeScenario) {
  resetTypingAnalyticsForTests()
  setTypingAnalyticsSyncNotifier((unit: string) => { rec.notified.push(unit) })
  const userData = seedUserData(scenario.tree)
  mkdirSync(`${userData}-paths`, { recursive: true })
  const db = new TypingAnalyticsDB(join(`${userData}-paths`, 'cache.db'))
  setTypingAnalyticsDBForTests(db)
  try {
    for (const text of scenario.cache ?? []) applyRowsToCache(db, rowsOf(text))
    const steps = []
    for (const step of scenario.steps) steps.push({ step, result: await runMergeStep(userData, db, step) })
    return { name: scenario.name, tree: { 'local/installation-id': FIXED_INSTALLATION_ID, ...scenario.tree }, cache: scenario.cache ?? [], steps }
  } finally {
    resetTypingAnalyticsDBForTests()
    setTypingAnalyticsSyncNotifier(null)
  }
}

const GOOGLE_API_ORIGIN = 'https://www.googleapis.com'

describe('analytics merge fixtures', () => {
  let drive: FakeDrive

  beforeAll(async () => {
    drive = await startFakeDrive()
  })

  afterAll(async () => {
    await drive.close()
  })

  async function recordReconcile(scenario: ReconcileScenario) {
    drive.state.reset()
    scenario.drive.forEach((seed, i) => {
      const name = 'name' in seed ? seed.name : `${seed.trashOf}.trash.${FIXED_NOW - 1_000}.${FIXED_NOW - 2_000}.fake-${i + 1}`
      drive.state.create(name, Buffer.from('{}'), 'application/json')
    })
    const userData = seedUserData(scenario.tree)
    rec.warnings.length = 0
    const requests: string[] = []
    const guarded = globalThis.fetch
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : input.toString())
      if (url.origin !== GOOGLE_API_ORIGIN) throw new Error(`google-drive.ts sent a request to ${url.origin}`)
      const method = (init?.method ?? 'GET').toUpperCase()
      const id = /^\/drive\/v3\/files\/([^/]+)$/.exec(url.pathname)?.[1]
      requests.push(method === 'DELETE' && id ? `delete ${id}` : method === 'GET' && url.pathname === '/drive/v3/files' ? 'list' : `${method} ${url.pathname}`)
      return guarded(`${drive.url}${url.pathname}${url.search}`, init)
    }) as typeof fetch
    try {
      const listing = await listFiles()
      const days = (hash: string) => Object.fromEntries([...collectRemoteOwnHashDays(listing, hash)].map(([uid, byDay]) =>
        [uid, [...byDay].map(([d, remote]) => [d, remote.name, remote.live?.id ?? null])]))
      const collected = { own: days(OWN), remote: days(REMOTE) }
      if (scenario.failDeletes) drive.state.inject({ ...scenario.failDeletes, only: 'delete' })
      const result = await reconcileOwnHashTypingAnalytics(listing, userData, OWN)
      return {
        name: scenario.name,
        tree: { 'local/installation-id': FIXED_INSTALLATION_ID, ...scenario.tree },
        drive: scenario.drive,
        failDeletes: scenario.failDeletes ?? null,
        listing: listing.map((f) => ({ id: f.id, name: f.name, modifiedTime: f.modifiedTime })),
        collected,
        mutated: result.mutated,
        state: JSON.stringify(result.state, null, 2),
        // In the order sent: the deletes of one day start 5 at a time, in
        // the order of the files.
        requests,
        warnings: rec.warnings.length,
        driveAfter: drive.state.files.map((f) => ({ id: f.id, name: f.name })),
        treeAfter: readTree(userData),
      }
    } finally {
      globalThis.fetch = guarded
    }
  }

  it('records every scenario', async () => {
    const merges = []
    for (const scenario of MERGE_SCENARIOS) merges.push(await recordMerge(scenario))
    const reconciles = []
    for (const scenario of RECONCILE_SCENARIOS) reconciles.push(await recordReconcile(scenario))
    expect(merges.length).toBe(MERGE_SCENARIOS.length)
    expect(reconciles.length).toBe(RECONCILE_SCENARIOS.length)
    writeJsonFixture(OUT, {
      about: 'The typing-analytics merges and the own-hash reconcile of the TypeScript sync code. Generated by scripts/sync-fixtures/record-analytics-merge-fixtures.test.ts; do not edit.',
      machineId: MACHINE_ID,
      ownHash: OWN,
      now: FIXED_NOW,
      merges,
      reconciles,
    })
  })
})
