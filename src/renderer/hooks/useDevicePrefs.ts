// SPDX-License-Identifier: GPL-2.0-or-later

import { useState, useCallback, useRef } from 'react'
import { LAYOUT_ID_SET } from '../data/keyboard-layouts'
import type { KeyboardLayoutId } from '../data/keyboard-layouts'
import { remapKeycode, isRemappedKeycode } from './useKeyboardLayout'
import { useAppConfig } from './useAppConfig'
import type { TypingTestResult } from '../../shared/types/pipette-settings'
import { trimResults } from '../typing-test/result-builder'
import type { TypingTestConfig } from '../typing-test/types'
import type { AutoLockMinutes, BasicViewType } from '../../shared/types/app-config'

export type { KeyboardLayoutId, AutoLockMinutes, BasicViewType }

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

const VALID_BASIC_VIEW_TYPES: ReadonlySet<string> = new Set(['ansi', 'iso', 'list'])

interface ValidatedPrefs {
  keyboardLayout: KeyboardLayoutId
  autoAdvance: boolean
  layerPanelOpen: boolean
  basicViewType: BasicViewType
  layerNames: string[]
  typingTestResults: TypingTestResult[]
  typingTestConfig?: TypingTestConfig
  typingTestLanguage?: string
}

function validateIpcPrefs(
  data: { keyboardLayout: string; autoAdvance: boolean; layerPanelOpen?: boolean; basicViewType?: string; layerNames?: string[]; typingTestResults?: TypingTestResult[]; typingTestConfig?: unknown; typingTestLanguage?: unknown } | null,
  defaultLayout: KeyboardLayoutId,
  defaultAutoAdvance: boolean,
  defaultLayerPanelOpen: boolean,
  defaultBasicViewType: BasicViewType,
): ValidatedPrefs | null {
  if (!data) return null

  const layout = typeof data.keyboardLayout === 'string' && LAYOUT_ID_SET.has(data.keyboardLayout)
    ? data.keyboardLayout
    : null
  const autoAdvance = typeof data.autoAdvance === 'boolean' ? data.autoAdvance : null
  if (layout === null && autoAdvance === null) return null

  const layerPanelOpen = typeof data.layerPanelOpen === 'boolean' ? data.layerPanelOpen : defaultLayerPanelOpen
  const basicViewType = typeof data.basicViewType === 'string' && VALID_BASIC_VIEW_TYPES.has(data.basicViewType)
    ? data.basicViewType as BasicViewType
    : defaultBasicViewType

  const layerNames = Array.isArray(data.layerNames)
    ? data.layerNames.filter((n): n is string => typeof n === 'string')
    : []
  const typingTestResults = Array.isArray(data.typingTestResults)
    ? data.typingTestResults.filter(isValidTypingTestResult)
    : []

  return {
    keyboardLayout: layout ?? defaultLayout,
    autoAdvance: autoAdvance ?? defaultAutoAdvance,
    layerPanelOpen,
    basicViewType,
    layerNames,
    typingTestResults,
    typingTestConfig: validateTypingTestConfig(data.typingTestConfig),
    typingTestLanguage: validateTypingTestLanguage(data.typingTestLanguage),
  }
}

export interface UseDevicePrefsReturn {
  layout: KeyboardLayoutId
  autoAdvance: boolean
  layerPanelOpen: boolean
  basicViewType: BasicViewType
  layerNames: string[]
  typingTestResults: TypingTestResult[]
  typingTestConfig: TypingTestConfig | undefined
  typingTestLanguage: string | undefined
  setLayout: (id: KeyboardLayoutId) => void
  setAutoAdvance: (enabled: boolean) => void
  setLayerPanelOpen: (open: boolean) => void
  setBasicViewType: (type: BasicViewType) => void
  setLayerNames: (names: string[]) => void
  addTypingTestResult: (result: TypingTestResult) => void
  setTypingTestConfig: (config: TypingTestConfig) => void
  setTypingTestLanguage: (lang: string) => void
  defaultLayout: KeyboardLayoutId
  defaultAutoAdvance: boolean
  defaultLayerPanelOpen: boolean
  defaultBasicViewType: BasicViewType
  setDefaultLayout: (id: KeyboardLayoutId) => void
  setDefaultAutoAdvance: (enabled: boolean) => void
  setDefaultLayerPanelOpen: (open: boolean) => void
  setDefaultBasicViewType: (type: BasicViewType) => void
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

