// SPDX-License-Identifier: GPL-2.0-or-later

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  charMinuteRowId,
  serializeRow,
  type JsonlRow,
} from '../jsonl-row'
import { readRows } from '../jsonl-reader'

function row(char: string, count: number, updatedAt: number): JsonlRow {
  return {
    id: charMinuteRowId('scope-1', 60_000, char),
    kind: 'char-minute',
    updated_at: updatedAt,
    payload: { scopeId: 'scope-1', minuteTs: 60_000, char, count },
  }
}

describe('readRows', () => {
  let tmpDir: string
  let path: string

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'pipette-jsonl-reader-'))
    path = join(tmpDir, 'device.jsonl')
  })

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it('returns an empty result when the file does not exist', async () => {
    const result = await readRows(path)
    expect(result.rows).toEqual([])
    expect(result.lastId).toBeNull()
    expect(result.partialLineSkipped).toBe(false)
  })

  it('preserves the caller-supplied afterId when the file is missing', async () => {
    const result = await readRows(path, { afterId: 'prev' })
    expect(result.lastId).toBe('prev')
  })

  it('reads all rows from a well-formed file', async () => {
    const rows = [row('a', 1, 1), row('b', 2, 2), row('c', 3, 3)]
    writeFileSync(path, rows.map(serializeRow).join(''))
    const result = await readRows(path)
    expect(result.rows.map((r) => r.id)).toEqual(rows.map((r) => r.id))
    expect(result.lastId).toBe(rows[2].id)
    expect(result.partialLineSkipped).toBe(false)
  })

  it('returns only rows after afterId (exclusive)', async () => {
    const rows = [row('a', 1, 1), row('b', 2, 2), row('c', 3, 3)]
    writeFileSync(path, rows.map(serializeRow).join(''))
    const result = await readRows(path, { afterId: rows[0].id })
    expect(result.rows.map((r) => r.id)).toEqual([rows[1].id, rows[2].id])
    expect(result.lastId).toBe(rows[2].id)
  })

  it('keeps the pointer when afterId points past the current end', async () => {
    writeFileSync(path, serializeRow(row('a', 1, 1)))
    const result = await readRows(path, { afterId: row('b', 2, 2).id })
    expect(result.rows).toEqual([])
    expect(result.lastId).toBe(row('b', 2, 2).id)
  })

  it('skips a trailing partial line (no terminating newline)', async () => {
    const complete = serializeRow(row('a', 1, 1))
    const partial = JSON.stringify(row('b', 2, 2))
    writeFileSync(path, complete + partial)
    const result = await readRows(path)
    expect(result.rows.map((r) => r.id)).toEqual([row('a', 1, 1).id])
    expect(result.partialLineSkipped).toBe(true)
  })

  it('drops malformed / unknown-kind lines and keeps the rest', async () => {
    const lines = [
      serializeRow(row('a', 1, 1)),
      '{ garbled\n',
      JSON.stringify({ id: 'x|1', kind: 'mystery', updated_at: 1, payload: {} }) + '\n',
      serializeRow(row('b', 2, 2)),
    ]
    writeFileSync(path, lines.join(''))
    const result = await readRows(path)
    expect(result.rows.map((r) => r.id)).toEqual([row('a', 1, 1).id, row('b', 2, 2).id])
    expect(result.partialLineSkipped).toBe(false)
  })
})
