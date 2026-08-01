// SPDX-License-Identifier: GPL-2.0-or-later
// The Analyze pane's trailing modals: the staged filter editor, the
// finger-assignment editor, and the CSV-export / Hub-upload modal.
// Split out of AnalyzePane.tsx (Task-split-analyze-pane, mechanical
// follow-up pass to get the pane under the 500-line cap).
//
// The filter-snapshot store panel overlay (`AnalyzeFilterStorePanel`)
// stays in AnalyzePane.tsx rather than joining this file: it's an
// `absolute inset-y-0 right-0` overlay positioned against the pane's
// own `relative` chart-area wrapper, and its outside-click handling
// closes over that same DOM subtree via `storePanelRef` — moving it
// here would resolve its absolute positioning against a different
// ancestor and change its on-screen placement, not just its file
// location.

import type { Dispatch, SetStateAction } from 'react'
import type { TypingKeyboardSummary, TypingKeymapSnapshot } from '../../../shared/types/typing-analytics'
import type { FingerType } from '../../../shared/kle/kle-ergonomics'
import type { AnalysisTabKey, RangeMs } from './analyze-types'
import type { DeviceScope, FilterDimension, IntervalViewMode } from '../../../shared/types/analyze-filters'
import { AnalyzeFilterModal, type AnalyzeFilterDraft } from './AnalyzeFilterModal'
import { FingerAssignmentModal } from './FingerAssignmentModal'
import { AnalyzeExportModal, type AnalyzeExportContext, type AnalyzeUploadCallbacks } from './AnalyzeExportModal'

export type AnalyzePaneModalState =
  | { kind: 'closed' }
  | { kind: 'export' }
  | { kind: 'upload'; entryId: string }

export interface AnalyzePaneModalsProps {
  tid: (id: string) => string
  filterModalOpen: boolean
  setFilterModalOpen: Dispatch<SetStateAction<boolean>>
  keyboards: readonly TypingKeyboardSummary[]
  loading: boolean
  analysisTab: AnalysisTabKey
  intervalViewMode: IntervalViewMode
  nowMs: number
  selectedUid: string | null
  deviceScopes: readonly DeviceScope[]
  filterDimension: FilterDimension
  rawAppScopes: readonly string[]
  rawTypingTestScopes: readonly string[]
  rawRunIdScopes: readonly string[]
  range: RangeMs
  selectedSnapshotSavedAt: number | null
  handleFilterModalApply: (draft: AnalyzeFilterDraft) => void
  fingerModalOpen: boolean
  setFingerModalOpen: Dispatch<SetStateAction<boolean>>
  effectiveSnapshot: TypingKeymapSnapshot | null
  fingerAssignments: Record<string, FingerType>
  handleFingerAssignmentsSave: (next: Record<string, FingerType>) => void
  modalState: AnalyzePaneModalState
  setModalState: Dispatch<SetStateAction<AnalyzePaneModalState>>
  exportCtx: AnalyzeExportContext | null
  modalUploadProps: AnalyzeUploadCallbacks | undefined
}

export function AnalyzePaneModals({
  tid,
  filterModalOpen,
  setFilterModalOpen,
  keyboards,
  loading,
  analysisTab,
  intervalViewMode,
  nowMs,
  selectedUid,
  deviceScopes,
  filterDimension,
  rawAppScopes,
  rawTypingTestScopes,
  rawRunIdScopes,
  range,
  selectedSnapshotSavedAt,
  handleFilterModalApply,
  fingerModalOpen,
  setFingerModalOpen,
  effectiveSnapshot,
  fingerAssignments,
  handleFingerAssignmentsSave,
  modalState,
  setModalState,
  exportCtx,
  modalUploadProps,
}: AnalyzePaneModalsProps): JSX.Element {
  return (
    <>
      {filterModalOpen && (
        <AnalyzeFilterModal
          onClose={() => setFilterModalOpen(false)}
          keyboards={keyboards}
          keyboardsLoading={loading}
          analysisTab={analysisTab}
          intervalViewMode={intervalViewMode}
          nowMs={nowMs}
          committed={{
            uid: selectedUid,
            deviceScopes,
            filterDimension,
            appScopes: rawAppScopes,
            typingTestScopes: rawTypingTestScopes,
            runIdScopes: rawRunIdScopes,
            range,
            snapshotSavedAt: selectedSnapshotSavedAt,
          }}
          onApply={handleFilterModalApply}
          tid={tid}
        />
      )}
      <FingerAssignmentModal
        isOpen={fingerModalOpen}
        onClose={() => setFingerModalOpen(false)}
        snapshot={effectiveSnapshot}
        assignments={fingerAssignments}
        onSave={handleFingerAssignmentsSave}
      />
      <AnalyzeExportModal
        isOpen={modalState.kind !== 'closed'}
        onClose={() => setModalState({ kind: 'closed' })}
        ctx={exportCtx}
        mode={modalState.kind === 'upload' ? 'upload' : 'export'}
        upload={modalUploadProps}
      />
    </>
  )
}
