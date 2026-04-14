// SPDX-License-Identifier: GPL-2.0-or-later
// In-memory scope-map aggregator: accumulates TypingAnalyticsEvents into a
// per-scope bucket so the service can flush a single merged payload to disk.
// See .claude/plans/typing-analytics.md.

import type {
  MatrixKeyStat,
  TypingAnalyticsEvent,
  TypingAnalyticsFingerprint,
  TypingScopeEntry,
} from '../../shared/types/typing-analytics'
import { canonicalScopeKey } from '../../shared/types/typing-analytics'

export class TypingAnalyticsAggregator {
  private readonly scopes = new Map<string, TypingScopeEntry>()

  addEvent(event: TypingAnalyticsEvent, fingerprint: TypingAnalyticsFingerprint): void {
    const key = canonicalScopeKey(fingerprint)
    const entry = this.scopes.get(key) ?? {
      scope: fingerprint,
      charCounts: {},
      matrixCounts: {},
    }

    if (event.kind === 'char') {
      entry.charCounts[event.key] = (entry.charCounts[event.key] ?? 0) + 1
    } else {
      const matrixKey = `${event.row},${event.col},${event.layer}`
      const existing: MatrixKeyStat | undefined = entry.matrixCounts[matrixKey]
      entry.matrixCounts[matrixKey] = {
        count: (existing?.count ?? 0) + 1,
        keycode: event.keycode,
      }
    }

    this.scopes.set(key, entry)
  }

  getScopes(): ReadonlyMap<string, TypingScopeEntry> {
    return this.scopes
  }

  isEmpty(): boolean {
    return this.scopes.size === 0
  }

  clear(): void {
    this.scopes.clear()
  }
}
