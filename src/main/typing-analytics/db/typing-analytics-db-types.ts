// SPDX-License-Identifier: GPL-2.0-or-later
// Row shapes for typing-analytics-db.ts's SQLite-backed storage, split out
// so the statement-preparation modules and the class chain can share them
// without importing the facade.

import type {
  JsonlBigramMinuteEntry,
  JsonlBigramMinutePayload,
  JsonlTrigramMinuteEntry,
  JsonlTrigramMinutePayload,
} from '../jsonl/jsonl-row'

export interface TypingScopeRow {
  id: string
  machineHash: string
  osPlatform: string
  osRelease: string
  osArch: string
  keyboardUid: string
  keyboardVendorId: number
  keyboardProductId: number
  keyboardProductName: string
  updatedAt: number
  isDeleted?: boolean
}

export interface CharMinuteRow {
  scopeId: string
  minuteTs: number
  char: string
  count: number
  /** Active application captured at flush time. Optional on the input
   * shape to keep older callers / fixtures terse; the DB layer
   * normalizes missing to null on insert. */
  appName?: string | null
  /** Typing test label captured per-event (custom = text name, normal =
   * `mode (language)`). Missing/null = ordinary REC input or a mixed
   * minute. Normalized to null on insert. */
  typingTest?: string | null
  /** Individual test run id ('' = non-test input). Part of the primary
   * key, so missing is normalized to '' on insert. */
  runId?: string
}

export interface MatrixMinuteRow {
  scopeId: string
  minuteTs: number
  row: number
  col: number
  layer: number
  keycode: number
  count: number
  /** Portion of `count` attributed to a tap for LT/MT keys, classified
   * by release edge or by the renderer's deferred-emit deadline,
   * whichever comes first. Defaults to 0 when the row came from a
   * non-tap-hold press (older ingestion path, test fixtures, or a press
   * not yet classified). */
  tapCount?: number
  /** Portion of `count` attributed to a hold, by the same classification
   * as `tapCount`. Defaults to 0 for the same reasons as `tapCount`. */
  holdCount?: number
  /** Keypress-duration histogram (see bigram-bucket.ts's duration grid)
   * / sum / sum-of-squares (ms), from `matrix-release` events landing
   * in this minute. Field names match {@link JsonlMatrixMinutePayload}'s
   * `dh`/`ds`/`dq` exactly (not spelled out) because apply-to-cache.ts
   * spreads a parsed JSONL payload straight into this shape — a
   * same-meaning-different-name pair here would silently stop
   * persisting duration data with no type error (every field involved
   * is optional). All three null/undefined together — a row written
   * before schema v8, or a cell with no duration samples this minute (a
   * routine state — see the shared event type's note on release-minute
   * vs press-minute attribution). */
  dh?: number[] | null
  ds?: number | null
  dq?: number | null
  /** See {@link CharMinuteRow.appName}. */
  appName?: string | null
  /** See {@link CharMinuteRow.typingTest}. */
  typingTest?: string | null
  /** See {@link CharMinuteRow.runId}. */
  runId?: string
}

export interface MinuteStatsRow {
  scopeId: string
  minuteTs: number
  keystrokes: number
  activeMs: number
  intervalAvgMs: number | null
  intervalMinMs: number | null
  intervalP25Ms: number | null
  intervalP50Ms: number | null
  intervalP75Ms: number | null
  intervalMaxMs: number | null
  /** Median / p95 sampling gap (ms) between polled matrix frames this
   * minute. Null for rows written before schema v8, or a minute with
   * no poll-gap sample. */
  pollP50Ms?: number | null
  pollP95Ms?: number | null
  /** See {@link CharMinuteRow.appName}. */
  appName?: string | null
  /** See {@link CharMinuteRow.typingTest}. */
  typingTest?: string | null
  /** See {@link CharMinuteRow.runId}. */
  runId?: string
}

export interface SessionRow {
  id: string
  scopeId: string
  startMs: number
  endMs: number
}

/** Per-pair bigram aggregate within a minute. Aliased from the JSONL
 * row shape so the merge / parse layers share a single source of
 * truth. `bigramId` follows the `${prevKeycode}_${currKeycode}` format;
 * `h` is the decoded 8-bucket histogram that the merge layer encodes
 * to a compact BLOB for storage. `s` / `sq` are the optional raw-IKI
 * sum / sum-of-squares pair (see JsonlBigramMinuteEntry). */
export type BigramMinuteEntry = JsonlBigramMinuteEntry
export type BigramMinuteRow = JsonlBigramMinutePayload

/** Same shape as {@link BigramMinuteEntry} / {@link BigramMinuteRow} for
 * trigrams — see JsonlTrigramMinuteEntry / JsonlTrigramMinutePayload. */
export type TrigramMinuteEntry = JsonlTrigramMinuteEntry
export type TrigramMinuteRow = JsonlTrigramMinutePayload

/** Row shape returned by range queries against typing_bigram_minute or
 * typing_trigram_minute — both tables project their id column as
 * `ngramId` so a single shape covers 2-gram and 3-gram callers alike.
 * `hist` is decoded from the on-disk BLOB so callers don't depend on
 * better-sqlite3's binary representation. `sumIki` / `sumSqIki` are
 * null when the row predates the sum columns (see schema.ts). One row
 * per (scope, minute, ngram) — the aggregation layer (range / view
 * IPC) sums these into pair-totals. */
export interface NgramMinuteCellRow {
  ngramId: string
  minuteTs: number
  count: number
  hist: number[]
  sumIki: number | null
  sumSqIki: number | null
  /** Physical-overlap accumulators (see OverlapCounts in
   * minute-buffer.ts) — only ever populated for BIGRAM rows;
   * `undefined` for trigram rows (the table has no such columns) so
   * callers can tell "not applicable" apart from "recorded as null". */
  overlapCount?: number | null
  overlapN?: number | null
}

/** Row shape returned by {@link TypingAnalyticsDB.listMatrixDurationCellsForUid} /
 * {@link TypingAnalyticsDB.listMatrixDurationCellsForUidAndHash} — one row
 * per (scope, minute, cell) that had at least one `matrix-release` sample
 * (rows with no sample that minute are excluded by the SQL, not returned
 * with an empty histogram). `hist` is decoded from the on-disk BLOB. */
export interface MatrixDurationCellRow {
  row: number
  col: number
  layer: number
  minuteTs: number
  hist: number[]
  sum: number
  sumSq: number
}

/** Row shapes carried across sync bundles. Live columns plus the
 * updated_at / is_deleted metadata the merge layer needs for LWW. */
export interface CharMinuteExportRow extends CharMinuteRow {
  updatedAt: number
  isDeleted: boolean
}
export interface MatrixMinuteExportRow extends MatrixMinuteRow {
  updatedAt: number
  isDeleted: boolean
}
export interface MinuteStatsExportRow extends MinuteStatsRow {
  updatedAt: number
  isDeleted: boolean
}
export interface SessionExportRow extends SessionRow {
  updatedAt: number
  isDeleted: boolean
}
export interface BigramMinuteExportRow extends BigramMinuteRow {
  updatedAt: number
  isDeleted: boolean
}
export interface TrigramMinuteExportRow extends TrigramMinuteRow {
  updatedAt: number
  isDeleted: boolean
}

// isDeleted is stored as a SQLite integer (0/1); Omit the row type's own
// boolean isDeleted before intersecting with the raw numeric column so
// the two conflicting property types don't collapse the whole
// intersection to `never`.
export type WithDeletedFlag<T> = Omit<T, 'isDeleted'> & { isDeleted: number }
