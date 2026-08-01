// SPDX-License-Identifier: GPL-2.0-or-later
// Pure row-building helpers for the typing-analytics flush pipeline: turn a
// resolved scope, a drained MinuteSnapshot, or a FinalizedSession into the
// JsonlRow shape appended to the per-device master file and applied to the
// SQLite cache. Nothing here is async or reads module state — the flush's
// synchronous drain-then-build window (see typing-analytics-pipeline.ts's
// doFlushPass) depends on that, so no function in this file may become
// async or be dynamically imported.

import type { TypingAnalyticsFingerprint } from '../../shared/types/typing-analytics'
import type { MinuteSnapshot } from './minute-buffer'
import type { FinalizedSession } from './session-detector'
import type { ResolvedScope } from './typing-analytics-state'
import {
  bigramMinuteRowId,
  charMinuteRowId,
  matrixMinuteRowId,
  minuteStatsRowId,
  scopeRowId,
  sessionRowId,
  trigramMinuteRowId,
  type JsonlBigramMinuteEntry,
  type JsonlRow,
} from './jsonl/jsonl-row'
import { bucketizeDurations, bucketizeIki, sumAndSumSquares } from './bigram-bucket'
import { utcDayFromMs, type UtcDay } from './jsonl/utc-day'

function buildScopeRow(
  scopeKey: string,
  fingerprint: TypingAnalyticsFingerprint,
  updatedAt: number,
): JsonlRow {
  return {
    id: scopeRowId(scopeKey),
    kind: 'scope',
    updated_at: updatedAt,
    payload: {
      id: scopeKey,
      machineHash: fingerprint.machineHash,
      osPlatform: fingerprint.os.platform,
      osRelease: fingerprint.os.release,
      osArch: fingerprint.os.arch,
      keyboardUid: fingerprint.keyboard.uid,
      keyboardVendorId: fingerprint.keyboard.vendorId,
      keyboardProductId: fingerprint.keyboard.productId,
      keyboardProductName: fingerprint.keyboard.productName,
    },
  }
}

