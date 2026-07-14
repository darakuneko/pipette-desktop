// SPDX-License-Identifier: GPL-2.0-or-later
//
// Aozora Bunko catalog browser: search-first UI over the 10,468-entry
// catalog manifest (rendered incrementally — see PAGE_SIZE), split into
// Imported / Available sections like LanguagePackTab's downloaded/available
// packs. Picking an unimported work downloads + cleans it into the
// typing-test-texts store; an already-imported work is just selected like
// any other fileImport text, and can be deleted back into Available.

import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { Check, Download, Loader2 } from 'lucide-react'
import { ICON_SM } from '../constants/ui-tokens'
import { useTypingTestTexts } from '../hooks/useTypingTestTexts'
import { useTypingDatasetUpdate } from './useTypingDatasetUpdate'
import { DatasetUpdateBanner } from './DatasetUpdateBanner'
import { SectionHeader, RowDeleteButton, RomajiBadge } from './list-parts'
import { KANA_ROWS, KANA_ROW_COLUMNS, KANA_COLUMN_TO_ROW, normalizeKanaInitial, type KanaRow } from './kana-initial'
import type { LanguageListEntry } from '../../shared/types/language-store'
import type { AozoraImportErrorCode } from '../../shared/types/aozora-import'
import type { TypingTestTextMeta } from '../../shared/types/typing-test-text-store'

const PAGE_SIZE = 50
const AOZORA_PROVIDER = 'aozora'

/** Catalog error code → i18n key for the per-row inline error line.
 *  DUPLICATE_NAME (the text store's own name-collision check) gets a
 *  specific message; every other code — including the download/unzip/
 *  decode pipeline's own codes — falls back to a generic message that
 *  carries the raw code for diagnosis. */
function importErrorKey(errorCode: AozoraImportErrorCode): string {
  return errorCode === 'DUPLICATE_NAME'
    ? 'editor.typingTest.language.catalogImportErrorDuplicate'
    : 'editor.typingTest.language.catalogImportErrorGeneric'
}

// Matches the AozoraRow accent idiom: bg-accent/10 + text-accent when
// selected, text-content-muted (brightening to text-accent on hover)
// otherwise — the same pattern the row's own import button uses.
function kanaButtonClass(active: boolean): string {
  const base = 'flex h-6 w-6 items-center justify-center rounded text-sm transition-colors'
  return active
    ? `${base} bg-accent/10 font-semibold text-accent`
    : `${base} text-content-muted hover:text-accent`
}

interface KanaButtonProps {
  label: string
  active: boolean
  testId: string
  onClick: () => void
}

// One kana toggle, shared by the row tier and the column tier.
function KanaButton({ label, active, testId, onClick }: KanaButtonProps) {
  return (
    <button type="button" data-testid={testId} aria-pressed={active} className={kanaButtonClass(active)} onClick={onClick}>
      {label}
    </button>
  )
}

// Module-level cache of the ~10,468-entry catalog manifest: a tab remount
// (e.g. switching Typing Test tabs) reuses it instead of repeating the full
// IPC fetch. The list only changes when a dataset update is applied, so it
// is invalidated from handleUpdateDataset below rather than on every mount.
let cachedCatalog: LanguageListEntry[] | null = null

export function clearAozoraCatalogCache(): void {
  cachedCatalog = null
}

interface Props {
  /** Active imported text id, when the current config is in fileImport mode
   *  (an imported Aozora work plays back through that same mode). */
  currentTextId?: string
  onSelect: (textId: string) => void
  /** Fired with the text id whenever an imported work is deleted. */
  onDeleted?: (textId: string) => void
}

