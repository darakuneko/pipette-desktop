// SPDX-License-Identifier: GPL-2.0-or-later
//
// One favorite type's saved entries: read on demand through `refreshEntries`
// and re-read when a sync merge rewrote `favorites/{type}`.

import { useCallback, useState } from 'react'
import type { FavoriteType, SavedFavoriteMeta } from '../../shared/types/favorite-store'
import { useLatestRequest } from './use-latest-request'
import { useSyncUnitApplied } from './use-sync-unit-applied'

export interface UseFavoriteEntriesReturn {
  entries: SavedFavoriteMeta[]
  refreshEntries: () => Promise<void>
}

/** `enabled: false` ignores sync notifications; `refreshEntries` still works. */
export function useFavoriteEntries(favoriteType: FavoriteType, enabled = true): UseFavoriteEntriesReturn {
  const [entries, setEntries] = useState<SavedFavoriteMeta[]>([])
  const beginListRequest = useLatestRequest(favoriteType)

  const refreshEntries = useCallback(async () => {
    const isCurrent = beginListRequest()
    try {
      const result = await window.vialAPI.favoriteStoreList(favoriteType)
      if (isCurrent() && result.success && result.entries) {
        setEntries(result.entries)
      }
    } catch {
      // Silently ignore list errors
    }
  }, [favoriteType, beginListRequest])

  useSyncUnitApplied(
    (unit) => enabled && unit === `favorites/${favoriteType}`,
    () => { void refreshEntries() },
  )

  return { entries, refreshEntries }
}
