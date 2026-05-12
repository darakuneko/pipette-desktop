// SPDX-License-Identifier: GPL-2.0-or-later

import { useCallback, useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { TIME_STEPS } from './settings-modal-shared'
import { ROW_CLASS, toggleTrackClass, toggleKnobClass } from '../editors/modal-controls'
import { KEYBOARD_LAYOUTS } from '../../data/keyboard-layouts'
import { useAppConfig } from '../../hooks/useAppConfig'
import { SUPPORTED_LANGUAGES } from '../../i18n'
import { useKeyLabels } from '../../hooks/useKeyLabels'
import { useI18nPackStore } from '../../hooks/useI18nPackStore'
import { useThemePackStore } from '../../hooks/useThemePackStore'
import { KeyLabelsModal } from '../key-labels/KeyLabelsModal'
import { LanguagePacksModal } from '../i18n-packs/LanguagePacksModal'
import { ThemePacksModal } from '../theme-packs/ThemePacksModal'
import { isPackTheme, extractPackId, type ThemeSelection } from '../../hooks/useTheme'
import type { KeyboardLayoutId, AutoLockMinutes } from '../../hooks/useDevicePrefs'
import { ZOOM_FACTOR_MIN, ZOOM_FACTOR_MAX, ZOOM_FACTOR_DEFAULT, clampZoomFactor, type BasicViewType, type SplitKeyMode } from '../../../shared/types/app-config'

export interface SettingsToolsTabProps {
  theme: ThemeSelection
  onThemeChange: (mode: ThemeSelection) => void
  defaultLayout: KeyboardLayoutId
  onDefaultLayoutChange: (layout: KeyboardLayoutId) => void
  defaultAutoAdvance: boolean
  onDefaultAutoAdvanceChange: (enabled: boolean) => void
  defaultLayerPanelOpen: boolean
  onDefaultLayerPanelOpenChange: (open: boolean) => void
  defaultBasicViewType: BasicViewType
  onDefaultBasicViewTypeChange: (type: BasicViewType) => void
  defaultSplitKeyMode: SplitKeyMode
  onDefaultSplitKeyModeChange: (mode: SplitKeyMode) => void
  defaultQuickSelect: boolean
  onDefaultQuickSelectChange: (enabled: boolean) => void
  autoLockTime: AutoLockMinutes
  onAutoLockTimeChange: (m: AutoLockMinutes) => void
  maxKeymapHistory: number
  onMaxKeymapHistoryChange: (n: number) => void
  /** Hub display_name; used by Key Labels modal to detect own posts. */
  hubDisplayName?: string | null
  /** True when Hub auth + display_name allow upload/update/remove. */
  hubCanWrite?: boolean
}

export function SettingsToolsTab({
  theme,
  onThemeChange,
  defaultLayout,
  onDefaultLayoutChange,
  defaultAutoAdvance,
  onDefaultAutoAdvanceChange,
  defaultLayerPanelOpen,
  onDefaultLayerPanelOpenChange,
  defaultBasicViewType,
  onDefaultBasicViewTypeChange,
  defaultSplitKeyMode,
  onDefaultSplitKeyModeChange,
  defaultQuickSelect,
  onDefaultQuickSelectChange,
  autoLockTime,
  onAutoLockTimeChange,
  maxKeymapHistory,
  onMaxKeymapHistoryChange,
  hubDisplayName = null,
  hubCanWrite = false,
}: SettingsToolsTabProps) {
  const { t } = useTranslation()
  const appConfig = useAppConfig()
  const [keyLabelsOpen, setKeyLabelsOpen] = useState(false)
  const [languagePacksOpen, setLanguagePacksOpen] = useState(false)
  const [themePacksOpen, setThemePacksOpen] = useState(false)
  const keyLabels = useKeyLabels()
  const i18nPacks = useI18nPackStore()
  const themePacks = useThemePackStore()

  const [zoomInput, setZoomInput] = useState(String(appConfig.config.zoomFactor ?? ZOOM_FACTOR_DEFAULT))

  useEffect(() => {
    setZoomInput(String(appConfig.config.zoomFactor ?? ZOOM_FACTOR_DEFAULT))
  }, [appConfig.config.zoomFactor])

  const commitZoom = useCallback(() => {
    const raw = Number(zoomInput)
    if (Number.isNaN(raw)) {
      setZoomInput(String(appConfig.config.zoomFactor ?? ZOOM_FACTOR_DEFAULT))
      return
    }
    const clamped = clampZoomFactor(raw)
    setZoomInput(String(clamped))
    if (clamped !== (appConfig.config.zoomFactor ?? ZOOM_FACTOR_DEFAULT)) {
      appConfig.set('zoomFactor', clamped)
    }
  }, [zoomInput, appConfig])

  const activeThemeName = useMemo(() => {
    if (isPackTheme(theme)) {
      const packId = extractPackId(theme)
      const meta = themePacks.metas.find((m) => m.id === packId)
      return meta?.name ?? packId
    }
    return t(`theme.${theme}`)
  }, [theme, themePacks.metas, t])

  const languageOptions = useMemo(() => {
    const opts: { id: string; name: string }[] = SUPPORTED_LANGUAGES.map((l) => ({ id: l.id, name: l.name }))
    for (const meta of i18nPacks.metas) {
      if (meta.deletedAt || !meta.enabled) continue
      opts.push({ id: `pack:${meta.id}`, name: meta.name })
    }
    return opts
  }, [i18nPacks.metas])

  /**
   * Default-layout dropdown options. QWERTY is materialised as a Key
   * Label store entry by `ensureQwertyEntry`, so iterating `metas`
   * first preserves the user-controlled drag order from the Key
   * Labels modal. `KEYBOARD_LAYOUTS` only serves as a safety net for
   * the brief window before `metas` has loaded.
   */
  const layoutOptions = useMemo(() => {
    const seen = new Set<string>()
    const out: { id: string; name: string }[] = []
    for (const meta of keyLabels.metas) {
      if (seen.has(meta.id)) continue
      seen.add(meta.id)
      out.push({ id: meta.id, name: meta.name })
    }
    for (const def of KEYBOARD_LAYOUTS) {
      if (seen.has(def.id)) continue
      seen.add(def.id)
      out.push({ id: def.id, name: def.name })
    }
    return out
  }, [keyLabels.metas])

  // Auto-heal an orphaned saved default layout. If the entry was
  // deleted from the Key Label store (locally or via sync) the saved
  // id no longer matches any option and would render as a raw UUID
  // in the dropdown. Reset it to qwerty so the UI is coherent. We
  // gate on `metas.length > 0` to avoid firing during the first-load
  // window when metas have not arrived yet.
  useEffect(() => {
    if (keyLabels.metas.length === 0) return
    if (!defaultLayout) return
    const known = layoutOptions.some((o) => o.id === defaultLayout)
    if (known) return
    onDefaultLayoutChange('qwerty')
  }, [keyLabels.metas, defaultLayout, layoutOptions, onDefaultLayoutChange])

  return (
    <>
    <div className="pt-4 space-y-6">
      <section>
        <div className="grid grid-cols-2 gap-3">
          <div className={ROW_CLASS} data-testid="settings-language-row">
            <span className="text-sm font-medium text-content-secondary">
              {t('i18n.manageRow')}
            </span>
            <div className="flex items-center gap-2">
              <span
                className="text-[13px] text-content"
                data-testid="settings-language-active-name"
              >
                {(() => {
                  const activeId = appConfig.config.language ?? 'builtin:en'
                  return languageOptions.find((l) => l.id === activeId)?.name ?? activeId
                })()}
              </span>
              <button
                type="button"
                onClick={() => setLanguagePacksOpen(true)}
                className="rounded border border-edge bg-surface px-2.5 py-1.5 text-[13px] text-content hover:bg-surface-hover focus:border-accent focus:outline-none"
                data-testid="settings-language-packs-button"
              >
                {t('i18n.edit')}
              </button>
            </div>
          </div>

          <div className={ROW_CLASS} data-testid="settings-key-labels-row">
            <span className="text-sm font-medium text-content-secondary">
              {t('keyLabels.manageRow')}
            </span>
            <button
              type="button"
              onClick={() => setKeyLabelsOpen(true)}
              className="rounded border border-edge bg-surface px-2.5 py-1.5 text-[13px] text-content hover:bg-surface-hover focus:border-accent focus:outline-none"
              data-testid="settings-key-labels-button"
            >
              {t('keyLabels.edit')}
            </button>
          </div>

          <div className={ROW_CLASS} data-testid="settings-theme-packs-row">
            <span className="text-sm font-medium text-content-secondary">
              {t('themePacks.manageRow')}
            </span>
            <div className="flex items-center gap-2">
              <span
                className="text-[13px] text-content"
                data-testid="settings-theme-pack-active-name"
              >
                {activeThemeName}
              </span>
              <button
                type="button"
                onClick={() => setThemePacksOpen(true)}
                className="rounded border border-edge bg-surface px-2.5 py-1.5 text-[13px] text-content hover:bg-surface-hover focus:border-accent focus:outline-none"
                data-testid="settings-theme-packs-button"
              >
                {t('i18n.edit')}
              </button>
            </div>
          </div>

          <div className={ROW_CLASS} data-testid="settings-zoom-factor-row">
            <div className="flex flex-col gap-0.5">
              <span className="text-sm font-medium text-content-secondary">
                {t('settings.zoomLevel')}
              </span>
              <span className="text-xs text-content-muted">
                {t('settings.zoomLevelWarning')}
              </span>
            </div>
            <div className="flex items-center gap-1.5">
              <input
                id="settings-zoom-factor-input"
                type="number"
                min={ZOOM_FACTOR_MIN}
                max={ZOOM_FACTOR_MAX}
                value={zoomInput}
                onChange={(e) => setZoomInput(e.target.value)}
                onBlur={commitZoom}
                onKeyDown={(e) => { if (e.key === 'Enter') commitZoom() }}
                className="w-20 rounded border border-edge bg-surface pl-2.5 pr-5 py-1.5 text-[13px] text-content text-right tabular-nums hover:bg-surface-hover focus:border-accent focus:outline-none"
                data-testid="settings-zoom-factor-input"
              />
              <span className="text-[13px] text-content-muted">%</span>
            </div>
          </div>
        </div>
      </section>

      <section>
        <h4 className="mb-1 text-sm font-medium text-content-secondary">
          {t('settings.defaults')}
        </h4>
        <div className="grid grid-cols-2 gap-3">
          <div className={ROW_CLASS} data-testid="settings-default-basic-view-type-row">
            <label htmlFor="settings-default-basic-view-type-selector" className="text-[13px] font-medium text-content">
              {t('settings.defaultBasicViewType')}
            </label>
            <select
              id="settings-default-basic-view-type-selector"
              value={defaultBasicViewType}
              onChange={(e) => onDefaultBasicViewTypeChange(e.target.value as BasicViewType)}
              className="rounded border border-edge bg-surface px-2.5 py-1.5 text-[13px] text-content focus:border-accent focus:outline-none"
              data-testid="settings-default-basic-view-type-selector"
            >
              <option value="ansi">{t('settings.basicViewTypeAnsi')}</option>
              <option value="iso">{t('settings.basicViewTypeIso')}</option>
              <option value="jis">{t('settings.basicViewTypeJis')}</option>
              <option value="list">{t('settings.basicViewTypeList')}</option>
            </select>
          </div>

          <div className={ROW_CLASS} data-testid="settings-default-layout-row">
            <label htmlFor="settings-default-layout-selector" className="text-[13px] font-medium text-content">
              {t('settings.defaultLayout')}
            </label>
            <select
              id="settings-default-layout-selector"
              value={defaultLayout}
              onChange={(e) => onDefaultLayoutChange(e.target.value as KeyboardLayoutId)}
              className="rounded border border-edge bg-surface px-2.5 py-1.5 text-[13px] text-content focus:border-accent focus:outline-none"
              data-testid="settings-default-layout-selector"
            >
              {layoutOptions.map((layoutDef) => (
                <option key={layoutDef.id} value={layoutDef.id}>
                  {layoutDef.name}
                </option>
              ))}
            </select>
          </div>

          <div className={ROW_CLASS} data-testid="settings-default-auto-advance-row">
            <span className="text-[13px] font-medium text-content">
              {t('settings.defaultAutoAdvance')}
            </span>
            <button
              type="button"
              role="switch"
              aria-checked={defaultAutoAdvance}
              aria-label={t('settings.defaultAutoAdvance')}
              className={toggleTrackClass(defaultAutoAdvance)}
              onClick={() => onDefaultAutoAdvanceChange(!defaultAutoAdvance)}
              data-testid="settings-default-auto-advance-toggle"
            >
              <span className={toggleKnobClass(defaultAutoAdvance)} />
            </button>
          </div>

          <div className={ROW_CLASS} data-testid="settings-default-split-key-mode-row">
            <span className="text-[13px] font-medium text-content">
              {t('settings.defaultSplitKeyMode')}
            </span>
            <button
              type="button"
              role="switch"
              aria-checked={defaultSplitKeyMode === 'split'}
              aria-label={t('settings.defaultSplitKeyMode')}
              className={toggleTrackClass(defaultSplitKeyMode === 'split')}
              onClick={() => onDefaultSplitKeyModeChange(defaultSplitKeyMode === 'split' ? 'flat' : 'split')}
              data-testid="settings-default-split-key-mode-toggle"
            >
              <span className={toggleKnobClass(defaultSplitKeyMode === 'split')} />
            </button>
          </div>

          <div className={ROW_CLASS} data-testid="settings-default-quick-select-row">
            <span className="text-[13px] font-medium text-content">
              {t('settings.defaultQuickSelect')}
            </span>
            <button
              type="button"
              role="switch"
              aria-checked={defaultQuickSelect}
              aria-label={t('settings.defaultQuickSelect')}
              className={toggleTrackClass(defaultQuickSelect)}
              onClick={() => onDefaultQuickSelectChange(!defaultQuickSelect)}
              data-testid="settings-default-quick-select-toggle"
            >
              <span className={toggleKnobClass(defaultQuickSelect)} />
            </button>
          </div>

          <div className={ROW_CLASS} data-testid="settings-default-layer-panel-open-row">
            <span className="text-[13px] font-medium text-content">
              {t('settings.defaultLayerPanelOpen')}
            </span>
            <button
              type="button"
              role="switch"
              aria-checked={defaultLayerPanelOpen}
              aria-label={t('settings.defaultLayerPanelOpen')}
              className={toggleTrackClass(defaultLayerPanelOpen)}
              onClick={() => onDefaultLayerPanelOpenChange(!defaultLayerPanelOpen)}
              data-testid="settings-default-layer-panel-open-toggle"
            >
              <span className={toggleKnobClass(defaultLayerPanelOpen)} />
            </button>
          </div>

          <div className={ROW_CLASS} data-testid="settings-max-keymap-history-row">
            <label htmlFor="settings-max-keymap-history-selector" className="text-[13px] font-medium text-content">
              {t('settings.maxKeymapHistory')}
            </label>
            <select
              id="settings-max-keymap-history-selector"
              value={maxKeymapHistory}
              onChange={(e) => onMaxKeymapHistoryChange(Number(e.target.value))}
              className="rounded border border-edge bg-surface px-2.5 py-1.5 text-[13px] text-content focus:border-accent focus:outline-none"
              data-testid="settings-max-keymap-history-selector"
            >
              {[10, 25, 50, 100, 200, 500].map((n) => (
                <option key={n} value={n}>{n}</option>
              ))}
            </select>
          </div>
        </div>
      </section>

      <section>
        <h4 className="mb-1 text-sm font-medium text-content-secondary">
          {t('settings.security')}
        </h4>
        <div className="flex flex-col gap-3">
          <div className={ROW_CLASS} data-testid="settings-auto-lock-time-row">
            <div className="flex flex-col gap-0.5">
              <label htmlFor="settings-auto-lock-time-selector" className="text-[13px] font-medium text-content">
                {t('settings.autoLockTime')}
              </label>
              <span className="text-xs text-content-muted">
                {t('settings.autoLockDescription')}
              </span>
            </div>
            <select
              id="settings-auto-lock-time-selector"
              value={autoLockTime}
              onChange={(e) => onAutoLockTimeChange(Number(e.target.value) as AutoLockMinutes)}
              className="rounded border border-edge bg-surface px-2.5 py-1.5 text-[13px] text-content focus:border-accent focus:outline-none"
              data-testid="settings-auto-lock-time-selector"
            >
              {TIME_STEPS.map((m) => (
                <option key={m} value={m}>
                  {t('settings.autoLockMinutes', { minutes: m })}
                </option>
              ))}
            </select>
          </div>
        </div>
      </section>
    </div>
    <KeyLabelsModal
      open={keyLabelsOpen}
      onClose={() => setKeyLabelsOpen(false)}
      currentDisplayName={hubDisplayName}
      hubCanWrite={hubCanWrite}
    />
    <LanguagePacksModal
      open={languagePacksOpen}
      onClose={() => setLanguagePacksOpen(false)}
      currentDisplayName={hubDisplayName}
      hubCanWrite={hubCanWrite}
    />
    <ThemePacksModal
      open={themePacksOpen}
      onClose={() => setThemePacksOpen(false)}
      onThemeChange={onThemeChange}
      hubCanWrite={hubCanWrite}
    />
    </>
  )
}
