// SPDX-License-Identifier: GPL-2.0-or-later
// Replays one day file of another device into the cache while keeping that
// device's deleted ranges (deleted-ranges.ts) hidden. The ranges are read
// synchronously right before the transaction, and the rows and the ranges'
// tombstones are written in that one transaction, so a reader of the cache
// never sees an in-range row live, and a ranges file written while an
// earlier file was being read is already used. This device's own hash is
// never hidden this way: its owner removes the rows from its own files.

import { applyRowsToCache, type ApplyRowsResult } from './jsonl/apply-to-cache'
import type { JsonlRow } from './jsonl/jsonl-row'
import type { TypingAnalyticsDB } from './db/typing-analytics-db'
import { readDeletedRangesSync } from './deleted-ranges-store'
import { clipToUtcDay } from './deleted-ranges'
import type { UtcDay } from './jsonl/utc-day'

export function replayDayRowsHidingDeletedRanges(
  db: TypingAnalyticsDB,
  rows: readonly JsonlRow[],
  ref: { uid: string; machineHash: string; utcDay: UtcDay },
  userDataDir: string,
  ownHash: string,
): ApplyRowsResult {
  const entries = ref.machineHash === ownHash ? [] : clipToUtcDay(readDeletedRangesSync(userDataDir, ref.uid, ref.machineHash), ref.utcDay)
  if (entries.length === 0) return applyRowsToCache(db, rows)
  return db.getConnection().transaction(() => {
    const applied = applyRowsToCache(db, rows)
    db.tombstoneRowsForUidHashInRanges(ref.uid, ref.machineHash, entries, Date.now())
    return applied
  })()
}
