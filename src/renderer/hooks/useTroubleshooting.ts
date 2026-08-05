// SPDX-License-Identifier: GPL-2.0-or-later
//
// Local > Application's Import/Export handlers. Used to also own a
// Reset Local Data multi-target picker (localTargets/selectedKeyboardUids/
// confirmingLocalReset/handleResetLocalTargets/storedKeyboards/isSyncing/
// syncDisabled) that DataModal never actually rendered — the real
// per-keyboard and remote reset affordances live in KeyboardSavesContent
// ("Delete All") and CloudDataContent respectively, and Local >
// Application's own reset is the single-target AppSettingsReset below.
// That dead half is pruned here.

import { useState, useCallback } from 'react'

export function useTroubleshooting() {
  const [busy, setBusy] = useState(false)
  const [importResult, setImportResult] = useState<'success' | 'error' | null>(null)

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
      setImportResult(result.success ? 'success' : 'error')
    } finally {
      setBusy(false)
    }
  }, [])

  return {
    busy,
    importResult,
    handleExport,
    handleImport,
  }
}
