// SPDX-License-Identifier: GPL-2.0-or-later
// The DB method fixtures of the Rust port (src-tauri/crates/
// pipette-typing-analytics-db): a seed of JSONL rows built for the reads,
// the method calls made on it, the write scenarios, and the canonical form
// of what each call returns. record-db-methods.test.ts records the calls
// whose answer does not depend on the time zone; tz-db-methods.test.ts
// records the ones that group by SQLite's `localtime`, once per zone of
// time-zones.ts.
//
// The canonical form keeps every number as the bits of its double
// (`r:<16 hex>`, as canonical.ts writes a REAL) and every string as
// `s:<text>`, so the Rust side compares values exactly whatever its own
// types; a Map becomes the array of its [key, value] entries in order and
// an undefined property is left out, as JSON leaves it.

import { join } from 'node:path'
import { truncateCache } from '../../src/main/typing-analytics/cache-rebuild'
import type { TypingAnalyticsDB } from '../../src/main/typing-analytics/db/typing-analytics-db'
import { COMMITTED_FIXTURES_DIR } from './paths'
import { realBits } from './canonical'

export const METHODS_SEED_PATH = join(COMMITTED_FIXTURES_DIR, 'methods-seed.jsonl')
export const METHODS_FIXTURE_PATH = join(COMMITTED_FIXTURES_DIR, 'methods.json')
export const METHODS_TZ_FIXTURES_DIR = join(COMMITTED_FIXTURES_DIR, 'methods_tz')

export const UID_A = 'uid-a'
export const UID_B = 'uid-b'
export const OWN = 'hash-own'
export const REMOTE = 'hash-remote'
const REMOTE_DELETED = 'hash-remote-deleted'
const REMOTE_NO_STATS = 'hash-remote-no-stats'

const MINUTE = 60_000
const HOUR = 60 * MINUTE

/** An ordinary UTC day of the Analyze window cases. */
const DAY = Date.UTC(2026, 9, 15)

/** Minutes around local midnights of the fixture zones: New York's 23 and
 * 25 hour days, Santiago's missing midnight, Havana's doubled one, Tokyo's
 * and UTC's midnights at a year end, a minute before the epoch and one in
 * a two-digit year (read back as the 1900s). */
export const BOUNDARY_MINUTES: readonly number[] = [
  Date.UTC(2026, 2, 8, 4, 59), Date.UTC(2026, 2, 8, 5, 0),
  Date.UTC(2026, 2, 9, 3, 59), Date.UTC(2026, 2, 9, 4, 0),
  Date.UTC(2026, 10, 1, 3, 59), Date.UTC(2026, 10, 1, 4, 0),
  Date.UTC(2026, 10, 2, 4, 59), Date.UTC(2026, 10, 2, 5, 0),
  Date.UTC(2024, 8, 8, 3, 59), Date.UTC(2024, 8, 8, 4, 0),
  Date.UTC(2024, 10, 3, 3, 59), Date.UTC(2024, 10, 3, 4, 30), Date.UTC(2024, 10, 3, 5, 30),
  Date.UTC(2026, 0, 1, 14, 59), Date.UTC(2026, 0, 1, 15, 0),
  Date.UTC(2025, 11, 31, 23, 59), Date.UTC(2026, 0, 1, 0, 0),
  -MINUTE,
  Date.parse('0050-06-15T12:00:00.000Z'),
]

const hist = (...values: number[]): number[] => [...values, ...new Array<number>(8 - values.length).fill(0)]

function line(kind: string, payload: Record<string, unknown>, updatedAt = 1_000, isDeleted?: boolean): string {
  return JSON.stringify({ id: kind, kind, updated_at: updatedAt, ...(isDeleted === undefined ? {} : { is_deleted: isDeleted }), payload })
}

function scope(id: string, uid: string, machineHash: string, extra: Record<string, unknown> = {}, updatedAt = 1_000, isDeleted?: boolean): string {
  return line('scope', {
    id, machineHash, osPlatform: 'linux', osRelease: '6.8.0', osArch: 'x64', keyboardUid: uid,
    keyboardVendorId: 0xfeed, keyboardProductId: 0x0001, keyboardProductName: 'Alpha', ...extra,
  }, updatedAt, isDeleted)
}

interface Tags { appName?: string | null; typingTest?: string | null; runId?: string }

