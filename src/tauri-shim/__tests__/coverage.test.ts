// SPDX-License-Identifier: GPL-2.0-or-later
// Counts the shim's members: real (backed by backend commands), fake (fixed
// answers in fakes.ts) and stub (every other member). Every implemented
// member is exactly one of real or fake, and the fakes are exactly the list
// below, so adding or replacing one is a deliberate change here too.

import { describe, expect, it, vi } from 'vitest'
import { fakes } from '../fakes'
import { implemented, real } from '../implemented'
import { VIAL_API_MEMBER_NAMES } from '../vial-api-members'

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }))

const EXPECTED_FAKES = [
  'appConfigGetAll',
  'appConfigSet',
  'trayStatusUpdate',
  'syncAuthStatus',
  'syncPasswordStatus',
  'syncHasPendingChanges',
  'syncFormatStatus',
  'notificationFetch',
  'i18nPackList',
  'windowStartedHidden',
  'windowIsVisible',
  'setWindowZoom',
  'themePackList',
  'keyLabelStoreList',
  'pipetteSettingsGet',
  'pipetteSettingsEnsureDir',
  'pipetteSettingsPatch',
  'keyboardMetaNameIfMissing',
  'snapshotStoreList',
  'typingRunLogList',
]

describe('shim coverage', () => {
  it('fakes exactly the expected members', () => {
    expect(Object.keys(fakes).sort()).toEqual([...EXPECTED_FAKES].sort())
  })

  it('implements only VialAPI members, each either real or fake', () => {
    const members = new Set<string>(VIAL_API_MEMBER_NAMES)
    const names = Object.keys(implemented)
    expect(names.filter((name) => !members.has(name))).toEqual([])
    expect(names.sort()).toEqual([...Object.keys(real), ...Object.keys(fakes)].sort())
  })
})
