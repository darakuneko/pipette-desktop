// SPDX-License-Identifier: GPL-2.0-or-later

import { useTranslation } from 'react-i18next'
import { Circle, CheckCircle2 } from 'lucide-react'
import type { useInlineRename } from '../../hooks/useInlineRename'
import type { ThemePackMeta } from '../../../shared/types/theme-store'
import { formatTimestamp } from '../../utils/format-timestamp'
import type { ThemeSelection } from '../../../shared/types/app-config'

export interface PackRowProps {
  meta: ThemePackMeta
  isActive: boolean
  pendingId: string | null
  confirmDeleteId: string | null
  setConfirmDeleteId: (id: string | null) => void
  rename: ReturnType<typeof useInlineRename<string>>
  onRenameKey: (event: React.KeyboardEvent<HTMLInputElement>, id: string) => void
  onRenameCommit: (id: string) => void | Promise<void>
  onSelect: (selection: ThemeSelection) => void
  onExport: (id: string) => void
  onDelete: (id: string) => void
}

export function PackRow({
  meta,
  isActive,
  pendingId,
  confirmDeleteId,
  setConfirmDeleteId,
  rename,
  onRenameKey,
  onRenameCommit,
  onSelect,
  onExport,
  onDelete,
}: PackRowProps): JSX.Element {
  const { t } = useTranslation()
  const busy = pendingId === meta.id
  const editing = rename.editingId === meta.id
  const isConfirmingDelete = confirmDeleteId === meta.id
  const linkClass = 'text-xs font-medium hover:underline disabled:opacity-50'

  const renderName = (): JSX.Element => {
    if (editing) {
      return (
        <input
          autoFocus
          type="text"
          value={rename.editLabel}
          onChange={(e) => rename.setEditLabel(e.target.value)}
          onBlur={() => void onRenameCommit(meta.id)}
          onKeyDown={(e) => onRenameKey(e, meta.id)}
          maxLength={64}
          className="w-full border-b border-edge bg-transparent px-1 text-sm text-content outline-none focus:border-accent"
          data-testid={`theme-packs-rename-input-${meta.id}`}
        />
      )
    }
    return (
      <span
        className="block w-full truncate text-content cursor-pointer"
        onClick={() => rename.startRename(meta.id, meta.name)}
        data-testid={`theme-packs-name-${meta.id}`}
      >
        {meta.name}
      </span>
    )
  }

  return (
    <div
      className={`flex flex-col rounded border bg-surface ${isActive ? 'border-accent' : 'border-edge'}`}
      data-testid={`theme-packs-row-${meta.id}`}
    >
      <div className="flex items-center gap-3 px-3 py-2">
        <button
          type="button"
          aria-label={t('themePacks.selectTheme', { name: meta.name })}
          className="shrink-0 text-content-muted hover:text-accent transition-colors"
          onClick={() => onSelect(`pack:${meta.id}`)}
          data-testid={`theme-packs-select-${meta.id}`}
        >
          {isActive ? (
            <CheckCircle2 size={18} className="text-accent" aria-hidden="true" />
          ) : (
            <Circle size={18} aria-hidden="true" />
          )}
        </button>
        <div className="flex-1 min-w-0 text-sm font-medium">{renderName()}</div>
        <div className="shrink-0 whitespace-nowrap text-xs text-content-muted">
          {formatTimestamp(meta.updatedAt)}
        </div>
        <div className="shrink-0 whitespace-nowrap text-xs text-content-muted">
          {meta.version ? `v${meta.version}` : ''}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {isConfirmingDelete ? (
            <span className="inline-flex items-center gap-3">
              <button
                type="button"
                disabled={busy}
                onClick={(e) => { e.stopPropagation(); void onDelete(meta.id) }}
                className={`${linkClass} text-danger`}
                data-testid={`theme-packs-confirm-delete-${meta.id}`}
              >
                {t('common.confirmDelete')}
              </button>
              <button
                type="button"
                onClick={(e) => { e.stopPropagation(); setConfirmDeleteId(null) }}
                className={`${linkClass} text-content-muted`}
                data-testid={`theme-packs-cancel-delete-${meta.id}`}
              >
                {t('common.cancel')}
              </button>
            </span>
          ) : (
            <>
              <button
                type="button"
                className={`${linkClass} text-content-muted`}
                onClick={(e) => { e.stopPropagation(); void onExport(meta.id) }}
                disabled={busy}
                data-testid={`theme-packs-export-${meta.id}`}
              >
                {t('themePacks.export')}
              </button>
              <button
                type="button"
                className={`${linkClass} text-danger`}
                onClick={(e) => { e.stopPropagation(); setConfirmDeleteId(meta.id) }}
                disabled={busy}
                data-testid={`theme-packs-delete-${meta.id}`}
              >
                {t('themePacks.delete')}
              </button>
            </>
          )}
        </div>
      </div>
      <div className="flex items-center gap-3 px-3 pb-2">
        <span className="flex-1 min-w-0" />
        <span className="shrink-0 rounded bg-surface-dim px-1.5 py-0.5 text-[11px] text-content-muted">
          {meta.baseTheme === 'dark' ? t('themePacks.baseThemeDark') : t('themePacks.baseThemeLight')}
        </span>
      </div>
    </div>
  )
}
