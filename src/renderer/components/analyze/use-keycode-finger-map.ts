// SPDX-License-Identifier: GPL-2.0-or-later
// Memoised wrapper around `buildKeycodeFingerMap`. The hook hides the
// `snapshot.layout as KeyboardLayout | null` cast and the empty-keys /
// null-snapshot fallbacks so callers (BigramsChart's finger-pair view,
// the Profile card) don't repeat the same boilerplate. Returns an
// empty Map when the snapshot is missing or has no usable keys, so
// callers can branch on `result.size === 0`.

import { useMemo } from 'react'
import { buildKeycodeFingerMap } from './analyze-bigram-finger'
import type { FingerType } from '../../../shared/kle/kle-ergonomics'
import type { KeyboardLayout } from '../../../shared/kle/types'
import type { TypingKeymapSnapshot } from '../../../shared/types/typing-analytics'

export function useKeycodeFingerMap(
  snapshot: TypingKeymapSnapshot | null,
  fingerOverrides?: Record<string, FingerType>,
): ReadonlyMap<number, FingerType> {
  return useMemo(() => {
    if (snapshot === null) return new Map<number, FingerType>()
    const layout = snapshot.layout as KeyboardLayout | null
    const keys = layout?.keys ?? []
    if (keys.length === 0) return new Map<number, FingerType>()
    return buildKeycodeFingerMap(snapshot, keys, fingerOverrides)
  }, [snapshot, fingerOverrides])
}
