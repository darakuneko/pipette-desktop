// SPDX-License-Identifier: GPL-2.0-or-later

import { describe, it, expect } from 'vitest'
import { SESSION_IDLE_GAP_MS, SessionDetector } from '../session-detector'

const UID_A = '0xAABB'
const UID_B = '0xCCDD'
const SCOPE_A = 'machineHash|linux|6.8|0xAABB|0xFEED|0x0000'
const SCOPE_B = 'machineHash|linux|6.8|0xCCDD|0x1234|0x0001'

describe('SessionDetector', () => {
  it('starts a fresh session on the first event for a scope', () => {
    const det = new SessionDetector()
    const finalized = det.recordEvent(UID_A, SCOPE_A, 1_000)
    expect(finalized).toEqual([])
    expect(det.hasActiveSession(SCOPE_A)).toBe(true)
  })

  it('extends the active session for events within the idle gap', () => {
    const det = new SessionDetector()
    det.recordEvent(UID_A, SCOPE_A, 1_000)
    expect(det.recordEvent(UID_A, SCOPE_A, 2_000)).toEqual([])
    expect(det.recordEvent(UID_A, SCOPE_A, 3_000)).toEqual([])
    const closed = det.closeAll()
    expect(closed).toHaveLength(1)
    expect(closed[0].record.keystrokeCount).toBe(3)
    expect(closed[0].record.start).toBe(new Date(1_000).toISOString())
    expect(closed[0].record.end).toBe(new Date(3_000).toISOString())
  })

  it('finalizes the previous session when an idle gap is detected', () => {
    const det = new SessionDetector()
    det.recordEvent(UID_A, SCOPE_A, 1_000)
    det.recordEvent(UID_A, SCOPE_A, 2_000)
    const after = det.recordEvent(UID_A, SCOPE_A, 2_000 + SESSION_IDLE_GAP_MS)

    expect(after).toHaveLength(1)
    expect(after[0].record.keystrokeCount).toBe(2)
    expect(after[0].record.start).toBe(new Date(1_000).toISOString())
    expect(after[0].record.end).toBe(new Date(2_000).toISOString())

    // A fresh session is now active for the same scope.
    expect(det.hasActiveSession(SCOPE_A)).toBe(true)
    const closed = det.closeAll()
    expect(closed[0].record.start).toBe(new Date(2_000 + SESSION_IDLE_GAP_MS).toISOString())
    expect(closed[0].record.keystrokeCount).toBe(1)
  })

  it('tracks separate sessions per scope', () => {
    const det = new SessionDetector()
    det.recordEvent(UID_A, SCOPE_A, 1_000)
    det.recordEvent(UID_B, SCOPE_B, 1_000)
    det.recordEvent(UID_A, SCOPE_A, 2_000)

    const closed = det.closeAll()
    expect(closed.map((f) => f.uid).sort()).toEqual([UID_A, UID_B])
    const aSession = closed.find((f) => f.uid === UID_A)!
    const bSession = closed.find((f) => f.uid === UID_B)!
    expect(aSession.record.keystrokeCount).toBe(2)
    expect(bSession.record.keystrokeCount).toBe(1)
  })

  it('closeForUid only finalizes sessions for that keyboard', () => {
    const det = new SessionDetector()
    det.recordEvent(UID_A, SCOPE_A, 1_000)
    det.recordEvent(UID_B, SCOPE_B, 1_000)

    const closed = det.closeForUid(UID_A)
    expect(closed).toHaveLength(1)
    expect(closed[0].uid).toBe(UID_A)
    expect(det.hasActiveSession(SCOPE_B)).toBe(true)
  })

  it('closeAll empties the detector and is idempotent', () => {
    const det = new SessionDetector()
    det.recordEvent(UID_A, SCOPE_A, 1_000)
    expect(det.closeAll()).toHaveLength(1)
    expect(det.closeAll()).toHaveLength(0)
    expect(det.hasActiveSession(SCOPE_A)).toBe(false)
  })

  it('respects a custom idle gap', () => {
    const det = new SessionDetector(100)
    det.recordEvent(UID_A, SCOPE_A, 1_000)
    expect(det.recordEvent(UID_A, SCOPE_A, 1_050)).toEqual([])
    const after = det.recordEvent(UID_A, SCOPE_A, 1_200)
    expect(after).toHaveLength(1)
    expect(after[0].record.keystrokeCount).toBe(2)
  })

  it('preserves a session record whose start and end span midnight', () => {
    const det = new SessionDetector()
    const start = Date.UTC(2026, 0, 1, 23, 59, 50) // 2026-01-01 23:59:50 UTC
    const end = Date.UTC(2026, 0, 2, 0, 4, 0) // 2026-01-02 00:04:00 UTC
    det.recordEvent(UID_A, SCOPE_A, start)
    det.recordEvent(UID_A, SCOPE_A, end)

    const [closed] = det.closeAll()
    // The record itself spans midnight; the consumer routes it to the
    // start-date file.
    expect(closed.record.start.startsWith('2026-01-01')).toBe(true)
    expect(closed.record.end.startsWith('2026-01-02')).toBe(true)
  })
})
