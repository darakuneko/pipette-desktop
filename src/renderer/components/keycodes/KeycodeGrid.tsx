// SPDX-License-Identifier: GPL-2.0-or-later

import type { Keycode } from '../../../shared/keycodes/keycodes'
import type { SplitKeyMode } from '../../../shared/types/app-config'
import { KeycodeButton } from './KeycodeButton'
import { SplitKey, getShiftedKeycode, type SplitKeySelectedPart } from './SplitKey'

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
  /** Global index map: base qmkId → { baseIdx, shiftedIdx } */
  keycodeIndexMap?: Map<string, { baseIdx: number; shiftedIdx?: number }>
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

/** Compute the selectedPart for a split key by checking expanded indices */
export function computeSplitSelectedPart(
  pickerSelectedIndices: Set<number> | undefined,
  baseIdx: number,
  shiftedIdx: number,
): SplitKeySelectedPart | undefined {
  if (!pickerSelectedIndices) return undefined
  const baseSel = pickerSelectedIndices.has(baseIdx)
  const shiftSel = pickerSelectedIndices.has(shiftedIdx)
  if (baseSel && shiftSel) return 'both'
  if (baseSel) return 'base'
  if (shiftSel) return 'shifted'
  return undefined
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
  keycodeIndexMap,
}: Props): React.ReactNode {
  const visible = isVisible ? keycodes.filter(isVisible) : keycodes
  const useSplit = splitKeyMode !== 'flat'

  return (
    <div className="flex flex-wrap gap-1">
      {visible.map((kc, visibleIdx) => {
        const entry = keycodeIndexMap?.get(kc.qmkId)
        const baseIdx = entry?.baseIdx ?? visibleIdx
        const shifted = useSplit ? getShiftedKeycode(kc.qmkId) : null
        const shiftedIdx = shifted ? entry?.shiftedIdx : undefined

        if (shifted && shiftedIdx != null) {
          const splitRemap = getSplitRemapProps(kc.qmkId, remapLabel)
          return (
            <div key={`${baseIdx}-${kc.qmkId}`} className="w-[44px] h-[44px]">
              <SplitKey
                base={kc}
                shifted={shifted}
                onClick={onClick}
                onDoubleClick={onDoubleClick}
                onHover={onHover}
                onHoverEnd={onHoverEnd}
                highlightedKeycodes={highlightedKeycodes}
                selectedPart={computeSplitSelectedPart(pickerSelectedIndices, baseIdx, shiftedIdx)}
                index={baseIdx}
                shiftedIndex={shiftedIdx}
                {...splitRemap}
              />
            </div>
          )
        }
        const displayLabel = getRemapDisplayLabel(kc.qmkId, remapLabel)
        return (
          <KeycodeButton
            key={`${baseIdx}-${kc.qmkId}`}
            keycode={kc}
            onClick={onClick ? (k, e) => onClick(k, e, baseIdx) : undefined}
            onDoubleClick={onDoubleClick}
            onHover={onHover}
            onHoverEnd={onHoverEnd}
            highlighted={highlightedKeycodes?.has(kc.qmkId)}
            selected={pickerSelectedIndices?.has(baseIdx)}
            displayLabel={displayLabel}
          />
        )
      })}
    </div>
  )
}
