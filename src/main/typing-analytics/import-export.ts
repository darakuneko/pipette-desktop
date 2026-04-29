// SPDX-License-Identifier: GPL-2.0-or-later
// Plain-text export / import for typing-analytics per-day JSONL files.
//
// The export side serialises every day this device owns for a given
// keyboard into individual files named after the cloud sync unit
// (`keyboards_{uid}_devices_{hash}_days_{YYYY-MM-DD}.jsonl`). The user
// can edit those files in any text editor and drop them back in via
// the import path.
//
// The import side is intentionally restrictive — typing data is
// recorded, never invented. A file is accepted only when:
//   1. its name matches the export pattern,
//   2. the day it claims is not "today (UTC)" — the recorder owns the
//      live day file and a concurrent overwrite would race append,
//   3. no earlier file in the same batch already targeted that day —
//      otherwise the outcome would depend on file-list order,
//   4. a file by the same name already exists locally OR was last seen
//      in the cloud listing,
//   5. its body parses cleanly as JSONL (no empty file, no broken
//      lines, at least one timestamped content row),
//   6. every parsed row's timestamps fall inside the day window the
//      filename claims.
// Anything else is rejected with a structured reason so the UI can
// surface why nothing happened.

import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import {
  deviceDayJsonlPath,
  listDeviceDays,
} from './jsonl/paths'
import { parseRow, type JsonlRow } from './jsonl/jsonl-row'
import { utcDayBoundaryMs, utcDayFromMs, type UtcDay } from './jsonl/utc-day'
import { pLimit } from '../../shared/concurrency'

/** Filename shape that pairs with the cloud sync-unit encoding. The
 * encrypted cloud files end in `.enc`; the export files use `.jsonl`
 * so the user can open them in any text editor. */
const FILE_PATTERN = /^keyboards_(.+?)_devices_(.+?)_days_(\d{4}-\d{2}-\d{2})\.jsonl$/

export interface ExportFileRef {
  uid: string
  machineHash: string
  utcDay: UtcDay
  fileName: string
}

export function exportFileNameFor(uid: string, machineHash: string, utcDay: UtcDay): string {
  return `keyboards_${uid}_devices_${machineHash}_days_${utcDay}.jsonl`
}

export function parseExportFileName(name: string): ExportFileRef | null {
  const fileName = basename(name)
  const m = fileName.match(FILE_PATTERN)
  if (!m) return null
  return { uid: m[1], machineHash: m[2], utcDay: m[3], fileName }
}

export interface ExportResult {
  /** Number of day files successfully written. */
  written: number
  /** Output directory the caller picked — surfaced for the UI's "open
   * in finder" affordance. */
  destinationDir: string
}

/** Copy day files under (uid, ownHash) into `destinationDir`, naming
 * each entry with `exportFileNameFor`. When `daysFilter` is provided,
 * only days present in the set are written; an empty set produces an
 * empty export. Days that vanish between listing and read (race with
 * a concurrent delete) are silently skipped — the next export picks
 * them up if they reappear. */
export async function exportTypingDataForKeyboard(
  userDataDir: string,
  uid: string,
  ownHash: string,
  destinationDir: string,
  daysFilter?: ReadonlySet<string>,
): Promise<ExportResult> {
  await mkdir(destinationDir, { recursive: true })
  const allDays = await listDeviceDays(userDataDir, uid, ownHash)
  const days = daysFilter ? allDays.filter((d) => daysFilter.has(d)) : allDays
  const limit = pLimit(8)
  const results = await Promise.all(days.map((day) => limit(async () => {
    const src = deviceDayJsonlPath(userDataDir, uid, ownHash, day)
    const out = join(destinationDir, exportFileNameFor(uid, ownHash, day))
    try {
      const content = await readFile(src, 'utf-8')
      await writeFile(out, content, 'utf-8')
      return 1
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
      return 0
    }
  })))
  return { written: results.reduce((sum, n) => sum + n, 0), destinationDir }
}

export type ImportRejectReason =
  | 'invalid-filename'
  | 'live-day-locked'
  | 'duplicate-in-batch'
  | 'no-matching-target'
  | 'empty-or-invalid-content'
  | 'rows-outside-day-window'
  | 'read-error'

export interface ImportRejection {
  fileName: string
  reason: ImportRejectReason
}

export interface ImportResult {
  imported: number
  rejections: ImportRejection[]
}

