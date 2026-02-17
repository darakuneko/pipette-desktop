// SPDX-License-Identifier: GPL-2.0-or-later
// Pipette settings store — per-UID device settings persistence

import { app } from 'electron'
import { join } from 'node:path'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { IpcChannels } from '../shared/ipc/channels'
import { notifyChange } from './sync/sync-service'
import { secureHandle } from './ipc-guard'
import type { PipetteSettings } from '../shared/types/pipette-settings'

function isSafePathSegment(segment: string): boolean {
  if (!segment || segment === '.' || segment === '..') return false
  return !/[/\\]/.test(segment)
}

function validateUid(uid: string): void {
  if (!isSafePathSegment(uid)) throw new Error('Invalid uid')
}

function isValidPrefs(value: unknown): value is PipetteSettings {
  if (typeof value !== 'object' || value === null) return false
  const obj = value as Record<string, unknown>
  if (typeof obj.keyboardLayout !== 'string') return false
  if (typeof obj.autoAdvance !== 'boolean') return false
  if ('layerNames' in obj && !Array.isArray(obj.layerNames)) return false
  if (Array.isArray(obj.layerNames) && (obj.layerNames as unknown[]).some((n) => typeof n !== 'string')) return false
  if ('typingTestResults' in obj && obj.typingTestResults != null && !Array.isArray(obj.typingTestResults)) return false
  if ('typingTestConfig' in obj && obj.typingTestConfig != null && (typeof obj.typingTestConfig !== 'object' || Array.isArray(obj.typingTestConfig))) return false
  if ('typingTestLanguage' in obj && obj.typingTestLanguage != null && typeof obj.typingTestLanguage !== 'string') return false
  if ('_rev' in obj && obj._rev !== 1) return false
  return true
}

function validatePrefs(prefs: unknown): asserts prefs is PipetteSettings {
  if (!isValidPrefs(prefs)) {
    throw new Error('Invalid prefs')
  }
}

function getDataPath(uid: string): string {
  return join(app.getPath('userData'), 'sync', 'keyboards', uid, 'pipette_settings.json')
}

async function readData(uid: string): Promise<PipetteSettings | null> {
  try {
    const raw = await readFile(getDataPath(uid), 'utf-8')
    const parsed: unknown = JSON.parse(raw)
    if (!isValidPrefs(parsed)) return null
    return {
      _rev: 1,
      keyboardLayout: parsed.keyboardLayout,
      autoAdvance: parsed.autoAdvance,
      layerNames: parsed.layerNames ?? [],
      typingTestResults: parsed.typingTestResults,
      typingTestConfig: parsed.typingTestConfig,
      typingTestLanguage: parsed.typingTestLanguage,
    }
  } catch {
    return null
  }
}

async function writeData(uid: string, prefs: PipetteSettings): Promise<void> {
  const dir = join(app.getPath('userData'), 'sync', 'keyboards', uid)
  await mkdir(dir, { recursive: true })

  const data: PipetteSettings = {
    ...prefs,
    _rev: 1,
    layerNames: prefs.layerNames ?? [],
    _updatedAt: new Date().toISOString(),
  }
  await writeFile(getDataPath(uid), JSON.stringify(data), 'utf-8')

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

  secureHandle(
    IpcChannels.PIPETTE_SETTINGS_SET,
    async (
      _event,
      uid: string,
      prefs: PipetteSettings,
    ): Promise<{ success: boolean; error?: string }> => {
      try {
        validateUid(uid)
        validatePrefs(prefs)
        await writeData(uid, prefs)
        return { success: true }
      } catch (err) {
        return { success: false, error: String(err) }
      }
    },
  )
}
