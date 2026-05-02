// SPDX-License-Identifier: GPL-2.0-or-later

import { useState, useCallback, useEffect, useRef } from 'react'
import type { KeyboardLayoutId } from '../data/keyboard-layouts'
import { useKeyLabelLookup } from './useKeyLabelLookup'
import { useAppConfig } from './useAppConfig'
import { MIN_SCALE, MAX_SCALE } from '../components/editors/keymap-editor-types'
import type { TypingTestResult, TypingViewMenuTab, ViewMode } from '../../shared/types/pipette-settings'
import { VIEW_MODES, isTypingViewMenuTab } from '../../shared/types/pipette-settings'
import { trimResults } from '../typing-test/result-builder'
import type { TypingTestConfig } from '../typing-test/types'
import type { AutoLockMinutes, BasicViewType, SplitKeyMode } from '../../shared/types/app-config'

export type { KeyboardLayoutId, AutoLockMinutes, BasicViewType, SplitKeyMode }

const VALID_QUOTE_LENGTHS: ReadonlySet<string> = new Set(['short', 'medium', 'long', 'all'])

function isFinitePositiveInt(n: unknown): n is number {
  return typeof n === 'number' && Number.isFinite(n) && n > 0 && Number.isInteger(n)
}

function hasBooleanFields(obj: Record<string, unknown>, ...keys: string[]): boolean {
  return keys.every((k) => typeof obj[k] === 'boolean')
}

