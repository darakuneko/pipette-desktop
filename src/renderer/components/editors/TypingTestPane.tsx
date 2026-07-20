// SPDX-License-Identifier: GPL-2.0-or-later

import { useState, useCallback, useEffect, useMemo, useRef, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { ChevronsLeft, ChevronsRight } from 'lucide-react'
import { ICON_SM } from '../../constants/ui-tokens'
import { TypingTestView } from '../../typing-test/TypingTestView'
import { TypingTestSettingsBar } from '../../typing-test/TypingTestSettingsBar'
import { buildResultNameChips } from '../../typing-test/result-builder'
import { PauseResumeModal } from '../../typing-test/PauseResumeModal'
import { LanguageSelectorModal } from '../../typing-test/LanguageSelectorModal'
import { TypingRecordingConsentModal } from '../../typing-test/TypingRecordingConsentModal'
import { isRomajiCapable, carryRomajiFields } from '../../typing-test/romaji-input'
import { useTypingHeatmap } from '../../typing-test/useTypingHeatmap'
import { TYPING_HEATMAP_WINDOW_OPTIONS } from '../../../shared/types/app-config'
import { KeyboardPane } from './KeyboardPane'
import type { RemapKind } from '../keyboard/constants'
import { HistoryToggle } from './HistoryToggle'
import { ComparisonToggle } from './ComparisonToggle'
import { computeComparison, matchingResults, conditionKey } from '../../typing-test/comparison'
import { KEY_UNIT, KEYBOARD_PADDING } from '../keyboard/constants'
import { repositionLayoutKeys, filterVisibleKeys } from '../../../shared/kle/filter-keys'
import type { KleKey } from '../../../shared/kle/types'
import type { TypingTestResult, PooledTypingTestResult, TypingViewMenuTab, TypingTestComparisonBaseline, TypingTestComparisonBaselines } from '../../../shared/types/pipette-settings'
import { DEFAULT_COMPARISON_BASELINE } from '../../../shared/types/pipette-settings'
import type { TypingTestConfig } from '../../typing-test/types'
import { DEFAULT_CONFIG, DEFAULT_LANGUAGE, DEFAULT_DISPLAY_LINES, DEFAULT_FONT_SIZE, DISPLAY_LINES_MIN, DISPLAY_LINES_MAX, FONT_OPTIONS } from '../../typing-test/types'

const LINE_OPTIONS = Array.from({ length: DISPLAY_LINES_MAX - DISPLAY_LINES_MIN + 1 }, (_, i) => DISPLAY_LINES_MIN + i)

/** Labelled group inside the left config panel — a small heading with an
 *  underline divider, then its controls (kept at natural width). */
function PanelSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex w-full flex-col items-start gap-2">
      <h3 className="w-full border-b border-edge pb-1 text-xs font-semibold uppercase tracking-wide text-content-muted">
        {title}
      </h3>
      {children}
    </section>
  )
}

import type { useTypingTest } from '../../typing-test/useTypingTest'
import { BTN_TOGGLE_ACTIVE, BTN_TOGGLE_INACTIVE } from '../../constants/ui-tokens'
import { ToggleRow } from './modal-controls'
import type { AnalyticsOrigin } from './keymap-editor-types'
import { PANEL_COLLAPSED_WIDTH } from './keymap-editor-types'

