// SPDX-License-Identifier: GPL-2.0-or-later
// Language-pack aware keycode tooltip text. `Keycode.tooltip` is the
// English source and the fallback; `tooltipKey` points at the
// `keycodeTooltip.*` entry a pack may translate. Pass it to the shared
// `keycodeTooltip(qmkId, resolveText)` (keycodes-utils.ts) for the
// `"MO: <text>"` form.

import type { TFunction } from 'i18next'
import type { Keycode } from '../../../shared/keycodes/keycodes'

type TooltipSource = Partial<Pick<Keycode, 'tooltip' | 'tooltipKey' | 'tooltipParams'>>

export function translateKeycodeTooltip(t: TFunction, kc: TooltipSource): string | undefined {
  if (!kc.tooltipKey) return kc.tooltip
  return t(kc.tooltipKey, { ...kc.tooltipParams, defaultValue: kc.tooltip })
}
