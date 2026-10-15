// SPDX-License-Identifier: GPL-2.0-or-later
// A text form of SQLite values that is the same in TypeScript and Rust, so
// two databases can be compared cell by cell and by digest. Each cell keeps
// its storage class: `n` (NULL), `i:<decimal>` (INTEGER), `r:<16 hex>` (the
// REAL's IEEE-754 bits, big-endian), `t:<hex of UTF-8>` (TEXT),
// `b:<hex>` (BLOB). Cells are joined by `|`, rows by `\n`. The Rust side
// (tests/common/mod.rs of the crate) builds the same text.

import { createHash } from 'node:crypto'
import type { Database as DatabaseType } from 'better-sqlite3'

export function realBits(value: number): string {
  const view = new DataView(new ArrayBuffer(8))
  view.setFloat64(0, value)
  return view.getBigUint64(0).toString(16).padStart(16, '0')
}

/** A value read with `safeIntegers(true)`, so INTEGER arrives as bigint and
 * REAL as number. */
function cell(value: unknown): string {
  if (value === null) return 'n'
  if (typeof value === 'bigint') return `i:${value.toString()}`
  if (typeof value === 'number') return `r:${realBits(value)}`
  if (typeof value === 'string') return `t:${Buffer.from(value, 'utf8').toString('hex')}`
  if (value instanceof Uint8Array) return `b:${Buffer.from(value).toString('hex')}`
  throw new Error(`unexpected SQLite value ${String(value)}`)
}

/** A number as the Analyze query hands it to the renderer: every JS number
 * is a double, so INTEGER and REAL results both become `r:` cells. */
export function numberCell(value: unknown): string {
  if (value === null) return 'n'
  if (typeof value === 'number') return `r:${realBits(value)}`
  throw new Error(`unexpected query value ${String(value)}`)
}

export interface TableDump {
  count: number
  sha256: string
  rows?: string[]
}

/** Every row of `table`, ordered by its primary key, in the canonical text. */
export function dumpTable(db: DatabaseType, table: string, withRows: boolean): TableDump {
  const info = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string; pk: number }>
  const pk = info.filter((c) => c.pk > 0).sort((a, b) => a.pk - b.pk).map((c) => c.name)
  const columns = info.map((c) => c.name).join(', ')
  const stmt = db.prepare(`SELECT ${columns} FROM ${table} ORDER BY ${pk.join(', ')}`).raw(true).safeIntegers(true)
  const rows = (stmt.all() as unknown[][]).map((r) => r.map(cell).join('|'))
  const sha256 = createHash('sha256').update(rows.join('\n'), 'utf8').digest('hex')
  return withRows ? { count: rows.length, sha256, rows } : { count: rows.length, sha256 }
}