export interface TypingTestPaneProps {
  typingTest: ReturnType<typeof useTypingTest>
  onConfigChange: (config: TypingTestConfig) => void
  /** Last normal (words/time/quote) config, restored when leaving fileImport. */
  monkeytypeConfig?: TypingTestConfig
  onLanguageChange: (lang: string) => Promise<void>
  layers: number
  layerNames?: string[]
  typingTestHistory?: TypingTestResult[]
  deviceName?: string
  pressedKeys: Set<string>
  keycodes: Map<string, string>
  encoderKeycodes: Map<string, [string, string]>
  remappedKeys: Set<string>
  /** Encoder analogue of `remappedKeys` — see `KeyboardWidget`'s
   *  `remappedEncoders`. */
  remappedEncoders?: Set<string>
  /** Which remap tint `remappedKeys`/`remappedEncoders` use — see
   *  `KeyboardWidget`'s `remapKind`. Defaults to `'actual'`. */
  remapKind?: RemapKind
  /** Active Key Label pack's per-key legend override — see
   *  `KeyboardWidget`'s `remapLabel`. */
  remapLabel?: (qmkId: string) => string
  layoutOptions: Map<number, number>
  scale: number
  keys: KleKey[]
  layerLabel: string
  contentRef?: React.RefObject<HTMLDivElement | null>
  /** Memory mode (imported fileImport text): a paused snapshot is saved. */
  hasSavedMemory?: boolean
  onPauseTest?: () => void
  onResumeTest?: () => void
  onRestartTestFromStart?: () => void
  /** Imported-text display preferences (fileImport mode). */
  displayLines?: number
  fontSize?: number
  onDisplayLinesChange?: (lines: number) => void
  onFontSizeChange?: (px: number) => void
  /** Editor view toggles — hide the keymap pane / the stats (WPM) row.
   *  Persisted per keyboard; only meaningful outside view-only mode. */
  hideKeymap?: boolean
  hideStatsRow?: boolean
  hideControls?: boolean
  onToggleHideKeymap?: (hidden: boolean) => void
  onToggleHideStatsRow?: (hidden: boolean) => void
  onToggleHideControls?: (hidden: boolean) => void
  /** Auto-save finished results without a name (default true). Drives only the
   *  toggle button — the save/name behavior lives in `useInputModes`. */
  saveUnnamed?: boolean
  onToggleSaveUnnamed?: (enabled: boolean) => void
  /** The just-finished result (held unsaved or saved latest), for name chips. */
  finishedResult?: TypingTestResult | null
  /** Name the just-finished result (save under name when held, else rename). */
  onNameFinishedResult?: (name: string) => void
  /** Per-condition Measurement-row comparison baselines (persisted per
   *  keyboard, synced). Keyed by condition; the current condition's baseline
   *  is looked up and applied. */
  comparisonBaselines?: TypingTestComparisonBaselines
  onComparisonBaselineChange?: (conditionKey: string, baseline: TypingTestComparisonBaseline) => void
  /** Left Settings panel expanded state (persisted per keyboard). */
  settingsPanelOpen?: boolean
  onToggleSettingsPanel?: (open: boolean) => void
  /** Label a saved result (by ISO date) from the History modal. */
  onRenameTypingTestResult?: (date: string, name: string) => void
  /** Delete a saved result (by ISO date) from the History modal. */
  onDeleteTypingTestResult?: (date: string) => void
  viewOnly?: boolean
  onViewOnlyChange?: (enabled: boolean) => void
  viewOnlyWindowSize?: { width: number; height: number }
  onViewOnlyWindowSizeChange?: (size: { width: number; height: number }) => void
  viewOnlyAlwaysOnTop?: boolean
  onViewOnlyAlwaysOnTopChange?: (enabled: boolean) => void
  recordEnabled?: boolean
  onRecordEnabledChange?: (enabled: boolean) => void
  /** Whether the user has accepted the typing-recording disclosure.
   * The REC tab Start button gates on this — first-time enable opens
   * the consent modal, subsequent enables skip it. */
  recordingConsentAccepted?: boolean
  onRecordingConsentAccepted?: () => void
  /** Window length in minutes for the typing-view heatmap overlay.
   * Exposed as a REC-tab dropdown so the user can dial how far back
   * the overlay reaches; data older than the window is dropped, data
   * within decays smoothly. Backed by
   * AppConfig.typingHeatmapWindowMin. */
  heatmapWindowMin?: number
  onHeatmapWindowMinChange?: (minutes: number) => void
  /** AppConfig flag — when on (and REC running), the analytics
   * service tags every minute payload with the active application
   * name. Toggle is intentionally inert until REC starts so the user
   * controls one switch at a time. */
  monitorAppEnabled?: boolean
  onMonitorAppEnabledChange?: (enabled: boolean) => void
  /** AppConfig flag — keeps Pipette running in the tray after the last
   * window closes. Mirrors Settings > Tools; surfaced here too since the
   * view-only window is often the last one open. */
  trayResident?: boolean
  onTrayResidentChange?: (enabled: boolean) => void
  /** AppConfig flag — launch resident in the tray without opening a
   * window. Disabled while trayResident is off; turning trayResident off
   * also clears this when set, since a hidden window with no tray icon
   * to reopen it would be unreachable. Same linked-clear logic as
   * SettingsToolsTab — keep both in sync. */
  startInTray?: boolean
  onStartInTrayChange?: (enabled: boolean) => void
  /** Which tab of the view-only menu is currently open. Window shows
   * size / always-on-top controls; REC shows the recording toggle and
   * the entry point to the analytics page; Monitor App shows the
   * active-application capture toggle. Persisted per keyboard via
   * PipetteSettings. */
  menuTab?: TypingViewMenuTab
  onMenuTabChange?: (tab: TypingViewMenuTab) => void
  /** Called when the user picks "View Analytics" from the REC tab.
   * The parent owns the navigation — the pane only surfaces the
   * entry point. */
  onViewAnalytics?: (origin: AnalyticsOrigin) => void
  /** Keyboard uid used for the typing-view heatmap query. The heatmap
   * stays hidden while this is unset or recording is off so a session
   * without a device never sees stale overlay data. */
  keyboardUid?: string
}

