// SPDX-License-Identifier: GPL-2.0-or-later
// Pipette settings store — per-UID device settings persistence

import { app } from 'electron'
import { join } from 'node:path'
import { mkdir, readFile, readdir } from 'node:fs/promises'
import { IpcChannels } from '../shared/ipc/channels'
import { notifyChange } from './sync/sync-service'
import { secureHandle } from './ipc-guard'
import { loadAppConfig } from './app-config'
import { withWriteLock } from './per-uid-write-lock'
import { isSafePathSegment } from './utils/safe-filename'
import { writeFileAtomic } from './utils/write-file-atomic'
import { getActiveKeyboardMetaMap, readKeyboardMetaIndex, resolveKeyboardDisplayName } from './sync/keyboard-meta'
import { getTypingAnalyticsDB } from './typing-analytics/db/typing-analytics-db'
import type { PipetteSettings, PipetteSettingsPatch, PooledTypingTestResult } from '../shared/types/pipette-settings'
import {
  mergeDefined,
  newSettingsBase,
  normalizePipetteSettings,
  settingsToSave,
  validatePrefs,
} from '../shared/pipette-settings-normalize'

function validateUid(uid: string): void {
  if (!isSafePathSegment(uid)) throw new Error('Invalid uid')
}

function getKeyboardDir(uid: string): string {
  return join(app.getPath('userData'), 'sync', 'keyboards', uid)
}

function getDataPath(uid: string): string {
  return join(getKeyboardDir(uid), 'pipette_settings.json')
}

export async function readPipetteSettings(uid: string): Promise<PipetteSettings | null> {
  if (!isSafePathSegment(uid)) return null
  return readData(uid)
}

async function readData(uid: string): Promise<PipetteSettings | null> {
  try {
    const raw = await readFile(getDataPath(uid), 'utf-8')
    return normalizePipetteSettings(JSON.parse(raw))
  } catch {
    return null
  }
}

async function writeData(uid: string, prefs: PipetteSettings): Promise<void> {
  await mkdir(getKeyboardDir(uid), { recursive: true })

  const data = settingsToSave(prefs)
  await writeFileAtomic(getDataPath(uid), JSON.stringify(data))

  notifyChange(`keyboards/${uid}/settings`)
}

export function setupPipetteSettingsStore(): void {
  secureHandle(
    IpcChannels.PIPETTE_SETTINGS_GET,
    async (_event, uid: string): Promise<PipetteSettings | null> => {
      try {
        validateUid(uid)
        return await readData(uid)
      } catch {
        return null
      }
    },
  )

  // The keyboard directory marks a keyboard as locally known (lazy download,
  // stored-keyboard list); this creates it without writing a settings file.
  secureHandle(
    IpcChannels.PIPETTE_SETTINGS_ENSURE_DIR,
    async (_event, uid: string): Promise<{ success: boolean; error?: string }> => {
      try {
        validateUid(uid)
        await mkdir(getKeyboardDir(uid), { recursive: true })
        return { success: true }
      } catch (err) {
        return { success: false, error: String(err) }
      }
    },
  )

  // Pool every locally-stored keyboard's saved typing-test results into one
  // flat list for the Measurement-row comparison baseline (keyboard-agnostic).
  // Reads are best-effort: a missing / invalid keyboard dir is skipped.
  secureHandle(
    IpcChannels.PIPETTE_SETTINGS_LIST_ALL_TYPING_RESULTS,
    async (): Promise<PooledTypingTestResult[]> => {
      const keyboardsDir = join(app.getPath('userData'), 'sync', 'keyboards')
      const metaMap = getActiveKeyboardMetaMap(await readKeyboardMetaIndex())
      // Analytics carries a product name even for keyboards with no saved
      // keymap (meta / snapshot), so it names otherwise-uid-only keyboards.
      let analyticsNames: Map<string, string> | undefined
      try {
        analyticsNames = new Map(
          getTypingAnalyticsDB().listKeyboardsWithTypingData().map((k) => [k.uid, k.productName]),
        )
      } catch { /* analytics db unavailable */ }
      const all: PooledTypingTestResult[] = []
      try {
        const entries = await readdir(keyboardsDir, { withFileTypes: true })
        for (const entry of entries) {
          if (!entry.isDirectory() || !isSafePathSegment(entry.name)) continue
          const prefs = await readData(entry.name)
          if (!prefs?.typingTestResults?.length) continue
          const keyboardName = await resolveKeyboardDisplayName(entry.name, metaMap, analyticsNames)
          for (const r of prefs.typingTestResults) all.push({ ...r, keyboardName })
        }
      } catch { /* keyboards dir doesn't exist yet */ }
      return all
    },
  )

  // Field-level merge: each renderer writer PATCHes only the fields it owns,
  // so concurrent writers (per-field setters / analyze filters / goal /
  // keymap scale) never clobber each other. The read-merge-write runs inside the
  // per-uid queue so it's atomic against other writes.
  secureHandle(
    IpcChannels.PIPETTE_SETTINGS_PATCH,
    async (
      _event,
      uid: string,
      partial: PipetteSettingsPatch,
    ): Promise<{ success: boolean; error?: string }> => {
      try {
        validateUid(uid)
        if (typeof partial !== 'object' || partial === null || Array.isArray(partial)) {
          throw new Error('Invalid patch')
        }
        await withWriteLock(uid, async () => {
          const existing = await readData(uid)
          const merged = mergeDefined(existing ?? newSettingsBase(loadAppConfig()), partial)
          validatePrefs(merged)
          await writeData(uid, merged)
        })
        return { success: true }
      } catch (err) {
        return { success: false, error: String(err) }
      }
    },
  )
}
