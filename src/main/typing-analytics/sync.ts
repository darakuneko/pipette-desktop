// SPDX-License-Identifier: GPL-2.0-or-later
// Sync-unit identifiers for the typing-analytics JSONL masters.
//
// v6 shape:  keyboards/{uid}/devices/{machineHash}
//   (one unit per (uid, hash), bundles the flat `{hash}.jsonl`)
//
// v7 shape:  keyboards/{uid}/devices/{machineHash}/days/{YYYY-MM-DD}
//   (one unit per (uid, hash, day), bundles a single per-day file)
//
// Both forms are recognised during the transition so the mirror write
// keeps shipping v6 bundles while v7 per-day bundles flow alongside.
// See .claude/plans/typing-analytics.md.

import type { UtcDay } from './jsonl/utc-day'
import { isUtcDay } from './jsonl/utc-day'

/** v6 sync-unit path for the flat JSONL master belonging to one
 * `(uid, machineHash)` pair. Owning device uploads; other devices
 * download + apply read-only. Retained while the v6 mirror write and
 * flat sync-service merge paths are still in place. */
export function typingAnalyticsDeviceSyncUnit(
  uid: string,
  machineHash: string,
): `keyboards/${string}/devices/${string}` {
  return `keyboards/${uid}/devices/${machineHash}`
}

/** Returns `{uid, machineHash}` when `syncUnit` matches the v6 device
 * form, otherwise null. v7 per-day units are intentionally *not* matched
 * here — callers route those through
 * {@link parseTypingAnalyticsDeviceDaySyncUnit}. */
export function parseTypingAnalyticsDeviceSyncUnit(
  syncUnit: string,
): { uid: string; machineHash: string } | null {
  const parts = syncUnit.split('/')
  if (parts.length !== 4) return null
  if (parts[0] !== 'keyboards' || parts[2] !== 'devices') return null
  if (parts[1].length === 0 || parts[3].length === 0) return null
  return { uid: parts[1], machineHash: parts[3] }
}

/** v7 sync-unit path for a per-day JSONL master belonging to one
 * `(uid, machineHash, UTC day)` triple. */
export function typingAnalyticsDeviceDaySyncUnit(
  uid: string,
  machineHash: string,
  utcDay: UtcDay,
): `keyboards/${string}/devices/${string}/days/${string}` {
  return `keyboards/${uid}/devices/${machineHash}/days/${utcDay}`
}

/** Returns `{uid, machineHash, utcDay}` when `syncUnit` matches the v7
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
