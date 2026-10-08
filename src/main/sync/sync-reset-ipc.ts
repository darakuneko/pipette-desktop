// SPDX-License-Identifier: GPL-2.0-or-later
// IPC handlers that reset or delete synced data. Each one holds the sync lock
// for its whole run (withResetLock, sync-reset-lock.ts).

import { app } from 'electron'
import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { IpcChannels } from '../../shared/ipc/channels'
import { getAppConfigStore } from '../app-config'
import { deleteFilesByPrefix, deleteFilesByExactName, deleteFilesById, driveFileName } from './google-drive'
import {
  withResetLock,
  cancelPendingChanges,
  copyPendingState,
  restoreCancelledPending,
  notifyChange,
  stopPolling,
  listLocalKeyboardUids,
  SyncBlockedError,
  assertSyncAllowed,
  assertNoLocalPasswordChange,
  forgetChangeStateCache,
  signOutKeepingPendingLocked,
} from './sync-service'
import { wrapIpc } from './sync-ipc-wrap'
import { deleteAllTypingForKeyboard, listTypingKeyboards } from '../typing-analytics/typing-analytics-service'
import { tombstoneAllKeyboardMeta, tombstoneKeyboardMeta } from './keyboard-meta'
import { secureHandle } from '../ipc-guard'
import type { SyncResetTargets, LocalResetTargets } from '../../shared/types/sync'
import { KEYBOARD_META_SYNC_UNIT } from '../../shared/types/keyboard-meta'
import { I18N_SYNC_UNIT_PREFIX } from '../../shared/types/i18n-store'
import { THEME_SYNC_UNIT_PREFIX } from '../../shared/types/theme-store'
import { KEY_LABEL_SYNC_UNIT } from '../key-label-store'
import { TYPING_TEST_TEXT_SYNC_UNIT } from '../typing-test-text-store'
import { isSafeKey } from '../utils/safe-filename'

/** `SyncResetTargets`' optional boolean fields — every one of them
 *  follows the identical "boolean or absent" validation and the same
 *  "counts toward at least one target selected" rule, so both the
 *  per-field type checks and the no-targets guard below loop over this
 *  instead of hand-repeating four near-identical `if` blocks. */
const OPTIONAL_SYNC_RESET_TARGETS = ['i18nPacks', 'themePacks', 'keyLabels', 'typingTestTexts'] as const

/** Runs Reset Keyboard Data's typing-analytics cleanup (flush, unlink this
 *  machine's JSONL, tombstone the SQLite-cache rows) for every keyboard
 *  with a local directory or cache rows. Removing `sync/keyboards` alone
 *  leaves the cache, so Analyze would keep showing the removed keyboards. */
async function deleteTypingForAllKeyboards(): Promise<void> {
  const uids = await listLocalKeyboardUids()
  try {
    for (const { uid } of listTypingKeyboards()) uids.add(uid)
  } catch (err) {
    console.warn('[sync-reset-ipc] reset local targets: analytics cache listing failed', err)
  }
  for (const uid of uids) {
    await deleteAllTypingForKeyboard(uid).catch((err) => {
      console.warn('[sync-reset-ipc] reset local targets: analytics cache cleanup failed', err)
    })
  }
}

