// SPDX-License-Identifier: GPL-2.0-or-later

import { useCallback, useEffect, useRef } from 'react'

/** Rolling window used to compute the keystrokes-per-minute rate. */
const KPM_WINDOW_MS = 60_000

/**
 * Session-local REC keystroke counter for the tray status display. Backed
 * by refs (not React state) so incrementing on every recorded keystroke
 * never triggers a re-render of the caller — App renders once per keymap
 * change, not once per keystroke. Resets to zero on the recording
 * OFF→ON edge so each REC session starts counting from zero; a paused
 * session (still ON) keeps its count.
 *
 * Alongside the running total, a bounded buffer of keystroke timestamps
 * backs `getKpm()` — a rolling last-60-seconds keystroke rate. Entries
 * older than the window are pruned on every increment and on every read,
 * so the buffer never grows past what fits in 60 seconds of typing
 * (~600 entries at 10 keys/s).
 */
export function useRecKeystrokeCounter(recordingActive: boolean): {
  increment: () => void
  getCount: () => number
  getKpm: () => number
} {
  const countRef = useRef(0)
  const wasActiveRef = useRef(recordingActive)
  const timestampsRef = useRef<number[]>([])

  useEffect(() => {
    const wasActive = wasActiveRef.current
    wasActiveRef.current = recordingActive
    if (!wasActive && recordingActive) {
      countRef.current = 0
      timestampsRef.current = []
    }
  }, [recordingActive])

  const pruneOld = useCallback((now: number) => {
    const cutoff = now - KPM_WINDOW_MS
    const buf = timestampsRef.current
    let firstLiveIndex = 0
    while (firstLiveIndex < buf.length && buf[firstLiveIndex] < cutoff) {
      firstLiveIndex++
    }
    if (firstLiveIndex > 0) {
      timestampsRef.current = buf.slice(firstLiveIndex)
    }
  }, [])

  const increment = useCallback(() => {
    countRef.current += 1
    const now = Date.now()
    timestampsRef.current.push(now)
    pruneOld(now)
  }, [pruneOld])

  const getCount = useCallback(() => countRef.current, [])

  const getKpm = useCallback(() => {
    pruneOld(Date.now())
    return timestampsRef.current.length
  }, [pruneOld])

  return { increment, getCount, getKpm }
}
