// SPDX-License-Identifier: GPL-2.0-or-later
// Delete part of this device's own typing data (the Data modal's Local tab
// deleting local calendar days). A local day overlaps one or two UTC day
// files, so whole files cannot be removed. Instead the rows inside the
// deleted ranges are appended again to the same file with `is_deleted: true`
// and a newer `updated_at`: the files stay append-only, the LWW merge makes
// the marks win in this cache, in a rebuild, and on every other device that
// replays the uploaded file.

import { app } from 'electron'
import { emptyTombstoneResult, type TypingTombstoneResult } from '../../shared/types/typing-analytics'
import { getTypingAnalyticsDB } from './db/typing-analytics-db'
import { getMachineHash } from './machine-hash'
import type { JsonlBigramMinuteEntry, JsonlRow } from './jsonl/jsonl-row'
import { readRows } from './jsonl/jsonl-reader'
import { deviceDayJsonlPath } from './jsonl/paths'
import { utcDayBoundaryMs, utcDayFromMs, type UtcDay } from './jsonl/utc-day'
import {
  claimOwnRowUpdatedAt,
  closeSessionsForUid,
  deletedByCutoff,
  dropBufferedTyping,
  notifyOwnDaysChanged,
  persistOwnJsonlDay,
  runOnFlushChain,
} from './typing-analytics-pipeline'

/** Every row kind but scope rows, which have no time. */
type TimedRow = Exclude<JsonlRow, { kind: 'scope' }>

export interface TimeRange {
  startMs: number
  endMs: number
}

/** The time a row belongs to, the same one `groupRowsByUidDay`
 * (typing-analytics-rows.ts) uses to pick its day file: the minute start
 * for per-minute rows, the start for sessions. */
function rowTimeMs(row: TimedRow): number {
  return row.kind === 'session' ? row.payload.startMs : row.payload.minuteTs
}

/** Every UTC day from the one holding `startMs` to the one holding
 * `endMs - 1`, i.e. every day file a row of `[startMs, endMs)` can be in. */
export function utcDaysOverlapping(ranges: readonly TimeRange[]): UtcDay[] {
  const days = new Set<UtcDay>()
  for (const range of ranges) {
    const last = utcDayFromMs(range.endMs - 1)
    let dayStart = utcDayBoundaryMs(utcDayFromMs(range.startMs)).startMs
    for (;;) {
      const day = utcDayFromMs(dayStart)
      days.add(day)
      if (day >= last) break
      dayStart = utcDayBoundaryMs(day).endMs
    }
  }
  return [...days].sort()
}

/** The cache row a JSONL row lands on, from its payload: the cache's
 * primary key (scope, minute, run and the cell, char or session id; an
 * n-gram minute is one key, its pairs are its rows). The row id is not
 * enough: rows written before run tagging share one id across the runs
 * of a minute. */
function cacheIdentity(row: TimedRow): string {
  if (row.kind === 'session') return JSON.stringify([row.kind, row.payload.id])
  const { scopeId, minuteTs, runId } = row.payload
  const minute = [row.kind, scopeId, minuteTs, runId ?? '']
  switch (row.kind) {
    case 'char-minute':
      return JSON.stringify([...minute, row.payload.char])
    case 'matrix-minute':
      return JSON.stringify([...minute, row.payload.row, row.payload.col, row.payload.layer])
    default:
      return JSON.stringify(minute)
  }
}

/** The copy of one n-gram (a pair or triple of one minute) that the LWW
 * replay keeps. */
interface NgramWinner {
  updatedAt: number
  isDeleted: boolean
  entry: JsonlBigramMinuteEntry
}

type NgramRow = Extract<JsonlRow, { kind: 'bigram-minute' | 'trigram-minute' }>

function ngramEntries(row: NgramRow): Record<string, JsonlBigramMinuteEntry> {
  return row.kind === 'bigram-minute' ? row.payload.bigrams : row.payload.trigrams
}

/** The rows of one day file that a delete must mark, one per cache row
 * (see cacheIdentity). For most kinds that is the copy the LWW replay
 * keeps (the highest `updated_at`, the first one on a tie, as the strict
 * `>` merge does), skipped when that copy is already deleted. The cache
 * keeps an n-gram minute as one row per pair (or triple), each with its
 * own LWW, so for those the same rule runs per pair over the copies that
 * hold it, and the minute's mark carries exactly the pairs whose kept
 * copy is live. `newestUpdatedAt` is the highest `updated_at` among the
 * matched rows. */
