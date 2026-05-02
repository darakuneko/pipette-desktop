// SPDX-License-Identifier: GPL-2.0-or-later
//
// Surface a one-shot notice when a connected keyboard's saved
// `keyboardLayout` is no longer present locally. Mirrors what
// `useDevicePrefs` already does (silently fall back to qwerty when the
// id is unknown), but lets the user know they can re-download the
// missing label from Settings → Tools → Key Labels.

import { useCallback, useEffect, useRef, useState } from 'react'
import { LAYOUT_ID_SET } from '../data/keyboard-layouts'

interface UseMissingKeyLabelNoticeReturn {
  missingName: string | null
  dismiss: () => void
}

/**
 * Reads `pipette_settings.keyboardLayout` directly via IPC so we see the
 * raw saved id (the one `useDevicePrefs` may have already replaced with
 * qwerty when the id was unknown). Compares against the QWERTY built-in
 * and the local Key Label store; if neither covers it, exposes the
 * layout id as `missingName` so the dialog can prompt the user.
 *
 * Each (uid + layoutId) pair is shown once per session — closing the
 * dialog records the dismissal in a ref so reconnects within the same
 * session stay quiet.
 */
export function useMissingKeyLabelNotice(uid: string | null): UseMissingKeyLabelNoticeReturn {
  const [missingName, setMissingName] = useState<string | null>(null)
  const dismissedRef = useRef<Set<string>>(new Set())
  const activeKeyRef = useRef<string | null>(null)

  useEffect(() => {
    if (!uid) {
      setMissingName(null)
      activeKeyRef.current = null
      return
    }

    let cancelled = false
    void (async () => {
      try {
        const prefs = await window.vialAPI.pipetteSettingsGet(uid)
        const layoutId = typeof prefs?.keyboardLayout === 'string' ? prefs.keyboardLayout : null
        if (!layoutId || layoutId === 'qwerty') return
        if (LAYOUT_ID_SET.has(layoutId)) return

        // Pull tombstones too — even a soft-deleted entry still
        // carries the original `name`, which lets the dialog show the
        // human label for layouts saved under the old random-UUID id
        // scheme.
        const stored = await window.vialAPI.keyLabelStoreListAll()
        const exists =
          stored.success && Array.isArray(stored.data) &&
          stored.data.some((meta) => meta.id === layoutId && !meta.deletedAt)
        if (exists) return

        const key = `${uid}::${layoutId}`
        if (dismissedRef.current.has(key)) return
        if (cancelled) return

        // Resolve a human-readable label name. Try in this order:
        //   1. Local soft-deleted entries (still carry the original
        //      name; covers labels saved under the old random-UUID
        //      scheme that are no longer matched by Hub).
        //   2. Hub detail by id (works for entries downloaded under
        //      the new "id == hubPostId" scheme).
        //   3. Fall back to the raw id so the dialog still has
        //      something to show.
        let displayName = layoutId
        const tombstone = stored.success && Array.isArray(stored.data)
          ? stored.data.find((meta) => meta.id === layoutId)
          : undefined
        if (tombstone?.name) {
          displayName = tombstone.name
        } else {
          try {
            const detail = await window.vialAPI.keyLabelHubDetail(layoutId)
            if (detail.success && detail.data?.name) {
              displayName = detail.data.name
            }
          } catch {
            // ignore — keep displayName = layoutId
          }
        }
        if (cancelled) return
        activeKeyRef.current = key
        setMissingName(displayName)
      } catch {
        // Silently no-op — sync proceeds with qwerty fallback.
      }
    })()

    return () => {
      cancelled = true
    }
  }, [uid])

  const dismiss = useCallback((): void => {
    if (activeKeyRef.current) dismissedRef.current.add(activeKeyRef.current)
    activeKeyRef.current = null
    setMissingName(null)
    // Caller is expected to flip the live `devicePrefs.layout` to
    // 'qwerty' so the in-memory state, the pipette_settings.json, and
    // the dropdown selection all stay in lockstep. We deliberately do
    // not write `pipette_settings` ourselves here — `useDevicePrefs`
    // owns that file's lifecycle and would race with us.
  }, [])

  return { missingName, dismiss }
}
