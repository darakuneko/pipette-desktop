// SPDX-License-Identifier: GPL-2.0-or-later
//
// Guards async list reads against out-of-order responses: only the newest
// request may apply its result, and a change of `scope` (e.g. the keyboard
// uid the list belongs to) invalidates every request already in flight.

import { useCallback, useEffect, useRef } from 'react'

/** Returns `begin()`. Call it when a request starts; the returned check is
 *  true only while that request is still the newest for the current scope. */
export function useLatestRequest(scope: string | number | null = null): () => () => boolean {
  const genRef = useRef(0)
  useEffect(() => {
    genRef.current++
  }, [scope])
  return useCallback(() => {
    const gen = ++genRef.current
    return () => gen === genRef.current
  }, [])
}
