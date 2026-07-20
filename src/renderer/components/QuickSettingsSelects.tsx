// SPDX-License-Identifier: GPL-2.0-or-later

import { useCallback, useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { LanguagePacksModal } from './i18n-packs/LanguagePacksModal'
import { ThemePacksModal } from './theme-packs/ThemePacksModal'
import { KeyLabelsModal } from './key-labels/KeyLabelsModal'
import { UpwardSelect, type UpwardSelectOption } from './UpwardSelect'
import { useAppConfig } from '../hooks/useAppConfig'
import { useI18nPackStore } from '../hooks/useI18nPackStore'
import { useThemePackStore } from '../hooks/useThemePackStore'
import { useKeyLabels } from '../hooks/useKeyLabels'
import { useKeyLabelLookup, type UseKeyLabelLookupReturn } from '../hooks/useKeyLabelLookup'
import { useLanguageOptions } from '../hooks/useLanguageOptions'
import { useLayoutOptions } from '../hooks/useLayoutOptions'
import { LAYOUT_BY_ID } from '../data/keyboard-layouts'
import { buildKeymapRewriteTable } from '../../shared/keymap/keymap-apply'
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
  /** Plain display switch (Plan-qwerty-select-no-rewrite v7): the select
   *  never opens the Rewrite confirm modal itself anymore — that lives on
   *  `KeymapEditor`'s simulation tab Apply button instead. Callers
   *  typically pass `useKeymapApplyPrompt().handleKeyboardLayoutChange`
   *  straight through. */
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

  const keyLabelLookup = useKeyLabelLookup()

  const languageOptions = useLanguageOptions(i18nPacks.metas)
  const layoutOptions = useLayoutOptions(keyLabels.metas)

  // Kick off a lazy fetch for every pack the select can currently show,
  // mirroring KeyLabelsModal's own `ensure` sweep over `labels.metas`.
  // `ensure` is a no-op for ids already cached/known-missing/built-in, so
  // re-running this whenever the option list or lookup identity changes
  // is cheap. Gated on the select actually being rendered (device
  // connected) so the footer bar doesn't fetch every pack before a
  // keyboard is even selected.
  useEffect(() => {
    if (keyboardLayout == null || !onKeyboardLayoutChange) return
    layoutOptions.forEach((o) => { void keyLabelLookup.ensure(o.id) })
  }, [keyboardLayout, onKeyboardLayoutChange, layoutOptions, keyLabelLookup])

  // Right-hand "Write"/"View" tag per pack — same
  // `keymapApplicable && buildKeymapRewriteTable(map).ok` predicate
  // KeyLabelsModal.isKeymapWritable uses, so a pack never disagrees with
  // itself between the modal and this footer select. The built-in QWERTY
  // baseline gets no tag at all (neutral default, nothing to compare it
  // against). A pack whose entry has not resolved yet also gets no tag —
  // showing "View" first and flipping to "Write" once the fetch lands
  // would read as the wrong answer flashing by; showing nothing until
  // resolved is the less jumpy of the two options the pack list has to
  // pick from.
  const layoutOptionsWithTags = useMemo<UpwardSelectOption[]>(
    () => layoutOptions.map((o) => ({ ...o, tag: keyLabelTag(o.id, keyLabelLookup, t) })),
    [layoutOptions, keyLabelLookup, t],
  )

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

  const closeModal = useCallback(() => setActiveModal(null), [])

  const currentLanguage = appConfig.config.language ?? 'builtin:en'
  const currentTheme = appConfig.config.theme ?? 'system'

  return (
    <>
      <div className="flex items-center gap-2">
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
                options={layoutOptionsWithTags}
                onChange={onKeyboardLayoutChange}
              />
            )}
          </>
        )}
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
      </div>
      <LanguagePacksModal
        open={activeModal === 'language'}
        onClose={closeModal}
        currentDisplayName={hubDisplayName}
        hubCanWrite={hubCanWrite}
      />
      <ThemePacksModal
        open={activeModal === 'theme'}
        onClose={closeModal}
        onThemeChange={onThemeChange}
        currentDisplayName={hubDisplayName}
        hubCanWrite={hubCanWrite}
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

/**
 * Resolves the right-aligned "Write"/"View" tag for one Keyboard Layout
 * option. Returns `undefined` (no tag) for the built-in QWERTY baseline
 * and for any pack whose entry has not been fetched yet — see the
 * `layoutOptionsWithTags` comment above for why "not yet resolved" stays
 * blank instead of showing a placeholder that might flip once the pack
 * loads.
 */
function keyLabelTag(
  id: string,
  lookup: UseKeyLabelLookupReturn,
  t: (key: string) => string,
): UpwardSelectOption['tag'] {
  if (LAYOUT_BY_ID.has(id)) return undefined
  const map = lookup.getMap(id)
  if (!map) return undefined
  const writable = lookup.getKeymapApplicable(id) && buildKeymapRewriteTable(map).ok
  return writable
    ? { label: t('keyLabels.typeKeymapWriteShort'), variant: 'accent' }
    : { label: t('keyLabels.typeViewOnlyShort'), variant: 'secondary' }
}
