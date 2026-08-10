// SPDX-License-Identifier: GPL-2.0-or-later

/** Ambient (background) matrix frame plumbing for useInputModes: the
 *  callback handed to useMatrixTester as `onAmbientFrame`, plus the refs
 *  it reads. Split out purely to keep useInputModes.ts's own body lean —
 *  everything here is single-purpose to that one callback and has no
 *  reason to live inline. */

import { useCallback, useRef } from 'react'
import type { RefObject } from 'react'

type ProcessMatrixFrameFn = (
  pressed: ReadonlySet<string>, keymap: Map<string, number>, options?: { ambient?: boolean },
) => void

// Stable identity across calls: passed straight through to
// processMatrixFrame, whose own dep on `options` (if it ever gained one)
// would otherwise see a fresh object every ambient frame.
const AMBIENT_OPTIONS = { ambient: true } as const

export interface UseAmbientMatrixFeedResult {
  /** Handed to useMatrixTester as its `onAmbientFrame` option. */
  onAmbientFrame: (pressed: Set<string>) => void
  /** The caller assigns `.current` render-phase from useTypingTest's
   *  `processMatrixFrame` (available only after that hook call — this hook
   *  is constructed before useMatrixTester/useTypingTest exist, so
   *  `onAmbientFrame`'s closure needs a ref to read the real function once
   *  it's ready). */
  processMatrixFrameRef: RefObject<ProcessMatrixFrameFn | null>
}

/** Feeds a background matrix poll frame straight into processMatrixFrame —
 *  one half of useInputModes's frame-supply split, the other half being
 *  its own state-driven effect (which feeds while typingTestMode instead,
 *  via pressedKeys/everPressedKeys state). The exclusivity guarantee
 *  between the two paths lives entirely in useMatrixTester's own poll
 *  routing: it never invokes `onAmbientFrame` at all while its OWN
 *  matrixMode is true (Key Tester UI, or a typing test in progress —
 *  beginTypingTest calls enterMatrixMode to make the matrix tester its
 *  input source), and its polling effect re-closes over matrixMode on
 *  every mode change (bumping the poll generation in cleanup), so there is
 *  no render window where a stale mode could route a frame here. This
 *  hook's own `typingTestModeRef` check below is a narrower, orthogonal
 *  guard: typingTestMode is a controlled prop owned by the parent, so a
 *  mode switch can land its prop update and useMatrixTester's matrixMode
 *  update in different commits — this ref keeps ambient delivery cut off
 *  for the whole span where typingTestMode is already true, independent of
 *  when matrixMode itself catches up. Both frame-supply paths ultimately
 *  call the exact same processMatrixFrame instance, so it never gets
 *  force-reset (no resetMatrixPressTracking, no fresh Map) across a switch
 *  the way a genuinely separate instance per path would. A key already
 *  held across the exact switch tick stays continuously "held" rather
 *  than producing a transitional release+press pair: useMatrixTester's
 *  own enterMatrixMode seeds pressedKeys/everPressedKeys from its last
 *  ambient frame in the same commit as the matrixMode flip (see
 *  lastAmbientFrameRef in use-matrix-tester.ts), so the state-driven
 *  effect below fires its first post-switch call against a pressedKeys
 *  value that already matches processMatrixFrame's own prevPressedRef —
 *  zero edges, so the switch itself neither drops nor double-counts the
 *  keystroke (pinned by useInputModes.ambient-frame.test.tsx). Passes
 *  `AMBIENT_OPTIONS` so
 *  processMatrixFrame also skips its layer-indicator state write (no
 *  editor re-render from a background poll tick). `onAmbientFrame`'s own
 *  identity is a stable useCallback ([]
 *  deps, reading only refs) — a fresh identity every render would flow
 *  into useMatrixTester's polling effect dependency array and restart its
 *  polling loop on every commit. */
export function useAmbientMatrixFeed(
  typingTestMode: boolean | undefined,
  keymap: Map<string, number>,
): UseAmbientMatrixFeedResult {
  const typingTestModeRef = useRef(typingTestMode)
  typingTestModeRef.current = typingTestMode
  const keymapRef = useRef(keymap)
  keymapRef.current = keymap
  const processMatrixFrameRef = useRef<ProcessMatrixFrameFn | null>(null)

  const onAmbientFrame = useCallback((pressed: Set<string>) => {
    if (typingTestModeRef.current) return
    processMatrixFrameRef.current?.(pressed, keymapRef.current, AMBIENT_OPTIONS)
  }, [])

  return { onAmbientFrame, processMatrixFrameRef }
}
