// SPDX-License-Identifier: GPL-2.0-or-later
// Analyze > Summary — dashboard tab for at-a-glance metrics. Owns the
// shared daily-summary fetch and the local-day pivot so each card
// renders against a single source instead of re-issuing the IPC and
// running its own midnight-tracking timer. The Profile card pulls
// extra IPCs (bigram / minute-stats) on its own since those are
// 30-day-windowed and not reused by the other cards.

import type { TypingKeymapSnapshot } from '../../../shared/types/typing-analytics'
import type { FingerType } from '../../../shared/kle/kle-ergonomics'
import { StreakGoalCard } from './StreakGoalCard'
import { TodaySummaryCard } from './TodaySummaryCard'
import { TypingProfileCard } from './TypingProfileCard'
import { WeeklyReportCard } from './WeeklyReportCard'
import { useDailySummary, useLocalToday } from './use-daily-summary'
import type { DeviceScope } from './analyze-types'

interface Props {
  uid: string
  deviceScope: DeviceScope
  /** App filter — see WpmChart.Props.appScopes. Forwarded to the
   * daily-summary fetch and to TypingProfileCard so every per-app
   * subview re-aggregates from the same single-app minute set. */
  appScopes: string[]
  /** Snapshot the parent already resolved for the current scope —
   * Profile uses it to map bigram keycodes to fingers / hands. */
  snapshot: TypingKeymapSnapshot | null
  /** Per-position finger overrides loaded by the parent's
   * pipetteSettings effect. */
  fingerOverrides: Record<string, FingerType>
}

export function SummaryView({ uid, deviceScope, appScopes, snapshot, fingerOverrides }: Props) {
  const { daily } = useDailySummary(uid, deviceScope, appScopes)
  const today = useLocalToday()
  return (
    <div className="flex h-full w-full flex-col gap-3">
      <TodaySummaryCard daily={daily} today={today} />
      <WeeklyReportCard daily={daily} today={today} />
      <TypingProfileCard
        uid={uid}
        deviceScope={deviceScope}
        appScopes={appScopes}
        daily={daily}
        today={today}
        snapshot={snapshot}
        fingerOverrides={fingerOverrides}
      />
      {/* The streak counter is a long-running motivator and reads as
          a single timeline of "kept typing every day". Filtering it
          per-app would make it reset whenever the user spent a day
          in a different app, which is the opposite of what the card
          is meant to convey, so we only render it when no app filter
          is active. */}
      {appScopes.length === 0 && (
        <StreakGoalCard uid={uid} daily={daily} today={today} />
      )}
    </div>
  )
}