export function TypingTestPane({
  typingTest,
  onConfigChange,
  monkeytypeConfig,
  onLanguageChange,
  layers,
  layerNames,
  typingTestHistory,
  deviceName,
  pressedKeys,
  keycodes,
  encoderKeycodes,
  remappedKeys,
  remappedEncoders,
  remapKind,
  remapLabel,
  layoutOptions,
  scale,
  keys,
  layerLabel,
  contentRef,
  hasSavedMemory,
  onPauseTest,
  onResumeTest,
  onRestartTestFromStart,
  displayLines,
  fontSize,
  onDisplayLinesChange,
  onFontSizeChange,
  hideKeymap,
  hideStatsRow,
  hideControls,
  onToggleHideKeymap,
  onToggleHideStatsRow,
  onToggleHideControls,
  saveUnnamed = true,
  onToggleSaveUnnamed,
  finishedResult,
  onNameFinishedResult,
  comparisonBaselines,
  onComparisonBaselineChange,
  settingsPanelOpen = true,
  onToggleSettingsPanel,
  onRenameTypingTestResult,
  onDeleteTypingTestResult,
  viewOnly,
  onViewOnlyChange,
  viewOnlyWindowSize,
  onViewOnlyWindowSizeChange,
  viewOnlyAlwaysOnTop,
  onViewOnlyAlwaysOnTopChange,
  recordEnabled,
  onRecordEnabledChange,
  recordingConsentAccepted,
  onRecordingConsentAccepted,
  heatmapWindowMin,
  onHeatmapWindowMinChange,
  monitorAppEnabled,
  onMonitorAppEnabledChange,
  trayResident,
  onTrayResidentChange,
  startInTray,
  onStartInTrayChange,
  menuTab = 'window',
  onMenuTabChange,
  onViewAnalytics,
  keyboardUid,
}: TypingTestPaneProps) {
  const { t } = useTranslation()

  // Heatmap overlay for view-only + record mode. Gated on both flags
  // so the overlay never shows up in editor mode and never lingers
  // after the user toggles record off.
  const {
    cells: heatmapCells,
    maxTotal: heatmapMaxTotal,
    maxTap: heatmapMaxTap,
    maxHold: heatmapMaxHold,
  } = useTypingHeatmap({
    uid: keyboardUid ?? null,
    layer: typingTest.effectiveLayer,
    enabled: !!viewOnly && !!recordEnabled,
    windowMs: (heatmapWindowMin ?? 5) * 60 * 1_000,
  })
  const heatmapActive = heatmapMaxTotal > 0
  const [showLanguageModal, setShowLanguageModal] = useState(false)
  const [showConsentModal, setShowConsentModal] = useState(false)
  const [showResumeModal, setShowResumeModal] = useState(false)

  // Measurement-row comparison: pool every keyboard's saved results, then pick
  // the baseline for the current condition. Refetched when this keyboard's
  // history changes so a just-saved run joins the pool. `state.startTime`
  // excludes the in-flight run from previous/best/average.
  const [comparisonPool, setComparisonPool] = useState<PooledTypingTestResult[]>([])
  useEffect(() => {
    let cancelled = false
    window.vialAPI.pipetteSettingsListAllTypingResults()
      .then((all) => { if (!cancelled) setComparisonPool(all) })
      .catch(() => { /* best-effort: no comparison if unavailable */ })
    return () => { cancelled = true }
  }, [typingTestHistory])

  // The baseline is remembered per condition: switching the typing-test
  // condition recalls the baseline saved for it (default: previous).
  const currentConditionKey = conditionKey(typingTest.config, typingTest.language)
  const comparisonBaselineValue = comparisonBaselines?.[currentConditionKey] ?? DEFAULT_COMPARISON_BASELINE
  // Scope: previous/best/average compare against THIS keyboard's same-condition
  // history only; a pinned baseline can be any keyboard's result (cross-keyboard
  // pool), so the picked result resolves from the full pool.
  const comparison = useMemo(() => {
    const pool = comparisonBaselineValue.kind === 'pinned' ? comparisonPool : (typingTestHistory ?? [])
    // startTime is null before the first run; computeComparison's `beforeMs`
    // guard (`!= null`) treats null and undefined identically.
    return computeComparison(pool, typingTest.config, typingTest.language, comparisonBaselineValue, typingTest.state.startTime ?? undefined)
  }, [comparisonPool, typingTestHistory, typingTest.config, typingTest.language, comparisonBaselineValue, typingTest.state.startTime])
  // Same-condition results only — the choices for a pinned baseline. No
  // `beforeMs`: the user is pinning a past result, not measuring a live run.
  const sameConditionResults = useMemo(
    () => matchingResults(comparisonPool, typingTest.config, typingTest.language),
    [comparisonPool, typingTest.config, typingTest.language],
  )
  const handleComparisonChange = useCallback(
    (baseline: TypingTestComparisonBaseline) => onComparisonBaselineChange?.(currentConditionKey, baseline),
    [onComparisonBaselineChange, currentConditionKey],
  )
  const handleRecordToggle = useCallback(() => {
    if (!onRecordEnabledChange) return
    // Stopping is always allowed without re-prompting; only the
    // first transition from "off → on" needs the disclosure.
    if (recordEnabled) {
      onRecordEnabledChange(false)
      return
    }
    if (!recordingConsentAccepted) {
      // Hide the REC overlay so the modal isn't visually overlapped
      // by the popover; the cancel/accept handlers reopen it so the
      // user lands back where they started.
      setViewOnlyControlsOpen(false)
      setShowConsentModal(true)
      return
    }
    onRecordEnabledChange(true)
  }, [onRecordEnabledChange, recordEnabled, recordingConsentAccepted])

  const handleTrayResidentToggle = useCallback(() => {
    if (!onTrayResidentChange) return
    const next = !trayResident
    onTrayResidentChange(next)
    // Mirrors SettingsToolsTab: a hidden window with no tray icon to
    // reopen it would be unreachable, so turning tray residency off
    // also clears startInTray when it was on.
    if (!next && startInTray) {
      onStartInTrayChange?.(false)
    }
  }, [onTrayResidentChange, trayResident, startInTray, onStartInTrayChange])

  const handleConsentAccept = useCallback(() => {
    onRecordingConsentAccepted?.()
    setShowConsentModal(false)
    setViewOnlyControlsOpen(true)
    onRecordEnabledChange?.(true)
  }, [onRecordingConsentAccepted, onRecordEnabledChange])

  const handleConsentCancel = useCallback(() => {
    setShowConsentModal(false)
    setViewOnlyControlsOpen(true)
  }, [])
  const [viewOnlyControlsOpen, setViewOnlyControlsOpen] = useState(false)
  const [mouseOver, setMouseOver] = useState(false)

  // Show hint text only when mouse is over the window
  useEffect(() => {
    if (!viewOnly) return
    const onEnter = (): void => setMouseOver(true)
    const onLeave = (): void => setMouseOver(false)
    document.documentElement.addEventListener('mouseenter', onEnter)
    document.documentElement.addEventListener('mouseleave', onLeave)
    return () => {
      document.documentElement.removeEventListener('mouseenter', onEnter)
      document.documentElement.removeEventListener('mouseleave', onLeave)
    }
  }, [viewOnly])
  // Always-on-top not supported on Wayland
  const [alwaysOnTopSupported, setAlwaysOnTopSupported] = useState(false)
  useEffect(() => {
    window.vialAPI.isAlwaysOnTopSupported().then(setAlwaysOnTopSupported).catch(() => {})
  }, [])
  const controlsBarRef = useRef<HTMLDivElement>(null)
  const onViewOnlyWindowSizeChangeRef = useRef(onViewOnlyWindowSizeChange)
  onViewOnlyWindowSizeChangeRef.current = onViewOnlyWindowSizeChange

  // Close controls on Escape key
  useEffect(() => {
    if (!viewOnly || !viewOnlyControlsOpen) return
    const handleEsc = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setViewOnlyControlsOpen(false)
    }
    document.addEventListener('keydown', handleEsc)
    return () => {
      document.removeEventListener('keydown', handleEsc)
    }
  }, [viewOnly, viewOnlyControlsOpen])

  const [cssScale, setCssScale] = useState(1)
  const paneWrapperRef = useRef<HTMLDivElement>(null)
  const paneNaturalSizeRef = useRef({ w: 0, h: 0 })
  const MARGIN = 20

  // Calculate default compact window size: keyboard at 100% + pane padding + margins
  const getDefaultCompactSize = useCallback(() => {
    const visibleKeys = filterVisibleKeys(repositionLayoutKeys(keys, layoutOptions), layoutOptions)
    let maxRight = 0
    let maxBottom = 0
    for (const key of visibleKeys) {
      const right = key.x + key.width
      const bottom = key.y + key.height
      if (right > maxRight) maxRight = right
      if (bottom > maxBottom) maxBottom = bottom
    }
    // SVG size at scale=1 + pane padding (px-5=40, border=4, pt-3=12, pb-2=8, label~18) + margins
    const svgW = maxRight * KEY_UNIT + KEYBOARD_PADDING * 2
    const svgH = maxBottom * KEY_UNIT + KEYBOARD_PADDING * 2
    const paneW = svgW + 44
    const paneH = svgH + 42
    let w = paneW + MARGIN * 2
    let h = paneH + MARGIN * 2
    // Cap to 80% of screen if keyboard at 100% exceeds it
    const maxW = window.screen.availWidth * 0.8
    const maxH = window.screen.availHeight * 0.8
    const capScale = Math.min(1, maxW / w, maxH / h)
    if (capScale < 1) {
      w = Math.round(w * capScale)
      h = Math.round(h * capScale)
    }
    return { width: w, height: h }
  }, [keys, layoutOptions])

  // App.tsx entry paths (analytics back, post-unlock, view restore, status bar)
  // call setWindowCompactMode with an undefined saved size, which main skips —
  // leaving the window at normal size. Apply the default here so every entry
  // path lands on a sensibly sized window.
  const appliedDefaultSizeRef = useRef(false)
  useEffect(() => {
    if (!viewOnly) {
      appliedDefaultSizeRef.current = false
      return
    }
    if (viewOnlyWindowSize) return
    if (appliedDefaultSizeRef.current) return
    if (keys.length === 0) return
    appliedDefaultSizeRef.current = true
    const size = getDefaultCompactSize()
    window.vialAPI.setWindowCompactMode(true, size).catch(() => {})
    onViewOnlyWindowSizeChangeRef.current?.(size)
  }, [viewOnly, viewOnlyWindowSize, getDefaultCompactSize, keys.length])

  // Auto-fit using CSS transform + aspect ratio lock
  useEffect(() => {
    if (!viewOnly) return
    let paneNaturalW = 0
    let paneNaturalH = 0

    const computeCssScale = (): void => {
      if (paneNaturalW <= 0 || paneNaturalH <= 0) return
      const availW = window.innerWidth - MARGIN * 2
      const availH = window.innerHeight - MARGIN * 2
      const fitW = availW / paneNaturalW
      const fitH = availH / paneNaturalH
      const fitted = Math.min(fitW, fitH)
      setCssScale(Math.max(0.05, fitted))
    }

    requestAnimationFrame(() => {
      const el = paneWrapperRef.current
      if (!el) return
      paneNaturalW = el.scrollWidth
      paneNaturalH = el.scrollHeight
      paneNaturalSizeRef.current = { w: paneNaturalW, h: paneNaturalH }
      if (paneNaturalW <= 0 || paneNaturalH <= 0) return

      const totalW = paneNaturalW + MARGIN * 2
      const totalH = paneNaturalH + MARGIN * 2
      window.vialAPI.setWindowAspectRatio(totalW / totalH).catch(() => {})

      computeCssScale()
    })

    // Save window size on resize (debounced)
    let saveTimer: ReturnType<typeof setTimeout> | null = null
    const onResize = (): void => {
      computeCssScale()
      if (saveTimer) clearTimeout(saveTimer)
      saveTimer = setTimeout(() => {
        onViewOnlyWindowSizeChangeRef.current?.({ width: window.innerWidth, height: window.innerHeight })
      }, 500)
    }

    window.addEventListener('resize', onResize)
    return () => {
      window.removeEventListener('resize', onResize)
      if (saveTimer) clearTimeout(saveTimer)
      window.vialAPI.setWindowAspectRatio(0).catch(() => {})
    }
  }, [viewOnly, keys, layoutOptions])

  // Sync always-on-top state
  useEffect(() => {
    if (!viewOnly) return
    window.vialAPI.setWindowAlwaysOnTop(viewOnlyAlwaysOnTop ?? false).catch(() => {})
    return () => { window.vialAPI.setWindowAlwaysOnTop(false).catch(() => {}) }
  }, [viewOnly, viewOnlyAlwaysOnTop])

  // Compact mode is managed by App.tsx onViewOnlyChange handler

  const handleViewOnlyToggle = useCallback(() => {
    if (!onViewOnlyChange) return
    const next = !viewOnly
    if (next) {
      const compactSize = viewOnlyWindowSize ?? getDefaultCompactSize()
      window.vialAPI.setWindowCompactMode(true, compactSize).then(() => {
        onViewOnlyChange(true)
      }).catch(() => {})
    } else {
      onViewOnlyChange(false)
    }
  }, [viewOnly, viewOnlyWindowSize, getDefaultCompactSize, onViewOnlyChange, typingTest])

  // Data Source / language. The mode kind (FileImport / Normal) goes in the label —
  // "Data Source(FileImport)" — and the button shows just the source (file name or
  // language), truncated to one line; the full text is on the title.
  let modeType: string
  if (typingTest.config.mode === 'fileImport') {
    modeType = t('editor.typingTest.language.tabFileImport')
  } else if (typingTest.config.mode === 'tatoeba') {
    modeType = t('editor.typingTest.language.tabTatoeba')
  } else {
    modeType = t('editor.typingTest.language.tabMonkeytype')
  }
  let modeLabel: string
  if (typingTest.isLanguageLoading) {
    modeLabel = t('editor.typingTest.language.loadingLanguage')
  } else if (typingTest.config.mode === 'fileImport') {
    modeLabel = typingTest.state.currentQuote?.source ?? t('editor.typingTest.language.fileImportText')
  } else if (typingTest.config.mode === 'tatoeba') {
    modeLabel = typingTest.config.language.replace(/_/g, ' ')
  } else {
    modeLabel = typingTest.language.replace(/_/g, ' ')
  }

  // Config controls, pinned to the window's top-left as a sidebar in editor
  // mode (view-only has no config UI). Lifted out of the keymap row so it sits
  // at the top-left instead of beside the centred keyboard.
  // Left Settings pane — collapsible like the keymap editor's LayerListPanel.
  // The outer box clips + transitions width; the content keeps its full width
  // and is hidden when collapsed (only the toggle rail remains).
  const settingsCollapsed = !settingsPanelOpen
  const configSidebar = viewOnly ? null : (
    <div
      className="flex shrink-0 flex-col self-stretch overflow-hidden rounded-xl border border-edge bg-picker-bg transition-width duration-200 ease-out"
      style={{ width: settingsCollapsed ? PANEL_COLLAPSED_WIDTH : '18rem' }}
      data-testid={settingsCollapsed ? 'typing-settings-panel-collapsed' : 'typing-settings-panel'}
    >
      {!settingsCollapsed && (
      <div className="flex min-h-0 w-72 flex-1 flex-col gap-4 overflow-y-auto p-3">
      {/* Settings — language/mode, base layer, pattern / units / options. */}
      <PanelSection title={t('editor.typingTest.section.settings')}>
        {/* Mode / language — shown for every mode (words / time / quote /
            fileImport); quote uses it to pick the quote source language. */}
        <div className="flex w-full flex-col items-start gap-1">
          <span className="text-sm text-content-muted">{t('editor.typingTest.modeLabel')}({modeType})</span>
          <button
            type="button"
            data-testid="language-selector"
            title={modeLabel}
            className="flex h-8 w-full items-center rounded-md border border-edge px-2.5 text-sm text-content-secondary transition-colors hover:text-content"
            onClick={() => setShowLanguageModal(true)}
            disabled={typingTest.isLanguageLoading}
          >
            <span className="truncate">{modeLabel}</span>
          </button>
        </div>
        {showLanguageModal && (
          <LanguageSelectorModal
            currentLanguage={typingTest.language}
            currentFileImportTextId={typingTest.config.mode === 'fileImport' ? typingTest.config.textId : undefined}
            currentTatoebaLanguage={typingTest.config.mode === 'tatoeba' ? typingTest.config.language : undefined}
            onSelectLanguage={(name) => {
              // Picking a MonkeyType language leaves fileImport / tatoeba mode —
              // restore the last normal (words/time/quote) config so its
              // Pattern/Units/Option settings survive the round trip; fall back
              // to the default if none saved.
              if (typingTest.config.mode === 'fileImport' || typingTest.config.mode === 'tatoeba') {
                onConfigChange(monkeytypeConfig ?? DEFAULT_CONFIG)
              }
              void onLanguageChange(name)
            }}
            onSelectImport={(textId) => onConfigChange({ mode: 'fileImport', textId, ...carryRomajiFields(typingTest.config) })}
            onSelectTatoeba={(language) => {
              // Carry the previous tatoeba Pattern/Units forward (switching
              // pack language shouldn't reset Lines/Time or their counts);
              // default to Lines/5/30 when not already in tatoeba mode.
              const cfg = typingTest.config
              const { pattern, lineCount, duration } = cfg.mode === 'tatoeba'
                ? cfg
                : { pattern: 'lines' as const, lineCount: 5, duration: 30 }
              onConfigChange({ mode: 'tatoeba', language, pattern, lineCount, duration, ...carryRomajiFields(cfg) })
            }}
            onCurrentTextDeleted={() => {
              // The selected imported text was deleted — fall back to
              // the default (words mode, English).
              onConfigChange(DEFAULT_CONFIG)
              void onLanguageChange(DEFAULT_LANGUAGE)
            }}
            onClose={() => setShowLanguageModal(false)}
          />
        )}
        {/* Base Layer / Lines / Font side by side. Lines + Font are the shared
            reading-window display settings (every mode); wraps if too narrow. */}
        <div className="flex w-full items-start gap-2">
          {layers > 1 && (
            <div className="flex flex-1 flex-col items-start gap-1">
              <span className="text-sm text-content-muted">{t('editor.typingTest.baseLayer')}</span>
              <select
                data-testid="base-layer-select"
                aria-label={t('editor.typingTest.baseLayer')}
                value={typingTest.baseLayer}
                onChange={(e) => typingTest.setBaseLayer(Number(e.target.value))}
                className="h-8 w-full rounded-md border border-edge bg-surface-alt px-2 text-sm text-content-secondary focus:border-accent focus:outline-none"
              >
                {Array.from({ length: layers }, (_, i) => (
                  <option key={i} value={i}>{layerNames?.[i] || i}</option>
                ))}
              </select>
            </div>
          )}
          <div className="flex flex-1 flex-col items-start gap-1">
            <span className="text-sm text-content-muted">{t('editor.typingTest.lines')}</span>
            <select
              data-testid="display-lines-select"
              aria-label={t('editor.typingTest.lines')}
              value={displayLines ?? DEFAULT_DISPLAY_LINES}
              onChange={(e) => onDisplayLinesChange?.(Number(e.target.value))}
              className="h-8 w-full rounded-md border border-edge bg-surface-alt px-2 text-sm text-content-secondary focus:border-accent focus:outline-none"
            >
              {LINE_OPTIONS.map((n) => <option key={n} value={n}>{n}</option>)}
            </select>
          </div>
          <div className="flex flex-1 flex-col items-start gap-1">
            <span className="text-sm text-content-muted">{t('editor.typingTest.fontSize')}</span>
            <select
              data-testid="font-size-select"
              aria-label={t('editor.typingTest.fontSize')}
              value={fontSize ?? DEFAULT_FONT_SIZE}
              onChange={(e) => onFontSizeChange?.(Number(e.target.value))}
              className="h-8 w-full rounded-md border border-edge bg-surface-alt px-2 text-sm text-content-secondary focus:border-accent focus:outline-none"
            >
              {FONT_OPTIONS.map((n) => <option key={n} value={n}>{n}</option>)}
            </select>
          </div>
        </div>
        {/* words/time/quote/tatoeba always get the full bar (tatoeba has its
            own Pattern/Units, see TypingTestSettingsBar); fileImport only
            gets it (Option row only) once its content is actually
            romaji-capable — otherwise there is nothing for the bar to show,
            same as before this mode's romaji support. */}
        {(typingTest.config.mode !== 'fileImport'
          || isRomajiCapable(typingTest.config, typingTest.language, typingTest.state.romajiCapable)) && (
          <TypingTestSettingsBar
            config={typingTest.config}
            onConfigChange={onConfigChange}
            language={typingTest.language}
            textRomajiCapable={typingTest.state.romajiCapable}
          />
        )}
      </PanelSection>

      {/* Data — saved run history + comparison baseline settings. Always shown
          (even with no saved results yet) so History stays reachable and the
          comparison baseline can be set up before the first result. */}
      <PanelSection title={t('editor.typingTest.section.data')}>
        <HistoryToggle
          results={typingTestHistory ?? []}
          deviceName={deviceName}
          onRename={onRenameTypingTestResult}
          onDelete={onDeleteTypingTestResult}
        />
        <ComparisonToggle
          pool={sameConditionResults}
          baseline={comparisonBaselineValue}
          onChange={handleComparisonChange}
        />
        {/* Save Unnamed — when on (default), a finished result is auto-saved
            even without a name; when off, only named results are kept. */}
        <ToggleRow
          testid="typing-test-toggle-save-unnamed"
          label={t('editor.typingTest.saveUnnamedToggle')}
          on={saveUnnamed}
          onToggle={() => onToggleSaveUnnamed?.(!saveUnnamed)}
          title={t(saveUnnamed ? 'editor.typingTest.disableSaveUnnamed' : 'editor.typingTest.enableSaveUnnamed')}
        />
      </PanelSection>

      {/* View — toggles ordered top-to-bottom to match the editor layout:
          operation (controls row) → measurement (stats row) → keymap pane.
          The switch is on when the section is visible. */}
      <PanelSection title={t('editor.typingTest.section.view')}>
        <ToggleRow
          testid="typing-test-toggle-controls"
          label={t('editor.typingTest.controlsToggle')}
          on={!hideControls}
          onToggle={() => onToggleHideControls?.(!hideControls)}
          title={t(hideControls ? 'editor.typingTest.showControls' : 'editor.typingTest.hideControls')}
        />
        <ToggleRow
          testid="typing-test-toggle-stats"
          label={t('editor.typingTest.statsToggle')}
          on={!hideStatsRow}
          onToggle={() => onToggleHideStatsRow?.(!hideStatsRow)}
          title={t(hideStatsRow ? 'editor.typingTest.showStats' : 'editor.typingTest.hideStats')}
        />
        <ToggleRow
          testid="typing-test-toggle-keymap"
          label={t('editor.typingTest.keymapToggle')}
          on={!hideKeymap}
          onToggle={() => onToggleHideKeymap?.(!hideKeymap)}
          title={t(hideKeymap ? 'editor.typingTest.showKeymap' : 'editor.typingTest.hideKeymap')}
        />
      </PanelSection>
      </div>
      )}
      {/* Collapse / expand toggle — pinned to the bottom (mt-auto). */}
      <div className="mt-auto shrink-0 border-t border-edge p-2">
        <button
          type="button"
          data-testid="typing-settings-panel-toggle"
          title={t(settingsCollapsed ? 'editor.typingTest.expandSettings' : 'editor.typingTest.collapseSettings')}
          aria-label={t(settingsCollapsed ? 'editor.typingTest.expandSettings' : 'editor.typingTest.collapseSettings')}
          className="flex items-center justify-center rounded-md p-1 text-content-muted transition-colors hover:bg-surface-dim hover:text-content"
          onClick={() => onToggleSettingsPanel?.(settingsCollapsed)}
        >
          {settingsCollapsed ? <ChevronsRight size={ICON_SM} aria-hidden="true" /> : <ChevronsLeft size={ICON_SM} aria-hidden="true" />}
        </button>
      </div>
    </div>
  )

  return (
    <>
      {showConsentModal && (
        <TypingRecordingConsentModal
          onAccept={handleConsentAccept}
          onCancel={handleConsentCancel}
        />
      )}
      {showResumeModal && (
        <PauseResumeModal
          wordIndex={typingTest.state.currentWordIndex}
          totalWords={typingTest.state.words.length}
          onResume={() => { setShowResumeModal(false); onResumeTest?.() }}
          onRestart={() => { setShowResumeModal(false); onRestartTestFromStart?.() }}
          onCancel={() => setShowResumeModal(false)}
        />
      )}
      {/* Editor: config sidebar pinned top-left, reading window + keymap
          centred in the remaining space. View-only collapses the wrappers
          (`contents`) so its scaled-pane layout is untouched. */}
      <div className={viewOnly ? 'contents' : 'flex min-h-0 w-full flex-1 items-stretch gap-2'}>
      {configSidebar}
      <div className={viewOnly ? 'contents' : 'flex min-w-0 flex-1 flex-col items-center'}>
      {!viewOnly && (
        <TypingTestView
          hideStatsRow={hideStatsRow}
          hideControls={hideControls}
          comparison={comparison}
          state={typingTest.state}
          wpm={typingTest.wpm}
          kpm={typingTest.kpm}
          accuracy={typingTest.accuracy}
          elapsedSeconds={typingTest.elapsedSeconds}
          remainingSeconds={typingTest.remainingSeconds}
          config={typingTest.config}
          paused={typingTest.state.status === 'running' && !typingTest.windowFocused}
          onCompositionStart={typingTest.processCompositionStart}
          onCompositionUpdate={typingTest.processCompositionUpdate}
          onCompositionEnd={typingTest.processCompositionEnd}
          romajiGuide={typingTest.romajiGuide}
          onImeSpaceKey={() => typingTest.processKeyEvent(' ', false, false, false)}
          displayLines={displayLines}
          fontSize={fontSize}
          onNameResult={onNameFinishedResult}
          // Chips come from the just-finished result (held unsaved or saved).
          resultNameChips={finishedResult ? buildResultNameChips(finishedResult, t, deviceName) : []}
          onStart={() => typingTest.restart()}
          onPause={() => onPauseTest?.()}
          onResume={() => setShowResumeModal(true)}
          hasSavedMemory={hasSavedMemory}
        />
      )}
      <div
        className={viewOnly ? 'flex min-h-0 w-full flex-1 cursor-pointer items-center justify-center overflow-hidden' : 'flex items-start justify-center overflow-auto'}
        onClick={viewOnly ? () => setViewOnlyControlsOpen((v) => !v) : undefined}
      >
        <div className={viewOnly ? 'relative' : 'relative w-full'} style={viewOnly && paneNaturalSizeRef.current.w > 0 ? { width: paneNaturalSizeRef.current.w * cssScale, height: paneNaturalSizeRef.current.h * cssScale, overflow: 'hidden' } : undefined}>
          {viewOnly && <div className="absolute inset-0 z-10" />}
          <div
            ref={viewOnly ? paneWrapperRef : undefined}
            className={viewOnly ? undefined : 'w-full'}
            style={viewOnly ? { transform: `scale(${cssScale})`, transformOrigin: 'top left' } : undefined}
          >
          {/* Editor: centre the keymap in the right pane. View-only must NOT
              add justify-center — natural-size measurement happens at width 0,
              where centring pushes content half-off and halves scrollWidth. */}
          <div className={`flex w-full items-start${viewOnly ? '' : ' justify-center'}`}>
          <div className="shrink-0">
          <div className="w-fit">
          {/* Keymap hidden only in the editor view — view-only mode is
              keyboard-focused, so the toggle never applies there. */}
          {!(hideKeymap && !viewOnly) && (
            <KeyboardPane
              paneId="primary"
              isActive={false}
              keys={keys}
              keycodes={keycodes}
              encoderKeycodes={encoderKeycodes}
              selectedKey={null}
              selectedEncoder={null}
              selectedMaskPart={false}
              selectedKeycode={null}
              pressedKeys={pressedKeys}
              everPressedKeys={undefined}
              remappedKeys={remappedKeys}
              remappedEncoders={remappedEncoders}
              remapKind={remapKind}
              remapLabel={remapLabel}
              layoutOptions={layoutOptions}
              heatmapCells={heatmapCells}
              heatmapMaxTotal={heatmapMaxTotal}
              heatmapMaxTap={heatmapMaxTap}
              heatmapMaxHold={heatmapMaxHold}
              scale={viewOnly ? 1 : scale}
              layerLabel={layerLabel}
              layerLabelTestId="layer-label"
              contentRef={contentRef}
            />
          )}
          </div>
          </div>
          </div>
          {heatmapActive && (
            <p
              data-testid="typing-test-heatmap-legend"
              className="mt-1 text-center text-xs text-content-muted"
            >
              {t('editor.typingTest.heatmap.legend', { minutes: heatmapWindowMin ?? 5 })}
            </p>
          )}
          {/* Layer-tracking note describes the keymap, so hide it with the keymap. */}
          {!viewOnly && !hideKeymap && (
            <p data-testid="typing-test-layer-note" className="text-center text-xs text-content-muted">
              {t('editor.typingTest.layerNote')}
            </p>
          )}
        </div>
        </div>
      </div>
      </div>
      </div>
      {viewOnly && (
        <>
        <div
          className={`pointer-events-none fixed inset-x-0 bottom-0 z-40 flex justify-center py-1 transition-opacity duration-200 ${viewOnlyControlsOpen || (!mouseOver && !recordEnabled) ? 'opacity-0' : 'opacity-100'}`}
        >
          <span className={`text-2xs ${!mouseOver && recordEnabled ? 'text-accent' : 'text-content-muted'}`}>
            {mouseOver
              ? t('editor.typingTest.closeHint')
              : t('editor.typingTest.recordingIndicator')}
          </span>
        </div>
        <div ref={controlsBarRef} className="fixed bottom-0 right-0 z-50">
          <div
            id="view-only-panel"
            role="menu"
            className={`absolute bottom-0 right-0 flex flex-col gap-1.5 rounded-tl-lg bg-surface-alt/95 px-3 pt-3 pb-2 text-xs shadow-lg backdrop-blur-sm transition-all duration-200 ease-out ${viewOnlyControlsOpen ? 'translate-y-0 opacity-100' : 'pointer-events-none translate-y-full overflow-hidden opacity-0'}`}
            onClick={(e) => e.stopPropagation()}
            {...(!viewOnlyControlsOpen && { inert: '' } as Record<string, string>)}
          >
            {/* Tab row — Window (sizing + always-on-top) / REC
                (recording toggle + analytics entry) / Monitor App
                (active-app capture toggle). The active tab is
                persisted per keyboard via PipetteSettings. */}
            <div role="tablist" className="flex gap-1">
              <button
                type="button"
                role="tab"
                aria-selected={menuTab === 'window'}
                data-testid="menu-tab-window"
                className={`flex-1 whitespace-nowrap ${menuTab === 'window' ? BTN_TOGGLE_ACTIVE : BTN_TOGGLE_INACTIVE}`}
                onClick={() => onMenuTabChange?.('window')}
              >
                {t('editor.typingTest.tab.window')}
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={menuTab === 'rec'}
                data-testid="menu-tab-rec"
                className={`flex-1 whitespace-nowrap ${menuTab === 'rec' ? BTN_TOGGLE_ACTIVE : BTN_TOGGLE_INACTIVE}`}
                onClick={() => onMenuTabChange?.('rec')}
              >
                {t('editor.typingTest.tab.rec')}
              </button>
            </div>

            {/* Each tab body is wrapped in its own flex column so we can
                pin a shared min-h. REC currently has the most controls
                (Start/Stop, Monitor App, tray toggles, View Analytics,
                HeatMap window), so the other tabs match its natural
                height. Keep this in sync if any tab grows/shrinks
                meaningfully. */}
            {menuTab === 'window' && (
              <div className="flex min-h-word-list flex-col gap-1.5">
                <button
                  type="button"
                  role="menuitem"
                  data-testid="reset-window-size"
                  className={`whitespace-nowrap ${BTN_TOGGLE_INACTIVE}`}
                  onClick={() => {
                    const size = getDefaultCompactSize()
                    window.vialAPI.setWindowCompactMode(true, size).catch(() => {})
                    if (onViewOnlyWindowSizeChange) onViewOnlyWindowSizeChange(size)
                    setViewOnlyControlsOpen(false)
                  }}
                >
                  {t('editor.typingTest.resetSize')}
                </button>
                <button
                  type="button"
                  role="menuitem"
                  data-testid="fit-window-size"
                  className={`whitespace-nowrap ${BTN_TOGGLE_INACTIVE}`}
                  onClick={() => {
                    const defaultSize = getDefaultCompactSize()
                    const ratio = defaultSize.height / defaultSize.width
                    const w = window.innerWidth
                    const h = Math.round(w * ratio)
                    const size = { width: w, height: h }
                    window.vialAPI.setWindowCompactMode(true, size).catch(() => {})
                    if (onViewOnlyWindowSizeChange) onViewOnlyWindowSizeChange(size)
                    setViewOnlyControlsOpen(false)
                  }}
                >
                  {t('editor.typingTest.fitSize')}
                </button>
                {alwaysOnTopSupported && onViewOnlyAlwaysOnTopChange && (
                  <button
                    type="button"
                    role="menuitem"
                    data-testid="always-on-top-toggle"
                    className={`whitespace-nowrap ${viewOnlyAlwaysOnTop ? BTN_TOGGLE_ACTIVE : BTN_TOGGLE_INACTIVE}`}
                    onClick={() => onViewOnlyAlwaysOnTopChange(!viewOnlyAlwaysOnTop)}
                  >
                    {t('editor.typingTest.alwaysOnTop')}
                  </button>
                )}
              </div>
            )}

            {menuTab === 'rec' && (
              <div className="flex min-h-word-list flex-col gap-1.5">
                {onRecordEnabledChange && (
                  <button
                    type="button"
                    role="menuitemcheckbox"
                    aria-checked={recordEnabled ?? false}
                    data-testid="typing-record-toggle"
                    className={`whitespace-nowrap ${recordEnabled ? BTN_TOGGLE_ACTIVE : BTN_TOGGLE_INACTIVE}`}
                    onClick={handleRecordToggle}
                  >
                    {recordEnabled ? t('editor.typingTest.recordStop') : t('editor.typingTest.recordStart')}
                  </button>
                )}
                {/* Monitor App lives directly under the Start/Stop
                    button so the recording-related toggles read top
                    to bottom. The label is fixed; the on/off state
                    only changes the border / background colour. The
                    button is greyed out while REC is off so app-name
                    capture has exactly one entry point. */}
                {onMonitorAppEnabledChange && (
                  <button
                    type="button"
                    role="menuitemcheckbox"
                    aria-checked={monitorAppEnabled ?? false}
                    aria-disabled={!recordEnabled}
                    data-testid="monitor-app-toggle"
                    className={
                      !recordEnabled
                        ? 'whitespace-nowrap rounded border border-edge px-2 py-1 text-content-muted opacity-60 cursor-not-allowed'
                        : `whitespace-nowrap ${monitorAppEnabled ? BTN_TOGGLE_ACTIVE : BTN_TOGGLE_INACTIVE}`
                    }
                    onClick={() => {
                      if (!recordEnabled) return
                      onMonitorAppEnabledChange(!monitorAppEnabled)
                    }}
                  >
                    {t('editor.typingTest.monitorApp.label')}
                  </button>
                )}
                {/* Tray toggles — same AppConfig fields and linked-clear
                    semantics as Settings > Tools, surfaced here since the
                    view-only window is often the last one open before the
                    user reaches for the tray. */}
                {onTrayResidentChange && (
                  <button
                    type="button"
                    role="menuitemcheckbox"
                    aria-checked={trayResident ?? false}
                    data-testid="typing-tray-resident-toggle"
                    className={`whitespace-nowrap ${trayResident ? BTN_TOGGLE_ACTIVE : BTN_TOGGLE_INACTIVE}`}
                    onClick={handleTrayResidentToggle}
                  >
                    {t('settings.trayResident')}
                  </button>
                )}
                {onStartInTrayChange && (
                  <button
                    type="button"
                    role="menuitemcheckbox"
                    aria-checked={startInTray ?? false}
                    aria-disabled={!trayResident}
                    data-testid="typing-start-in-tray-toggle"
                    className={
                      !trayResident
                        ? 'whitespace-nowrap rounded border border-edge px-2 py-1 text-content-muted opacity-60 cursor-not-allowed'
                        : `whitespace-nowrap ${startInTray ? BTN_TOGGLE_ACTIVE : BTN_TOGGLE_INACTIVE}`
                    }
                    onClick={() => {
                      if (!trayResident) return
                      onStartInTrayChange(!startInTray)
                    }}
                  >
                    {t('settings.startInTray')}
                  </button>
                )}
                {onViewAnalytics && (
                  <button
                    type="button"
                    role="menuitem"
                    data-testid="view-analytics"
                    className={`whitespace-nowrap ${BTN_TOGGLE_INACTIVE}`}
                    onClick={() => {
                      setViewOnlyControlsOpen(false)
                      onViewAnalytics('typingView')
                    }}
                  >
                    {t('app.analyzeTab')}
                  </button>
                )}
                {onHeatmapWindowMinChange && (
                  <div className="flex items-center justify-between gap-1">
                    <span className="text-content-muted">{t('editor.typingTest.heatmapWindowShort')}</span>
                    <select
                      data-testid="heatmap-window-select"
                      aria-label={t('editor.typingTest.heatmapWindow')}
                      value={heatmapWindowMin ?? 5}
                      onChange={(e) => onHeatmapWindowMinChange(Number(e.target.value))}
                      className="rounded border border-edge bg-surface-alt px-1.5 py-0.5 text-xs text-content-secondary focus:border-accent focus:outline-none"
                    >
                      {TYPING_HEATMAP_WINDOW_OPTIONS.map((m) => (
                        <option key={m} value={m}>{t('editor.typingTest.heatmapWindowOption', { minutes: m })}</option>
                      ))}
                    </select>
                  </div>
                )}
              </div>
            )}

            {/* Separator — what follows is always visible regardless of tab */}
            <div className="mt-1 border-t border-edge-subtle" aria-hidden="true" />

            {layers > 1 && (
              <div className="flex items-center justify-between gap-1">
                <span className="text-content-muted">{t('editor.typingTest.baseLayerShort')}</span>
                <select
                  data-testid="base-layer-select"
                  aria-label={t('editor.typingTest.baseLayer')}
                  value={typingTest.baseLayer}
                  onChange={(e) => typingTest.setBaseLayer(Number(e.target.value))}
                  className="rounded border border-edge bg-surface-alt px-1.5 py-0.5 text-xs text-content-secondary focus:border-accent focus:outline-none"
                >
                  {Array.from({ length: layers }, (_, i) => (
                    <option key={i} value={i}>{layerNames?.[i] || i}</option>
                  ))}
                </select>
              </div>
            )}

            {onViewOnlyChange && (
              <button
                type="button"
                role="menuitem"
                data-testid="view-only-toggle"
                // Mirrors the StatusBar disconnect button: red text on
                // a default-edge border so "exit" reads as the
                // destructive / out-of-mode action rather than the
                // accent-coloured primary path.
                className="whitespace-nowrap rounded border border-edge px-2 py-1 text-danger transition-colors hover:text-danger/80"
                onClick={handleViewOnlyToggle}
              >
                {t('editor.typingTest.exitViewOnly')}
              </button>
            )}
          </div>
        </div>
        </>
      )}

    </>
  )
}
