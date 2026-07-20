// SPDX-License-Identifier: GPL-2.0-or-later

import { useState, useCallback, useEffect, useMemo, useRef } from 'react'
import type { KeyboardLayoutId } from '../data/keyboard-layouts'
import { useKeyLabelLookup } from './useKeyLabelLookup'
import { buildKeymapRewriteTable } from '../../shared/keymap/keymap-apply'
import type { RemapKind } from '../components/keyboard/constants'
import { useAppConfig } from './useAppConfig'
import { MIN_SCALE, MAX_SCALE } from '../components/editors/keymap-editor-types'
import type { TypingTestResult, TypingViewMenuTab, ViewMode, TypingTestMemory, TypingTestMemoryWord, TypingTestComparisonBaseline, TypingTestComparisonBaselines, ViewMatrixCell } from '../../shared/types/pipette-settings'
import { VIEW_MODES, isTypingViewMenuTab, isTypingTestComparisonBaselines } from '../../shared/types/pipette-settings'
import { trimResults } from '../typing-test/result-builder'
import type { TypingTestConfig, RomajiDetailSettings, RomajiCaseStyle } from '../typing-test/types'
import { DEFAULT_DISPLAY_LINES, DEFAULT_FONT_SIZE, clampDisplayLines, clampFontSize } from '../typing-test/types'
import type { RomajiStyle } from '../typing-test/romaji-engine'
import type { AutoLockMinutes, BasicViewType, SplitKeyMode } from '../../shared/types/app-config'
import { clampZoomFactor } from '../../shared/types/app-config'

export type { KeyboardLayoutId, AutoLockMinutes, BasicViewType, SplitKeyMode }

const VALID_QUOTE_LENGTHS: ReadonlySet<string> = new Set(['short', 'medium', 'long', 'all'])
const VALID_ROMAJI_STYLES: ReadonlySet<string> = new Set([
  'hepburn', 'kunrei',
  'c', 'q', 'digraph', 'xSmall', 'lSmall', 'w', 'v', 'f', 'ye', 'xn', 'nApos',
])
const VALID_ROMAJI_CASE_STYLES: ReadonlySet<string> = new Set(['lower', 'capital', 'upper'])

function isFinitePositiveInt(n: unknown): n is number {
  return typeof n === 'number' && Number.isFinite(n) && n > 0 && Number.isInteger(n)
}

function hasBooleanFields(obj: Record<string, unknown>, ...keys: string[]): boolean {
  return keys.every((k) => typeof obj[k] === 'boolean')
}

/** Validates `config.romaji` (Romaji Settings modal fields) field-by-field:
 *  an unknown/malformed field is dropped individually instead of rejecting
 *  the whole nested object, so a stray/corrupted field never takes out
 *  fields that did validate (Plan-typing-romaji-settings-modal design
 *  judgement #9 — the same nested-config drop bug that hit `romajiInput`
 *  before it was carried through explicitly below). Returns undefined when
 *  `raw` isn't a plausible object, or every field turned out invalid. */
