// SPDX-License-Identifier: GPL-2.0-or-later

import { useCallback, useEffect, useRef } from 'react'

/**
 * Session-local REC keystroke counter for the tray status display. Backed
 * by a ref (not React state) so incrementing on every recorded keystroke
 * never triggers a re-render of the caller — App renders once per keymap
 * change, not once per keystroke. Resets to zero on the recording
 * OFF→ON edge so each REC session starts counting from zero; a paused
 * session (still ON) keeps its count.
 */
export function useRecKeystrokeCounter(recordingActive: boolean): {
  increment: () => void
  getCount: () => number
} {
  const countRef = useRef(0)
  const wasActiveRef = useRef(recordingActive)

  useEffect(() => {
    const wasActive = wasActiveRef.current
    wasActiveRef.current = recordingActive
    if (!wasActive && recordingActive) {
      countRef.current = 0
    }
  }, [recordingActive])

  const increment = useCallback(() => {
    countRef.current += 1
  }, [])

  const getCount = useCallback(() => countRef.current, [])

  return { increment, getCount }
}
