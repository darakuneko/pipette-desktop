// SPDX-License-Identifier: GPL-2.0-or-later
// Central mutable state for the typing-analytics service, consolidated into
// one exported object so every sibling module in this directory shares the
// same live bindings. A plain `export let x` cannot be reassigned from
// outside its declaring module (an imported binding is read-only, and the
// project's compiled CommonJS output doesn't give re-importers a live view
// of a reassigned local either) — `minuteBuffer` below is reassigned
// wholesale (see resetTypingAnalyticsForTests), so every other field is
// folded into the same object rather than mixing two different state-
// sharing conventions across the split. See
// .claude/plans/typing-analytics.md for the design rationale.

import type { TypingAnalyticsFingerprint } from '../../shared/types/typing-analytics'
import { MinuteBuffer } from './minute-buffer'
import { SessionDetector, type FinalizedSession } from './session-detector'
import type { TypingSyncState } from './sync-state'

export interface ResolvedScope {
  fingerprint: TypingAnalyticsFingerprint
  scopeKey: string
}

/** Injected sync-change notifier. Kept as a callback instead of a direct
 * import to avoid coupling the analytics service to sync-service at module
 * load time — the main-process bootstrap wires in the real implementation
 * via {@link setTypingAnalyticsSyncNotifier}. */
type SyncNotifier = (syncUnit: string) => void

/** Every module-scoped mutable binding the typing-analytics service needs,
 * shared across `typing-analytics-pipeline.ts`, `typing-analytics-queries.ts`,
 * `typing-analytics-retention.ts`, and the facade. `lastFlushUpdatedAt` has a
 * single writer — `doFlushPass` in `typing-analytics-pipeline.ts` — see that
 * function for the monotonicity invariant this field encodes. */
export const taState = {
  initialization: null as Promise<void> | null,
  ipcRegistered: false,
  syncNotifier: null as SyncNotifier | null,
  minuteBuffer: new MinuteBuffer(),
  sessionDetector: new SessionDetector(),
  scopeCache: new Map<string, ResolvedScope>(),
  pendingSessions: [] as FinalizedSession[],
  dirty: false,
  flushChain: Promise.resolve() as Promise<void>,
  inFlightFlushCount: 0,
  flushTimer: null as ReturnType<typeof setTimeout> | null,
  syncState: null as TypingSyncState | null,
  lastFlushUpdatedAt: 0,
}

export function setTypingAnalyticsSyncNotifier(notifier: SyncNotifier | null): void {
  taState.syncNotifier = notifier
}

export function getMinuteBufferForTests(): MinuteBuffer {
  return taState.minuteBuffer
}

export function resetTypingAnalyticsForTests(): void {
  taState.initialization = null
  taState.ipcRegistered = false
  // Not drainAll(): with retention, drainAll only finalizes dirty entries
  // and retains the rest, so it would leak clean entries from one test
  // case into the next case's identically-keyed scope/minute. Reassigning
  // the singleton (mirrors flushChain's reset below) starts every case
  // from a real empty buffer.
  taState.minuteBuffer = new MinuteBuffer()
  taState.sessionDetector.closeAll()
  taState.scopeCache.clear()
  taState.pendingSessions.length = 0
  taState.dirty = false
  taState.flushChain = Promise.resolve()
  taState.inFlightFlushCount = 0
  taState.lastFlushUpdatedAt = 0
  taState.syncNotifier = null
  taState.syncState = null
  if (taState.flushTimer) {
    clearTimeout(taState.flushTimer)
    taState.flushTimer = null
  }
}
