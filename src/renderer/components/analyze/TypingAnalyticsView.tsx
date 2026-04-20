// SPDX-License-Identifier: GPL-2.0-or-later
// Analyze tab content — per-keyboard typing analytics dashboard.
// C2 added the keyboard list; C3 adds the right pane header with the
// analysis tab switcher (WPM / Interval / Heatmap) and the period /
// device-scope filters. The chart bodies are stubbed here and filled
// in by C4–C6.

import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { TypingKeyboardSummary } from '../../../shared/types/typing-analytics'

type AnalysisTabKey = 'wpm' | 'interval' | 'heatmap'
type PeriodKey = '7d' | '30d' | 'all'
type DeviceScope = 'own' | 'all'

const SIDE_BTN_BASE =
  'block w-full rounded-md border px-3 py-2 text-left text-[13px] transition-colors'
const SIDE_BTN_IDLE =
  'border-transparent bg-transparent text-content-secondary hover:border-edge hover:bg-surface-dim'
const SIDE_BTN_ACTIVE =
  'border-accent bg-accent/10 text-content'

const TAB_BTN_BASE =
  'rounded-md px-3 py-1.5 text-[13px] font-medium transition-colors'
const TAB_BTN_IDLE = 'text-content-muted hover:text-content-secondary'
const TAB_BTN_ACTIVE = 'bg-surface text-content shadow-sm'

const FILTER_LABEL = 'flex items-center gap-1.5 text-[12px] text-content-muted'
const FILTER_SELECT =
  'rounded-md border border-edge bg-surface px-2 py-1 text-[12px] text-content focus:border-accent focus:outline-none'

const ANALYSIS_TABS: AnalysisTabKey[] = ['wpm', 'interval', 'heatmap']
const PERIOD_OPTIONS: PeriodKey[] = ['7d', '30d', 'all']
const DEVICE_SCOPES: DeviceScope[] = ['own', 'all']

export function TypingAnalyticsView() {
  const { t } = useTranslation()
  const [keyboards, setKeyboards] = useState<TypingKeyboardSummary[]>([])
  const [loading, setLoading] = useState(true)
  const [selectedUid, setSelectedUid] = useState<string | null>(null)
  const [analysisTab, setAnalysisTab] = useState<AnalysisTabKey>('wpm')
  const [period, setPeriod] = useState<PeriodKey>('30d')
  const [deviceScope, setDeviceScope] = useState<DeviceScope>('own')

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
          <>
            <div
              className="flex gap-1 rounded-lg bg-surface-dim p-1"
              data-testid="analyze-tabs"
              role="tablist"
              aria-label={t('analyze.tablistLabel')}
            >
              {ANALYSIS_TABS.map((key) => (
                <button
                  key={key}
                  type="button"
                  role="tab"
                  aria-selected={analysisTab === key}
                  className={`${TAB_BTN_BASE} ${analysisTab === key ? TAB_BTN_ACTIVE : TAB_BTN_IDLE}`}
                  onClick={() => setAnalysisTab(key)}
                  data-testid={`analyze-tab-${key}`}
                >
                  {t(`analyze.analysisTab.${key}`)}
                </button>
              ))}
            </div>
            <div
              className="flex flex-wrap items-center gap-3 border-b border-edge pb-3"
              data-testid="analyze-filters"
            >
              <label className={FILTER_LABEL}>
                {t('analyze.filters.period')}
                <select
                  className={FILTER_SELECT}
                  value={period}
                  onChange={(e) => setPeriod(e.target.value as PeriodKey)}
                  data-testid="analyze-filter-period"
                >
                  {PERIOD_OPTIONS.map((key) => (
                    <option key={key} value={key}>
                      {t(`analyze.filters.periodOption.${key}`)}
                    </option>
                  ))}
                </select>
              </label>
              <label className={FILTER_LABEL}>
                {t('analyze.filters.device')}
                <select
                  className={FILTER_SELECT}
                  value={deviceScope}
                  onChange={(e) => setDeviceScope(e.target.value as DeviceScope)}
                  data-testid="analyze-filter-device"
                >
                  {DEVICE_SCOPES.map((key) => (
                    <option key={key} value={key}>
                      {t(`analyze.filters.deviceOption.${key}`)}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <div className="flex-1 min-h-0 overflow-auto py-2 text-[13px] text-content-muted" data-testid="analyze-chart">
              {t('analyze.placeholder')}
            </div>
          </>
        ) : (
          <div className="py-6 text-center text-sm text-content-muted">
            {t('analyze.selectKeyboard')}
          </div>
        )}
      </section>
    </div>
  )
}
