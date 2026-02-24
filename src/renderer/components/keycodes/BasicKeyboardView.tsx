// SPDX-License-Identifier: GPL-2.0-or-later

import { useCallback, useEffect, useRef, useState, useMemo } from 'react'
import { DISPLAY_LAYOUTS, type DisplayLayoutDef } from './display-keyboard-defs'
import { DisplayKeyboard } from './DisplayKeyboard'
import { KeycodeButton } from './KeycodeButton'
import {
  KEYCODES_SPECIAL,
  KEYCODES_SHIFTED,
  KEYCODES_BASIC,
  KEYCODES_BASIC_NUMPAD,
  KEYCODES_BASIC_NAV,
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

/** Get remaining keycodes not shown in the keyboard layout, based on layout size */
function getRemainingKeycodes(layout: DisplayLayoutDef): Keycode[] {
  const shownIds = collectLayoutQmkIds(layout.kle)
  const remaining: Keycode[] = []

  // Always show: KEYCODES_SPECIAL + KEYCODES_SHIFTED (not on any physical layout)
  for (const kc of KEYCODES_SPECIAL) {
    if (!shownIds.has(kc.qmkId)) remaining.push(kc)
  }
  for (const kc of KEYCODES_SHIFTED) {
    if (!shownIds.has(kc.qmkId)) remaining.push(kc)
  }

  // Conditionally show based on layout size
  if (layout.id !== 'ansi_100') {
    // 80% and 70% don't have numpad
    for (const kc of KEYCODES_BASIC_NUMPAD) {
      if (!shownIds.has(kc.qmkId)) remaining.push(kc)
    }
  }
  if (layout.id === 'ansi_70') {
    // 70% doesn't have nav cluster
    for (const kc of KEYCODES_BASIC_NAV) {
      if (!shownIds.has(kc.qmkId)) remaining.push(kc)
    }
  }

  return remaining
}

export function BasicKeyboardView({
  onKeycodeClick,
  onKeycodeHover,
  onKeycodeHoverEnd,
  highlightedKeycodes,
  pickerSelectedKeycodes,
  isVisible,
}: Props) {
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

  const selectedLayout = useMemo<DisplayLayoutDef | null>(() => {
    for (const def of DISPLAY_LAYOUTS) {
      if (containerWidth >= def.minWidth) return def
    }
    return null
  }, [containerWidth])

  const remainingKeycodes = useMemo(() => {
    if (!selectedLayout) return null
    return getRemainingKeycodes(selectedLayout)
  }, [selectedLayout])

  const defaultIsVisible = useCallback((kc: Keycode) => !kc.hidden, [])
  const visCheck = isVisible ?? defaultIsVisible

  // Flat fallback: all basic keycodes
  const flatKeycodes = useMemo(() => {
    return [...KEYCODES_SPECIAL, ...KEYCODES_BASIC, ...KEYCODES_SHIFTED].filter(visCheck)
  }, [visCheck])

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
          {remainingKeycodes && remainingKeycodes.filter(visCheck).length > 0 && (
            <div className="mt-2 flex flex-wrap gap-1">
              {remainingKeycodes.filter(visCheck).map((kc) => (
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
          )}
        </>
      ) : (
        <div className="flex flex-wrap gap-1">
          {flatKeycodes.map((kc) => (
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
      )}
    </div>
  )
}
