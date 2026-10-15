// SPDX-License-Identifier: GPL-2.0-or-later
// Fixture generator for the log line format of src-tauri/crates/
// pipette-logger. Each message goes through the real log and logHidPacket
// of src/main/logger.ts at a fixed system time, into a temp userData, and
// the line it appends is recorded. The Rust logger must write the same
// lines.
//
// Run: pnpm run generate:fs-logger-fixtures

import { describe, it, expect, vi, afterAll } from 'vitest'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { writeJsonFixture } from '../fixture-files'
import { REPO_ROOT } from '../fixture-vitest-config'

const userData = vi.hoisted(() => ({ dir: '' }))

vi.mock('electron', () => ({ app: { getPath: () => userData.dir } }))

import { log, logHidPacket, type LogLevel } from '../../src/main/logger'

const OUT = resolve(REPO_ROOT, 'src-tauri/crates/pipette-logger/tests/fixtures/ts_log_lines.json')

const TIMES = [
  0,
  Date.UTC(1999, 11, 31, 23, 59, 59, 999),
  Date.UTC(2024, 1, 29, 12, 0, 0, 7),
  Date.UTC(2026, 9, 16, 1, 2, 3, 456),
  Date.UTC(2100, 2, 1, 0, 0, 0, 50),
]

const MESSAGES: Array<[LogLevel, string]> = [
  ['info', 'Pipette starting'],
  ['warn', 'a warning with "quotes" and \\backslashes\\'],
  ['error', 'Ü✓ キーボード ⌨️'],
  ['debug', 'two\nlines'],
  ['info', ''],
]

const PACKETS: Array<['TX' | 'RX', number[]]> = [
  ['TX', [0xfe, 0x00, 0x0a, ...new Array<number>(29).fill(0)]],
  ['RX', Array.from({ length: 32 }, (_, i) => (i * 37) & 0xff)],
]

let readUpTo = 0

/** What the logger appended since the previous call. */
function appended(): string {
  const bytes = readFileSync(join(userData.dir, 'logs', 'pipette-0.log'))
  const text = bytes.subarray(readUpTo).toString('utf-8')
  readUpTo = bytes.length
  return text
}

describe('log line fixtures', () => {
  userData.dir = mkdtempSync(join(tmpdir(), 'pipette-log-fixture-'))
  afterAll(() => {
    vi.useRealTimers()
    rmSync(userData.dir, { recursive: true, force: true })
  })

  it('records the TypeScript line for every message and packet', () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    const lines = []
    for (const epochMs of TIMES) {
      vi.setSystemTime(epochMs)
      for (const [level, message] of MESSAGES) {
        log(level, message)
        lines.push({ epochMs, level, message, line: appended() })
      }
    }

    const packets = []
    const previous = process.env.VIAL_DEBUG_HID
    process.env.VIAL_DEBUG_HID = '1'
    try {
      vi.setSystemTime(TIMES[3])
      for (const [direction, data] of PACKETS) {
        logHidPacket(direction, new Uint8Array(data))
        packets.push({ epochMs: TIMES[3], direction, data, line: appended() })
      }
    } finally {
      if (previous === undefined) delete process.env.VIAL_DEBUG_HID
      else process.env.VIAL_DEBUG_HID = previous
    }

    writeJsonFixture(OUT, { lines, packets })
    expect(lines.every((l) => l.line.endsWith('\n'))).toBe(true)
  })
})
