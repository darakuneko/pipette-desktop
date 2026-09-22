// SPDX-License-Identifier: GPL-2.0-or-later
//
// Local > Application's Import/Export handlers.

import { useState, useCallback } from 'react'

/** A single union state, since 'success' and 'error' only ever change
 *  together — an error message is only meaningful alongside the 'error'
 *  status, never left over once the outcome switches to 'success'. */
type ImportOutcome = { status: 'success' } | { status: 'error'; message: string }

export function useTroubleshooting() {
  const [busy, setBusy] = useState(false)
  const [importOutcome, setImportOutcome] = useState<ImportOutcome | null>(null)

  const handleExport = useCallback(async () => {
    setBusy(true)
    try {
      await window.vialAPI.exportLocalData()
    } finally {
      setBusy(false)
    }
  }, [])

  const handleImport = useCallback(async () => {
    setBusy(true)
    try {
      const result = await window.vialAPI.importLocalData()
      if (result.success) {
        // A cancelled file picker isn't an outcome — leave whatever outcome
        // (success/error) is already displayed from a previous import alone.
        if (result.cancelled) return
        setImportOutcome({ status: 'success' })
      } else {
        setImportOutcome({ status: 'error', message: result.error })
      }
    } finally {
      setBusy(false)
    }
  }, [])

  return {
    busy,
    importOutcome,
    handleExport,
    handleImport,
  }
}
