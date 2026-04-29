// SPDX-License-Identifier: GPL-2.0-or-later
// Streak / Goal summary cards rendered under the Activity chart.
//
// Three cards:
//   1. 現在の連続記録日数  — goal cycle progress `{current}/{goalDays} 日`
//   2. 全期間最長連続記録日数 — longest-ever streak (no reset), with a
//      History button that opens GoalAchievementsModal
//   3. 打鍵記録目標設定 — inline editable `days` + `keystrokes` rows
//      with a 2-click confirm; changing either clears the in-flight
//      achievement counter (warning is shown the moment the value
//      differs from the saved one).

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { GoalHistoryEntry, PipetteSettings } from '../../../shared/types/pipette-settings'
import { DEFAULT_GOAL_DAYS, DEFAULT_GOAL_KEYSTROKES, DEFAULT_PIPETTE_SETTINGS } from '../../../shared/types/pipette-settings'
import type { TypingDailySummary } from '../../../shared/types/typing-analytics'
import type { AnalyzeSummaryItem } from './analyze-summary-table'
import {
  byDate,
  calcGoalCycleProgress,
  calcLongestStreak,
  detectGoalAchievements,
  type GoalAchievement,
  type GoalPair,
  toLocalDate,
} from './analyze-streak-goal'
import { GoalAchievementsModal } from './GoalAchievementsModal'
import { AnalyzeStatGrid } from './stat-card'

interface Props {
  uid: string
  /** Cross-machine daily summary for this keyboard. SummaryView fetches
   * once and shares the array with every Summary card so each one
   * doesn't refetch on its own. */
  daily: ReadonlyArray<TypingDailySummary>
  /** Local YYYY-MM-DD pivot supplied by SummaryView; the parent's
   * `useLocalToday` re-evaluates it across midnight. */
  today: string
}

