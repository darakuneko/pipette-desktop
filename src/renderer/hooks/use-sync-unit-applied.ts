// SPDX-License-Identifier: GPL-2.0-or-later
//
// Turns the main process's "a sync merge rewrote this unit" notification
// into window events, so lists showing that unit can re-read it.
// One IPC subscription per window, shared by every listener.

import { useEffect } from 'react'
import { KEYBOARD_META_SYNC_UNIT } from '../../shared/types/keyboard-meta'
import { useLatestRef } from './use-latest-ref'
import type { VialAPI } from '../../shared/types/vial-api'

export const SYNC_UNIT_APPLIED_EVENT = 'pipette:sync-unit-applied'

// Unit names match KEY_LABEL_SYNC_UNIT (main/key-label-store.ts) and
// TYPING_TEST_TEXT_SYNC_UNIT (main/typing-test-text-store.ts). Those lists
// already refresh on their own change events (useKeyLabels.ts,
// useTypingTestTexts.ts, useKeyLabelLookup.ts), so the bridge re-dispatches them.
const STORE_CHANGE_EVENTS: Readonly<Record<string, string>> = {
  'key-labels': 'pipette:key-labels-changed',
  'typing-test-texts': 'pipette:typing-test-texts-changed',
}

const KEYBOARD_SNAPSHOTS_UNIT = /^keyboards\/[^/]+\/snapshots$/

/** Units that can change the stored-keyboard list (`listStoredKeyboards`):
 *  keyboard names and any keyboard's saved snapshots. */
export function affectsStoredKeyboards(syncUnit: string): boolean {
  return syncUnit === KEYBOARD_META_SYNC_UNIT || KEYBOARD_SNAPSHOTS_UNIT.test(syncUnit)
}

export interface SyncUnitAppliedDetail {
  syncUnit: string
}

let subscribedTo: VialAPI['syncOnUnitApplied'] | null = null
let unsubscribeBridge: (() => void) | null = null

/** Subscribes this window to the main-process notification once. Safe to
 *  call from every consumer; later calls are no-ops unless
 *  `window.vialAPI.syncOnUnitApplied` was replaced, in which case the old
 *  subscription is dropped and the new function subscribed. */
export function ensureSyncUnitAppliedBridge(): void {
  if (typeof window === 'undefined') return
  const subscribe = window.vialAPI?.syncOnUnitApplied
  // Test doubles of vialAPI may omit the subscription.
  if (typeof subscribe !== 'function' || subscribe === subscribedTo) return
  unsubscribeBridge?.()
  subscribedTo = subscribe
  unsubscribeBridge = subscribe((syncUnit) => {
    dispatchSyncUnitApplied(syncUnit)
    const storeEvent = STORE_CHANGE_EVENTS[syncUnit]
    if (storeEvent) window.dispatchEvent(new Event(storeEvent))
  })
}

/** Calls `onApplied` whenever a sync merge rewrote a unit `match` accepts.
 *  The latest `match` / `onApplied` are read through refs, so passing new
 *  closures each render does not resubscribe. */
export function useSyncUnitApplied(match: (syncUnit: string) => boolean, onApplied: () => void): void {
  const matchRef = useLatestRef(match)
  const onAppliedRef = useLatestRef(onApplied)

  useEffect(() => {
    ensureSyncUnitAppliedBridge()
    const handler = (event: Event): void => {
      const syncUnit = (event as CustomEvent<SyncUnitAppliedDetail>).detail?.syncUnit
      if (typeof syncUnit === 'string' && matchRef.current(syncUnit)) onAppliedRef.current()
    }
    window.addEventListener(SYNC_UNIT_APPLIED_EVENT, handler)
    return () => window.removeEventListener(SYNC_UNIT_APPLIED_EVENT, handler)
  }, [matchRef, onAppliedRef])
}

/** Fires the window event that `useSyncUnitApplied` listens to. */
export function dispatchSyncUnitApplied(syncUnit: string): void {
  window.dispatchEvent(new CustomEvent<SyncUnitAppliedDetail>(SYNC_UNIT_APPLIED_EVENT, { detail: { syncUnit } }))
}
