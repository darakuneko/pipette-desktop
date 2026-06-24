// SPDX-License-Identifier: GPL-2.0-or-later

import { useState, useEffect, useCallback, useRef, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { useEscapeClose } from '../hooks/useEscapeClose'
import { useTypingTestTexts } from '../hooks/useTypingTestTexts'
import { ModalCloseButton } from '../components/editors/ModalCloseButton'
import { Check, Download, Trash2, Loader2, FileUp } from 'lucide-react'
import { ICON_SM } from '../constants/ui-tokens'
import type { LanguageListEntry } from '../../shared/types/language-store'
import type { TypingTestTextMeta } from '../../shared/types/typing-test-text-store'

type Tab = 'existing' | 'import'

/** Store error code → i18n key for the Import tab error line. Unlisted
 *  codes fall back to the generic importFailed message. */
const IMPORT_ERROR_KEYS: Record<string, string> = {
  NOT_UTF8: 'editor.typingTest.language.importErrorNotUtf8',
  TOO_LARGE: 'editor.typingTest.language.importErrorTooLarge',
  EMPTY_TEXT: 'editor.typingTest.language.importErrorEmpty',
}

interface Props {
  currentLanguage: string
  /** Active imported text id, when the current config is in custom mode. */
  currentCustomTextId?: string
  onSelectLanguage: (name: string) => void
  /** Called when an imported text is picked — switches to custom mode. */
  onSelectImport: (textId: string) => void
  /** Called on close when the currently-selected imported text was deleted
   *  (and nothing else was picked) so the caller can reset to the default. */
  onCurrentTextDeleted?: () => void
  onClose: () => void
}

function formatName(name: string): string {
  return name.replace(/_/g, ' ')
}

export function LanguageSelectorModal({
  currentLanguage,
  currentCustomTextId,
  onSelectLanguage,
  onSelectImport,
  onCurrentTextDeleted,
  onClose,
}: Props) {
  const { t } = useTranslation()
  const [tab, setTab] = useState<Tab>(currentCustomTextId ? 'import' : 'existing')
  const [languages, setLanguages] = useState<LanguageListEntry[]>([])
  const [search, setSearch] = useState('')
  const [downloading, setDownloading] = useState<Set<string>>(new Set())
  const backdropRef = useRef<HTMLDivElement>(null)
  const searchRef = useRef<HTMLInputElement>(null)
  // Flipped true when the currently-selected imported text is deleted, so a
  // plain close (Esc / backdrop / X — not an explicit pick) resets to default.
  const deletedCurrentRef = useRef(false)

  const handleClose = useCallback(() => {
    if (deletedCurrentRef.current) onCurrentTextDeleted?.()
    onClose()
  }, [onClose, onCurrentTextDeleted])

  useEscapeClose(handleClose)

  useEffect(() => {
    let alive = true
    window.vialAPI.langList().then((list) => {
      if (alive) setLanguages(list)
    }).catch(() => {})
    return () => { alive = false }
  }, [])

  useEffect(() => {
    if (tab === 'existing') searchRef.current?.focus()
  }, [tab])

  const handleBackdropClick = useCallback((e: React.MouseEvent) => {
    if (e.target === backdropRef.current) handleClose()
  }, [handleClose])

  const handleDownload = useCallback(async (name: string) => {
    setDownloading((s) => new Set(s).add(name))
    try {
      const result = await window.vialAPI.langDownload(name)
      if (result.success) {
        setLanguages((prev) =>
          prev.map((l) => (l.name === name ? { ...l, status: 'downloaded' as const } : l)),
        )
      }
    } finally {
      setDownloading((s) => {
        const next = new Set(s)
        next.delete(name)
        return next
      })
    }
  }, [])

  const handleDelete = useCallback(async (name: string) => {
    const result = await window.vialAPI.langDelete(name)
    if (result.success) {
      setLanguages((prev) =>
        prev.map((l) => (l.name === name ? { ...l, status: 'not-downloaded' as const } : l)),
      )
    }
  }, [])

  const handleSelect = useCallback((name: string) => {
    onSelectLanguage(name)
    onClose()
  }, [onSelectLanguage, onClose])

  const handleSelectImport = useCallback((id: string) => {
    onSelectImport(id)
    onClose()
  }, [onSelectImport, onClose])

  const filtered = useMemo(() => {
    if (!search) return languages
    const q = search.toLowerCase()
    return languages.filter((l) => formatName(l.name).toLowerCase().includes(q))
  }, [languages, search])

  const downloaded = useMemo(() => filtered.filter((l) => l.status !== 'not-downloaded'), [filtered])
  const available = useMemo(() => filtered.filter((l) => l.status === 'not-downloaded'), [filtered])

  return (
    <div
      ref={backdropRef}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
      role="dialog"
      onClick={handleBackdropClick}
    >
      <div className="flex h-modal-80vh w-modal-typing flex-col rounded-2xl border border-edge bg-surface shadow-xl">
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
            onClick={() => setTab('existing')}
          >
            {t('editor.typingTest.language.tabNormal')}
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'import'}
            data-testid="language-tab-import"
            className={`flex-1 px-4 py-2 text-sm font-medium transition-colors ${tab === 'import' ? 'border-b-2 border-accent text-accent' : 'text-content-secondary hover:text-content'}`}
            onClick={() => setTab('import')}
          >
            {t('editor.typingTest.language.tabCustom')}
          </button>
        </div>

        {tab === 'existing' ? (
          <>
            <div className="border-b border-edge px-4 py-2">
              <input
                ref={searchRef}
                type="text"
                className="w-full rounded-md border border-edge bg-surface-alt px-3 py-1.5 text-sm text-content placeholder:text-content-muted focus:border-accent focus:outline-none"
                placeholder={t('editor.typingTest.language.searchPlaceholder')}
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                data-testid="language-search"
              />
            </div>

            <div className="flex-1 overflow-y-auto">
              {filtered.length === 0 && (
                <p className="px-4 py-6 text-center text-sm text-content-muted">{t('editor.typingTest.language.noResults')}</p>
              )}

              {downloaded.length > 0 && (
                <div>
                  <div className="sticky top-0 bg-surface px-4 py-2 text-xs font-medium uppercase text-content-muted">
                    {t('editor.typingTest.language.downloaded')}
                  </div>
                  {downloaded.map((lang) => (
                    <LanguageRow
                      key={lang.name}
                      lang={lang}
                      isCurrent={!currentCustomTextId && lang.name === currentLanguage}
                      isDownloading={downloading.has(lang.name)}
                      onSelect={handleSelect}
                      onDelete={handleDelete}
                    />
                  ))}
                </div>
              )}

              {available.length > 0 && (
                <div>
                  <div className="sticky top-0 bg-surface px-4 py-2 text-xs font-medium uppercase text-content-muted">
                    {t('editor.typingTest.language.available')}
                  </div>
                  {available.map((lang) => (
                    <LanguageRow
                      key={lang.name}
                      lang={lang}
                      isCurrent={false}
                      isDownloading={downloading.has(lang.name)}
                      onSelect={handleSelect}
                      onDownload={handleDownload}
                    />
                  ))}
                </div>
              )}
            </div>
          </>
        ) : (
          <ImportTab
            currentCustomTextId={currentCustomTextId}
            onSelect={handleSelectImport}
            onDeleteCurrent={() => { deletedCurrentRef.current = true }}
          />
        )}
      </div>
    </div>
  )
}

