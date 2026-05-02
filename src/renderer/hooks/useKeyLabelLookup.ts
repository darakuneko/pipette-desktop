// SPDX-License-Identifier: GPL-2.0-or-later
//
// Lazily-loaded cache of Key Label entry payloads (`map` /
// `compositeLabels` / `name`). Built-in `KEYBOARD_LAYOUTS` entries
// resolve synchronously from `LAYOUT_BY_ID`; anything else is fetched
// via IPC the first time `ensure(id)` is called and cached for the
// lifetime of the hook instance. Used by:
//   - `useKeyboardLayout` (KeymapEditor key labels)
//   - `LayoutComparisonView` / analyze-csv-builders (Layout Comparison
//     map-vs-map source / target inputs)

import { useCallback, useEffect, useRef, useState } from 'react'
import { LAYOUT_BY_ID } from '../data/keyboard-layouts'
import type { KeyLabelEntryFile } from '../../shared/types/key-label-store'

// Same event name `useKeyLabels` dispatches whenever the store
// changes — listened to here so the lookup cache gets dropped on
// import / rename / delete / Hub download. Without this the renderer
// would keep showing the previous map until the next app launch.
const REFRESH_EVENT = 'pipette:key-labels-changed'

export interface UseKeyLabelLookupReturn {
  /** Trigger a fetch for `id` if it is not already cached or built-in. */
  ensure: (id: string) => Promise<void>
  /** Display name. Falls back to the id when the entry has not loaded yet. */
  getName: (id: string) => string | undefined
  /** qmkId → label map (basic keys). Empty object for built-in QWERTY. */
  getMap: (id: string) => Record<string, string> | undefined
  /** qmkId → label map for composite keycodes (e.g. `LALT(KC_L)`). */
  getCompositeLabels: (id: string) => Record<string, string> | undefined
}

export function useKeyLabelLookup(): UseKeyLabelLookupReturn {
  const [, setVersion] = useState(0)
  const cacheRef = useRef<Map<string, KeyLabelEntryFile>>(new Map())
  const inflightRef = useRef<Map<string, Promise<void>>>(new Map())
  const missingRef = useRef<Set<string>>(new Set())

  // Drop the cache whenever any other place mutates the Key Labels
  // store (import / rename / delete / Hub download). The next
  // `ensure(id)` call will re-fetch the fresh content via IPC.
  useEffect(() => {
    if (typeof window === 'undefined') return
    const handler = (): void => {
      cacheRef.current.clear()
      missingRef.current.clear()
      setVersion((v) => v + 1)
    }
    window.addEventListener(REFRESH_EVENT, handler)
    return () => window.removeEventListener(REFRESH_EVENT, handler)
  }, [])

  const ensure = useCallback(async (id: string): Promise<void> => {
    if (!id) return
    if (LAYOUT_BY_ID.has(id)) return
    if (cacheRef.current.has(id)) return
    if (missingRef.current.has(id)) return
    const inflight = inflightRef.current.get(id)
    if (inflight) return inflight

    const promise = (async () => {
      try {
        const result = await window.vialAPI.keyLabelStoreGet(id)
        if (result.success && result.data) {
          cacheRef.current.set(id, result.data.data)
          setVersion((v) => v + 1)
        } else {
          // Avoid hammering IPC on a missing id; the user will refresh
          // when they install the matching label.
          missingRef.current.add(id)
        }
      } catch {
        missingRef.current.add(id)
      } finally {
        inflightRef.current.delete(id)
      }
    })()
    inflightRef.current.set(id, promise)
    return promise
  }, [])

  const getName = useCallback((id: string): string | undefined => {
    const builtin = LAYOUT_BY_ID.get(id)
    if (builtin) return builtin.name
    return cacheRef.current.get(id)?.name
  }, [])

  const getMap = useCallback((id: string): Record<string, string> | undefined => {
    const builtin = LAYOUT_BY_ID.get(id)
    if (builtin) return builtin.map
    return cacheRef.current.get(id)?.map
  }, [])

  const getCompositeLabels = useCallback((id: string): Record<string, string> | undefined => {
    const builtin = LAYOUT_BY_ID.get(id)
    if (builtin) return builtin.compositeLabels
    return cacheRef.current.get(id)?.compositeLabels
  }, [])

  return { ensure, getName, getMap, getCompositeLabels }
}
