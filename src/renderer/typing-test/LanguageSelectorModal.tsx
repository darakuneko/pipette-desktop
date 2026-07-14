// SPDX-License-Identifier: GPL-2.0-or-later

import { useState, useCallback, useEffect, useMemo, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { useEscapeClose } from '../hooks/useEscapeClose'
import { useTypingTestTexts } from '../hooks/useTypingTestTexts'
import { ModalCloseButton } from '../components/editors/ModalCloseButton'
import { MODAL_LG } from '../components/editors/store-modal-shared'
import { Check, Loader2, FileUp } from 'lucide-react'
import { ICON_SM } from '../constants/ui-tokens'
import { LanguagePackTab } from './LanguagePackTab'
import { AozoraCatalogTab } from './AozoraCatalogTab'
import { RowDeleteButton, RomajiBadge, RomajiFilterToggle } from './list-parts'
import type { TypingTestTextMeta } from '../../shared/types/typing-test-text-store'

type Tab = 'existing' | 'tatoeba' | 'import' | 'aozora'

/** Store error code → i18n key for the Import tab error line. Unlisted
 *  codes fall back to the generic importFailed message. */
const IMPORT_ERROR_KEYS: Record<string, string> = {
  NOT_UTF8: 'editor.typingTest.language.importErrorNotUtf8',
  TOO_LARGE: 'editor.typingTest.language.importErrorTooLarge',
  EMPTY_TEXT: 'editor.typingTest.language.importErrorEmpty',
}

interface Props {
  currentLanguage: string
  /** Active imported text id, when the current config is in fileImport mode. */
  currentFileImportTextId?: string
  /** Active tatoeba pack language, when the current config is in tatoeba mode. */
  currentTatoebaLanguage?: string
  onSelectLanguage: (name: string) => void
  /** Called when an imported text is picked — switches to fileImport mode. */
  onSelectImport: (textId: string) => void
  /** Called when a tatoeba pack is picked — switches to tatoeba mode. */
  onSelectTatoeba: (language: string) => void
  /** Called on close when the currently-selected imported text was deleted
   *  (and nothing else was picked) so the caller can reset to the default. */
  onCurrentTextDeleted?: () => void
  onClose: () => void
}

function initialTab(fileImportTextId?: string, tatoebaLanguage?: string): Tab {
  if (fileImportTextId) return 'import'
  if (tatoebaLanguage) return 'tatoeba'
  return 'existing'
}

export function LanguageSelectorModal({
  currentLanguage,
  currentFileImportTextId,
  currentTatoebaLanguage,
  onSelectLanguage,
  onSelectImport,
  onSelectTatoeba,
  onCurrentTextDeleted,
  onClose,
}: Props) {
  const { t } = useTranslation()
  const [tab, setTab] = useState<Tab>(() => initialTab(currentFileImportTextId, currentTatoebaLanguage))
  const backdropRef = useRef<HTMLDivElement>(null)
  // Flipped true when the currently-selected imported text is deleted, so a
  // plain close (Esc / backdrop / X — not an explicit pick) resets to default.
  const deletedCurrentRef = useRef(false)
  // Flipped true on the first manual tab click so the async initial-tab
  // correction below never overrides the user's own navigation.
  const userNavigatedRef = useRef(false)
  const { metas } = useTypingTestTexts()

  // `initialTab`'s 'import' guess is wrong for catalog-managed texts: they
  // are excluded from the File Import list (managed by their catalog tab),
  // so the current selection would look missing. Metas load async, so the
  // correction happens here once they resolve.
  useEffect(() => {
    if (userNavigatedRef.current || tab !== 'import' || !currentFileImportTextId) return
    const source = metas.find((m) => m.id === currentFileImportTextId)?.source
    if (source?.provider === 'aozora') setTab('aozora')
  }, [metas, tab, currentFileImportTextId])

  const selectTab = useCallback((next: Tab) => {
    userNavigatedRef.current = true
    setTab(next)
  }, [])

  const handleClose = useCallback(() => {
    if (deletedCurrentRef.current) onCurrentTextDeleted?.()
    onClose()
  }, [onClose, onCurrentTextDeleted])

  // Shared by both the Aozora and File Import tabs: only the deletion of the
  // currently-selected imported text should flip deletedCurrentRef, so the
  // current-or-not distinction lives here rather than in either tab.
  const handleTextDeleted = useCallback((id: string) => {
    if (id === currentFileImportTextId) deletedCurrentRef.current = true
  }, [currentFileImportTextId])

  useEscapeClose(handleClose)

  const handleBackdropClick = useCallback((e: React.MouseEvent) => {
    if (e.target === backdropRef.current) handleClose()
  }, [handleClose])

  const handleSelect = useCallback((name: string) => {
    onSelectLanguage(name)
    onClose()
  }, [onSelectLanguage, onClose])

  const handleSelectImport = useCallback((id: string) => {
    onSelectImport(id)
    onClose()
  }, [onSelectImport, onClose])

  const handleSelectTatoeba = useCallback((language: string) => {
    onSelectTatoeba(language)
    onClose()
  }, [onSelectTatoeba, onClose])

  return (
    <div
      ref={backdropRef}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
      role="dialog"
      onClick={handleBackdropClick}
    >
      <div className={`flex h-modal-80vh ${MODAL_LG} flex-col rounded-2xl border border-edge bg-surface shadow-xl`}>
        <div className="flex items-center justify-between border-b border-edge px-4 py-3">
          <h2 className="text-lg font-semibold text-content">{t('editor.typingTest.language.title')}</h2>
          <ModalCloseButton testid="language-modal-close" onClick={handleClose} />
        </div>

        <div className="flex border-b border-edge" role="tablist">
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'existing'}
            data-testid="language-tab-existing"
            className={`flex-1 px-4 py-2 text-sm font-medium transition-colors ${tab === 'existing' ? 'border-b-2 border-accent text-accent' : 'text-content-secondary hover:text-content'}`}
            onClick={() => selectTab('existing')}
          >
            {t('editor.typingTest.language.tabMonkeytype')}
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'tatoeba'}
            data-testid="language-tab-tatoeba"
            className={`flex-1 px-4 py-2 text-sm font-medium transition-colors ${tab === 'tatoeba' ? 'border-b-2 border-accent text-accent' : 'text-content-secondary hover:text-content'}`}
            onClick={() => selectTab('tatoeba')}
          >
            {t('editor.typingTest.language.tabTatoeba')}
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'aozora'}
            data-testid="language-tab-aozora"
            className={`flex-1 px-4 py-2 text-sm font-medium transition-colors ${tab === 'aozora' ? 'border-b-2 border-accent text-accent' : 'text-content-secondary hover:text-content'}`}
            onClick={() => selectTab('aozora')}
          >
            {t('editor.typingTest.language.tabAozora')}
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'import'}
            data-testid="language-tab-import"
            className={`flex-1 px-4 py-2 text-sm font-medium transition-colors ${tab === 'import' ? 'border-b-2 border-accent text-accent' : 'text-content-secondary hover:text-content'}`}
            onClick={() => selectTab('import')}
          >
            {t('editor.typingTest.language.tabFileImport')}
          </button>
        </div>

        {tab === 'existing' && (
          <LanguagePackTab
            provider="monkeytype"
            currentSelected={currentFileImportTextId || currentTatoebaLanguage ? undefined : currentLanguage}
            onSelect={handleSelect}
          />
        )}

        {tab === 'tatoeba' && (
          <LanguagePackTab
            provider="tatoeba"
            currentSelected={currentTatoebaLanguage}
            onSelect={handleSelectTatoeba}
          />
        )}

        {tab === 'aozora' && (
          <AozoraCatalogTab
            currentTextId={currentFileImportTextId}
            onSelect={handleSelectImport}
            onDeleted={handleTextDeleted}
          />
        )}

        {tab === 'import' && (
          <ImportTab
            currentFileImportTextId={currentFileImportTextId}
            onSelect={handleSelectImport}
            onDeleted={handleTextDeleted}
          />
        )}
      </div>
    </div>
  )
}

