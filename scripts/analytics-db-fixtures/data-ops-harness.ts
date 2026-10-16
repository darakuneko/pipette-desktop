// SPDX-License-Identifier: GPL-2.0-or-later
// The scenarios of the data-operation fixture generators
// (record-analytics-data-ops-fixtures.test.ts, tz-data-ops.test.ts): a
// userData tree, then steps of recording, deletes, export, import, cache
// rebuild, the apply of this device's own deleted ranges and the typing-view
// heatmap, each run through the real TypeScript code on a temp directory and
// the real better-sqlite3 cache. Each scenario records the answer of every
// step, the sync units announced in order, the log lines, the files under
// sync/, local/typing-analytics/ and exports/, and every cache table.
//
// The test files mock what this module needs (electron, the logger, the
// machine hash, the OS, randomUUID, unlink, the sync notifier) with the
// answers of data-ops-pinned.ts, which this module sets per scenario.

import { vi } from 'vitest'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { buildTree, recordTree, type Tree } from '../keyboard-store-fixtures/fixture-tree'
import { dumpTable } from './canonical'
import { pinned } from './data-ops-pinned'
import {
  closeSessionsForUid,
  flushNow,
  flushTypingAnalyticsBeforeQuit,
  hasTypingAnalyticsPendingWork,
  ingestEvent,
  isValidEvent,
  runOnFlushChain,
} from '../../src/main/typing-analytics/typing-analytics-pipeline'
import {
  resetTypingAnalyticsForTests,
  setTypingAnalyticsSyncNotifier,
  taState,
} from '../../src/main/typing-analytics/typing-analytics-state'
import { getTypingAnalyticsDB, resetTypingAnalyticsDBForTests } from '../../src/main/typing-analytics/db/typing-analytics-db'
import { DATA_TABLE_NAMES } from '../../src/main/typing-analytics/db/schema'
import { deleteAllTypingForKeyboard, deleteTypingDailySummaries } from '../../src/main/typing-analytics/typing-analytics-retention'
import { deleteDeviceTypingData } from '../../src/main/sync/typing-device-delete'
import { ensureCacheIsFresh, rebuildCacheFromMasterFiles } from '../../src/main/typing-analytics/cache-rebuild'
import {
  applyOwnDeletedRangesForAllKeyboards,
  prepareOwnDeletedRangesReapply,
} from '../../src/main/typing-analytics/deleted-ranges-apply'
import { exportTypingDataForKeyboard, importTypingDataFiles } from '../../src/main/typing-analytics/import-export'
import { getMatrixHeatmap } from '../../src/main/typing-analytics/typing-analytics-queries'

export const MACHINE_ID = 'golden-machine'
export const INSTALLATION_ID = '0f1e2d3c-4b5a-4697-8877-665544332211'
export const OWN_HASH = createHash('sha256').update(MACHINE_ID).update(INSTALLATION_ID).digest('hex')
pinned.ownHash = OWN_HASH
export const OS = { platform: 'linux', release: '6.8.0-golden', arch: 'x64' }
export const REMOTE_HASH = 'remote-hash-1'
export const OTHER_REMOTE_HASH = 'remote-hash-2'

