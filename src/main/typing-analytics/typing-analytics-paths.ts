// SPDX-License-Identifier: GPL-2.0-or-later
// Filesystem path helpers for the typing analytics subsystem. Mirrors the
// layout documented in .claude/plans/typing-analytics.md:
//
//   userData/sync/keyboards/{uid}/typing-analytics/
//     daily/{YYYY-MM-DD}.json
//     sessions/{YYYY-MM-DD}.jsonl
//   userData/local/keyboards/{uid}/typing-analytics/archive/
//     daily/{YYYY-MM}/{YYYY-MM-DD}.json
//     sessions/{YYYY-MM}/{YYYY-MM-DD}.jsonl

import { app } from 'electron'
import { join } from 'node:path'

function userData(): string {
  return app.getPath('userData')
}

/** Live daily aggregate directory (sync eligible). */
export function dailyDir(uid: string): string {
  return join(userData(), 'sync', 'keyboards', uid, 'typing-analytics', 'daily')
}

/** Live sessions JSONL directory (sync eligible). */
export function sessionsDir(uid: string): string {
  return join(userData(), 'sync', 'keyboards', uid, 'typing-analytics', 'sessions')
}

/** Archive root for expired files (local only, never synced). */
export function archiveRoot(uid: string): string {
  return join(userData(), 'local', 'keyboards', uid, 'typing-analytics', 'archive')
}

export function dailyFilePath(uid: string, date: string): string {
  return join(dailyDir(uid), `${date}.json`)
}

export function sessionsFilePath(uid: string, date: string): string {
  return join(sessionsDir(uid), `${date}.jsonl`)
}

/** Archive destination for a daily aggregate file. */
export function archivedDailyFilePath(uid: string, date: string): string {
  const month = date.slice(0, 7) // YYYY-MM
  return join(archiveRoot(uid), 'daily', month, `${date}.json`)
}

/** Archive destination for a session log file. */
export function archivedSessionsFilePath(uid: string, date: string): string {
  const month = date.slice(0, 7)
  return join(archiveRoot(uid), 'sessions', month, `${date}.jsonl`)
}
