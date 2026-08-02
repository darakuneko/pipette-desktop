// SPDX-License-Identifier: GPL-2.0-or-later
// Write-path methods for TypingAnalyticsDB: additive ingest (writeMinute /
// upsertScope / insertSession / retainOwnData), tombstone writes, sync
// export selects, and authoritative LWW sync-merge writes. Extends
// TypingAnalyticsDbBase so it can reach `this.db` (for db.transaction)
// and `this.stmts` (every prepared statement group). Split out of what
// used to be one 3,255-line file/class — see
// .claude/tasks/done/Task-split-typing-analytics-db.md.

import { emptyTombstoneResult } from '../../../shared/types/typing-analytics'
import type { TypingTombstoneResult } from '../../../shared/types/typing-analytics'
import { decodeHistBuffer, encodeHistBuffer } from './typing-analytics-row-codec'
import type {
  TypingScopeRow,
  CharMinuteRow,
  MatrixMinuteRow,
  MinuteStatsRow,
  SessionRow,
  CharMinuteExportRow,
  MatrixMinuteExportRow,
  MinuteStatsExportRow,
  SessionExportRow,
  BigramMinuteExportRow,
  TrigramMinuteExportRow,
  WithDeletedFlag,
} from './typing-analytics-db-types'
import { TypingAnalyticsDbBase } from './typing-analytics-db-base'

export abstract class TypingAnalyticsDbWrites extends TypingAnalyticsDbBase {
  upsertScope(row: TypingScopeRow): void {
    this.stmts.ingest.upsertScopeStmt.run({
      id: row.id,
      machineHash: row.machineHash,
      osPlatform: row.osPlatform,
      osRelease: row.osRelease,
      osArch: row.osArch,
      keyboardUid: row.keyboardUid,
      keyboardVendorId: row.keyboardVendorId,
      keyboardProductId: row.keyboardProductId,
      keyboardProductName: row.keyboardProductName,
      updatedAt: row.updatedAt,
    })
  }

  writeMinute(
    stats: MinuteStatsRow,
    charCounts: CharMinuteRow[],
    matrixCounts: MatrixMinuteRow[],
    updatedAt: number,
  ): void {
    // app_name flows uniformly across stats / char / matrix per minute:
    // a flush either contributed under one specific app or it didn't.
    // Per-row override is also accepted (`row.appName`) so test
    // fixtures that hand-build mixed rows still work; live ingestion
    // sets stats.appName once and lets the rows inherit.
    const minuteAppName = stats.appName ?? null
    // typing_test flows the same way as app_name (uniform per minute, with
    // a per-row override accepted for hand-built fixtures).
    const minuteTypingTest = stats.typingTest ?? null
    // run_id is part of the bucket key, so the whole minute shares one run
    // ('' for non-test input). Per-row override accepted for fixtures.
    const minuteRunId = stats.runId ?? ''
    const upsertTx = this.db.transaction(() => {
      this.stmts.ingest.upsertMinuteStatsStmt.run({
        scopeId: stats.scopeId,
        minuteTs: stats.minuteTs,
        keystrokes: stats.keystrokes,
        activeMs: stats.activeMs,
        intervalAvgMs: stats.intervalAvgMs,
        intervalMinMs: stats.intervalMinMs,
        intervalP25Ms: stats.intervalP25Ms,
        intervalP50Ms: stats.intervalP50Ms,
        intervalP75Ms: stats.intervalP75Ms,
        intervalMaxMs: stats.intervalMaxMs,
        appName: minuteAppName,
        typingTest: minuteTypingTest,
        runId: minuteRunId,
        updatedAt,
      })
      for (const c of charCounts) {
        this.stmts.ingest.upsertCharMinuteStmt.run({
          scopeId: c.scopeId,
          minuteTs: c.minuteTs,
          char: c.char,
          count: c.count,
          appName: c.appName ?? minuteAppName,
          typingTest: c.typingTest ?? minuteTypingTest,
          runId: c.runId ?? minuteRunId,
          updatedAt,
        })
      }
      for (const m of matrixCounts) {
        this.stmts.ingest.upsertMatrixMinuteStmt.run({
          scopeId: m.scopeId,
          minuteTs: m.minuteTs,
          row: m.row,
          col: m.col,
          layer: m.layer,
          keycode: m.keycode,
          count: m.count,
          tapCount: m.tapCount ?? 0,
          holdCount: m.holdCount ?? 0,
          appName: m.appName ?? minuteAppName,
          typingTest: m.typingTest ?? minuteTypingTest,
          runId: m.runId ?? minuteRunId,
          updatedAt,
        })
      }
    })
    upsertTx()
  }

