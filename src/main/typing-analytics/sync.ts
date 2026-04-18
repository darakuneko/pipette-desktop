// SPDX-License-Identifier: GPL-2.0-or-later
// Typing analytics sync bundle: serializes / merges row sets against the
// SQLite store. The sync-service drives this by calling
// buildTypingAnalyticsBundle to upload and mergeTypingAnalyticsBundle to
// apply an incoming remote bundle. Row-level LWW keeps cross-device
// replicas consistent without per-machine conflict resolution because
// scope_id embeds machine_hash. See .claude/plans/typing-analytics.md.

import {
  ALLOWED_TYPING_SYNC_SPAN_DAYS,
  DEFAULT_TYPING_SYNC_SPAN_DAYS,
  type TypingSyncSpanDays,
} from '../../shared/types/typing-analytics'
import { isTypingSyncSpanDays } from '../../shared/types/pipette-settings'
import {
  getTypingAnalyticsDB,
  type CharMinuteExportRow,
  type MatrixMinuteExportRow,
  type MinuteStatsExportRow,
  type SessionExportRow,
  type TypingAnalyticsDB,
  type TypingScopeRow,
} from './db/typing-analytics-db'

/** Canonical string identifier for the typing-analytics sync unit. Kept in
 * one place so the sync-service, sync-bundle, and analytics service never
 * drift apart on the path format. */
export function typingAnalyticsSyncUnit(uid: string): `keyboards/${string}/typing-analytics` {
  return `keyboards/${uid}/typing-analytics`
}

/** Returns the uid when `syncUnit` matches `keyboards/{uid}/typing-analytics`,
 * otherwise null. Pair this with `typingAnalyticsSyncUnit(uid)` so call sites
 * never hand-roll the 3-part split check. */
export function parseTypingAnalyticsSyncUnit(syncUnit: string): string | null {
  const parts = syncUnit.split('/')
  if (parts.length !== 3) return null
  if (parts[0] !== 'keyboards' || parts[2] !== 'typing-analytics') return null
  return parts[1]
}

export const TYPING_ANALYTICS_BUNDLE_REV = 1

const DAY_MS = 24 * 60 * 60 * 1_000

/** Tombstones survive in the bundle window long enough that a device that
 * has been offline for the longest supported sync span (plus a 30-day
 * grace) cannot resurrect an already-deleted row. */
export const TYPING_ANALYTICS_TOMBSTONE_RETENTION_DAYS =
  Math.max(...ALLOWED_TYPING_SYNC_SPAN_DAYS) + 30

export interface TypingAnalyticsBundle {
  _rev: typeof TYPING_ANALYTICS_BUNDLE_REV
  exportedAt: number
  uid: string
  spanDays: TypingSyncSpanDays | number
  scopes: TypingScopeRow[]
  charMinutes: CharMinuteExportRow[]
  matrixMinutes: MatrixMinuteExportRow[]
  minuteStats: MinuteStatsExportRow[]
  sessions: SessionExportRow[]
}

export interface BuildBundleOptions {
  /** Wall-clock override for deterministic tests. Defaults to Date.now(). */
  now?: number
  /** Injected DB for tests. Defaults to the singleton. */
  db?: TypingAnalyticsDB
}

function normalizeSpan(spanDays: number): TypingSyncSpanDays {
  return isTypingSyncSpanDays(spanDays) ? spanDays : DEFAULT_TYPING_SYNC_SPAN_DAYS
}

/** Build a bundle containing every live row within `spanDays` and every
 * tombstone within the fixed tombstone retention window. The caller is
 * responsible for serializing/encrypting/uploading the result via the
 * existing sync-service pipeline. */
export function buildTypingAnalyticsBundle(
  uid: string,
  spanDays: number,
  options: BuildBundleOptions = {},
): TypingAnalyticsBundle {
  const db = options.db ?? getTypingAnalyticsDB()
  const now = options.now ?? Date.now()
  const effectiveSpan = normalizeSpan(spanDays)
  const liveSinceMs = now - effectiveSpan * DAY_MS
  const tombstoneSinceMs = now - TYPING_ANALYTICS_TOMBSTONE_RETENTION_DAYS * DAY_MS

  return {
    _rev: TYPING_ANALYTICS_BUNDLE_REV,
    exportedAt: now,
    uid,
    spanDays: effectiveSpan,
    scopes: db.exportScopesForUid(uid, tombstoneSinceMs),
    charMinutes: db.exportCharMinutesForUid(uid, liveSinceMs, tombstoneSinceMs),
    matrixMinutes: db.exportMatrixMinutesForUid(uid, liveSinceMs, tombstoneSinceMs),
    minuteStats: db.exportMinuteStatsForUid(uid, liveSinceMs, tombstoneSinceMs),
    sessions: db.exportSessionsForUid(uid, liveSinceMs, tombstoneSinceMs),
  }
}

export interface MergeBundleOptions {
  db?: TypingAnalyticsDB
}

export interface MergeBundleResult {
  scopes: number
  charMinutes: number
  matrixMinutes: number
  minuteStats: number
  sessions: number
  skippedRev: boolean
  skippedUid?: string
}

function isBundleShape(value: unknown): value is TypingAnalyticsBundle {
  if (typeof value !== 'object' || value === null) return false
  const obj = value as Record<string, unknown>
  return (
    typeof obj._rev === 'number' &&
    typeof obj.uid === 'string' &&
    Array.isArray(obj.scopes) &&
    Array.isArray(obj.charMinutes) &&
    Array.isArray(obj.matrixMinutes) &&
    Array.isArray(obj.minuteStats) &&
    Array.isArray(obj.sessions)
  )
}

/** Merge a remote bundle into the local SQLite store. Each row is applied
 * via the authoritative LWW merge helpers, so remote wins only when its
 * updated_at is strictly newer. Scope rows are applied first so the FKs
 * that later rows rely on are already present on the receiving side. */
export function mergeTypingAnalyticsBundle(
  remote: unknown,
  expectedUid: string,
  options: MergeBundleOptions = {},
): MergeBundleResult {
  const result: MergeBundleResult = {
    scopes: 0,
    charMinutes: 0,
    matrixMinutes: 0,
    minuteStats: 0,
    sessions: 0,
    skippedRev: false,
  }

  if (!isBundleShape(remote)) {
    result.skippedRev = true
    return result
  }

  if (remote._rev !== TYPING_ANALYTICS_BUNDLE_REV) {
    result.skippedRev = true
    return result
  }

  if (remote.uid !== expectedUid) {
    result.skippedUid = remote.uid
    return result
  }

  const db = options.db ?? getTypingAnalyticsDB()
  const connection = db.getConnection()

  connection.transaction(() => {
    for (const scope of remote.scopes) {
      db.mergeScope(scope)
    }
    result.scopes = remote.scopes.length
    for (const row of remote.charMinutes) {
      db.mergeCharMinute(row)
    }
    result.charMinutes = remote.charMinutes.length
    for (const row of remote.matrixMinutes) {
      db.mergeMatrixMinute(row)
    }
    result.matrixMinutes = remote.matrixMinutes.length
    for (const row of remote.minuteStats) {
      db.mergeMinuteStats(row)
    }
    result.minuteStats = remote.minuteStats.length
    for (const row of remote.sessions) {
      db.mergeSession(row)
    }
    result.sessions = remote.sessions.length
  })()

  return result
}