function buildSnapshotRows(snapshot: MinuteSnapshot, updatedAt: number): JsonlRow[] {
  // appName carries through to every per-minute row so the JSONL master
  // file is the source of truth for app filtering after a cache rebuild.
  // Older master files predate this field; the readers fall back to
  // null on missing.
  const appName = snapshot.appName
  // typing_test carries through identically to appName so the JSONL master
  // stays the source of truth for TypingTest filtering after a rebuild.
  const typingTest = snapshot.typingTest
  // run_id is part of every per-minute row's identity (id + SQLite PK) so
  // two runs in one minute stay distinct. '' for non-test (REC) input.
  const runId = snapshot.runId
  const rows: JsonlRow[] = []
  // A minute whose only contribution is a matrix-release event (a press
  // near :59.9 released at :00.1 of the NEXT minute — see the
  // matrix-release event type's doc comment on release-vs-press minute
  // attribution) has keystrokes === 0 and no charCounts: nothing was
  // actually typed IN this minute, only a duration sample that happens
  // to land here. Shipping a minute-stats row for it would fabricate a
  // phantom day in selectDailySummariesForUid — a day appears in Analyze
  // solely because a key held across midnight happened to release a
  // fraction of a second into the next day. The matrix-minute row for
  // that cell (carrying the duration data) still ships in the loop
  // below regardless; only this per-minute stats rollup is skipped.
  if (snapshot.keystrokes > 0 || snapshot.charCounts.size > 0) {
    rows.push({
      id: minuteStatsRowId(snapshot.scopeId, snapshot.minuteTs, runId),
      kind: 'minute-stats',
      updated_at: updatedAt,
      payload: {
        scopeId: snapshot.scopeId,
        minuteTs: snapshot.minuteTs,
        keystrokes: snapshot.keystrokes,
        activeMs: snapshot.activeMs,
        intervalAvgMs: snapshot.intervalAvgMs,
        intervalMinMs: snapshot.intervalMinMs,
        intervalP25Ms: snapshot.intervalP25Ms,
        intervalP50Ms: snapshot.intervalP50Ms,
        intervalP75Ms: snapshot.intervalP75Ms,
        intervalMaxMs: snapshot.intervalMaxMs,
        // Absent (not null) when the minute recorded no poll-gap samples
        // at all — mirrors the matrix-minute dh/ds/dq convention below:
        // "no data" stays absent on the wire rather than an explicit
        // null pair, keeping pre-v8 rows and "genuinely no samples" rows
        // indistinguishable on disk — readers already treat both
        // identically (see isValidPollStatsPair).
        ...(snapshot.pollP50Ms !== null ? { pollP50Ms: snapshot.pollP50Ms, pollP95Ms: snapshot.pollP95Ms } : {}),
        appName,
        typingTest,
        runId,
      },
    })
  }
  for (const [char, count] of snapshot.charCounts) {
    rows.push({
      id: charMinuteRowId(snapshot.scopeId, snapshot.minuteTs, runId, char),
      kind: 'char-minute',
      updated_at: updatedAt,
      payload: { scopeId: snapshot.scopeId, minuteTs: snapshot.minuteTs, char, count, appName, typingTest, runId },
    })
  }
  for (const cell of snapshot.matrixCounts.values()) {
    // Built once as a complete triple (or left undefined) rather than
    // computed piecemeal — present only when this cell had at least one
    // matrix-release sample this minute; see JsonlMatrixMinutePayload's
    // doc comment for why absent (not a zeroed histogram) is correct.
    let dur: { dh: number[]; ds: number; dq: number } | undefined
    if (cell.durations.length > 0) {
      const { sum, sumSq } = sumAndSumSquares(cell.durations)
      dur = { dh: bucketizeDurations(cell.durations), ds: sum, dq: sumSq }
    }
    rows.push({
      id: matrixMinuteRowId(snapshot.scopeId, snapshot.minuteTs, runId, cell.row, cell.col, cell.layer),
      kind: 'matrix-minute',
      updated_at: updatedAt,
      payload: {
        scopeId: snapshot.scopeId,
        minuteTs: snapshot.minuteTs,
        row: cell.row,
        col: cell.col,
        layer: cell.layer,
        keycode: cell.keycode,
        count: cell.count,
        tapCount: cell.tapCount,
        holdCount: cell.holdCount,
        ...dur,
        appName,
        typingTest,
        runId,
      },
    })
  }
  if (snapshot.bigrams.size > 0) {
    rows.push({
      id: bigramMinuteRowId(snapshot.scopeId, snapshot.minuteTs, runId),
      kind: 'bigram-minute',
      updated_at: updatedAt,
      payload: {
        scopeId: snapshot.scopeId,
        minuteTs: snapshot.minuteTs,
        bigrams: toNgramEntries(snapshot.bigrams, snapshot.overlaps),
        appName,
        typingTest,
        runId,
      },
    })
  }
  if (snapshot.trigrams.size > 0) {
    rows.push({
      id: trigramMinuteRowId(snapshot.scopeId, snapshot.minuteTs, runId),
      kind: 'trigram-minute',
      updated_at: updatedAt,
      payload: {
        scopeId: snapshot.scopeId,
        minuteTs: snapshot.minuteTs,
        // Overlap is a bigram-only concept — see JsonlBigramMinuteEntry's
        // doc comment on why trigram entries never carry oc/on.
        trigrams: toNgramEntries(snapshot.trigrams),
        appName,
        typingTest,
        runId,
      },
    })
  }
  return rows
}

/** Bucketize each pair/triple's raw IKI samples into the JSONL entry
 * shape (`c`/`h`/`s`/`sq`) shared by bigram-minute and trigram-minute
 * rows — see {@link buildSnapshotRows}. `overlaps` is supplied for the
 * bigram call site only; when present, a pair with a recorded overlap
 * accumulator gains `oc`/`on` (absent — not zeroed — for a pair whose
 * every contributing event had an undetermined overlap, since "never
 * observed" must not collapse into "observed as never overlapping"). */