  insertSession(row: SessionRow, updatedAt: number): void {
    this.stmts.ingest.insertSessionStmt.run({
      id: row.id,
      scopeId: row.scopeId,
      startMs: row.startMs,
      endMs: row.endMs,
      updatedAt,
    })
  }

  /** Remove data for the local machine older than the cutoff timestamp. */
  retainOwnData(machineHash: string, cutoffMs: number): void {
    const tx = this.db.transaction(() => {
      this.stmts.ingest.deleteCharMinuteBeforeStmt.run({ machineHash, cutoffMs })
      this.stmts.ingest.deleteMatrixMinuteBeforeStmt.run({ machineHash, cutoffMs })
      this.stmts.ingest.deleteMinuteStatsBeforeStmt.run({ machineHash, cutoffMs })
      this.stmts.ngram[2].deleteBefore.run({ machineHash, cutoffMs })
      this.stmts.ngram[3].deleteBefore.run({ machineHash, cutoffMs })
      this.stmts.ingest.deleteSessionsBeforeStmt.run({ machineHash, cutoffMs })
    })
    tx()
  }

  /** Tombstone every live row for a uid whose timestamp falls inside
   * [startMs, endMs). Bumps updated_at on the touched rows so LWW
   * merge on other devices picks up the deletion. Returns per-table
   * change counts for UX / logging. */
  /** Same as {@link tombstoneRowsForUidInRange} but restricted to a
   * single machine_hash. Used by the Sync-delete UX to retract a
   * specific remote device's contribution without touching rows
   * another device recorded on the same date. */
  tombstoneRowsForUidHashInRange(
    uid: string,
    machineHash: string,
    startMs: number,
    endMs: number,
    updatedAt: number,
  ): TypingTombstoneResult {
    const result = emptyTombstoneResult()
    const tx = this.db.transaction(() => {
      result.charMinutes = this.stmts.sync.tombstoneCharMinutesForHashInRangeStmt.run({ uid, machineHash, startMs, endMs, updatedAt }).changes
      result.matrixMinutes = this.stmts.sync.tombstoneMatrixMinutesForHashInRangeStmt.run({ uid, machineHash, startMs, endMs, updatedAt }).changes
      result.minuteStats = this.stmts.sync.tombstoneMinuteStatsForHashInRangeStmt.run({ uid, machineHash, startMs, endMs, updatedAt }).changes
      result.bigramMinutes = this.stmts.ngram[2].tombstoneForHashInRange.run({ uid, machineHash, startMs, endMs, updatedAt }).changes
      result.trigramMinutes = this.stmts.ngram[3].tombstoneForHashInRange.run({ uid, machineHash, startMs, endMs, updatedAt }).changes
      result.sessions = this.stmts.sync.tombstoneSessionsForHashInRangeStmt.run({ uid, machineHash, startMs, endMs, updatedAt }).changes
    })
    tx()
    return result
  }

  tombstoneRowsForUidInRange(
    uid: string,
    startMs: number,
    endMs: number,
    updatedAt: number,
  ): TypingTombstoneResult {
    const result = emptyTombstoneResult()
    const tx = this.db.transaction(() => {
      result.charMinutes = this.stmts.sync.tombstoneCharMinutesInRangeStmt.run({ uid, startMs, endMs, updatedAt }).changes
      result.matrixMinutes = this.stmts.sync.tombstoneMatrixMinutesInRangeStmt.run({ uid, startMs, endMs, updatedAt }).changes
      result.minuteStats = this.stmts.sync.tombstoneMinuteStatsInRangeStmt.run({ uid, startMs, endMs, updatedAt }).changes
      result.bigramMinutes = this.stmts.ngram[2].tombstoneInRange.run({ uid, startMs, endMs, updatedAt }).changes
      result.trigramMinutes = this.stmts.ngram[3].tombstoneInRange.run({ uid, startMs, endMs, updatedAt }).changes
      result.sessions = this.stmts.sync.tombstoneSessionsInRangeStmt.run({ uid, startMs, endMs, updatedAt }).changes
    })
    tx()
    return result
  }

