// SPDX-License-Identifier: GPL-2.0-or-later
// Streaming reader for the per-device typing-analytics JSONL files.
// Reads every row in the file by default; an optional `afterId` pointer
// lets a caller resume from a known row id without re-reading the head.
// A trailing line without a newline terminator is treated as partial
// (crash-truncated) and skipped — the caller keeps the previous pointer
// and retries next pass.

import { createReadStream } from 'node:fs'
import { open } from 'node:fs/promises'
import { createInterface } from 'node:readline'
import type { JsonlRow } from './jsonl-row'
import { parseRow } from './jsonl-row'

export interface ReadOptions {
  /** When set, only rows appearing *after* the row with this id are
   * returned. `null` or absent means "read from the beginning". */
  afterId?: string | null
}

export interface ReadResult {
  rows: JsonlRow[]
  /** Id of the last row successfully emitted in `rows`. When no new rows
   * were found, this is the input `afterId`. Consumers persist it as the
   * next pass's `afterId` to guarantee forward progress. */
  lastId: string | null
  /** True when the file ended mid-line (last byte was not '\n'). The
   * partial line is always skipped; this flag lets callers warn / log. */
  partialLineSkipped: boolean
}

async function endsWithNewline(path: string): Promise<boolean | null> {
  let handle
  try {
    handle = await open(path, 'r')
  } catch {
    return null
  }
  try {
    const stats = await handle.stat()
    if (stats.size === 0) return true
    const buf = Buffer.alloc(1)
    await handle.read(buf, 0, 1, stats.size - 1)
    return buf[0] === 0x0a
  } finally {
    await handle.close()
  }
}

/** Read every row after `afterId` from the JSONL file at `path`. Returns
 * an empty result when the file does not exist (a cold boot before any
 * writer has flushed). Unknown / malformed lines are silently dropped by
 * `parseRow` so forward-compat row kinds from newer builds don't poison
 * the whole file.
 *
 * Memory footprint is O(emitted rows) — lines are parsed as they stream
 * in, with a single-line lookahead buffer so the last line can be
 * discarded when the file ended mid-write (no terminating newline). */
export async function readRows(
  path: string,
  options: ReadOptions = {},
): Promise<ReadResult> {
  const afterId = options.afterId ?? null
  const terminated = await endsWithNewline(path)
  if (terminated === null) {
    return { rows: [], lastId: afterId, partialLineSkipped: false }
  }

  const rows: JsonlRow[] = []
  let lastId = afterId
  let passed = afterId === null
  let pending: string | null = null

  const processLine = (line: string): void => {
    if (!line) return
    const row = parseRow(line)
    if (!row) return
    if (!passed) {
      if (row.id === afterId) passed = true
      return
    }
    rows.push(row)
    lastId = row.id
  }

  const stream = createReadStream(path, { encoding: 'utf8' })
  const rl = createInterface({ input: stream, crlfDelay: Infinity })
  for await (const line of rl) {
    if (pending !== null) processLine(pending)
    pending = line
  }

  let partialLineSkipped = false
  if (pending !== null) {
    if (terminated) processLine(pending)
    else partialLineSkipped = true
  }

  return { rows, lastId, partialLineSkipped }
}