export function setupSyncResetIpc(): void {
  secureHandle(IpcChannels.SYNC_RESET_TARGETS, (_event, targets: SyncResetTargets) =>
    wrapIpc('Reset sync targets failed', async () => {
      if (typeof targets !== 'object' || targets === null) throw new Error('Invalid targets')
      const hasKeyboards = targets.keyboards === true || (Array.isArray(targets.keyboards) && targets.keyboards.length > 0)
      if (typeof targets.keyboards !== 'boolean' && !Array.isArray(targets.keyboards)) {
        throw new Error('Invalid targets: keyboards must be boolean or string[]')
      }
      if (typeof targets.favorites !== 'boolean') {
        throw new Error('Invalid targets: favorites must be boolean')
      }
      for (const key of OPTIONAL_SYNC_RESET_TARGETS) {
        if (targets[key] !== undefined && typeof targets[key] !== 'boolean') {
          throw new Error(`Invalid targets: ${key} must be boolean`)
        }
      }
      if (!hasKeyboards && !targets.favorites && !OPTIONAL_SYNC_RESET_TARGETS.some((key) => targets[key])) {
        throw new Error('No targets selected')
      }
      if (Array.isArray(targets.keyboards) && !targets.keyboards.every((uid) => typeof uid === 'string' && isSafeKey(uid))) {
        throw new Error('Invalid keyboard UID')
      }
      const resetKeyboards = targets.keyboards === true ? 'all' : targets.keyboards || null
      return withResetLock(resetKeyboards, async () => {
        await assertSyncAllowed()
        let metaChanged = false
        // Unit-name-only labels for any target whose Drive delete batch had
        // a rejection — collected rather than thrown immediately so every
        // requested target still gets attempted even if an earlier one
        // partially failed (a rejected delete does not stop the batch).
        const failedTargets: string[] = []
        // One cancel for every target, before anything is deleted. It always
        // writes, so a disk failure stops the reset here.
        cancelPendingChanges([
          ...(targets.keyboards === true ? ['keyboards/'] : []),
          ...(Array.isArray(targets.keyboards) ? targets.keyboards.map((uid) => `keyboards/${uid}/`) : []),
          ...(targets.favorites ? ['favorites/'] : []),
          ...(targets.i18nPacks ? [I18N_SYNC_UNIT_PREFIX] : []),
          ...(targets.themePacks ? [THEME_SYNC_UNIT_PREFIX] : []),
          ...(targets.keyLabels ? [KEY_LABEL_SYNC_UNIT] : []),
          ...(targets.typingTestTexts ? [TYPING_TEST_TEXT_SYNC_UNIT] : []),
        ], { writeAlways: true })
        if (targets.keyboards === true) {
          const result = await deleteFilesByPrefix('keyboards_')
          if (result.failed > 0) failedTargets.push('keyboards')
          const tombstoned = await tombstoneAllKeyboardMeta()
          if (tombstoned > 0) metaChanged = true
        } else if (Array.isArray(targets.keyboards)) {
          for (const uid of targets.keyboards) {
            const result = await deleteFilesByPrefix(`keyboards_${uid}_`)
            if (result.failed > 0) failedTargets.push(`keyboards/${uid}`)
            const tombstoneResult = await tombstoneKeyboardMeta(uid)
            if (tombstoneResult === 'tombstoned') metaChanged = true
          }
        }
        if (targets.favorites) {
          const result = await deleteFilesByPrefix('favorites_')
          if (result.failed > 0) failedTargets.push('favorites')
        }
        if (targets.i18nPacks) {
          const result = await deleteFilesByPrefix('i18n_')
          if (result.failed > 0) failedTargets.push('i18nPacks')
        }
        if (targets.themePacks) {
          const result = await deleteFilesByPrefix('themes_')
          if (result.failed > 0) failedTargets.push('themePacks')
        }
        if (targets.keyLabels) {
          const result = await deleteFilesByExactName(driveFileName(KEY_LABEL_SYNC_UNIT))
          if (result.failed > 0) failedTargets.push('keyLabels')
        }
        if (targets.typingTestTexts) {
          const result = await deleteFilesByExactName(driveFileName(TYPING_TEST_TEXT_SYNC_UNIT))
          if (result.failed > 0) failedTargets.push('typingTestTexts')
        }
        if (metaChanged) notifyChange(KEYBOARD_META_SYNC_UNIT)
        if (failedTargets.length > 0) {
          throw new Error(`Failed to delete remote data for: ${failedTargets.join(', ')}`)
        }
      })
    }),
  )

  // --- Reset keyboard data (per-device) ---
  secureHandle(IpcChannels.RESET_KEYBOARD_DATA, (_event, uid: string) =>
    wrapIpc('Reset keyboard data failed', async () => {
      if (!isSafeKey(uid)) {
        throw new Error('Invalid uid')
      }
      return withResetLock([uid], async () => {
        // Refused while a sync password change is in progress. When Drive
        // can't be checked (offline, signed out) the local reset still runs
        // but the remote delete is skipped: a lock may be there unseen. Drive
        // needing a newer app also only skips the remote delete: this
        // machine's local data is still its own to remove.
        const remoteDeleteAllowed = await assertSyncAllowed().then(
          () => true,
          (err: unknown) => {
            if (err instanceof SyncBlockedError && err.reason !== 'updateRequired') throw err
            return false
          },
        )
        // The cancel always writes and is where a failed pending write stops
        // the reset, so it comes before anything is removed; it runs again after the
        // analytics cleanup, whose flush marks this keyboard's units pending.
        const keyboardUnits = [`keyboards/${uid}/`]
        cancelPendingChanges(keyboardUnits, { writeAlways: true })
        // Flush + unlink this keyboard's analytics JSONL and tombstone its
        // SQLite-cache rows, otherwise the Analyze view keeps showing the
        // keyboard from the stale cache after the directory is removed.
        await deleteAllTypingForKeyboard(uid).catch((err) => {
          console.warn('[sync-reset-ipc] reset keyboard: analytics cache cleanup failed', err)
        })
        cancelPendingChanges(keyboardUnits)
        const userData = app.getPath('userData')
        await rm(join(userData, 'sync', 'keyboards', uid), { recursive: true, force: true })
        // Best-effort remote deletion
        if (remoteDeleteAllowed) await deleteFilesByPrefix(`keyboards_${uid}_`).catch(() => {})
        // Tombstone meta entry so other devices see the removal
        const tombstoneResult = await tombstoneKeyboardMeta(uid)
        if (tombstoneResult === 'tombstoned') {
          notifyChange(KEYBOARD_META_SYNC_UNIT)
        }
      })
    }),
  )

  // --- Reset local targets ---
  secureHandle(IpcChannels.RESET_LOCAL_TARGETS, (_event, targets: LocalResetTargets) =>
    wrapIpc('Reset local targets failed', async () => {
      if (typeof targets !== 'object' || targets === null) throw new Error('Invalid targets')
      if (typeof targets.keyboards !== 'boolean' || typeof targets.favorites !== 'boolean' || typeof targets.appSettings !== 'boolean') {
        throw new Error('Invalid targets: expected boolean fields')
      }
      if (targets.i18nPacks !== undefined && typeof targets.i18nPacks !== 'boolean') {
        throw new Error('Invalid targets: i18nPacks must be boolean')
      }
      if (targets.themePacks !== undefined && typeof targets.themePacks !== 'boolean') {
        throw new Error('Invalid targets: themePacks must be boolean')
      }
      if (!targets.keyboards && !targets.favorites && !targets.appSettings && !targets.i18nPacks && !targets.themePacks) throw new Error('No targets selected')
      return withResetLock(targets.keyboards ? 'all' : null, async () => {
        // App settings include local/auth, which holds a password change's
        // state; removing it mid-change would orphan the Drive lock.
        if (targets.appSettings) await assertNoLocalPasswordChange()
        const userData = app.getPath('userData')
        const allSelected = targets.keyboards && targets.favorites && targets.appSettings && targets.i18nPacks && targets.themePacks
        // One cancel for every target (all units when everything is
        // selected), before anything is removed. It always writes, so a
        // failed pending write stops the reset here. Imported typing-test texts and
        // key-display labels are both global, all-keyboard user content —
        // reset them alongside favorites (the global-content reset bucket).
        const cancelled = allSelected ? undefined : [
          ...(targets.keyboards ? ['keyboards/'] : []),
          ...(targets.favorites ? ['favorites/', TYPING_TEST_TEXT_SYNC_UNIT, KEY_LABEL_SYNC_UNIT] : []),
          ...(targets.i18nPacks ? [I18N_SYNC_UNIT_PREFIX] : []),
          ...(targets.themePacks ? [THEME_SYNC_UNIT_PREFIX] : []),
        ]
        const pendingBeforeCancel = targets.appSettings ? copyPendingState() : null
        cancelPendingChanges(cancelled, { writeAlways: true })
        if (pendingBeforeCancel) {
          // Removing local/auth signs out, so it is done as a sign-out: the
          // account's unsent changes are held for its next sign-in, and the
          // cached tokens and account caches are dropped with the token
          // file. It can fail (the hold is written first), so it runs before
          // anything is removed. On a failure the reset ends with nothing
          // removed, the sign-in and settings kept, polling still running,
          // and the units the cancel removed put back pending, keeping any
          // marked since (written now, or by the next pending write if this
          // write fails too).
          try {
            await signOutKeepingPendingLocked()
          } catch (err) {
            restoreCancelledPending(pendingBeforeCancel)
            throw err
          }
          // Clearing appSettings resets autoSync config, so stop polling to match
          stopPolling()
        }
        if (targets.keyboards) {
          await deleteTypingForAllKeyboards()
          // The cleanup's flush marks the keyboards' analytics units pending.
          cancelPendingChanges(cancelled)
        }
        if (targets.keyboards) {
          await rm(join(userData, 'sync', 'keyboards'), { recursive: true, force: true })
        }
        if (targets.favorites) {
          await rm(join(userData, 'sync', 'favorites'), { recursive: true, force: true })
          await rm(join(userData, 'sync', 'typing-test-texts'), { recursive: true, force: true })
          await rm(join(userData, 'sync', 'key-labels'), { recursive: true, force: true })
        }
        if (targets.i18nPacks) {
          await rm(join(userData, 'sync', 'i18n'), { recursive: true, force: true })
        }
        if (targets.themePacks) {
          await rm(join(userData, 'sync', 'themes'), { recursive: true, force: true })
        }
        if (targets.appSettings) {
          getAppConfigStore().clear()
          await rm(join(userData, 'local', 'auth'), { recursive: true, force: true })
          forgetChangeStateCache()
          await rm(join(userData, 'local', 'downloads', 'languages'), { recursive: true, force: true })
          await rm(join(userData, 'local', 'logs'), { recursive: true, force: true })
        }
      })
    }),
  )

  secureHandle(IpcChannels.SYNC_DELETE_FILES, (_event, fileIds: string[]) =>
    wrapIpc('Delete files failed', async () => {
      if (!Array.isArray(fileIds) || fileIds.length === 0) throw new Error('No files specified')
      if (!fileIds.every((id) => typeof id === 'string')) throw new Error('Invalid file ID')
      return withResetLock(null, async () => {
        await assertSyncAllowed()
        const result = await deleteFilesById(fileIds)
        if (result.failed > 0) throw new Error(`Failed to delete ${result.failed} of ${result.attempted} files: ${result.firstError}`)
      }, 'Cannot delete while sync is in progress')
    }),
  )
}