export function StreakGoalCard({ uid, daily, today }: Props) {
  const { t } = useTranslation()
  const [settings, setSettings] = useState<PipetteSettings | null>(null)
  const [historyOpen, setHistoryOpen] = useState(false)

  useEffect(() => {
    let cancelled = false
    window.vialAPI
      .pipetteSettingsGet(uid)
      .then((prefs) => { if (!cancelled) setSettings(prefs) })
      .catch(() => { if (!cancelled) setSettings(null) })
    return () => { cancelled = true }
  }, [uid])

  const goalKeystrokes = settings?.analyze?.goalKeystrokes ?? DEFAULT_GOAL_KEYSTROKES
  const goalDays = settings?.analyze?.goalDays ?? DEFAULT_GOAL_DAYS
  const goalHistory = settings?.analyze?.goalHistory ?? []
  const currentGoal: GoalPair = useMemo(
    () => ({ days: goalDays, keystrokes: goalKeystrokes }),
    [goalDays, goalKeystrokes],
  )

  const dailyMap = useMemo(() => byDate(daily), [daily])

  const progress = useMemo(
    () => calcGoalCycleProgress(dailyMap, goalHistory, currentGoal, today),
    [dailyMap, goalHistory, currentGoal, today],
  )
  const longest = useMemo(
    () => calcLongestStreak(dailyMap, goalHistory, currentGoal),
    [dailyMap, goalHistory, currentGoal],
  )
  const achievements: GoalAchievement[] = useMemo(
    () => detectGoalAchievements(dailyMap, goalHistory, currentGoal),
    [dailyMap, goalHistory, currentGoal],
  )

  const pct = progress.goalDays > 0
    ? Math.round((progress.current / progress.goalDays) * 100)
    : 0
  const currentValue = t('analyze.streakGoal.currentValue', {
    current: progress.current,
    goalDays: progress.goalDays,
  })

  const persistGoal = useCallback(async (next: GoalPair) => {
    // Keyboards without a prior settings file return null from
    // `pipetteSettingsGet`. Bootstrap a minimum valid PipetteSettings
    // so the first goal edit can create the file instead of silently
    // dropping the write (which used to leave the draft stuck and the
    // "changes cleared" warning visible).
    const fetched = await window.vialAPI.pipetteSettingsGet(uid)
    const current: PipetteSettings = fetched ?? settings ?? DEFAULT_PIPETTE_SETTINGS
    const prevAnalyze = current.analyze ?? {}
    const prevHistory: GoalHistoryEntry[] = prevAnalyze.goalHistory ?? []
    const prevKeystrokes = prevAnalyze.goalKeystrokes ?? DEFAULT_GOAL_KEYSTROKES
    const prevDays = prevAnalyze.goalDays ?? DEFAULT_GOAL_DAYS
    if (prevKeystrokes === next.keystrokes && prevDays === next.days) return

    const nowIso = new Date().toISOString()
    const todayLocal = toLocalDate(Date.parse(nowIso))
    const latest = prevHistory[prevHistory.length - 1]
    const latestLocal = latest
      ? toLocalDate(Date.parse(latest.effectiveFrom))
      : null
    // Same-day coalesce: skip pushing a new retirement when the
    // previous goal was already retired earlier today. The old entry
    // still correctly describes yesterday's-and-earlier goal.
    const nextHistory: GoalHistoryEntry[] = latestLocal === todayLocal
      ? prevHistory
      : [...prevHistory, { days: prevDays, keystrokes: prevKeystrokes, effectiveFrom: nowIso }]

    const nextSettings: PipetteSettings = {
      ...current,
      analyze: {
        ...prevAnalyze,
        goalDays: next.days,
        goalKeystrokes: next.keystrokes,
        goalHistory: nextHistory,
      },
    }
    setSettings(nextSettings)
    try {
      await window.vialAPI.pipetteSettingsSet(uid, nextSettings)
    } catch {
      setSettings(current)
    }
  }, [settings, uid])

  const items: AnalyzeSummaryItem[] = [
    {
      labelKey: 'analyze.streakGoal.currentStreakLabel',
      value: currentValue,
      unit: `${pct}%`,
      descriptionKey: 'analyze.streakGoal.currentStreakDesc',
    },
    {
      labelKey: 'analyze.streakGoal.longestStreakLabel',
      value: String(longest),
      unit: t('analyze.streakGoal.daysUnit'),
    },
    {
      labelKey: 'analyze.streakGoal.goalLabel',
      value: (
        <InlineGoalSettings
          goalDays={goalDays}
          goalKeystrokes={goalKeystrokes}
          onSave={persistGoal}
        />
      ),
    },
  ]

  return (
    <section className="flex flex-col gap-2" data-testid="analyze-streak-goal-section">
      <div className="flex items-center gap-3">
        <h3 className="text-[13px] font-semibold text-content">
          {t('analyze.streakGoal.sectionTitle')}
        </h3>
        <button
          type="button"
          onClick={() => setHistoryOpen(true)}
          className="rounded border border-edge bg-surface px-3 py-1 text-[11px] text-content-secondary transition-colors hover:border-accent hover:text-content"
          data-testid="analyze-streak-goal-history-open"
        >
          {t('analyze.streakGoal.historyButton')}
        </button>
      </div>
      <AnalyzeStatGrid
        items={items}
        ariaLabelKey="analyze.streakGoal.ariaLabel"
        testId="analyze-streak-goal"
      />
      <GoalAchievementsModal
        isOpen={historyOpen}
        onClose={() => setHistoryOpen(false)}
        achievements={achievements}
      />
    </section>
  )
}

interface InlineGoalSettingsProps {
  goalDays: number
  goalKeystrokes: number
  onSave: (next: GoalPair) => void | Promise<void>
}