export function AozoraCatalogTab({ currentTextId, onSelect, onDeleted }: Props) {
  const { t } = useTranslation()
  const [catalog, setCatalog] = useState<LanguageListEntry[]>(cachedCatalog ?? [])
  const [search, setSearch] = useState('')
  const [selectedRow, setSelectedRow] = useState<KanaRow | null>(null)
  const [selectedColumn, setSelectedColumn] = useState<string | null>(null)
  const [importing, setImporting] = useState<Set<string>>(new Set())
  const [errors, setErrors] = useState<Record<string, string>>({})
  // Distinguishes "the catalog fetch failed" from "the catalog is genuinely
  // empty" so a load failure doesn't silently render as an empty result list.
  const [catalogLoadFailed, setCatalogLoadFailed] = useState(false)
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE)
  const searchRef = useRef<HTMLInputElement>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const sentinelRef = useRef<HTMLDivElement>(null)
  const { metas, refresh: refreshMetas, remove } = useTypingTestTexts()
  const { updateAvailable, updating, applyUpdate } = useTypingDatasetUpdate(AOZORA_PROVIDER)

  useEffect(() => {
    if (cachedCatalog) return
    let alive = true
    window.vialAPI.langList(AOZORA_PROVIDER).then((list) => {
      cachedCatalog = list
      if (alive) setCatalog(list)
    }).catch(() => {
      if (alive) setCatalogLoadFailed(true)
    })
    return () => { alive = false }
  }, [])

  useEffect(() => { searchRef.current?.focus() }, [])

  // A new query, a reloaded catalog (dataset update), or a changed kana
  // filter all start the Available list back at the first page — otherwise a
  // narrower filter could leave visibleCount pointing past the new,
  // shorter match set.
  useEffect(() => { setVisibleCount(PAGE_SIZE) }, [search, catalog, selectedRow, selectedColumn])

  function handleRowClick(row: KanaRow): void {
    setSelectedRow((prev) => (prev === row ? null : row))
    setSelectedColumn(null)
  }

  function handleColumnClick(column: string): void {
    setSelectedColumn((prev) => (prev === column ? null : column))
  }

  const handleUpdateDataset = useCallback(async () => {
    const changed = await applyUpdate()
    if (changed) {
      // The update may have changed the manifest; drop the cached catalog
      // so a later tab remount re-fetches instead of serving stale entries.
      clearAozoraCatalogCache()
      const list = await window.vialAPI.langList(AOZORA_PROVIDER)
      cachedCatalog = list
      setCatalog(list)
    }
  }, [applyUpdate])

  // workId (catalog entry `name`) -> the meta it was imported as. Soft-
  // deleted texts don't count as imported. Keeps the full meta (not just the
  // id) so the row can also show the Romaji badge for kana-pure imports —
  // `romajiCapable` is computed by the store from the entry's own content.
  const importedMetaByWorkId = useMemo(() => {
    const map = new Map<string, TypingTestTextMeta>()
    for (const meta of metas) {
      if (meta.deletedAt) continue
      if (meta.source?.provider === AOZORA_PROVIDER && meta.source.workId) {
        map.set(meta.source.workId, meta)
      }
    }
    return map
  }, [metas])

  // Precomputed lowercase search haystack and normalized author-kana
  // initial, built once per catalog load so a keystroke or a kana-filter
  // click only re-runs the (cheap) comparison instead of re-normalizing
  // every entry. authorKana is the canonical source; an entry from an
  // older cached override that lacks it falls back to its display-name
  // author (a foreign author's display name is already katakana).
  const searchIndex = useMemo(
    () => catalog.map((entry) => ({
      entry,
      haystack: `${entry.title ?? ''}\n${entry.author ?? ''}`.toLowerCase(),
      kanaInitial: normalizeKanaInitial(entry.authorKana) ?? normalizeKanaInitial(entry.author),
    })),
    [catalog],
  )
  const query = search.trim().toLowerCase()

  // Single filter pass: partitions matches into the "Imported" section
  // (already-imported works) and the "Available" section (everything
  // else), always both sectioned — mirrors LanguagePackTab's downloaded/
  // available split — so an imported work never blends into the plain
  // list mid-search. The empty-result state is derived from both lists
  // being empty rather than a separate counter. The kana filter (row, or
  // the narrower column once one is picked) combines with the text search
  // as AND.
  const { imported, available } = useMemo(() => {
    const imported: LanguageListEntry[] = []
    const available: LanguageListEntry[] = []
    for (const { entry, haystack, kanaInitial } of searchIndex) {
      if (query && !haystack.includes(query)) continue
      if (selectedColumn) {
        if (kanaInitial !== selectedColumn) continue
      } else if (selectedRow) {
        if (!kanaInitial || KANA_COLUMN_TO_ROW[kanaInitial] !== selectedRow) continue
      }
      if (importedMetaByWorkId.has(entry.name)) {
        imported.push(entry)
      } else {
        available.push(entry)
      }
    }
    return { imported, available }
  }, [searchIndex, query, importedMetaByWorkId, selectedRow, selectedColumn])

  // Pagination only applies to the Available list — imported works are few
  // enough (per-user) to render in full.
  const hasMore = visibleCount < available.length

  // Infinite scroll: observes a sentinel placed after the last rendered
  // Available-list row, using the scroll container itself as the
  // intersection root. Re-created whenever hasMore flips (the sentinel
  // mounts/unmounts) so a stale observer never lingers once every match
  // is rendered.
  useEffect(() => {
    if (!hasMore) return
    const sentinel = sentinelRef.current
    const root = scrollRef.current
    if (!sentinel || !root) return
    const observer = new IntersectionObserver((entries) => {
      if (entries[0]?.isIntersecting) {
        setVisibleCount((prev) => prev + PAGE_SIZE)
      }
    }, { root })
    observer.observe(sentinel)
    return () => observer.disconnect()
  }, [hasMore])

  const handleImport = useCallback(async (workId: string) => {
    setImporting((prev) => new Set(prev).add(workId))
    setErrors((prev) => {
      const next = { ...prev }
      delete next[workId]
      return next
    })
    try {
      const result = await window.vialAPI.aozoraImport(workId)
      if (result.success) {
        await refreshMetas()
        onSelect(result.meta.id)
        return
      }
      setErrors((prev) => ({ ...prev, [workId]: t(importErrorKey(result.errorCode), { code: result.errorCode }) }))
    } finally {
      setImporting((prev) => {
        const next = new Set(prev)
        next.delete(workId)
        return next
      })
    }
  }, [refreshMetas, onSelect, t])

  // Soft-deletes the imported text behind a catalog entry (same tombstone
  // as ImportTab's remove). The metas refresh this triggers naturally moves
  // the row from Imported back to Available. `onDeleted` is reported
  // optimistically before the IPC round-trip so closing the modal
  // mid-delete still resets a deleted current text; a failed delete turns
  // the reset into a harmless no-op.
  const handleDelete = useCallback(async (textId: string) => {
    onDeleted?.(textId)
    await remove(textId)
  }, [remove, onDeleted])

  // Shared row renderer for both the Imported and Available sections: an
  // already-imported entry naturally swaps its import button for a delete
  // button inside AozoraRow (see `imported` there), so passing the same
  // importing/error lookups to both sections is behavior-identical.
  const renderRow = useCallback((entry: LanguageListEntry) => {
    const meta = importedMetaByWorkId.get(entry.name)
    return (
      <AozoraRow
        key={entry.name}
        entry={entry}
        textId={meta?.id}
        romajiCapable={meta?.romajiCapable === true}
        // Guard against undefined === undefined: an unimported row has no
        // textId, and outside fileImport mode there is no currentTextId.
        isCurrent={meta !== undefined && meta.id === currentTextId}
        isImporting={importing.has(entry.name)}
        error={errors[entry.name]}
        onSelect={onSelect}
        onImport={handleImport}
        onDelete={handleDelete}
      />
    )
  }, [importedMetaByWorkId, currentTextId, importing, errors, onSelect, handleImport, handleDelete])

  return (
    <>
      <div className="border-b border-edge px-4 py-2">
        <input
          ref={searchRef}
          type="text"
          className="w-full rounded-md border border-edge bg-surface-alt px-3 py-1.5 text-sm text-content placeholder:text-content-muted focus:border-accent focus:outline-none"
          placeholder={t('editor.typingTest.language.catalogSearchPlaceholder')}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          data-testid="aozora-search"
        />

        <div
          className="mt-2 flex flex-wrap items-center gap-1"
          role="group"
          aria-label={t('editor.typingTest.language.kanaRowGroupAriaLabel')}
        >
          {KANA_ROWS.map((row) => (
            <KanaButton
              key={row}
              label={row}
              active={selectedRow === row}
              testId={`aozora-kana-row-${row}`}
              onClick={() => handleRowClick(row)}
            />
          ))}
          <span className="text-xs text-content-muted">{t('editor.typingTest.language.kanaRowLabel')}</span>
        </div>

        {selectedRow && (
          <div
            className="mt-2 flex flex-wrap items-center gap-1"
            role="group"
            aria-label={t('editor.typingTest.language.kanaColumnGroupAriaLabel')}
            data-testid="aozora-kana-columns"
          >
            {KANA_ROW_COLUMNS[selectedRow].map((column) => (
              <KanaButton
                key={column}
                label={column}
                active={selectedColumn === column}
                testId={`aozora-kana-col-${column}`}
                onClick={() => handleColumnClick(column)}
              />
            ))}
          </div>
        )}
      </div>

      <DatasetUpdateBanner updateAvailable={updateAvailable} updating={updating} onUpdate={handleUpdateDataset} />

      <div ref={scrollRef} className="flex-1 overflow-y-auto">
        {catalogLoadFailed ? (
          <p className="px-4 py-6 text-center text-sm text-danger" data-testid="aozora-catalog-error">
            {t('editor.typingTest.language.catalogLoadFailed')}
          </p>
        ) : imported.length === 0 && available.length === 0 && (
          <p className="px-4 py-6 text-center text-sm text-content-muted">{t('editor.typingTest.language.noResults')}</p>
        )}

        {imported.length > 0 && (
          <div>
            <SectionHeader label={t('editor.typingTest.language.downloaded')} />
            {imported.map(renderRow)}
          </div>
        )}

        {available.length > 0 && (
          <div>
            <SectionHeader label={t('editor.typingTest.language.available')} />
            {available.slice(0, visibleCount).map(renderRow)}
          </div>
        )}

        {hasMore && <div ref={sentinelRef} className="h-px" data-testid="aozora-sentinel" />}
      </div>
    </>
  )
}