interface ImportTabProps {
  currentFileImportTextId?: string
  onSelect: (id: string) => void
  /** Fired with the text id whenever an imported text is deleted. */
  onDeleted?: (textId: string) => void
}

function ImportTab({ currentFileImportTextId, onSelect, onDeleted }: ImportTabProps) {
  const { t } = useTranslation()
  const { metas, importFromFile, confirmImport, remove } = useTypingTestTexts()
  const [importing, setImporting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [romajiOnly, setRomajiOnly] = useState(false)
  // Name of an import awaiting overwrite confirmation (null = none pending).
  const [overwriteName, setOverwriteName] = useState<string | null>(null)

  // Catalog-managed texts (e.g. Aozora Bunko imports) are listed and
  // deleted from their own catalog tab, not here. Excluded by the
  // presence of `source` rather than a specific provider name, so any
  // future catalog provider is excluded the same way.
  const fileImportMetas = useMemo(() => metas.filter((meta) => !meta.source), [metas])
  const visibleMetas = useMemo(
    () => (romajiOnly ? fileImportMetas.filter((meta) => meta.romajiCapable === true) : fileImportMetas),
    [fileImportMetas, romajiOnly],
  )

  const handleRemove = useCallback(async (id: string) => {
    // Optimistic: report before the IPC round-trip so closing the modal
    // mid-delete still resets a deleted current text. A failed delete turns
    // the reset into a harmless no-op rather than leaving the config
    // pointing at a tombstoned text.
    onDeleted?.(id)
    return remove(id)
  }, [remove, onDeleted])

  const handleImport = useCallback(async () => {
    setImporting(true)
    setError(null)
    setOverwriteName(null)
    try {
      const result = await importFromFile()
      // A name collision is held for confirmation, not surfaced as an error.
      if (!result.success && result.errorCode === 'DUPLICATE_NAME') {
        setOverwriteName(result.error ?? '')
        return
      }
      // 'cancelled' is a user no-op, not an error worth surfacing.
      if (!result.success && result.error !== 'cancelled') {
        const key = IMPORT_ERROR_KEYS[result.errorCode ?? ''] ?? 'editor.typingTest.language.importFailed'
        setError(t(key))
      }
    } finally {
      setImporting(false)
    }
  }, [importFromFile, t])

  const handleConfirmOverwrite = useCallback(async () => {
    setOverwriteName(null)
    const result = await confirmImport()
    if (!result.success) {
      const key = IMPORT_ERROR_KEYS[result.errorCode ?? ''] ?? 'editor.typingTest.language.importFailed'
      setError(t(key))
    }
  }, [confirmImport, t])

  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      <div className="border-b border-edge px-4 py-2">
        {overwriteName !== null ? (
          <div className="flex flex-col items-center gap-2" data-testid="typing-text-import-overwrite">
            <p className="text-center text-sm text-content-secondary">
              {t('editor.typingTest.language.importOverwritePrompt', { name: overwriteName })}
            </p>
            <div className="flex items-center gap-2">
              <button
                type="button"
                data-testid="typing-text-import-overwrite-confirm"
                className="rounded-md border border-danger px-3 py-1 text-sm text-danger transition-colors hover:bg-danger/10"
                onClick={handleConfirmOverwrite}
              >
                {t('editor.typingTest.language.confirmOverwrite')}
              </button>
              <button
                type="button"
                data-testid="typing-text-import-overwrite-cancel"
                className="rounded-md border border-edge px-3 py-1 text-sm text-content-secondary transition-colors hover:text-content"
                onClick={() => setOverwriteName(null)}
              >
                {t('common.cancel')}
              </button>
            </div>
          </div>
        ) : (
          <button
            type="button"
            data-testid="typing-text-import"
            className="flex w-full items-center justify-center gap-2 rounded-md border border-edge px-3 py-1.5 text-sm text-content-secondary transition-colors hover:text-accent disabled:opacity-50"
            onClick={handleImport}
            disabled={importing}
          >
            {importing ? (
              <Loader2 size={ICON_SM} className="animate-spin" aria-hidden="true" />
            ) : (
              <FileUp size={ICON_SM} aria-hidden="true" />
            )}
            <span>{t('editor.typingTest.language.import')}</span>
          </button>
        )}
        {error && (
          <p className="mt-1 text-center text-xs text-danger" data-testid="typing-text-import-error">{error}</p>
        )}
        <div className="mt-2 flex flex-wrap items-center gap-1">
          <RomajiFilterToggle active={romajiOnly} onToggle={() => setRomajiOnly((v) => !v)} />
        </div>
      </div>

      <div className="flex-1 overflow-y-auto">
        {visibleMetas.length === 0 ? (
          <p className="px-4 py-6 text-center text-sm text-content-muted">{t('editor.typingTest.language.importEmpty')}</p>
        ) : (
          visibleMetas.map((meta) => (
            <ImportRow
              key={meta.id}
              meta={meta}
              isCurrent={meta.id === currentFileImportTextId}
              onSelect={onSelect}
              onDelete={handleRemove}
            />
          ))
        )}
      </div>
    </div>
  )
}

