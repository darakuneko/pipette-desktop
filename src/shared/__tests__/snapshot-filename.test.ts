// SPDX-License-Identifier: GPL-2.0-or-later

import { describe, it, expect } from 'vitest'
import { buildSnapshotFilename, snapshotFilenameForDisplay } from '../snapshot-filename'

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
