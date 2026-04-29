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
    expect(closed[0].keystrokeCount).toBe(3)
    expect(closed[0].startMs).toBe(1_000)
    expect(closed[0].endMs).toBe(3_000)
    expect(closed[0].id).toMatch(/^[0-9a-f-]{36}$/)
  })

  it('finalizes the previous session when an idle gap is detected', () => {
    const det = new SessionDetector()
    det.recordEvent(UID_A, SCOPE_A, 1_000)
    det.recordEvent(UID_A, SCOPE_A, 2_000)
    const after = det.recordEvent(UID_A, SCOPE_A, 2_000 + SESSION_IDLE_GAP_MS)

    expect(after).toHaveLength(1)
    expect(after[0].keystrokeCount).toBe(2)
    expect(after[0].startMs).toBe(1_000)
    expect(after[0].endMs).toBe(2_000)

    // A fresh session is now active for the same scope with a new id.
    expect(det.hasActiveSession(SCOPE_A)).toBe(true)
    const closed = det.closeAll()
    expect(closed[0].startMs).toBe(2_000 + SESSION_IDLE_GAP_MS)
    expect(closed[0].keystrokeCount).toBe(1)
    expect(closed[0].id).not.toBe(after[0].id)
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
    expect(aSession.keystrokeCount).toBe(2)
    expect(bSession.keystrokeCount).toBe(1)
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
    expect(after[0].keystrokeCount).toBe(2)
  })

  it('does not rewind lastEventMs when a late out-of-order event arrives', () => {
    const det = new SessionDetector()
    det.recordEvent(UID_A, SCOPE_A, 1_000)
    det.recordEvent(UID_A, SCOPE_A, 2_000 + SESSION_IDLE_GAP_MS) // finalizes #1, starts #2
    // Late event from before the split: must not rewind session #2 such
    // that a subsequent on-time event would trip a false idle-gap split.
    det.recordEvent(UID_A, SCOPE_A, 1_500)
    const further = det.recordEvent(UID_A, SCOPE_A, 2_000 + SESSION_IDLE_GAP_MS + 1_000)
    expect(further).toEqual([])

    const [closed] = det.closeAll()
    expect(closed.startMs).toBeLessThanOrEqual(closed.endMs)
    // startMs was extended backwards by the late event so the finalized
    // record reflects the true outer window.
    expect(closed.startMs).toBe(1_500)
    expect(closed.endMs).toBe(2_000 + SESSION_IDLE_GAP_MS + 1_000)
    expect(closed.keystrokeCount).toBe(3)
  })

  it('preserves a session record whose start and end span midnight', () => {
    const det = new SessionDetector()
    const start = Date.UTC(2026, 0, 1, 23, 59, 50) // 2026-01-01 23:59:50 UTC
    const end = Date.UTC(2026, 0, 2, 0, 4, 0) // 2026-01-02 00:04:00 UTC
    det.recordEvent(UID_A, SCOPE_A, start)
    det.recordEvent(UID_A, SCOPE_A, end)

    const [closed] = det.closeAll()
    // The record itself spans midnight; the consumer is free to route it by
    // start date or raw ms.
    expect(closed.startMs).toBe(start)
    expect(closed.endMs).toBe(end)
  })
})
