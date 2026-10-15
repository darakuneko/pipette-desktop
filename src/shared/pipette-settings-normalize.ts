// SPDX-License-Identifier: GPL-2.0-or-later
// The content rules of a keyboard's pipette settings file
// (sync/keyboards/{uid}/pipette_settings.json), shared by every process that
// reads or writes one: which files are valid, which fields a read keeps and
// in what order, how a patch merges into the stored settings, what a new
// file starts from, and the text a write stores. The file I/O stays with
// the caller (src/main/pipette-settings-store.ts, and the Tauri shim's
// src/tauri-shim/api/settings.ts).

import type { AppConfig } from './types/app-config'
import type { PipetteSettings, PipetteSettingsPatch, ViewMode } from './types/pipette-settings'
import { VIEW_MODES, DEFAULT_PIPETTE_SETTINGS, isTypingSyncSpanDays, isTypingTestComparisonBaselines } from './types/pipette-settings'
import { isPositiveInt, isValidAnalyzeFilterSettings } from './types/analyze-filters'
import { isFingerType, isPosKey } from './kle/kle-ergonomics'
import { isRecord } from './vil-file'

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
      if (!isPosKey(k)) return false
      if (!isFingerType(v)) return false
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
  if ('showBenchmark' in obj && obj.showBenchmark != null && typeof obj.showBenchmark !== 'boolean') return false
  return true
}

/** Validates `viewMatrix`: an object keyed by physical `"row,col"` mapping
 *  to a `{ row, col }` logical override. Any malformed entry rejects the
 *  whole map, matching the defensive style used for `typingTestMemory`
 *  (an untrustworthy map is dropped entirely rather than partially kept). */
function isValidViewMatrix(value: unknown): boolean {
  if (value == null) return true
  if (typeof value !== 'object' || Array.isArray(value)) return false
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (!isPosKey(k)) return false
    if (typeof v !== 'object' || v === null || Array.isArray(v)) return false
    const cell = v as Record<string, unknown>
    if (!Number.isInteger(cell.row) || (cell.row as number) < 0) return false
    if (!Number.isInteger(cell.col) || (cell.col as number) < 0) return false
  }
  return true
}

export function isValidPrefs(value: unknown): value is PipetteSettings {
  if (typeof value !== 'object' || value === null) return false
  const obj = value as Record<string, unknown>
  if (typeof obj.keyboardLayout !== 'string') return false
  if (typeof obj.autoAdvance !== 'boolean') return false
  if ('layerNames' in obj && !Array.isArray(obj.layerNames)) return false
  if (Array.isArray(obj.layerNames) && (obj.layerNames as unknown[]).some((n) => typeof n !== 'string')) return false
  if ('typingTestResults' in obj && obj.typingTestResults != null && !Array.isArray(obj.typingTestResults)) return false
  if ('typingTestConfig' in obj && obj.typingTestConfig != null && (typeof obj.typingTestConfig !== 'object' || Array.isArray(obj.typingTestConfig))) return false
  if ('typingTestMonkeytypeConfig' in obj && obj.typingTestMonkeytypeConfig != null && (typeof obj.typingTestMonkeytypeConfig !== 'object' || Array.isArray(obj.typingTestMonkeytypeConfig))) return false
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
  if ('typingTestViewOnlyOpacity' in obj && obj.typingTestViewOnlyOpacity != null && typeof obj.typingTestViewOnlyOpacity !== 'number') return false
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
  if ('viewMode' in obj && obj.viewMode != null && !VIEW_MODES.includes(obj.viewMode as ViewMode)) return false
  if ('analyze' in obj && !isValidAnalyzeSettings(obj.analyze)) return false
  if ('viewMatrix' in obj && !isValidViewMatrix(obj.viewMatrix)) return false
  if ('viewMatrixWires' in obj && obj.viewMatrixWires != null && typeof obj.viewMatrixWires !== 'boolean') return false
  if ('layerHoverPreview' in obj && obj.layerHoverPreview != null && typeof obj.layerHoverPreview !== 'boolean') return false
  if ('entryHoverPreview' in obj && obj.entryHoverPreview != null && typeof obj.entryHoverPreview !== 'boolean') return false
  if ('keycodeTabOrder' in obj && obj.keycodeTabOrder != null && (!Array.isArray(obj.keycodeTabOrder) || (obj.keycodeTabOrder as unknown[]).some((id) => typeof id !== 'string'))) return false
  if ('_rev' in obj && obj._rev !== 1) return false
  return true
}

