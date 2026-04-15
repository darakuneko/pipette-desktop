// SPDX-License-Identifier: GPL-2.0-or-later

import { describe, it, expect, beforeEach } from 'vitest'
import { MinuteBuffer, MINUTE_MS } from '../minute-buffer'
import type {
  TypingAnalyticsEvent,
  TypingAnalyticsFingerprint,
} from '../../../shared/types/typing-analytics'
import { canonicalScopeKey } from '../../../shared/types/typing-analytics'

function fingerprint(overrides: Partial<TypingAnalyticsFingerprint['keyboard']> = {}): TypingAnalyticsFingerprint {
  return {
    machineHash: 'hash-abc',
    os: { platform: 'linux', release: '6.8.0', arch: 'x64' },
    keyboard: {
      uid: '0xAABB',
      vendorId: 0xFEED,
      productId: 0x0000,
      productName: 'Pipette',
      ...overrides,
    },
  }
}

function charEvent(key: string, ts: number): TypingAnalyticsEvent {
  return { kind: 'char', key, ts, keyboard: { uid: 'x', vendorId: 0, productId: 0, productName: '' } }
}

function matrixEvent(row: number, col: number, layer: number, keycode: number, ts: number): TypingAnalyticsEvent {
  return {
    kind: 'matrix',
    row,
    col,
    layer,
    keycode,
    ts,
    keyboard: { uid: 'x', vendorId: 0, productId: 0, productName: '' },
  }
}