function stats(scopeId: string, minuteTs: number, keystrokes: number, activeMs: number, tags: Tags = {}, extra: Record<string, unknown> = {}): string {
  return line('minute-stats', {
    scopeId, minuteTs, keystrokes, activeMs,
    intervalAvgMs: 120, intervalMinMs: 40 + keystrokes, intervalP25Ms: 90, intervalP50Ms: 110.5, intervalP75Ms: 150, intervalMaxMs: 300 + keystrokes,
    ...tags, ...extra,
  })
}

function matrix(scopeId: string, minuteTs: number, cell: [row: number, col: number, layer: number], keycode: number, count: number, tap: number, hold: number, tags: Tags = {}, extra: Record<string, unknown> = {}): string {
  const [row, col, layer] = cell
  return line('matrix-minute', { scopeId, minuteTs, row, col, layer, keycode, count, tapCount: tap, holdCount: hold, ...tags, ...extra })
}

/** The seed: three devices of keyboard A (one of them tombstoned, one
 * without minute stats), keyboard B, and a keyboard with a scope only. */
export function buildMethodsSeed(): string {
  const own = 'scope-own-a'
  const ownOld = 'scope-own-a-old'
  const remote = 'scope-remote-a'
  const remoteNew = 'scope-remote-a-new'
  const lines: string[] = [
    scope(own, UID_A, OWN),
    scope(ownOld, UID_A, OWN, { osRelease: '6.1.0' }, 900),
    scope(remote, UID_A, REMOTE, { osPlatform: 'darwin', osRelease: '24.0.0', osArch: 'arm64', keyboardProductName: 'Alpha (mac)' }),
    scope(remoteNew, UID_A, REMOTE, { osPlatform: 'darwin', osRelease: '25.0.0', osArch: 'arm64', keyboardProductName: 'Alpha (mac)' }, 2_000),
    scope('scope-remote-deleted', UID_A, REMOTE_DELETED, { osPlatform: 'win32', osRelease: '10.0.26100' }, 1_500, true),
    scope('scope-remote-no-stats', UID_A, REMOTE_NO_STATS),
    scope('scope-own-b', UID_B, OWN, { keyboardVendorId: 0x1234, keyboardProductId: 0x5678, keyboardProductName: 'beta' }),
    scope('scope-empty', 'uid-empty', OWN, { keyboardProductName: 'Empty' }),
  ]

  // A window of minutes on DAY: apps, typing tests, runs, fractions, tags
  // shared between devices, and the seconds just inside and outside.
  const t = (h: number, m: number): number => DAY + h * HOUR + m * MINUTE
  lines.push(
    stats(own, t(10, 0), 30, 30_000, { appName: 'Code' }, { pollP50Ms: 8, pollP95Ms: 16.5 }),
    stats(own, t(10, 1), 12, 20_000, { appName: 'Slack' }),
    stats(own, t(10, 2), 2.5, 1_234.5, {}, { pollP50Ms: null, pollP95Ms: 30 }),
    stats(own, t(10, 3), 40, 60_000, { appName: 'Code', typingTest: 'words (english)', runId: 'run-1' }),
    stats(own, t(10, 4), 35, 60_000, { appName: 'Code', typingTest: 'words (english)', runId: 'run-1' }),
    stats(own, t(10, 4), 20, 30_000, { typingTest: 'novel.txt', runId: 'run-2' }),
    stats(own, t(10, 5), 0, 0, { appName: 'Code' }),
    stats(own, t(10, 6), 9, 0, { appName: 'Idle' }),
    stats(ownOld, t(10, 0), 5, 5_000, { appName: 'Code' }, { pollP50Ms: 12, pollP95Ms: 20 }),
    stats(remote, t(10, 0), 50, 45_000, { appName: 'Code' }),
    stats(remoteNew, t(10, 1), 7, 9_000, { appName: 'Mail' }),
    stats('scope-remote-deleted', t(10, 1), 999, 1_000, { appName: 'Code' }),
    stats('scope-own-b', t(10, 2), 11, 11_000, { appName: 'Code' }),
    line('minute-stats', {
      scopeId: own, minuteTs: t(10, 7), keystrokes: 3, activeMs: 3_000,
      intervalAvgMs: null, intervalMinMs: null, intervalP25Ms: null, intervalP50Ms: null, intervalP75Ms: null, intervalMaxMs: null,
      appName: 'Code',
    }),
    line('minute-stats', {
      scopeId: own, minuteTs: t(10, 8), keystrokes: 4, activeMs: 4_000,
      intervalAvgMs: 1, intervalMinMs: 1, intervalP25Ms: 1, intervalP50Ms: 1, intervalP75Ms: 1, intervalMaxMs: 1,
    }, 2_000, true),
  )
  lines.push(
    matrix(own, t(10, 0), [0, 1, 0], 4, 10, 0, 0, { appName: 'Code' }, { dh: hist(1, 2, 3), ds: 512.5, dq: 70_000.25 }),
    matrix(own, t(10, 0), [0, 2, 1], 42, 3, 0, 0, { appName: 'Code' }),
    matrix(own, t(10, 1), [0, 1, 0], 4, 6, 0, 0, { appName: 'Slack' }, { dh: hist(0, 1), ds: 80, dq: 6_400 }),
    matrix(own, t(10, 1), [1, 0, 0], 0x402a, 5, 3, 2, { appName: 'Slack' }),
    matrix(own, t(10, 2), [1, 1, 0], 0x202a, 4, 1, 3),
    matrix(own, t(10, 2), [1, 2, 2], 0x4105, 2, 0, 2, {}, { dh: hist(0, 0, 0, 4), ds: 900, dq: 202_500 }),
    matrix(own, t(10, 3), [2, 0, 0], 44.5, 8, 0, 0, { appName: 'Code', typingTest: 'words (english)', runId: 'run-1' }),
    matrix(own, t(10, 4), [2, 1, 0], 5, 7, 0, 0, { typingTest: 'novel.txt', runId: 'run-2' }),
    matrix(remote, t(10, 0), [0, 1, 0], 4, 20, 0, 0, { appName: 'Code' }, { dh: hist(5), ds: 100, dq: 2_000 }),
    matrix(remoteNew, t(10, 1), [0, 2, 1], 42, 1, 0, 0, { appName: 'Mail' }),
    matrix('scope-remote-no-stats', t(10, 1), [3, 3, 0], 42, 9, 0, 0),
    matrix('scope-remote-deleted', t(10, 1), [0, 1, 0], 4, 99, 0, 0),
    matrix('scope-own-b', t(10, 2), [0, 1, 0], 4, 11, 0, 0, { appName: 'Code' }),
    line('matrix-minute', { scopeId: own, minuteTs: t(10, 5), row: 0, col: 1, layer: 0, keycode: 4, count: 0, tapCount: 0, holdCount: 0 }, 2_000, true),
  )
  lines.push(
    line('bigram-minute', {
      scopeId: own, minuteTs: t(10, 0), appName: 'Code',
      bigrams: { '4_5': { c: 3, h: hist(1, 2), s: 300.5, sq: 30_100.25, oc: 1, on: 2 }, '5_6': { c: 1, h: hist(0, 1), oc: 0, on: 1 }, '10_4': { c: 2, h: hist(2) } },
    }),
    line('bigram-minute', { scopeId: own, minuteTs: t(10, 1), appName: 'Slack', bigrams: { '4_5': { c: 2, h: hist(0, 2), oc: 2, on: 2 } } }),
    line('bigram-minute', { scopeId: own, minuteTs: t(10, 2), bigrams: { '6_7': { c: 1, h: hist(1) } } }),
    line('bigram-minute', { scopeId: remote, minuteTs: t(10, 0), appName: 'Code', bigrams: { '4_5': { c: 5, h: hist(5), s: 500, sq: 50_000, oc: 3, on: 4 } } }),
    line('bigram-minute', { scopeId: own, minuteTs: t(10, 3), typingTest: 'words (english)', runId: 'run-1', bigrams: { '4_5': { c: 1, h: hist(1), oc: 1, on: 1 } } }),
    line('bigram-minute', { scopeId: own, minuteTs: t(10, 5), bigrams: { '4_5': { c: 1, h: hist(1), oc: 1, on: 1 } } }, 2_000, true),
    line('trigram-minute', { scopeId: own, minuteTs: t(10, 0), appName: 'Code', trigrams: { '4_5_6': { c: 2, h: hist(0, 2), s: 400, sq: 80_000 }, '10_4_5': { c: 1, h: hist(1) } } }),
    line('trigram-minute', { scopeId: remote, minuteTs: t(10, 1), trigrams: { '4_5_6': { c: 1, h: hist(1) } } }),
  )
  lines.push(
    line('session', { id: 'session-1', scopeId: own, startMs: t(9, 58), endMs: t(10, 3) }),
    line('session', { id: 'session-2', scopeId: own, startMs: t(10, 4), endMs: t(10, 4) + 45_000 }),
    line('session', { id: 'session-3', scopeId: remote, startMs: t(10, 0), endMs: t(10, 30) }),
    line('session', { id: 'session-4', scopeId: own, startMs: t(10, 6), endMs: t(10, 7) }, 2_000, true),
    line('char-minute', { scopeId: own, minuteTs: t(10, 0), char: 'a', count: 3, appName: 'Code' }),
  )

  // The local-day minutes: a minute stats row and a matrix row each, the
  // keystrokes telling the minutes apart in the daily sums.
  BOUNDARY_MINUTES.forEach((minuteTs, i) => {
    lines.push(
      stats(own, minuteTs, 100 + i, 10_000 + i, { appName: i % 2 === 0 ? 'Code' : null }),
      matrix(own, minuteTs, [i % 4, i % 3, i % 2], 4 + i, 1 + i, i % 2, 0, { appName: i % 2 === 0 ? 'Code' : null }),
    )
    if (i % 3 === 0) lines.push(stats(remote, minuteTs, 7, 700))
  })
  return lines.join('\n') + '\n'
}

