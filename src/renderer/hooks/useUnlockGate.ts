// SPDX-License-Identifier: GPL-2.0-or-later

import { useRef, useEffect, useCallback } from 'react'
import { isResetKeycode } from '../../shared/keycodes/keycodes'

interface UnlockGateOptions {
  unlocked?: boolean
  onUnlock?: () => void
}

interface UnlockGate {
  /**
   * Execute `action` immediately if no code requires unlock, or if
   * already unlocked.  Otherwise store it as a pending action and
   * trigger the unlock flow.
   *
   * @param codes - raw keycodes to check for QK_BOOT
   * @param action - async callback to run (now or after unlock)
   */
  guard: (codes: number[], action: () => Promise<void>) => Promise<void>

  /**
   * Always require unlock before executing `action`, regardless of
   * keycodes.  Used for operations like macro saves that the Vial
   * protocol unconditionally gates behind unlock.
   */
  guardAll: (action: () => Promise<void>) => Promise<void>

  /**
   * Clear any pending action. Useful when the caller starts a new
   * operation that should supersede the previous pending one.
   */
  clearPending: () => void
}

/**
 * Shared hook that gates an async action behind the keyboard unlock flow
 * when any of the provided keycodes is QK_BOOT.
 *
 * When a guarded action is blocked because the keyboard is locked, the
 * action is stored in a ref. Once `unlocked` becomes `true`, the stored
 * action fires automatically.
 *
 * `unlocked` uses strict equality (`=== false`) so that `undefined`
 * (props not provided) is treated as unlocked for backwards compatibility.
 */
export function useUnlockGate({ unlocked, onUnlock }: UnlockGateOptions): UnlockGate {
  const pendingRef = useRef<(() => Promise<void>) | null>(null)

  useEffect(() => {
    if (unlocked && pendingRef.current) {
      const action = pendingRef.current
      pendingRef.current = null
      void action().catch(() => {})
    }
  }, [unlocked])

  const clearPending = useCallback(() => {
    pendingRef.current = null
  }, [])

  const deferOrRun = useCallback(
    async (needsUnlock: boolean, action: () => Promise<void>) => {
      if (needsUnlock && unlocked === false) {
        pendingRef.current = action
        onUnlock?.()
        return
      }
      await action()
    },
    [unlocked, onUnlock],
  )

  const guard = useCallback(
    async (codes: number[], action: () => Promise<void>) => {
      await deferOrRun(codes.some(isResetKeycode), action)
    },
    [deferOrRun],
  )

  const guardAll = useCallback(
    async (action: () => Promise<void>) => {
      await deferOrRun(true, action)
    },
    [deferOrRun],
  )

  return { guard, guardAll, clearPending }
}
