// SPDX-License-Identifier: GPL-2.0-or-later

import { useCallback, useEffect, useRef } from 'react'
import type { TrayStatus } from '../../shared/types/vial-api'

const THROTTLE_MS = 1000

export interface TrayStatusInput {
  keyboardName: string | null
  recording: boolean
  /** Read on demand rather than passed as a plain number so incrementing
   * the underlying counter (see useRecKeystrokeCounter) never forces a
   * re-render of the caller — this hook pulls the latest value itself on
   * each throttle tick instead of being pushed a new value per keystroke. */
  getCount: () => number
  /** Rolling last-60-seconds keystroke rate, read the same way as
   * getCount — see useRecKeystrokeCounter. */
  getKpm: () => number
}

/**
 * Forwards the connected keyboard's name and REC keystroke count to the
 * main-process tray (see src/main/app-behavior.ts). Identity/recording
 * edges (keyboard connect/disconnect, REC toggle) are sent immediately so
 * the tray feels responsive; count-only movement is throttled to at most
 * one send per second (trailing, so the final value always lands) since
 * it changes far more often and the tray doesn't need per-keystroke
 * precision.
 */
export function useTrayStatus({ keyboardName, recording, getCount, getKpm }: TrayStatusInput): void {
  const lastSentRef = useRef<TrayStatus | null>(null)
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const getCountRef = useRef(getCount)
  getCountRef.current = getCount
  const getKpmRef = useRef(getKpm)
  getKpmRef.current = getKpm

  const sendIfChanged = useCallback((next: TrayStatus) => {
    const last = lastSentRef.current
    if (last && last.keyboardName === next.keyboardName && last.recording === next.recording &&
        last.count === next.count && last.kpm === next.kpm) {
      return
    }
    lastSentRef.current = next
    window.vialAPI.trayStatusUpdate(next).catch(() => { /* best-effort — tray display only */ })
  }, [])

  // Immediate send on identity/recording edges (and on mount).
  useEffect(() => {
    sendIfChanged({ keyboardName, recording, count: getCountRef.current(), kpm: getKpmRef.current() })
  }, [keyboardName, recording, sendIfChanged])

  // While recording, poll the count/kpm getters at most once per second
  // and send a trailing update when either moved. Both are ref-backed (no
  // React state), so this is the only way the hook observes changes
  // without the caller re-rendering on every keystroke.
  useEffect(() => {
    if (!recording) return
    intervalRef.current = setInterval(() => {
      sendIfChanged({ keyboardName, recording, count: getCountRef.current(), kpm: getKpmRef.current() })
    }, THROTTLE_MS)
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current)
      intervalRef.current = null
    }
  }, [recording, keyboardName, sendIfChanged])
}
