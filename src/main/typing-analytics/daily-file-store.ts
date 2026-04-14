// SPDX-License-Identifier: GPL-2.0-or-later
// Read/write the per-day scope-map aggregate file. On write the incoming
// scope-map is merged additively with the on-disk content so multiple
// flushes within the same day accumulate into a single file.

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import type {
  MatrixKeyStat,
  TypingAnalyticsDailyFile,
  TypingScopeEntry,
} from '../../shared/types/typing-analytics'
import {
  TYPING_ANALYTICS_REV,
  TYPING_ANALYTICS_VERSION,
} from '../../shared/types/typing-analytics'
import { dailyFilePath } from './typing-analytics-paths'

function isDailyFile(value: unknown): value is TypingAnalyticsDailyFile {
  if (typeof value !== 'object' || value === null) return false
  const obj = value as Record<string, unknown>
  return (
    obj._rev === TYPING_ANALYTICS_REV &&
    obj.analyticsVersion === TYPING_ANALYTICS_VERSION &&
    typeof obj.date === 'string' &&
    typeof obj.updatedAt === 'string' &&
    typeof obj.lastFlushedAt === 'string' &&
    typeof obj.scopes === 'object' && obj.scopes !== null && !Array.isArray(obj.scopes)
  )
}

export async function readDailyFile(
  uid: string,
  date: string,
): Promise<TypingAnalyticsDailyFile | null> {
  const path = dailyFilePath(uid, date)
  try {
    const raw = await readFile(path, 'utf-8')
    const parsed: unknown = JSON.parse(raw)
    return isDailyFile(parsed) ? parsed : null
  } catch {
    return null
  }
}

/**
 * Merge two scope maps additively. Both sides contribute to char and matrix
 * counts, and missing scopes from either side are carried over unchanged.
 * The caller's inputs are not mutated.
 */
export function mergeScopeMaps(
  a: Record<string, TypingScopeEntry>,
  b: Record<string, TypingScopeEntry>,
): Record<string, TypingScopeEntry> {
  const merged: Record<string, TypingScopeEntry> = {}
  for (const [key, entry] of Object.entries(a)) {
    merged[key] = cloneScopeEntry(entry)
  }
  for (const [key, entry] of Object.entries(b)) {
    const existing = merged[key]
    if (!existing) {
      merged[key] = cloneScopeEntry(entry)
      continue
    }
    merged[key] = mergeScopeEntry(existing, entry)
  }
  return merged
}

function cloneScopeEntry(entry: TypingScopeEntry): TypingScopeEntry {
  return {
    scope: entry.scope,
    charCounts: { ...entry.charCounts },
    matrixCounts: cloneMatrixCounts(entry.matrixCounts),
  }
}

function cloneMatrixCounts(
  counts: Record<string, MatrixKeyStat>,
): Record<string, MatrixKeyStat> {
  const out: Record<string, MatrixKeyStat> = {}
  for (const [k, v] of Object.entries(counts)) out[k] = { ...v }
  return out
}

function mergeScopeEntry(a: TypingScopeEntry, b: TypingScopeEntry): TypingScopeEntry {
  const charCounts: Record<string, number> = { ...a.charCounts }
  for (const [k, v] of Object.entries(b.charCounts)) {
    charCounts[k] = (charCounts[k] ?? 0) + v
  }
  const matrixCounts: Record<string, MatrixKeyStat> = cloneMatrixCounts(a.matrixCounts)
  for (const [k, v] of Object.entries(b.matrixCounts)) {
    const existing = matrixCounts[k]
    matrixCounts[k] = {
      count: (existing?.count ?? 0) + v.count,
      keycode: v.keycode,
    }
  }
  return { scope: b.scope, charCounts, matrixCounts }
}

/**
 * Merge the incoming scope map into any existing daily file and write it
 * back. The caller should clear its aggregator after this call succeeds.
 */
export async function flushDailyFile(
  uid: string,
  date: string,
  incomingScopes: Record<string, TypingScopeEntry>,
): Promise<void> {
  const existing = await readDailyFile(uid, date)
  const mergedScopes = existing
    ? mergeScopeMaps(existing.scopes, incomingScopes)
    : cloneScopes(incomingScopes)

  const now = new Date().toISOString()
  const next: TypingAnalyticsDailyFile = {
    _rev: TYPING_ANALYTICS_REV,
    analyticsVersion: TYPING_ANALYTICS_VERSION,
    date,
    updatedAt: now,
    lastFlushedAt: now,
    scopes: mergedScopes,
  }

  const path = dailyFilePath(uid, date)
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, JSON.stringify(next), 'utf-8')
}

function cloneScopes(
  scopes: Record<string, TypingScopeEntry>,
): Record<string, TypingScopeEntry> {
  const out: Record<string, TypingScopeEntry> = {}
  for (const [k, v] of Object.entries(scopes)) out[k] = cloneScopeEntry(v)
  return out
}
