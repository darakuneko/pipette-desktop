// SPDX-License-Identifier: GPL-2.0-or-later

import { useState, useEffect, useCallback, useRef, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { Check, Download, Trash2, Loader2 } from 'lucide-react'
import { ICON_SM } from '../constants/ui-tokens'
import { clearTatoebaPackCache } from './word-generator'
import { useTypingDatasetUpdate } from './useTypingDatasetUpdate'
import { DatasetUpdateBanner } from './DatasetUpdateBanner'
import type { LanguageListEntry } from '../../shared/types/language-store'

function formatName(name: string): string {
  return name.replace(/_/g, ' ')
}

interface Props {
  /** Dataset provider whose packs this tab lists (e.g. 'monkeytype', 'tatoeba'). */
  provider: string
  /** Name of the pack currently in use for this provider, highlighted with a
   *  check. `undefined` when another mode/provider is active. */
  currentSelected?: string
  onSelect: (name: string) => void
}

/**
 * A provider's downloadable language/sentence packs: search + a session-cached
 * "update available" banner + the downloaded/available lists with per-row
 * download / delete. Shared verbatim by the MonkeyType and Tatoeba tabs; only
 * one tab is mounted at a time, so the test ids are intentionally identical
 * across providers.
 */
export function LanguagePackTab({ provider, currentSelected, onSelect }: Props) {
  const { t } = useTranslation()
  const [languages, setLanguages] = useState<LanguageListEntry[]>([])
  const [search, setSearch] = useState('')
  const [downloading, setDownloading] = useState<Set<string>>(new Set())
  const { updateAvailable, updating, applyUpdate } = useTypingDatasetUpdate(provider)
  const searchRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    let alive = true
    window.vialAPI.langList(provider).then((list) => {
      if (alive) setLanguages(list)
    }).catch(() => {})
    return () => { alive = false }
  }, [provider])

  useEffect(() => { searchRef.current?.focus() }, [])

  const handleUpdateDataset = useCallback(async () => {
    const changed = await applyUpdate()
    if (changed) {
      // The update dropped the old downloaded files; forget any cached packs
      // so the session doesn't keep playing stale sentences.
      if (provider === 'tatoeba') clearTatoebaPackCache()
      // The manifest may have new/changed languages; refresh the list.
      const list = await window.vialAPI.langList(provider)
      setLanguages(list)
    }
    // On `changed:false` (Hub unreachable / invalid payload) the update was
    // NOT applied — keep the banner so the user can retry.
  }, [applyUpdate, provider])

  const handleDownload = useCallback(async (name: string) => {
    setDownloading((s) => new Set(s).add(name))
    try {
      const result = await window.vialAPI.langDownload(name, provider)
      if (result.success) {
        // Re-downloading replaces the file on disk; drop any cached copy.
        if (provider === 'tatoeba') clearTatoebaPackCache(name)
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
  }, [provider])

  const handleDelete = useCallback(async (name: string) => {
    const result = await window.vialAPI.langDelete(name, provider)
    if (result.success) {
      // The file is gone; forget any cached copy so it can't still be played.
      if (provider === 'tatoeba') clearTatoebaPackCache(name)
      setLanguages((prev) =>
        prev.map((l) => (l.name === name ? { ...l, status: 'not-downloaded' as const } : l)),
      )
    }
  }, [provider])

  const filtered = useMemo(() => {
    if (!search) return languages
    const q = search.toLowerCase()
    return languages.filter((l) => formatName(l.name).toLowerCase().includes(q))
  }, [languages, search])

  const downloaded = useMemo(() => filtered.filter((l) => l.status !== 'not-downloaded'), [filtered])
  const available = useMemo(() => filtered.filter((l) => l.status === 'not-downloaded'), [filtered])

  return (
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

      <DatasetUpdateBanner updateAvailable={updateAvailable} updating={updating} onUpdate={handleUpdateDataset} />

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
                isCurrent={lang.name === currentSelected}
                isDownloading={downloading.has(lang.name)}
                onSelect={onSelect}
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
                onSelect={onSelect}
                onDownload={handleDownload}
              />
            ))}
          </div>
        )}
      </div>
    </>
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
