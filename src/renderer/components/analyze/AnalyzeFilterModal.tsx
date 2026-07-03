// SPDX-License-Identifier: GPL-2.0-or-later
// Staged Analyze filter editor (Plan-analyze-filter-modal). Opened from
// `AnalyzeFilterSummaryChip`; every row here edits a *draft* copy of the
// committed filter state — nothing leaves this component until Apply
// hands the whole draft to `onApply` in one call. This mirrors
// `FingerAssignmentModal`'s local-draft pattern rather than the filter
// row's historical immediate-apply behaviour.
//
// The component is a pure draft editor: the parent passes the committed
// state in via `committed` (read once, at mount) and owns all commit
// routing inside `onApply` (same-uid batch vs uid-switch staging — see
// `AnalyzePane.handleFilterModalApply`). Mount it conditionally
// (`{open && <AnalyzeFilterModal …/>}`) so the draft re-seeds from
// committed props on every open and the option fetches only run while
// the modal is actually visible.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { ReactNode } from 'react'
import type { TypingKeyboardSummary } from '../../../shared/types/typing-analytics'
import {
  distributionForcesOwnDevice,
  type DeviceScope,
  type FilterDimension,
} from '../../../shared/types/analyze-filters'
import { DEFAULT_ANALYZE_FILTERS, type AnalyzeFiltersBatchPatch } from '../../hooks/useAnalyzeFilters'
import { useAnalyzeScopeOptions } from '../../hooks/useAnalyzeScopeOptions'
import type { AnalysisTabKey, IntervalViewMode, RangeMs } from './analyze-types'
import { useEscapeClose } from '../../hooks/useEscapeClose'
import { ModalCloseButton } from '../editors/ModalCloseButton'
import { BTN_PRIMARY, BTN_SECONDARY } from '../../constants/ui-tokens'
import { DeviceMultiSelect } from './DeviceMultiSelect'
import { AppSelect } from './AppSelect'
import { TypingTestSelect } from './TypingTestSelect'
import { RunSelect } from './RunSelect'
import { FilterDimensionToggle } from './FilterDimensionToggle'
import { RangeDayPicker } from './RangeDayPicker'
import { KeymapSnapshotTimeline } from './KeymapSnapshotTimeline'
import { clampRangeToBoundaries, getSnapshotBoundaries, rangeForSnapshot } from './clamp-range'
import { FILTER_LABEL, FILTER_SELECT } from './analyze-filter-styles'

const DAY_MS = 86_400_000
const DEFAULT_RANGE_DAYS = 7

/** Committed filter state the draft seeds from — read once at mount
 * (the modal is frozen against outside changes while open). */
export interface AnalyzeFilterModalCommitted {
  uid: string | null
  deviceScopes: readonly DeviceScope[]
  filterDimension: FilterDimension
  /** Raw (un-zeroed) scope selections, so the draft edits what the user
   * actually picked regardless of which dimension is active. */
  appScopes: readonly string[]
  typingTestScopes: readonly string[]
  runIdScopes: readonly string[]
  range: RangeMs
  snapshotSavedAt: number | null
}

/** The whole staged edit, handed to `onApply` in one call. `range` is
 * already clamped to the draft snapshot's boundaries. The parent routes
 * the commit: same uid → batch-apply + set range/snapshot; different
 * uid → stage the patch for the uid switch and let the fresh-load
 * behaviour pick range/snapshot. */
export interface AnalyzeFilterDraft {
  uid: string | null
  filtersPatch: AnalyzeFiltersBatchPatch
  range: RangeMs
  snapshotSavedAt: number | null
}

interface Props {
  onClose: () => void
  keyboards: readonly TypingKeyboardSummary[]
  keyboardsLoading: boolean
  analysisTab: AnalysisTabKey
  intervalViewMode: IntervalViewMode
  nowMs: number
  committed: AnalyzeFilterModalCommitted
  onApply: (draft: AnalyzeFilterDraft) => void
  /** Pane-scoped testid prefixer (`-b` suffix for pane B). Row testids
   * reuse the historical (pre-modal) ids so existing selectors mostly
   * keep working — only the *location* moved. */
  tid: (id: string) => string
}

