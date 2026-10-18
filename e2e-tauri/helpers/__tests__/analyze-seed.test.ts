// SPDX-License-Identifier: GPL-2.0-or-later
// The Analyze seed writes every row into the day file of its own UTC day,
// in any time zone: the app reads a day file only for rows inside the UTC
// day its name gives.

import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { DUMMY_TA_UID, seedDummyTypingAnalytics } from '../analyze-seed'

const MACHINE_HASH = 'a'.repeat(64)
const NOW = Date.UTC(2026, 9, 1, 23, 0, 0)
const ORIGINAL_TZ = process.env.TZ

interface Row {
  kind: string
  payload: { minuteTs?: number; startMs?: number }
}

/** Seeds a fresh userData directory in `zone` and returns its day files
 *  (name → rows). */
async function seedIn(zone: string): Promise<Map<string, Row[]>> {
  process.env.TZ = zone
  const userData = mkdtempSync(join(tmpdir(), 'pipette-analyze-seed-'))
  try {
    mkdirSync(join(userData, 'local', 'typing-analytics'), { recursive: true })
    writeFileSync(
      join(userData, 'local', 'typing-analytics', 'sync_state.json'),
      JSON.stringify({ my_device_id: MACHINE_HASH }),
    )
    await seedDummyTypingAnalytics(userData, NOW)
    const dir = join(userData, 'sync', 'keyboards', DUMMY_TA_UID, 'devices', MACHINE_HASH)
    const files = new Map<string, Row[]>()
    for (const name of readdirSync(dir).sort()) {
      const lines = readFileSync(join(dir, name), 'utf8').split('\n').filter((line) => line.length > 0)
      files.set(name, lines.map((line) => JSON.parse(line) as Row))
    }
    return files
  } finally {
    rmSync(userData, { recursive: true, force: true })
  }
}

afterEach(() => {
  if (ORIGINAL_TZ === undefined) delete process.env.TZ
  else process.env.TZ = ORIGINAL_TZ
})

describe('seedDummyTypingAnalytics', () => {
  it.each(['UTC', 'Asia/Tokyo', 'America/New_York', 'Pacific/Kiritimati'])(
    'keeps every row inside the UTC day of its file in %s',
    async (zone) => {
      const files = await seedIn(zone)
      expect(files.size).toBeGreaterThan(21)
      for (const [name, rows] of files) {
        const day = name.replace(/\.jsonl$/, '')
        expect(rows[0].kind).toBe('scope')
        for (const row of rows.slice(1)) {
          expect(row.kind).not.toBe('scope')
          const ms = row.kind === 'session' ? row.payload.startMs : row.payload.minuteTs
          expect(new Date(ms ?? Number.NaN).toISOString().slice(0, 10)).toBe(day)
        }
      }
    },
  )
})
