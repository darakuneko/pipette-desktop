// SPDX-License-Identifier: GPL-2.0-or-later
// Track in-flight typing sessions per scope and finalize them when the
// recording is paused, the user goes idle, or the app shuts down. A session
// = the span between record ON / first event and record OFF / idle gap /
// before-quit. The detector emits closed sessions; the caller is responsible
// for routing them to the SQLite store.

import { randomUUID } from 'node:crypto'

export const SESSION_IDLE_GAP_MS = 5 * 60 * 1000

interface ActiveSession {
  id: string
  uid: string
  scopeKey: string
  startMs: number
  lastEventMs: number
  keystrokeCount: number
}

export interface FinalizedSession {
  id: string
  uid: string
  scopeKey: string
  startMs: number
  endMs: number
  keystrokeCount: number
}

export class SessionDetector {
  private readonly sessions = new Map<string, ActiveSession>()

  constructor(private readonly idleGapMs: number = SESSION_IDLE_GAP_MS) {}

  /**
   * Record one event timestamp for a scope. Returns any sessions that were
   * closed by this event (idle gap → previous session finalized + new session
   * started). The just-started session is not returned.
   */
  recordEvent(uid: string, scopeKey: string, ts: number): FinalizedSession[] {
    const existing = this.sessions.get(scopeKey)

    if (!existing) {
      this.sessions.set(scopeKey, this.startNew(uid, scopeKey, ts))
      return []
    }

    const gap = ts - existing.lastEventMs
    if (gap >= this.idleGapMs) {
      const finalized = this.toFinalized(existing)
      this.sessions.set(scopeKey, this.startNew(uid, scopeKey, ts))
      return [finalized]
    }

    // A late-arriving event (ts < lastEventMs) counts as a keystroke but
    // does not rewind the session end, which would otherwise inflate the
    // next gap and falsely trip the idle-gap split. Its ts still extends
    // startMs backwards so the finalized span reflects the true outer
    // window of the session.
    if (ts > existing.lastEventMs) existing.lastEventMs = ts
    if (ts < existing.startMs) existing.startMs = ts
    existing.keystrokeCount += 1
    return []
  }

  /** Close every active session and return the finalized records. */
  closeAll(): FinalizedSession[] {
    const finalized: FinalizedSession[] = []
    for (const session of this.sessions.values()) {
      finalized.push(this.toFinalized(session))
    }
    this.sessions.clear()
    return finalized
  }

  /** Close any sessions belonging to a specific keyboard. */
  closeForUid(uid: string): FinalizedSession[] {
    const finalized: FinalizedSession[] = []
    for (const [key, session] of this.sessions) {
      if (session.uid !== uid) continue
      finalized.push(this.toFinalized(session))
      this.sessions.delete(key)
    }
    return finalized
  }

  hasActiveSession(scopeKey: string): boolean {
    return this.sessions.has(scopeKey)
  }

  hasAnyActiveSession(): boolean {
    return this.sessions.size > 0
  }

  private startNew(uid: string, scopeKey: string, ts: number): ActiveSession {
    return {
      id: randomUUID(),
      uid,
      scopeKey,
      startMs: ts,
      lastEventMs: ts,
      keystrokeCount: 1,
    }
  }

  private toFinalized(session: ActiveSession): FinalizedSession {
    return {
      id: session.id,
      uid: session.uid,
      scopeKey: session.scopeKey,
      startMs: session.startMs,
      endMs: session.lastEventMs,
      keystrokeCount: session.keystrokeCount,
    }
  }
}
