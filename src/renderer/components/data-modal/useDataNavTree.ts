// SPDX-License-Identifier: GPL-2.0-or-later

import { useState, useEffect, useRef, useCallback, useMemo } from 'react'
import type { DataNavPath } from './data-modal-types'
import type { StoredKeyboardInfo, SyncDataScanResult } from '../../../shared/types/sync'

export interface UseDataNavTreeOptions {
  showHubTab: boolean
  syncEnabled: boolean
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
  const [expandedNodes, setExpandedNodes] = useState<Set<string>>(
    () => cachedExpandedNodes ?? new Set(),
  )
  const [activePath, setActivePath] = useState<DataNavPath | null>(cachedActivePath)
  const fetchedRef = useRef(false)

  // Sync scan state
  const [syncScanResult, setSyncScanResult] = useState<SyncDataScanResult | null>(null)
  const [syncScanning, setSyncScanning] = useState(false)
  const syncScannedRef = useRef(false)

  useEffect(() => {
    if (fetchedRef.current) return
    fetchedRef.current = true
    window.vialAPI.listStoredKeyboards().then(setStoredKeyboards).catch(() => {})
  }, [])

  // Auto-scan sync when enabled
  const handleSyncScan = useCallback(async () => {
    setSyncScanning(true)
    try {
      const result = await window.vialAPI.syncScanRemote()
      setSyncScanResult(result)
    } catch {
      setSyncScanResult(null)
    } finally {
      setSyncScanning(false)
    }
  }, [])

  useEffect(() => {
    if (!syncEnabled || syncScannedRef.current) return
    syncScannedRef.current = true
    void handleSyncScan()
  }, [syncEnabled, handleSyncScan])

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

  // Sync to cache on change
  useEffect(() => {
    cachedExpandedNodes = expandedNodes
  }, [expandedNodes])

  useEffect(() => {
    cachedActivePath = activePath
  }, [activePath])

  const refreshStoredKeyboards = useCallback(async () => {
    const keyboards = await window.vialAPI.listStoredKeyboards()
    setStoredKeyboards(keyboards)
  }, [])

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
    expandedNodes,
    toggleExpand,
    isExpanded,
    activePath,
    setActivePath,
    showHubTab,
    refreshStoredKeyboards,
    syncScanResult: filteredSyncScanResult,
    syncScanning,
    handleSyncScan,
  }
}
