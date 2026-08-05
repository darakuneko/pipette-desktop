// SPDX-License-Identifier: GPL-2.0-or-later
// Standalone Analyze page. Keeps the Analyze experience outside both
// the DeviceSelector shell (top of app) and the typing-view chrome so
// the two entry points render identical content; callers just supply
// an `onBack` target and (optionally) a keyboard to preselect. The
// Back button itself lives in TypingAnalyticsView's own footer bar so
// this page stays header-less.
//
// The padded `<main>` wrapper only surrounds the scrollable content —
// TypingAnalyticsView's footer bar renders full-bleed below it (edge
// to edge like the keymap editor's StatusBar) so it reads as a docked
// bar instead of a pair of buttons floating at the end of the scroll
// content.

import { TypingAnalyticsView } from './TypingAnalyticsView'
import type { ConnectedTappingTerm } from './analyze-types'

interface Props {
  onBack: () => void
  initialUid?: string
  connectedTappingTerm?: ConnectedTappingTerm | null
  onOpenRunTimeline?: (runId: string) => void
}

export function AnalyzePage({ onBack, initialUid, connectedTappingTerm, onOpenRunTimeline }: Props) {
  return (
    <div className="flex h-screen flex-col bg-surface" data-testid="analyze-page">
      <TypingAnalyticsView initialUid={initialUid} onBack={onBack} connectedTappingTerm={connectedTappingTerm} onOpenRunTimeline={onOpenRunTimeline} />
    </div>
  )
}
