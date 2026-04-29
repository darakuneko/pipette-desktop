// SPDX-License-Identifier: GPL-2.0-or-later
// Test-only drop-in replacement for better-sqlite3. Routes the subset of
// the API our code uses through sql.js (pure-JS SQLite) so vitest runs
// against Node ABI without needing the Electron-ABI prebuilt binary.
// Wired via vitest.config.ts resolve.alias.

import { readFileSync, writeFileSync } from 'node:fs'
import type { Database as SqlJsDatabase, SqlJsStatic } from 'sql.js'

type BindValue = null | number | string | Uint8Array
type BindParams = Record<string, BindValue> | BindValue[]

const INSERT_PREFIX = /^\s*insert\b/i
const PREFIXED_PARAM = /^[@:$]/

function isMemoryPath(path: string): boolean {
  return path === ':memory:'
}

let sqlJs: SqlJsStatic | null = null

/** Called once from the vitest setup file after top-level `await initSqlJs()`. */
export function __setSqlJs(instance: SqlJsStatic): void {
  sqlJs = instance
}

function requireSqlJs(): SqlJsStatic {
  if (!sqlJs) {
    throw new Error(
      'better-sqlite3 adapter: sql.js was not initialized. ' +
        'Vitest setupFiles must run setup-sqlite-mock.ts before tests.',
    )
  }
  return sqlJs
}

/** Persist the db contents so reopening the same path yields the same rows
 * (better-sqlite3 gives you a real file; sql.js is purely in-memory, so we
 * shim the round-trip with fs.readFileSync / writeFileSync). */
function loadBytes(path: string): Uint8Array | undefined {
  if (isMemoryPath(path)) return undefined
  try {
    return new Uint8Array(readFileSync(path))
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw err
  }
}

/** better-sqlite3 accepts named bindings as `{foo: 1}` bound to `@foo`.
 * sql.js expects the parameter prefix in the key name, so we expand every
 * key into each of the three prefixes sql.js recognises. */
function normalizeParams(args: unknown[]): BindParams | undefined {
  if (args.length === 0) return undefined
  if (args.length === 1) {
    const single = args[0]
    if (single !== null && typeof single === 'object' && !Array.isArray(single) && !(single instanceof Uint8Array)) {
      const expanded: Record<string, BindValue> = {}
      for (const [key, rawValue] of Object.entries(single as Record<string, unknown>)) {
        const value = coerceBindValue(rawValue)
        if (PREFIXED_PARAM.test(key)) {
          expanded[key] = value
        } else {
          expanded[`@${key}`] = value
          expanded[`:${key}`] = value
          expanded[`$${key}`] = value
        }
      }
      return expanded
    }
  }
  return args.map(coerceBindValue) as BindValue[]
}

function coerceBindValue(value: unknown): BindValue {
  if (value === null || value === undefined) return null
  if (typeof value === 'boolean') return value ? 1 : 0
  if (typeof value === 'bigint') return Number(value)
  if (typeof value === 'number' || typeof value === 'string') return value
  if (value instanceof Uint8Array) return value
  return String(value)
}

class AdapterStatement {
  constructor(
    private readonly raw: SqlJsDatabase,
    private readonly sql: string,
  ) {}

  private withStmt<T>(args: unknown[], fn: (stmt: ReturnType<SqlJsDatabase['prepare']>) => T): T {
    const stmt = this.raw.prepare(this.sql)
    try {
      const params = normalizeParams(args)
      if (params !== undefined) stmt.bind(params as BindParams)
      return fn(stmt)
    } finally {
      stmt.free()
    }
  }

  run(...args: unknown[]): { changes: number; lastInsertRowid: number } {
    this.withStmt(args, (stmt) => {
      stmt.step()
    })
    const changes = this.raw.getRowsModified()
    // last_insert_rowid() is only meaningful after INSERT; skip the probe
    // otherwise so update/delete-heavy suites don't pay for an extra exec.
    let lastInsertRowid = 0
    if (INSERT_PREFIX.test(this.sql)) {
      const result = this.raw.exec('SELECT last_insert_rowid() AS id')
      lastInsertRowid = Number(result?.[0]?.values?.[0]?.[0] ?? 0)
    }
    return { changes, lastInsertRowid }
  }

  get(...args: unknown[]): Record<string, unknown> | undefined {
    return this.withStmt(args, (stmt) => {
      if (!stmt.step()) return undefined
      return stmt.getAsObject() as Record<string, unknown>
    })
  }

  all(...args: unknown[]): Record<string, unknown>[] {
    return this.withStmt(args, (stmt) => {
      const rows: Record<string, unknown>[] = []
      while (stmt.step()) rows.push(stmt.getAsObject() as Record<string, unknown>)
      return rows
    })
  }
}

class AdapterDatabase {
  private readonly raw: SqlJsDatabase
  private readonly path: string
  private readonly memoryBacked: boolean
  private txDepth = 0
  private closed = false

  constructor(path = ':memory:', _options?: unknown) {
    this.path = path
    this.memoryBacked = isMemoryPath(path)
    const SQL = requireSqlJs()
    this.raw = new SQL.Database(loadBytes(path))
  }

  prepare(sql: string): AdapterStatement {
    return new AdapterStatement(this.raw, sql)
  }

  exec(sql: string): this {
    this.raw.exec(sql)
    this.persist()
    return this
  }

  pragma(source: string, options?: { simple?: boolean }): unknown {
    const sql = /^\s*pragma\s/i.test(source) ? source : `PRAGMA ${source}`
    const rows = this.raw.exec(sql)
    if (!rows.length) return []
    const [first] = rows
    if (options?.simple) {
      return first.values?.[0]?.[0] ?? null
    }
    return (first.values ?? []).map((row: unknown[]) => {
      const obj: Record<string, unknown> = {}
      first.columns.forEach((col: string, idx: number) => {
        obj[col] = row[idx]
      })
      return obj
    })
  }

  transaction<T extends (...args: unknown[]) => unknown>(fn: T): T {
    const wrapped = (...args: unknown[]) => {
      const savepoint = this.txDepth > 0 ? `sp_${this.txDepth}` : null
      if (savepoint) {
        this.raw.exec(`SAVEPOINT ${savepoint}`)
      } else {
        this.raw.exec('BEGIN')
      }
      this.txDepth++
      try {
        const result = fn(...args)
        this.txDepth--
        if (savepoint) {
          this.raw.exec(`RELEASE ${savepoint}`)
        } else {
          this.raw.exec('COMMIT')
          this.persist()
        }
        return result
      } catch (err) {
        this.txDepth--
        if (savepoint) {
          this.raw.exec(`ROLLBACK TO ${savepoint}; RELEASE ${savepoint}`)
        } else {
          this.raw.exec('ROLLBACK')
        }
        throw err
      }
    }
    return wrapped as T
  }

  close(): void {
    if (this.closed) return
    this.persist()
    this.raw.close()
    this.closed = true
  }

  get name(): string {
    return this.path
  }
  get open(): boolean {
    return !this.closed
  }
  get memory(): boolean {
    return this.memoryBacked
  }
  get readonly(): boolean {
    return false
  }
  get inTransaction(): boolean {
    return this.txDepth > 0
  }

  private persist(): void {
    if (this.memoryBacked || this.closed || this.txDepth > 0) return
    writeFileSync(this.path, Buffer.from(this.raw.export()))
  }
}

export default AdapterDatabase
