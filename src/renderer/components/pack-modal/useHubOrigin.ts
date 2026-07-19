// SPDX-License-Identifier: GPL-2.0-or-later
//
// Fetches the Pipette Hub origin used to build "Open in browser" links.
// Two fetch strategies exist across the pack modals today:
//   - i18n / theme packs re-fetch every time the modal opens (`[open]` dep).
//   - Key Labels fetches exactly once on first mount, regardless of
//     subsequent open/close cycles.
// Both are preserved via the `onlyOnce` option rather than collapsed
// into a single behaviour, per the Phase 1 "no visible/behavioural
// change" rule. `onlyOnce` is a stable per-call-site choice (never
// toggles at runtime), so two plain effects — one gated on it, one
// gated on `open` — are clearer than folding both strategies into a
// single effect via a computed dependency-array entry.

import { useEffect, useState } from 'react'

export function useHubOrigin(open: boolean, options: { onlyOnce?: boolean } = {}): string {
  const { onlyOnce = false } = options
  const [hubOrigin, setHubOrigin] = useState('')

  // Key Labels: fetch exactly once, regardless of subsequent open/close cycles.
  useEffect(() => {
    if (!onlyOnce) return
    let cancelled = false
    void (async () => {
      try {
        const origin = await window.vialAPI.hubGetOrigin()
        if (!cancelled) setHubOrigin(origin)
      } catch {
        // best-effort; the Open link simply hides when origin stays empty
      }
    })()
    return () => { cancelled = true }
  }, [onlyOnce])

  // i18n / theme packs: re-fetch every time the modal opens.
  useEffect(() => {
    if (onlyOnce || !open) return
    void window.vialAPI.hubGetOrigin().then((origin) => { if (origin) setHubOrigin(origin) }).catch(() => null)
  }, [onlyOnce, open])

  return hubOrigin
}
