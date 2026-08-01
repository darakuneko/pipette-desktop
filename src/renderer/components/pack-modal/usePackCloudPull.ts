// SPDX-License-Identifier: GPL-2.0-or-later
//
// Shared "Pull from Cloud" handler for Language Packs / Theme Packs:
// an explicit 'packs'-scoped download (i18n + theme packs only),
// covering the fresh-machine discovery gap the 3-minute poll cannot
// close on its own — see matchesScope's doc in sync-service.ts. Each
// pack store's own change-broadcast listener refreshes its `metas`
// automatically once the merge lands, so this hook does not need to
// trigger a manual refresh itself. Not gated on Cloud Sync being
// configured — the button always renders (neither modal has cheap
// access to authenticated/hasPassword without mounting a second
// `useSync()` instance, which duplicates its network checks and
// listeners) — a missing/invalid sync setup, a busy race with another
// in-flight sync, or a partial pull all surface as a localized error
// via `result.status`/`result.skipReason` below instead of `syncExecute`
// resolving with `success: true` (see `SyncOperationResult`'s doc:
// `success` alone cannot distinguish "actually ran" from "silently did
// nothing").

import { useCallback, useState } from 'react'
import type { TFunction } from 'i18next'

export interface UsePackCloudPullResult {
  pulling: boolean
  pull: () => Promise<void>
}

/** @param fallbackErrorKey i18n key used when `syncExecute` throws
 *  outright (no `SyncOperationResult` to read a reason from) — each
 *  modal passes its own feature-specific generic error copy
 *  (`i18n.errorGeneric` / `themePacks.parseError`). */
export function usePackCloudPull(
  setActionError: (error: string | null) => void,
  t: TFunction,
  fallbackErrorKey: string,
): UsePackCloudPullResult {
  const [pulling, setPulling] = useState(false)

  const pull = useCallback(async (): Promise<void> => {
    setPulling(true)
    setActionError(null)
    try {
      const result = await window.vialAPI.syncExecute('download', 'packs')
      if (result.status === 'skipped') {
        setActionError(t(`sync.pullError.${result.skipReason ?? 'busy'}`))
      } else if (result.status === 'partial') {
        setActionError(t('sync.pullError.partial'))
      } else if (!result.success) {
        // Defensive fallback — SYNC_EXECUTE always sets `status` on a
        // non-throwing result, so this only covers an unexpected shape.
        setActionError(result.error ?? t(fallbackErrorKey))
      }
    } catch (err) {
      setActionError(err instanceof Error ? err.message : t(fallbackErrorKey))
    } finally {
      setPulling(false)
    }
  }, [setActionError, t, fallbackErrorKey])

  return { pulling, pull }
}
