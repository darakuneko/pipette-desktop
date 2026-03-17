// SPDX-License-Identifier: GPL-2.0-or-later

import { useState, useEffect, useRef, useCallback } from 'react'
import type { DataNavPath } from './data-modal-types'
import type { StoredKeyboardInfo } from '../../../shared/types/sync'

export interface UseDataNavTreeOptions {
  showHubTab: boolean
}

// Persist tree state across modal open/close within the same session
let cachedExpandedNodes: Set<string> | null = null
let cachedActivePath: DataNavPath | null = null

/** Reset cached state (for testing) */
export function resetDataNavCache(): void {
  cachedExpandedNodes = null
  cachedActivePath = null
}

export function useDataNavTree({ showHubTab }: UseDataNavTreeOptions) {
  const [storedKeyboards, setStoredKeyboards] = useState<StoredKeyboardInfo[]>([])
  const [expandedNodes, setExpandedNodes] = useState<Set<string>>(
    () => cachedExpandedNodes ?? new Set(),
  )
  const [activePath, setActivePath] = useState<DataNavPath | null>(cachedActivePath)
  const fetchedRef = useRef(false)

  useEffect(() => {
    if (fetchedRef.current) return
    fetchedRef.current = true
    window.vialAPI.listStoredKeyboards().then(setStoredKeyboards).catch(() => {})
  }, [])

  // Sync to cache on change
  useEffect(() => {
    cachedExpandedNodes = expandedNodes
  }, [expandedNodes])

  useEffect(() => {
    cachedActivePath = activePath
  }, [activePath])

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
  }
}