/** A call of a TypeScript DB method: its name and positional arguments. */
export interface MethodCall {
  method: string
  args: unknown[]
}

const ALL_TIME = [0, Number.MAX_SAFE_INTEGER] as const
const WINDOW = [DAY + 10 * HOUR, DAY + 10 * HOUR + 5 * MINUTE] as const

/** Calls whose answer does not depend on the time zone. */
export function independentCalls(): MethodCall[] {
  const c = (method: string, ...args: unknown[]): MethodCall => ({ method, args })
  const ranges = [ALL_TIME, WINDOW, [DAY + 10 * HOUR + 0.5, DAY + 10 * HOUR + 2.5 * MINUTE]] as const
  const calls: MethodCall[] = [
    c('listLocalKeyboardUids', OWN),
    c('listLocalKeyboardUids', REMOTE),
    c('listKeyboardsWithTypingData'),
    c('listRemoteDeviceInfosForUid', UID_A, OWN),
    c('listRemoteDeviceInfosForUid', UID_A, REMOTE),
    c('aggregateMatrixCountsForUid', UID_A, OWN, 0, 0),
    c('aggregateMatrixCountsForUid', UID_A, OWN, 1, DAY + 10 * HOUR + MINUTE),
    c('aggregateMatrixCountsForUid', UID_A, REMOTE, 0.5, 0),
  ]
  for (const [since, until] of ranges) {
    for (const [hashArgs, hash] of [[[], undefined], [[OWN], OWN]] as const) {
      const suffix = hash === undefined ? '' : 'AndHash'
      const pick = (name: string): string => `${name}ForUid${suffix}`
      calls.push(
        c(pick('listLayerUsage'), UID_A, ...hashArgs, since, until),
        c(pick('listMatrixCells'), UID_A, ...hashArgs, since, until),
        c(pick('listMatrixDurationCells'), UID_A, ...hashArgs, since, until),
        c(`listMinuteStatsInRangeForUid${suffix}`, UID_A, ...hashArgs, since, until),
        c(`listSessionsInRangeForUid${suffix}`, UID_A, ...hashArgs, since, until),
        c(`listBksMinuteInRangeForUid${suffix}`, UID_A, ...hashArgs, since, until),
        c(`listNgramMinutesInRangeForUid${suffix}`, 2, UID_A, ...hashArgs, since, until),
        c(`listNgramMinutesInRangeForUid${suffix}`, 3, UID_A, ...hashArgs, since, until),
        c('aggregateMatrixCountsForUidInRange', UID_A, 0, since, until, hash),
        c('aggregateMatrixCountsForUidInRange', UID_A, 1, since, until, hash),
      )
    }
    for (const hash of [null, OWN, REMOTE]) {
      calls.push(
        c('listRolloverMinutesInRange', UID_A, hash, since, until),
        c('listAppsForUidInRange', UID_A, hash, since, until),
        c('listTypingTestsForUidInRange', UID_A, hash, since, until),
        c('getAppUsageForUidInRange', UID_A, hash, since, until),
        c('getWpmByAppForUidInRange', UID_A, hash, since, until),
        c('listTypingTestRunsForUidInRange', UID_A, hash, since, until),
      )
    }
  }
  // The filters, on the statements that take them.
  const filters: Array<[string[], string[], string[]]> = [
    [['Code'], [], []],
    [['Code', 'Slack'], [], []],
    [[], ['words (english)'], []],
    [[], [], ['run-2', '']],
    [['Code'], ['words (english)'], ['run-1']],
  ]
  for (const f of filters) {
    calls.push(
      c('listLayerUsageForUid', UID_A, ...ALL_TIME, ...f),
      c('listMatrixCellsForUidAndHash', UID_A, OWN, ...ALL_TIME, ...f),
      c('listMatrixDurationCellsForUid', UID_A, ...ALL_TIME, ...f),
      c('listMinuteStatsInRangeForUid', UID_A, ...ALL_TIME, ...f),
      c('listBksMinuteInRangeForUidAndHash', UID_A, OWN, ...ALL_TIME, ...f),
      c('listNgramMinutesInRangeForUid', 2, UID_A, ...ALL_TIME, ...f),
      c('listNgramMinutesInRangeForUidAndHash', 3, UID_A, OWN, ...ALL_TIME, ...f),
      c('aggregateMatrixCountsForUidInRange', UID_A, 0, ...ALL_TIME, OWN, ...f),
      c('listRolloverMinutesInRange', UID_A, null, ...ALL_TIME, ...f),
    )
  }
  calls.push(
    c('listTypingTestRunsForUidInRange', UID_A, null, ...ALL_TIME, ['novel.txt']),
    c('listTypingTestRunsForUidInRange', UID_A, OWN, ...ALL_TIME, ['words (english)', 'novel.txt']),
    c('listLayerUsageForUid', UID_B, ...ALL_TIME),
    c('listMinuteStatsInRangeForUid', 'uid-empty', ...ALL_TIME),
  )
  return calls
}

