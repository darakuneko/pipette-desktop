// SPDX-License-Identifier: GPL-2.0-or-later

import { describe, expect, it } from 'vitest'
import type { GoalHistoryEntry } from '../../../../shared/types/pipette-settings'
import type { TypingDailySummary } from '../../../../shared/types/typing-analytics'
import {
  byDate,
  calcGoalCycleProgress,
  calcLongestStreak,
  daysBetween,
  detectGoalAchievements,
  resolveGoalAt,
  shiftLocalDate,
  toLocalDate,
  type GoalPair,
} from '../analyze-streak-goal'

const day = (date: string, keystrokes: number): TypingDailySummary => ({
  date,
  keystrokes,
  activeMs: 0,
})

const mapOf = (rows: TypingDailySummary[]): Map<string, number> => byDate(rows)

const G = (days: number, keystrokes: number): GoalPair => ({ days, keystrokes })

describe('toLocalDate / shiftLocalDate / daysBetween', () => {
  it('pads single-digit month/day', () => {
    const ms = new Date(2026, 0, 5, 7).getTime()
    expect(toLocalDate(ms)).toBe('2026-01-05')
  })
  it('shifts across month and year boundaries', () => {
    expect(shiftLocalDate('2026-03-01', -1)).toBe('2026-02-28')
    expect(shiftLocalDate('2026-12-31', 1)).toBe('2027-01-01')
  })
  it('daysBetween is inclusive and order-insensitive', () => {
    expect(daysBetween('2026-04-01', '2026-04-01')).toBe(1)
    expect(daysBetween('2026-04-03', '2026-04-01')).toBe(3)
  })
})

describe('byDate', () => {
  it('sums duplicate dates into one bucket', () => {
    const m = byDate([day('2026-04-22', 100), day('2026-04-22', 50)])
    expect(m.get('2026-04-22')).toBe(150)
  })
})

describe('resolveGoalAt', () => {
  const current = G(15, 2000)

  it('returns currentGoal when history is empty', () => {
    expect(resolveGoalAt([], current, '2026-05-14')).toEqual(current)
  })

  it('returns retired value for dates before its retirement', () => {
    const history: GoalHistoryEntry[] = [
      { days: 10, keystrokes: 1000, effectiveFrom: '2026-05-15T10:00:00+09:00' },
    ]
    expect(resolveGoalAt(history, current, '2026-05-14')).toEqual(G(10, 1000))
  })

  it('returns currentGoal on and after retirement date', () => {
    const history: GoalHistoryEntry[] = [
      { days: 10, keystrokes: 1000, effectiveFrom: '2026-05-15T10:00:00+09:00' },
    ]
    expect(resolveGoalAt(history, current, '2026-05-15')).toEqual(current)
    expect(resolveGoalAt(history, current, '2026-05-16')).toEqual(current)
  })

  it('picks the entry closest to (just after) the target among multiple', () => {
    const history: GoalHistoryEntry[] = [
      { days: 10, keystrokes: 1000, effectiveFrom: '2026-05-15T10:00:00+09:00' },
      { days: 15, keystrokes: 2000, effectiveFrom: '2026-08-01T10:00:00+09:00' },
    ]
    const cur = G(7, 500)
    expect(resolveGoalAt(history, cur, '2026-04-01')).toEqual(G(10, 1000))
    expect(resolveGoalAt(history, cur, '2026-06-15')).toEqual(G(15, 2000))
    expect(resolveGoalAt(history, cur, '2026-09-01')).toEqual(cur)
  })
})

describe('calcLongestStreak', () => {
  const cur = G(10, 1000)

  it('returns 0 for empty map', () => {
    expect(calcLongestStreak(new Map(), [], cur)).toBe(0)
  })

  it('finds the longest run anywhere in history', () => {
    const m = mapOf([
      day('2026-04-10', 2000),
      day('2026-04-11', 2000),
      day('2026-04-12', 2000),
      day('2026-04-13', 2000),
      day('2026-04-14', 500),
      day('2026-04-15', 1500),
      day('2026-04-16', 1500),
    ])
    expect(calcLongestStreak(m, [], cur)).toBe(4)
  })

  it('respects per-date goal via history', () => {
    // On 2026-04-14 goal was 500 (retired), on 2026-04-15 goal is 1000 (current).
    const history: GoalHistoryEntry[] = [
      { days: 10, keystrokes: 500, effectiveFrom: '2026-04-15T00:00:00+09:00' },
    ]
    const m = mapOf([
      day('2026-04-14', 700), // hits 500 → goal-met under old rule
      day('2026-04-15', 700), // misses 1000 → not hit under new rule
    ])
    expect(calcLongestStreak(m, history, cur)).toBe(1)
  })

  it('calendar gaps break the run', () => {
    const m = mapOf([
      day('2026-04-20', 2000),
      day('2026-04-22', 2000),
      day('2026-04-23', 2000),
    ])
    expect(calcLongestStreak(m, [], cur)).toBe(2)
  })
})

