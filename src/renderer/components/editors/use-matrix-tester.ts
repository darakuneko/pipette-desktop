// SPDX-License-Identifier: GPL-2.0-or-later

import { useState, useCallback, useEffect, useRef } from 'react'
import { parseMatrixState, POLL_INTERVAL } from './matrix-utils'

export interface UseMatrixTesterOptions {
  rows?: number
  cols?: number
  getMatrixState?: () => Promise<number[]>
  unlocked?: boolean
  onUnlock?: (options?: { macroWarning?: boolean }) => void
  onMatrixModeChange?: (matrixMode: boolean, hasMatrixTester: boolean) => void
}

export interface UseMatrixTesterReturn {
  matrixMode: boolean
  pressedKeys: Set<string>
  everPressedKeys: Set<string>
  hasMatrixTester: boolean
  handleMatrixToggle: () => void
  /** Enters matrix mode directly, skipping the unlock gate — used by
   *  useInputModes's beginTypingTest, which has already resolved unlock
   *  itself before calling in (a typing test also drives the key matrix
   *  as its input source). */
  enterMatrixMode: () => void
  /** Clears matrix state and exits matrix mode — also reused by the
   *  typing-test lifecycle (host) when leaving the test view or when the
   *  keyboard locks. */
  resetMatrixState: () => void
}

/** Owns the key matrix tester: polling raw matrix state off the device,
 *  tracking pressed/ever-pressed keys, and the unlock-gated enter/exit
 *  flow. Also used as the typing test's input source, so `enterMatrixMode`
 *  / `resetMatrixState` are exposed for the host to drive directly. */
export function useMatrixTester({
  rows,
  cols,
  getMatrixState,
  unlocked,
  onUnlock,
  onMatrixModeChange,
}: UseMatrixTesterOptions): UseMatrixTesterReturn {
  const [matrixMode, setMatrixMode] = useState(false)
  const [pressedKeys, setPressedKeys] = useState<Set<string>>(new Set())
  const [everPressedKeys, setEverPressedKeys] = useState<Set<string>>(new Set())
  const pollingRef = useRef(true)
  const timerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  const hasMatrixTester = (getMatrixState != null && rows != null && cols != null) || matrixMode

  useEffect(() => {
    onMatrixModeChange?.(matrixMode, hasMatrixTester)
  }, [matrixMode, hasMatrixTester, onMatrixModeChange])

  // --- Matrix polling ---
  const poll = useCallback(async () => {
    if (!pollingRef.current || !getMatrixState || rows == null || cols == null) return
    try {
      const data = await getMatrixState()
      if (!pollingRef.current) return
      const pressed = parseMatrixState(data, rows, cols)
      setPressedKeys(pressed)
      setEverPressedKeys((prev) => {
        const next = new Set(prev)
        for (const key of pressed) next.add(key)
        return next
      })
    } catch {
      // device may disconnect
    }
    if (pollingRef.current) {
      timerRef.current = setTimeout(poll, POLL_INTERVAL)
    }
  }, [getMatrixState, rows, cols])

  useEffect(() => {
    if (!matrixMode || !unlocked) return
    pollingRef.current = true
    poll()
    return () => {
      pollingRef.current = false
      if (timerRef.current) clearTimeout(timerRef.current)
    }
  }, [poll, matrixMode, unlocked])

  // Deferred matrix mode entry
  const [pendingMatrix, setPendingMatrix] = useState(false)

  const enterMatrixMode = useCallback(() => {
    setMatrixMode(true)
  }, [])

  useEffect(() => {
    if (pendingMatrix && unlocked) {
      setPendingMatrix(false)
      enterMatrixMode()
    }
  }, [pendingMatrix, unlocked, enterMatrixMode])

  const resetMatrixState = useCallback(() => {
    setPressedKeys(new Set())
    setEverPressedKeys(new Set())
    setMatrixMode(false)
  }, [])

  // Exit key tester when the keyboard is locked
  useEffect(() => {
    if (!unlocked && matrixMode) resetMatrixState()
  }, [unlocked, matrixMode, resetMatrixState])

  const handleMatrixToggle = useCallback(() => {
    if (matrixMode) {
      resetMatrixState()
    } else if (unlocked) {
      enterMatrixMode()
    } else {
      setPendingMatrix(true)
      onUnlock?.()
    }
  }, [matrixMode, unlocked, resetMatrixState, enterMatrixMode, onUnlock])

  return {
    matrixMode,
    pressedKeys,
    everPressedKeys,
    hasMatrixTester,
    handleMatrixToggle,
    enterMatrixMode,
    resetMatrixState,
  }
}
