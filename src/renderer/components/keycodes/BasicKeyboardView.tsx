// SPDX-License-Identifier: GPL-2.0-or-later

import { useEffect, useRef, useState, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { DISPLAY_LAYOUTS, type DisplayLayoutDef } from './display-keyboard-defs'
import { DisplayKeyboard } from './DisplayKeyboard'
import { KeycodeButton } from './KeycodeButton'
import { KEYCODE_CATEGORIES, type KeycodeGroup } from './categories'
import {
  KEYCODES_SPECIAL,
  KEYCODES_SHIFTED,
  KEYCODES_BASIC,
  type Keycode,
  findKeycode,
} from '../../../shared/keycodes/keycodes'
import { parseKle } from '../../../shared/kle/kle-parser'

interface Props {
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

/** Get the basic category groups definition */
function getBasicGroups(): KeycodeGroup[] {
  const basic = KEYCODE_CATEGORIES.find((c) => c.id === 'basic')
  return basic?.getGroups?.() ?? []
}

interface RemainingGroup {
  labelKey: string
  keycodes: Keycode[]
}

/** Group remaining keycodes by their basic category group */
function getRemainingGroups(layout: DisplayLayoutDef, visCheck: (kc: Keycode) => boolean): RemainingGroup[] {
  const shownIds = collectLayoutQmkIds(layout.kle)
  const groups = getBasicGroups()
  const result: RemainingGroup[] = []

  for (const group of groups) {
    const remaining = group.keycodes.filter((kc) => !shownIds.has(kc.qmkId) && visCheck(kc))
    if (remaining.length > 0) {
      result.push({ labelKey: group.labelKey, keycodes: remaining })
    }
  }

  return result
}

export function BasicKeyboardView({
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

  const selectedLayout = useMemo<DisplayLayoutDef | null>(() => {
    for (const def of DISPLAY_LAYOUTS) {
      if (containerWidth >= def.minWidth) return def
    }
    return null
  }, [containerWidth])

  const remainingGroups = useMemo(() => {
    if (!selectedLayout) return []
    return getRemainingGroups(selectedLayout, visCheck)
  }, [selectedLayout, visCheck])

  const flatKeycodes = useMemo(() => {
    return [...KEYCODES_SPECIAL, ...KEYCODES_BASIC, ...KEYCODES_SHIFTED].filter(visCheck)
  }, [visCheck])

  function renderKeycodeGrid(keycodes: Keycode[]) {
    return (
      <div className="flex flex-wrap gap-1">
        {keycodes.map((kc) => (
          <KeycodeButton
            key={kc.qmkId}
            keycode={kc}
            onClick={onKeycodeClick}
            onHover={onKeycodeHover}
            onHoverEnd={onKeycodeHoverEnd}
            highlighted={highlightedKeycodes?.has(kc.qmkId)}
            selected={pickerSelectedKeycodes?.has(kc.qmkId)}
          />
        ))}
      </div>
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
          {remainingGroups.length > 0 && (
            <div className="mt-1">
              {remainingGroups.map((group) => (
                <div key={group.labelKey}>
                  <h4 className="text-xs font-normal text-content-muted px-1 pt-2 pb-1">
                    {t(group.labelKey)}
                  </h4>
                  {renderKeycodeGrid(group.keycodes)}
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