/** Calls that group by SQLite's `localtime`. */
export function localTimeCalls(): MethodCall[] {
  const c = (method: string, ...args: unknown[]): MethodCall => ({ method, args })
  const calls: MethodCall[] = [
    c('listDailySummariesForUid', UID_A),
    c('listDailySummariesForUidAndHash', UID_A, OWN),
    c('listDailySummariesForUidAndHash', UID_A, REMOTE),
    c('listDailySummariesForUid', UID_A, ['Code'], [], []),
    c('listDailySummariesForUidAndHash', UID_A, OWN, [], ['words (english)'], ['run-1']),
    c('listIntervalSummariesForUid', UID_A),
    c('listIntervalSummariesForUidAndHash', UID_A, OWN),
    c('listIntervalSummariesForUidAndHash', UID_A, REMOTE),
  ]
  for (const [since, until] of [ALL_TIME, WINDOW, [Date.UTC(2024, 0, 1), Date.UTC(2027, 0, 1)]] as const) {
    calls.push(
      c('listActivityGridForUid', UID_A, since, until),
      c('listActivityGridForUidAndHash', UID_A, OWN, since, until),
      c('listMatrixCellsByDayForUid', UID_A, since, until),
      c('listMatrixCellsByDayForUidAndHash', UID_A, OWN, since, until),
      c('getPeakRecordsInRangeForUid', UID_A, since, until),
      c('getPeakRecordsInRangeForUidAndHash', UID_A, OWN, since, until),
      c('getPeakRecordsInRangeForUidAndHash', UID_A, REMOTE, since, until),
    )
  }
  calls.push(
    c('listActivityGridForUid', UID_A, ...ALL_TIME, ['Code'], [], []),
    c('listMatrixCellsByDayForUid', UID_A, ...ALL_TIME, [], [], ['run-1']),
    c('getPeakRecordsInRangeForUid', UID_A, ...ALL_TIME, ['Slack'], [], []),
    c('getPeakRecordsInRangeForUid', 'uid-empty', ...ALL_TIME),
  )
  return calls
}

/** The canonical form of a returned value (see the top of this file). */
export function canonical(value: unknown): unknown {
  if (value === null || value === undefined) return null
  if (typeof value === 'number') return `r:${realBits(value)}`
  if (typeof value === 'string') return `s:${value}`
  if (Array.isArray(value)) return value.map(canonical)
  if (value instanceof Map) return [...value.entries()].map(([k, v]) => [canonical(k), canonical(v)])
  if (typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined).map(([k, v]) => [k, canonical(v)]))
  }
  throw new Error(`unexpected value ${String(value)}`)
}

/** Runs `call` on `db` and returns its canonical answer. `truncateCache`
 * is the function of cache-rebuild.ts that empties the data tables. */
export function runCall(db: TypingAnalyticsDB, call: MethodCall): unknown {
  if (call.method === 'truncateCache') return canonical(truncateCache(db))
  const method = (db as unknown as Record<string, (...args: unknown[]) => unknown>)[call.method]
  if (typeof method !== 'function') throw new Error(`no method ${call.method}`)
  return canonical(method.apply(db, call.args))
}