  const defaultLayout = LAYOUT_ID_SET.has(config.defaultKeyboardLayout)
    ? config.defaultKeyboardLayout
    : 'qwerty'
  const defaultAutoAdvance = config.defaultAutoAdvance
  const defaultLayerPanelOpen = config.defaultLayerPanelOpen
  const defaultBasicViewType = config.defaultBasicViewType

  const [layout, updateLayout, layoutRef] = useStateRef<KeyboardLayoutId>(defaultLayout)
  const [autoAdvance, updateAutoAdvance, autoAdvanceRef] = useStateRef<boolean>(defaultAutoAdvance)
  const [layerPanelOpen, updateLayerPanelOpen, layerPanelOpenRef] = useStateRef<boolean>(defaultLayerPanelOpen)
  const [basicViewType, updateBasicViewType, basicViewTypeRef] = useStateRef<BasicViewType>(defaultBasicViewType)
  const [layerNames, updateLayerNames, layerNamesRef] = useStateRef<string[]>([])
  const [typingTestResults, updateTypingTestResults, typingTestResultsRef] = useStateRef<TypingTestResult[]>([])
  const [typingTestConfig, updateTypingTestConfig, typingTestConfigRef] = useStateRef<TypingTestConfig | undefined>(undefined)
  const [typingTestLanguage, updateTypingTestLanguage, typingTestLanguageRef] = useStateRef<string | undefined>(undefined)

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
      layerNames: layerNamesRef.current,
      typingTestResults: typingTestResultsRef.current,
      typingTestConfig: typingTestConfigRef.current as Record<string, unknown> | undefined,
      typingTestLanguage: typingTestLanguageRef.current,
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

  const setAutoLockTime = useCallback((m: AutoLockMinutes) => {
    set('autoLockTime', m)
  }, [set])

  const applyDevicePrefs = useCallback(async (uid: string) => {
    uidRef.current = uid
    const seq = ++applySeqRef.current

    let prefs: ValidatedPrefs | null = null
    try {
      const raw = await window.vialAPI.pipetteSettingsGet(uid)
      if (applySeqRef.current !== seq) return
      prefs = validateIpcPrefs(raw, defaultLayout, defaultAutoAdvance, defaultLayerPanelOpen, defaultBasicViewType)
    } catch {
      // IPC failure — fall through to defaults
    }
    if (applySeqRef.current !== seq) return

    const resolved: ValidatedPrefs = prefs ?? {
      keyboardLayout: defaultLayout,
      autoAdvance: defaultAutoAdvance,
      layerPanelOpen: defaultLayerPanelOpen,
      basicViewType: defaultBasicViewType,
      layerNames: [],
      typingTestResults: [],
    }

    updateLayout(resolved.keyboardLayout)
    updateAutoAdvance(resolved.autoAdvance)
    updateLayerPanelOpen(resolved.layerPanelOpen)
    updateBasicViewType(resolved.basicViewType)
    updateLayerNames(resolved.layerNames)
    updateTypingTestResults(resolved.typingTestResults)
    updateTypingTestConfig(resolved.typingTestConfig)
    updateTypingTestLanguage(resolved.typingTestLanguage)

    if (!prefs) {
      saveCurrentPrefs()
    }
  }, [saveCurrentPrefs, defaultLayout, defaultAutoAdvance, defaultLayerPanelOpen, defaultBasicViewType])

  const remapLabel = useCallback(
    (qmkId: string): string => remapKeycode(qmkId, layout),
    [layout],
  )

  const isRemapped = useCallback(
    (qmkId: string): boolean => isRemappedKeycode(qmkId, layout),
    [layout],
  )

  return {
    layout,
    autoAdvance,
    layerPanelOpen,
    basicViewType,
    layerNames,
    typingTestResults,
    typingTestConfig,
    typingTestLanguage,
    setLayout,
    setAutoAdvance,
    setLayerPanelOpen,
    setBasicViewType,
    setLayerNames,
    addTypingTestResult,
    setTypingTestConfig,
    setTypingTestLanguage,
    defaultLayout,
    defaultAutoAdvance,
    defaultLayerPanelOpen,
    defaultBasicViewType,
    setDefaultLayout,
    setDefaultAutoAdvance,
    setDefaultLayerPanelOpen,
    setDefaultBasicViewType,
    autoLockTime: config.autoLockTime,
    setAutoLockTime,
    applyDevicePrefs,
    remapLabel,
    isRemapped,
  }
}
