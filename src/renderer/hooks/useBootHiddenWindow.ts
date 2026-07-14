// SPDX-License-Identifier: GPL-2.0-or-later

import { useEffect, useRef } from 'react'

/**
 * Manages the window-visibility side of "start hidden in tray, but show
 * the window for the Unlock dialog." The main process starts the window
 * hidden (windowStartedHidden()); this hook shows it only while the
 * Unlock dialog opened during session restore is visible, then hides it
 * again once the dialog resolves — but only if this hook is the one that
 * showed it. If the window is already visible (the user showed it
 * themselves, or the boot-hidden phase never really applied), later
 * unlock dialogs during normal use are left alone: the phase ends without
 * showing or hiding anything.
 */
export function useBootHiddenWindow(unlockDialogVisible: boolean): void {
  const bootHiddenRef = useRef(false)
  const weShowedRef = useRef(false)
  const prevVisibleRef = useRef(unlockDialogVisible)

  // Learn whether this launch started hidden. Runs once; only arm the
  // phase if the window is still actually hidden by the time this
  // resolves — if the user (or the OS) already revealed it, the
  // boot-hidden phase is already over and must never re-arm. A failure
  // (or a launch that did not start hidden) also leaves the phase off.
  useEffect(() => {
    let cancelled = false
    window.vialAPI.windowStartedHidden().then((hidden) => {
      if (!cancelled) bootHiddenRef.current = hidden && document.visibilityState !== 'visible'
    }).catch(() => { /* best-effort — stay non-boot-hidden on failure */ })
    return () => { cancelled = true }
  }, [])

  useEffect(() => {
    const wasVisible = prevVisibleRef.current
    prevVisibleRef.current = unlockDialogVisible
    if (!bootHiddenRef.current) return

    if (unlockDialogVisible && !wasVisible) {
      if (document.visibilityState === 'visible') {
        // The window is already visible (the user is actively using it) —
        // this is not the boot-hidden dialog. End the phase without
        // touching the window; later dialogs must not hide it either.
        bootHiddenRef.current = false
        return
      }
      // Rising edge on a genuinely hidden window: show it for the dialog
      // and remember that we did so, so the falling edge only hides what
      // we showed.
      weShowedRef.current = true
      void window.vialAPI.windowShow().catch(() => {})
    } else if (!unlockDialogVisible && wasVisible) {
      // Falling edge: the dialog resolved (unlocked, or cancelled/
      // disconnected). End the boot-hidden phase — later dialogs in this
      // session no longer auto-show/hide — and hide the window again only
      // if this hook is the one that showed it for this dialog.
      bootHiddenRef.current = false
      if (weShowedRef.current) {
        void window.vialAPI.windowHide().catch(() => {})
      }
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
