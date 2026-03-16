// SPDX-License-Identifier: GPL-2.0-or-later

import { type MacroAction, deserializeAllMacros } from '../../../preload/macro'

export const KC_TRNS = 1
export const KC_NO = 0

export type KeycodeAction = Extract<MacroAction, { type: 'tap' | 'down' | 'up' }>

export function isKeycodeAction(action: MacroAction): action is KeycodeAction {
  return action.type === 'tap' || action.type === 'down' || action.type === 'up'
}

export function parseMacroBuffer(
  buffer: number[],
  protocol: number,
  count: number,
): MacroAction[][] {
  const parsed = deserializeAllMacros(buffer, protocol, count)
  while (parsed.length < count) {
    parsed.push([])
  }
  return parsed
}
