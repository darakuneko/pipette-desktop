// SPDX-License-Identifier: GPL-2.0-or-later
// Memoised wrapper around `buildSnapshotQmkByCode`, mirroring
// `use-keycode-finger-map.ts`'s shape: hides the null-snapshot
// fallback so Speed-ranking / bigram-pair label callers (KeyHeatmapChart,
// BigramsChart) don't repeat the same boilerplate. Returns an empty map
// when the snapshot is missing, so callers can branch on `size === 0`
// or simply pass the map straight through as an "always defined but
// possibly empty" optional prop.

import { useMemo } from 'react'
import { buildSnapshotQmkByCode } from './analyze-snapshot-codes'
import type { TypingKeymapSnapshot } from '../../../shared/types/typing-analytics'

export function useSnapshotQmkByCode(
  snapshot: TypingKeymapSnapshot | null,
): ReadonlyMap<number, string> {
  return useMemo(() => {
    if (!snapshot) return new Map<number, string>()
    return buildSnapshotQmkByCode(snapshot, snapshot.vialProtocol)
  }, [snapshot])
}
