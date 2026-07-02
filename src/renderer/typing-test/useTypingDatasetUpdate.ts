// SPDX-License-Identifier: GPL-2.0-or-later
//
// Shared "dataset update available" check/apply flow for a Typing Test
// provider (monkeytype / tatoeba / aozora). The main process caches the
// version check for the app session, so mounting this once per tab-open
// (or switching tabs) won't re-hit the Hub. Extracted so every dataset
// tab (LanguagePackTab, AozoraCatalogTab) shares one implementation
// instead of re-deriving the same two IPC calls.

import { useState, useEffect, useCallback } from 'react'

export interface UseTypingDatasetUpdateReturn {
  updateAvailable: boolean
  updating: boolean
  /** Apply the update. Resolves to whether it actually changed anything —
   *  `false` means the Hub was unreachable or returned an invalid payload,
   *  in which case the caller should keep showing the banner for a retry. */
  applyUpdate: () => Promise<boolean>
}

export function useTypingDatasetUpdate(provider: string): UseTypingDatasetUpdateReturn {
  const [updateAvailable, setUpdateAvailable] = useState(false)
  const [updating, setUpdating] = useState(false)

  useEffect(() => {
    let alive = true
    window.vialAPI.checkTypingDatasetUpdate(provider)
      .then((r) => { if (alive) setUpdateAvailable(r.updateAvailable) })
      .catch(() => {})
    return () => { alive = false }
  }, [provider])

  const applyUpdate = useCallback(async (): Promise<boolean> => {
    setUpdating(true)
    try {
      const result = await window.vialAPI.updateTypingDataset(provider)
      if (result.changed) setUpdateAvailable(false)
      return result.changed
    } finally {
      setUpdating(false)
    }
  }, [provider])

  return { updateAvailable, updating, applyUpdate }
}
