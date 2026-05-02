// SPDX-License-Identifier: GPL-2.0-or-later

import { useCallback, useEffect } from 'react'
import { LAYOUT_BY_ID } from '../data/keyboard-layouts'
import type { KeyboardLayoutId } from '../data/keyboard-layouts'
import { useAppConfig } from './useAppConfig'
import { useKeyLabelLookup } from './useKeyLabelLookup'

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
  const lookup = useKeyLabelLookup()

  // Accept any non-empty id so Key Labels installed via the modal are
  // honoured. The actual remap call falls back to QWERTY when the id
  // is not in the local store yet.
  const layout = typeof config.currentKeyboardLayout === 'string'
    && config.currentKeyboardLayout.length > 0
    ? config.currentKeyboardLayout
    : 'qwerty'

  // Make sure non-built-in layouts have their map cached. The lookup
  // bumps an internal version on success so the callbacks below see
  // the freshly-loaded map without an extra effect-driven setState.
  useEffect(() => {
    void lookup.ensure(layout)
  }, [lookup, layout])

  const setLayout = useCallback((newLayout: KeyboardLayoutId) => {
    set('currentKeyboardLayout', newLayout)
  }, [set])

  const remapLabelCb = useCallback(
    (qmkId: string): string => {
      const composite = lookup.getCompositeLabels(layout)?.[qmkId]
      if (composite !== undefined) return composite
      const mapped = lookup.getMap(layout)?.[qmkId]
      if (mapped !== undefined) return mapped
      return qmkId
    },
    [layout, lookup],
  )

  const isRemapped = useCallback(
    (qmkId: string): boolean => {
      const composite = lookup.getCompositeLabels(layout)
      if (composite && qmkId in composite) return true
      const map = lookup.getMap(layout)
      return Boolean(map && qmkId in map)
    },
    [layout, lookup],
  )

  return { layout, setLayout, remapLabel: remapLabelCb, isRemapped }
}
