// SPDX-License-Identifier: GPL-2.0-or-later
// Phase 5 analytics dashboard shell. Intentionally blank for now —
// the content (charts, finger load, bigram grid, layout suggestions)
// is staged in follow-up work. See .claude/plans/typing-analytics.md
// for the scope.

import { useTranslation } from 'react-i18next'

export interface TypingAnalyticsPageProps {
  /** Label shown beside the back button — today this is the keyboard
   * name so the user knows which editor they return to. */
  deviceName?: string
  /** Invoked when the user hits the back button — the App shell is
   * responsible for actually navigating. */
  onBack: () => void
}

export function TypingAnalyticsPage({ deviceName, onBack }: TypingAnalyticsPageProps) {
  const { t } = useTranslation()

  return (
    <div className="flex min-h-0 flex-1 flex-col p-4">
      <div className="mb-4 flex items-center gap-3">
        <button
          type="button"
          data-testid="analytics-back"
          className="rounded border border-edge px-3 py-1.5 text-sm text-content-secondary transition-colors hover:text-content"
          onClick={onBack}
        >
          {t('analytics.backToKeyboard', { name: deviceName ?? '' })}
        </button>
        <h1 className="text-lg font-medium">{t('analytics.title')}</h1>
      </div>

      {/* Placeholder — the real dashboard lands in a later phase.
          Keeping the page rendered so the navigation wiring is
          exercisable today without blocking on chart work. */}
      <div className="flex flex-1 items-center justify-center text-sm text-content-muted">
        {t('analytics.comingSoon')}
      </div>
    </div>
  )
}
