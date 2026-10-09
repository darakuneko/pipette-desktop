// SPDX-License-Identifier: GPL-2.0-or-later
// Sync-unit identifiers for the typing-analytics JSONL masters.
//
// Shapes:
//   keyboards/{uid}/devices/{machineHash}/days/{YYYY-MM-DD}
//     (one unit per (uid, hash, day), bundles a single per-day file)
//   keyboards/{uid}/devices/{machineHash}/deleted-ranges
//     (one unit per (uid, hash): the time ranges other devices deleted
//     from that device's typing data)
//
// Per-day units (not per-device) keep sync granular: a remote device's
// typing history is fetched and merged one day-file at a time instead
// of as a single, ever-growing blob.

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

/** Last segment of the deleted-ranges unit name. */
const TYPING_DELETED_RANGES_SEGMENT = 'deleted-ranges'

/** Sync-unit path for the deleted-ranges file of one `(uid, machineHash)`. */
export function typingDeletedRangesSyncUnit(
  uid: string,
  machineHash: string,
): `keyboards/${string}/devices/${string}/deleted-ranges` {
  return `keyboards/${uid}/devices/${machineHash}/${TYPING_DELETED_RANGES_SEGMENT}`
}

/** Returns `{uid, machineHash}` when `syncUnit` is a deleted-ranges unit,
 * otherwise null. */
export function parseTypingDeletedRangesSyncUnit(
  syncUnit: string,
): { uid: string; machineHash: string } | null {
  const parts = syncUnit.split('/')
  if (parts.length !== 5) return null
  if (parts[0] !== 'keyboards' || parts[2] !== 'devices' || parts[4] !== TYPING_DELETED_RANGES_SEGMENT) return null
  if (parts[1].length === 0 || parts[3].length === 0) return null
  return { uid: parts[1], machineHash: parts[3] }
}
