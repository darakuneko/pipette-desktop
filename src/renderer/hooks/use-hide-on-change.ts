// SPDX-License-Identifier: GPL-2.0-or-later
//
// Runs `hide` after every commit in which any of `deps` changed (and on
// mount). Hover surfaces use it to close their bubble when the screen it
// was opened on changes underneath the pointer — a layer switch, a keymap
// edit, another keyboard — so the bubble never describes something that
// is no longer there. Pass a referentially stable `hide`, or the bubble
// closes on every render, and keep `deps` the same length on every call,
// as with any React dependency list.

import { useEffect, type DependencyList } from 'react'

export function useHideOnChange(hide: () => void, deps: DependencyList): void {
  useEffect(() => {
    hide()
  }, [hide, ...deps])
}
