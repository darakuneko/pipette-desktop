// SPDX-License-Identifier: GPL-2.0-or-later
// Meta-table statements — the only group prepared BEFORE migrateSchema
// runs, since reading schema_version must not depend on the very
// migration it's about to trigger. See typing-analytics-db-base.ts's
// constructor for the 3-phase init this ordering requires.

import type { Database as DatabaseType, Statement } from 'better-sqlite3'

export interface MetaStatements {
  getMetaStmt: Statement
  setMetaStmt: Statement
}

export function prepareMetaStatements(db: DatabaseType): MetaStatements {
  return {
    getMetaStmt: db.prepare('SELECT value FROM typing_analytics_meta WHERE key = ?'),
    setMetaStmt: db.prepare(`
      INSERT INTO typing_analytics_meta (key, value) VALUES (@key, @value)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `),
  }
}
