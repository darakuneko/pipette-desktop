// SPDX-License-Identifier: GPL-2.0-or-later
// Shared row encode/decode helpers used by both the write path (merge /
// ingest statements) and the read path (range queries) of
// typing-analytics-db.ts.

import { BIGRAM_HIST_BUCKETS } from '../jsonl/jsonl-row'
import type { TypingMatrixCellDailyRow } from '../../../shared/types/typing-analytics'

/** Pack the 8-bucket bigram histogram into a 32-byte little-endian u32
 * buffer for BLOB storage. Treats missing / non-finite entries as 0
 * so a malformed JSONL row can't crash the merge. */
export function encodeHistBuffer(hist: readonly number[]): Buffer {
  const buf = Buffer.alloc(BIGRAM_HIST_BUCKETS * 4)
  for (let i = 0; i < BIGRAM_HIST_BUCKETS; i += 1) {
    const value = hist[i]
    buf.writeUInt32LE(Number.isFinite(value) && value >= 0 ? value : 0, i * 4)
  }
  return buf
}

/** Decode a stored bigram histogram BLOB into the 8-element count
 * array. better-sqlite3 returns BLOBs as Uint8Array; the wrapper
 * around DataView keeps the parser independent of Node Buffer typing
 * so callers can pass either shape. */
export function decodeHistBuffer(buf: Uint8Array): number[] {
  if (buf.byteLength !== BIGRAM_HIST_BUCKETS * 4) {
    // Defensive: a row produced by a different schema version would
    // never satisfy the merge BLOB length, but the cache rebuild path
    // can in principle accept hand-crafted JSONL. Returning zeros
    // avoids crashing read-paths on a broken row.
    return new Array<number>(BIGRAM_HIST_BUCKETS).fill(0)
  }
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
  const out = new Array<number>(BIGRAM_HIST_BUCKETS)
  for (let i = 0; i < BIGRAM_HIST_BUCKETS; i += 1) {
    out[i] = view.getUint32(i * 4, true)
  }
  return out
}

/** Raw row shape returned by the matrix-cells-by-day SQL. The
 * `date` column carries a `YYYY-MM-DD` string from
 * `strftime('localtime')` which we convert to a local-midnight epoch
 * ms before returning {@link TypingMatrixCellDailyRow}. */
export interface MatrixCellsByDayDbRow {
  date: string
  layer: number
  row: number
  col: number
  count: number
  tap: number
  hold: number
}

export function localDateStringToMs(dateStr: string): number {
  // `dateStr` is `YYYY-MM-DD` from SQLite's strftime('localtime'); the
  // 3-arg Date constructor parses it as local midnight, which is what
  // the renderer expects for week / month bucketing.
  const [yy, mm, dd] = dateStr.split('-').map((s) => Number.parseInt(s, 10))
  return new Date(yy, mm - 1, dd).getTime()
}

export function matrixCellsByDayDbRowToDailyRow(r: MatrixCellsByDayDbRow): TypingMatrixCellDailyRow {
  return {
    dayMs: localDateStringToMs(r.date),
    layer: r.layer,
    row: r.row,
    col: r.col,
    count: r.count,
    tap: r.tap,
    hold: r.hold,
  }
}
