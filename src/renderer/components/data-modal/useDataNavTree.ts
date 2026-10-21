// SPDX-License-Identifier: GPL-2.0-or-later

import { useState, useEffect, useRef, useCallback, useMemo } from 'react'
import type { DataNavPath } from './data-modal-types'
import type { StoredKeyboardInfo, SyncDataScanResult } from '../../../shared/types/sync'
import type { TypingKeyboardSummary } from '../../../shared/types/typing-analytics'
import { useLatestRequest } from '../../hooks/use-latest-request'
import { affectsStoredKeyboards, useSyncUnitApplied } from '../../hooks/use-sync-unit-applied'
import { byDisplayName, syncKeyboardName } from './sync-keyboard-name'

export interface UseDataNavTreeOptions {
  showHubTab: boolean
  syncEnabled: boolean
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : 'Download failed'
}

// Persist tree state across modal open/close within the same session
let cachedExpandedNodes: Set<string> | null = null
let cachedActivePath: DataNavPath | null = null

/** Reset cached state (for testing) */
export function resetDataNavCache(): void {
  cachedExpandedNodes = null
  cachedActivePath = null
}

export function useDataNavTree({ showHubTab, syncEnabled }: UseDataNavTreeOptions) {
  const [storedKeyboards, setStoredKeyboards] = useState<StoredKeyboardInfo[]>([])
  const [typingKeyboards, setTypingKeyboards] = useState<TypingKeyboardSummary[]>([])
  const [expandedNodes, setExpandedNodes] = useState<Set<string>>(
    () => cachedExpandedNodes ?? new Set(),
  )
  const [activePath, setActivePath] = useState<DataNavPath | null>(cachedActivePath)
  const fetchedRef = useRef(false)
  const typingFetchedRef = useRef(false)

  // Sync scan state
  const [syncScanResult, setSyncScanResult] = useState<SyncDataScanResult | null>(null)
  const [syncScanning, setSyncScanning] = useState(false)
  // Whether the scan has run since the sync was last enabled.
  const syncScannedRef = useRef(false)
  // Bumped when the sync is disabled, so a read of Drive started before
  // (possibly for another account) does not apply its answer.
  const syncGenerationRef = useRef(0)

  // Remote typing hashes keyed by uid — populated lazily when the user
  // expands Sync > Typing > {keyboard} so startup stays quiet.
  const [remoteTypingHashes, setRemoteTypingHashes] = useState<Record<string, string[]>>({})
  const remoteTypingFetchedRef = useRef<Set<string>>(new Set())
  const refreshRemoteTypingHashes = useCallback(async (uid: string) => {
    const generation = syncGenerationRef.current
    const apply = (hashes: string[]) => {
      if (generation === syncGenerationRef.current) setRemoteTypingHashes((prev) => ({ ...prev, [uid]: hashes }))
    }
    try {
      // Merge cache-known hashes (immediate) with cloud-discovered
      // hashes (authoritative) so a device we've never fetched from
      // still appears in the Sync > Typing tree. Cache-known hashes come
      // from the device-info bundle.
      const [infoBundle, cloud] = await Promise.all([
        window.vialAPI.typingAnalyticsListDeviceInfos(uid),
        window.vialAPI.typingAnalyticsListRemoteCloudHashes(uid),
      ])
      const local = infoBundle ? infoBundle.remotes.map((r) => r.machineHash) : []
      apply(Array.from(new Set<string>([...local, ...cloud])).sort())
    } catch {
      apply([])
    }
  }, [])
  const ensureRemoteTypingHashes = useCallback((uid: string) => {
    if (remoteTypingFetchedRef.current.has(uid)) return
    remoteTypingFetchedRef.current.add(uid)
    void refreshRemoteTypingHashes(uid)
  }, [refreshRemoteTypingHashes])

  // Lazy-download state for sync keyboards
  const [downloadingUid, setDownloadingUid] = useState<string | null>(null)
  const [downloadErrorByUid, setDownloadErrorByUid] = useState<Record<string, string>>({})

  // Every read of the stored-keyboard list goes through here, so a slow
  // read never overwrites the result of one that started after it.
  const beginKeyboardsRequest = useLatestRequest()
  const readStoredKeyboards = useCallback(async (): Promise<{ keyboards: StoredKeyboardInfo[]; applied: boolean }> => {
    const isCurrent = beginKeyboardsRequest()
    const keyboards = await window.vialAPI.listStoredKeyboards()
    const applied = isCurrent()
    if (applied) setStoredKeyboards(keyboards)
    return { keyboards, applied }
  }, [beginKeyboardsRequest])

  useEffect(() => {
    if (fetchedRef.current) return
    fetchedRef.current = true
    readStoredKeyboards().catch(() => {})
  }, [readStoredKeyboards])

  useEffect(() => {
    if (typingFetchedRef.current) return
    typingFetchedRef.current = true
    window.vialAPI.typingAnalyticsListKeyboards().then(setTypingKeyboards).catch(() => {})
  }, [])

  // Auto-scan sync when enabled. Only the newest scan sets the result and
  // ends `syncScanning`, so an older one that ends later is dropped.
  const beginScanRequest = useLatestRequest()
  const handleSyncScan = useCallback(async () => {
    const isCurrent = beginScanRequest()
    setSyncScanning(true)
    const result = await window.vialAPI.syncScanRemote().catch(() => null)
    if (!isCurrent()) return
    setSyncScanResult(result)
    setSyncScanning(false)
  }, [beginScanRequest])

  // Once each time the sync becomes enabled (signing in again rescans with
  // fresh names); the ref keeps a double-run effect from scanning twice.
  // Disabling it drops what was read from Drive, which may belong to the
  // account signed out of.
  useEffect(() => {
    if (!syncEnabled) {
      syncScannedRef.current = false
      syncGenerationRef.current++
      beginScanRequest()
      setSyncScanning(false)
      setSyncScanResult(null)
      remoteTypingFetchedRef.current.clear()
      setRemoteTypingHashes((prev) => (Object.keys(prev).length === 0 ? prev : {}))
      return
    }
    if (syncScannedRef.current) return
    syncScannedRef.current = true
    void handleSyncScan()
  }, [syncEnabled, handleSyncScan, beginScanRequest])

  // Filter sync scan result: exclude keyboards that exist locally
  const filteredSyncScanResult = useMemo(() => {
    if (!syncScanResult) return null
    const localUids = new Set(storedKeyboards.map((kb) => kb.uid))
    return {
      ...syncScanResult,
      keyboards: syncScanResult.keyboards.filter((uid) => !localUids.has(uid)),
      favorites: [], // Favorites are always managed locally
    }
  }, [syncScanResult, storedKeyboards])

  // Sync > Typing: the local typing keyboards and those the scan found
  // another device's typing days of, named as Sync > Keyboards names them
  // (a local keyboard's product name comes before its uid); none while the
  // sync is off.
  const syncTypingKeyboards = useMemo(() => {
    if (!syncEnabled) return []
    const fallbacks = new Map(typingKeyboards.map((kb) => [kb.uid, kb.productName || kb.uid]))
    for (const uid of syncScanResult?.typingKeyboards ?? []) {
      if (!fallbacks.has(uid)) fallbacks.set(uid, uid)
    }
    return [...fallbacks]
      .map(([uid, fallback]) => ({ uid, name: syncKeyboardName(uid, syncScanResult, storedKeyboards, fallback) }))
      .sort((a, b) => byDisplayName(a.name, b.name))
  }, [syncEnabled, typingKeyboards, syncScanResult, storedKeyboards])

  // Sync to cache on change
  useEffect(() => {
    cachedExpandedNodes = expandedNodes
  }, [expandedNodes])

  useEffect(() => {
    cachedActivePath = activePath
  }, [activePath])

  const refreshStoredKeyboards = useCallback(async () => {
    await readStoredKeyboards()
  }, [readStoredKeyboards])

  // A sync merge renamed a keyboard or rewrote its snapshots: re-read the
  // list and carry a new name into the open keyboard page, leaving the
  // tree's expansion and the selected page as they are.
  const reloadStoredKeyboardsAfterSync = useCallback(async () => {
    try {
      const { keyboards, applied } = await readStoredKeyboards()
      if (!applied) return
      setActivePath((prev) => {
        if (prev?.page !== 'keyboard') return prev
        const name = keyboards.find((kb) => kb.uid === prev.uid)?.name
        return name && name !== prev.name ? { ...prev, name } : prev
      })
    } catch {
      // keep the list on screen
    }
  }, [readStoredKeyboards])
  useSyncUnitApplied(affectsStoredKeyboards, () => { void reloadStoredKeyboardsAfterSync() })

  const refreshTypingKeyboards = useCallback(async () => {
    const keyboards = await window.vialAPI.typingAnalyticsListKeyboards().catch(() => [] as TypingKeyboardSummary[])
    setTypingKeyboards(keyboards)
  }, [])

  const onSyncKeyboardSelect = useCallback(
    async (uid: string, name: string) => {
      // Already local — switch immediately, no network needed
      const local = storedKeyboards.find((kb) => kb.uid === uid)
      if (local) {
        setActivePath({ section: 'local', page: 'keyboard', uid, name: local.name })
        return
      }
      // Block concurrent downloads: executeSync silently no-ops while another sync runs,
      // so dispatching multiple clicks would otherwise "succeed" without producing data.
      if (downloadingUid !== null) return
      setDownloadingUid(uid)
      setDownloadErrorByUid((prev) => {
        if (!(uid in prev)) return prev
        const next = { ...prev }
        delete next[uid]
        return next
      })
      try {
        await window.vialAPI.syncExecute('download', { keyboard: uid })
        const { keyboards: refreshed } = await readStoredKeyboards()
        const downloaded = refreshed.find((kb) => kb.uid === uid)
        if (downloaded) {
          setActivePath({ section: 'local', page: 'keyboard', uid, name: downloaded.name || name })
        } else {
          setDownloadErrorByUid((prev) => ({ ...prev, [uid]: 'Downloaded data not found locally' }))
        }
      } catch (err) {
        setDownloadErrorByUid((prev) => ({ ...prev, [uid]: errorMessage(err) }))
      } finally {
        setDownloadingUid(null)
      }
    },
    [storedKeyboards, downloadingUid, readStoredKeyboards],
  )

  const toggleExpand = useCallback((nodeId: string) => {
    setExpandedNodes((prev) => {
      const next = new Set(prev)
      if (next.has(nodeId)) next.delete(nodeId)
      else next.add(nodeId)
      return next
    })
  }, [])

  const isExpanded = useCallback((nodeId: string) => expandedNodes.has(nodeId), [expandedNodes])

  return {
    storedKeyboards,
    typingKeyboards,
    syncTypingKeyboards,
    expandedNodes,
    toggleExpand,
    isExpanded,
    activePath,
    setActivePath,
    showHubTab,
    refreshStoredKeyboards,
    refreshTypingKeyboards,
    syncScanResult: filteredSyncScanResult,
    // Unfiltered scan, threaded through to CloudDataContent (Sync >
    // Cloud Data) so it can reuse this same scan instead of running its
    // own second full download+decrypt pass — the filtered result above
    // intentionally zeroes `favorites` for the orphan-discovery tree,
    // which is wrong for Cloud Data's actual need (showing/resetting a
    // target's remote copy regardless of whether it's also filtered out
    // of that tree).
    rawSyncScanResult: syncScanResult,
    syncScanning,
    handleSyncScan,
    onSyncKeyboardSelect,
    downloadingUid,
    downloadErrorByUid,
    remoteTypingHashes,
    ensureRemoteTypingHashes,
  }
}
