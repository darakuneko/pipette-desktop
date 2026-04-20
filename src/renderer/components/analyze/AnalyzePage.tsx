// SPDX-License-Identifier: GPL-2.0-or-later
// Standalone Analyze page. Keeps the Analyze experience outside both
// the DeviceSelector shell (top of app) and the typing-view chrome so
// the two entry points render identical content; callers just supply
// an `onBack` target and (optionally) a keyboard to preselect.

import { ArrowLeft } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { TypingAnalyticsView } from './TypingAnalyticsView'

interface Props {
  onBack: () => void
  initialUid?: string
}

export function AnalyzePage({ onBack, initialUid }: Props) {
  const { t } = useTranslation()
  return (
    <div className="flex min-h-screen flex-col bg-surface" data-testid="analyze-page">
      <header className="flex items-center gap-3 border-b border-edge px-8 py-5">
        <button
          type="button"
          className="inline-flex items-center gap-1.5 rounded-md border border-edge px-3 py-1.5 text-sm text-content-secondary transition-colors hover:text-content"
          onClick={onBack}
          data-testid="analyze-back"
        >
          <ArrowLeft size={14} aria-hidden="true" />
          {t('analyze.back')}
        </button>
        <h1 className="text-lg font-semibold">{t('analyze.pageTitle')}</h1>
      </header>
      <main className="flex-1 min-h-0 p-8">
        <TypingAnalyticsView initialUid={initialUid} />
      </main>
    </div>
  )
}
