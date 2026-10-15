// SPDX-License-Identifier: GPL-2.0-or-later
// The VialAPI pipette settings members for the Tauri build
// (src-tauri/src/store_commands/settings.rs). The backend only stores the
// text of a keyboard's settings file; the content rules are the ones the
// Electron main process applies (src/shared/pipette-settings-normalize.ts),
// applied here.
//
// A patch reads the file with its etag, merges, validates and serializes
// here, and writes the text back naming that etag. The backend writes it
// only while the file still has that etag, so a change made in between
// (a sync merge) is never overwritten: the write answers `conflict` and the
// patch starts over from a new read. The patches of a keyboard are queued
// under its uid, the key its snapshot writes share, from the read to the
// write, so the renderer's own patches never conflict with each other and
// apply in the order it made them, as the Electron handler's lock does.
// As with Electron's IPC, which copies the arguments when the member is
// called, a queued patch applies the object as it was at the call.

import type { AppConfig } from '../../shared/types/app-config'
import type { PipetteSettings, PipetteSettingsPatch, PooledTypingTestResult } from '../../shared/types/pipette-settings'
import type { VialAPI } from '../../shared/types/vial-api'
import {
  mergeDefined,
  newSettingsBase,
  parsePipetteSettings,
  settingsToSave,
  validatePrefs,
} from '../../shared/pipette-settings-normalize'
import { isSafePathSegment } from '../../shared/utils/safe-filename'
import { call } from '../ipc'
import { readAppConfigAfterSets } from './app-config'
import { enqueue } from '../key-queue'

/** A settings file as read: `content` is null when there is none. */
export interface SettingsFile {
  content: string | null
  etag: string
}

/** A stored keyboard's settings file and display name. */
export interface KeyboardSettingsFile {
  uid: string
  name: string
  content: string
}

/** Writes made before a patch gives up on a file that keeps changing. */
export const MAX_PATCH_ATTEMPTS = 8

type Result = { success: boolean; error?: string }

export const readSettingsFile = (uid: string): Promise<SettingsFile> => call<SettingsFile>('pipette_settings_read', { uid })

export const writeSettingsFile = (uid: string, content: string, etag: string): Promise<'written' | 'conflict'> =>
  call<'written' | 'conflict'>('pipette_settings_write', { uid, content, etag })

export async function ensureSettingsDir(uid: string): Promise<void> {
  await call<null>('pipette_settings_ensure_dir', { uid })
}

export const readAllSettingsFiles = (): Promise<KeyboardSettingsFile[]> =>
  call<KeyboardSettingsFile[]>('pipette_settings_read_all')

async function patchSettings(uid: string, partial: PipetteSettingsPatch): Promise<Result> {
  try {
    if (!isSafePathSegment(uid)) throw new Error('Invalid uid')
    if (typeof partial !== 'object' || partial === null || Array.isArray(partial)) {
      throw new Error('Invalid patch')
    }
    // Read only for a missing file, and once: the defaults a new file
    // starts from, as they are after the sets made before this patch.
    let config: AppConfig | undefined
    for (let attempt = 1; attempt <= MAX_PATCH_ATTEMPTS; attempt++) {
      const { content, etag } = await readSettingsFile(uid)
      const existing = content === null ? null : parsePipetteSettings(content)
      const base = existing ?? newSettingsBase((config ??= await readAppConfigAfterSets()))
      const merged = mergeDefined(base, partial)
      validatePrefs(merged)
      if ((await writeSettingsFile(uid, JSON.stringify(settingsToSave(merged)), etag)) === 'written') {
        return { success: true }
      }
    }
    console.error(`[vialAPI shim] pipette settings of ${uid} changed during each of ${MAX_PATCH_ATTEMPTS} writes`)
    throw new Error('Settings changed while being written')
  } catch (err) {
    return { success: false, error: String(err) }
  }
}

export const settingsApi = {
  pipetteSettingsGet: async (uid): Promise<PipetteSettings | null> => {
    if (!isSafePathSegment(uid)) return null
    try {
      const { content } = await readSettingsFile(uid)
      return content === null ? null : parsePipetteSettings(content)
    } catch {
      return null
    }
  },
  pipetteSettingsPatch: async (uid, partial) => {
    const sent = structuredClone(partial)
    return enqueue(uid, () => patchSettings(uid, sent))
  },
  pipetteSettingsEnsureDir: async (uid) => {
    try {
      await ensureSettingsDir(uid)
      return { success: true }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  },
  pipetteSettingsListAllTypingResults: async () => {
    const all: PooledTypingTestResult[] = []
    for (const file of await readAllSettingsFiles()) {
      const prefs = parsePipetteSettings(file.content)
      if (!prefs?.typingTestResults?.length) continue
      for (const r of prefs.typingTestResults) all.push({ ...r, keyboardName: file.name })
    }
    return all
  },
} satisfies Partial<VialAPI>
