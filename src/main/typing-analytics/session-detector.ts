// SPDX-License-Identifier: GPL-2.0-or-later
// Track in-flight typing sessions per scope and finalize them when the
// recording is paused, the user goes idle, or the app shuts down. A session
// = the span between record ON / first event and record OFF / idle gap /
// before-quit. The detector emits closed sessions; the caller is responsible
// for routing them to disk (sessions-file-store).

import type { TypingSessionRecord } from '../../shared/types/typing-analytics'

export const SESSION_IDLE_GAP_MS = 5 * 60 * 1000

interface ActiveSession {
  uid: string
  scopeKey: string
  startMs: number
  lastEventMs: number
  keystrokeCount: number
}

export interface FinalizedSession {
  uid: string
  record: TypingSessionRecord
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

    existing.lastEventMs = ts
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
    return { uid, scopeKey, startMs: ts, lastEventMs: ts, keystrokeCount: 1 }
  }

  private toFinalized(session: ActiveSession): FinalizedSession {
    return {
      uid: session.uid,
      record: {
        start: new Date(session.startMs).toISOString(),
        end: new Date(session.lastEventMs).toISOString(),
        keystrokeCount: session.keystrokeCount,
        scope: session.scopeKey,
      },
    }
  }
}
