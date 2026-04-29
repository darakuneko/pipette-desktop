// SPDX-License-Identifier: GPL-2.0-or-later
// Shared 5-colour palette for Ergonomics finger visualisation.
// Left + right share a colour per finger role (pinky / ring / middle
// / index / thumb) so the palette stays small and the hand is
// communicated by position rather than hue.
//
// Colours are pulled from the renderer-wide `chartSeriesColor` ramp
// so the Finger Assignment modal stays visually consistent with the
// Heatmap and other Analyze charts. Pinky lands on the warm end
// (most distal finger ↔ red), thumb on the cool end (most proximal
// ↔ blue), giving outer→inner readers a natural cool→warm gradient.

import type { FingerType } from '../../../shared/kle/kle-ergonomics'
import type { EffectiveTheme } from '../../hooks/useEffectiveTheme'
import { chartSeriesColor } from '../../utils/chart-palette'

const FINGER_ROLE_INDEX: Record<FingerType, number> = {
  'left-thumb': 0,
  'right-thumb': 0,
  'left-index': 1,
  'right-index': 1,
  'left-middle': 2,
  'right-middle': 2,
  'left-ring': 3,
  'right-ring': 3,
  'left-pinky': 4,
  'right-pinky': 4,
}

const FINGER_ROLE_COUNT = 5

export function fingerColor(finger: FingerType, theme: EffectiveTheme): string {
  return chartSeriesColor(FINGER_ROLE_INDEX[finger], FINGER_ROLE_COUNT, theme)
}

export function getFingerColors(theme: EffectiveTheme): Record<FingerType, string> {
  const out = {} as Record<FingerType, string>
  for (const finger of Object.keys(FINGER_ROLE_INDEX) as FingerType[]) {
    out[finger] = fingerColor(finger, theme)
  }
  return out
}
