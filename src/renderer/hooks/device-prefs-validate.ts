// SPDX-License-Identifier: GPL-2.0-or-later

import type { KeyboardLayoutId } from '../data/keyboard-layouts'
import { MIN_SCALE, MAX_SCALE } from '../components/editors/keymap-editor-types'
import type { TypingTestResult, TypingViewMenuTab, ViewMode, TypingTestMemory, TypingTestMemoryWord, TypingTestComparisonBaselines, ViewMatrixCell } from '../../shared/types/pipette-settings'
import { VIEW_MODES, isTypingViewMenuTab, isTypingTestComparisonBaselines } from '../../shared/types/pipette-settings'
import { isNonNegInt, isValidTypingTestResult, sanitizeTypingTestResult } from '../typing-test/typing-test-result-sanitize'
import type { TypingTestConfig, RomajiDetailSettings, RomajiCaseStyle } from '../typing-test/types'
import { DEFAULT_DISPLAY_LINES, DEFAULT_FONT_SIZE, clampDisplayLines, clampFontSize } from '../typing-test/types'
import type { RomajiStyle } from '../typing-test/romaji-engine'
import type { BasicViewType, SplitKeyMode } from '../../shared/types/app-config'
import { clampZoomFactor } from '../../shared/types/app-config'

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
  // guideLineCount takes precedence when present and valid; otherwise fall
  // back to a legacy guideWordCount (pre-rename field, same 0-3 int range
  // and "0 = hidden" meaning) so a persisted config written before the
  // rename doesn't silently lose its explicit guide setting. A malformed
  // value in either field is simply dropped (falls through to "not set" /
  // the modal's default of 1), same as every other field here.
  if (
    typeof obj.guideLineCount === 'number'
    && Number.isInteger(obj.guideLineCount)
    && obj.guideLineCount >= 0
    && obj.guideLineCount <= 3
  ) {
    result.guideLineCount = obj.guideLineCount
  } else if (
    typeof obj.guideWordCount === 'number'
    && Number.isInteger(obj.guideWordCount)
    && obj.guideWordCount >= 0
    && obj.guideWordCount <= 3
  ) {
    result.guideLineCount = obj.guideWordCount
  }
  if (typeof obj.lineEndEnter === 'boolean') {
    result.lineEndEnter = obj.lineEndEnter
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
export function isMonkeytypeMode(mode: TypingTestConfig['mode']): boolean {
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
  // All-or-nothing, mirroring how captureMemory always writes all three
  // together (see TypingTestMemory's doc comment): a malformed/partial
  // group degrades to "absent" rather than trusting a subset, so
  // restoreState's legacy-format fallback (permanently uncomputable) kicks
  // in exactly the same as for a memory saved before KSPC existed.
  const validKspcGroup =
    isNonNegInt(o.totalKeystrokes) && isNonNegInt(o.confirmedChars) && typeof o.kspcUncomputable === 'boolean'
  return {
    textId: o.textId,
    currentWordIndex: o.currentWordIndex,
    currentInput: o.currentInput,
    wordResults,
    correctChars: o.correctChars,
    incorrectChars: o.incorrectChars,
    elapsedMs: o.elapsedMs,
    wpmHistory,
    totalKeystrokes: validKspcGroup ? (o.totalKeystrokes as number) : undefined,
    confirmedChars: validKspcGroup ? (o.confirmedChars as number) : undefined,
    kspcUncomputable: validKspcGroup ? (o.kspcUncomputable as boolean) : undefined,
    savedAt: typeof o.savedAt === 'string' ? o.savedAt : new Date(0).toISOString(),
  }
}

const VALID_BASIC_VIEW_TYPES: ReadonlySet<string> = new Set(['ansi', 'iso', 'jis', 'list'])
const LEGACY_BASIC_VIEW_MAP: Record<string, string> = { keyboard: 'ansi' }
const VALID_SPLIT_KEY_MODES: ReadonlySet<string> = new Set(['split', 'flat'])
const VALID_VIEW_MODES: ReadonlySet<string> = new Set(VIEW_MODES)

export interface ValidatedPrefs {
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

export function validateIpcPrefs(
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
