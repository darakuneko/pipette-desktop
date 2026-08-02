// SPDX-License-Identifier: GPL-2.0-or-later
// SQLite-backed storage for typing analytics. Provides a typed, synchronous
// API on top of better-sqlite3 for the service layer to consume.
//
// This file is the public facade over an abstract-class chain:
// TypingAnalyticsDbBase (connection + migration-aware constructor + the
// prepared-statement bundle) -> TypingAnalyticsDbWrites (ingest / tombstone
// / sync export / merge) -> TypingAnalyticsDbReads (every Analyze-facing
// query). It exists so importers keep the single `TypingAnalyticsDB` name,
// constructor signature, and full method surface they always have — see
// .claude/tasks/done/Task-split-typing-analytics-db.md for why the
// 3,255-line original was split this way. External code must import this
// facade path, never a db/ sibling directly; new DB logic belongs in the
// appropriate sibling (a statement group under sql/, or the base/writes/
// reads class it operates on), not here.

import { app } from 'electron'
import { join } from 'node:path'
import { TypingAnalyticsDbReads } from './typing-analytics-db-reads'

export class TypingAnalyticsDB extends TypingAnalyticsDbReads {}

export type {
  TypingScopeRow,
  CharMinuteRow,
  MatrixMinuteRow,
  MinuteStatsRow,
  SessionRow,
  BigramMinuteEntry,
  BigramMinuteRow,
  TrigramMinuteEntry,
  TrigramMinuteRow,
  NgramMinuteCellRow,
  MatrixDurationCellRow,
  CharMinuteExportRow,
  MatrixMinuteExportRow,
  MinuteStatsExportRow,
  SessionExportRow,
  BigramMinuteExportRow,
  TrigramMinuteExportRow,
} from './typing-analytics-db-types'

export type {
  TypingKeyboardSummary,
  TypingDailySummary,
  TypingIntervalDailySummary,
  TypingActivityCell,
  TypingLayerUsageRow,
  TypingMatrixCellRow,
  TypingMatrixCellDailyRow,
  TypingMinuteStatsRow,
  TypingRolloverMinuteRow,
  TypingSessionRow,
  TypingBksMinuteRow,
  TypingTombstoneResult,
  PeakRecords,
} from '../../../shared/types/typing-analytics'

let instance: TypingAnalyticsDB | null = null

export function defaultDbPath(): string {
  return join(app.getPath('userData'), 'local', 'typing-analytics.db')
}

export function getTypingAnalyticsDB(): TypingAnalyticsDB {
  if (!instance) instance = new TypingAnalyticsDB(defaultDbPath())
  return instance
}

export function resetTypingAnalyticsDBForTests(): void {
  if (instance) {
    instance.close()
    instance = null
  }
}

export function setTypingAnalyticsDBForTests(db: TypingAnalyticsDB): void {
  instance = db
}