// Two-row inline editor (日数 / 回数). Each row is a separate
// InlineNumberField that handles its own 2-click confirm via
// useConfirmAction semantics: first click/Enter arms the change and
// swaps the button to "Confirm", second click commits. Esc cancels.
// A joint warning renders below whenever either draft differs from
// the persisted value — so the user sees the reset risk before
// committing.
function InlineGoalSettings({ goalDays, goalKeystrokes, onSave }: InlineGoalSettingsProps) {
  const { t } = useTranslation()
  const [daysDraft, setDaysDraft] = useState<number>(goalDays)
  const [keystrokesDraft, setKeystrokesDraft] = useState<number>(goalKeystrokes)

  useEffect(() => { setDaysDraft(goalDays) }, [goalDays])
  useEffect(() => { setKeystrokesDraft(goalKeystrokes) }, [goalKeystrokes])

  const pendingDays = daysDraft !== goalDays
  const pendingKeystrokes = keystrokesDraft !== goalKeystrokes
  const hasPending = pendingDays || pendingKeystrokes

  const commit = useCallback(async () => {
    await onSave({ days: daysDraft, keystrokes: keystrokesDraft })
  }, [daysDraft, keystrokesDraft, onSave])

  const cancelAll = useCallback(() => {
    setDaysDraft(goalDays)
    setKeystrokesDraft(goalKeystrokes)
  }, [goalDays, goalKeystrokes])

  return (
    <div className="flex flex-col gap-0.5">
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
        <span className="inline-flex items-baseline gap-1">
          <InlineNumberField
            value={keystrokesDraft}
            onChange={setKeystrokesDraft}
            persistedValue={goalKeystrokes}
            onCancel={cancelAll}
            min={1}
            confirmPending={pendingKeystrokes}
            onCommit={commit}
            ariaLabel={t('analyze.streakGoal.goalKeystrokesAria')}
            testid="analyze-streak-goal-keystrokes"
          />
          <span className="text-[11px] text-content-muted">{t('analyze.streakGoal.keystrokesUnit')}</span>
        </span>
        <span className="inline-flex items-baseline gap-1">
          <InlineNumberField
            value={daysDraft}
            onChange={setDaysDraft}
            persistedValue={goalDays}
            onCancel={cancelAll}
            min={1}
            confirmPending={pendingDays}
            onCommit={commit}
            ariaLabel={t('analyze.streakGoal.goalDaysAria')}
            testid="analyze-streak-goal-days"
          />
          <span className="text-[11px] text-content-muted">{t('analyze.streakGoal.daysUnit')}</span>
        </span>
      </div>
      {hasPending && (
        <div
          className="mt-1 rounded border border-accent/40 bg-accent/5 px-1.5 py-1 text-[10px] leading-tight text-content-secondary"
          data-testid="analyze-streak-goal-warning"
        >
          {t('analyze.streakGoal.changeWarning')}
        </div>
      )}
    </div>
  )
}

interface InlineNumberFieldProps {
  /** Current draft value (editing state). Updates propagate via
   * `onChange`; the parent owns the draft so co-edited fields can be
   * reset together on Esc. */
  value: number
  onChange: (v: number) => void
  /** Persisted source-of-truth the field should revert to on Esc. */
  persistedValue: number
  /** Called after Esc reverts `value` — lets the parent sync any
   * co-edited fields back to their persisted source. */
  onCancel?: () => void
  min: number
  /** `true` when the draft differs from the persisted value, so the
   * field should surface the confirm affordance. */
  confirmPending: boolean
  onCommit: () => void | Promise<void>
  ariaLabel: string
  testid: string
}

function InlineNumberField({
  value,
  onChange,
  persistedValue,
  onCancel,
  min,
  confirmPending,
  onCommit,
  ariaLabel,
  testid,
}: InlineNumberFieldProps) {
  const { t } = useTranslation()
  const [draft, setDraft] = useState(String(value))
  const inputRef = useRef<HTMLInputElement>(null)
  // Suppresses the blur-driven stageChange right after an Esc cancel —
  // without it, the blur would read the stale `draft` closure and
  // clobber the reverted parent state.
  const cancellingRef = useRef(false)

  useEffect(() => { setDraft(String(value)) }, [value])

  const parseDraft = (): number | null => {
    const parsed = Number.parseInt(draft, 10)
    return Number.isFinite(parsed) && parsed >= min ? parsed : null
  }

  const stageChange = () => {
    if (cancellingRef.current) {
      cancellingRef.current = false
      return
    }
    const parsed = parseDraft()
    if (parsed === null) {
      setDraft(String(value))
      return
    }
    if (parsed !== value) onChange(parsed)
  }

  const handleConfirm = () => {
    void onCommit()
  }

  const handleCancel = () => {
    cancellingRef.current = true
    setDraft(String(persistedValue))
    onChange(persistedValue)
    inputRef.current?.blur()
    onCancel?.()
  }

  return (
    <span className="inline-flex items-center gap-1">
      <input
        ref={inputRef}
        type="number"
        min={min}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={stageChange}
        onKeyDown={(e) => {
          if (e.key === 'Enter') stageChange()
          else if (e.key === 'Escape') handleCancel()
        }}
        aria-label={ariaLabel}
        data-testid={testid}
        className="w-20 border-b border-edge bg-transparent p-0 text-[18px] font-bold text-content outline-none focus:border-accent"
      />
      {confirmPending && (
        <button
          type="button"
          // `onMouseDown` fires before the input's blur, so clicking
          // commit never triggers a stale stageChange that would
          // unmount this button mid-click.
          onMouseDown={(e) => { e.preventDefault(); handleConfirm() }}
          className="rounded border border-accent bg-accent/10 px-1.5 py-0.5 text-[10px] text-content hover:bg-accent/20"
          data-testid={`${testid}-confirm`}
        >
          {t('analyze.streakGoal.confirm')}
        </button>
      )}
    </span>
  )
}
