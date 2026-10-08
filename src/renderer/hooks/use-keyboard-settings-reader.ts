// SPDX-License-Identifier: GPL-2.0-or-later
//
// Keeps a component's own copy of one keyboard's settings file current. It
// reads the file when `uid` changes and again, silently, when a Cloud Sync
// merge rewrote that keyboard's settings (`keyboards/{uid}/settings`). The
// Analyze readers pass the keyboard they show, which can differ from the
// connected one (`useDevicePrefs` follows that one).
//
// Only the newest read applies, and only while `uid` is still the keyboard
// it read. A local write passed through `trackWrite` drops a read in flight
// and holds new reads back until every tracked write settles, then reads
// once more, so a reload never puts back a value the user just changed.

import { useCallback, useEffect, useRef } from 'react'
import { useLatestRef } from './use-latest-ref'
import { useSyncUnitApplied } from './use-sync-unit-applied'
import { isSameValue } from '../utils/same-value'
import type { PipetteSettings } from '../../shared/types/pipette-settings'

export interface KeyboardSettingsReader {
  /** Wraps a local write of this keyboard's settings (see the module
   *  comment). Resolves / rejects like `write`. */
  trackWrite: <T>(write: Promise<T>) => Promise<T>
}

export interface KeyboardSettingsReaderOptions {
  /** False when the caller reads the file itself on a uid change; the hook
   *  then reads only after a merge. Default true. */
  initialRead?: boolean
}

/** Returns `prev` when `next` is structurally equal (or has the same
 *  `key`), so a reload that changed nothing keeps the identity consumers
 *  depend on and does not re-render. */
export function keepIfSame<T>(prev: T, next: T, key?: (value: T) => string): T {
  const same = key ? key(prev) === key(next) : isSameValue(prev, next)
  return same ? prev : next
}

/** `onRead` receives the file, or `null` when the first read for this uid
 *  found no file or failed (and when `uid` is null). After the first
 *  delivery, a missing file or a failed read keeps what is shown. */
export function useKeyboardSettingsReader(
  uid: string | null,
  onRead: (prefs: PipetteSettings | null) => void,
  { initialRead = true }: KeyboardSettingsReaderOptions = {},
): KeyboardSettingsReader {
  const uidRef = useLatestRef(uid)
  const onReadRef = useLatestRef(onRead)
  const genRef = useRef(0)
  const writesRef = useRef(0)
  const readingRef = useRef(false)
  const owedRef = useRef(false)
  const deliveredRef = useRef(false)

  const read = useCallback(function read(): void {
    const readUid = uidRef.current
    if (readUid === null) return
    if (writesRef.current > 0) {
      owedRef.current = true
      return
    }
    const gen = ++genRef.current
    readingRef.current = true
    const settle = (prefs: PipetteSettings | null): void => {
      if (gen !== genRef.current || uidRef.current !== readUid) return
      readingRef.current = false
      if (prefs === null && deliveredRef.current) return
      deliveredRef.current = true
      onReadRef.current(prefs)
    }
    // The executor turns a synchronous IPC throw into a failed read.
    new Promise<PipetteSettings | null>((resolve) => { resolve(window.vialAPI.pipetteSettingsGet(readUid)) })
      .then(settle, () => settle(null))
  }, [uidRef, onReadRef])

  const wake = useCallback((): void => {
    if (!owedRef.current || writesRef.current > 0) return
    owedRef.current = false
    read()
  }, [read])

  useEffect(() => {
    // Drop reads started before the switch, including one for a uid that is
    // current again by the time it finishes (A -> B -> A).
    genRef.current++
    readingRef.current = false
    owedRef.current = false
    deliveredRef.current = !initialRead
    if (!initialRead) return
    if (uid === null) onReadRef.current(null)
    else read()
  }, [uid, initialRead, read, onReadRef])

  useSyncUnitApplied(
    (syncUnit) => uidRef.current !== null && syncUnit === `keyboards/${uidRef.current}/settings`,
    read,
  )

  const trackWrite = useCallback(async <T,>(write: Promise<T>): Promise<T> => {
    writesRef.current++
    genRef.current++
    if (readingRef.current) {
      readingRef.current = false
      owedRef.current = true
    }
    try {
      return await write
    } finally {
      writesRef.current--
      wake()
    }
  }, [wake])

  return { trackWrite }
}