function validateRomajiDetailSettings(raw: unknown): RomajiDetailSettings | undefined {
  if (raw == null || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const obj = raw as Record<string, unknown>
  const result: RomajiDetailSettings = {}
  if (typeof obj.caseStyle === 'string' && VALID_ROMAJI_CASE_STYLES.has(obj.caseStyle)) {
    result.caseStyle = obj.caseStyle as RomajiCaseStyle
  }
  // A persisted `fontSize` (from a build that still had the per-guide font
  // control) is intentionally not read here — it silently falls through to
  // "not set" now that the guide always tracks Settings > Font.
  if (Array.isArray(obj.guideStyles)) {
    // 'hepburn' is dropped here (unlike disabledStyles below, which keeps
    // it): the Guide row's Base selection is single-select, and hepburn is
    // its implicit default — the modal never writes 'hepburn' into
    // guideStyles itself (see RomajiSettingsModal's selectGuideBase), and
    // GUIDE_STYLE_PRIORITY in romaji-engine.ts has no 'hepburn' entry, so a
    // stray 'hepburn' here would sit inert. Sanitizing it out keeps a
    // hand-edited or legacy-written config equivalent to the canonical
    // default rather than persisting a functionally meaningless entry.
    const styles = obj.guideStyles.filter(
      (s): s is RomajiStyle => typeof s === 'string' && VALID_ROMAJI_STYLES.has(s) && s !== 'hepburn',
    )
    if (styles.length > 0) result.guideStyles = styles
  }
  if (Array.isArray(obj.disabledStyles)) {
    let styles = obj.disabledStyles.filter(
      (s): s is RomajiStyle => typeof s === 'string' && VALID_ROMAJI_STYLES.has(s),
    )
    // At least one base system (hepburn/kunrei) must stay enabled — the
    // Romaji Settings modal enforces this on the way in, but a persisted
    // config could still carry both disabled (e.g. hand-edited, or written
    // by a future version with looser rules). Sanitize deterministically
    // by dropping 'kunrei' from the disabled set rather than rejecting the
    // whole field, so kunrei-shiki wins and stays enabled.
    if (styles.includes('hepburn') && styles.includes('kunrei')) {
      styles = styles.filter((s) => s !== 'kunrei')
    }
    if (styles.length > 0) result.disabledStyles = styles
  }
  if (
    typeof obj.guideWordCount === 'number'
    && Number.isInteger(obj.guideWordCount)
    && obj.guideWordCount >= 0
    && obj.guideWordCount <= 3
  ) {
    result.guideWordCount = obj.guideWordCount
  }
  return Object.keys(result).length > 0 ? result : undefined
}

function validateTypingTestConfig(raw: unknown): TypingTestConfig | undefined {
  if (raw == null || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const obj = raw as Record<string, unknown>
  // Optional carry-through: keep a persisted boolean romajiInput on
  // words/time/tatoeba/fileImport configs (every mode but quote), drop any
  // other type silently (the field is optional, so a malformed value
  // degrades to "not set" rather than rejecting the whole config). Same
  // treatment for the nested `romaji` detail settings.
  const romajiInput = typeof obj.romajiInput === 'boolean' ? { romajiInput: obj.romajiInput } : {}
  const romaji = validateRomajiDetailSettings(obj.romaji)
  const romajiDetail = romaji ? { romaji } : {}
  switch (obj.mode) {
    case 'words':
      if (!isFinitePositiveInt(obj.wordCount) || !hasBooleanFields(obj, 'punctuation', 'numbers')) return undefined
      return { mode: 'words', wordCount: obj.wordCount, punctuation: obj.punctuation as boolean, numbers: obj.numbers as boolean, ...romajiInput, ...romajiDetail }
    case 'time':
      if (!isFinitePositiveInt(obj.duration) || !hasBooleanFields(obj, 'punctuation', 'numbers')) return undefined
      return { mode: 'time', duration: obj.duration, punctuation: obj.punctuation as boolean, numbers: obj.numbers as boolean, ...romajiInput, ...romajiDetail }
    case 'quote':
      if (typeof obj.quoteLength !== 'string' || !VALID_QUOTE_LENGTHS.has(obj.quoteLength)) return undefined
      return { mode: 'quote', quoteLength: obj.quoteLength as 'short' | 'medium' | 'long' | 'all' }
    case 'fileImport':
      if (typeof obj.textId !== 'string' || obj.textId.length === 0) return undefined
      return { mode: 'fileImport', textId: obj.textId, ...romajiInput, ...romajiDetail }
    case 'tatoeba': {
      if (typeof obj.language !== 'string' || obj.language.length === 0) return undefined
      // Older configs (saved before Tatoeba gained its own Pattern/Units)
      // lack pattern/lineCount/duration — default them rather than reject
      // the whole config, same treatment as every other optional-carry-
      // through field on this type.
      const pattern = obj.pattern === 'time' ? 'time' : 'lines'
      const lineCount = isFinitePositiveInt(obj.lineCount) ? obj.lineCount : 5
      const duration = isFinitePositiveInt(obj.duration) ? obj.duration : 30
      return { mode: 'tatoeba', language: obj.language, pattern, lineCount, duration, ...romajiInput, ...romajiDetail }
    }
    default:
      return undefined
  }
}

/** The MonkeyType-family modes whose config is remembered as the fallback
 *  restored when leaving fileImport / tatoeba. */
function isMonkeytypeMode(mode: TypingTestConfig['mode']): boolean {
  return mode === 'words' || mode === 'time' || mode === 'quote'
}

/** The MonkeyType fallback config must be a normal (words/time/quote) config.
 *  Reject any fileImport / tatoeba value — including a stale one persisted by
 *  an older build — so leaving those modes never restores them. */
function validateMonkeytypeConfig(raw: unknown): TypingTestConfig | undefined {
  const cfg = validateTypingTestConfig(raw)
  return cfg && isMonkeytypeMode(cfg.mode) ? cfg : undefined
}

function validateTypingTestLanguage(raw: unknown): string | undefined {
  if (typeof raw !== 'string' || raw.length === 0) return undefined
  return raw
}

function validateTypingTestMemory(raw: unknown): TypingTestMemory | undefined {
  if (raw == null || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const o = raw as Record<string, unknown>
  if (typeof o.textId !== 'string' || o.textId.length === 0) return undefined
  if (typeof o.currentWordIndex !== 'number' || !Number.isFinite(o.currentWordIndex) || o.currentWordIndex < 0) return undefined
  if (typeof o.currentInput !== 'string') return undefined
  if (typeof o.correctChars !== 'number' || typeof o.incorrectChars !== 'number') return undefined
  if (typeof o.elapsedMs !== 'number' || !Number.isFinite(o.elapsedMs) || o.elapsedMs < 0) return undefined
  if (!Array.isArray(o.wordResults)) return undefined
  const rawResults = o.wordResults as unknown[]
  const wordResults = rawResults.filter((w): w is TypingTestMemoryWord => {
    if (typeof w !== 'object' || w === null) return false
    const r = w as Record<string, unknown>
    return typeof r.word === 'string' && typeof r.typed === 'string' && typeof r.correct === 'boolean'
  })
  // A malformed entry means the snapshot is untrustworthy — discard it.
  if (wordResults.length !== rawResults.length) return undefined
  const wpmHistory = Array.isArray(o.wpmHistory)
    ? (o.wpmHistory as unknown[]).filter((n): n is number => typeof n === 'number')
    : []
  return {
    textId: o.textId,
    currentWordIndex: o.currentWordIndex,
    currentInput: o.currentInput,
    wordResults,
    correctChars: o.correctChars,
    incorrectChars: o.incorrectChars,
    elapsedMs: o.elapsedMs,
    wpmHistory,
    savedAt: typeof o.savedAt === 'string' ? o.savedAt : new Date(0).toISOString(),
  }
}

function isValidTypingTestResult(item: unknown): item is TypingTestResult {
  if (typeof item !== 'object' || item === null) return false
  const r = item as Record<string, unknown>
  return typeof r.date === 'string' && typeof r.wpm === 'number' && typeof r.accuracy === 'number'
}

/** Validates a result's optional `mistakes` field: a plain object mapping
 *  every key to a finite number. Returns `undefined` for anything else
 *  (absent, wrong shape, non-numeric/non-finite values) so a malformed
 *  field degrades to "not set" rather than rejecting the whole result —
 *  same treatment as the other optional fields on `TypingTestResult`. */
function sanitizeMistakes(raw: unknown): Record<string, number> | undefined {
  if (raw == null || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const entries = Object.entries(raw as Record<string, unknown>)
  if (entries.length === 0) return undefined
  const mistakes: Record<string, number> = {}
  for (const [key, value] of entries) {
    if (typeof value !== 'number' || !Number.isFinite(value)) return undefined
    mistakes[key] = value
  }
  return mistakes
}

/** Drops a malformed `mistakes` field without discarding the rest of an
 *  already-`isValidTypingTestResult`-checked result. Applied after the
 *  filter above so a persisted result with a corrupted `mistakes` blob
 *  still survives (minus that one field) instead of vanishing from
 *  History entirely. */
function sanitizeTypingTestResult(result: TypingTestResult): TypingTestResult {
  const mistakes = sanitizeMistakes(result.mistakes)
  if (mistakes) return { ...result, mistakes }
  if (result.mistakes === undefined) return result
  const { mistakes: _dropped, ...rest } = result
  return rest
}

const VALID_BASIC_VIEW_TYPES: ReadonlySet<string> = new Set(['ansi', 'iso', 'jis', 'list'])
const LEGACY_BASIC_VIEW_MAP: Record<string, string> = { keyboard: 'ansi' }
const VALID_SPLIT_KEY_MODES: ReadonlySet<string> = new Set(['split', 'flat'])
const VALID_VIEW_MODES: ReadonlySet<string> = new Set(VIEW_MODES)

interface ValidatedPrefs {
  keyboardLayout: KeyboardLayoutId
  autoAdvance: boolean
  layerPanelOpen: boolean
  basicViewType: BasicViewType
  splitKeyMode: SplitKeyMode
  quickSelect: boolean
  keymapScale: number
  layerNames: string[]
  typingTestResults: TypingTestResult[]
  typingTestConfig?: TypingTestConfig
  typingTestMonkeytypeConfig?: TypingTestConfig
  typingTestLanguage?: string
  typingTestViewOnly: boolean
  typingTestViewOnlyWindowSize?: { width: number; height: number }
  typingTestViewOnlyAlwaysOnTop: boolean
  typingTestMemory?: TypingTestMemory
  typingTestDisplayLines: number
  typingTestFontSize: number
  typingTestHideKeymap: boolean
  typingTestHideStatsRow: boolean
  typingTestHideControls: boolean
  typingTestSaveUnnamed: boolean
  typingTestComparisonBaselines: TypingTestComparisonBaselines
  typingTestSettingsPanelOpen: boolean
  typingRecordEnabled: boolean
  typingViewMenuTab: TypingViewMenuTab
  viewMode: ViewMode
  keyEditorZoom?: number
  viewMatrix?: Record<string, ViewMatrixCell>
}

function validateIpcPrefs(
  data: { keyboardLayout: string; autoAdvance: boolean; layerPanelOpen?: boolean; basicViewType?: string; splitKeyMode?: string; quickSelect?: boolean; keymapScale?: number; keyEditorZoom?: number; layerNames?: string[]; typingTestResults?: TypingTestResult[]; typingTestConfig?: unknown; typingTestMonkeytypeConfig?: unknown; typingTestLanguage?: unknown; typingTestViewOnly?: boolean; typingTestViewOnlyWindowSize?: unknown; typingTestViewOnlyAlwaysOnTop?: boolean; typingTestMemory?: unknown; typingTestDisplayLines?: unknown; typingTestFontSize?: unknown; typingTestHideKeymap?: boolean; typingTestHideStatsRow?: boolean; typingTestHideControls?: boolean; typingTestSaveUnnamed?: boolean; typingTestComparisonBaselines?: unknown; typingTestSettingsPanelOpen?: boolean; typingRecordEnabled?: boolean; typingViewMenuTab?: unknown; viewMode?: unknown; viewMatrix?: Record<string, ViewMatrixCell> } | null,
  defaultLayout: KeyboardLayoutId,
  defaultAutoAdvance: boolean,
  defaultLayerPanelOpen: boolean,
  defaultBasicViewType: BasicViewType,
  defaultSplitKeyMode: SplitKeyMode,
  defaultQuickSelect: boolean,
): ValidatedPrefs | null {
  if (!data) return null

  // After the Key Labels migration the built-in `LAYOUT_ID_SET` only
  // covers QWERTY. Any saved id that is not empty is accepted here; the
  // Key Label store is consulted at render time and falls back to
  // QWERTY when the id is not (yet) installed locally.
  const layout = typeof data.keyboardLayout === 'string' && data.keyboardLayout.length > 0
    ? data.keyboardLayout
    : null
  const autoAdvance = typeof data.autoAdvance === 'boolean' ? data.autoAdvance : null
  if (layout === null && autoAdvance === null) return null

  const layerPanelOpen = typeof data.layerPanelOpen === 'boolean' ? data.layerPanelOpen : defaultLayerPanelOpen
  const rawBasicView = typeof data.basicViewType === 'string'
    ? (LEGACY_BASIC_VIEW_MAP[data.basicViewType] ?? data.basicViewType)
    : null
  const basicViewType = rawBasicView !== null && VALID_BASIC_VIEW_TYPES.has(rawBasicView)
    ? rawBasicView as BasicViewType
    : defaultBasicViewType
  const splitKeyMode = typeof data.splitKeyMode === 'string' && VALID_SPLIT_KEY_MODES.has(data.splitKeyMode)
    ? data.splitKeyMode as SplitKeyMode
    : defaultSplitKeyMode
  const quickSelect = typeof data.quickSelect === 'boolean' ? data.quickSelect : defaultQuickSelect
  const keymapScale = typeof data.keymapScale === 'number' && data.keymapScale >= MIN_SCALE && data.keymapScale <= MAX_SCALE
    ? Math.round(data.keymapScale * 10) / 10
    : 1

  const layerNames = Array.isArray(data.layerNames)
    ? data.layerNames.filter((n): n is string => typeof n === 'string')
    : []
  const typingTestResults = Array.isArray(data.typingTestResults)
    ? data.typingTestResults.filter(isValidTypingTestResult).map(sanitizeTypingTestResult)
    : []

  // Legacy migration: { mode: 'viewOnly' } → separate boolean
  let typingTestConfig = validateTypingTestConfig(data.typingTestConfig)
  let typingTestViewOnly = typeof data.typingTestViewOnly === 'boolean' ? data.typingTestViewOnly : false
  if (!typingTestConfig && data.typingTestConfig != null) {
    const raw = data.typingTestConfig as Record<string, unknown>
    if (raw.mode === 'viewOnly') {
      typingTestViewOnly = true
      typingTestConfig = undefined
    }
  }

  const viewMode: ViewMode = typeof data.viewMode === 'string' && VALID_VIEW_MODES.has(data.viewMode)
    ? data.viewMode as ViewMode
    : 'editor'

  return {
    keyboardLayout: layout ?? defaultLayout,
    autoAdvance: autoAdvance ?? defaultAutoAdvance,
    layerPanelOpen,
    basicViewType,
    splitKeyMode,
    quickSelect,
    keymapScale,
    layerNames,
    typingTestResults,
    typingTestConfig,
    typingTestMonkeytypeConfig: validateMonkeytypeConfig(data.typingTestMonkeytypeConfig),
    typingTestLanguage: validateTypingTestLanguage(data.typingTestLanguage),
    typingTestViewOnly,
    typingTestViewOnlyWindowSize: validateWindowSize(data.typingTestViewOnlyWindowSize),
    typingTestViewOnlyAlwaysOnTop: typeof data.typingTestViewOnlyAlwaysOnTop === 'boolean' ? data.typingTestViewOnlyAlwaysOnTop : false,
    typingTestMemory: validateTypingTestMemory(data.typingTestMemory),
    typingTestDisplayLines: typeof data.typingTestDisplayLines === 'number' ? clampDisplayLines(data.typingTestDisplayLines) : DEFAULT_DISPLAY_LINES,
    typingTestFontSize: typeof data.typingTestFontSize === 'number' ? clampFontSize(data.typingTestFontSize) : DEFAULT_FONT_SIZE,
    typingTestHideKeymap: data.typingTestHideKeymap === true,
    typingTestHideStatsRow: data.typingTestHideStatsRow === true,
    typingTestHideControls: data.typingTestHideControls === true,
    // Default true: a finished result is auto-saved unless the user opts out.
    typingTestSaveUnnamed: data.typingTestSaveUnnamed !== false,
    typingTestComparisonBaselines: isTypingTestComparisonBaselines(data.typingTestComparisonBaselines) ? data.typingTestComparisonBaselines : {},
    typingTestSettingsPanelOpen: typeof data.typingTestSettingsPanelOpen === 'boolean' ? data.typingTestSettingsPanelOpen : true,
    typingRecordEnabled: typeof data.typingRecordEnabled === 'boolean' ? data.typingRecordEnabled : false,
    typingViewMenuTab: isTypingViewMenuTab(data.typingViewMenuTab) ? data.typingViewMenuTab : 'window',
    viewMode,
    keyEditorZoom: typeof data.keyEditorZoom === 'number' ? clampZoomFactor(data.keyEditorZoom) : undefined,
    // Trusted as-is: the main process (pipette-settings-store's
    // isValidViewMatrix) is the single validator for this shape, same as
    // the other store-validated per-keyboard fields.
    viewMatrix: data.viewMatrix,
  }
}

function validateWindowSize(raw: unknown): { width: number; height: number } | undefined {
  if (raw == null || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const obj = raw as Record<string, unknown>
  if (typeof obj.width !== 'number' || typeof obj.height !== 'number') return undefined
  if (obj.width <= 0 || obj.height <= 0) return undefined
  return { width: obj.width, height: obj.height }
}

export interface UseDevicePrefsReturn {
  layout: KeyboardLayoutId
  autoAdvance: boolean
  layerPanelOpen: boolean
  basicViewType: BasicViewType
  splitKeyMode: SplitKeyMode
  quickSelect: boolean
  keymapScale: number
  layerNames: string[]
  typingTestResults: TypingTestResult[]
  typingTestConfig: TypingTestConfig | undefined
  typingTestMonkeytypeConfig: TypingTestConfig | undefined
  typingTestLanguage: string | undefined
  typingTestViewOnly: boolean
  typingTestViewOnlyWindowSize: { width: number; height: number } | undefined
  typingTestViewOnlyAlwaysOnTop: boolean
  typingTestMemory: TypingTestMemory | undefined
  typingTestDisplayLines: number
  typingTestFontSize: number
  typingTestHideKeymap: boolean
  typingTestHideStatsRow: boolean
  typingTestHideControls: boolean
  typingTestSaveUnnamed: boolean
  typingTestComparisonBaselines: TypingTestComparisonBaselines
  typingTestSettingsPanelOpen: boolean
  typingRecordEnabled: boolean
  typingViewMenuTab: TypingViewMenuTab
  viewMode: ViewMode
  keyEditorZoom: number | undefined
  viewMatrix: Record<string, ViewMatrixCell> | undefined
  appliedUid: string | null
  setLayout: (id: KeyboardLayoutId) => void
  setAutoAdvance: (enabled: boolean) => void
  setLayerPanelOpen: (open: boolean) => void
  setBasicViewType: (type: BasicViewType) => void
  setSplitKeyMode: (mode: SplitKeyMode) => void
  setQuickSelect: (enabled: boolean) => void
  setKeymapScale: (scale: number) => void
  setLayerNames: (names: string[]) => void
  addTypingTestResult: (result: TypingTestResult) => void
  renameTypingTestResult: (date: string, name: string) => void
  deleteTypingTestResult: (date: string) => void
  setTypingTestConfig: (config: TypingTestConfig) => void
  setTypingTestLanguage: (lang: string) => void
  setTypingTestViewOnly: (enabled: boolean) => void
  setTypingTestViewOnlyWindowSize: (size: { width: number; height: number }) => void
  setTypingTestViewOnlyAlwaysOnTop: (enabled: boolean) => void
  setTypingTestMemory: (memory: TypingTestMemory | undefined) => void
  setTypingTestDisplayLines: (lines: number) => void
  setTypingTestFontSize: (px: number) => void
  setTypingTestHideKeymap: (hidden: boolean) => void
  setTypingTestHideStatsRow: (hidden: boolean) => void
  setTypingTestHideControls: (hidden: boolean) => void
  setTypingTestSaveUnnamed: (enabled: boolean) => void
  setTypingTestComparisonBaseline: (conditionKey: string, baseline: TypingTestComparisonBaseline) => void
  setTypingTestSettingsPanelOpen: (open: boolean) => void
  setTypingRecordEnabled: (enabled: boolean) => void
  setTypingViewMenuTab: (tab: TypingViewMenuTab) => void
  setViewMode: (mode: ViewMode) => void
  setKeyEditorZoom: (zoom: number) => void
  setViewMatrix: (next: Record<string, ViewMatrixCell> | undefined) => void
  defaultLayout: KeyboardLayoutId
  defaultAutoAdvance: boolean
  defaultLayerPanelOpen: boolean
  defaultBasicViewType: BasicViewType
  defaultSplitKeyMode: SplitKeyMode
  defaultQuickSelect: boolean
  setDefaultLayout: (id: KeyboardLayoutId) => void
  setDefaultAutoAdvance: (enabled: boolean) => void
  setDefaultLayerPanelOpen: (open: boolean) => void
  setDefaultBasicViewType: (type: BasicViewType) => void
  setDefaultSplitKeyMode: (mode: SplitKeyMode) => void
  setDefaultQuickSelect: (enabled: boolean) => void
  autoLockTime: AutoLockMinutes
  setAutoLockTime: (m: AutoLockMinutes) => void
  applyDevicePrefs: (uid: string) => Promise<void>
  /** Display label for a qmkId: the active Key Label pack's own label
   *  (via `compositeLabels` -> `map`), falling back to the qmkId itself
   *  when neither has an entry. Display Only is the sole remap-rendering
   *  mode (Plan-qwerty-select-no-rewrite v5 最終仕様) — a Rewrite never
   *  leaves anything for this to simulate, since it resets `layout` back
   *  to QWERTY (raw/no-color) on success. */
  remapLabel: (qmkId: string) => string
  /** The blue "remapped" tint source: true whenever `remapLabel(qmkId)`
   *  differs from `qmkId` itself — same rule every picker/palette consumer
   *  applies. */
  isRemapped: (qmkId: string) => boolean
  /** Which remap tint `isRemapped`-tinted keys use on the keymap surface
   *  (keymap pane + typing-test pane; the picker is untouched — see
   *  `pickerRemapLabel` below). `'simulated'` iff an active (non-empty)
   *  pack map is loaded and it's a pure permutation (same `.ok` verdict
   *  `rewriteTableResult` already computes for the Rewrite gate) — the
   *  "labels show what a Rewrite WOULD produce, pressing still types the
   *  old character" case. `'actual'` otherwise: JIS-type display remaps
   *  (truthful — the OS/IME really produces the shown char), QWERTY/no
   *  pack (irrelevant since no key is ever tinted there), and
   *  non-permutation deviation packs. */
  remapKind: RemapKind
  /** Display name of the active layout/pack — see `remapKind`'s sibling
   *  doc comment on `activeLayoutName` in the hook body for what feeds it. */
  activeLayoutName: string
  /** Display label for a qmkId, but ONLY for the key PICKER surface
   *  (`TabbedKeycodes` / `KeyPopover` → `PopoverTabKey`) — the keymap
   *  legend itself (`useLayerKeycodes`, `KeyWidget`'s masked-inner label)
   *  keeps using `remapLabel` above unconditionally.
   *
   *  Plan-qwerty-select-no-rewrite v6: the picker should only ever change
   *  for a pack that deviates from ANSI (a symbol/label the picker can't
   *  already show as-is — JIS shift pairs, kana, ...). A pure QWERTY-
   *  keycode permutation (Colemak, Eucalyn, Dvorak, ...) swaps WHICH key
   *  sends a character, but every character it swaps in already exists
   *  somewhere in the picker — remapping the picker's own legends for
   *  that case would just be noise (and would desync the picker's
   *  legend from the keycode it actually inserts). So this identity-
   *  passes for a permutation pack and only forwards to `remapLabel` once
   *  the active pack fails the same `buildKeymapRewriteTable` check the
   *  Key Label "apply to keymap" rewrite itself uses to decide
   *  applicability — a deviation pack behaves exactly like `remapLabel`.
   *  QWERTY/no pack has an empty map, which trivially passes the check
   *  (nothing to permute), so it already resolves to identity without a
   *  separate guard. */
  pickerRemapLabel: (qmkId: string) => string
}

/**
 * Pairs a state value with a ref that always holds the latest value.
 * The ref is needed so that saveCurrentPrefs can read current values
 * inside a stable (never-recreated) callback.
 */
function useStateRef<T>(initial: T): [T, (v: T) => void, React.RefObject<T>] {
  const [value, setValue] = useState<T>(initial)
  const ref = useRef(value)
  const update = useCallback((v: T) => {
    ref.current = v
    setValue(v)
  }, [])
  return [value, update, ref]
}

export function useDevicePrefs(): UseDevicePrefsReturn {
  const { config, set } = useAppConfig()

  // Accept any non-empty id; Key Labels installed via the modal are
  // valid even though they are not in the built-in `LAYOUT_ID_SET`.
  const defaultLayout = typeof config.defaultKeyboardLayout === 'string'
    && config.defaultKeyboardLayout.length > 0
    ? config.defaultKeyboardLayout
    : 'qwerty'
  const defaultAutoAdvance = config.defaultAutoAdvance
  const defaultLayerPanelOpen = config.defaultLayerPanelOpen
  const defaultBasicViewType = config.defaultBasicViewType
  const defaultSplitKeyMode = config.defaultSplitKeyMode ?? 'split'
  const defaultQuickSelect = config.defaultQuickSelect ?? false

  const [layout, updateLayout, layoutRef] = useStateRef<KeyboardLayoutId>(defaultLayout)
  const [autoAdvance, updateAutoAdvance, autoAdvanceRef] = useStateRef<boolean>(defaultAutoAdvance)
  const [layerPanelOpen, updateLayerPanelOpen, layerPanelOpenRef] = useStateRef<boolean>(defaultLayerPanelOpen)
  const [basicViewType, updateBasicViewType, basicViewTypeRef] = useStateRef<BasicViewType>(defaultBasicViewType)
  const [splitKeyMode, updateSplitKeyMode, splitKeyModeRef] = useStateRef<SplitKeyMode>(defaultSplitKeyMode)
  const [quickSelect, updateQuickSelect, quickSelectRef] = useStateRef<boolean>(defaultQuickSelect)
  const [keymapScale, updateKeymapScale, keymapScaleRef] = useStateRef<number>(1)
  const [layerNames, updateLayerNames, layerNamesRef] = useStateRef<string[]>([])
  const [typingTestResults, updateTypingTestResults, typingTestResultsRef] = useStateRef<TypingTestResult[]>([])
  const [typingTestConfig, updateTypingTestConfig, typingTestConfigRef] = useStateRef<TypingTestConfig | undefined>(undefined)
  const [typingTestMonkeytypeConfig, updateTypingTestMonkeytypeConfig, typingTestMonkeytypeConfigRef] = useStateRef<TypingTestConfig | undefined>(undefined)
  const [typingTestLanguage, updateTypingTestLanguage, typingTestLanguageRef] = useStateRef<string | undefined>(undefined)
  const [typingTestViewOnly, updateTypingTestViewOnly, typingTestViewOnlyRef] = useStateRef<boolean>(false)
  const [typingTestViewOnlyWindowSize, updateTypingTestViewOnlyWindowSize, typingTestViewOnlyWindowSizeRef] = useStateRef<{ width: number; height: number } | undefined>(undefined)
  const [typingTestViewOnlyAlwaysOnTop, updateTypingTestViewOnlyAlwaysOnTop, typingTestViewOnlyAlwaysOnTopRef] = useStateRef<boolean>(false)
  const [typingTestMemory, updateTypingTestMemory, typingTestMemoryRef] = useStateRef<TypingTestMemory | undefined>(undefined)
  const [typingTestDisplayLines, updateTypingTestDisplayLines, typingTestDisplayLinesRef] = useStateRef<number>(DEFAULT_DISPLAY_LINES)
  const [typingTestFontSize, updateTypingTestFontSize, typingTestFontSizeRef] = useStateRef<number>(DEFAULT_FONT_SIZE)
  const [typingTestHideKeymap, updateTypingTestHideKeymap, typingTestHideKeymapRef] = useStateRef<boolean>(false)
  const [typingTestHideStatsRow, updateTypingTestHideStatsRow, typingTestHideStatsRowRef] = useStateRef<boolean>(false)
  const [typingTestHideControls, updateTypingTestHideControls, typingTestHideControlsRef] = useStateRef<boolean>(false)
  const [typingTestSaveUnnamed, updateTypingTestSaveUnnamed, typingTestSaveUnnamedRef] = useStateRef<boolean>(true)
  const [typingTestComparisonBaselines, updateTypingTestComparisonBaselines, typingTestComparisonBaselinesRef] = useStateRef<TypingTestComparisonBaselines>({})
  const [typingTestSettingsPanelOpen, updateTypingTestSettingsPanelOpen, typingTestSettingsPanelOpenRef] = useStateRef<boolean>(true)
  const [typingRecordEnabled, updateTypingRecordEnabled, typingRecordEnabledRef] = useStateRef<boolean>(false)
  const [typingViewMenuTab, updateTypingViewMenuTab, typingViewMenuTabRef] = useStateRef<TypingViewMenuTab>('window')
  const [viewMode, updateViewMode, viewModeRef] = useStateRef<ViewMode>('editor')
  const [keyEditorZoom, updateKeyEditorZoom, keyEditorZoomRef] = useStateRef<number | undefined>(undefined)
  const [viewMatrix, updateViewMatrix, viewMatrixRef] = useStateRef<Record<string, ViewMatrixCell> | undefined>(undefined)
  const [appliedUid, setAppliedUid] = useState<string | null>(null)

  const uidRef = useRef('')
  const applySeqRef = useRef(0)

  const saveCurrentPrefs = useCallback(() => {
    const uid = uidRef.current
    if (!uid) return
    window.vialAPI.pipetteSettingsPatch(uid, {
      _rev: 1,
      keyboardLayout: layoutRef.current,
      autoAdvance: autoAdvanceRef.current,
      layerPanelOpen: layerPanelOpenRef.current,
      basicViewType: basicViewTypeRef.current,
      splitKeyMode: splitKeyModeRef.current,
      quickSelect: quickSelectRef.current,
      keymapScale: keymapScaleRef.current,
      keyEditorZoom: keyEditorZoomRef.current,
      layerNames: layerNamesRef.current,
      typingTestResults: typingTestResultsRef.current,
      typingTestConfig: typingTestConfigRef.current as Record<string, unknown> | undefined,
      typingTestMonkeytypeConfig: typingTestMonkeytypeConfigRef.current as Record<string, unknown> | undefined,
      typingTestLanguage: typingTestLanguageRef.current,
      typingTestViewOnly: typingTestViewOnlyRef.current,
      typingTestViewOnlyWindowSize: typingTestViewOnlyWindowSizeRef.current,
      typingTestViewOnlyAlwaysOnTop: typingTestViewOnlyAlwaysOnTopRef.current,
      // `null` clears the persisted memory; the field-level PATCH skips
      // `undefined`, so a bare `undefined` would leave a stale paused run
      // on disk after finish / restart.
      typingTestMemory: typingTestMemoryRef.current ?? null,
      typingTestDisplayLines: typingTestDisplayLinesRef.current,
      typingTestFontSize: typingTestFontSizeRef.current,
      typingTestHideKeymap: typingTestHideKeymapRef.current,
      typingTestHideStatsRow: typingTestHideStatsRowRef.current,
      typingTestHideControls: typingTestHideControlsRef.current,
      typingTestSaveUnnamed: typingTestSaveUnnamedRef.current,
      typingTestComparisonBaselines: typingTestComparisonBaselinesRef.current,
      typingTestSettingsPanelOpen: typingTestSettingsPanelOpenRef.current,
      typingRecordEnabled: typingRecordEnabledRef.current,
      typingViewMenuTab: typingViewMenuTabRef.current,
      viewMode: viewModeRef.current,
      // `null` clears the persisted overrides when the ref holds `undefined`
      // (reset), mirroring `typingTestMemory` above — a bare `undefined`
      // would leave a stale map on disk instead of clearing it.
      viewMatrix: viewMatrixRef.current ?? null,
    }).catch(() => {
      // IPC failure — best-effort save
    })
  }, [])

  const setLayout = useCallback((id: KeyboardLayoutId) => {
    updateLayout(id)
    saveCurrentPrefs()
  }, [saveCurrentPrefs, updateLayout])

  const setAutoAdvance = useCallback((enabled: boolean) => {
    updateAutoAdvance(enabled)
    saveCurrentPrefs()
  }, [saveCurrentPrefs, updateAutoAdvance])

  const setLayerPanelOpen = useCallback((open: boolean) => {
    updateLayerPanelOpen(open)
    saveCurrentPrefs()
  }, [saveCurrentPrefs, updateLayerPanelOpen])

  const setBasicViewType = useCallback((type: BasicViewType) => {
    updateBasicViewType(type)
    saveCurrentPrefs()
  }, [saveCurrentPrefs, updateBasicViewType])

  const setSplitKeyMode = useCallback((mode: SplitKeyMode) => {
    updateSplitKeyMode(mode)
    saveCurrentPrefs()
  }, [saveCurrentPrefs, updateSplitKeyMode])

  const setQuickSelect = useCallback((enabled: boolean) => {
    updateQuickSelect(enabled)
    saveCurrentPrefs()
  }, [saveCurrentPrefs, updateQuickSelect])

  const setKeymapScale = useCallback((scale: number) => {
    const clamped = Math.max(MIN_SCALE, Math.min(MAX_SCALE, scale))
    updateKeymapScale(Math.round(clamped * 10) / 10)
    saveCurrentPrefs()
  }, [saveCurrentPrefs, updateKeymapScale])

  const setLayerNames = useCallback((names: string[]) => {
    updateLayerNames(names)
    saveCurrentPrefs()
  }, [saveCurrentPrefs, updateLayerNames])

  const MAX_TYPING_TEST_RESULTS = 500

  const addTypingTestResult = useCallback((result: TypingTestResult) => {
    const updated = trimResults([result, ...typingTestResultsRef.current], MAX_TYPING_TEST_RESULTS)
    updateTypingTestResults(updated)
    saveCurrentPrefs()
  }, [saveCurrentPrefs, updateTypingTestResults])

  /** Label a saved result (keyed by its ISO date) for run comparison. An
   *  empty name clears the label. No-op when nothing changed. */
  const renameTypingTestResult = useCallback((date: string, name: string) => {
    const nextName = name.trim() || undefined
    let changed = false
    const updated = typingTestResultsRef.current.map((r) => {
      if (r.date !== date || (r.name ?? '') === (nextName ?? '')) return r
      changed = true
      return { ...r, name: nextName }
    })
    if (!changed) return
    updateTypingTestResults(updated)
    saveCurrentPrefs()
  }, [saveCurrentPrefs, updateTypingTestResults])

  /** Remove a single saved result (keyed by its ISO date). */
  const deleteTypingTestResult = useCallback((date: string) => {
    const updated = typingTestResultsRef.current.filter((r) => r.date !== date)
    if (updated.length === typingTestResultsRef.current.length) return
    updateTypingTestResults(updated)
    saveCurrentPrefs()
  }, [saveCurrentPrefs, updateTypingTestResults])

  const setTypingTestConfig = useCallback((cfg: TypingTestConfig) => {
    const prev = typingTestConfigRef.current
    updateTypingTestConfig(cfg)
    // Remember the last normal (words/time/quote) config so it survives a
    // switch into a non-normal mode (fileImport / tatoeba) and back. When
    // entering such a mode, capture the outgoing normal config too — covers old
    // prefs where typingTestMonkeytypeConfig was never saved. tatoeba must NOT
    // be cached here, else selecting a MonkeyType language would restore it.
    if (isMonkeytypeMode(cfg.mode)) updateTypingTestMonkeytypeConfig(cfg)
    else if (prev && isMonkeytypeMode(prev.mode)) updateTypingTestMonkeytypeConfig(prev)
    saveCurrentPrefs()
  }, [saveCurrentPrefs, updateTypingTestConfig, updateTypingTestMonkeytypeConfig])

  const setTypingTestLanguage = useCallback((lang: string) => {
    updateTypingTestLanguage(lang)
    saveCurrentPrefs()
  }, [saveCurrentPrefs, updateTypingTestLanguage])

  const setTypingTestViewOnly = useCallback((enabled: boolean) => {
    updateTypingTestViewOnly(enabled)
    saveCurrentPrefs()
  }, [saveCurrentPrefs, updateTypingTestViewOnly])

  const setTypingTestViewOnlyWindowSize = useCallback((size: { width: number; height: number }) => {
    updateTypingTestViewOnlyWindowSize(size)
    saveCurrentPrefs()
  }, [saveCurrentPrefs, updateTypingTestViewOnlyWindowSize])


  const setTypingTestViewOnlyAlwaysOnTop = useCallback((enabled: boolean) => {
    updateTypingTestViewOnlyAlwaysOnTop(enabled)
    saveCurrentPrefs()
  }, [saveCurrentPrefs, updateTypingTestViewOnlyAlwaysOnTop])

  const setTypingTestMemory = useCallback((memory: TypingTestMemory | undefined) => {
    // Skip the full-prefs write when nothing changed — most commonly a
    // clear (undefined) issued while already cleared (finish / restart).
    if (typingTestMemoryRef.current === memory) return
    updateTypingTestMemory(memory)
    saveCurrentPrefs()
  }, [saveCurrentPrefs, updateTypingTestMemory])

  const setTypingTestDisplayLines = useCallback((lines: number) => {
    const clamped = clampDisplayLines(lines)
    if (typingTestDisplayLinesRef.current === clamped) return
    updateTypingTestDisplayLines(clamped)
    saveCurrentPrefs()
  }, [saveCurrentPrefs, updateTypingTestDisplayLines])

  const setTypingTestFontSize = useCallback((px: number) => {
    const clamped = clampFontSize(px)
    if (typingTestFontSizeRef.current === clamped) return
    updateTypingTestFontSize(clamped)
    saveCurrentPrefs()
  }, [saveCurrentPrefs, updateTypingTestFontSize])

  const setTypingTestHideKeymap = useCallback((hidden: boolean) => {
    if (typingTestHideKeymapRef.current === hidden) return
    updateTypingTestHideKeymap(hidden)
    saveCurrentPrefs()
  }, [saveCurrentPrefs, updateTypingTestHideKeymap])

  const setTypingTestHideStatsRow = useCallback((hidden: boolean) => {
    if (typingTestHideStatsRowRef.current === hidden) return
    updateTypingTestHideStatsRow(hidden)
    saveCurrentPrefs()
  }, [saveCurrentPrefs, updateTypingTestHideStatsRow])

  const setTypingTestHideControls = useCallback((hidden: boolean) => {
    if (typingTestHideControlsRef.current === hidden) return
    updateTypingTestHideControls(hidden)
    saveCurrentPrefs()
  }, [saveCurrentPrefs, updateTypingTestHideControls])

  const setTypingTestSaveUnnamed = useCallback((enabled: boolean) => {
    if (typingTestSaveUnnamedRef.current === enabled) return
    updateTypingTestSaveUnnamed(enabled)
    saveCurrentPrefs()
  }, [saveCurrentPrefs, updateTypingTestSaveUnnamed])

  const setTypingTestComparisonBaseline = useCallback((conditionKey: string, baseline: TypingTestComparisonBaseline) => {
    updateTypingTestComparisonBaselines({ ...typingTestComparisonBaselinesRef.current, [conditionKey]: baseline })
    saveCurrentPrefs()
  }, [saveCurrentPrefs, updateTypingTestComparisonBaselines, typingTestComparisonBaselinesRef])

  const setTypingTestSettingsPanelOpen = useCallback((open: boolean) => {
    if (typingTestSettingsPanelOpenRef.current === open) return
    updateTypingTestSettingsPanelOpen(open)
    saveCurrentPrefs()
  }, [saveCurrentPrefs, updateTypingTestSettingsPanelOpen])

  const setTypingRecordEnabled = useCallback((enabled: boolean) => {
    if (typingRecordEnabledRef.current === enabled) return
    updateTypingRecordEnabled(enabled)
    saveCurrentPrefs()
  }, [saveCurrentPrefs, updateTypingRecordEnabled])

  const setTypingViewMenuTab = useCallback((tab: TypingViewMenuTab) => {
    if (typingViewMenuTabRef.current === tab) return
    updateTypingViewMenuTab(tab)
    saveCurrentPrefs()
  }, [saveCurrentPrefs, updateTypingViewMenuTab])

  const setViewMode = useCallback((mode: ViewMode) => {
    if (viewModeRef.current === mode) return
    updateViewMode(mode)
    saveCurrentPrefs()
  }, [saveCurrentPrefs, updateViewMode])

  /** `undefined` resets to physical matrix order — clears every override. */
  const setViewMatrix = useCallback((next: Record<string, ViewMatrixCell> | undefined) => {
    updateViewMatrix(next)
    saveCurrentPrefs()
  }, [saveCurrentPrefs, updateViewMatrix])

  const setKeyEditorZoom = useCallback((zoom: number) => {
    const clamped = clampZoomFactor(zoom)
    if (keyEditorZoomRef.current === clamped) return
    updateKeyEditorZoom(clamped)
    saveCurrentPrefs()
  }, [saveCurrentPrefs, updateKeyEditorZoom])

  const setDefaultLayout = useCallback((id: KeyboardLayoutId) => {
    set('defaultKeyboardLayout', id)
  }, [set])

  const setDefaultAutoAdvance = useCallback((enabled: boolean) => {
    set('defaultAutoAdvance', enabled)
  }, [set])

  const setDefaultLayerPanelOpen = useCallback((open: boolean) => {
    set('defaultLayerPanelOpen', open)
  }, [set])

  const setDefaultBasicViewType = useCallback((type: BasicViewType) => {
    set('defaultBasicViewType', type)
  }, [set])

  const setDefaultSplitKeyMode = useCallback((mode: SplitKeyMode) => {
    set('defaultSplitKeyMode', mode)
  }, [set])

  const setDefaultQuickSelect = useCallback((enabled: boolean) => {
    set('defaultQuickSelect', enabled)
  }, [set])

  const setAutoLockTime = useCallback((m: AutoLockMinutes) => {
    set('autoLockTime', m)
  }, [set])

  const applyDevicePrefs = useCallback(async (uid: string) => {
    uidRef.current = uid
    setAppliedUid(null)
    const seq = ++applySeqRef.current

    let prefs: ValidatedPrefs | null = null
    try {
      const raw = await window.vialAPI.pipetteSettingsGet(uid)
      if (applySeqRef.current !== seq) return
      prefs = validateIpcPrefs(raw, defaultLayout, defaultAutoAdvance, defaultLayerPanelOpen, defaultBasicViewType, defaultSplitKeyMode, defaultQuickSelect)
    } catch {
      // IPC failure — fall through to defaults
    }
    if (applySeqRef.current !== seq) return

    const resolved: ValidatedPrefs = prefs ?? {
      keyboardLayout: defaultLayout,
      autoAdvance: defaultAutoAdvance,
      layerPanelOpen: defaultLayerPanelOpen,
      basicViewType: defaultBasicViewType,
      splitKeyMode: defaultSplitKeyMode,
      quickSelect: defaultQuickSelect,
      keymapScale: 1,
      layerNames: [],
      typingTestResults: [],
      typingTestViewOnly: false,
      typingTestViewOnlyAlwaysOnTop: false,
      typingTestDisplayLines: DEFAULT_DISPLAY_LINES,
      typingTestFontSize: DEFAULT_FONT_SIZE,
      typingTestHideKeymap: false,
      typingTestHideStatsRow: false,
      typingTestHideControls: false,
      typingTestSaveUnnamed: true,
      typingTestComparisonBaselines: {},
      typingTestSettingsPanelOpen: true,
      typingRecordEnabled: false,
      typingViewMenuTab: 'window',
      viewMode: 'editor',
    }
    updateLayout(resolved.keyboardLayout)
    updateAutoAdvance(resolved.autoAdvance)
    updateLayerPanelOpen(resolved.layerPanelOpen)
    updateBasicViewType(resolved.basicViewType)
    updateSplitKeyMode(resolved.splitKeyMode)
    updateQuickSelect(resolved.quickSelect)
    updateKeymapScale(resolved.keymapScale)
    updateLayerNames(resolved.layerNames)
    updateTypingTestResults(resolved.typingTestResults)
    updateTypingTestConfig(resolved.typingTestConfig)
    updateTypingTestMonkeytypeConfig(resolved.typingTestMonkeytypeConfig)
    updateTypingTestLanguage(resolved.typingTestLanguage)
    updateTypingTestViewOnly(resolved.typingTestViewOnly)
    updateTypingTestViewOnlyWindowSize(resolved.typingTestViewOnlyWindowSize)
    updateTypingTestViewOnlyAlwaysOnTop(resolved.typingTestViewOnlyAlwaysOnTop)
    updateTypingTestMemory(resolved.typingTestMemory)
    updateTypingTestDisplayLines(resolved.typingTestDisplayLines)
    updateTypingTestFontSize(resolved.typingTestFontSize)
    updateTypingTestHideKeymap(resolved.typingTestHideKeymap)
    updateTypingTestHideStatsRow(resolved.typingTestHideStatsRow)
    updateTypingTestHideControls(resolved.typingTestHideControls)
    updateTypingTestSaveUnnamed(resolved.typingTestSaveUnnamed)
    updateTypingTestComparisonBaselines(resolved.typingTestComparisonBaselines)
    updateTypingTestSettingsPanelOpen(resolved.typingTestSettingsPanelOpen)
    updateTypingRecordEnabled(resolved.typingRecordEnabled)
    updateTypingViewMenuTab(resolved.typingViewMenuTab)
    updateViewMode(resolved.viewMode)
    updateKeyEditorZoom(resolved.keyEditorZoom)
    updateViewMatrix(resolved.viewMatrix)
    setAppliedUid(uid)

    if (!prefs) {
      saveCurrentPrefs()
    }
  }, [saveCurrentPrefs, defaultLayout, defaultAutoAdvance, defaultLayerPanelOpen, defaultBasicViewType, defaultSplitKeyMode, defaultQuickSelect])

  const lookup = useKeyLabelLookup()

  // Trigger an IPC fetch for non-built-in layouts so the remap callbacks
  // see the map / compositeLabels as soon as the store responds.
  useEffect(() => {
    void lookup.ensure(layout)
  }, [lookup, layout])

  // Single source of truth for "does this pack's map build a rewrite
  // table" — `packIsPurePermutation` (Phase P, picker gate) needs the same
  // `.ok` verdict `buildKeymapRewriteTable` computes for the Key Label
  // "apply to keymap" rewrite.
  //
  // Memoized on the pack map's own object reference (stable per cache
  // entry, see `useKeyLabelLookup.getMap`) rather than on `lookup` itself
  // (a fresh object literal every render), so this only rebuilds when the
  // pack data actually changes. QWERTY/no pack: `map` is `undefined` (not
  // yet loaded) or an empty object (built-in QWERTY, or an uninstalled
  // pack that never resolves) — an empty map trivially passes
  // `buildKeymapRewriteTable` (there is nothing to permute).
  const activeMap = lookup.getMap(layout)
  const rewriteTableResult = useMemo(
    () => (activeMap ? buildKeymapRewriteTable(activeMap) : undefined),
    [activeMap],
  )

  // Picker-only gate (Plan-qwerty-select-no-rewrite v6, Phase P): a pure
  // QWERTY-keycode permutation pack (Colemak, Eucalyn, Dvorak, ...) must
  // leave the key PICKER raw — see `pickerRemapLabel`'s doc comment below.
  // Re-derives the same `.ok` verdict `buildKeymapRewriteTable` already
  // computes for the Key Label "apply to keymap" rewrite, rather than
  // consulting `getKeymapApplicable` (an author-supplied hint the rewrite
  // path deliberately treats as advisory only, not authoritative). An
  // undefined `rewriteTableResult` (no pack loaded) defaults to "pure
  // permutation" too since `remapLabel` is already identity in that state
  // regardless of this flag.
  const packIsPurePermutation = !rewriteTableResult || rewriteTableResult.ok

  // Author-supplied "wants a keymap rewrite" hint (Plan-key-label-keymap-
  // apply) — `false` for built-in QWERTY and for any pack not yet loaded.
  // Combined with `packIsPurePermutation` below (the structural `.ok`
  // verdict) into the single Plan-qwerty-select-no-rewrite v7 predicate:
  // `keymapApplicable && buildKeymapRewriteTable(map).ok`. That predicate —
  // not `.ok` alone — is what `remapKind` now gates on, so it doubles as
  // the simulation-tab / Apply-eligibility signal `KeymapEditor` consumes
  // via `remapKind === 'simulated'` (tab visibility, Apply button, and the
  // simulated tint all read the exact same boolean, never three separately
  // maintained checks).
  const keymapApplicable = !!activeMap && lookup.getKeymapApplicable(layout)

  // Which remap tint `isRemapped`-tinted keys use on the keymap surface
  // (see the `remapKind` field's own doc comment on the return type).
  // "An active pack map is loaded" is checked directly against `activeMap`
  // rather than `rewriteTableResult` — QWERTY's map is `{}` (truthy,
  // trivially a pure permutation) but has nothing to tint, so gating on
  // "non-empty" here avoids relying on `rewriteTableResult`'s undefined-
  // ness to mean "no pack" (it doesn't for QWERTY, which is why
  // `packIsPurePermutation`'s own doc comment calls that state out
  // separately). `keymapApplicable` is the addition over the old
  // `.ok`-only check: a pack that structurally permutes but was never
  // flagged applicable (the author's own opt-out) now renders with the
  // ACTUAL tint in place, same as a JIS-type deviation pack, instead of
  // simulating a Rewrite nothing downstream will actually offer.
  const remapKind: RemapKind = useMemo(() => {
    const hasActivePackMap = !!activeMap && Object.keys(activeMap).length > 0
    return hasActivePackMap && keymapApplicable && packIsPurePermutation ? 'simulated' : 'actual'
  }, [activeMap, keymapApplicable, packIsPurePermutation])

  // Display name for the active pack — used by `KeymapEditor`'s simulation
  // tab label when `remapKind === 'simulated'`. Falls back to the raw id
  // (same fallback `useKeyLabelLookup.getName` documents) so a not-yet-
  // loaded pack never renders an empty tab.
  const activeLayoutName = lookup.getName(layout) ?? layout

  // Display Only is the sole remap-rendering mode (Plan-qwerty-select-
  // no-rewrite v5 最終仕様): both the keymap and the key picker always show
  // the active Key Label pack's own labels, resolved through its
  // compositeLabels -> map lookup order and falling back to qmkId itself
  // when neither has an entry. QWERTY's map/compositeLabels are always
  // empty (`BUILTIN_QWERTY_LAYOUT_ID` in keyboard-layouts.ts), so it
  // resolves to identity without a separate guard. A Rewrite never leaves
  // anything for this to simulate — it resets `layout` back to QWERTY on
  // success (raw characters, no color), the same clean state a
  // snapshot/.vil restore leaves.
  const remapLabel = useCallback(
    (qmkId: string): string => {
      const composite = lookup.getCompositeLabels(layout)?.[qmkId]
      if (composite !== undefined) return composite
      const mapped = lookup.getMap(layout)?.[qmkId]
      if (mapped !== undefined) return mapped
      return qmkId
    },
    [lookup, layout],
  )

  // The blue "remapped" tint: true whenever the resolved label differs from
  // the qmkId itself — the same `remapLabel(x) !== x` rule every picker/
  // palette consumer (KeycodeGrid.getRemapDisplayLabel) already uses.
  const isRemapped = useCallback(
    (qmkId: string): boolean => remapLabel(qmkId) !== qmkId,
    [remapLabel],
  )

  // Delegates to `remapLabel` itself for the deviation-pack branch (rather
  // than re-resolving compositeLabels/map independently) so the picker and
  // keymap legend can never disagree on what a deviation pack's label is —
  // only WHETHER it's shown differs between the two surfaces.
  const pickerRemapLabel = useCallback(
    (qmkId: string): string => (packIsPurePermutation ? qmkId : remapLabel(qmkId)),
    [packIsPurePermutation, remapLabel],
  )

  return {
    layout,
    autoAdvance,
    layerPanelOpen,
    basicViewType,
    splitKeyMode,
    quickSelect,
    keymapScale,
    layerNames,
    typingTestResults,
    typingTestConfig,
    typingTestMonkeytypeConfig,
    typingTestLanguage,
    typingTestViewOnly,
    typingTestViewOnlyWindowSize,
    typingTestViewOnlyAlwaysOnTop,
    typingTestMemory,
    typingTestDisplayLines,
    typingTestFontSize,
    typingTestHideKeymap,
    typingTestHideStatsRow,
    typingTestHideControls,
    typingTestSaveUnnamed,
    typingTestComparisonBaselines,
    typingTestSettingsPanelOpen,
    typingRecordEnabled,
    typingViewMenuTab,
    viewMode,
    keyEditorZoom,
    viewMatrix,
    appliedUid,
    setLayout,
    setAutoAdvance,
    setLayerPanelOpen,
    setBasicViewType,
    setSplitKeyMode,
    setQuickSelect,
    setKeymapScale,
    setLayerNames,
    addTypingTestResult,
    renameTypingTestResult,
    deleteTypingTestResult,
    setTypingTestConfig,
    setTypingTestLanguage,
    setTypingTestViewOnly,
    setTypingTestViewOnlyWindowSize,
    setTypingTestViewOnlyAlwaysOnTop,
    setTypingTestMemory,
    setTypingTestDisplayLines,
    setTypingTestFontSize,
    setTypingTestHideKeymap,
    setTypingTestHideStatsRow,
    setTypingTestHideControls,
    setTypingTestSaveUnnamed,
    setTypingTestComparisonBaseline,
    setTypingTestSettingsPanelOpen,
    setTypingRecordEnabled,
    setTypingViewMenuTab,
    setViewMode,
    setViewMatrix,
    setKeyEditorZoom,
    defaultLayout,
    defaultAutoAdvance,
    defaultLayerPanelOpen,
    defaultBasicViewType,
    defaultSplitKeyMode,
    defaultQuickSelect,
    setDefaultLayout,
    setDefaultAutoAdvance,
    setDefaultLayerPanelOpen,
    setDefaultBasicViewType,
    setDefaultSplitKeyMode,
    setDefaultQuickSelect,
    autoLockTime: config.autoLockTime,
    setAutoLockTime,
    applyDevicePrefs,
    remapLabel,
    isRemapped,
    remapKind,
    activeLayoutName,
    pickerRemapLabel,
  }
}
