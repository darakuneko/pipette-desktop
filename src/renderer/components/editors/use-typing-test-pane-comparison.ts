// SPDX-License-Identifier: GPL-2.0-or-later

import { useState, useEffect, useMemo, useCallback } from 'react'
import { computeComparison, matchingResults, conditionKey } from '../../typing-test/comparison'
import type { TypingTestResult, PooledTypingTestResult, TypingTestComparisonBaseline, TypingTestComparisonBaselines } from '../../../shared/types/pipette-settings'
import { DEFAULT_COMPARISON_BASELINE } from '../../../shared/types/pipette-settings'
import type { useTypingTest } from '../../typing-test/useTypingTest'

interface UseTypingTestPaneComparisonParams {
  typingTest: ReturnType<typeof useTypingTest>
  typingTestHistory?: TypingTestResult[]
  comparisonBaselines?: TypingTestComparisonBaselines
  onComparisonBaselineChange?: (conditionKey: string, baseline: TypingTestComparisonBaseline) => void
}

/** Measurement-row comparison pool + baseline resolution, split out of
 *  TypingTestPane (file-splitting.md cap) — see
 *  Task-split-typing-test-pane.md. Behavior-preserving: dep arrays are
 *  copied verbatim from the pre-split Pane. */
export function useTypingTestPaneComparison({
  typingTest,
  typingTestHistory,
  comparisonBaselines,
  onComparisonBaselineChange,
}: UseTypingTestPaneComparisonParams) {
  // Measurement-row comparison: pool every keyboard's saved results, then pick
  // the baseline for the current condition. Refetched when this keyboard's
  // history changes so a just-saved run joins the pool. `state.startTime`
  // excludes the in-flight run from previous/best/average.
  const [comparisonPool, setComparisonPool] = useState<PooledTypingTestResult[]>([])
  useEffect(() => {
    let cancelled = false
    window.vialAPI.pipetteSettingsListAllTypingResults()
      .then((all) => { if (!cancelled) setComparisonPool(all) })
      .catch(() => { /* best-effort: no comparison if unavailable */ })
    return () => { cancelled = true }
  }, [typingTestHistory])

  // The EFFECTIVE bias state of the current run — NOT `isWeakSpotTrainingActive
  // (typingTest.config)` (the toggle alone): a run started with the toggle on
  // but the keystroke gate not met samples normally, and
  // use-typing-test-result-save.ts only ever persists `weakSpotTrainingMode: true`
  // for a run whose OWN `state.weakSpotProfile` snapshot was actually non-null
  // (see that file's own comment). The live condition key must use the same
  // effective signal, or a gated (toggle-on, unbiased) run can never find its
  // own saved result in PB/comparison grouping — `conditionKey` would carry
  // `|weakspot` while `configKey(result)` never does for that run.
  const weakSpotActive = typingTest.state.weakSpotProfile != null

  // The baseline is remembered per condition: switching the typing-test
  // condition recalls the baseline saved for it (default: previous).
  const currentConditionKey = conditionKey(typingTest.config, typingTest.language, { weakSpotActive })
  const comparisonBaselineValue = comparisonBaselines?.[currentConditionKey] ?? DEFAULT_COMPARISON_BASELINE
  // Scope: previous/best/average compare against THIS keyboard's same-condition
  // history only; a pinned baseline can be any keyboard's result (cross-keyboard
  // pool), so the picked result resolves from the full pool.
  const comparison = useMemo(() => {
    const pool = comparisonBaselineValue.kind === 'pinned' ? comparisonPool : (typingTestHistory ?? [])
    // startTime is null before the first run; computeComparison's `beforeMs`
    // guard (`!= null`) treats null and undefined identically.
    return computeComparison(pool, typingTest.config, typingTest.language, comparisonBaselineValue, typingTest.state.startTime ?? undefined, { weakSpotActive })
  }, [comparisonPool, typingTestHistory, typingTest.config, typingTest.language, comparisonBaselineValue, typingTest.state.startTime, weakSpotActive])
  // Same-condition results only — the choices for a pinned baseline. No
  // `beforeMs`: the user is pinning a past result, not measuring a live run.
  const sameConditionResults = useMemo(
    () => matchingResults(comparisonPool, typingTest.config, typingTest.language, undefined, { weakSpotActive }),
    [comparisonPool, typingTest.config, typingTest.language, weakSpotActive],
  )
  const handleComparisonChange = useCallback(
    (baseline: TypingTestComparisonBaseline) => onComparisonBaselineChange?.(currentConditionKey, baseline),
    [onComparisonBaselineChange, currentConditionKey],
  )

  return {
    comparison,
    sameConditionResults,
    comparisonBaselineValue,
    handleComparisonChange,
  }
}