  /** Tombstone every live row for a uid across all time. Scope rows
   * themselves are left intact so the next recording session reuses
   * them without a fresh fingerprint build. */
  tombstoneAllRowsForUid(uid: string, updatedAt: number): TypingTombstoneResult {
    const result = emptyTombstoneResult()
    const tx = this.db.transaction(() => {
      result.charMinutes = this.stmts.sync.tombstoneAllCharMinutesStmt.run({ uid, updatedAt }).changes
      result.matrixMinutes = this.stmts.sync.tombstoneAllMatrixMinutesStmt.run({ uid, updatedAt }).changes
      result.minuteStats = this.stmts.sync.tombstoneAllMinuteStatsStmt.run({ uid, updatedAt }).changes
      result.bigramMinutes = this.stmts.ngram[2].tombstoneAll.run({ uid, updatedAt }).changes
      result.trigramMinutes = this.stmts.ngram[3].tombstoneAll.run({ uid, updatedAt }).changes
      result.sessions = this.stmts.sync.tombstoneAllSessionsStmt.run({ uid, updatedAt }).changes
    })
    tx()
    return result
  }

  // --- Sync export ----------------------------------------------------

  exportScopesForUid(uid: string, tombstoneSinceMs: number): TypingScopeRow[] {
    const rows = this.stmts.sync.selectScopesForUidStmt.all({ uid, tombstoneSinceMs }) as Array<
      WithDeletedFlag<TypingScopeRow>
    >
    return rows.map((r) => ({ ...r, isDeleted: r.isDeleted === 1 }))
  }

  exportCharMinutesForUid(
    uid: string,
    liveSinceMinuteMs: number,
    tombstoneSinceMs: number,
  ): CharMinuteExportRow[] {
    const rows = this.stmts.sync.selectCharMinutesForUidStmt.all({ uid, liveSinceMinuteMs, tombstoneSinceMs }) as Array<
      WithDeletedFlag<CharMinuteExportRow>
    >
    return rows.map((r) => ({ ...r, isDeleted: r.isDeleted === 1 }))
  }

  exportMatrixMinutesForUid(
    uid: string,
    liveSinceMinuteMs: number,
    tombstoneSinceMs: number,
  ): MatrixMinuteExportRow[] {
    const rows = this.stmts.sync.selectMatrixMinutesForUidStmt.all({ uid, liveSinceMinuteMs, tombstoneSinceMs }) as Array<
      WithDeletedFlag<Omit<MatrixMinuteExportRow, 'dh'>> & { dh: Uint8Array | null }
    >
    // dh comes back as a raw BLOB (or null) like every other hist column
    // in this file — decode it the same way toMatrixDurationCellRows does.
    return rows.map((r) => ({ ...r, isDeleted: r.isDeleted === 1, dh: r.dh ? decodeHistBuffer(r.dh) : null }))
  }

  exportMinuteStatsForUid(
    uid: string,
    liveSinceMinuteMs: number,
    tombstoneSinceMs: number,
  ): MinuteStatsExportRow[] {
    const rows = this.stmts.sync.selectMinuteStatsForUidStmt.all({ uid, liveSinceMinuteMs, tombstoneSinceMs }) as Array<
      WithDeletedFlag<MinuteStatsExportRow>
    >
    return rows.map((r) => ({ ...r, isDeleted: r.isDeleted === 1 }))
  }

  exportSessionsForUid(
    uid: string,
    liveSinceStartMs: number,
    tombstoneSinceMs: number,
  ): SessionExportRow[] {
    const rows = this.stmts.sync.selectSessionsForUidStmt.all({ uid, liveSinceStartMs, tombstoneSinceMs }) as Array<
      WithDeletedFlag<SessionExportRow>
    >
    return rows.map((r) => ({ ...r, isDeleted: r.isDeleted === 1 }))
  }

  // --- Sync merge (authoritative LWW) ---------------------------------

  mergeScope(row: TypingScopeRow): void {
    this.stmts.merge.mergeScopeStmt.run({
      id: row.id,
      machineHash: row.machineHash,
      osPlatform: row.osPlatform,
      osRelease: row.osRelease,
      osArch: row.osArch,
      keyboardUid: row.keyboardUid,
      keyboardVendorId: row.keyboardVendorId,
      keyboardProductId: row.keyboardProductId,
      keyboardProductName: row.keyboardProductName,
      updatedAt: row.updatedAt,
      isDeleted: row.isDeleted ? 1 : 0,
    })
  }

  mergeCharMinute(row: CharMinuteExportRow): void {
    this.stmts.merge.mergeCharMinuteStmt.run({
      scopeId: row.scopeId,
      minuteTs: row.minuteTs,
      char: row.char,
      count: row.count,
      appName: row.appName ?? null,
      typingTest: row.typingTest ?? null,
      runId: row.runId ?? '',
      updatedAt: row.updatedAt,
      isDeleted: row.isDeleted ? 1 : 0,
    })
  }

