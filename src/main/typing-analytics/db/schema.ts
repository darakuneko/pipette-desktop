// SPDX-License-Identifier: GPL-2.0-or-later
// SQLite schema for the typing analytics database. See
// .claude/plans/typing-analytics.md for the design rationale.

export const SCHEMA_VERSION = 1

export const CREATE_SCHEMA_SQL = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS typing_scopes (
  id TEXT PRIMARY KEY,
  machine_hash TEXT NOT NULL,
  os_platform TEXT NOT NULL,
  os_release TEXT NOT NULL,
  os_arch TEXT NOT NULL,
  keyboard_uid TEXT NOT NULL,
  keyboard_vendor_id INTEGER NOT NULL,
  keyboard_product_id INTEGER NOT NULL,
  keyboard_product_name TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  is_deleted INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_scopes_keyboard_uid ON typing_scopes(keyboard_uid);

CREATE TABLE IF NOT EXISTS typing_char_minute (
  scope_id TEXT NOT NULL,
  minute_ts INTEGER NOT NULL,
  char TEXT NOT NULL,
  count INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  is_deleted INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (scope_id, minute_ts, char),
  FOREIGN KEY (scope_id) REFERENCES typing_scopes(id)
);
CREATE INDEX IF NOT EXISTS idx_char_minute_ts ON typing_char_minute(minute_ts);

CREATE TABLE IF NOT EXISTS typing_matrix_minute (
  scope_id TEXT NOT NULL,
  minute_ts INTEGER NOT NULL,
  row INTEGER NOT NULL,
  col INTEGER NOT NULL,
  layer INTEGER NOT NULL,
  keycode INTEGER NOT NULL,
  count INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  is_deleted INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (scope_id, minute_ts, row, col, layer),
  FOREIGN KEY (scope_id) REFERENCES typing_scopes(id)
);
CREATE INDEX IF NOT EXISTS idx_matrix_minute_ts ON typing_matrix_minute(minute_ts);
-- Supports the typing-view heatmap (scope_id + layer + minute_ts range scan
-- polled every few seconds). Without it the heatmap query falls back to the
-- minute_ts-only index and re-filters every scope/layer row in memory.
CREATE INDEX IF NOT EXISTS idx_matrix_minute_scope_layer_ts ON typing_matrix_minute(scope_id, layer, minute_ts);

CREATE TABLE IF NOT EXISTS typing_minute_stats (
  scope_id TEXT NOT NULL,
  minute_ts INTEGER NOT NULL,
  keystrokes INTEGER NOT NULL,
  active_ms INTEGER NOT NULL,
  interval_avg_ms INTEGER,
  interval_min_ms INTEGER,
  interval_p25_ms INTEGER,
  interval_p50_ms INTEGER,
  interval_p75_ms INTEGER,
  interval_max_ms INTEGER,
  updated_at INTEGER NOT NULL,
  is_deleted INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (scope_id, minute_ts),
  FOREIGN KEY (scope_id) REFERENCES typing_scopes(id)
);

CREATE TABLE IF NOT EXISTS typing_sessions (
  id TEXT PRIMARY KEY,
  scope_id TEXT NOT NULL,
  start_ms INTEGER NOT NULL,
  end_ms INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  is_deleted INTEGER NOT NULL DEFAULT 0,
  FOREIGN KEY (scope_id) REFERENCES typing_scopes(id)
);
CREATE INDEX IF NOT EXISTS idx_sessions_scope_start ON typing_sessions(scope_id, start_ms);

CREATE TABLE IF NOT EXISTS typing_analytics_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`
