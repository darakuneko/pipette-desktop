// SPDX-License-Identifier: GPL-2.0-or-later
// Pipette settings store — per-UID device settings persistence

import { app } from 'electron'
import { join } from 'node:path'
import { mkdir, readFile, writeFile, readdir } from 'node:fs/promises'
import { IpcChannels } from '../shared/ipc/channels'
import { notifyChange } from './sync/sync-service'
import { secureHandle } from './ipc-guard'
import { withWriteLock } from './per-uid-write-lock'
import { isRecord } from '../shared/vil-file'
import { getActiveKeyboardMetaMap, readKeyboardMetaIndex, resolveKeyboardDisplayName } from './sync/keyboard-meta'
import { getTypingAnalyticsDB } from './typing-analytics/db/typing-analytics-db'
import type { PipetteSettings, PipetteSettingsPatch, ViewMode, PooledTypingTestResult } from '../shared/types/pipette-settings'
import { VIEW_MODES, DEFAULT_PIPETTE_SETTINGS, isTypingSyncSpanDays, isTypingViewMenuTab, isTypingTestComparisonBaselines } from '../shared/types/pipette-settings'
import { isPositiveInt, isValidAnalyzeFilterSettings } from '../shared/types/analyze-filters'
import { FINGER_LIST, type FingerType } from '../shared/kle/kle-ergonomics'

const FINGER_SET = new Set<FingerType>(FINGER_LIST)
const KEY_POS_RE = /^\d+,\d+$/

function isValidIsoTimestamp(v: unknown): v is string {
  if (typeof v !== 'string' || v.length === 0) return false
  const ms = Date.parse(v)
  return Number.isFinite(ms)
}

function isValidGoalHistoryEntry(value: unknown): boolean {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const obj = value as Record<string, unknown>
  if (!isPositiveInt(obj.days)) return false
  if (!isPositiveInt(obj.keystrokes)) return false
  if (!isValidIsoTimestamp(obj.effectiveFrom)) return false
  return true
}

