// SPDX-License-Identifier: GPL-2.0-or-later

import { useCallback, useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { TIME_STEPS } from './settings-modal-shared'
import { ROW_CLASS, SettingsToggleRow } from '../editors/modal-controls'
import { useAppConfig } from '../../hooks/useAppConfig'
import { useKeyLabels } from '../../hooks/useKeyLabels'
import { useI18nPackStore } from '../../hooks/useI18nPackStore'
import { useThemePackStore } from '../../hooks/useThemePackStore'
import { useLayoutOptions } from '../../hooks/useLayoutOptions'
import { useLanguageOptions } from '../../hooks/useLanguageOptions'
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

  const commitZoomValue = useCallback((val: string) => {
    const raw = Number(val)
    if (Number.isNaN(raw)) {
      setZoomInput(String(appConfig.config.zoomFactor ?? ZOOM_FACTOR_DEFAULT))
      return
    }
    const clamped = clampZoomFactor(raw)
    setZoomInput(String(clamped))
    if (clamped !== (appConfig.config.zoomFactor ?? ZOOM_FACTOR_DEFAULT)) {
      appConfig.set('zoomFactor', clamped)
    }
  }, [appConfig])

  const commitZoom = useCallback(() => {
    commitZoomValue(zoomInput)
  }, [zoomInput, commitZoomValue])

  const activeThemeName = useMemo(() => {
    if (isPackTheme(theme)) {
      const packId = extractPackId(theme)
      const meta = themePacks.metas.find((m) => m.id === packId)
      return meta?.name ?? packId
    }
    return t(`theme.${theme}`)
  }, [theme, themePacks.metas, t])

  const languageOptions = useLanguageOptions(i18nPacks.metas)

  /**
   * Default-layout dropdown options. QWERTY is materialised as a Key
   * Label store entry by `ensureQwertyEntry`, so iterating `metas`
   * first preserves the user-controlled drag order from the Key
   * Labels modal. `KEYBOARD_LAYOUTS` only serves as a safety net for
   * the brief window before `metas` has loaded.
   */
  const layoutOptions = useLayoutOptions(keyLabels.metas)

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
                className="text-sm text-content"
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
                className="rounded border border-edge bg-surface px-2.5 py-1.5 text-sm text-content hover:bg-surface-hover focus:border-accent focus:outline-none"
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
              className="rounded border border-edge bg-surface px-2.5 py-1.5 text-sm text-content hover:bg-surface-hover focus:border-accent focus:outline-none"
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
                className="text-sm text-content"
                data-testid="settings-theme-pack-active-name"
              >
                {activeThemeName}
              </span>
              <button
                type="button"
                onClick={() => setThemePacksOpen(true)}
                className="rounded border border-edge bg-surface px-2.5 py-1.5 text-sm text-content hover:bg-surface-hover focus:border-accent focus:outline-none"
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
                onChange={(e) => {
                  const val = e.target.value
                  setZoomInput(val)
                  // Spin-button clicks have empty inputType in Chromium
                  if (!(e.nativeEvent as InputEvent).inputType) commitZoomValue(val)
                }}
                onBlur={commitZoom}
                onKeyDown={(e) => { if (e.key === 'Enter') commitZoom() }}
                className="zoom-factor-input w-20 rounded border border-edge bg-surface px-2.5 py-1.5 text-sm text-content text-right tabular-nums hover:bg-surface-hover focus:border-accent focus:outline-none"
                data-testid="settings-zoom-factor-input"
              />
              <span className="text-sm text-content-muted">%</span>
            </div>
          </div>

          <SettingsToggleRow
            rowTestId="settings-auto-launch-row"
            toggleTestId="settings-auto-launch-toggle"
            label={t('settings.autoLaunch')}
            description={t('settings.autoLaunchDescription')}
            on={appConfig.config.autoLaunch ?? false}
            onToggle={() => appConfig.set('autoLaunch', !(appConfig.config.autoLaunch ?? false))}
          />

          <SettingsToggleRow
            rowTestId="settings-tray-resident-row"
            toggleTestId="settings-tray-resident-toggle"
            label={t('settings.trayResident')}
            description={t('settings.trayResidentDescription')}
            on={appConfig.config.trayResident ?? false}
            onToggle={() => {
              const next = !(appConfig.config.trayResident ?? false)
              appConfig.set('trayResident', next)
              // A hidden window with no tray icon to reopen it would be
              // unreachable, so turning tray residency off also clears
              // startInTray when it was on.
              if (!next && (appConfig.config.startInTray ?? false)) {
                appConfig.set('startInTray', false)
              }
            }}
          />

          <SettingsToggleRow
            rowTestId="settings-restore-last-session-row"
            toggleTestId="settings-restore-last-session-toggle"
            label={t('settings.restoreLastSession')}
            description={t('settings.restoreLastSessionDescription')}
            on={appConfig.config.restoreLastSession ?? true}
            onToggle={() => appConfig.set('restoreLastSession', !(appConfig.config.restoreLastSession ?? true))}
          />

          <SettingsToggleRow
            rowTestId="settings-start-in-tray-row"
            toggleTestId="settings-start-in-tray-toggle"
            label={t('settings.startInTray')}
            description={t('settings.startInTrayDescription')}
            on={appConfig.config.startInTray ?? false}
            onToggle={() => appConfig.set('startInTray', !(appConfig.config.startInTray ?? false))}
            disabled={!(appConfig.config.trayResident ?? false)}
          />
        </div>
      </section>

      <section>
        <h4 className="mb-1 text-sm font-medium text-content-secondary">
          {t('settings.defaults')}
        </h4>
        <div className="grid grid-cols-2 gap-3">
          <div className={ROW_CLASS} data-testid="settings-default-basic-view-type-row">
            <label htmlFor="settings-default-basic-view-type-selector" className="text-sm font-medium text-content">
              {t('settings.defaultBasicViewType')}
            </label>
            <select
              id="settings-default-basic-view-type-selector"
              value={defaultBasicViewType}
              onChange={(e) => onDefaultBasicViewTypeChange(e.target.value as BasicViewType)}
              className="rounded border border-edge bg-surface px-2.5 py-1.5 text-sm text-content focus:border-accent focus:outline-none"
              data-testid="settings-default-basic-view-type-selector"
            >
              <option value="ansi">{t('settings.basicViewTypeAnsi')}</option>
              <option value="iso">{t('settings.basicViewTypeIso')}</option>
              <option value="jis">{t('settings.basicViewTypeJis')}</option>
              <option value="list">{t('settings.basicViewTypeList')}</option>
            </select>
          </div>

          <div className={ROW_CLASS} data-testid="settings-default-layout-row">
            <label htmlFor="settings-default-layout-selector" className="text-sm font-medium text-content">
              {t('settings.defaultLayout')}
            </label>
            <select
              id="settings-default-layout-selector"
              value={defaultLayout}
              onChange={(e) => onDefaultLayoutChange(e.target.value as KeyboardLayoutId)}
              className="rounded border border-edge bg-surface px-2.5 py-1.5 text-sm text-content focus:border-accent focus:outline-none"
              data-testid="settings-default-layout-selector"
            >
              {layoutOptions.map((layoutDef) => (
                <option key={layoutDef.id} value={layoutDef.id}>
                  {layoutDef.name}
                </option>
              ))}
            </select>
          </div>

          <SettingsToggleRow
            rowTestId="settings-default-auto-advance-row"
            toggleTestId="settings-default-auto-advance-toggle"
            label={t('settings.defaultAutoAdvance')}
            labelTone="content"
            on={defaultAutoAdvance}
            onToggle={() => onDefaultAutoAdvanceChange(!defaultAutoAdvance)}
          />

          <SettingsToggleRow
            rowTestId="settings-default-split-key-mode-row"
            toggleTestId="settings-default-split-key-mode-toggle"
            label={t('settings.defaultSplitKeyMode')}
            labelTone="content"
            on={defaultSplitKeyMode === 'split'}
            onToggle={() => onDefaultSplitKeyModeChange(defaultSplitKeyMode === 'split' ? 'flat' : 'split')}
          />

          <SettingsToggleRow
            rowTestId="settings-default-quick-select-row"
            toggleTestId="settings-default-quick-select-toggle"
            label={t('settings.defaultQuickSelect')}
            labelTone="content"
            on={defaultQuickSelect}
            onToggle={() => onDefaultQuickSelectChange(!defaultQuickSelect)}
          />

          <SettingsToggleRow
            rowTestId="settings-default-layer-panel-open-row"
            toggleTestId="settings-default-layer-panel-open-toggle"
            label={t('settings.defaultLayerPanelOpen')}
            labelTone="content"
            on={defaultLayerPanelOpen}
            onToggle={() => onDefaultLayerPanelOpenChange(!defaultLayerPanelOpen)}
          />

          <div className={ROW_CLASS} data-testid="settings-max-keymap-history-row">
            <label htmlFor="settings-max-keymap-history-selector" className="text-sm font-medium text-content">
              {t('settings.maxKeymapHistory')}
            </label>
            <select
              id="settings-max-keymap-history-selector"
              value={maxKeymapHistory}
              onChange={(e) => onMaxKeymapHistoryChange(Number(e.target.value))}
              className="rounded border border-edge bg-surface px-2.5 py-1.5 text-sm text-content focus:border-accent focus:outline-none"
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
              <label htmlFor="settings-auto-lock-time-selector" className="text-sm font-medium text-content">
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
              className="rounded border border-edge bg-surface px-2.5 py-1.5 text-sm text-content focus:border-accent focus:outline-none"
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
