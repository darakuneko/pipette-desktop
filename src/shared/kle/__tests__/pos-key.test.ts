// SPDX-License-Identifier: GPL-2.0-or-later

import { describe, it, expect } from 'vitest'
import { posKey } from '../pos-key'

describe('posKey', () => {
  it('formats row,col with no whitespace', () => {
    expect(posKey(0, 0)).toBe('0,0')
    expect(posKey(3, 5)).toBe('3,5')
  })

  it('locks the persisted-data format', () => {
    // PipetteSettings.analyze.fingerAssignments and analytics IPC
    // payloads ship `"row,col"` on the wire / on disk. Hard-coded
    // expectations below lock the format so a future change can't
    // silently invalidate user data.
    expect(posKey(12, 7)).toBe('12,7')
    expect(posKey(99, 0)).toBe('99,0')
  })
})
