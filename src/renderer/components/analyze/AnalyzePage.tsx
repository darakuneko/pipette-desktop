// SPDX-License-Identifier: GPL-2.0-or-later
// Standalone Analyze page. Keeps the Analyze experience outside both
// the DeviceSelector shell (top of app) and the typing-view chrome so
// the two entry points render identical content; callers just supply
// an `onBack` target and (optionally) a keyboard to preselect. The
// Back button itself lives in the sidebar of TypingAnalyticsView so
// this page stays header-less.

import { TypingAnalyticsView } from './TypingAnalyticsView'
import type { ConnectedTappingTerm } from './analyze-types'

interface Props {
  onBack: () => void
  initialUid?: string
  connectedTappingTerm?: ConnectedTappingTerm | null
}

export function AnalyzePage({ onBack, initialUid, connectedTappingTerm }: Props) {
  return (
    <div className="flex h-screen flex-col bg-surface" data-testid="analyze-page">
      <main className="flex-1 min-h-0 p-8">
        <TypingAnalyticsView initialUid={initialUid} onBack={onBack} connectedTappingTerm={connectedTappingTerm} />
      </main>
    </div>
  )
}
