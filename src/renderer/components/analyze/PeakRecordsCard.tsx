// SPDX-License-Identifier: GPL-2.0-or-later
// Analyze > Peak Records — four summary cards rendered above the tab
// switcher. Values come from narrow aggregation queries on minute-stats
// and sessions, and they follow the same range / device-scope filters
// as the charts below so the peaks always match what the user is
// looking at.

import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { PeakRecords } from '../../../shared/types/typing-analytics'
import type { DeviceScope, RangeMs } from './analyze-types'
import { formatDateTime } from '../editors/store-modal-shared'
import { StatCard } from './stat-card'

interface Props {
  uid: string
  range: RangeMs
  deviceScope: DeviceScope
}

const NULL_DASH = '—'

function formatDurationMinutes(durationMs: number): string {
  return String(Math.round(durationMs / 60000))
}

export function PeakRecordsCard({ uid, range, deviceScope }: Props) {
  const { t } = useTranslation()
  const [records, setRecords] = useState<PeakRecords | null>(null)

  useEffect(() => {
    if (!uid) {
      setRecords(null)
      return
    }
    let cancelled = false
    const fetchFn = deviceScope === 'own'
      ? window.vialAPI.typingAnalyticsGetPeakRecordsLocal
      : window.vialAPI.typingAnalyticsGetPeakRecords
    void fetchFn(uid, range.fromMs, range.toMs)
      .then((r) => {
        if (!cancelled) setRecords(r)
      })
      .catch(() => {
        if (!cancelled) setRecords(null)
      })
    return () => {
      cancelled = true
    }
  }, [uid, range, deviceScope])

  if (!records) return null
  const hasAny = records.peakWpm !== null
    || records.peakKeystrokesPerMin !== null
    || records.peakKeystrokesPerDay !== null
    || records.longestSession !== null
  if (!hasAny) return null

  return (
    <div
      className="grid grid-cols-2 gap-2 sm:grid-cols-4"
      data-testid="analyze-peak-records"
    >
      <StatCard
        label={t('analyze.peak.peakWpm')}
        value={records.peakWpm ? String(Math.round(records.peakWpm.value)) : NULL_DASH}
        unit={records.peakWpm ? t('analyze.peak.unit.wpm') : ''}
        context={records.peakWpm ? formatDateTime(records.peakWpm.atMs) : ''}
        testid="analyze-peak-wpm"
      />
      <StatCard
        label={t('analyze.peak.peakKeystrokesPerMin')}
        value={records.peakKeystrokesPerMin ? records.peakKeystrokesPerMin.value.toLocaleString() : NULL_DASH}
        unit={records.peakKeystrokesPerMin ? t('analyze.peak.unit.kpm') : ''}
        context={records.peakKeystrokesPerMin ? formatDateTime(records.peakKeystrokesPerMin.atMs) : ''}
        testid="analyze-peak-kpm"
      />
      <StatCard
        label={t('analyze.peak.peakKeystrokesPerDay')}
        value={records.peakKeystrokesPerDay ? records.peakKeystrokesPerDay.value.toLocaleString() : NULL_DASH}
        unit={records.peakKeystrokesPerDay ? t('analyze.peak.unit.kpd') : ''}
        context={records.peakKeystrokesPerDay ? records.peakKeystrokesPerDay.day : ''}
        testid="analyze-peak-kpd"
      />
      <StatCard
        label={t('analyze.peak.longestSession')}
        value={records.longestSession ? formatDurationMinutes(records.longestSession.durationMs) : NULL_DASH}
        unit={records.longestSession ? t('analyze.peak.unit.minutes') : ''}
        context={records.longestSession ? formatDateTime(records.longestSession.startedAtMs) : ''}
        testid="analyze-peak-session"
      />
    </div>
  )
}