/** The ids randomUUID hands out, in order. */
export const IDS = Array.from({ length: 32 }, (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`)

/** The state file of a cache that is up to date for this device. */
export const FRESH_SYNC_STATE =
  JSON.stringify({ _rev: 3, my_device_id: OWN_HASH, uploaded: {}, reconciled_at: {}, last_synced_at: 0 }, null, 2)

export type Step =
  | { op: 'event'; payload: unknown }
  | { op: 'advance'; ms: number }
  | { op: 'flush'; uid: string }
  | { op: 'quit' }
  /** The Local tab's Delete All (`own`) or Reset Keyboard Data (`all`),
   *  with the current time as the cutoff. */
  | { op: 'deleteAll'; uid: string; scope: 'own' | 'all' }
  /** The Local tab's delete of local days, the current time the cutoff. */
  | { op: 'deleteDays'; uid: string; dates: string[] }
  /** The Sync tab's delete of a device's data, the current time the cutoff. */
  | { op: 'deleteDevice'; uid: string; hash: string; dates: string[] | 'all' }
  /** The export into `dir` under userData. */
  | { op: 'export'; uid: string; dates: string[]; dir: string }
  /** The import of `files` (paths under userData), offline. */
  | { op: 'import'; files: string[] }
  | { op: 'rebuild' }
  /** The startup check: rebuilds when sync_state.json asks for it. */
  | { op: 'ensureFresh' }
  /** The startup apply of this device's own deleted ranges. */
  | { op: 'applyOwnRanges' }
  | { op: 'heatmap'; uid: string; layer: number; since: number }
  /** Makes the unlink of `path` (under userData) fail with EACCES. */
  | { op: 'failUnlink'; path: string }
  | { op: 'write'; path: string; content: string }
  | { op: 'mkdir'; path: string }
  | { op: 'remove'; path: string }

export interface Scenario {
  name: string
  /** The clock when the scenario starts. */
  start: number
  /** The userData tree before the first step. */
  tree: Tree
  steps: Step[]
}

// --- seed rows -----------------------------------------------------------

const KEYBOARD = { vendorId: 0xfeed, productId: 0, productName: 'Pipette Keyboard' }
const MINUTE = 60_000

function scopeIdOf(hash: string, uid: string): string {
  return `${hash}|${uid}`
}

function line(row: object): string {
  return JSON.stringify(row) + '\n'
}

function utcDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10)
}

export interface SeedOptions {
  /** Every third time also gets a session of 40 minutes. */
  sessions?: boolean
  updatedAt?: number
}

/** Day files of (`uid`, `hash`) with rows at each of `times` (minute
 *  starts): a minute-stats, a char-minute, a matrix-minute and a
 *  bigram-minute row each, sessions on every third time. */
export function seedDays(uid: string, hash: string, times: number[], options: SeedOptions = {}): Tree {
  const scopeId = scopeIdOf(hash, uid)
  const updatedAt = options.updatedAt ?? 1_000
  const byDay = new Map<string, string[]>()
  const scope = line({
    id: `scope|${scopeId}`,
    kind: 'scope',
    updated_at: updatedAt,
    payload: {
      id: scopeId, machineHash: hash, osPlatform: 'linux', osRelease: '6.8.0', osArch: 'x64',
      keyboardUid: uid, keyboardVendorId: KEYBOARD.vendorId, keyboardProductId: KEYBOARD.productId,
      keyboardProductName: KEYBOARD.productName,
    },
  })
  times.forEach((t, i) => {
    const day = utcDay(t)
    const lines = byDay.get(day) ?? [scope]
    byDay.set(day, lines)
    const common = { scopeId, minuteTs: t }
    lines.push(line({
      id: `ms|${t}`, kind: 'minute-stats', updated_at: updatedAt,
      payload: { ...common, keystrokes: 10 + i, activeMs: 5_000, intervalAvgMs: 120, intervalMinMs: 50,
        intervalP25Ms: 80, intervalP50Ms: 110, intervalP75Ms: 150, intervalMaxMs: 400 },
    }))
    lines.push(line({ id: `ch|${t}`, kind: 'char-minute', updated_at: updatedAt, payload: { ...common, char: 'a', count: 3 + i } }))
    lines.push(line({
      id: `mx|${t}`, kind: 'matrix-minute', updated_at: updatedAt,
      payload: { ...common, row: 0, col: i % 4, layer: 0, keycode: 4 + (i % 4), count: 2, tapCount: 1, holdCount: 0 },
    }))
    lines.push(line({
      id: `bg|${t}`, kind: 'bigram-minute', updated_at: updatedAt,
      payload: { ...common, bigrams: {
        '4_5': { c: 2, h: [0, 1, 1, 0, 0, 0, 0, 0], s: 300, sq: 45_000 },
        [`5_${6 + (i % 3)}`]: { c: 1, h: [0, 0, 1, 0, 0, 0, 0, 0] },
      } },
    }))
    if (options.sessions && i % 3 === 0) {
      lines.push(line({
        id: `session|${hash}-${t}`, kind: 'session', updated_at: updatedAt,
        payload: { id: `${hash}-${t}`, scopeId, startMs: t, endMs: t + 40 * MINUTE },
      }))
    }
  })
  const tree: Tree = {}
  for (const [day, lines] of byDay) {
    tree[`sync/keyboards/${uid}/devices/${hash}/${day}.jsonl`] = lines.join('')
  }
  return tree
}

/** A deleted-ranges file of `entries` [id, startMs, endMs, cutoffMs]. */
export function rangesFile(entries: Array<[string, number, number, number]>): string {
  return JSON.stringify({
    version: 1,
    entries: entries.map(([id, startMs, endMs, cutoffMs]) => ({ id, startMs, endMs, cutoffMs })),
  }, null, 2)
}

export function rangesPath(uid: string, hash: string): string {
  return `sync/keyboards/${uid}/devices/${hash}/deleted-ranges.json`
}

export function dayPath(uid: string, hash: string, day: string): string {
  return `sync/keyboards/${uid}/devices/${hash}/${day}.jsonl`
}

// --- running -------------------------------------------------------------

/** `text` with the userData directory as `<userData>` and the text of an
 *  OS error (Node's `E…: …`) as `<os error>`. */
function normalize(text: string): string {
  return text.replaceAll(pinned.userData, '<userData>').replace(/E[A-Z]+: .*$/, '<os error>')
}

/** Waits for the flush chain, and whatever it queues while it runs. A
 *  failed task was answered to its caller already. */
async function settle(): Promise<void> {
  for (;;) {
    const chain = taState.flushChain
    await chain.catch(() => undefined)
    if (chain === taState.flushChain) return
  }
}

async function answer(step: Step): Promise<unknown> {
  const userData = pinned.userData
  switch (step.op) {
    case 'event':
      if (isValidEvent(step.payload)) await ingestEvent(step.payload)
      return undefined
    case 'advance':
      vi.advanceTimersByTime(step.ms)
      return undefined
    case 'flush':
      closeSessionsForUid(step.uid)
      await flushNow({ final: true })
      return undefined
    case 'quit':
      if (hasTypingAnalyticsPendingWork()) await flushTypingAnalyticsBeforeQuit()
      return undefined
    case 'deleteAll':
      return deleteAllTypingForKeyboard(step.uid, Date.now(), step.scope)
    case 'deleteDays':
      return deleteTypingDailySummaries(step.uid, step.dates, Date.now())
    case 'deleteDevice':
      await deleteDeviceTypingData(step.uid, step.hash, step.dates, Date.now())
      return undefined
    case 'export':
      return (await exportTypingDataForKeyboard(userData, step.uid, OWN_HASH, join(userData, step.dir), new Set(step.dates))).written
    case 'import': {
      // importTypingFiles (sync-ipc.ts), offline.
      const result = await importTypingDataFiles(userData, step.files.map((file) => join(userData, file)), {
        cloudHasFile: null,
        runExclusive: runOnFlushChain,
        prepareReplace: prepareOwnDeletedRangesReapply,
      })
      if (result.imported > 0) await ensureCacheIsFresh(getTypingAnalyticsDB(), userData, OWN_HASH, { force: true })
      return result
    }
    case 'rebuild':
      return rebuildCacheFromMasterFiles(getTypingAnalyticsDB(), userData, OWN_HASH)
    case 'ensureFresh':
      return (await ensureCacheIsFresh(getTypingAnalyticsDB(), userData, OWN_HASH)).rebuilt
    case 'applyOwnRanges':
      await applyOwnDeletedRangesForAllKeyboards(userData, OWN_HASH, () => false)
      return undefined
    case 'heatmap':
      return getMatrixHeatmap(step.uid, step.layer, step.since)
    case 'failUnlink':
      pinned.unlinkFailures.add(join(userData, step.path))
      return undefined
    case 'write':
      mkdirSync(dirname(join(userData, step.path)), { recursive: true })
      writeFileSync(join(userData, step.path), step.content)
      return undefined
    case 'mkdir':
      mkdirSync(join(userData, step.path), { recursive: true })
      return undefined
    case 'remove':
      rmSync(join(userData, step.path), { recursive: true, force: true })
      return undefined
  }
}

/** The answer of a step as JSON text, `{ error }` when it threw. */
async function outcome(step: Step): Promise<string | null> {
  try {
    const value = await answer(step)
    return value === undefined ? null : JSON.stringify(value)
  } catch (err) {
    return JSON.stringify({ error: normalize(err instanceof Error ? err.message : String(err)) })
  } finally {
    await settle()
  }
}

/** A file larger than this is recorded as its SHA-256 in a compact
 *  fixture. */
const COMPACT_FILE_BYTES = 2_048

/** The files under the subtrees the data operations write; in a compact
 *  fixture a large file as `{ sha256 }` of its bytes. */
function recordedFiles(userData: string, compact: boolean): Record<string, Tree[string] | { sha256: string }> {
  const tree: Record<string, Tree[string] | { sha256: string }> = {}
  for (const root of ['sync', 'local/typing-analytics', 'exports']) {
    let files: Tree
    try {
      files = recordTree(join(userData, root))
    } catch {
      continue
    }
    for (const [path, content] of Object.entries(files)) {
      if (content === null) continue
      const bytes = typeof content === 'string' ? Buffer.from(content, 'utf-8') : Buffer.from(content.hex, 'hex')
      tree[`${root}/${path}`] = compact && bytes.length > COMPACT_FILE_BYTES
        ? { sha256: createHash('sha256').update(bytes).digest('hex') }
        : content
    }
  }
  return tree
}

/** Runs `scenarios`; a `compact` fixture holds large files as their SHA-256
 *  and each table as its row count and SHA-256 (canonical.ts). */
export async function runScenarios(scenarios: Scenario[], { compact = false } = {}): Promise<unknown[]> {
  const results = []
  for (const scenario of scenarios) {
    pinned.userData = mkdtempSync(join(tmpdir(), 'pipette-ta-data-ops-'))
    buildTree(pinned.userData, scenario.tree)
    pinned.ids = [...IDS]
    pinned.unlinkFailures.clear()
    pinned.logs.length = 0
    pinned.units.length = 0
    resetTypingAnalyticsForTests()
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    vi.setSystemTime(scenario.start)
    setTypingAnalyticsSyncNotifier((unit) => pinned.units.push(unit))
    try {
      const outcomes: Array<string | null> = []
      for (const step of scenario.steps) outcomes.push(await outcome(step))
      const db = getTypingAnalyticsDB().getConnection()
      const tables = Object.fromEntries(DATA_TABLE_NAMES.map((table) => [table, dumpTable(db, table, !compact)]))
      results.push({
        name: scenario.name,
        start: scenario.start,
        tree: scenario.tree,
        steps: scenario.steps,
        expected: {
          outcomes,
          units: [...pinned.units],
          logs: pinned.logs.map(normalize),
          files: recordedFiles(pinned.userData, compact),
          tables,
        },
      })
    } finally {
      resetTypingAnalyticsDBForTests()
      resetTypingAnalyticsForTests()
      vi.useRealTimers()
      rmSync(pinned.userData, { recursive: true, force: true })
      pinned.userData = ''
    }
  }
  return results
}