export function collectRowsToMark(
  rows: readonly JsonlRow[],
  marks: (ms: number) => boolean,
): { rows: JsonlRow[]; newestUpdatedAt: number } {
  const winners = new Map<string, JsonlRow>()
  const ngrams = new Map<string, Map<string, NgramWinner>>()
  let newestUpdatedAt = 0
  for (const row of rows) {
    if (row.kind === 'scope') continue
    if (!marks(rowTimeMs(row))) continue
    newestUpdatedAt = Math.max(newestUpdatedAt, row.updated_at)
    const key = cacheIdentity(row)
    const current = winners.get(key)
    if (!current || row.updated_at > current.updated_at) winners.set(key, row)
    if (row.kind !== 'bigram-minute' && row.kind !== 'trigram-minute') continue
    const byPair = ngrams.get(key) ?? new Map<string, NgramWinner>()
    ngrams.set(key, byPair)
    for (const [pair, entry] of Object.entries(ngramEntries(row))) {
      const kept = byPair.get(pair)
      if (!kept || row.updated_at > kept.updatedAt) {
        byPair.set(pair, { updatedAt: row.updated_at, isDeleted: row.is_deleted === true, entry })
      }
    }
  }
  const result: JsonlRow[] = []
  for (const [key, row] of winners) {
    if (row.kind !== 'bigram-minute' && row.kind !== 'trigram-minute') {
      if (row.is_deleted !== true) result.push(row)
      continue
    }
    const live: Record<string, JsonlBigramMinuteEntry> = {}
    for (const [pair, kept] of ngrams.get(key) ?? []) {
      if (!kept.isDeleted) live[pair] = kept.entry
    }
    if (Object.keys(live).length === 0) continue
    // The newest copy carries the minute's tags; the caller sets the
    // delete flag and the new updated_at.
    const base = { id: row.id, updated_at: row.updated_at }
    result.push(row.kind === 'bigram-minute'
      ? { ...base, kind: row.kind, payload: { ...row.payload, bigrams: live } }
      : { ...base, kind: row.kind, payload: { ...row.payload, trigrams: live } })
  }
  return { rows: result, newestUpdatedAt }
}

function countMarks(result: TypingTombstoneResult, rows: readonly JsonlRow[]): void {
  for (const row of rows) {
    switch (row.kind) {
      case 'char-minute': result.charMinutes += 1; break
      case 'matrix-minute': result.matrixMinutes += 1; break
      case 'minute-stats': result.minuteStats += 1; break
      case 'bigram-minute': result.bigramMinutes += 1; break
      case 'trigram-minute': result.trigramMinutes += 1; break
      case 'session': result.sessions += 1; break
    }
  }
}

/** Delete `uid`'s own typing in `ranges` (`[startMs, endMs)`), limited to
 * times at or before `cutoffMs` (the moment the user asked for the delete;
 * see discardBufferedTyping, typing-analytics-pipeline.ts). One task on the
 * flush chain, so no flush writes in between: it closes the active
 * sessions that started in the ranges, drops the buffered data of the
 * ranges, then appends the delete marks to each overlapping day file and
 * applies them to the cache. Each day that got marks is announced to sync
 * so the file is uploaded again. Returns the number of marked rows. */
export async function deleteOwnTypingInRanges(
  uid: string,
  ranges: readonly TimeRange[],
  cutoffMs: number,
): Promise<TypingTombstoneResult> {
  const marks = deletedByCutoff(cutoffMs, ranges)
  const days = utcDaysOverlapping(ranges)
  const result = emptyTombstoneResult()
  await runOnFlushChain(async () => {
    closeSessionsForUid(uid, marks)
    dropBufferedTyping(uid, marks)
    // Fail before anything is written when the cache cannot be opened.
    getTypingAnalyticsDB()
    const machineHash = await getMachineHash()
    const userDataDir = app.getPath('userData')
    const byDay: Array<{ day: UtcDay; rows: JsonlRow[] }> = []
    let newestUpdatedAt = 0
    for (const day of days) {
      const { rows } = await readRows(deviceDayJsonlPath(userDataDir, uid, machineHash, day))
      const found = collectRowsToMark(rows, marks)
      if (found.rows.length === 0) continue
      byDay.push({ day, rows: found.rows })
      newestUpdatedAt = Math.max(newestUpdatedAt, found.newestUpdatedAt)
    }
    if (byDay.length === 0) return
    const updatedAt = claimOwnRowUpdatedAt(newestUpdatedAt)
    for (const { day, rows } of byDay) {
      const marked = rows.map((row) => ({ ...row, is_deleted: true, updated_at: updatedAt }))
      await persistOwnJsonlDay(uid, day, marked, machineHash, userDataDir)
      countMarks(result, marked)
      notifyOwnDaysChanged(uid, machineHash, [day])
    }
  })
  return result
}
