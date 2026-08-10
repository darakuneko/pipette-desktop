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
  /** When true, polling keeps running even while matrixMode is off, so a
   *  background recorder can keep observing the key matrix outside the Key
   *  Tester screen. Frames are then routed to `onAmbientFrame` instead of
   *  `pressedKeys`/`everPressedKeys` state (see below). */
  recordingActive?: boolean
  /** Receives each parsed pressed-key frame while polling runs only because
   *  of `recordingActive` (matrixMode is false). Never called while
   *  matrixMode is true -- the two frame-delivery paths are mutually
   *  exclusive so a frame is never delivered twice. */
  onAmbientFrame?: (pressed: Set<string>) => void
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
   *  as its input source). Also seeds pressedKeys/everPressedKeys from the
   *  most recent ambient frame (if any) in the same commit as the mode
   *  flip, so a key already held during ambient recording carries over
   *  continuously into the Key Tester / typing-test state instead of
   *  registering a phantom release+press pair — see `lastAmbientFrameRef`
   *  below for the full mechanism. */
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
  recordingActive,
  onAmbientFrame,
}: UseMatrixTesterOptions): UseMatrixTesterReturn {
  const [matrixMode, setMatrixMode] = useState(false)
  const [pressedKeys, setPressedKeys] = useState<Set<string>>(new Set())
  const [everPressedKeys, setEverPressedKeys] = useState<Set<string>>(new Set())
  // Generation counter for the poll loop, replacing a shared boolean flag.
  // Each (re)start bumps it; an in-flight getMatrixState() call captures its
  // generation and, once resolved, only applies its frame / reschedules
  // itself if the generation still matches. This prevents a stale poll from
  // an old loop (e.g. one still awaiting its device round-trip when
  // recordingActive flips off then back on) from spawning a second,
  // overlapping loop once it resolves.
  const pollGenRef = useRef(0)
  const timerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  // The most recent frame observed on the ambient (background) polling
  // path — updated on every ambient tick, consumed exactly once by
  // enterMatrixMode to seed pressedKeys/everPressedKeys so a key already
  // held when the caller hands off from ambient recording to Key Tester /
  // a typing test doesn't produce a phantom release+press pair (a stale
  // React `pressedKeys` of `{}` meeting processMatrixFrame's own
  // prevPressedRef, which the ambient path already advanced). Cleared
  // whenever ambient feeding stops for a reason OTHER than that handoff
  // (recording turning off, or the keyboard locking) — see the effect
  // below — so a much later, unrelated matrixMode entry never seeds from
  // a stale snapshot of a previous session.
  const lastAmbientFrameRef = useRef<Set<string>>(new Set())

  const hasMatrixTester = (getMatrixState != null && rows != null && cols != null) || matrixMode

  useEffect(() => {
    onMatrixModeChange?.(matrixMode, hasMatrixTester)
  }, [matrixMode, hasMatrixTester, onMatrixModeChange])

  // --- Matrix polling ---
  // The tick function is defined inside this effect (not a separate
  // useCallback) so it closes directly over `gen` and this render's
  // `matrixMode`/`getMatrixState`/`rows`/`cols`/`onAmbientFrame` -- no ref
  // shadow needed for mode routing, since the effect itself is keyed on
  // matrixMode: any mode change tears down this closure (bumping the
  // generation in cleanup, discarding an in-flight call) before a new one
  // captures the new mode. Rescheduling passes `tick` itself to setTimeout
  // (not a wrapping arrow function), so no closure is allocated per tick.
  useEffect(() => {
    if (!((matrixMode || recordingActive === true) && unlocked)) return
    const gen = ++pollGenRef.current

    async function tick() {
      if (pollGenRef.current !== gen || !getMatrixState || rows == null || cols == null) return
      try {
        const data = await getMatrixState()
        if (pollGenRef.current !== gen) return // superseded loop -- discard
        const pressed = parseMatrixState(data, rows, cols)
        if (matrixMode) {
          // Key Tester UI path: drive visible state. A key already held when
          // polling starts has no prior frame to compare against, so it is
          // reported pressed (and added to everPressedKeys) on this very
          // first frame -- there is no debounce or edge-detection here.
          setPressedKeys(pressed)
          setEverPressedKeys((prev) => {
            const next = new Set(prev)
            for (const key of pressed) next.add(key)
            return next
          })
        } else {
          // Ambient (background recording) path: hand the frame off without
          // touching component state, so polling never re-renders the editor.
          // Recorded into lastAmbientFrameRef first (same `pressed` Set
          // reference processMatrixFrame is about to adopt as its own
          // prevPressedRef) so a later enterMatrixMode can seed from it.
          lastAmbientFrameRef.current = pressed
          onAmbientFrame?.(pressed)
        }
      } catch {
        // device may disconnect
      }
      if (pollGenRef.current === gen) {
        timerRef.current = setTimeout(tick, POLL_INTERVAL)
      }
    }

    tick()
    return () => {
      // Bump the generation so this loop's in-flight call (if any) resolves
      // as stale instead of rescheduling a follow-up tick.
      pollGenRef.current += 1
      if (timerRef.current) clearTimeout(timerRef.current)
    }
  }, [matrixMode, unlocked, recordingActive, getMatrixState, rows, cols, onAmbientFrame])

  // Deferred matrix mode entry
  const [pendingMatrix, setPendingMatrix] = useState(false)

  const enterMatrixMode = useCallback(() => {
    // Seed from the last ambient frame (see lastAmbientFrameRef's own doc
    // comment) BEFORE flipping matrixMode, so both state writes land in
    // the same commit as the mode flip -- the state-driven feed effect in
    // useInputModes reads pressedKeys keyed on typingTestMode, and must
    // never see a stale (pre-seed) value on its first post-switch firing.
    const seed = lastAmbientFrameRef.current
    if (seed.size > 0) {
      setPressedKeys(seed)
      setEverPressedKeys((prev) => {
        const next = new Set(prev)
        for (const key of seed) next.add(key)
        return next
      })
      // Consumed once: the next real matrixMode poll frame takes over
      // pressedKeys from here on, and this ref should only ever feed a
      // NEW handoff (a fresh ambient frame observed after some later
      // exit back to ambient), never the same frame twice.
      lastAmbientFrameRef.current = new Set()
    }
    setMatrixMode(true)
  }, [])

  // Clear the pending ambient-frame seed whenever ambient feeding stops for
  // a reason OTHER than handing off into matrixMode (recording turning
  // off, or the keyboard locking). matrixMode itself is deliberately NOT a
  // dependency here: entering matrixMode is the handoff this ref exists to
  // serve, and enterMatrixMode already consumes (and clears) it directly
  // above -- this effect only guards the non-handoff paths, so it can
  // never race that consumption.
  useEffect(() => {
    if (!recordingActive || !unlocked) {
      lastAmbientFrameRef.current = new Set()
    }
  }, [recordingActive, unlocked])

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
