// SPDX-License-Identifier: GPL-2.0-or-later
// Move typing-analytics files that are older than the configured sync span
// from the live sync/ directory to the local-only archive/ directory so they
// stop being uploaded without being lost.

import { mkdir, readdir, rename, stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import {
  archivedDailyFilePath,
  archivedSessionsFilePath,
  dailyDir,
  sessionsDir,
} from './typing-analytics-paths'

const DAILY_PATTERN = /^(\d{4}-\d{2}-\d{2})\.json$/
const SESSIONS_PATTERN = /^(\d{4}-\d{2}-\d{2})\.jsonl$/

export interface ArchiveCleanupResult {
  movedDaily: number
  movedSessions: number
}

export interface CleanupOptions {
  /** ISO date (YYYY-MM-DD) considered the reference for "today". */
  today: string
  /** Number of days of history kept in sync/ (older moves to archive). */
  syncSpanDays: number
}

/**
 * Move expired daily and sessions files for a single keyboard from sync/ to
 * the local archive. Missing directories and individual move failures are
 * tolerated so a partial run still cleans up what it can.
 */
export async function cleanupArchiveForKeyboard(
  uid: string,
  options: CleanupOptions,
): Promise<ArchiveCleanupResult> {
  const cutoff = computeCutoff(options.today, options.syncSpanDays)

  const [movedDaily, movedSessions] = await Promise.all([
    moveExpired(dailyDir(uid), DAILY_PATTERN, cutoff, (date) => archivedDailyFilePath(uid, date)),
    moveExpired(sessionsDir(uid), SESSIONS_PATTERN, cutoff, (date) => archivedSessionsFilePath(uid, date)),
  ])
  return { movedDaily, movedSessions }
}

function computeCutoff(today: string, syncSpanDays: number): string {
  // Files with a date strictly older than this cutoff are moved.
  const base = new Date(`${today}T00:00:00Z`)
  base.setUTCDate(base.getUTCDate() - Math.max(0, syncSpanDays) + 1)
  return base.toISOString().slice(0, 10)
}

async function moveExpired(
  sourceDir: string,
  pattern: RegExp,
  cutoff: string,
  resolveDest: (date: string) => string,
): Promise<number> {
  let entries: string[]
  try {
    entries = await readdir(sourceDir)
  } catch {
    return 0
  }

  let moved = 0
  for (const name of entries) {
    const match = pattern.exec(name)
    if (!match) continue
    const date = match[1]
    if (date >= cutoff) continue

    const src = join(sourceDir, name)
    try {
      const stats = await stat(src)
      if (!stats.isFile()) continue
    } catch {
      continue
    }

    const dest = resolveDest(date)
    try {
      await mkdir(dirname(dest), { recursive: true })
      await rename(src, dest)
      moved++
    } catch {
      // Leave the file in place on failure and continue with the rest.
    }
  }
  return moved
}
