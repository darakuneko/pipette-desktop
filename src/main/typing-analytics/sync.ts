// SPDX-License-Identifier: GPL-2.0-or-later
// Sync-unit identifiers for the typing-analytics JSONL masters. One unit
// per (keyboard uid, machineHash), so the sync-service bundles each
// device's append-only JSONL file as a single atomic upload/download
// target. See .claude/plans/typing-analytics.md.

/** Canonical sync-unit path for the JSONL master belonging to one
 * `(uid, machineHash)` pair. Owning device uploads; other devices
 * download + apply read-only. */
export function typingAnalyticsDeviceSyncUnit(
  uid: string,
  machineHash: string,
): `keyboards/${string}/devices/${string}` {
  return `keyboards/${uid}/devices/${machineHash}`
}

/** Returns `{uid, machineHash}` when `syncUnit` matches the device form,
 * otherwise null. Pairs with {@link typingAnalyticsDeviceSyncUnit} so
 * call sites never hand-roll the 4-part split check. */
export function parseTypingAnalyticsDeviceSyncUnit(
  syncUnit: string,
): { uid: string; machineHash: string } | null {
  const parts = syncUnit.split('/')
  if (parts.length !== 4) return null
  if (parts[0] !== 'keyboards' || parts[2] !== 'devices') return null
  if (parts[1].length === 0 || parts[3].length === 0) return null
  return { uid: parts[1], machineHash: parts[3] }
}
