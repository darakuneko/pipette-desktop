// SPDX-License-Identifier: GPL-2.0-or-later

import { describe, it, expect } from 'vitest'
import { KEYCODE_CATEGORIES, groupByLayoutRow } from '../categories'

describe('system tab groups', () => {
  const systemCategory = KEYCODE_CATEGORIES.find((cat) => cat.id === 'system')

  it('orders groups as Mouse, Boot, Joystick, Audio, Haptic, Media Playback, Browser, System Control, Locking Keys, App', () => {
    const groups = systemCategory?.getGroups?.() ?? []
    expect(groups.map((g) => g.labelKey)).toEqual([
      'keycodes.group.mouse',
      'keycodes.group.boot',
      'keycodes.group.joystick',
      'keycodes.group.audio',
      'keycodes.group.haptic',
      'keycodes.group.mediaPlayback',
      'keycodes.group.browser',
      'keycodes.group.systemControl',
      'keycodes.group.lockingKeys',
      'keycodes.group.app',
    ])
  })

  it('renders Mouse+Boot on one row, Joystick alone on the next, and System Control, Locking Keys, App on the same row', () => {
    const groups = systemCategory?.getGroups?.() ?? []
    const rows = groupByLayoutRow(groups)
    const rowLabelKeys = rows.map((row) => row.map((g) => g.labelKey))
    expect(rowLabelKeys).toEqual([
      ['keycodes.group.mouse', 'keycodes.group.boot'],
      ['keycodes.group.joystick'],
      ['keycodes.group.audio', 'keycodes.group.haptic'],
      ['keycodes.group.mediaPlayback', 'keycodes.group.browser'],
      ['keycodes.group.systemControl', 'keycodes.group.lockingKeys', 'keycodes.group.app'],
    ])
  })
})
