// SPDX-License-Identifier: GPL-2.0-or-later
// Sync-unit identifiers for the typing-analytics JSONL masters.
//
// Shape: keyboards/{uid}/devices/{machineHash}/days/{YYYY-MM-DD}
//   (one unit per (uid, hash, day), bundles a single per-day file)
//
// See .claude/plans/typing-analytics.md.

import type { UtcDay } from './jsonl/utc-day'
import { isUtcDay } from './jsonl/utc-day'

/** Sync-unit path for a per-day JSONL master belonging to one
 * `(uid, machineHash, UTC day)` triple. */
export function typingAnalyticsDeviceDaySyncUnit(
  uid: string,
  machineHash: string,
  utcDay: UtcDay,
): `keyboards/${string}/devices/${string}/days/${string}` {
  return `keyboards/${uid}/devices/${machineHash}/days/${utcDay}`
}

/** Returns `{uid, machineHash, utcDay}` when `syncUnit` matches the
 * per-day form, otherwise null. The day segment is validated against
 * `isUtcDay` so malformed inputs don't produce phantom bundles. */
export function parseTypingAnalyticsDeviceDaySyncUnit(
  syncUnit: string,
): { uid: string; machineHash: string; utcDay: UtcDay } | null {
  const parts = syncUnit.split('/')
  if (parts.length !== 6) return null
  if (parts[0] !== 'keyboards' || parts[2] !== 'devices' || parts[4] !== 'days') return null
  if (parts[1].length === 0 || parts[3].length === 0) return null
  if (!isUtcDay(parts[5])) return null
  return { uid: parts[1], machineHash: parts[3], utcDay: parts[5] }
}