interface ImportRowProps {
  meta: TypingTestTextMeta
  isCurrent: boolean
  onSelect: (id: string) => void
  onDelete: (id: string) => Promise<unknown>
}

function ImportRow({ meta, isCurrent, onSelect, onDelete }: ImportRowProps) {
  const { t } = useTranslation()
  return (
    <div
      data-testid={`typing-text-row-${meta.id}`}
      className={`flex items-center gap-2 px-4 py-2 text-sm transition-colors ${isCurrent ? 'bg-accent/10' : 'cursor-pointer hover:bg-surface-alt'}`}
      onClick={() => onSelect(meta.id)}
    >
      <div className="flex min-w-0 flex-1 items-center gap-2">
        {isCurrent && <Check size={ICON_SM} className="shrink-0 text-accent" aria-hidden="true" />}
        <span className={`truncate ${isCurrent ? 'font-semibold text-accent' : 'text-content'}`}>{meta.name}</span>
        {meta.romajiCapable === true && <RomajiBadge />}
      </div>
      <span className="shrink-0 text-xs text-content-muted">
        {t('editor.typingTest.language.words', { count: meta.wordCount })}
      </span>
      <RowDeleteButton testId={`typing-text-delete-${meta.id}`} onClick={() => { void onDelete(meta.id) }} />
    </div>
  )
}

