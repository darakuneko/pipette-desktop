// SPDX-License-Identifier: GPL-2.0-or-later

import { describe, it, expect } from 'vitest'
import {
  parseTypingAnalyticsDeviceDaySyncUnit,
  parseTypingDeletedRangesSyncUnit,
  typingDeletedRangesSyncUnit,
} from '../sync'

describe('typingDeletedRangesSyncUnit', () => {
  it('names the deleted-ranges unit of one (uid, machineHash)', () => {
    expect(typingDeletedRangesSyncUnit('0xAABB', 'hash-a')).toBe('keyboards/0xAABB/devices/hash-a/deleted-ranges')
  })
})

describe('parseTypingDeletedRangesSyncUnit', () => {
  it('round-trips the unit name', () => {
    expect(parseTypingDeletedRangesSyncUnit(typingDeletedRangesSyncUnit('0xAABB', 'hash-a')))
      .toEqual({ uid: '0xAABB', machineHash: 'hash-a' })
  })

  it('rejects other shapes', () => {
    expect(parseTypingDeletedRangesSyncUnit('keyboards/0xAABB/devices/hash-a/days/2026-04-19')).toBeNull()
    expect(parseTypingDeletedRangesSyncUnit('keyboards/0xAABB/devices/hash-a')).toBeNull()
    expect(parseTypingDeletedRangesSyncUnit('keyboards//devices/hash-a/deleted-ranges')).toBeNull()
    expect(parseTypingDeletedRangesSyncUnit('keyboards/0xAABB/devices//deleted-ranges')).toBeNull()
    expect(parseTypingDeletedRangesSyncUnit('keyboards/0xAABB/settings')).toBeNull()
    expect(parseTypingDeletedRangesSyncUnit('keyboards/0xAABB/devices/hash-a/deleted-ranges/x')).toBeNull()
  })

  it('is not a per-day unit', () => {
    expect(parseTypingAnalyticsDeviceDaySyncUnit('keyboards/0xAABB/devices/hash-a/deleted-ranges')).toBeNull()
  })
})
