// SPDX-License-Identifier: GPL-2.0-or-later

import { useCallback, useEffect, useRef, useState } from 'react'
import { useAppConfig } from './useAppConfig'
import type { UpdateErrorCode } from '../../shared/types/update'

/** How long after the window is on screen (and the startup notices are
 *  done) the update is checked, so the check does not compete with the
 *  startup itself. */
export const UPDATE_CHECK_DELAY_MS = 3_000

/** What the update modal shows: an update to offer, or the failure the
 *  last update left (its install, after the app quit, failed). */
export type UpdatePrompt =
  | { kind: 'available'; version: string; currentVersion: string; releaseUrl: string }
  | { kind: 'failed'; version: string; code: UpdateErrorCode; releaseUrl: string; backupPath?: string }

export interface UpdateCheckState {
  prompt: UpdatePrompt | null
  /** "Not now", or closing the failure. */
  close: () => void
  /** "Skip this version": the startup check no longer offers exactly it. */
  skip: () => void
}

interface StartupNotice {
  settled: boolean
  visible: boolean
}

/** Whether the main window is on screen, from the backend's answer and its
 *  visibility events: a launch that starts in the tray stays false until
 *  the window is shown. */
function useWindowVisible(): boolean {
  const [visible, setVisible] = useState(false)
  useEffect(() => {
    let cancelled = false
    const unsubscribe = window.vialAPI.onWindowVisibilityChanged((shown) => setVisible(shown))
    window.vialAPI.windowIsVisible().then((shown) => {
      if (!cancelled && shown) setVisible(true)
    }).catch(() => { /* the events still tell */ })
    return () => {
      cancelled = true
      unsubscribe()
    }
  }, [])
  return visible
}

/**
 * Checks for an update once per launch: after the startup notices are done
 * and their modal is closed (the two modals never show together), once the
 * window is on screen, {@link UPDATE_CHECK_DELAY_MS} later. A failure the
 * last update left is shown instead of checking. A version the user
 * skipped is not offered; the check answers it as `skipped`. A failed
 * check shows nothing: the About tab's check reports it.
 */
export function useUpdateCheck(notice: StartupNotice): UpdateCheckState {
  const appConfig = useAppConfig()
  const windowVisible = useWindowVisible()
  const [prompt, setPrompt] = useState<UpdatePrompt | null>(null)
  const startedRef = useRef(false)
  const mountedRef = useRef(true)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Started once, the check is not stopped by a later change of its
  // inputs; only unmounting stops it, and a pending one starts again if
  // the component mounts again.
  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      if (timerRef.current !== null) {
        clearTimeout(timerRef.current)
        timerRef.current = null
        startedRef.current = false
      }
    }
  }, [])

  useEffect(() => {
    if (startedRef.current || !notice.settled || notice.visible || !windowVisible) return
    startedRef.current = true
    timerRef.current = setTimeout(() => {
      timerRef.current = null
      void (async () => {
        const failure = await window.vialAPI.updateTakeFailure().catch(() => null)
        if (failure) {
          if (mountedRef.current) setPrompt({ kind: 'failed', ...failure })
          return
        }
        const result = await window.vialAPI.updateCheck().catch(() => null)
        if (!mountedRef.current || result?.status !== 'available' || result.skipped) return
        const { version, currentVersion, releaseUrl } = result
        setPrompt({ kind: 'available', version, currentVersion, releaseUrl })
      })()
    }, UPDATE_CHECK_DELAY_MS)
  }, [notice.settled, notice.visible, windowVisible])

  const close = useCallback(() => setPrompt(null), [])

  const skip = useCallback(() => {
    if (prompt?.kind === 'available') appConfig.set('updateSkippedVersion', prompt.version)
    setPrompt(null)
  }, [prompt, appConfig])

  return { prompt, close, skip }
}