function isValidAnalyzeSettings(value: unknown): boolean {
  if (value == null) return true
  if (typeof value !== 'object' || Array.isArray(value)) return false
  const obj = value as Record<string, unknown>
  if ('fingerAssignments' in obj && obj.fingerAssignments != null) {
    const fa = obj.fingerAssignments
    if (typeof fa !== 'object' || Array.isArray(fa)) return false
    for (const [k, v] of Object.entries(fa as Record<string, unknown>)) {
      if (!KEY_POS_RE.test(k)) return false
      if (typeof v !== 'string' || !FINGER_SET.has(v as FingerType)) return false
    }
  }
  if ('goalDays' in obj && obj.goalDays != null && !isPositiveInt(obj.goalDays)) return false
  if ('goalKeystrokes' in obj && obj.goalKeystrokes != null && !isPositiveInt(obj.goalKeystrokes)) return false
  if ('goalHistory' in obj && obj.goalHistory != null) {
    if (!Array.isArray(obj.goalHistory)) return false
    if (!obj.goalHistory.every(isValidGoalHistoryEntry)) return false
  }
  if ('filters' in obj && obj.filters != null && !isValidAnalyzeFilterSettings(obj.filters)) return false
  if ('compareFilters' in obj && obj.compareFilters != null && !isValidAnalyzeFilterSettings(obj.compareFilters)) return false
  return true
}

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
  if ('typingTestNormalConfig' in obj && obj.typingTestNormalConfig != null && (typeof obj.typingTestNormalConfig !== 'object' || Array.isArray(obj.typingTestNormalConfig))) return false
  if ('typingTestLanguage' in obj && obj.typingTestLanguage != null && typeof obj.typingTestLanguage !== 'string') return false
  if ('layerPanelOpen' in obj && obj.layerPanelOpen != null && typeof obj.layerPanelOpen !== 'boolean') return false
  if ('basicViewType' in obj && obj.basicViewType != null && obj.basicViewType !== 'ansi' && obj.basicViewType !== 'iso' && obj.basicViewType !== 'jis' && obj.basicViewType !== 'list' && obj.basicViewType !== 'keyboard') return false
  if ('splitKeyMode' in obj && obj.splitKeyMode != null && obj.splitKeyMode !== 'split' && obj.splitKeyMode !== 'flat') return false
  if ('quickSelect' in obj && obj.quickSelect != null && typeof obj.quickSelect !== 'boolean') return false
  if ('keymapScale' in obj && obj.keymapScale != null && (typeof obj.keymapScale !== 'number' || obj.keymapScale < 0.3 || obj.keymapScale > 2.0)) return false
  if ('keyEditorZoom' in obj && obj.keyEditorZoom != null && (typeof obj.keyEditorZoom !== 'number' || obj.keyEditorZoom < 50 || obj.keyEditorZoom > 200)) return false
  if ('typingTestViewOnly' in obj && obj.typingTestViewOnly != null && typeof obj.typingTestViewOnly !== 'boolean') return false
  if ('typingTestViewOnlyWindowSize' in obj && obj.typingTestViewOnlyWindowSize != null) {
    if (typeof obj.typingTestViewOnlyWindowSize !== 'object' || Array.isArray(obj.typingTestViewOnlyWindowSize)) return false
    const ws = obj.typingTestViewOnlyWindowSize as Record<string, unknown>
    if (typeof ws.width !== 'number' || typeof ws.height !== 'number') return false
  }
  if ('typingTestViewOnlyAlwaysOnTop' in obj && obj.typingTestViewOnlyAlwaysOnTop != null && typeof obj.typingTestViewOnlyAlwaysOnTop !== 'boolean') return false
  if ('typingTestMemory' in obj && obj.typingTestMemory != null && (typeof obj.typingTestMemory !== 'object' || Array.isArray(obj.typingTestMemory))) return false
  if ('typingTestDisplayLines' in obj && obj.typingTestDisplayLines != null && typeof obj.typingTestDisplayLines !== 'number') return false
  if ('typingTestFontSize' in obj && obj.typingTestFontSize != null && typeof obj.typingTestFontSize !== 'number') return false
  if ('typingTestHideKeymap' in obj && obj.typingTestHideKeymap != null && typeof obj.typingTestHideKeymap !== 'boolean') return false
  if ('typingTestHideStatsRow' in obj && obj.typingTestHideStatsRow != null && typeof obj.typingTestHideStatsRow !== 'boolean') return false
  if ('typingTestHideControls' in obj && obj.typingTestHideControls != null && typeof obj.typingTestHideControls !== 'boolean') return false
  if ('typingTestSaveUnnamed' in obj && obj.typingTestSaveUnnamed != null && typeof obj.typingTestSaveUnnamed !== 'boolean') return false
  if ('typingTestComparisonBaselines' in obj && obj.typingTestComparisonBaselines != null && !isTypingTestComparisonBaselines(obj.typingTestComparisonBaselines)) return false
  if ('typingTestSettingsPanelOpen' in obj && obj.typingTestSettingsPanelOpen != null && typeof obj.typingTestSettingsPanelOpen !== 'boolean') return false
  if ('typingRecordEnabled' in obj && obj.typingRecordEnabled != null && typeof obj.typingRecordEnabled !== 'boolean') return false
  if ('typingSyncSpanDays' in obj && obj.typingSyncSpanDays != null && !isTypingSyncSpanDays(obj.typingSyncSpanDays)) return false
  if ('typingViewMenuTab' in obj && obj.typingViewMenuTab != null && !isTypingViewMenuTab(obj.typingViewMenuTab)) return false
  if ('viewMode' in obj && obj.viewMode != null && !VIEW_MODES.includes(obj.viewMode as ViewMode)) return false
  if ('analyze' in obj && !isValidAnalyzeSettings(obj.analyze)) return false
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

