// SPDX-License-Identifier: GPL-2.0-or-later
// Shared per-mode fetch effect for KeyHeatmapChart's Speed / Duration
// modes: both need "only fetch while this mode is active, skip the
// call when already cached under this key, null the cached key on
// failure so the next visit retries instead of re-serving the emptied
// result, ignore a response that settles after unmount or a mode swap"
// — this hook is that pattern written once instead of twice. Count mode
// stays a bespoke effect in KeyHeatmapChart.tsx: it fetches per selected
// layer with a per-layer catch (a failed layer falls back to `{}` while
// the others still populate), which doesn't fit this hook's
// whole-fetch-or-nothing failure handling without losing that nuance.

import { useEffect, useRef, useState } from 'react'

export interface ModeFetchState<T> {
  data: T
  loading: boolean
}

/** Fetches `fetcher()` while `active` is true, skipping the call
 * entirely when `key` still matches the last successful fetch (the
 * mode was left and re-entered with unchanged filters). A failed fetch
 * resets `data` to `empty` and nulls the cached key so the next time
 * this mode becomes active it retries instead of serving the
 * stale/emptied result under a key that still matches.
 *
 * `key` must encode every filter axis the fetch depends on (uid / range
 * / scope / app filters / ...) — see KeyHeatmapChart's `axesKey`.
 * `fetcher` and `empty` are deliberately excluded from the effect's
 * dependency array: `key` already captures fetch identity, and a
 * fresh-but-equivalent closure passed in on every render (the normal
 * shape of an inline arrow function at the call site) must not
 * retrigger the fetch — only a real `key` change (or `active` flipping)
 * may. */
export function useModeFetch<T>(active: boolean, key: string, fetcher: () => Promise<T>, empty: T): ModeFetchState<T> {
  const [data, setData] = useState<T>(empty)
  const [loading, setLoading] = useState(false)
  const fetchKeyRef = useRef<string | null>(null)

  useEffect(() => {
    if (!active) {
      setLoading(false)
      return
    }
    if (fetchKeyRef.current === key) {
      setLoading(false)
      return
    }
    let cancelled = false
    setLoading(true)
    fetcher()
      .then((result) => {
        if (cancelled) return
        setData(result)
        fetchKeyRef.current = key
        setLoading(false)
      })
      .catch(() => {
        if (cancelled) return
        setData(empty)
        fetchKeyRef.current = null
        setLoading(false)
      })
    return () => { cancelled = true }
    // `fetcher` / `empty` deliberately excluded — see the doc comment above.
  }, [active, key])

  return { data, loading }
}
