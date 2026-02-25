// SPDX-License-Identifier: GPL-2.0-or-later

import type { Keycode } from '../../../shared/keycodes/keycodes'
import type { SplitKeyMode } from '../../../shared/types/app-config'
import { KeycodeButton } from './KeycodeButton'
import { SplitKey, getShiftedKeycode } from './SplitKey'

interface Props {
  keycodes: Keycode[]
  onClick?: (keycode: Keycode, event: React.MouseEvent) => void
  onHover?: (keycode: Keycode, rect: DOMRect) => void
  onHoverEnd?: () => void
  highlightedKeycodes?: Set<string>
  pickerSelectedKeycodes?: Set<string>
  isVisible?: (kc: Keycode) => boolean
  splitKeyMode?: SplitKeyMode
  remapLabel?: (qmkId: string) => string
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
  onHover,
  onHoverEnd,
  highlightedKeycodes,
  pickerSelectedKeycodes,
  isVisible,
  splitKeyMode,
  remapLabel,
}: Props): React.ReactNode {
  const visible = isVisible ? keycodes.filter(isVisible) : keycodes
  const useSplit = splitKeyMode !== 'flat'

  return (
    <div className="flex flex-wrap gap-1">
      {visible.map((kc) => {
        const shifted = useSplit ? getShiftedKeycode(kc.qmkId) : null
        if (shifted && (!isVisible || isVisible(shifted))) {
          const splitRemap = getSplitRemapProps(kc.qmkId, remapLabel)
          return (
            <div key={kc.qmkId} className="w-[44px] h-[44px]">
              <SplitKey
                base={kc}
                shifted={shifted}
                onClick={onClick}
                onHover={onHover}
                onHoverEnd={onHoverEnd}
                highlightedKeycodes={highlightedKeycodes}
                pickerSelectedKeycodes={pickerSelectedKeycodes}
                {...splitRemap}
              />
            </div>
          )
        }
        const displayLabel = getRemapDisplayLabel(kc.qmkId, remapLabel)
        return (
          <KeycodeButton
            key={kc.qmkId}
            keycode={kc}
            onClick={onClick}
            onHover={onHover}
            onHoverEnd={onHoverEnd}
            highlighted={highlightedKeycodes?.has(kc.qmkId)}
            selected={pickerSelectedKeycodes?.has(kc.qmkId)}
            displayLabel={displayLabel}
          />
        )
      })}
    </div>
  )
}
