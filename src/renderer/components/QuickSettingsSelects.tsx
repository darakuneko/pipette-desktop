// SPDX-License-Identifier: GPL-2.0-or-later

import { useCallback, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { LanguagePacksModal } from './i18n-packs/LanguagePacksModal'
import { ThemePacksModal } from './theme-packs/ThemePacksModal'
import { KeyLabelsModal } from './key-labels/KeyLabelsModal'
import { UpwardSelect } from './UpwardSelect'
import { useAppConfig } from '../hooks/useAppConfig'
import { useI18nPackStore } from '../hooks/useI18nPackStore'
import { useThemePackStore } from '../hooks/useThemePackStore'
import { useKeyLabels } from '../hooks/useKeyLabels'
import { useLanguageOptions } from '../hooks/useLanguageOptions'
import { useLayoutOptions } from '../hooks/useLayoutOptions'
import type { ThemeSelection } from '../hooks/useTheme'
import type { KeyboardLayoutId } from '../hooks/useKeyboardLayout'

const BUTTON_CLASS =
  'flex items-center justify-center rounded border border-edge px-2.5 py-1 text-xs leading-none text-content-secondary transition-colors hover:text-content focus:border-accent focus:outline-none'

type ActiveModal = 'language' | 'theme' | 'keyLabels' | null

export interface QuickSettingsSelectsProps {
  onThemeChange: (t: ThemeSelection) => void
  hubDisplayName?: string | null
  hubCanWrite?: boolean
  keyboardLayout?: KeyboardLayoutId
  onKeyboardLayoutChange?: (layout: KeyboardLayoutId) => void
}

export function QuickSettingsSelects({
  onThemeChange,
  hubDisplayName = null,
  hubCanWrite = false,
  keyboardLayout,
  onKeyboardLayoutChange,
}: QuickSettingsSelectsProps) {
  const { t, i18n } = useTranslation()
  const appConfig = useAppConfig()
  const i18nPacks = useI18nPackStore()
  const themePacks = useThemePackStore()
  const keyLabels = useKeyLabels()

  const [editMode, setEditMode] = useState(false)
  const [activeModal, setActiveModal] = useState<ActiveModal>(null)

  const languageOptions = useLanguageOptions(i18nPacks.metas)
  const layoutOptions = useLayoutOptions(keyLabels.metas)

  const themeOptions = useMemo(() => {
    const opts: { id: string; name: string }[] = [
      { id: 'system', name: t('theme.system') },
      { id: 'light', name: t('theme.light') },
      { id: 'dark', name: t('theme.dark') },
    ]
    for (const meta of themePacks.metas) {
      if (meta.deletedAt) continue
      opts.push({ id: `pack:${meta.id}`, name: meta.name })
    }
    return opts
  }, [themePacks.metas, i18n.language])

  const handleLanguageChange = useCallback((id: string) => {
    appConfig.set('language', id)
    void i18n.changeLanguage(id)
  }, [appConfig, i18n])

  const handleThemeChange = useCallback((v: string) => {
    onThemeChange(v as ThemeSelection)
  }, [onThemeChange])

  const handleKeyboardLayoutChange = useCallback((v: string) => {
    onKeyboardLayoutChange?.(v as KeyboardLayoutId)
  }, [onKeyboardLayoutChange])

  const closeModal = useCallback(() => setActiveModal(null), [])

  const currentLanguage = appConfig.config.language ?? 'builtin:en'
  const currentTheme = appConfig.config.theme ?? 'system'

  return (
    <>
      <div className="flex items-center gap-2">
        <button
          type="button"
          className={`flex items-center justify-center rounded border px-2.5 py-1 text-xs leading-none transition-colors focus:outline-none ${
            editMode
              ? 'border-accent text-accent'
              : 'border-edge text-content-secondary hover:text-content'
          }`}
          onClick={() => setEditMode((v) => !v)}
        >
          {editMode ? t('common.done') : t('common.edit')}
        </button>

        {editMode ? (
          <>
            <button type="button" className={BUTTON_CLASS} onClick={() => setActiveModal('language')}>
              {t('i18n.modalTitle')}
            </button>
            <button type="button" className={BUTTON_CLASS} onClick={() => setActiveModal('theme')}>
              {t('themePacks.title')}
            </button>
            <button type="button" className={BUTTON_CLASS} onClick={() => setActiveModal('keyLabels')}>
              {t('keyLabels.title')}
            </button>
          </>
        ) : (
          <>
            <UpwardSelect
              aria-label={t('i18n.modalTitle')}
              value={currentLanguage}
              options={languageOptions}
              onChange={handleLanguageChange}
            />
            <UpwardSelect
              aria-label={t('themePacks.title')}
              value={currentTheme}
              options={themeOptions}
              onChange={handleThemeChange}
            />
            {keyboardLayout != null && onKeyboardLayoutChange && (
              <UpwardSelect
                aria-label={t('keyLabels.title')}
                value={keyboardLayout}
                options={layoutOptions}
                onChange={handleKeyboardLayoutChange}
              />
            )}
          </>
        )}
      </div>
      <LanguagePacksModal open={activeModal === 'language'} onClose={closeModal} />
      <ThemePacksModal
        open={activeModal === 'theme'}
        onClose={closeModal}
        onThemeChange={onThemeChange}
      />
      <KeyLabelsModal
        open={activeModal === 'keyLabels'}
        onClose={closeModal}
        currentDisplayName={hubDisplayName}
        hubCanWrite={hubCanWrite}
      />
    </>
  )
}