interface ModalRowProps {
  testId?: string
  /** Renders a `FILTER_LABEL` shell around the children. Omit for rows
   * whose control brings its own label (RangeDayPicker,
   * KeymapSnapshotTimeline). */
  label?: string
  /** When set, replaces the control with a muted explanatory note —
   * the "this filter can't apply on the current tab/view" state. */
  disabledNote?: string | null
  noteTestId?: string
  children?: ReactNode
}

function ModalRow({ testId, label, disabledNote, noteTestId, children }: ModalRowProps) {
  return (
    <div
      className="flex items-center justify-between gap-3 border-b border-edge-subtle py-2.5 last:border-b-0"
      data-testid={testId}
    >
      {label !== undefined ? (
        <label className={FILTER_LABEL}>
          <span>{label}</span>
          {disabledNote ? (
            <span className="text-xs text-content-muted" data-testid={noteTestId}>
              {disabledNote}
            </span>
          ) : children}
        </label>
      ) : children}
    </div>
  )
}

export function AnalyzeFilterModal({
  onClose,
  keyboards,
  keyboardsLoading,
  analysisTab,
  intervalViewMode,
  nowMs,
  committed,
  onApply,
  tid,
}: Props) {
  const { t } = useTranslation()
  useEscapeClose(onClose)

  // Draft state seeds from the committed snapshot at mount; the parent
  // mounts this component fresh on every open, so no reseed effect is
  // needed and a cancelled edit can never leak into the next open.
  const [draftUid, setDraftUid] = useState<string | null>(committed.uid)
  const [draftDeviceScopes, setDraftDeviceScopes] = useState<DeviceScope[]>(() => [...committed.deviceScopes])
  const [draftFilterDimension, setDraftFilterDimension] = useState<FilterDimension>(committed.filterDimension)
  const [draftAppScopes, setDraftAppScopes] = useState<string[]>(() => [...committed.appScopes])
  const [draftTypingTestScopes, setDraftTypingTestScopes] = useState<string[]>(() => [...committed.typingTestScopes])
  const [draftRunIdScopes, setDraftRunIdScopes] = useState<string[]>(() => [...committed.runIdScopes])
  const [draftSnapshotSavedAt, setDraftSnapshotSavedAt] = useState<number | null>(committed.snapshotSavedAt)
  const [draftRange, setDraftRange] = useState<RangeMs>(committed.range)
  // Tracks which uid the "jump to latest snapshot" auto-set has already
  // run for, mirroring `AnalyzePane`'s own `autoSetRangeForUidRef`. Starts
  // at the committed uid (its range/snapshot already reflect the load);
  // reset to `null` on keyboard change / Reset so the effect below
  // re-derives the Period + Keymap preview for the draft's new uid.
  const autoRangeUidRef = useRef<string | null>(committed.uid)

  const draftScope = useAnalyzeScopeOptions(draftUid)

  const resetDraftScopeFields = useCallback(() => {
    setDraftDeviceScopes([...DEFAULT_ANALYZE_FILTERS.deviceScopes])
    setDraftAppScopes([...DEFAULT_ANALYZE_FILTERS.appScopes])
    setDraftTypingTestScopes([...DEFAULT_ANALYZE_FILTERS.typingTestScopes])
    setDraftRunIdScopes([...DEFAULT_ANALYZE_FILTERS.runIdScopes])
    setDraftSnapshotSavedAt(null)
    autoRangeUidRef.current = null
  }, [])

  // Reseed device / source / keymap / range to this keyboard's own
  // defaults when the user picks a different keyboard inside the modal —
  // scopes picked for the previous keyboard may not even apply here.
  // The dimension toggle keeps the user's pick (it's keyboard-agnostic).
  const handleDraftUidChange = useCallback((nextUid: string | null) => {
    setDraftUid(nextUid)
    resetDraftScopeFields()
  }, [resetDraftScopeFields])

  // "Jump to latest snapshot" preview for the draft uid, once its
  // snapshot list resolves — mirrors `AnalyzePane`'s mount/uid-switch
  // behaviour so the Period / Keymap rows show what a fresh load of that
  // keyboard would actually look like.
  useEffect(() => {
    if (!draftUid) return
    if (draftScope.summariesLoading) return
    if (autoRangeUidRef.current === draftUid) return
    autoRangeUidRef.current = draftUid
    if (draftScope.snapshotSummaries.length === 0) {
      setDraftRange({ fromMs: nowMs - DAY_MS * DEFAULT_RANGE_DAYS, toMs: nowMs })
      return
    }
    const latest = draftScope.snapshotSummaries[draftScope.snapshotSummaries.length - 1]
    setDraftRange({ fromMs: latest.savedAt, toMs: nowMs })
    setDraftSnapshotSavedAt(latest.savedAt)
  }, [draftUid, draftScope.snapshotSummaries, draftScope.summariesLoading, nowMs])

  const draftSnapshotBoundaries = useMemo(
    () => getSnapshotBoundaries(draftSnapshotSavedAt, draftScope.snapshotSummaries, nowMs),
    [draftSnapshotSavedAt, draftScope.snapshotSummaries, nowMs],
  )

  const handleDraftSelectSnapshot = useCallback((savedAt: number) => {
    const snapshotRange = rangeForSnapshot(savedAt, draftScope.snapshotSummaries, nowMs)
    if (snapshotRange === null) return
    setDraftSnapshotSavedAt(savedAt)
    setDraftRange(snapshotRange)
  }, [draftScope.snapshotSummaries, nowMs])

  const handleReset = useCallback(() => {
    setDraftFilterDimension(DEFAULT_ANALYZE_FILTERS.filterDimension)
    resetDraftScopeFields()
  }, [resetDraftScopeFields])

  const handleApply = useCallback(() => {
    onApply({
      uid: draftUid,
      filtersPatch: {
        deviceScopes: draftDeviceScopes,
        filterDimension: draftFilterDimension,
        appScopes: draftAppScopes,
        typingTestScopes: draftTypingTestScopes,
        runIdScopes: draftRunIdScopes,
      },
      // Pre-clamp synchronously (mirrors the pane's own snapshot-select
      // behaviour) so the parent never has to run a follow-up clamp
      // effect against a range that straddles a keymap edit.
      range: clampRangeToBoundaries(draftRange, draftSnapshotBoundaries),
      snapshotSavedAt: draftSnapshotSavedAt,
    })
    onClose()
  }, [
    draftUid, draftDeviceScopes, draftFilterDimension, draftAppScopes, draftTypingTestScopes,
    draftRunIdScopes, draftRange, draftSnapshotBoundaries, draftSnapshotSavedAt,
    onApply, onClose,
  ])

  // Source is meaningless on By App (its charts aggregate across every
  // source and consume only uid/range/device). Interval's Distribution
  // view forces the DEVICE to `'own'` but still applies the App /
  // TypingTest / Run scopes (see `IntervalChart`'s
  // `listMinuteStatsForScope` call), so only the Device row is disabled
  // there — Source stays editable.
  const distributionActive = analysisTab === 'interval' && distributionForcesOwnDevice(intervalViewMode)
  const sourceDisabledNote = analysisTab === 'byApp' ? t('analyze.filters.sourceDisabledByApp') : null
  const deviceDisabledNote = distributionActive ? t('analyze.filters.distributionDisabledNote') : null

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
      data-testid={tid('analyze-filter-modal')}
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={tid('analyze-filter-modal-title')}
        className="w-modal-md max-w-modal-vw max-h-modal-80vh overflow-y-auto rounded-2xl border border-edge bg-surface-alt p-6 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-4 flex items-center justify-between">
          <h3 id={tid('analyze-filter-modal-title')} className="text-lg font-semibold">
            {t('analyze.filters.editConditions')}
          </h3>
          <ModalCloseButton testid={tid('analyze-filter-modal-close')} onClick={onClose} />
        </div>

        <div className="flex flex-col">
          <ModalRow testId={tid('analyze-filter-modal-keyboard-row')} label={t('analyze.filters.keyboard')}>
            <select
              className={FILTER_SELECT}
              value={draftUid ?? ''}
              onChange={(e) => handleDraftUidChange(e.target.value || null)}
              disabled={keyboardsLoading || keyboards.length === 0}
              aria-label={t('analyze.filters.keyboard')}
              data-testid={tid('analyze-filter-keyboard')}
            >
              {keyboardsLoading ? (
                <option value="">{t('common.loading')}</option>
              ) : keyboards.length === 0 ? (
                <option value="" data-testid={tid('analyze-no-keyboards')}>{t('analyze.noKeyboards')}</option>
              ) : (
                <>
                  {draftUid === null && (
                    <option value="">{t('analyze.selectKeyboard')}</option>
                  )}
                  {keyboards.map((kb) => (
                    <option key={kb.uid} value={kb.uid} data-testid={tid(`analyze-kb-${kb.uid}`)}>
                      {kb.productName || kb.uid}
                    </option>
                  ))}
                </>
              )}
            </select>
          </ModalRow>

          {draftUid && (
            <>
              <ModalRow
                testId={tid('analyze-filter-modal-device-row')}
                label={t('analyze.filters.device')}
                disabledNote={deviceDisabledNote}
                noteTestId={tid('analyze-filter-device-disabled-note')}
              >
                <DeviceMultiSelect
                  value={draftDeviceScopes}
                  ownDevice={draftScope.deviceInfos.own}
                  remoteDevices={draftScope.deviceInfos.remotes}
                  onChange={setDraftDeviceScopes}
                  ariaLabel={t('analyze.filters.device')}
                  testId={tid('analyze-filter-device')}
                />
              </ModalRow>

              <ModalRow
                testId={tid('analyze-filter-modal-source-row')}
                label={t('analyze.filters.sourceLabel')}
                disabledNote={sourceDisabledNote}
                noteTestId={tid('analyze-filter-source-disabled-note')}
              >
                <div className="flex min-w-0 items-center gap-2">
                  <FilterDimensionToggle
                    value={draftFilterDimension}
                    onChange={setDraftFilterDimension}
                    testId={tid('analyze-filter-dimension')}
                  />
                  {draftFilterDimension === 'typingTest' ? (
                    <>
                      <TypingTestSelect
                        uid={draftUid}
                        range={draftRange}
                        deviceScopes={draftDeviceScopes}
                        value={draftTypingTestScopes}
                        onChange={setDraftTypingTestScopes}
                        ariaLabel={t('analyze.filters.typingTest')}
                        testId={tid('analyze-filter-typing-test')}
                      />
                      {draftTypingTestScopes.length > 0 && (
                        <RunSelect
                          uid={draftUid}
                          range={draftRange}
                          deviceScopes={draftDeviceScopes}
                          materialScopes={draftTypingTestScopes}
                          value={draftRunIdScopes}
                          onChange={setDraftRunIdScopes}
                          ariaLabel={t('analyze.filters.run')}
                          testId={tid('analyze-filter-run')}
                        />
                      )}
                    </>
                  ) : (
                    <AppSelect
                      uid={draftUid}
                      range={draftRange}
                      deviceScopes={draftDeviceScopes}
                      value={draftAppScopes}
                      onChange={setDraftAppScopes}
                      ariaLabel={t('analyze.filters.app')}
                      testId={tid('analyze-filter-app')}
                    />
                  )}
                </div>
              </ModalRow>

              {draftScope.snapshotSummaries.length > 0 && (
                <ModalRow testId={tid('analyze-filter-modal-keymap-row')}>
                  <KeymapSnapshotTimeline
                    summaries={draftScope.snapshotSummaries}
                    selectedSavedAt={draftSnapshotSavedAt}
                    onSelectSnapshot={handleDraftSelectSnapshot}
                    testId={tid('analyze-snapshot-timeline')}
                  />
                </ModalRow>
              )}

              <ModalRow testId={tid('analyze-filter-modal-period-row')}>
                <RangeDayPicker
                  range={draftRange}
                  snapshotBoundaries={draftSnapshotBoundaries}
                  nowMs={nowMs}
                  onChange={setDraftRange}
                  labelKey="analyze.filters.period"
                  testIdPrefix={tid('analyze-filter-range')}
                />
              </ModalRow>
            </>
          )}
        </div>

        {/* Footer follows the shared modal idiom (ResultNameModal,
            AnalyzeExportModal, TypingRecordingConsentModal): right-aligned
            [secondary][primary] with the primary labeled Save. */}
        <div className="mt-5 flex items-center justify-end gap-2 border-t border-edge pt-4">
          <button
            type="button"
            className={BTN_SECONDARY}
            onClick={handleReset}
            data-testid={tid('analyze-filter-modal-reset')}
          >
            {t('common.reset')}
          </button>
          <button
            type="button"
            className={BTN_PRIMARY}
            onClick={handleApply}
            data-testid={tid('analyze-filter-modal-apply')}
          >
            {t('common.save')}
          </button>
        </div>
      </div>
    </div>
  )
}
