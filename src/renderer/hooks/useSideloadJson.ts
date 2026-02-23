// SPDX-License-Identifier: GPL-2.0-or-later

import { useCallback, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { KeyboardDefinition } from '../../shared/types/protocol'

export function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v)
}

export function isKeyboardDefinition(data: unknown): data is KeyboardDefinition {
  if (!isRecord(data)) return false

  const matrix = data.matrix
  if (
    !isRecord(matrix) ||
    typeof matrix.rows !== 'number' ||
    typeof matrix.cols !== 'number'
  ) {
    return false
  }

  const layouts = data.layouts
  if (!isRecord(layouts) || !Array.isArray(layouts.keymap)) {
    return false
  }

  if ('dynamic_keymap' in data && data.dynamic_keymap != null) {
    if (!isRecord(data.dynamic_keymap)) return false
    const lc = data.dynamic_keymap.layer_count
    if (lc != null && (typeof lc !== 'number' || !Number.isInteger(lc) || lc < 1 || lc > 32)) {
      return false
    }
  }

  return true
}

export function useSideloadJson(
  applyDefinition: (def: KeyboardDefinition) => void,
): { sideloadJson: () => Promise<void>; error: string | null } {
  const { t } = useTranslation()
  const [error, setError] = useState<string | null>(null)

  const sideloadJson = useCallback(async () => {
    setError(null)
    try {
      const result = await window.vialAPI.sideloadJson()
      if (!result.success) {
        if (result.error !== 'cancelled') {
          setError(t('error.sideloadFailed'))
        }
        return
      }
      if (!isKeyboardDefinition(result.data)) {
        setError(t('error.sideloadInvalidDefinition'))
        return
      }
      applyDefinition(result.data)
    } catch {
      setError(t('error.sideloadFailed'))
    }
  }, [applyDefinition, t])

  return { sideloadJson, error }
}
