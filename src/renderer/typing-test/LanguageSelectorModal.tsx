// SPDX-License-Identifier: GPL-2.0-or-later

import { useState, useEffect, useCallback, useRef, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { ModalCloseButton } from '../components/editors/ModalCloseButton'
import { Check, Download, Trash2, Loader2 } from 'lucide-react'
import type { LanguageListEntry } from '../../shared/types/language-store'

interface Props {
  currentLanguage: string
  onSelectLanguage: (name: string) => void
  onClose: () => void
}

function formatName(name: string): string {
  return name.replace(/_/g, ' ')
}

export function LanguageSelectorModal({ currentLanguage, onSelectLanguage, onClose }: Props) {
  const { t } = useTranslation()
  const [languages, setLanguages] = useState<LanguageListEntry[]>([])
  const [search, setSearch] = useState('')
  const [downloading, setDownloading] = useState<Set<string>>(new Set())
  const backdropRef = useRef<HTMLDivElement>(null)
  const searchRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    let alive = true
    window.vialAPI.langList().then((list) => {
      if (alive) setLanguages(list)
    }).catch(() => {})
    searchRef.current?.focus()
    return () => { alive = false }
  }, [])

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [onClose])

  const handleBackdropClick = useCallback((e: React.MouseEvent) => {
    if (e.target === backdropRef.current) onClose()
  }, [onClose])

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
      <div className="flex h-[80vh] w-[480px] flex-col rounded-xl border border-edge bg-surface shadow-2xl">
        <div className="flex items-center justify-between border-b border-edge px-4 py-3">
          <h2 className="text-lg font-semibold text-content">{t('editor.typingTest.language.title')}</h2>
          <ModalCloseButton testid="language-modal-close" onClick={onClose} />
        </div>

        <div className="border-b border-edge px-4 py-2">
          <input
            ref={searchRef}
            type="text"
            className="w-full rounded-md border border-edge bg-surface-alt px-3 py-1.5 text-sm text-content placeholder:text-content-muted"
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
                  isCurrent={lang.name === currentLanguage}
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
      </div>
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
        {isCurrent && <Check size={14} className="shrink-0 text-accent" aria-hidden="true" />}
        <span className={`truncate ${isCurrent ? 'font-semibold text-accent' : 'text-content'}`}>
          {formatName(lang.name)}
        </span>
        {lang.rightToLeft && (
          <span className="shrink-0 rounded bg-surface-alt px-1 py-0.5 text-[10px] text-content-muted">RTL</span>
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
            <Loader2 size={14} className="animate-spin" aria-hidden="true" />
          ) : (
            <Download size={14} aria-hidden="true" />
          )}
        </button>
      )}

      {lang.status === 'downloaded' && onDelete && (
        <button
          type="button"
          data-testid={`language-delete-${lang.name}`}
          className="shrink-0 rounded p-1 text-content-muted hover:text-red-500"
          onClick={(e) => {
            e.stopPropagation()
            onDelete(lang.name)
          }}
        >
          <Trash2 size={14} aria-hidden="true" />
        </button>
      )}
    </div>
  )
}
