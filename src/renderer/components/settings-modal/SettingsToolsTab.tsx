// SPDX-License-Identifier: GPL-2.0-or-later

import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { THEME_OPTIONS, TIME_STEPS } from './settings-modal-shared'
import { ROW_CLASS, toggleTrackClass, toggleKnobClass } from '../editors/modal-controls'
import { KEYBOARD_LAYOUTS } from '../../data/keyboard-layouts'
import { useAppConfig } from '../../hooks/useAppConfig'
import i18n, { SUPPORTED_LANGUAGES } from '../../i18n'
import { useKeyLabels } from '../../hooks/useKeyLabels'
import { KeyLabelsModal } from '../key-labels/KeyLabelsModal'
import type { ThemeMode } from '../../hooks/useTheme'
import type { KeyboardLayoutId, AutoLockMinutes } from '../../hooks/useDevicePrefs'
import type { BasicViewType, SplitKeyMode } from '../../../shared/types/app-config'

export interface SettingsToolsTabProps {
  theme: ThemeMode
  onThemeChange: (mode: ThemeMode) => void
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
  const keyLabels = useKeyLabels()

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
        <h4 className="mb-2 text-sm font-medium text-content-secondary">
          {t('theme.label')}
        </h4>
        <div className="flex rounded-lg border border-edge bg-surface p-1 gap-0.5">
          {THEME_OPTIONS.map(({ mode, icon: Icon }) => (
            <button
              key={mode}
              type="button"
              className={`flex flex-1 items-center justify-center gap-1.5 rounded-md px-3 py-2 text-sm font-medium transition-colors ${
                theme === mode
                  ? 'bg-accent/15 text-accent'
                  : 'text-content-secondary hover:text-content'
              }`}
              onClick={() => onThemeChange(mode)}
              data-testid={`theme-option-${mode}`}
            >
              <Icon size={16} aria-hidden="true" />
              {t(`theme.${mode}`)}
            </button>
          ))}
        </div>
      </section>

      <section>
        <div className="grid grid-cols-2 gap-3">
          <div className={ROW_CLASS} data-testid="settings-language-row">
            <label htmlFor="settings-language-selector" className="text-sm font-medium text-content-secondary">
              {t('settings.language')}
            </label>
            <select
              id="settings-language-selector"
              value={appConfig.config.language ?? 'en'}
              onChange={(e) => {
                appConfig.set('language', e.target.value)
                void i18n.changeLanguage(e.target.value)
              }}
              className="rounded border border-edge bg-surface px-2.5 py-1.5 text-[13px] text-content focus:border-accent focus:outline-none"
              data-testid="settings-language-selector"
            >
              {SUPPORTED_LANGUAGES.map((lang) => (
                <option key={lang.id} value={lang.id}>
                  {lang.name}
                </option>
              ))}
            </select>
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
    </>
  )
}