  mergeMatrixMinute(row: MatrixMinuteExportRow): void {
    this.stmts.merge.mergeMatrixMinuteStmt.run({
      scopeId: row.scopeId,
      minuteTs: row.minuteTs,
      row: row.row,
      col: row.col,
      layer: row.layer,
      keycode: row.keycode,
      count: row.count,
      tapCount: row.tapCount ?? 0,
      holdCount: row.holdCount ?? 0,
      durHist: row.dh ? encodeHistBuffer(row.dh) : null,
      durSum: row.ds ?? null,
      durSumSq: row.dq ?? null,
      appName: row.appName ?? null,
      typingTest: row.typingTest ?? null,
      runId: row.runId ?? '',
      updatedAt: row.updatedAt,
      isDeleted: row.isDeleted ? 1 : 0,
    })
  }

  mergeMinuteStats(row: MinuteStatsExportRow): void {
    this.stmts.merge.mergeMinuteStatsStmt.run({
      scopeId: row.scopeId,
      minuteTs: row.minuteTs,
      keystrokes: row.keystrokes,
      activeMs: row.activeMs,
      intervalAvgMs: row.intervalAvgMs,
      intervalMinMs: row.intervalMinMs,
      intervalP25Ms: row.intervalP25Ms,
      intervalP50Ms: row.intervalP50Ms,
      intervalP75Ms: row.intervalP75Ms,
      intervalMaxMs: row.intervalMaxMs,
      pollP50Ms: row.pollP50Ms ?? null,
      pollP95Ms: row.pollP95Ms ?? null,
      appName: row.appName ?? null,
      typingTest: row.typingTest ?? null,
      runId: row.runId ?? '',
      updatedAt: row.updatedAt,
      isDeleted: row.isDeleted ? 1 : 0,
    })
  }

  mergeSession(row: SessionExportRow): void {
    this.stmts.merge.mergeSessionStmt.run({
      id: row.id,
      scopeId: row.scopeId,
      startMs: row.startMs,
      endMs: row.endMs,
      updatedAt: row.updatedAt,
      isDeleted: row.isDeleted ? 1 : 0,
    })
  }

  /** Apply a single JSONL bigram-minute row by expanding each pair into
   * its own SQLite upsert. The caller is expected to wrap the batch in
   * a transaction (see {@link applyRowsToCache}). LWW-replace, same as
   * every other merge* method — the incoming row already holds the full
   * per-minute total for its pair, not a delta to accumulate. `s`/`sq`
   * fall back to null when the source row predates the sum columns. */
  mergeBigramMinute(row: BigramMinuteExportRow): void {
    const isDeleted = row.isDeleted ? 1 : 0
    const appName = row.appName ?? null
    const typingTest = row.typingTest ?? null
    const runId = row.runId ?? ''
    for (const bigramId of Object.keys(row.bigrams)) {
      const entry = row.bigrams[bigramId]
      this.stmts.ngram[2].merge.run({
        scopeId: row.scopeId,
        minuteTs: row.minuteTs,
        ngramId: bigramId,
        count: entry.c,
        hist: encodeHistBuffer(entry.h),
        sumIki: entry.s ?? null,
        sumSqIki: entry.sq ?? null,
        overlapCount: entry.oc ?? null,
        overlapN: entry.on ?? null,
        appName,
        typingTest,
        runId,
        updatedAt: row.updatedAt,
        isDeleted,
      })
    }
  }

  /** Same as {@link mergeBigramMinute} for trigram-minute rows. */
  mergeTrigramMinute(row: TrigramMinuteExportRow): void {
    const isDeleted = row.isDeleted ? 1 : 0
    const appName = row.appName ?? null
    const typingTest = row.typingTest ?? null
    const runId = row.runId ?? ''
    for (const trigramId of Object.keys(row.trigrams)) {
      const entry = row.trigrams[trigramId]
      this.stmts.ngram[3].merge.run({
        scopeId: row.scopeId,
        minuteTs: row.minuteTs,
        ngramId: trigramId,
        count: entry.c,
        hist: encodeHistBuffer(entry.h),
        sumIki: entry.s ?? null,
        sumSqIki: entry.sq ?? null,
        appName,
        typingTest,
        runId,
        updatedAt: row.updatedAt,
        isDeleted,
      })
    }
  }
}
