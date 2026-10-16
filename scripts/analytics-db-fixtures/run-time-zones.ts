// SPDX-License-Identifier: GPL-2.0-or-later
// Runs the time-zone fixture generators (tz-*.test.ts in this directory)
// once per zone of time-zones.ts, each in a process started with TZ set:
// both JavaScript and SQLite's 'localtime' (the C library) read the zone
// when the process starts. Like the other generators of this directory
// they run under Electron acting as Node, so better-sqlite3 loads.
//
// Run: pnpm run generate:analytics-db-fixtures

import { spawnSync } from 'node:child_process'
import { FIXTURE_TIME_ZONES, FIXTURE_TIME_ZONE_VAR } from './time-zones'

for (const zone of FIXTURE_TIME_ZONES) {
  const result = spawnSync(
    'electron',
    ['node_modules/vitest/vitest.mjs', 'run', '--config', 'scripts/analytics-db-fixtures/vitest.config.ts', 'tz-'],
    {
      stdio: 'inherit',
      shell: process.platform === 'win32',
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', TZ: zone, [FIXTURE_TIME_ZONE_VAR]: zone },
    },
  )
  if (result.status !== 0) {
    console.error(`the time-zone fixtures failed in ${zone}`)
    process.exit(result.status ?? 1)
  }
}