interface AozoraRowProps {
  entry: LanguageListEntry
  /** Id of the text this catalog entry was imported as, if any. */
  textId?: string
  /** Whether the imported text's content is pure kana (romaji-input
   *  capable). Only meaningful once imported — an unimported entry's
   *  content hasn't been fetched yet, so this is always false for it. */
  romajiCapable: boolean
  isCurrent: boolean
  isImporting: boolean
  error?: string
  onSelect: (textId: string) => void
  onImport: (workId: string) => void
  onDelete: (textId: string) => void
}

function AozoraRow({ entry, textId, romajiCapable, isCurrent, isImporting, error, onSelect, onImport, onDelete }: AozoraRowProps) {
  const { t } = useTranslation()
  const imported = textId !== undefined

  let rowStyle = ''
  if (isCurrent) {
    rowStyle = 'bg-accent/10'
  } else if (imported) {
    rowStyle = 'cursor-pointer hover:bg-surface-alt'
  }

  return (
    <div>
      <div
        data-testid={`aozora-row-${entry.name}`}
        className={`flex items-center gap-3 px-4 py-2 text-sm transition-colors ${rowStyle}`}
        onClick={imported ? () => onSelect(textId) : undefined}
      >
        <div className="flex min-w-0 flex-1 flex-col">
          <div className="flex min-w-0 items-center gap-2">
            {isCurrent && <Check size={ICON_SM} className="shrink-0 text-accent" aria-hidden="true" />}
            <span className={`truncate ${isCurrent ? 'font-semibold text-accent' : 'text-content'}`}>
              {entry.title ?? entry.name}
            </span>
            {romajiCapable && <RomajiBadge />}
          </div>
          {entry.author && <span className="truncate text-xs text-content-muted">{entry.author}</span>}
        </div>

        <span className="shrink-0 text-xs text-content-muted">
          {t('editor.typingTest.language.estimatedChars', { count: entry.wordCount })}
        </span>

        {!imported && (
          <button
            type="button"
            data-testid={`aozora-import-${entry.name}`}
            aria-label={t('editor.typingTest.language.catalogImportAction')}
            className="shrink-0 rounded p-1 text-content-muted hover:text-accent"
            onClick={(e) => {
              e.stopPropagation()
              onImport(entry.name)
            }}
            disabled={isImporting}
          >
            {isImporting ? (
              <Loader2 size={ICON_SM} className="animate-spin" aria-hidden="true" />
            ) : (
              <Download size={ICON_SM} aria-hidden="true" />
            )}
          </button>
        )}

        {imported && (
          <RowDeleteButton testId={`aozora-delete-${entry.name}`} onClick={() => onDelete(textId)} />
        )}
      </div>
      {error && (
        <p className="px-4 pb-2 text-xs text-danger" data-testid={`aozora-error-${entry.name}`}>{error}</p>
      )}
    </div>
  )
}
