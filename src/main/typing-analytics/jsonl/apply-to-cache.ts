// SPDX-License-Identifier: GPL-2.0-or-later
// Apply parsed JSONL rows to the local cache SQLite DB. Uses the
// authoritative LWW merge helpers on the DB so re-applying the same row
// is a no-op (same updated_at → WHERE clause blocks) and remote rows
// replace local state only when strictly newer. Scope rows run first
// inside the same transaction so FK targets resolve for the per-minute
// rows that follow.

import type { TypingAnalyticsDB } from '../db/typing-analytics-db'
import type { JsonlRow } from './jsonl-row'

export interface ApplyRowsResult {
  scopes: number
  charMinutes: number
  matrixMinutes: number
  minuteStats: number
  sessions: number
  bigramMinutes: number
}

export function applyRowsToCache(
  db: TypingAnalyticsDB,
  rows: readonly JsonlRow[],
): ApplyRowsResult {
  const result: ApplyRowsResult = {
    scopes: 0,
    charMinutes: 0,
    matrixMinutes: 0,
    minuteStats: 0,
    sessions: 0,
    bigramMinutes: 0,
  }
  if (rows.length === 0) return result

  const connection = db.getConnection()
  connection.transaction(() => {
    for (const row of rows) {
      if (row.kind !== 'scope') continue
      db.mergeScope({
        ...row.payload,
        updatedAt: row.updated_at,
        isDeleted: row.is_deleted ?? false,
      })
      result.scopes += 1
    }

    for (const row of rows) {
      if (row.kind === 'scope') continue
      const common = { updatedAt: row.updated_at, isDeleted: row.is_deleted ?? false }
      switch (row.kind) {
        case 'char-minute':
          db.mergeCharMinute({ ...row.payload, ...common })
          result.charMinutes += 1
          break
        case 'matrix-minute':
          db.mergeMatrixMinute({ ...row.payload, ...common })
          result.matrixMinutes += 1
          break
        case 'minute-stats':
          db.mergeMinuteStats({ ...row.payload, ...common })
          result.minuteStats += 1
          break
        case 'session':
          db.mergeSession({ ...row.payload, ...common })
          result.sessions += 1
          break
        case 'bigram-minute':
          db.mergeBigramMinute({ ...row.payload, ...common })
          result.bigramMinutes += 1
          break
      }
    }
  })()

  return result
}
