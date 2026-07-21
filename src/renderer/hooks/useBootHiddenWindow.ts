// SPDX-License-Identifier: GPL-2.0-or-later

import { useEffect, useRef, useState } from 'react'

interface BootHiddenWindowOptions {
  unlockDialogVisible: boolean
}

/**
 * Manages the window-visibility side of "start hidden in tray, but show
 * the window for the Unlock dialog." The main process starts the window
 * hidden (windowStartedHidden()); this hook shows it only while the
 * Unlock dialog is visible during that boot-hidden phase, then hides it
 * again once the dialog resolves — but only if this hook is the one that
 * showed it. If the window is already visible (the user showed it
 * themselves, or the boot-hidden phase never really applied), later
 * unlock dialogs during normal use are left alone: the phase ends without
 * showing or hiding anything.
 *
 * This hook does not decide whether the dialog should open — that is
 * owned by the view-restore effects (App.tsx's typingView restore,
 * useInputModes' typingTest/matrix-test entry), which are view-mode
 * aware. This hook only reacts to `unlockDialogVisible` once something
 * else has opened it, so a boot-hidden restore into a view that does not
 * require unlocking (e.g. the plain keymap editor) never forces a
 * prompt.
 *
 * Window visibility truth comes from the main process (windowIsVisible /
 * onWindowVisibilityChanged), not from document.visibilityState: a
 * BrowserWindow created with show: false can still report
 * document.visibilityState === 'visible' on some platforms (observed on
 * Linux Electron), which would silently prevent the boot-hidden phase
 * from ever arming.
 */
export function useBootHiddenWindow(opts: BootHiddenWindowOptions): void {
  const { unlockDialogVisible } = opts

  // Arming is reactive state, not a ref: windowStartedHidden() resolves
  // asynchronously, and by the time it does, the dialog may already be
  // visible (typingView restore path). The reveal effect is keyed on
  // `armed` and re-runs when it flips true, so an already-visible dialog
  // at that moment is not lost.
  const [armed, setArmed] = useState(false)

  const weShowedRef = useRef(false)
  // Tracks unlockDialogVisible only while armed, starting at false so that
  // a dialog already visible at the moment arming resolves is treated as
  // a rising edge instead of being missed.
  const prevVisibleRef = useRef(false)

  // Live main-process window visibility, kept current by the
  // onWindowVisibilityChanged subscription below. Read synchronously by
  // the arming effect and the rising-edge check instead of the DOM's
  // visibilityState.
  const windowVisibleRef = useRef(false)
  // True once a live onWindowVisibilityChanged push has updated
  // windowVisibleRef — lets the arming effect know its own
  // windowIsVisible() snapshot may already be stale by the time it
  // resolves (e.g. the user revealed the window via the tray in the gap
  // between the query being sent and it resolving) and defer to the ref
  // instead of overwriting it with outdated data.
  const windowVisibilityKnownRef = useRef(false)

  // Subscribe to live visibility pushes once per mount. Two jobs: keep
  // windowVisibleRef current, and end the boot-hidden phase the moment the
  // user reveals the window themselves (tray Show / OS restore) rather
  // than via our own windowShow() call. `armed` is not read from this
  // effect's closure (it would be stale — this effect has no deps) so
  // setArmed(false) is called unconditionally; that is a harmless no-op
  // when the phase is already off.
  useEffect(() => {
    const unsubscribe = window.vialAPI.onWindowVisibilityChanged((visible) => {
      windowVisibleRef.current = visible
      windowVisibilityKnownRef.current = true
      if (visible && !weShowedRef.current) {
        setArmed(false)
      }
    })
    return unsubscribe
  }, [])

  // Learn whether this launch started hidden. Runs once; only arm the
  // phase if the window is still actually hidden by the time this
  // resolves — if the user (or the OS) already revealed it, the
  // boot-hidden phase is already over and must never arm. A failure (or a
  // launch that did not start hidden) also leaves the phase off.
  useEffect(() => {
    let cancelled = false
    Promise.all([window.vialAPI.windowStartedHidden(), window.vialAPI.windowIsVisible()]).then(([hidden, visible]) => {
      if (cancelled) return
      // A live push may have already updated windowVisibleRef with more
      // current data than this query's own snapshot — trust that over a
      // possibly-stale `visible` value.
      if (!windowVisibilityKnownRef.current) {
        windowVisibleRef.current = visible
      }
      setArmed(hidden && !windowVisibleRef.current)
    }).catch(() => { /* best-effort — stay non-boot-hidden on failure */ })
    return () => { cancelled = true }
  }, [])

  // Show/hide the window around the Unlock dialog's visible lifetime.
  useEffect(() => {
    if (!armed) return
    const wasVisible = prevVisibleRef.current
    prevVisibleRef.current = unlockDialogVisible

    if (unlockDialogVisible && !wasVisible) {
      if (windowVisibleRef.current) {
        // The window is already visible (the user is actively using it) —
        // this is not the boot-hidden dialog. End the phase without
        // touching the window; later dialogs must not hide it either.
        setArmed(false)
        return
      }
      // Rising edge on a genuinely hidden window: show it for the dialog
      // and remember that we did so, so the falling edge only hides what
      // we showed. weShowedRef must be set synchronously (not after the
      // invoke resolves): Electron emits win 'show' from within win.show(),
      // so the WINDOW_VISIBILITY_CHANGED push reaches the visibility
      // subscription above BEFORE this invoke's promise resolves. If
      // weShowedRef were still false at that point, that push would read as
      // a foreign reveal and disarm the phase, breaking this very show.
      //
      // That leaves a window-ownership race: the user may have shown the
      // window via the tray in the gap between the WINDOW_IS_VISIBLE
      // snapshot (arming effect) and this call. windowShow() resolves with
      // whether main actually transitioned the window from hidden to
      // shown — false means the user beat us to it. Roll back ownership in
      // that case so the falling edge does not hide a window the user
      // opened themselves.
      weShowedRef.current = true
      void window.vialAPI.windowShow().then((transitioned) => {
        if (!transitioned) {
          weShowedRef.current = false
          setArmed(false)
        }
      }).catch(() => {})
    } else if (!unlockDialogVisible && wasVisible) {
      // Falling edge: the dialog resolved (unlocked, or disconnected).
      // End the boot-hidden phase — later dialogs in this session no
      // longer auto-show/hide — and hide the window again only if this
      // hook is the one that showed it for this dialog.
      setArmed(false)
      if (weShowedRef.current) {
        void window.vialAPI.windowHide().catch(() => {})
      }
    }
  }, [armed, unlockDialogVisible])
}
