// SPDX-License-Identifier: GPL-2.0-or-later

import { useState, useCallback, useMemo, useEffect, useRef } from 'react'
import { parseLayoutLabels, unpackLayoutOptions, packLayoutOptions } from '../../../shared/layout-options'
import { filterVisibleKeys, repositionLayoutKeys } from '../../../shared/kle/filter-keys'
import { KEY_UNIT, KEY_SPACING, KEYBOARD_PADDING } from '../keyboard/constants'
import type { KeyboardLayout } from '../../../shared/kle/types'

export interface UseLayoutOptionsPanelOptions {
  layout: KeyboardLayout | null
  layoutLabels?: (string | string[])[]
  packedLayoutOptions?: number
  onSetLayoutOptions?: (options: number) => Promise<void>
  layoutOptions: Map<number, number>
  scale: number
}

export interface UseLayoutOptionsPanelReturn {
  parsedOptions: ReturnType<typeof parseLayoutLabels>
  hasLayoutOptions: boolean
  layoutValues: Map<number, number>
  effectiveLayoutOptions: Map<number, number>
  handleLayoutOptionChange: (index: number, value: number) => Promise<void>
  keyboardAreaMinHeight: number
  selectableKeys: import('../../../shared/kle/types').KleKey[]
  layoutPanelOpen: boolean
  setLayoutPanelOpen: React.Dispatch<React.SetStateAction<boolean>>
  layoutPanelRef: React.RefObject<HTMLDivElement | null>
  layoutButtonRef: React.RefObject<HTMLButtonElement | null>
}

export function useLayoutOptionsPanel({
  layout,
  layoutLabels,
  packedLayoutOptions,
  onSetLayoutOptions,
  layoutOptions,
  scale,
}: UseLayoutOptionsPanelOptions): UseLayoutOptionsPanelReturn {
  const parsedOptions = useMemo(() => parseLayoutLabels(layoutLabels), [layoutLabels])
  const hasLayoutOptions = parsedOptions.length > 0

  const [layoutValues, setLayoutValues] = useState<Map<number, number>>(() =>
    packedLayoutOptions != null && packedLayoutOptions >= 0
      ? unpackLayoutOptions(packedLayoutOptions, parsedOptions)
      : new Map(),
  )

  useEffect(() => {
    if (packedLayoutOptions != null && packedLayoutOptions >= 0) {
      setLayoutValues(unpackLayoutOptions(packedLayoutOptions, parsedOptions))
    }
  }, [packedLayoutOptions, parsedOptions])

  const effectiveLayoutOptions = hasLayoutOptions ? layoutValues : layoutOptions

  const handleLayoutOptionChange = useCallback(
    async (index: number, value: number) => {
      const newValues = new Map(layoutValues)
      newValues.set(index, value)
      setLayoutValues(newValues)
      if (onSetLayoutOptions) {
        const packed = packLayoutOptions(newValues, parsedOptions)
        await onSetLayoutOptions(packed)
      }
    },
    [layoutValues, parsedOptions, onSetLayoutOptions],
  )

  // Pre-compute scaled min-height for the keyboard area container
  const keyboardAreaMinHeight = useMemo(() => {
    if (!layout || layout.keys.length === 0) return 0
    const visible = filterVisibleKeys(
      repositionLayoutKeys(layout.keys, effectiveLayoutOptions),
      effectiveLayoutOptions,
    )
    if (visible.length === 0) return 0
    const s = KEY_UNIT * scale
    const spacing = KEY_SPACING * scale
    let minY = Infinity
    let maxY = -Infinity
    for (const key of visible) {
      const x0 = s * key.x
      const y0 = s * key.y
      const x1 = s * (key.x + key.width) - spacing
      const y1 = s * (key.y + key.height) - spacing
      const corners: [number, number][] = [[x0, y0], [x1, y0], [x1, y1], [x0, y1]]
      const has2 = key.width2 !== key.width || key.height2 !== key.height || key.x2 !== 0 || key.y2 !== 0
      if (has2) {
        const sx0 = x0 + s * key.x2
        const sy0 = y0 + s * key.y2
        const sx1 = s * (key.x + key.x2 + key.width2) - spacing
        const sy1 = s * (key.y + key.y2 + key.height2) - spacing
        corners.push([sx0, sy0], [sx1, sy0], [sx1, sy1], [sx0, sy1])
      }
      if (key.rotation !== 0) {
        const cx = s * key.rotationX
        const cy = s * key.rotationY
        const rad = (key.rotation * Math.PI) / 180
        const cos = Math.cos(rad)
        const sin = Math.sin(rad)
        for (const [px, py] of corners) {
          const ry = cy + (px - cx) * sin + (py - cy) * cos
          if (ry < minY) minY = ry
          if (ry > maxY) maxY = ry
        }
      } else {
        for (const [, py] of corners) {
          if (py < minY) minY = py
          if (py > maxY) maxY = py
        }
      }
    }
    const fixedChrome = KEYBOARD_PADDING * 2 + 20 + 16
    return maxY - minY + fixedChrome
  }, [layout, effectiveLayoutOptions, scale])

  // Visible non-encoder, non-decal keys for selection
  const selectableKeys = useMemo(() => {
    if (!layout) return []
    const opts = effectiveLayoutOptions
    return layout.keys.filter((key) => {
      if (key.encoderIdx >= 0 || key.decal) return false
      if (key.layoutIndex >= 0) {
        const sel = opts.get(key.layoutIndex)
        return sel === undefined ? key.layoutOption === 0 : key.layoutOption === sel
      }
      return true
    })
  }, [layout, effectiveLayoutOptions])

  // Layout overlay panel state
  const [layoutPanelOpen, setLayoutPanelOpen] = useState(false)
  const layoutPanelRef = useRef<HTMLDivElement>(null)
  const layoutButtonRef = useRef<HTMLButtonElement>(null)

  // Close layout panel on click-outside or Escape
  useEffect(() => {
    if (!layoutPanelOpen) return
    function onMouseDown(e: MouseEvent) {
      if (layoutPanelRef.current?.contains(e.target as Node) || layoutButtonRef.current?.contains(e.target as Node)) return
      setLayoutPanelOpen(false)
    }
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') setLayoutPanelOpen(false)
    }
    document.addEventListener('mousedown', onMouseDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('mousedown', onMouseDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [layoutPanelOpen])

  return {
    parsedOptions,
    hasLayoutOptions,
    layoutValues,
    effectiveLayoutOptions,
    handleLayoutOptionChange,
    keyboardAreaMinHeight,
    selectableKeys,
    layoutPanelOpen,
    setLayoutPanelOpen,
    layoutPanelRef,
    layoutButtonRef,
  }
}
