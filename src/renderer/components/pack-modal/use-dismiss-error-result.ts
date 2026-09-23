// SPDX-License-Identifier: GPL-2.0-or-later
//
// Auto-dismiss for the per-row `lastResult` badges of the pack modals:
// while the result holds an error entry, drop the error entries after
// ERROR_DISMISS_MS (the same lifetime as the modal's error banner).
// Success entries stay until the next action replaces them.

import { useEffect, type Dispatch, type SetStateAction } from 'react'
import { ERROR_DISMISS_MS } from '../ui/DismissibleError'
import type { PackActionResult } from './pack-modal-types'

type LastResult = PackActionResult | PackActionResult[] | null

function hasError(result: LastResult): boolean {
  if (result === null) return false
  if (Array.isArray(result)) return result.some((r) => r.kind === 'error')
  return result.kind === 'error'
}

function stripErrors(result: LastResult): LastResult {
  if (result === null) return null
  if (!Array.isArray(result)) return result.kind === 'error' ? null : result
  const kept = result.filter((r) => r.kind !== 'error')
  return kept.length > 0 ? kept : null
}

export function useDismissErrorResult(
  lastResult: LastResult,
  setLastResult: Dispatch<SetStateAction<LastResult>>,
): void {
  // Keyed on identity: every action sets a fresh object, so a repeat of
  // the same message still restarts the timer.
  useEffect(() => {
    if (!hasError(lastResult)) return
    const scheduled = lastResult
    const timer = setTimeout(() => {
      // Only strip the result this timer was armed for; a newer result
      // set in the same tick keeps its own full lifetime.
      setLastResult((prev) => (prev === scheduled ? stripErrors(prev) : prev))
    }, ERROR_DISMISS_MS)
    return () => clearTimeout(timer)
  }, [lastResult, setLastResult])
}
