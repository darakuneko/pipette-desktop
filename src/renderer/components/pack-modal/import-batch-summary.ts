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