function validateTypingTestConfig(raw: unknown): TypingTestConfig | undefined {
  if (raw == null || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const obj = raw as Record<string, unknown>
  switch (obj.mode) {
    case 'words':
      if (!isFinitePositiveInt(obj.wordCount) || !hasBooleanFields(obj, 'punctuation', 'numbers')) return undefined
      return { mode: 'words', wordCount: obj.wordCount, punctuation: obj.punctuation as boolean, numbers: obj.numbers as boolean }
    case 'time':
      if (!isFinitePositiveInt(obj.duration) || !hasBooleanFields(obj, 'punctuation', 'numbers')) return undefined
      return { mode: 'time', duration: obj.duration, punctuation: obj.punctuation as boolean, numbers: obj.numbers as boolean }
    case 'quote':
      if (typeof obj.quoteLength !== 'string' || !VALID_QUOTE_LENGTHS.has(obj.quoteLength)) return undefined
      return { mode: 'quote', quoteLength: obj.quoteLength as 'short' | 'medium' | 'long' | 'all' }
    default:
      return undefined
  }
}

function validateTypingTestLanguage(raw: unknown): string | undefined {
  if (typeof raw !== 'string' || raw.length === 0) return undefined
  return raw
}

function isValidTypingTestResult(item: unknown): item is TypingTestResult {
  if (typeof item !== 'object' || item === null) return false
  const r = item as Record<string, unknown>
  return typeof r.date === 'string' && typeof r.wpm === 'number' && typeof r.accuracy === 'number'
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
  typingTestLanguage?: string
  typingTestViewOnly: boolean
  typingTestViewOnlyWindowSize?: { width: number; height: number }
  typingTestViewOnlyAlwaysOnTop: boolean
  typingRecordEnabled: boolean
  typingViewMenuTab: TypingViewMenuTab
  viewMode: ViewMode
}

function validateIpcPrefs(
  data: { keyboardLayout: string; autoAdvance: boolean; layerPanelOpen?: boolean; basicViewType?: string; splitKeyMode?: string; quickSelect?: boolean; keymapScale?: number; layerNames?: string[]; typingTestResults?: TypingTestResult[]; typingTestConfig?: unknown; typingTestLanguage?: unknown; typingTestViewOnly?: boolean; typingTestViewOnlyWindowSize?: unknown; typingTestViewOnlyAlwaysOnTop?: boolean; typingRecordEnabled?: boolean; typingViewMenuTab?: unknown; viewMode?: unknown } | null,
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
    ? data.typingTestResults.filter(isValidTypingTestResult)
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
    typingTestLanguage: validateTypingTestLanguage(data.typingTestLanguage),
    typingTestViewOnly,
    typingTestViewOnlyWindowSize: validateWindowSize(data.typingTestViewOnlyWindowSize),
    typingTestViewOnlyAlwaysOnTop: typeof data.typingTestViewOnlyAlwaysOnTop === 'boolean' ? data.typingTestViewOnlyAlwaysOnTop : false,
    typingRecordEnabled: typeof data.typingRecordEnabled === 'boolean' ? data.typingRecordEnabled : false,
    typingViewMenuTab: isTypingViewMenuTab(data.typingViewMenuTab) ? data.typingViewMenuTab : 'window',
    viewMode,
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
  typingTestLanguage: string | undefined
  typingTestViewOnly: boolean
  typingTestViewOnlyWindowSize: { width: number; height: number } | undefined
  typingTestViewOnlyAlwaysOnTop: boolean
  typingRecordEnabled: boolean
  typingViewMenuTab: TypingViewMenuTab
  viewMode: ViewMode
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
  setTypingTestConfig: (config: TypingTestConfig) => void
  setTypingTestLanguage: (lang: string) => void
  setTypingTestViewOnly: (enabled: boolean) => void
  setTypingTestViewOnlyWindowSize: (size: { width: number; height: number }) => void
  setTypingTestViewOnlyAlwaysOnTop: (enabled: boolean) => void
  setTypingRecordEnabled: (enabled: boolean) => void
  setTypingViewMenuTab: (tab: TypingViewMenuTab) => void
  setViewMode: (mode: ViewMode) => void
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
  remapLabel: (qmkId: string) => string
  isRemapped: (qmkId: string) => boolean
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
  const [typingTestLanguage, updateTypingTestLanguage, typingTestLanguageRef] = useStateRef<string | undefined>(undefined)
  const [typingTestViewOnly, updateTypingTestViewOnly, typingTestViewOnlyRef] = useStateRef<boolean>(false)
  const [typingTestViewOnlyWindowSize, updateTypingTestViewOnlyWindowSize, typingTestViewOnlyWindowSizeRef] = useStateRef<{ width: number; height: number } | undefined>(undefined)
  const [typingTestViewOnlyAlwaysOnTop, updateTypingTestViewOnlyAlwaysOnTop, typingTestViewOnlyAlwaysOnTopRef] = useStateRef<boolean>(false)
  const [typingRecordEnabled, updateTypingRecordEnabled, typingRecordEnabledRef] = useStateRef<boolean>(false)
  const [typingViewMenuTab, updateTypingViewMenuTab, typingViewMenuTabRef] = useStateRef<TypingViewMenuTab>('window')
  const [viewMode, updateViewMode, viewModeRef] = useStateRef<ViewMode>('editor')
  const [appliedUid, setAppliedUid] = useState<string | null>(null)

  const uidRef = useRef('')
  const applySeqRef = useRef(0)

  const saveCurrentPrefs = useCallback(() => {
    const uid = uidRef.current
    if (!uid) return
    window.vialAPI.pipetteSettingsSet(uid, {
      _rev: 1,
      keyboardLayout: layoutRef.current,
      autoAdvance: autoAdvanceRef.current,
      layerPanelOpen: layerPanelOpenRef.current,
      basicViewType: basicViewTypeRef.current,
      splitKeyMode: splitKeyModeRef.current,
      quickSelect: quickSelectRef.current,
      keymapScale: keymapScaleRef.current,
      layerNames: layerNamesRef.current,
      typingTestResults: typingTestResultsRef.current,
      typingTestConfig: typingTestConfigRef.current as Record<string, unknown> | undefined,
      typingTestLanguage: typingTestLanguageRef.current,
      typingTestViewOnly: typingTestViewOnlyRef.current,
      typingTestViewOnlyWindowSize: typingTestViewOnlyWindowSizeRef.current,
      typingTestViewOnlyAlwaysOnTop: typingTestViewOnlyAlwaysOnTopRef.current || undefined,
      typingRecordEnabled: typingRecordEnabledRef.current || undefined,
      typingViewMenuTab: typingViewMenuTabRef.current,
      viewMode: viewModeRef.current,
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

  const setTypingTestConfig = useCallback((cfg: TypingTestConfig) => {
    updateTypingTestConfig(cfg)
    saveCurrentPrefs()
  }, [saveCurrentPrefs, updateTypingTestConfig])

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
    updateTypingTestLanguage(resolved.typingTestLanguage)
    updateTypingTestViewOnly(resolved.typingTestViewOnly)
    updateTypingTestViewOnlyWindowSize(resolved.typingTestViewOnlyWindowSize)
    updateTypingTestViewOnlyAlwaysOnTop(resolved.typingTestViewOnlyAlwaysOnTop)
    updateTypingRecordEnabled(resolved.typingRecordEnabled)
    updateTypingViewMenuTab(resolved.typingViewMenuTab)
    updateViewMode(resolved.viewMode)
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

  const isRemapped = useCallback(
    (qmkId: string): boolean => {
      const composite = lookup.getCompositeLabels(layout)
      if (composite && qmkId in composite) return true
      const map = lookup.getMap(layout)
      return Boolean(map && qmkId in map)
    },
    [lookup, layout],
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
    typingTestLanguage,
    typingTestViewOnly,
    typingTestViewOnlyWindowSize,
    typingTestViewOnlyAlwaysOnTop,
    typingRecordEnabled,
    typingViewMenuTab,
    viewMode,
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
    setTypingTestConfig,
    setTypingTestLanguage,
    setTypingTestViewOnly,
    setTypingTestViewOnlyWindowSize,
    setTypingTestViewOnlyAlwaysOnTop,
    setTypingRecordEnabled,
    setTypingViewMenuTab,
    setViewMode,
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
  }
}
