// SPDX-License-Identifier: GPL-2.0-or-later
//
// Trigger an in-browser download of `payload` as a JSON file. Used by
// renderer-only export paths (the bundled English pack, missing-key
// templates) where going through the main-process file dialog is
// unnecessary because the body is already in memory and the file is
// downloaded into the browser's default folder.

import { safeFilename } from '../../shared/utils/safe-filename'

export interface DownloadJsonOptions {
  /** When set, the stem is sanitised via `safeFilename` and prefixed
   * with `${prefix}-`; otherwise `filename` is used verbatim. */
  prefix?: string
  fallback?: string
}

export function downloadJson(
  filename: string,
  payload: unknown,
  options: DownloadJsonOptions = {},
): void {
  const stem = options.prefix
    ? `${options.prefix}-${safeFilename(filename, options.fallback ?? 'pack')}`
    : filename
  const finalName = stem.endsWith('.json') ? stem : `${stem}.json`
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = finalName
  a.click()
  URL.revokeObjectURL(url)
}
