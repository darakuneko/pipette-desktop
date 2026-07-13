// SPDX-License-Identifier: GPL-2.0-or-later

import { useEffect, useRef } from 'react'

/**
 * Manages the window-visibility side of "start hidden in tray, but show
 * the window for the Unlock dialog." The main process starts the window
 * hidden (windowStartedHidden()); this hook shows it only while the
 * Unlock dialog opened during session restore is visible, then hides it
 * again once the dialog resolves — unless the user has already shown the
 * window themselves (e.g. a tray click), in which case the boot-hidden
 * phase ends and the window is left alone.
 */
export function useBootHiddenWindow(unlockDialogVisible: boolean): void {
  const bootHiddenRef = useRef(false)
  const weShowedRef = useRef(false)
  const prevVisibleRef = useRef(unlockDialogVisible)

  // Learn whether this launch started hidden. Runs once; a failure (or a
  // launch that did not start hidden) simply leaves the phase off, so the
  // rest of this hook never touches the window.
  useEffect(() => {
    let cancelled = false
    window.vialAPI.windowStartedHidden().then((hidden) => {
      if (!cancelled) bootHiddenRef.current = hidden
    }).catch(() => { /* best-effort — stay non-boot-hidden on failure */ })
    return () => { cancelled = true }
  }, [])

  useEffect(() => {
    const wasVisible = prevVisibleRef.current
    prevVisibleRef.current = unlockDialogVisible
    if (!bootHiddenRef.current) return

    if (unlockDialogVisible && !wasVisible) {
      // Rising edge: the unlock dialog just opened during the boot-hidden
      // phase. Show the window for it and remember that we did so, so the
      // visibilitychange listener below does not mistake this for the
      // user showing the window themselves.
      weShowedRef.current = true
      void window.vialAPI.windowShow().catch(() => {})
    } else if (!unlockDialogVisible && wasVisible) {
      // Falling edge: the dialog resolved (unlocked, or cancelled/
      // disconnected). Hide the window again and end the boot-hidden
      // phase — later dialogs in this session no longer auto-show/hide.
      // (weShowedRef needs no reset: every read is gated on the
      // boot-hidden flag that just went false for good.)
      bootHiddenRef.current = false
      void window.vialAPI.windowHide().catch(() => {})
    }
  }, [unlockDialogVisible])

  useEffect(() => {
    function handleVisibilityChange() {
      if (!bootHiddenRef.current) return
      if (document.visibilityState === 'visible' && !weShowedRef.current) {
        // The user showed the window themselves (tray Show / OS restore)
        // before we ever showed it for a dialog. Never auto-hide a window
        // the user opened — just end the boot-hidden phase.
        bootHiddenRef.current = false
      }
    }
    document.addEventListener('visibilitychange', handleVisibilityChange)
    return () => document.removeEventListener('visibilitychange', handleVisibilityChange)
  }, [])
}
