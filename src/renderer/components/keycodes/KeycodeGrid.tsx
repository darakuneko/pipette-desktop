// SPDX-License-Identifier: GPL-2.0-or-later

import type { Keycode } from '../../../shared/keycodes/keycodes'
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
}

export function KeycodeGrid({
  keycodes,
  onClick,
  onHover,
  onHoverEnd,
  highlightedKeycodes,
  pickerSelectedKeycodes,
  isVisible,
}: Props): React.ReactNode {
  const visible = isVisible ? keycodes.filter(isVisible) : keycodes

  return (
    <div className="flex flex-wrap gap-1">
      {visible.map((kc) => {
        const shifted = getShiftedKeycode(kc.qmkId)
        if (shifted && (!isVisible || isVisible(shifted))) {
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
              />
            </div>
          )
        }
        return (
          <KeycodeButton
            key={kc.qmkId}
            keycode={kc}
            onClick={onClick}
            onHover={onHover}
            onHoverEnd={onHoverEnd}
            highlighted={highlightedKeycodes?.has(kc.qmkId)}
            selected={pickerSelectedKeycodes?.has(kc.qmkId)}
          />
        )
      })}
    </div>
  )
}
