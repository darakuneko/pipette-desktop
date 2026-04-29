// SPDX-License-Identifier: GPL-2.0-or-later
// Goal achievements modal — lists every completed goal cycle (from
// detectGoalAchievements) in reverse chronological order. Triggered
// from the longest-streak card's History button on the Activity tab.

import { useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { ModalCloseButton } from '../editors/ModalCloseButton'
import type { GoalAchievement } from './analyze-streak-goal'

interface Props {
  isOpen: boolean
  onClose: () => void
  achievements: ReadonlyArray<GoalAchievement>
}

export function GoalAchievementsModal({ isOpen, onClose, achievements }: Props) {
  const { t } = useTranslation()

  useEffect(() => {
    if (!isOpen) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [isOpen, onClose])

  if (!isOpen) return null

  const rows = [...achievements].reverse()

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
      data-testid="analyze-goal-achievements-modal"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="goal-achievements-title"
        className="w-[720px] max-w-[95vw] max-h-[90vh] flex flex-col rounded-2xl bg-surface-alt border border-edge shadow-xl overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-5 pt-4 pb-2 shrink-0">
          <h2 id="goal-achievements-title" className="text-lg font-bold text-content">
            {t('analyze.streakGoal.historyTitle')}
          </h2>
          <ModalCloseButton testid="analyze-goal-achievements-close" onClick={onClose} />
        </div>
        <div className="flex-1 min-h-0 overflow-auto px-5 py-3">
          {rows.length === 0 ? (
            <div
              className="py-8 text-center text-[13px] text-content-muted"
              data-testid="analyze-goal-achievements-empty"
            >
              {t('analyze.streakGoal.historyEmpty')}
            </div>
          ) : (
            <table className="w-full text-left text-[12px]" data-testid="analyze-goal-achievements-table">
              <thead>
                <tr className="border-b border-edge text-[11px] uppercase tracking-wider text-content-muted">
                  <th className="py-2 pr-3 font-semibold">{t('analyze.streakGoal.historyColumn.period')}</th>
                  <th className="py-2 pr-3 font-semibold">{t('analyze.streakGoal.historyColumn.goal')}</th>
                  <th className="py-2 pr-3 text-right font-semibold">{t('analyze.streakGoal.historyColumn.days')}</th>
                  <th className="py-2 pr-3 text-right font-semibold">{t('analyze.streakGoal.historyColumn.total')}</th>
                  <th className="py-2 text-right font-semibold">{t('analyze.streakGoal.historyColumn.average')}</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((entry, idx) => (
                  <tr key={`${entry.startDate}-${entry.endDate}-${idx}`} className="border-b border-edge/60 last:border-b-0">
                    <td className="py-2 pr-3 text-content">
                      {t('analyze.streakGoal.historyPeriod', {
                        start: entry.startDate,
                        end: entry.endDate,
                      })}
                    </td>
                    <td className="py-2 pr-3 text-content-secondary">
                      {t('analyze.streakGoal.historyGoal', {
                        days: entry.goal.days,
                        keystrokes: entry.goal.keystrokes.toLocaleString(),
                      })}
                    </td>
                    <td className="py-2 pr-3 text-right font-medium text-content">
                      {entry.consecutiveDays}
                    </td>
                    <td className="py-2 pr-3 text-right font-medium text-content">
                      {entry.keystrokesTotal.toLocaleString()}
                    </td>
                    <td className="py-2 text-right text-content">
                      {entry.averagePerDay.toLocaleString()}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </div>
  )
}
