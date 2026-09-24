// SPDX-License-Identifier: GPL-2.0-or-later
//
// A ref that always holds the latest `value`. Callbacks that read it can
// keep one identity (`useCallback` with no data deps) while still seeing
// current props — the pattern the hover handlers use so the memoized key
// and encoder widgets they reach never re-render on a keymap edit.
//
// The ref is written in a layout effect, so it is current from the commit
// on. Reading it during render would see the previous value; read it only
// from event handlers and effects.

import { useLayoutEffect, useRef } from 'react'

export function useLatestRef<T>(value: T): { readonly current: T } {
  const ref = useRef(value)
  useLayoutEffect(() => {
    ref.current = value
  })
  return ref
}