interface ImportTabProps {
  currentCustomTextId?: string
  onSelect: (id: string) => void
  /** Fired when the currently-selected imported text is deleted. */
  onDeleteCurrent?: () => void
}

function ImportTab({ currentCustomTextId, onSelect, onDeleteCurrent }: ImportTabProps) {
  const { t } = useTranslation()
  const { metas, importFromFile, confirmImport, remove } = useTypingTestTexts()
  const [importing, setImporting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // Name of an import awaiting overwrite confirmation (null = none pending).
  const [overwriteName, setOverwriteName] = useState<string | null>(null)

  const handleRemove = useCallback(async (id: string) => {
    const result = await remove(id)
    if (result.success && id === currentCustomTextId) onDeleteCurrent?.()
    return result
  }, [remove, currentCustomTextId, onDeleteCurrent])

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
      </div>

      <div className="flex-1 overflow-y-auto">
        {metas.length === 0 ? (
          <p className="px-4 py-6 text-center text-sm text-content-muted">{t('editor.typingTest.language.importEmpty')}</p>
        ) : (
          metas.map((meta) => (
            <ImportRow
              key={meta.id}
              meta={meta}
              isCurrent={meta.id === currentCustomTextId}
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
      </div>
      <span className="shrink-0 text-xs text-content-muted">
        {t('editor.typingTest.language.words', { count: meta.wordCount })}
      </span>
      <button
        type="button"
        data-testid={`typing-text-delete-${meta.id}`}
        aria-label={t('common.delete')}
        className="shrink-0 rounded p-1 text-content-muted hover:text-danger"
        onClick={(e) => {
          e.stopPropagation()
          void onDelete(meta.id)
        }}
      >
        <Trash2 size={ICON_SM} aria-hidden="true" />
      </button>
    </div>
  )
}

interface LanguageRowProps {
  lang: LanguageListEntry
  isCurrent: boolean
  isDownloading: boolean
  onSelect: (name: string) => void
  onDownload?: (name: string) => void
  onDelete?: (name: string) => void
}

function LanguageRow({ lang, isCurrent, isDownloading, onSelect, onDownload, onDelete }: LanguageRowProps) {
  const { t } = useTranslation()
  const canSelect = lang.status !== 'not-downloaded'

  let rowStyle = ''
  if (isCurrent) {
    rowStyle = 'bg-accent/10'
  } else if (canSelect) {
    rowStyle = 'cursor-pointer hover:bg-surface-alt'
  }

  return (
    <div
      data-testid={`language-row-${lang.name}`}
      className={`flex items-center gap-2 px-4 py-2 text-sm transition-colors ${rowStyle}`}
      onClick={canSelect ? () => onSelect(lang.name) : undefined}
    >
      <div className="flex min-w-0 flex-1 items-center gap-2">
        {isCurrent && <Check size={ICON_SM} className="shrink-0 text-accent" aria-hidden="true" />}
        <span className={`truncate ${isCurrent ? 'font-semibold text-accent' : 'text-content'}`}>
          {formatName(lang.name)}
        </span>
        {lang.rightToLeft && (
          <span className="shrink-0 rounded bg-surface-alt px-1 py-0.5 text-2xs text-content-muted">RTL</span>
        )}
      </div>

      <span className="shrink-0 text-xs text-content-muted">
        {t('editor.typingTest.language.words', { count: lang.wordCount })}
      </span>

      {lang.status === 'not-downloaded' && onDownload && (
        <button
          type="button"
          data-testid={`language-download-${lang.name}`}
          className="shrink-0 rounded p-1 text-content-muted hover:text-accent"
          onClick={(e) => {
            e.stopPropagation()
            onDownload(lang.name)
          }}
          disabled={isDownloading}
        >
          {isDownloading ? (
            <Loader2 size={ICON_SM} className="animate-spin" aria-hidden="true" />
          ) : (
            <Download size={ICON_SM} aria-hidden="true" />
          )}
        </button>
      )}

      {lang.status === 'downloaded' && onDelete && (
        <button
          type="button"
          data-testid={`language-delete-${lang.name}`}
          className="shrink-0 rounded p-1 text-content-muted hover:text-danger"
          onClick={(e) => {
            e.stopPropagation()
            onDelete(lang.name)
          }}
        >
          <Trash2 size={ICON_SM} aria-hidden="true" />
        </button>
      )}
    </div>
  )
}