describe('detectGoalAchievements', () => {
  const cur = G(3, 1000)

  it('emits one entry when the run hits goalDays', () => {
    const m = mapOf([
      day('2026-04-20', 1500),
      day('2026-04-21', 1200),
      day('2026-04-22', 1800),
    ])
    const out = detectGoalAchievements(m, [], cur)
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({
      startDate: '2026-04-20',
      endDate: '2026-04-22',
      consecutiveDays: 3,
      keystrokesTotal: 4500,
      averagePerDay: 1500,
      goal: { days: 3, keystrokes: 1000 },
    })
  })

  it('resets and starts a new cycle after achievement', () => {
    const m = mapOf([
      day('2026-04-20', 1200),
      day('2026-04-21', 1200),
      day('2026-04-22', 1200),
      day('2026-04-23', 1200),
      day('2026-04-24', 1200),
      day('2026-04-25', 1200),
    ])
    const out = detectGoalAchievements(m, [], cur)
    expect(out).toHaveLength(2)
    expect(out[0].startDate).toBe('2026-04-20')
    expect(out[0].endDate).toBe('2026-04-22')
    expect(out[1].startDate).toBe('2026-04-23')
    expect(out[1].endDate).toBe('2026-04-25')
  })

  it('goal change mid-run invalidates the in-progress run', () => {
    // goal was 500 until 2026-05-15, then 2000
    const history: GoalHistoryEntry[] = [
      { days: 3, keystrokes: 500, effectiveFrom: '2026-05-15T00:00:00+09:00' },
    ]
    const current = G(3, 2000)
    const m = mapOf([
      day('2026-05-13', 700), // hits old 500
      day('2026-05-14', 700), // hits old 500
      day('2026-05-15', 2500), // hits new 2000, but run reset here
      day('2026-05-16', 2500),
      day('2026-05-17', 2500),
    ])
    const out = detectGoalAchievements(m, history, current)
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({
      startDate: '2026-05-15',
      endDate: '2026-05-17',
      goal: { days: 3, keystrokes: 2000 },
    })
  })

  it('does not emit runs that are still in progress', () => {
    const m = mapOf([
      day('2026-04-20', 1200),
      day('2026-04-21', 1200),
    ])
    expect(detectGoalAchievements(m, [], cur)).toEqual([])
  })
})

describe('calcGoalCycleProgress', () => {
  const cur = G(10, 1000)

  it('returns current=0 with empty map', () => {
    expect(calcGoalCycleProgress(new Map(), [], cur, '2026-04-24'))
      .toEqual({ current: 0, goalDays: 10 })
  })

  it('counts a live run that reaches today', () => {
    const m = mapOf([
      day('2026-04-22', 1500),
      day('2026-04-23', 1500),
      day('2026-04-24', 1500),
    ])
    expect(calcGoalCycleProgress(m, [], cur, '2026-04-24'))
      .toEqual({ current: 3, goalDays: 10 })
  })

  it('yesterday still counts when today is missing', () => {
    const m = mapOf([
      day('2026-04-22', 1500),
      day('2026-04-23', 1500),
    ])
    expect(calcGoalCycleProgress(m, [], cur, '2026-04-24'))
      .toEqual({ current: 2, goalDays: 10 })
  })

  it('drops stale runs that ended 2+ days ago', () => {
    const m = mapOf([
      day('2026-04-20', 1500),
      day('2026-04-21', 1500),
    ])
    expect(calcGoalCycleProgress(m, [], cur, '2026-04-24'))
      .toEqual({ current: 0, goalDays: 10 })
  })

  it('resets after completing an achievement cycle', () => {
    const cycleGoal = G(3, 1000)
    const m = mapOf([
      day('2026-04-22', 1500),
      day('2026-04-23', 1500),
      day('2026-04-24', 1500),
    ])
    // 3/3 cycle completed at today → current cycle back to 0
    expect(calcGoalCycleProgress(m, [], cycleGoal, '2026-04-24'))
      .toEqual({ current: 0, goalDays: 3 })
  })

  it('after an achievement, fresh hits count toward the next cycle', () => {
    const cycleGoal = G(3, 1000)
    const m = mapOf([
      day('2026-04-20', 1500), // cycle 1
      day('2026-04-21', 1500),
      day('2026-04-22', 1500), // cycle 1 done
      day('2026-04-23', 1500), // cycle 2 starts
      day('2026-04-24', 1500),
    ])
    expect(calcGoalCycleProgress(m, [], cycleGoal, '2026-04-24'))
      .toEqual({ current: 2, goalDays: 3 })
  })

  it('goal change resets the in-progress run', () => {
    const history: GoalHistoryEntry[] = [
      { days: 3, keystrokes: 500, effectiveFrom: '2026-04-24T10:00:00+09:00' },
    ]
    const current = G(3, 2000)
    const m = mapOf([
      day('2026-04-22', 700),  // hits old 500
      day('2026-04-23', 700),  // hits old 500 (streak 2)
      day('2026-04-24', 2500), // new goal takes effect, run reset, streak = 1
    ])
    expect(calcGoalCycleProgress(m, history, current, '2026-04-24'))
      .toEqual({ current: 1, goalDays: 3 })
  })
})
