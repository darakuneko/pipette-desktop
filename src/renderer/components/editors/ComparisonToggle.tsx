// SPDX-License-Identifier: GPL-2.0-or-later

import { useState, useCallback, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { useEscapeClose } from '../../hooks/useEscapeClose'
import { ModalCloseButton } from './ModalCloseButton'
import { formatDate } from './store-modal-shared'
import { BTN_PRIMARY, BTN_SECONDARY } from '../../constants/ui-tokens'
import { COMPARISON_BASELINE_KINDS } from '../../../shared/types/pipette-settings'
import type { PooledTypingTestResult, TypingTestComparisonBaseline, ComparisonBaselineKind } from '../../../shared/types/pipette-settings'

interface Props {
  /** Same-condition results (across all keyboards) — the choices for a pinned
   *  baseline. */
  pool: PooledTypingTestResult[]
  baseline: TypingTestComparisonBaseline
  onChange?: (baseline: TypingTestComparisonBaseline) => void
}

const MAX_PINNABLE = 100

function toggleClass(active: boolean): string {
  const base = 'inline-flex h-8 items-center rounded-md border px-3 text-sm transition-colors'
  if (active) return `${base} border-accent bg-accent/10 text-accent`
  return `${base} border-edge text-content-secondary hover:text-content`
}

export function ComparisonToggle({ pool, baseline, onChange }: Props) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const [draftKind, setDraftKind] = useState<ComparisonBaselineKind>(baseline.kind)
  const [draftPinnedDate, setDraftPinnedDate] = useState<string | undefined>(baseline.pinnedDate)

  const close = useCallback(() => setOpen(false), [])
  useEscapeClose(close, open)

  // Sync the draft to the persisted value each time the modal opens.
  const openModal = useCallback(() => {
    setDraftKind(baseline.kind)
    setDraftPinnedDate(baseline.pinnedDate)
    setOpen(true)
  }, [baseline])

  // Most-recent first; capped so a huge history doesn't bloat the picker.
  const pinnable = useMemo(
    () => [...pool]
      .sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime())
      .slice(0, MAX_PINNABLE),
    [pool],
  )

  const save = useCallback(() => {
    const next: TypingTestComparisonBaseline = draftKind === 'pinned'
      ? { kind: 'pinned', pinnedDate: draftPinnedDate }
      : { kind: draftKind }
    onChange?.(next)
    setOpen(false)
  }, [draftKind, draftPinnedDate, onChange])

  // A pinned baseline with no chosen result isn't a valid save.
  const canSave = draftKind !== 'pinned' || !!draftPinnedDate

  return (
    <>
      <button
        type="button"
        data-testid="typing-test-comparison-toggle"
        // Accent-highlight whenever comparison is active (any baseline but
        // 'off'), mirroring the Show toggles, so the button reflects on/off
        // state rather than just whether the modal is open.
        className={toggleClass(baseline.kind !== 'off')}
        aria-pressed={baseline.kind !== 'off'}
        onClick={openModal}
      >
        {t('editor.typingTest.compare.button')}
      </button>
      {open && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
          data-testid="comparison-modal-backdrop"
          role="dialog"
          aria-modal="true"
          aria-labelledby="comparison-modal-title"
          onClick={close}
        >
          <div
            className="flex max-h-modal-80vh w-full max-w-3xl flex-col rounded-xl border border-edge bg-surface-alt shadow-lg"
            data-testid="comparison-modal"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between border-b border-edge px-4 py-3">
              <h2 id="comparison-modal-title" className="text-base font-semibold text-content">
                {t('editor.typingTest.compare.title')}
              </h2>
              <ModalCloseButton testid="comparison-modal-close" onClick={close} />
            </div>

            <div className="flex min-h-0 flex-col gap-1 overflow-y-auto p-4">
              {COMPARISON_BASELINE_KINDS.map((kind) => (
                <label
                  key={kind}
                  className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-sm transition-colors hover:bg-surface-dim"
                  data-testid={`comparison-kind-${kind}`}
                >
                  <input
                    type="radio"
                    name="comparison-kind"
                    className="accent-accent"
                    checked={draftKind === kind}
                    onChange={() => setDraftKind(kind)}
                  />
                  <span className={draftKind === kind ? 'text-content' : 'text-content-secondary'}>
                    {t(`editor.typingTest.compare.${kind}`)}
                  </span>
                </label>
              ))}

              {draftKind === 'pinned' && (
                <div className="mt-1 min-h-0 rounded-md border border-edge">
                  {pinnable.length > 0 ? (
                    <div className="max-h-56 overflow-y-auto">
                      <table className="w-full table-fixed text-xs">
                        <thead className="sticky top-0 bg-surface-alt text-content-muted">
                          <tr>
                            <th className="px-2 py-1.5 text-left font-medium">{t('editor.typingTest.compare.colName')}</th>
                            <th className="w-36 px-2 py-1.5 text-left font-medium">{t('editor.typingTest.compare.colKeyboard')}</th>
                            <th className="w-44 px-2 py-1.5 text-left font-medium">{t('editor.typingTest.compare.colTime')}</th>
                            <th className="w-14 px-2 py-1.5 text-right font-medium">{t('editor.typingTest.wpm')}</th>
                          </tr>
                        </thead>
                        <tbody>
                          {pinnable.map((r) => (
                            <tr
                              key={r.date}
                              data-testid={`comparison-pin-${r.date}`}
                              aria-pressed={draftPinnedDate === r.date}
                              className={`cursor-pointer border-t border-edge/50 transition-colors ${draftPinnedDate === r.date ? 'bg-accent/10 font-semibold text-accent' : 'text-content hover:bg-surface-dim'}`}
                              onClick={() => setDraftPinnedDate(r.date)}
                            >
                              <td className="truncate px-2 py-1.5">{r.name || t('editor.typingTest.history.unnamed')}</td>
                              <td className="whitespace-nowrap px-2 py-1.5">{r.keyboardName}</td>
                              <td className="whitespace-nowrap px-2 py-1.5 font-mono">{formatDate(r.date)}</td>
                              <td className="whitespace-nowrap px-2 py-1.5 text-right font-mono">{r.wpm}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  ) : (
                    <p className="px-2 py-2 text-xs text-content-muted">{t('editor.typingTest.compare.noResults')}</p>
                  )}
                </div>
              )}
            </div>

            <div className="flex justify-end gap-2 border-t border-edge px-4 py-3">
              <button type="button" className={BTN_SECONDARY} onClick={close}>
                {t('common.cancel')}
              </button>
              <button type="button" className={BTN_PRIMARY} disabled={!canSave} onClick={save} data-testid="comparison-modal-save">
                {t('common.save')}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  )
}
