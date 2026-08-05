// SPDX-License-Identifier: GPL-2.0-or-later
// Remote data inspection: listing/categorizing what's on Drive without
// merging it into local state (used by the sync settings scan UI and
// the undecryptable-files diagnostic). Split out of sync-service.ts to
// keep it under the project's 800-line Service/Util size ceiling.

import { decrypt } from './sync-crypto'
import {
  listFiles,
  downloadFile,
  driveFileName,
  syncUnitFromFileName,
  type DriveFile,
} from './google-drive'
import { pLimit } from '../../shared/concurrency'
import { SYNC_CONCURRENCY } from './sync-runtime-state'
import { requireSyncCredentials, PASSWORD_CHECK_UNIT, validatePasswordCheck } from './sync-password'
import { KEY_LABEL_SYNC_UNIT } from '../key-label-store'
import { TYPING_TEST_TEXT_SYNC_UNIT } from '../typing-test-text-store'
import { I18N_INDEX_SYNC_UNIT } from '../../shared/types/i18n-store'
import { THEME_INDEX_SYNC_UNIT } from '../../shared/types/theme-store'
import { readKeyboardMetaIndex, getActiveKeyboardMetaMap } from './keyboard-meta'
import type { SyncBundle, UndecryptableFile, SyncDataScanResult } from '../../shared/types/sync'

async function fetchValidatedDataFiles(): Promise<{ password: string; dataFiles: DriveFile[] } | null> {
  const credentials = await requireSyncCredentials()
  if (!credentials.ok) return null
  const { password } = credentials
  const remoteFiles = await listFiles()

  await validatePasswordCheck(password, remoteFiles)

  const passwordCheckFileName = driveFileName(PASSWORD_CHECK_UNIT)
  const dataFiles = remoteFiles.filter((f) => f.name !== passwordCheckFileName)
  return { password, dataFiles }
}

async function findUndecryptableFiles(password: string, dataFiles: DriveFile[]): Promise<UndecryptableFile[]> {
  const undecryptable: UndecryptableFile[] = []
  const limit = pLimit(SYNC_CONCURRENCY)
  await Promise.allSettled(
    dataFiles.map((file) =>
      limit(async () => {
        try {
          const envelope = await downloadFile(file.id)
          await decrypt(envelope, password)
        } catch {
          undecryptable.push({
            fileId: file.id,
            fileName: file.name,
            syncUnit: syncUnitFromFileName(file.name),
          })
        }
      }),
    ),
  )
  return undecryptable
}

export async function listUndecryptableFiles(): Promise<UndecryptableFile[]> {
  const result = await fetchValidatedDataFiles()
  if (!result) return []
  return findUndecryptableFiles(result.password, result.dataFiles)
}

/** Shared by the no-credentials early return and (spread into) the
 *  success path below, so a future new `SyncDataScanResult` field only
 *  needs a default added here once instead of in both literals. */
const EMPTY_SCAN_RESULT: SyncDataScanResult = {
  keyboards: [],
  keyboardNames: {},
  favorites: [],
  i18nPacks: [],
  themePacks: [],
  keyLabels: false,
  typingTestTexts: false,
  hasI18nData: false,
  hasThemesData: false,
  undecryptable: [],
}

export async function scanRemoteData(): Promise<SyncDataScanResult> {
  const result = await fetchValidatedDataFiles()
  if (!result) {
    return EMPTY_SCAN_RESULT
  }
  const { password, dataFiles } = result

  // Categorize from filenames (no download needed)
  const keyboardUids = new Set<string>()
  const favoriteTypes = new Set<string>()
  const i18nPackIds = new Set<string>()
  const themePackIds = new Set<string>()
  let keyLabelsFound = false
  let typingTestTextsFound = false
  let i18nIndexFound = false
  let themesIndexFound = false
  for (const file of dataFiles) {
    const syncUnit = syncUnitFromFileName(file.name)
    if (!syncUnit) continue
    if (syncUnit.startsWith('keyboards/')) {
      const uid = syncUnit.split('/')[1]
      if (uid) keyboardUids.add(uid)
    } else if (syncUnit.startsWith('favorites/')) {
      const type = syncUnit.split('/')[1]
      if (type) favoriteTypes.add(type)
    } else if (syncUnit.startsWith('i18n/packs/')) {
      const packId = syncUnit.slice('i18n/packs/'.length)
      if (packId) i18nPackIds.add(packId)
    } else if (syncUnit.startsWith('themes/packs/')) {
      const packId = syncUnit.slice('themes/packs/'.length)
      if (packId) themePackIds.add(packId)
    } else if (syncUnit === KEY_LABEL_SYNC_UNIT) {
      keyLabelsFound = true
    } else if (syncUnit === TYPING_TEST_TEXT_SYNC_UNIT) {
      typingTestTextsFound = true
    } else if (syncUnit === I18N_INDEX_SYNC_UNIT) {
      // The index can outlive every pack id it once listed (all
      // tombstoned and GC'd) — tracked separately so `hasI18nData`
      // below still surfaces a resettable target in that 30-day dead
      // zone instead of going silent just because `i18nPackIds` is empty.
      i18nIndexFound = true
    } else if (syncUnit === THEME_INDEX_SYNC_UNIT) {
      themesIndexFound = true
    }
  }

  // Use whatever names are already in the local meta index (populated by executeSync/backfill
  // and the LIST_STORED_KEYBOARDS safety net). scanRemoteData stays read-only here so it
  // doesn't trigger extra downloads or writes.
  const metaIndex = await readKeyboardMetaIndex()
  const metaMap = getActiveKeyboardMetaMap(metaIndex)
  const keyboardNames: Record<string, string> = {}
  for (const uid of keyboardUids) {
    const name = metaMap.get(uid)
    if (name) keyboardNames[uid] = name
  }

  const undecryptable = await findUndecryptableFiles(password, dataFiles)

  return {
    ...EMPTY_SCAN_RESULT,
    keyboards: [...keyboardUids],
    keyboardNames,
    favorites: [...favoriteTypes],
    i18nPacks: [...i18nPackIds],
    themePacks: [...themePackIds],
    keyLabels: keyLabelsFound,
    typingTestTexts: typingTestTextsFound,
    hasI18nData: i18nIndexFound || i18nPackIds.size > 0,
    hasThemesData: themesIndexFound || themePackIds.size > 0,
    undecryptable,
  }
}

/** Download and decrypt a remote sync unit bundle without merging into local. */
export async function fetchRemoteBundle(syncUnit: string): Promise<SyncBundle | null> {
  const result = await fetchValidatedDataFiles()
  if (!result) return null
  const { password, dataFiles } = result
  const targetName = driveFileName(syncUnit)
  const file = dataFiles.find((f) => f.name === targetName)
  if (!file) return null
  try {
    const envelope = await downloadFile(file.id)
    const plaintext = await decrypt(envelope, password)
    return JSON.parse(plaintext) as SyncBundle
  } catch {
    return null
  }
}

/** Snapshot of the user's appData Drive listing as a name-only set,
 * for callers that need many existence checks (e.g. import). Returns
 * `null` when the user is unauthenticated so the caller can fall back
 * to a local-only check rather than rejecting outright. */
export async function listRemoteFileNames(): Promise<Set<string> | null> {
  const credentials = await requireSyncCredentials()
  if (!credentials.ok) return null
  const remoteFiles = await listFiles()
  return new Set(remoteFiles.map((f) => f.name))
}
