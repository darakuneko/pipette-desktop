// SPDX-License-Identifier: GPL-2.0-or-later

import { useCallback } from 'react'
import { LAYOUT_BY_ID, LAYOUT_ID_SET } from '../data/keyboard-layouts'
import type { KeyboardLayoutId } from '../data/keyboard-layouts'
import { useAppConfig } from './useAppConfig'

export type { KeyboardLayoutId }

export function remapKeycode(qmkId: string, layout: KeyboardLayoutId): string {
  const mapped = LAYOUT_BY_ID.get(layout)?.map[qmkId]
  return mapped !== undefined ? mapped : qmkId
}

/**
 * Resolve a display label for a qmkId, consulting the layout's
 * `compositeLabels` first (composite keycodes such as `LALT(KC_L)`),
 * then falling back to the basic-key `map`.
 *
 * Returns the original qmkId when neither source has an entry.
 */
export function remapLabel(qmkId: string, layout: KeyboardLayoutId): string {
  const def = LAYOUT_BY_ID.get(layout)
  if (!def) return qmkId
  const composite = def.compositeLabels?.[qmkId]
  if (composite !== undefined) return composite
  const mapped = def.map[qmkId]
  return mapped !== undefined ? mapped : qmkId
}

export function isRemappedKeycode(qmkId: string, layout: KeyboardLayoutId): boolean {
  const def = LAYOUT_BY_ID.get(layout)
  if (!def) return false
  if (def.compositeLabels && qmkId in def.compositeLabels) return true
  return qmkId in def.map
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

  const remapLabelCb = useCallback(
    (qmkId: string): string => {
      return remapLabel(qmkId, layout)
    },
    [layout],
  )

  const isRemapped = useCallback(
    (qmkId: string): boolean => {
      return isRemappedKeycode(qmkId, layout)
    },
    [layout],
  )

  return { layout, setLayout, remapLabel: remapLabelCb, isRemapped }
}
