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

function isLiteralToken(token: string): boolean {
  return /^-?(?:0x[0-9a-f]+|\d+)$/i.test(token)
}

function splitTopLevelArgs(content: string): string[] {
  const args: string[] = []
  let start = 0
  let depth = 0

  for (let i = 0; i < content.length; i++) {
    const ch = content[i]
    if (ch === '(') {
      depth++
    } else if (ch === ')') {
      depth = Math.max(0, depth - 1)
    } else if (ch === ',' && depth === 0) {
      args.push(content.slice(start, i))
      start = i + 1
    }
  }

  args.push(content.slice(start))
  return args
}

function remapNestedKeycode(qmkId: string, table: Record<string, string>): string {
  const direct = table[qmkId]
  if (direct !== undefined) return direct

  const openIdx = qmkId.indexOf('(')
  if (openIdx <= 0 || !qmkId.endsWith(')')) return qmkId

  const head = qmkId.slice(0, openIdx)
  const inner = qmkId.slice(openIdx + 1, -1)
  const args = splitTopLevelArgs(inner)
  if (args.length === 0) return qmkId

  const remappedArgs = args.map((arg) => {
    const trimmed = arg.trim()
    if (trimmed.length === 0 || isLiteralToken(trimmed)) return trimmed
    return remapNestedKeycode(trimmed, table)
  })

  return `${head}(${remappedArgs.join(',')})`
}

export function remapKeycode(qmkId: string, layout: KeyboardLayoutId): string {
  const table = getRemapTable(layout)
  if (!table) return qmkId
  return remapNestedKeycode(qmkId, table)
}

export function isRemappedKeycode(qmkId: string, layout: KeyboardLayoutId): boolean {
  return remapKeycode(qmkId, layout) !== qmkId
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
