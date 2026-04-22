// SPDX-License-Identifier: GPL-2.0-or-later
// Shared 5-colour palette for Ergonomics finger visualisation.
// Left + right share a colour per finger role (pinky / ring / middle
// / index / thumb) so the palette stays small and the hand is
// communicated by position rather than hue.

import type { FingerType } from '../../../shared/kle/kle-ergonomics'

export const FINGER_COLORS: Record<FingerType, string> = {
  'left-pinky': '#f07575',
  'right-pinky': '#f07575',
  'left-ring': '#f3a25a',
  'right-ring': '#f3a25a',
  'left-middle': '#74c287',
  'right-middle': '#74c287',
  'left-index': '#6aa8e0',
  'right-index': '#6aa8e0',
  'left-thumb': '#a88bd6',
  'right-thumb': '#a88bd6',
}