export function validatePrefs(prefs: unknown): asserts prefs is PipetteSettings {
  if (!isValidPrefs(prefs)) {
    throw new Error('Invalid prefs')
  }
}

/** The settings of a parsed file, or null when the file is not valid
 *  settings. Only the known fields are kept, in this order; `_rev` is
 *  always 1 and a missing `layerNames` reads as `[]`. A field the file does
 *  not have is kept as an undefined property, so a patch that sets it later
 *  puts it in its place here. */
export function normalizePipetteSettings(parsed: unknown): PipetteSettings | null {
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
    typingTestMonkeytypeConfig: parsed.typingTestMonkeytypeConfig,
    typingTestLanguage: parsed.typingTestLanguage,
    typingTestViewOnly: parsed.typingTestViewOnly,
    typingTestViewOnlyWindowSize: parsed.typingTestViewOnlyWindowSize,
    typingTestViewOnlyAlwaysOnTop: parsed.typingTestViewOnlyAlwaysOnTop,
    typingTestViewOnlyOpacity: parsed.typingTestViewOnlyOpacity,
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
    viewMode: parsed.viewMode,
    analyze: parsed.analyze,
    viewMatrix: parsed.viewMatrix,
    viewMatrixWires: parsed.viewMatrixWires,
    layerHoverPreview: parsed.layerHoverPreview,
    entryHoverPreview: parsed.entryHoverPreview,
    keycodeTabOrder: parsed.keycodeTabOrder,
  }
}

/** The settings in a file's text, or null when it is not JSON or not valid
 *  settings. */
export function parsePipetteSettings(raw: string): PipetteSettings | null {
  try {
    return normalizePipetteSettings(JSON.parse(raw))
  } catch {
    return null
  }
}

/** Merge `base.analyze` with `partial.analyze` one level deep so the three
 * analyze writers (filters / fingerAssignments / goal) only ever send their
 * own sub-fields and never clobber each other's. `undefined` skips a
 * sub-field (leave existing); an empty object/array clears that field's
 * contents (e.g. fingerAssignments `{}` drops all overrides). */
export function mergeAnalyze(base: unknown, partial: Record<string, unknown>): Record<string, unknown> {
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
 * the key — used by setters that clear a field such as `typingTestMemory`
 * or `viewMatrix`). `analyze` is merged one level deeper (see
 * {@link mergeAnalyze}) because three independent writers own disjoint
 * sub-fields of it. */
export function mergeDefined(base: PipetteSettings, partial: PipetteSettingsPatch): PipetteSettings {
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
  // merged is built up dynamically from PipetteSettings's own fields plus
  // the patch, so it satisfies the shape at runtime; the untyped Record
  // accumulator just doesn't retain enough literal-key info for `as` to
  // see the overlap directly.
  return merged as unknown as PipetteSettings
}

/** What a new file starts from: the app-wide defaults the renderer shows
 *  for a keyboard without saved settings, so the first field-level save
 *  does not pin the shared constant's layout / auto-advance. */
export function newSettingsBase(
  config: Pick<AppConfig, 'defaultKeyboardLayout' | 'defaultAutoAdvance'>,
): PipetteSettings {
  return {
    ...DEFAULT_PIPETTE_SETTINGS,
    keyboardLayout: typeof config.defaultKeyboardLayout === 'string' && config.defaultKeyboardLayout.length > 0
      ? config.defaultKeyboardLayout
      : DEFAULT_PIPETTE_SETTINGS.keyboardLayout,
    autoAdvance: config.defaultAutoAdvance,
  }
}

/** The text a write stores for `prefs`: `_rev: 1`, `layerNames` (`[]` when
 *  missing) and `_updatedAt` (now) over the settings, as compact JSON. */
export function serializePipetteSettings(prefs: PipetteSettings): string {
  const data: PipetteSettings = {
    ...prefs,
    _rev: 1,
    layerNames: prefs.layerNames ?? [],
    _updatedAt: new Date().toISOString(),
  }
  return JSON.stringify(data)
}