function toNgramEntries(
  ikisByKey: ReadonlyMap<string, number[]>,
  overlaps?: ReadonlyMap<string, { oc: number; on: number }>,
): Record<string, JsonlBigramMinuteEntry> {
  const entries: Record<string, JsonlBigramMinuteEntry> = {}
  for (const [key, ikis] of ikisByKey) {
    const { sum, sumSq } = sumAndSumSquares(ikis)
    const overlap = overlaps?.get(key)
    entries[key] = {
      c: ikis.length,
      h: bucketizeIki(ikis),
      s: sum,
      sq: sumSq,
      ...(overlap ? { oc: overlap.oc, on: overlap.on } : {}),
    }
  }
  return entries
}

function buildSessionRow(
  session: FinalizedSession,
  resolved: ResolvedScope,
  updatedAt: number,
): JsonlRow {
  return {
    id: sessionRowId(session.id),
    kind: 'session',
    updated_at: updatedAt,
    payload: {
      id: session.id,
      scopeId: resolved.scopeKey,
      startMs: session.startMs,
      endMs: session.endMs,
    },
  }
}

/** Partition the flush's rows into per-(uid, UTC-day) buckets.
 *
 * The UTC day is derived from the row's native timestamp:
 *   - snapshot rows (minute-stats / char-minute / matrix-minute) use
 *     `minuteTs` so every row in the same minute bucket lands on the
 *     same day regardless of how long the flush takes to run.
 *   - session rows use `startMs`; a session that spans 00:00 UTC is
 *     kept whole on the start day (no splitting).
 *   - scope rows don't carry a timestamp, so they're replicated into
 *     every day that references the scope in this flush. The LWW merge
 *     makes the duplicates idempotent on the cache side. */
export function groupRowsByUidDay(
  scopesToUpsert: Map<string, TypingAnalyticsFingerprint>,
  snapshots: MinuteSnapshot[],
  sessionsWithScope: Array<{ session: FinalizedSession; resolved: ResolvedScope }>,
  updatedAt: number,
): Map<string, Map<UtcDay, JsonlRow[]>> {
  const rowsByUidDay = new Map<string, Map<UtcDay, JsonlRow[]>>()
  const scopeDays = new Map<string, Set<UtcDay>>()
  const scopeDayKey = (uid: string, scopeId: string): string => `${uid}\0${scopeId}`

  const addRow = (uid: string, day: UtcDay, row: JsonlRow): void => {
    let byDay = rowsByUidDay.get(uid)
    if (!byDay) {
      byDay = new Map<UtcDay, JsonlRow[]>()
      rowsByUidDay.set(uid, byDay)
    }
    const list = byDay.get(day)
    if (list) list.push(row)
    else byDay.set(day, [row])
  }

  const recordScopeDay = (uid: string, scopeId: string, day: UtcDay): void => {
    const key = scopeDayKey(uid, scopeId)
    const set = scopeDays.get(key)
    if (set) set.add(day)
    else scopeDays.set(key, new Set([day]))
  }

  for (const snapshot of snapshots) {
    const uid = snapshot.fingerprint.keyboard.uid
    const day = utcDayFromMs(snapshot.minuteTs)
    recordScopeDay(uid, snapshot.scopeId, day)
    for (const row of buildSnapshotRows(snapshot, updatedAt)) {
      addRow(uid, day, row)
    }
  }
  for (const { session, resolved } of sessionsWithScope) {
    const uid = resolved.fingerprint.keyboard.uid
    const day = utcDayFromMs(session.startMs)
    recordScopeDay(uid, resolved.scopeKey, day)
    addRow(uid, day, buildSessionRow(session, resolved, updatedAt))
  }
  for (const [scopeId, fingerprint] of scopesToUpsert) {
    const uid = fingerprint.keyboard.uid
    const days = scopeDays.get(scopeDayKey(uid, scopeId))
    if (!days) continue
    const scopeRow = buildScopeRow(scopeId, fingerprint, updatedAt)
    for (const day of days) addRow(uid, day, scopeRow)
  }
  return rowsByUidDay
}
