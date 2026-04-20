// SPDX-License-Identifier: GPL-2.0-or-later
// Analyze tab content — landing view for the per-keyboard typing
// analytics dashboard. C1 lays down the placeholder; follow-up chunks
// fill in the keyboard list, period/device filters, and the charts.

import { useTranslation } from 'react-i18next'

export function TypingAnalyticsView() {
  const { t } = useTranslation()
  return (
    <div
      className="py-6 text-center text-sm text-content-muted"
      data-testid="analyze-view"
    >
      {t('analyze.placeholder')}
    </div>
  )
}
