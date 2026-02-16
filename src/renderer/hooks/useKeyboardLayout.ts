// SPDX-License-Identifier: GPL-2.0-or-later

import { useCallback } from 'react'
import { LAYOUT_BY_ID, LAYOUT_ID_SET } from '../data/keyboard-layouts'
import type { KeyboardLayoutId } from '../data/keyboard-layouts'
import { useAppConfig } from './useAppConfig'

export type { KeyboardLayoutId }

function getRemapTable(layout: KeyboardLayoutId): Record<string, string> | null {
  const def = LAYOUT_BY_ID.get(layout)
  if (!def || Object.keys(def.map).length === 0) return null
  return def.map
}

export function remapKeycode(qmkId: string, layout: KeyboardLayoutId): string {
  const table = getRemapTable(layout)
  if (!table) return qmkId
  return table[qmkId] ?? qmkId
}

export function isRemappedKeycode(qmkId: string, layout: KeyboardLayoutId): boolean {
  const table = getRemapTable(layout)
  if (!table) return false
  return qmkId in table
}

interface UseKeyboardLayoutReturn {
  layout: KeyboardLayoutId
  setLayout: (layout: KeyboardLayoutId) => void
  remapLabel: (qmkId: string) => string
  isRemapped: (qmkId: string) => boolean
}

export function useKeyboardLayout(): UseKeyboardLayoutReturn {
  const { config, set } = useAppConfig()

  const layout = LAYOUT_ID_SET.has(config.currentKeyboardLayout)
    ? config.currentKeyboardLayout
    : 'qwerty'

  const setLayout = useCallback((newLayout: KeyboardLayoutId) => {
    set('currentKeyboardLayout', newLayout)
  }, [set])

  const remapLabel = useCallback(
    (qmkId: string): string => {
      return remapKeycode(qmkId, layout)
    },
    [layout],
  )

  const isRemapped = useCallback(
    (qmkId: string): boolean => {
      return isRemappedKeycode(qmkId, layout)
    },
    [layout],
  )

  return { layout, setLayout, remapLabel, isRemapped }
}