export async function readPipetteSettings(uid: string): Promise<PipetteSettings | null> {
  if (!isSafePathSegment(uid)) return null
  return readData(uid)
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
      layerPanelOpen: parsed.layerPanelOpen,
      basicViewType: parsed.basicViewType,
      splitKeyMode: parsed.splitKeyMode,
      quickSelect: parsed.quickSelect,
      keymapScale: parsed.keymapScale,
      keyEditorZoom: parsed.keyEditorZoom,
      layerNames: parsed.layerNames ?? [],
      typingTestResults: parsed.typingTestResults,
      typingTestConfig: parsed.typingTestConfig,
      typingTestNormalConfig: parsed.typingTestNormalConfig,
      typingTestLanguage: parsed.typingTestLanguage,
      typingTestViewOnly: parsed.typingTestViewOnly,
      typingTestViewOnlyWindowSize: parsed.typingTestViewOnlyWindowSize,
      typingTestViewOnlyAlwaysOnTop: parsed.typingTestViewOnlyAlwaysOnTop,
      typingTestMemory: parsed.typingTestMemory,
      typingTestDisplayLines: parsed.typingTestDisplayLines,
      typingTestFontSize: parsed.typingTestFontSize,
      typingTestHideKeymap: parsed.typingTestHideKeymap,
      typingTestHideStatsRow: parsed.typingTestHideStatsRow,
      typingTestHideControls: parsed.typingTestHideControls,
      typingTestSaveUnnamed: parsed.typingTestSaveUnnamed,
      typingTestComparisonBaselines: parsed.typingTestComparisonBaselines,
      typingTestSettingsPanelOpen: parsed.typingTestSettingsPanelOpen,
      typingRecordEnabled: parsed.typingRecordEnabled,
      typingSyncSpanDays: parsed.typingSyncSpanDays,
      typingViewMenuTab: parsed.typingViewMenuTab,
      viewMode: parsed.viewMode,
      analyze: parsed.analyze,
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

/** Merge `base.analyze` with `partial.analyze` one level deep so the three
 * analyze writers (filters / fingerAssignments / goal) only ever send their
 * own sub-fields and never clobber each other's. `undefined` skips a
 * sub-field (leave existing); an empty object/array clears that field's
 * contents (e.g. fingerAssignments `{}` drops all overrides). */
function mergeAnalyze(base: unknown, partial: Record<string, unknown>): Record<string, unknown> {
  const merged: Record<string, unknown> = isRecord(base) ? { ...base } : {}
  for (const [k, v] of Object.entries(partial)) {
    if (v === undefined) continue
    merged[k] = v
  }
  return merged
}

/** Shallow-merge only the defined keys of `partial` onto `base` so a writer
 * that omits (or leaves undefined) a field never erases the persisted value
 * another writer owns. `undefined` skips a field; `null` clears it (removes
 * the key, used by the full-prefs writer for owned fields like
 * `typingTestMemory`). `analyze` is merged one level deeper (see
 * {@link mergeAnalyze}) because three independent writers own disjoint
 * sub-fields of it. */
function mergeDefined(base: PipetteSettings, partial: PipetteSettingsPatch): PipetteSettings {
  const merged: Record<string, unknown> = { ...base }
  for (const [k, v] of Object.entries(partial)) {
    if (v === undefined) continue
    if (v === null) {
      delete merged[k]
    } else if (k === 'analyze' && isRecord(v)) {
      merged.analyze = mergeAnalyze(base.analyze, v)
    } else {
      merged[k] = v
    }
  }
  return merged as PipetteSettings
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
  // so concurrent writers (full prefs / analyze filters / goal / keymap
  // scale) never clobber each other. The read-merge-write runs inside the
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
          const merged = mergeDefined(existing ?? DEFAULT_PIPETTE_SETTINGS, partial)
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
