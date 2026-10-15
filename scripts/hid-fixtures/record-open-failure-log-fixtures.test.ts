// SPDX-License-Identifier: GPL-2.0-or-later
// Fixture generator for the open-failure log of src-tauri/crates/pipette-hid.
// openHidDevice of src/main/hid-service.ts runs against a node-hid whose
// enumeration fails with each error, and the message it logs is recorded.
// The Rust service must log the same message at the same level.
//
// Run: pnpm run generate:hid-fixtures

import { describe, it, expect, vi } from 'vitest'
import { resolve } from 'node:path'
import { writeJsonFixture } from '../fixture-files'
import { REPO_ROOT } from '../fixture-vitest-config'

const devicesAsync = vi.hoisted(() => vi.fn())
const log = vi.hoisted(() => vi.fn())

vi.mock('node-hid', () => ({ default: { devicesAsync, HIDAsync: { open: vi.fn() } } }))
vi.mock('../../src/main/logger', () => ({ log, logHidPacket: vi.fn() }))

import { openHidDevice } from '../../src/main/hid-service'

const OUT = resolve(REPO_ROOT, 'src-tauri/crates/pipette-hid/tests/fixtures/ts_open_failure_logs.json')

const CASES: Array<[number, number, string]> = [
  [0x1234, 0x5678, 'cannot enumerate devices'],
  [0x0001, 0x00ab, 'could not open /dev/hidraw3: Permission denied'],
  [0x0000, 0x0000, ''],
  [0xffff, 0xffff, 'Ü✓ キーボード ⌨️'],
  [0x0a0b, 0x0c0d, 'two\nlines'],
]

describe('open failure log fixtures', () => {
  it('records the level and message logged for each failure', async () => {
    const logs = []
    for (const [vendorId, productId, error] of CASES) {
      log.mockClear()
      devicesAsync.mockRejectedValueOnce(new Error(error))
      await expect(openHidDevice(vendorId, productId)).rejects.toThrow()
      expect(log).toHaveBeenCalledTimes(1)
      const [level, message] = log.mock.calls[0] as [string, string]
      logs.push({ vendorId, productId, error, level, message })
    }
    writeJsonFixture(OUT, { logs })
  })
})
