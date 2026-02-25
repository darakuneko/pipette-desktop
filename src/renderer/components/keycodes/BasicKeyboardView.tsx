// SPDX-License-Identifier: GPL-2.0-or-later

import { useEffect, useRef, useState, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { ANSI_LAYOUTS, ISO_LAYOUTS, type DisplayLayoutDef } from './display-keyboard-defs'
import type { BasicViewType } from '../../../shared/types/app-config'
import { DisplayKeyboard } from './DisplayKeyboard'
import { KeycodeGrid } from './KeycodeGrid'
import { KEYCODE_CATEGORIES, groupByLayoutRow, type KeycodeGroup } from './categories'
import {
  KEYCODES_SPECIAL,
  KEYCODES_BASIC,
  type Keycode,
  findKeycode,
} from '../../../shared/keycodes/keycodes'
import { parseKle } from '../../../shared/kle/kle-parser'

interface Props {
  viewType: BasicViewType
  onKeycodeClick?: (keycode: Keycode, event: React.MouseEvent) => void
  onKeycodeHover?: (keycode: Keycode, rect: DOMRect) => void
  onKeycodeHoverEnd?: () => void
  highlightedKeycodes?: Set<string>
  pickerSelectedKeycodes?: Set<string>
  isVisible?: (kc: Keycode) => boolean
}

/** Collect all QMK IDs present in a KLE layout definition */
function collectLayoutQmkIds(kle: unknown[][]): Set<string> {
  const layout = parseKle(kle)
  const ids = new Set<string>()
  for (const key of layout.keys) {
    const qmkId = key.labels[0]
    if (qmkId && findKeycode(qmkId)) ids.add(qmkId)
  }
  return ids
}

function defaultIsVisible(kc: Keycode): boolean {
  return !kc.hidden
}

/** Get the basic category groups definition for a given view type */
function getBasicGroups(viewType: string): KeycodeGroup[] {
  const basic = KEYCODE_CATEGORIES.find((c) => c.id === 'basic')
  return basic?.getGroups?.(viewType) ?? []
}

/** Group remaining keycodes by their basic category group */
function getRemainingGroups(layout: DisplayLayoutDef, visCheck: (kc: Keycode) => boolean, viewType: string): KeycodeGroup[] {
  const shownIds = collectLayoutQmkIds(layout.kle)
  const groups = getBasicGroups(viewType)
  const result: KeycodeGroup[] = []

  for (const group of groups) {
    const remaining = group.keycodes.filter((kc) => !shownIds.has(kc.qmkId) && visCheck(kc))
    if (remaining.length > 0) {
      result.push({ labelKey: group.labelKey, keycodes: remaining, layoutRow: group.layoutRow })
    }
  }

  return result
}

export function BasicKeyboardView({
  viewType,
  onKeycodeClick,
  onKeycodeHover,
  onKeycodeHoverEnd,
  highlightedKeycodes,
  pickerSelectedKeycodes,
  isVisible,
}: Props) {
  const { t } = useTranslation()
  const containerRef = useRef<HTMLDivElement>(null)
  const [containerWidth, setContainerWidth] = useState(0)

  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        setContainerWidth(entry.contentRect.width)
      }
    })
    observer.observe(el)
    return () => observer.disconnect()
  }, [])

  const visCheck = isVisible ?? defaultIsVisible

  const layouts = viewType === 'iso' ? ISO_LAYOUTS : ANSI_LAYOUTS

  const selectedLayout = useMemo<DisplayLayoutDef | null>(() => {
    for (const def of layouts) {
      if (containerWidth >= def.minWidth) return def
    }
    return null
  }, [containerWidth, layouts])

  const remainingRows = useMemo(() => {
    if (!selectedLayout) return []
    const groups = getRemainingGroups(selectedLayout, visCheck, viewType)
    return groupByLayoutRow(groups)
  }, [selectedLayout, visCheck, viewType])

  const flatKeycodes = useMemo(() => {
    return [...KEYCODES_SPECIAL, ...KEYCODES_BASIC].filter(visCheck)
  }, [visCheck])

  function renderKeycodeGrid(keycodes: Keycode[]) {
    return (
      <KeycodeGrid
        keycodes={keycodes}
        onClick={onKeycodeClick}
        onHover={onKeycodeHover}
        onHoverEnd={onKeycodeHoverEnd}
        highlightedKeycodes={highlightedKeycodes}
        pickerSelectedKeycodes={pickerSelectedKeycodes}
        isVisible={visCheck}
      />
    )
  }

  return (
    <div ref={containerRef}>
      {selectedLayout ? (
        <>
          <DisplayKeyboard
            kle={selectedLayout.kle}
            onKeycodeClick={onKeycodeClick}
            onKeycodeHover={onKeycodeHover}
            onKeycodeHoverEnd={onKeycodeHoverEnd}
            highlightedKeycodes={highlightedKeycodes}
            pickerSelectedKeycodes={pickerSelectedKeycodes}
          />
          {remainingRows.length > 0 && (
            <div className="mt-1">
              {remainingRows.map((row) => (
                <div key={row[0].labelKey} className="flex gap-x-3">
                  {row.map((group) => (
                    <div key={group.labelKey}>
                      <h4 className="text-xs font-normal text-content-muted px-1 pt-2 pb-1">
                        {t(group.labelKey)}
                      </h4>
                      {renderKeycodeGrid(group.keycodes)}
                    </div>
                  ))}
                </div>
              ))}
            </div>
          )}
        </>
      ) : (
        renderKeycodeGrid(flatKeycodes)
      )}
    </div>
  )
}
