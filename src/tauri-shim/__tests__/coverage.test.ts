// SPDX-License-Identifier: GPL-2.0-or-later
// Counts the shim's members: real (backed by backend commands), fake (fixed
// answers in fakes.ts) and stub (every other member). Every implemented
// member is exactly one of real or fake, and the fakes are exactly the list
// below, so adding or replacing one is a deliberate change here too. The
// keyboard members (HID probe, file dialogs, snapshot, favorite and
// pipette settings stores, stored keyboards, pending sync units) are all
// real.

import { describe, expect, it, vi } from 'vitest'
import { fakes } from '../fakes'
import { implemented, real } from '../implemented'
import { VIAL_API_MEMBER_NAMES } from '../vial-api-members'

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }))

const EXPECTED_FAKES = [
  'trayStatusUpdate',
  'syncAuthStatus',
  'syncPasswordStatus',
  'syncFormatStatus',
  'notificationFetch',
  'i18nPackList',
  'themePackList',
  'keyLabelHubList',
  'keyLabelHubDownload',
  'keyLabelHubUpload',
  'keyLabelHubUpdate',
  'keyLabelHubSync',
  'keyLabelHubTimestamps',
  'keyLabelHubDelete',
  'typingRunLogList',
]

/** The members the keyboard editor needs from the backend, all real. */
const KEYBOARD_MEMBERS = [
  'probeDevice',
  'saveLayout',
  'loadLayout',
  'exportKeymapC',
  'exportPdf',
  'exportCsv',
  'exportCsvBundle',
  'exportJson',
  'sideloadJson',
  'snapshotStoreList',
  'snapshotStoreSave',
  'snapshotStoreLoad',
  'snapshotStoreUpdate',
  'snapshotStoreRename',
  'snapshotStoreDelete',
  'snapshotStoreSetHubPostId',
  'snapshotStoreSetHubPrivate',
  'favoriteStoreList',
  'favoriteStoreSave',
  'favoriteStoreLoad',
  'favoriteStoreRename',
  'favoriteStoreDelete',
  'favoriteStoreExport',
  'favoriteStoreExportCurrent',
  'favoriteStoreImport',
  'favoriteStoreImportToCurrent',
  'favoriteStoreSetHubPostId',
  'favoriteStoreSetHubPrivate',
  'pipetteSettingsGet',
  'pipetteSettingsPatch',
  'pipetteSettingsEnsureDir',
  'pipetteSettingsListAllTypingResults',
  'listStoredKeyboards',
  'keyboardMetaNameIfMissing',
  'syncHasPendingChanges',
  'syncOnPendingChange',
]

describe('shim coverage', () => {
  it('backs every keyboard member with backend commands', () => {
    expect(new Set(KEYBOARD_MEMBERS).size).toBe(36)
    expect(KEYBOARD_MEMBERS.filter((name) => !(name in real))).toEqual([])
    expect(KEYBOARD_MEMBERS.filter((name) => name in fakes)).toEqual([])
  })

  // Applied sync units come from the sync service, which the backend does
  // not run yet; the renderer only subscribes.
  it('backs every key label store member with backend commands', () => {
    const members = Object.keys(implemented).filter((name) => name.startsWith('keyLabelStore'))
    expect(members).toHaveLength(10)
    expect(members.filter((name) => !(name in real))).toEqual([])
  })

  it('leaves syncOnUnitApplied to the stub', () => {
    expect('syncOnUnitApplied' in implemented).toBe(false)
  })

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
