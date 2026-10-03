// SPDX-License-Identifier: GPL-2.0-or-later
// Whether to show the "update Pipette to keep syncing" banner: Drive holds
// a sync-format marker newer than this app's. The status lives in main
// (sync-format-status.ts), which pushes every change (a blocked sync,
// sign-in, sign-out); it is fetched once on mount for the value main had
// before this hook subscribed.

import { useCallback, useEffect, useState } from 'react'

export interface SyncUpdateBannerState {
  visible: boolean
  /** Hides the banner until the app restarts. */
  dismiss: () => void
}

/** Whether Drive needs a newer sync format than this app's, following
 *  main's pushed status; false while unknown. */
export function useSyncFormatUpdateRequired(): boolean {
  const [updateRequired, setUpdateRequired] = useState(false)

  useEffect(() => {
    // A push is newer than the initial fetch, so a fetch answering after
    // a push (or after unmount) is dropped.
    let fetchCurrent = true
    const unsubscribe = window.vialAPI.syncOnFormatStatusChanged((status) => {
      fetchCurrent = false
      setUpdateRequired(status?.updateRequired === true)
    })
    window.vialAPI.syncFormatStatus().then(
      (status) => {
        if (fetchCurrent) setUpdateRequired(status?.updateRequired === true)
      },
      () => {
        // Unknown status: treated as not required.
      },
    )
    return () => {
      fetchCurrent = false
      unsubscribe()
    }
  }, [])

  return updateRequired
}

export function useSyncFormatStatus(): SyncUpdateBannerState {
  const updateRequired = useSyncFormatUpdateRequired()
  const [dismissed, setDismissed] = useState(false)
  const dismiss = useCallback(() => setDismissed(true), [])

  return { visible: updateRequired && !dismissed, dismiss }
}
