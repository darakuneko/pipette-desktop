// SPDX-License-Identifier: GPL-2.0-or-later
//
// Renderer-side state for the Key Labels feature: list local entries,
// search Pipette Hub, and CRUD against both stores. Map lookups for
// `KeymapEditor` rendering live in `useKeyLabelLookup` (added in T8) so
// frequently-rendered keys do not pay for the modal-side state.

import { useCallback, useEffect, useState } from 'react'
import type {
  KeyLabelMeta,
  KeyLabelStoreResult,
} from '../../shared/types/key-label-store'
import type {
  HubKeyLabelListParams,
  HubKeyLabelListResponse,
  HubKeyLabelTimestampsResponse,
} from '../../shared/types/hub-key-label'

/**
 * Cross-instance refresh signal. Each `useKeyLabels()` mounts an
 * independent React state; without this fan-out, mutations from one
 * call site (e.g. the Key Labels modal downloading a label) never
 * reach another (e.g. SettingsToolsTab populating the layout dropdown).
 */
const REFRESH_EVENT = 'pipette:key-labels-changed'

function emitKeyLabelsChanged(): void {
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new Event(REFRESH_EVENT))
  }
}

export interface UseKeyLabelsReturn {
  metas: KeyLabelMeta[]
  loading: boolean
  error: string | null
  refresh: () => Promise<void>

  importFromFile: () => Promise<KeyLabelStoreResult<KeyLabelMeta>>
  exportEntry: (id: string) => Promise<KeyLabelStoreResult<{ filePath: string }>>
  reorder: (orderedIds: string[]) => Promise<KeyLabelStoreResult<void>>
  rename: (id: string, newName: string) => Promise<KeyLabelStoreResult<KeyLabelMeta>>
  remove: (id: string) => Promise<KeyLabelStoreResult<void>>

  hubSearch: (params: HubKeyLabelListParams) => Promise<KeyLabelStoreResult<HubKeyLabelListResponse>>
  hubDownload: (hubPostId: string) => Promise<KeyLabelStoreResult<KeyLabelMeta>>
  hubUpload: (id: string) => Promise<KeyLabelStoreResult<KeyLabelMeta>>
  hubUpdate: (id: string) => Promise<KeyLabelStoreResult<KeyLabelMeta>>
  hubSync: (id: string) => Promise<KeyLabelStoreResult<KeyLabelMeta>>
  hubTimestamps: (ids: string[]) => Promise<KeyLabelStoreResult<HubKeyLabelTimestampsResponse>>
  hubDelete: (id: string) => Promise<KeyLabelStoreResult<void>>
}

export function useKeyLabels(): UseKeyLabelsReturn {
  const [metas, setMetas] = useState<KeyLabelMeta[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const result = await window.vialAPI.keyLabelStoreList()
      if (!result.success || !result.data) {
        setError(result.error ?? 'Failed to load key labels')
        return
      }
      // Preserve the index.json order from the store (the user's drag
      // reorder + the "append on download" rule both rely on it).
      // Sorting client-side would fight `KEY_LABEL_STORE_REORDER`.
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

  // Listen for changes from other hook instances so the dropdown in
  // SettingsToolsTab and the modal stay in lockstep without a manual
  // page reload.
  useEffect(() => {
    if (typeof window === 'undefined') return
    const handler = (): void => {
      void refresh()
    }
    window.addEventListener(REFRESH_EVENT, handler)
    return () => window.removeEventListener(REFRESH_EVENT, handler)
  }, [refresh])

  const importFromFile = useCallback(async (): Promise<KeyLabelStoreResult<KeyLabelMeta>> => {
    const result = await window.vialAPI.keyLabelStoreImport()
    if (result.success) {
      await refresh()
      emitKeyLabelsChanged()
    }
    return result
  }, [refresh])

  const exportEntry = useCallback(async (
    id: string,
  ): Promise<KeyLabelStoreResult<{ filePath: string }>> => {
    return window.vialAPI.keyLabelStoreExport(id)
  }, [])

  const reorder = useCallback(async (
    orderedIds: string[],
  ): Promise<KeyLabelStoreResult<void>> => {
    const result = await window.vialAPI.keyLabelStoreReorder(orderedIds)
    if (result.success) {
      await refresh()
      emitKeyLabelsChanged()
    }
    return result
  }, [refresh])

  const rename = useCallback(async (
    id: string,
    newName: string,
  ): Promise<KeyLabelStoreResult<KeyLabelMeta>> => {
    const result = await window.vialAPI.keyLabelStoreRename(id, newName)
    if (result.success) {
      await refresh()
      emitKeyLabelsChanged()
    }
    return result
  }, [refresh])

  const remove = useCallback(async (id: string): Promise<KeyLabelStoreResult<void>> => {
    const result = await window.vialAPI.keyLabelStoreDelete(id)
    if (result.success) {
      await refresh()
      emitKeyLabelsChanged()
    }
    return result
  }, [refresh])

  const hubSearch = useCallback(async (
    params: HubKeyLabelListParams,
  ): Promise<KeyLabelStoreResult<HubKeyLabelListResponse>> => {
    return window.vialAPI.keyLabelHubList(params)
  }, [])

  const hubDownload = useCallback(async (
    hubPostId: string,
  ): Promise<KeyLabelStoreResult<KeyLabelMeta>> => {
    const result = await window.vialAPI.keyLabelHubDownload(hubPostId)
    if (result.success) {
      await refresh()
      emitKeyLabelsChanged()
    }
    return result
  }, [refresh])

  const hubUpload = useCallback(async (id: string): Promise<KeyLabelStoreResult<KeyLabelMeta>> => {
    const result = await window.vialAPI.keyLabelHubUpload(id)
    if (result.success) {
      await refresh()
      emitKeyLabelsChanged()
    }
    return result
  }, [refresh])

  const hubUpdate = useCallback(async (id: string): Promise<KeyLabelStoreResult<KeyLabelMeta>> => {
    const result = await window.vialAPI.keyLabelHubUpdate(id)
    if (result.success) {
      await refresh()
      emitKeyLabelsChanged()
    }
    return result
  }, [refresh])

  const hubSync = useCallback(async (id: string): Promise<KeyLabelStoreResult<KeyLabelMeta>> => {
    const result = await window.vialAPI.keyLabelHubSync(id)
    if (result.success) {
      await refresh()
      emitKeyLabelsChanged()
    }
    return result
  }, [refresh])

  const hubTimestamps = useCallback(async (
    ids: string[],
  ): Promise<KeyLabelStoreResult<HubKeyLabelTimestampsResponse>> => {
    return window.vialAPI.keyLabelHubTimestamps(ids)
  }, [])

  const hubDelete = useCallback(async (id: string): Promise<KeyLabelStoreResult<void>> => {
    const result = await window.vialAPI.keyLabelHubDelete(id)
    if (result.success) {
      await refresh()
      emitKeyLabelsChanged()
    }
    return result
  }, [refresh])

  return {
    metas,
    loading,
    error,
    refresh,
    importFromFile,
    exportEntry,
    reorder,
    rename,
    remove,
    hubSearch,
    hubDownload,
    hubUpload,
    hubUpdate,
    hubSync,
    hubTimestamps,
    hubDelete,
  }
}