describe('MinuteBuffer', () => {
  let buffer: MinuteBuffer

  beforeEach(() => {
    buffer = new MinuteBuffer()
  })

  it('starts empty', () => {
    expect(buffer.isEmpty()).toBe(true)
    expect(buffer.drainAll()).toEqual([])
  })

  it('groups events into minute buckets', () => {
    const fp = fingerprint()
    buffer.addEvent(charEvent('a', 1_000), fp)
    buffer.addEvent(charEvent('b', 30_000), fp)
    buffer.addEvent(charEvent('a', MINUTE_MS + 5_000), fp)

    const snapshots = buffer.drainAll().sort((a, b) => a.minuteTs - b.minuteTs)
    expect(snapshots).toHaveLength(2)
    expect(snapshots[0].minuteTs).toBe(0)
    expect(snapshots[0].keystrokes).toBe(2)
    expect(snapshots[0].charCounts.get('a')).toBe(1)
    expect(snapshots[0].charCounts.get('b')).toBe(1)
    expect(snapshots[1].minuteTs).toBe(MINUTE_MS)
    expect(snapshots[1].keystrokes).toBe(1)
  })

  it('accumulates char counts within the same minute', () => {
    const fp = fingerprint()
    buffer.addEvent(charEvent('a', 1_000), fp)
    buffer.addEvent(charEvent('a', 2_000), fp)
    buffer.addEvent(charEvent('b', 3_000), fp)

    const [snap] = buffer.drainAll()
    expect(snap.charCounts.get('a')).toBe(2)
    expect(snap.charCounts.get('b')).toBe(1)
  })

  it('accumulates matrix counts keyed by position, keeps the latest keycode', () => {
    const fp = fingerprint()
    buffer.addEvent(matrixEvent(0, 3, 0, 0x04, 1_000), fp)
    buffer.addEvent(matrixEvent(0, 3, 0, 0x04, 2_000), fp)
    buffer.addEvent(matrixEvent(2, 1, 1, 0x4015, 3_000), fp)

    const [snap] = buffer.drainAll()
    expect(snap.matrixCounts.get('0,3,0')).toEqual({ row: 0, col: 3, layer: 0, keycode: 0x04, count: 2 })
    expect(snap.matrixCounts.get('2,1,1')).toEqual({ row: 2, col: 1, layer: 1, keycode: 0x4015, count: 1 })
  })

  it('computes interval stats from event timing', () => {
    const fp = fingerprint()
    // 5 events with intervals [100, 200, 300, 400]
    buffer.addEvent(charEvent('a', 1_000), fp)
    buffer.addEvent(charEvent('a', 1_100), fp)
    buffer.addEvent(charEvent('a', 1_300), fp)
    buffer.addEvent(charEvent('a', 1_600), fp)
    buffer.addEvent(charEvent('a', 2_000), fp)

    const [snap] = buffer.drainAll()
    expect(snap.keystrokes).toBe(5)
    expect(snap.intervalMinMs).toBe(100)
    expect(snap.intervalMaxMs).toBe(400)
    expect(snap.intervalAvgMs).toBe(250)
    // sorted intervals: [100, 200, 300, 400]
    // p25 at index floor(3*0.25)=0 → 100
    // p50 at index floor(3*0.5)=1 → 200
    // p75 at index floor(3*0.75)=2 → 300
    expect(snap.intervalP25Ms).toBe(100)
    expect(snap.intervalP50Ms).toBe(200)
    expect(snap.intervalP75Ms).toBe(300)
    expect(snap.activeMs).toBe(1_000)
  })

  it('keeps separate buckets per scope within the same minute', () => {
    const fp1 = fingerprint({ uid: '0xAAAA' })
    const fp2 = fingerprint({ uid: '0xBBBB' })
    buffer.addEvent(charEvent('a', 1_000), fp1)
    buffer.addEvent(charEvent('a', 2_000), fp2)

    const snapshots = buffer.drainAll()
    expect(snapshots).toHaveLength(2)
    const scope1Id = canonicalScopeKey(fp1)
    const scope2Id = canonicalScopeKey(fp2)
    expect(new Set(snapshots.map((s) => s.scopeId))).toEqual(new Set([scope1Id, scope2Id]))
  })

  it('drainClosed only returns entries strictly older than the boundary', () => {
    const fp = fingerprint()
    buffer.addEvent(charEvent('a', 1_000), fp)                // minute 0
    buffer.addEvent(charEvent('a', MINUTE_MS + 1_000), fp)    // minute 1
    buffer.addEvent(charEvent('a', 2 * MINUTE_MS + 1_000), fp) // minute 2

    const closed = buffer.drainClosed(2 * MINUTE_MS)
    expect(closed.map((s) => s.minuteTs).sort((a, b) => a - b)).toEqual([0, MINUTE_MS])
    // Minute 2 is still live.
    expect(buffer.isEmpty()).toBe(false)

    const remaining = buffer.drainAll()
    expect(remaining).toHaveLength(1)
    expect(remaining[0].minuteTs).toBe(2 * MINUTE_MS)
  })

  it('keeps activeMs monotonic when a late event arrives with an earlier ts', () => {
    const fp = fingerprint()
    buffer.addEvent(charEvent('a', 1_000), fp)
    buffer.addEvent(charEvent('a', 1_200), fp)
    // Out-of-order event: still counted, but lastEventMs must not walk back.
    buffer.addEvent(charEvent('a', 1_100), fp)

    const [snap] = buffer.drainAll()
    expect(snap.keystrokes).toBe(3)
    expect(snap.activeMs).toBe(200)
  })

  it('extends firstEventMs backwards for a late event earlier than the first seen', () => {
    const fp = fingerprint()
    buffer.addEvent(charEvent('a', 1_500), fp)
    buffer.addEvent(charEvent('a', 2_000), fp)
    // Earlier than the first seen event — still within minute 0 since
    // MINUTE_MS = 60_000, so it rebuckets into the same entry.
    buffer.addEvent(charEvent('a', 500), fp)

    const [snap] = buffer.drainAll()
    expect(snap.keystrokes).toBe(3)
    // Outer window is 500 → 2000, so activeMs = 1_500.
    expect(snap.activeMs).toBe(1_500)
  })

  it('handles a single-event minute with null percentile stats', () => {
    const fp = fingerprint()
    buffer.addEvent(charEvent('a', 1_000), fp)

    const [snap] = buffer.drainAll()
    expect(snap.keystrokes).toBe(1)
    expect(snap.activeMs).toBe(0)
    expect(snap.intervalAvgMs).toBeNull()
    expect(snap.intervalMinMs).toBeNull()
    expect(snap.intervalP50Ms).toBeNull()
    expect(snap.intervalMaxMs).toBeNull()
  })
})
