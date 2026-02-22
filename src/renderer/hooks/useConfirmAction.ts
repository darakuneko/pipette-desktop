// SPDX-License-Identifier: GPL-2.0-or-later

import { useState, useCallback } from 'react'

interface ConfirmAction {
  confirming: boolean
  trigger: () => void
  reset: () => void
}

/**
 * Two-click confirm pattern: first click arms confirmation, second executes.
 * Call `reset()` to disarm without executing (e.g. when switching entries).
 */
export function useConfirmAction(onConfirm: () => void): ConfirmAction {
  const [confirming, setConfirming] = useState(false)

  const trigger = useCallback(() => {
    if (!confirming) {
      setConfirming(true)
      return
    }
    setConfirming(false)
    onConfirm()
  }, [confirming, onConfirm])

  const reset = useCallback(() => {
    setConfirming(false)
  }, [])

  return { confirming, trigger, reset }
}
