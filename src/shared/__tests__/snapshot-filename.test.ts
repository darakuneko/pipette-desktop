// SPDX-License-Identifier: GPL-2.0-or-later

import { describe, it, expect } from 'vitest'
import { MAX_SNAPSHOT_DEVICE_NAME_BYTES, buildSnapshotFilename, capSnapshotDeviceName, snapshotFilenameForDisplay } from '../snapshot-filename'
import { utf8ByteLength } from '../utils/utf8-truncate'

const ID = '0b9f6f1e-3c1a-4e0e-9d7a-2f1d5f6b8a90'

describe('buildSnapshotFilename', () => {
  it('puts the device name, the timestamp and the id in that order', () => {
    expect(buildSnapshotFilename('GPK60-63R', '2026-10-08T12-00-00.000Z', ID))
      .toBe(`GPK60-63R_2026-10-08T12-00-00.000Z_${ID}.pipette`)
  })
})

describe('snapshotFilenameForDisplay', () => {
  it('drops the id from a name that carries it', () => {
    expect(snapshotFilenameForDisplay(`GPK60-63R_2026-10-08T12-00-00.000Z_${ID}.pipette`, ID))
      .toBe('GPK60-63R_2026-10-08T12-00-00.000Z.pipette')
  })

  it('returns a name without the id as it is', () => {
    expect(snapshotFilenameForDisplay('GPK60-63R_2026-10-08T12-00-00.000Z.pipette', ID))
      .toBe('GPK60-63R_2026-10-08T12-00-00.000Z.pipette')
  })

  it('leaves a name ending in a different id alone', () => {
    const other = 'ffffffff-3c1a-4e0e-9d7a-2f1d5f6b8a90'
    const name = `KB_2026-10-08T12-00-00.000Z_${other}.pipette`
    expect(snapshotFilenameForDisplay(name, ID)).toBe(name)
  })

  it('returns the name as it is when the id is empty', () => {
    expect(snapshotFilenameForDisplay('KB_.pipette', '')).toBe('KB_.pipette')
  })
})

describe('capSnapshotDeviceName', () => {
  it('returns a name within the limit as it is', () => {
    expect(capSnapshotDeviceName('GPK60-63R')).toBe('GPK60-63R')
    expect(capSnapshotDeviceName('Foo_')).toBe('Foo_')
    const exact = 'a'.repeat(MAX_SNAPSHOT_DEVICE_NAME_BYTES)
    expect(capSnapshotDeviceName(exact)).toBe(exact)
  })

  it('cuts a long ASCII name to the limit', () => {
    expect(capSnapshotDeviceName('a'.repeat(500))).toBe('a'.repeat(MAX_SNAPSHOT_DEVICE_NAME_BYTES))
  })

  it.each([['日本語キーボード'], ['😀'], ['👨‍👩‍👧'], ['aé']])('cuts a long %s name between code points', (unit) => {
    const long = unit.repeat(100)
    const capped = capSnapshotDeviceName(long)
    expect(utf8ByteLength(capped)).toBeLessThanOrEqual(MAX_SNAPSHOT_DEVICE_NAME_BYTES)
    expect(utf8ByteLength(capped)).toBeGreaterThan(MAX_SNAPSHOT_DEVICE_NAME_BYTES - 4)
    expect(long.startsWith(capped)).toBe(true)
    expect(capped).not.toMatch(/[\uD800-\uDBFF]$/)
  })

  it('drops the `_` / `.` / spaces the cut leaves at the end', () => {
    expect(capSnapshotDeviceName(`${'a'.repeat(MAX_SNAPSHOT_DEVICE_NAME_BYTES - 3)}_. _bcd`)).toBe('a'.repeat(MAX_SNAPSHOT_DEVICE_NAME_BYTES - 3))
  })

  it('falls back to keyboard when the cut leaves nothing', () => {
    expect(capSnapshotDeviceName('_'.repeat(200))).toBe('keyboard')
  })

  it('buildSnapshotFilename caps the device name, keeping the whole name well under the 255-byte name limit', () => {
    const name = buildSnapshotFilename('鍵'.repeat(200), '2026-10-08T12-00-00.000Z', ID)
    expect(utf8ByteLength(name)).toBeLessThanOrEqual(200)
    expect(name.startsWith(`${capSnapshotDeviceName('鍵'.repeat(200))}_2026-10-08T12-00-00.000Z_`)).toBe(true)
  })
})
