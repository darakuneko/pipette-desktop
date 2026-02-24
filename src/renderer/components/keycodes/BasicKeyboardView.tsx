// SPDX-License-Identifier: GPL-2.0-or-later

import { useEffect, useRef, useState, useMemo } from 'react'
import { DISPLAY_LAYOUTS, type DisplayLayoutDef } from './display-keyboard-defs'
import { DisplayKeyboard } from './DisplayKeyboard'
import { KeycodeButton } from './KeycodeButton'
import {
  KEYCODES_SPECIAL,
  KEYCODES_SHIFTED,
  KEYCODES_BASIC,
  KEYCODES_ISO,
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

/** All basic keycodes in display order (same as the basic category) */
const ALL_BASIC_KEYCODES: Keycode[] = [...KEYCODES_SPECIAL, ...KEYCODES_BASIC, ...KEYCODES_SHIFTED, ...KEYCODES_ISO]

/** Get all basic keycodes not present in the keyboard layout */
function getRemainingKeycodes(layout: DisplayLayoutDef): Keycode[] {
  const shownIds = collectLayoutQmkIds(layout.kle)
  return ALL_BASIC_KEYCODES.filter((kc) => !shownIds.has(kc.qmkId))
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

  const visCheck = isVisible ?? defaultIsVisible

  const selectedLayout = useMemo<DisplayLayoutDef | null>(() => {
    for (const def of DISPLAY_LAYOUTS) {
      if (containerWidth >= def.minWidth) return def
    }
    return null
  }, [containerWidth])

  const visibleRemainingKeycodes = useMemo(() => {
    if (!selectedLayout) return []
    return getRemainingKeycodes(selectedLayout).filter(visCheck)
  }, [selectedLayout, visCheck])

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
          {visibleRemainingKeycodes.length > 0 && (
            <div className="mt-2 flex flex-wrap gap-1">
              {visibleRemainingKeycodes.map((kc) => (
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