export interface ImportOptions {
  /** Filename → boolean. Returns true when cloud already has a file
   * by that exact name (matches the encrypted form's basename
   * without the `.enc`). The renderer-supplied implementation typically
   * checks `listFiles()` for `${name.replace(/\.jsonl$/, '.enc')}`.
   * `null` means cloud was unavailable (offline / unauthenticated) —
   * the import then accepts local-only matches without erroring. */
  cloudHasFile: ((name: string) => Promise<boolean>) | null
  /** Override the wall clock used to compute "today (UTC)" for the
   * `live-day-locked` check. Defaults to `Date.now`. Tests pass a fixed
   * value so the live-day boundary is deterministic. */
  now?: () => number
}

/** Validate + overwrite a batch of files. Each path is processed
 * independently so a single bad entry doesn't abort the rest. */
export async function importTypingDataFiles(
  userDataDir: string,
  filePaths: readonly string[],
  options: ImportOptions,
): Promise<ImportResult> {
  const result: ImportResult = { imported: 0, rejections: [] }
  const today = utcDayFromMs((options.now ?? Date.now)())
  // Same-day file encountered earlier in this batch — refusing the
  // second one keeps the outcome deterministic instead of "last writer
  // in the file list wins".
  const seenTargets = new Set<string>()
  for (const path of filePaths) {
    const ref = parseExportFileName(path)
    if (!ref) {
      result.rejections.push({ fileName: basename(path), reason: 'invalid-filename' })
      continue
    }
    if (ref.utcDay === today) {
      result.rejections.push({ fileName: ref.fileName, reason: 'live-day-locked' })
      continue
    }
    const targetPath = deviceDayJsonlPath(userDataDir, ref.uid, ref.machineHash, ref.utcDay)
    if (seenTargets.has(targetPath)) {
      result.rejections.push({ fileName: ref.fileName, reason: 'duplicate-in-batch' })
      continue
    }
    seenTargets.add(targetPath)
    const localExists = await fileExists(targetPath)
    let cloudExists = false
    if (!localExists && options.cloudHasFile) {
      try {
        cloudExists = await options.cloudHasFile(ref.fileName)
      } catch {
        cloudExists = false
      }
    }
    if (!localExists && !cloudExists) {
      result.rejections.push({ fileName: ref.fileName, reason: 'no-matching-target' })
      continue
    }
    let body: string
    try {
      body = await readFile(path, 'utf-8')
    } catch {
      result.rejections.push({ fileName: ref.fileName, reason: 'read-error' })
      continue
    }
    const rows = parseRowsFromBody(body)
    if (rows === null || !rowsHaveTimestampedContent(rows)) {
      result.rejections.push({ fileName: ref.fileName, reason: 'empty-or-invalid-content' })
      continue
    }
    if (!rowsFallInsideDay(rows, ref.utcDay)) {
      result.rejections.push({ fileName: ref.fileName, reason: 'rows-outside-day-window' })
      continue
    }
    await mkdir(dirname(targetPath), { recursive: true })
    await writeFile(targetPath, body, 'utf-8')
    result.imported += 1
  }
  return result
}

/** Parse every non-empty line. Returns `null` when the body is empty
 * or any line fails to parse (unknown kind, bad JSON, missing fields)
 * — silent truncation of an existing day file is the worst possible
 * outcome here, so partial successes are not allowed. */
function parseRowsFromBody(body: string): JsonlRow[] | null {
  const rows: JsonlRow[] = []
  let nonEmpty = 0
  for (const line of body.split('\n')) {
    if (!line) continue
    nonEmpty += 1
    const row = parseRow(line)
    if (!row) return null
    rows.push(row)
  }
  return nonEmpty === 0 ? null : rows
}

function rowsHaveTimestampedContent(rows: readonly JsonlRow[]): boolean {
  return rows.some((r) => rowTimestamp(r) !== null)
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch { return false }
}

/** Every row's timestamps must fall inside `[startMs, endMs)` for the
 * advertised UTC day. minute-bucketed rows use `payload.minuteTs`;
 * sessions are checked with `startMs` only because their `endMs` is
 * allowed to spill into the next day. Scope rows have no timestamp
 * and are accepted unconditionally. */
function rowsFallInsideDay(rows: readonly JsonlRow[], day: UtcDay): boolean {
  const { startMs, endMs } = utcDayBoundaryMs(day)
  for (const row of rows) {
    if (row.kind === 'scope') continue
    const ts = rowTimestamp(row)
    if (ts === null) continue
    if (ts < startMs || ts >= endMs) return false
  }
  return true
}

function rowTimestamp(row: JsonlRow): number | null {
  switch (row.kind) {
    case 'char-minute':
    case 'matrix-minute':
    case 'minute-stats':
      return row.payload.minuteTs
    case 'session':
      return row.payload.startMs
    default:
      return null
  }
}
