// SPDX-License-Identifier: GPL-2.0-or-later
//
// Renderer-side state for imported Typing Test texts: list local
// entries and CRUD against the store. Mirrors useKeyLabels' cross-
// instance refresh signal so the modal and any other consumer stay in
// lockstep. Also clears the word-generator file-import-text cache on change
// so freshly imported / renamed text plays back correctly.

import { useCallback, useEffect, useRef, useState } from 'react'
import type {
  TypingTestTextMeta,
  TypingTestTextStoreResult,
} from '../../shared/types/typing-test-text-store'
import { clearFileImportTextCache } from '../typing-test/word-generator'
import { ensureSyncUnitAppliedBridge } from './use-sync-unit-applied'

const REFRESH_EVENT = 'pipette:typing-test-texts-changed'

function emitTypingTestTextsChanged(): void {
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new Event(REFRESH_EVENT))
  }
}

export interface UseTypingTestTextsReturn {
  metas: TypingTestTextMeta[]
  loading: boolean
  error: string | null
  refresh: () => Promise<void>
  importFromFile: () => Promise<TypingTestTextStoreResult<TypingTestTextMeta>>
  /** Commit the import that collided on name (after the user confirms). */
  confirmImport: () => Promise<TypingTestTextStoreResult<TypingTestTextMeta>>
  rename: (id: string, newName: string) => Promise<TypingTestTextStoreResult<TypingTestTextMeta>>
  remove: (id: string) => Promise<TypingTestTextStoreResult<void>>
}

export function useTypingTestTexts(): UseTypingTestTextsReturn {
  const [metas, setMetas] = useState<TypingTestTextMeta[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // Only the newest request may apply its response.
  const requestGenRef = useRef(0)
  const loudGenRef = useRef(0)

  // `silent` keeps `loading` and `error` untouched (background re-read).
  const load = useCallback(async (silent: boolean) => {
    const gen = ++requestGenRef.current
    if (!silent) {
      loudGenRef.current = gen
      setLoading(true)
      setError(null)
    }
    try {
      const result = await window.vialAPI.typingTestTextStoreList()
      if (gen !== requestGenRef.current) return
      if (!result.success || !result.data) {
        if (!silent) setError(result.error ?? 'Failed to load texts')
        return
      }
      setMetas(result.data)
    } catch (err) {
      if (!silent && gen === requestGenRef.current) setError(err instanceof Error ? err.message : String(err))
    } finally {
      if (!silent && gen === loudGenRef.current) setLoading(false)
    }
  }, [])

  const refresh = useCallback(() => load(false), [load])

  useEffect(() => {
    void refresh()
  }, [refresh])

  // Other hook instances and sync merges (via the sync-unit bridge) fire
  // REFRESH_EVENT.
  useEffect(() => {
    if (typeof window === 'undefined') return
    ensureSyncUnitAppliedBridge()
    const handler = (): void => {
      void load(true)
    }
    window.addEventListener(REFRESH_EVENT, handler)
    return () => window.removeEventListener(REFRESH_EVENT, handler)
  }, [load])

  const importFromFile = useCallback(async (): Promise<TypingTestTextStoreResult<TypingTestTextMeta>> => {
    const result = await window.vialAPI.typingTestTextStoreImport()
    if (result.success) {
      if (result.data) clearFileImportTextCache(result.data.id)
      await refresh()
      emitTypingTestTextsChanged()
    }
    return result
  }, [refresh])

  const confirmImport = useCallback(async (): Promise<TypingTestTextStoreResult<TypingTestTextMeta>> => {
    const result = await window.vialAPI.typingTestTextStoreImportConfirm()
    if (result.success) {
      if (result.data) clearFileImportTextCache(result.data.id)
      await refresh()
      emitTypingTestTextsChanged()
    }
    return result
  }, [refresh])

  const rename = useCallback(async (
    id: string,
    newName: string,
  ): Promise<TypingTestTextStoreResult<TypingTestTextMeta>> => {
    const result = await window.vialAPI.typingTestTextStoreRename(id, newName)
    if (result.success) {
      clearFileImportTextCache(id)
      await refresh()
      emitTypingTestTextsChanged()
    }
    return result
  }, [refresh])

  const remove = useCallback(async (id: string): Promise<TypingTestTextStoreResult<void>> => {
    const result = await window.vialAPI.typingTestTextStoreDelete(id)
    if (result.success) {
      clearFileImportTextCache(id)
      await refresh()
      emitTypingTestTextsChanged()
    }
    return result
  }, [refresh])

  return { metas, loading, error, refresh, importFromFile, confirmImport, rename, remove }
}
