// SPDX-License-Identifier: GPL-2.0-or-later
//
// Renderer-side state for imported Typing Test texts: list local
// entries and CRUD against the store. Mirrors useKeyLabels' cross-
// instance refresh signal so the modal and any other consumer stay in
// lockstep. Also clears the word-generator custom-text cache on change
// so freshly imported / renamed text plays back correctly.

import { useCallback, useEffect, useState } from 'react'
import type {
  TypingTestTextMeta,
  TypingTestTextStoreResult,
} from '../../shared/types/typing-test-text-store'
import { clearCustomTextCache } from '../typing-test/word-generator'

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

  const refresh = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const result = await window.vialAPI.typingTestTextStoreList()
      if (!result.success || !result.data) {
        setError(result.error ?? 'Failed to load texts')
        return
      }
      setMetas(result.data)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  useEffect(() => {
    if (typeof window === 'undefined') return
    const handler = (): void => {
      void refresh()
    }
    window.addEventListener(REFRESH_EVENT, handler)
    return () => window.removeEventListener(REFRESH_EVENT, handler)
  }, [refresh])

  const importFromFile = useCallback(async (): Promise<TypingTestTextStoreResult<TypingTestTextMeta>> => {
    const result = await window.vialAPI.typingTestTextStoreImport()
    if (result.success) {
      if (result.data) clearCustomTextCache(result.data.id)
      await refresh()
      emitTypingTestTextsChanged()
    }
    return result
  }, [refresh])

  const confirmImport = useCallback(async (): Promise<TypingTestTextStoreResult<TypingTestTextMeta>> => {
    const result = await window.vialAPI.typingTestTextStoreImportConfirm()
    if (result.success) {
      if (result.data) clearCustomTextCache(result.data.id)
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
      clearCustomTextCache(id)
      await refresh()
      emitTypingTestTextsChanged()
    }
    return result
  }, [refresh])

  const remove = useCallback(async (id: string): Promise<TypingTestTextStoreResult<void>> => {
    const result = await window.vialAPI.typingTestTextStoreDelete(id)
    if (result.success) {
      clearCustomTextCache(id)
      await refresh()
      emitTypingTestTextsChanged()
    }
    return result
  }, [refresh])

  return { metas, loading, error, refresh, importFromFile, confirmImport, rename, remove }
}
