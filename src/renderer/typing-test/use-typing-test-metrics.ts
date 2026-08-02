// SPDX-License-Identifier: GPL-2.0-or-later

/** Live-updating derived metrics for useTypingTest: the once-per-second
 *  tick that drives every time-based memo below, the WPM-history
 *  sampler, the time-bounded auto-finish effect, and the memoized
 *  wpm/kpm/accuracy/kspc/elapsedSeconds/remainingSeconds themselves. */

import { useState, useEffect, useMemo, type Dispatch, type SetStateAction } from 'react'
import { isTimeBoundedRun, runDurationSeconds } from './types'
import type { TypingTestConfig } from './types'
import type { TypingTestState } from './run-state'
import { computeKspc } from '../../shared/kspc'

const MAX_WPM_HISTORY = 300

export interface TypingTestMetrics {
  wpm: number
  kpm: number
  accuracy: number
  /** Keystrokes per confirmed character (see `computeKspc` and
   *  `TypingTestState.confirmedChars`), live-updated the same way as
   *  wpm/kpm/accuracy. `null` while nothing is confirmed yet, or once an
   *  IME composition made the run's `totalKeystrokes` untrustworthy
   *  (`state.kspcUncomputable`). */
  kspc: number | null
  elapsedSeconds: number
  remainingSeconds: number | null
}

export function useTypingTestMetrics(
  state: TypingTestState,
  config: TypingTestConfig,
  setState: Dispatch<SetStateAction<TypingTestState>>,
): TypingTestMetrics {
  // Tick every second while running so elapsed time and WPM update live
  const [tick, setTick] = useState(0)
  useEffect(() => {
    if (state.status !== 'running') return
    const id = setInterval(() => {
      setTick((n) => n + 1)
      // Record WPM snapshot for history
      setState((s) => {
        if (s.status !== 'running' || !s.startTime) return s
        const elapsed = (Date.now() - s.startTime) / 60000
        if (elapsed <= 0) return s
        const currentWpm = Math.round((s.correctChars / 5) / elapsed)
        if (s.wpmHistory.length >= MAX_WPM_HISTORY) return s
        return { ...s, wpmHistory: [...s.wpmHistory, currentWpm] }
      })
    }, 1000)
    return () => clearInterval(id)
  }, [state.status])

  // Time-bounded countdown (monkeytype time mode, or tatoeba's Time
  // pattern) - finish when remaining reaches 0
  useEffect(() => {
    if (state.status !== 'running') return
    if (!isTimeBoundedRun(config)) return
    if (!state.startTime) return

    const duration = runDurationSeconds(config)
    if (duration == null) return
    const elapsed = Math.floor((Date.now() - state.startTime) / 1000)
    if (elapsed >= duration) {
      setState((s) => {
        if (s.status !== 'running') return s
        return { ...s, status: 'finished', endTime: Date.now() }
      })
    }
  }, [tick, state.status, state.startTime, config])

  const wpm = useMemo(() => {
    if (!state.startTime) return 0
    const end = state.endTime ?? Date.now()
    const minutes = (end - state.startTime) / 60000
    if (minutes <= 0) return 0
    return Math.round((state.correctChars / 5) / minutes)
  }, [state.startTime, state.endTime, state.correctChars, tick])

  // Keystrokes per minute (correct chars / minute). FileImport mode shows this
  // instead of WPM, since imported code / CJK text has no meaningful "words".
  const kpm = useMemo(() => {
    if (!state.startTime) return 0
    const end = state.endTime ?? Date.now()
    const minutes = (end - state.startTime) / 60000
    if (minutes <= 0) return 0
    return Math.round(state.correctChars / minutes)
  }, [state.startTime, state.endTime, state.correctChars, tick])

  const accuracy = useMemo(() => {
    const total = state.correctChars + state.incorrectChars
    if (total === 0) return 100
    return Math.round((state.correctChars / total) * 100)
  }, [state.correctChars, state.incorrectChars])

  // Live keystrokes-per-confirmed-character, same computeKspc math the
  // finished result is built from (buildTypingTestResult), reading
  // state.confirmedChars directly — no per-mode derivation here.
  const kspc = useMemo(() => {
    if (state.kspcUncomputable) return null
    return computeKspc(state.totalKeystrokes, state.confirmedChars)
  }, [state.kspcUncomputable, state.totalKeystrokes, state.confirmedChars])

  const elapsedSeconds = useMemo(() => {
    if (!state.startTime) return 0
    const end = state.endTime ?? Date.now()
    return Math.floor((end - state.startTime) / 1000)
  }, [state.startTime, state.endTime, tick])

  const remainingSeconds = useMemo(() => {
    const duration = runDurationSeconds(config)
    if (duration == null) return null
    if (!state.startTime) return duration
    if (state.endTime) return 0
    const elapsed = Math.floor((Date.now() - state.startTime) / 1000)
    return Math.max(0, duration - elapsed)
  }, [config, state.startTime, state.endTime, tick])

  return { wpm, kpm, accuracy, kspc, elapsedSeconds, remainingSeconds }
}
