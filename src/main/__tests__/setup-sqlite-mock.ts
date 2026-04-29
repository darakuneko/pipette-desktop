// SPDX-License-Identifier: GPL-2.0-or-later
// Initializes the sql.js WebAssembly engine once per vitest process so the
// better-sqlite3 adapter (aliased via vitest.config.ts resolve.alias) can
// construct Database instances synchronously from inside test code.

import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import initSqlJs from 'sql.js'
import { __setSqlJs } from './better-sqlite3-adapter'

const require = createRequire(import.meta.url)
const sqlJsDir = dirname(require.resolve('sql.js'))

const SQL = await initSqlJs({
  locateFile: (file) => join(sqlJsDir, file),
})

__setSqlJs(SQL)
