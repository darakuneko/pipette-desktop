// SPDX-License-Identifier: GPL-2.0-or-later
// Analyze tab content — per-keyboard typing analytics dashboard.
// C2 lays out the two-column shell and the left-hand keyboard list;
// follow-up chunks fill in the analysis tabs, filters, and charts.

import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { TypingKeyboardSummary } from '../../../shared/types/typing-analytics'

const SIDE_BTN_BASE =
  'block w-full rounded-md border px-3 py-2 text-left text-[13px] transition-colors'
const SIDE_BTN_IDLE =
  'border-transparent bg-transparent text-content-secondary hover:border-edge hover:bg-surface-dim'
const SIDE_BTN_ACTIVE =
  'border-accent bg-accent/10 text-content'

export function TypingAnalyticsView() {
  const { t } = useTranslation()
  const [keyboards, setKeyboards] = useState<TypingKeyboardSummary[]>([])
  const [loading, setLoading] = useState(true)
  const [selectedUid, setSelectedUid] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    setLoading(true)
    try {
      const list = await window.vialAPI.typingAnalyticsListKeyboards()
      setKeyboards(list)
      setSelectedUid((prev) => {
        if (prev && list.some((kb) => kb.uid === prev)) return prev
        return list[0]?.uid ?? null
      })
    } catch {
      setKeyboards([])
      setSelectedUid(null)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const selected = selectedUid
    ? keyboards.find((kb) => kb.uid === selectedUid) ?? null
    : null

  return (
    <div
      className="flex h-[70vh] min-h-0 gap-4"
      data-testid="analyze-view"
    >
      <aside className="flex w-60 shrink-0 flex-col gap-2 border-r border-edge pr-4 min-h-0">
        <h3 className="px-1 text-[11px] font-semibold uppercase tracking-widest text-content-muted">
          {t('analyze.keyboardList')}
        </h3>
        {loading ? (
          <div className="px-1 py-2 text-[13px] text-content-muted">
            {t('common.loading')}
          </div>
        ) : keyboards.length === 0 ? (
          <div className="px-1 py-2 text-[13px] text-content-muted" data-testid="analyze-no-keyboards">
            {t('analyze.noKeyboards')}
          </div>
        ) : (
          <div className="flex flex-1 min-h-0 flex-col gap-1 overflow-y-auto">
            {keyboards.map((kb) => (
              <button
                key={kb.uid}
                type="button"
                className={`${SIDE_BTN_BASE} ${kb.uid === selectedUid ? SIDE_BTN_ACTIVE : SIDE_BTN_IDLE}`}
                onClick={() => setSelectedUid(kb.uid)}
                data-testid={`analyze-kb-${kb.uid}`}
              >
                <span className="block font-medium">{kb.productName || kb.uid}</span>
                <span className="block font-mono text-[10px] text-content-muted">{kb.uid}</span>
              </button>
            ))}
          </div>
        )}
      </aside>
      <section className="flex flex-1 min-h-0 min-w-0 flex-col gap-3">
        {selected ? (
          <div className="py-2 text-[13px] text-content-muted" data-testid="analyze-selected-placeholder">
            {t('analyze.placeholder')}
          </div>
        ) : (
          <div className="py-6 text-center text-sm text-content-muted">
            {t('analyze.selectKeyboard')}
          </div>
        )}
      </section>
    </div>
  )
}
