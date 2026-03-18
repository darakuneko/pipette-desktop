// SPDX-License-Identifier: GPL-2.0-or-later

import type { Keycode } from '../../../shared/keycodes/keycodes'
import type { SplitKeyMode } from '../../../shared/types/app-config'
import { KeycodeButton } from './KeycodeButton'
import { SplitKey, getShiftedKeycode } from './SplitKey'

interface Props {
  keycodes: Keycode[]
  onClick?: (keycode: Keycode, event: React.MouseEvent, index: number) => void
  onDoubleClick?: (keycode: Keycode) => void
  onHover?: (keycode: Keycode, rect: DOMRect) => void
  onHoverEnd?: () => void
  highlightedKeycodes?: Set<string>
  pickerSelectedIndices?: Set<number>
  isVisible?: (kc: Keycode) => boolean
  splitKeyMode?: SplitKeyMode
  remapLabel?: (qmkId: string) => string
  /** Offset added to the index for each keycode (used when rendering a subset). */
  indexOffset?: number
}

/** Return remapped display label for a keycode, or undefined if unchanged */
export function getRemapDisplayLabel(qmkId: string, remapLabel?: (qmkId: string) => string): string | undefined {
  if (!remapLabel) return undefined
  const remapped = remapLabel(qmkId)
  return remapped !== qmkId ? remapped : undefined
}

/** Compute remap display props for a split key's base keycode */
export function getSplitRemapProps(qmkId: string, remapLabel?: (qmkId: string) => string) {
  const remapped = getRemapDisplayLabel(qmkId, remapLabel)
  if (remapped == null) return undefined
  if (remapped.includes('\n')) {
    const [shifted, base] = remapped.split('\n')
    return { baseDisplayLabel: base, shiftedDisplayLabel: shifted }
  }
  return { baseDisplayLabel: remapped }
}

export function KeycodeGrid({
  keycodes,
  onClick,
  onDoubleClick,
  onHover,
  onHoverEnd,
  highlightedKeycodes,
  pickerSelectedIndices,
  isVisible,
  splitKeyMode,
  remapLabel,
  indexOffset = 0,
}: Props): React.ReactNode {
  const visible = isVisible ? keycodes.filter(isVisible) : keycodes
  const useSplit = splitKeyMode !== 'flat'

  // Build index map: when filtering, we need the original index
  const indexMap = isVisible
    ? keycodes.reduce<number[]>((acc, kc, i) => { if (isVisible(kc)) acc.push(i); return acc }, [])
    : null

  return (
    <div className="flex flex-wrap gap-1">
      {visible.map((kc, visibleIdx) => {
        const originalIdx = (indexMap ? indexMap[visibleIdx] : visibleIdx) + indexOffset
        const shifted = useSplit ? getShiftedKeycode(kc.qmkId) : null
        if (shifted) {
          const splitRemap = getSplitRemapProps(kc.qmkId, remapLabel)
          return (
            <div key={`${originalIdx}-${kc.qmkId}`} className="w-[44px] h-[44px]">
              <SplitKey
                base={kc}
                shifted={shifted}
                onClick={onClick}
                onDoubleClick={onDoubleClick}
                onHover={onHover}
                onHoverEnd={onHoverEnd}
                highlightedKeycodes={highlightedKeycodes}
                selected={pickerSelectedIndices?.has(originalIdx)}
                index={originalIdx}
                {...splitRemap}
              />
            </div>
          )
        }
        const displayLabel = getRemapDisplayLabel(kc.qmkId, remapLabel)
        return (
          <KeycodeButton
            key={`${originalIdx}-${kc.qmkId}`}
            keycode={kc}
            onClick={onClick ? (k, e) => onClick(k, e, originalIdx) : undefined}
            onDoubleClick={onDoubleClick}
            onHover={onHover}
            onHoverEnd={onHoverEnd}
            highlighted={highlightedKeycodes?.has(kc.qmkId)}
            selected={pickerSelectedIndices?.has(originalIdx)}
            displayLabel={displayLabel}
          />
        )
      })}
    </div>
  )
}
