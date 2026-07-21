// SPDX-License-Identifier: GPL-2.0-or-later
//
// Shared multi-line failure summary for the three pack-management
// modals' (Language Packs, Theme Packs, Key Labels) multi-file import
// batches. Mirrors the typing-analytics import precedent
// (`src/main/typing-analytics/import-export.ts`'s `ImportRejection[]`)
// but surfaces through the modals' existing single-string `actionError`
// banner instead of a dedicated list component — `PackManagerModal`'s
// error banner renders `white-space: pre-wrap` so the newline-joined
// lines below actually break visually.

import type { TFunction } from 'i18next'

export interface ImportBatchFailure {
  fileName: string
  reason: string
}

/** Strips a filesystem path down to its final segment for display in the
 *  failure summary — the full absolute path is noise to the user. */
export function basenameOf(path: string): string {
  const segments = path.split(/[\\/]/)
  return segments[segments.length - 1] || path
}

/** Dedupes a batch's per-file results by id, keeping the last file's
 *  outcome when two files resolve to the same id (e.g. two files with
 *  the same name, so the store's auto-overwrite reuses the same id) —
 *  that's what actually ended up on disk. `Map.delete` before `set`
 *  moves a repeated id to the end, matching the last file's processing
 *  order rather than the first's. */
export function dedupeByIdKeepLast<T>(items: T[], getId: (item: T) => string): T[] {
  const byId = new Map<string, T>()
  for (const item of items) {
    const id = getId(item)
    byId.delete(id)
    byId.set(id, item)
  }
  return [...byId.values()]
}

/**
 * Builds the "{{count}} file(s) could not be imported:" header plus one
 * `fileName: reason` line per failure. Returns null when there are no
 * failures so callers can leave `actionError` untouched in that case.
 */
export function buildImportBatchFailureSummary(
  t: TFunction,
  failures: ImportBatchFailure[],
): string | null {
  if (failures.length === 0) return null
  const header = t('common.importBatchFailed', { count: failures.length })
  const lines = failures.map((f) => `${f.fileName}: ${f.reason}`)
  return [header, ...lines].join('\n')
}

/**
 * Builds the toolbar "Imported N file(s) (success N, failure N)"
 * headline shown for a multi-file import batch, or `null` below the
 * 2-file threshold — mirroring its sibling `buildImportBatchFailureSummary`'s
 * self-gating null return, so call sites no longer need their own
 * `totalCount >= 2` check.
 *
 * `successCount` MUST be the original, pre-dedupe count of files that
 * actually saved — never the post-dedupe count. Two files that both
 * overwrote the same existing pack are still 2 successes here even
 * though they collapse to a single placed entry (see the P1
 * "count/scroll uses deduped set" fix note in useImportBatch.ts, the
 * one caller of this function). `notSavedFailures` is the files that
 * never got saved (parse/validate/store failures) — a saved file whose
 * Hub auto-sync later failed still counts toward `successCount` (its
 * failure is a separate concern surfaced by
 * `buildImportBatchFailureSummary`'s banner, not this headline).
 */
export function buildImportSummary(
  t: TFunction,
  successCount: number,
  notSavedFailures: ImportBatchFailure[],
): string | null {
  const failure = notSavedFailures.length
  const total = successCount + failure
  if (total < 2) return null
  return t('common.importSummary', { count: total, success: successCount, failure })
}
