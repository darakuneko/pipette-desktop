// SPDX-License-Identifier: GPL-2.0-or-later
//
// Renderer-side state for the Key Labels feature: list local entries,
// search Pipette Hub, and CRUD against both stores. Map lookups for
// `KeymapEditor` rendering live in `useKeyLabelLookup` (added in T8) so
// frequently-rendered keys do not pay for the modal-side state.

import { useCallback, useEffect, useRef, useState } from 'react'
import { ensureSyncUnitAppliedBridge } from './use-sync-unit-applied'
import type {
  KeyLabelMeta,
  KeyLabelStoreResult,
  KeyLabelImportBatchResult,
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
  /** While held, change-event refreshes wait; one queued refresh runs on
   *  release. Used to keep rows still during a drag reorder. */
  holdChangeRefresh: (held: boolean) => void

  importFromFile: () => Promise<KeyLabelStoreResult<KeyLabelImportBatchResult>>
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
  // Starts true: the initial `refresh()` below fires from an effect
  // (after this first render commits), so `loading` must already read
  // true on that very first render for consumers that gate on it (e.g.
  // Key Labels' Name-sort `ready` flag) to correctly treat "not yet
  // fetched" as not-ready, rather than racing the effect.
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  // Only the newest request may apply its response.
  const requestGenRef = useRef(0)
  const loudGenRef = useRef(0)
  const heldRef = useRef(false)
  const queuedRef = useRef(false)

  // `silent` keeps `loading` and `error` untouched, so a background re-read
  // does not blank the list or reset consumers that gate on `loading`.
  const load = useCallback(async (silent: boolean) => {
    const gen = ++requestGenRef.current
    if (!silent) {
      loudGenRef.current = gen
      setLoading(true)
      setError(null)
    }
    try {
      const result = await window.vialAPI.keyLabelStoreList()
      if (gen !== requestGenRef.current) return
      // A background read that lands mid-drag could remove the dragged row;
      // drop it and read again on release. Explicit refreshes still apply.
      if (silent && heldRef.current) {
        queuedRef.current = true
        return
      }
      if (!result.success || !result.data) {
        if (!silent) setError(result.error ?? 'Failed to load key labels')
        return
      }
      // Preserve the index.json order from the store (the user's drag
      // reorder + the "append on download" rule both rely on it).
      // Sorting client-side would fight `KEY_LABEL_STORE_REORDER`.
      setMetas(result.data)
    } catch (err) {
      if (!silent && gen === requestGenRef.current) setError(err instanceof Error ? err.message : String(err))
    } finally {
      if (!silent && gen === loudGenRef.current) setLoading(false)
    }
  }, [])

  const refresh = useCallback(() => load(false), [load])

  const holdChangeRefresh = useCallback((held: boolean): void => {
    heldRef.current = held
    if (!held && queuedRef.current) {
      queuedRef.current = false
      void load(true)
    }
  }, [load])

  useEffect(() => {
    void refresh()
  }, [refresh])

  // Listen for changes from other hook instances (and sync merges, via the
  // sync-unit bridge) so the dropdown in SettingsToolsTab and the modal stay
  // in lockstep without a manual page reload.
  useEffect(() => {
    if (typeof window === 'undefined') return
    ensureSyncUnitAppliedBridge()
    const handler = (): void => {
      if (heldRef.current) {
        queuedRef.current = true
        return
      }
      void load(true)
    }
    window.addEventListener(REFRESH_EVENT, handler)
    return () => window.removeEventListener(REFRESH_EVENT, handler)
  }, [load])

  const importFromFile = useCallback(async (): Promise<KeyLabelStoreResult<KeyLabelImportBatchResult>> => {
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
    holdChangeRefresh,
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

