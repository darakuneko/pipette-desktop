// SPDX-License-Identifier: GPL-2.0-or-later
// Shared, dimension-aware label builder for the Analyze filter summary
// chip + the staged filter modal (Plan-analyze-filter-modal). Both
// surfaces need to render the same four human-readable strings —
// keyboard / device / source / period — from the same filter state, so
// the resolution logic lives here once instead of being duplicated (or
// drifting) between the chip and the modal.
//
// `AnalyzeExportModal`'s `exportCtx.conditions` (AnalyzePane.tsx) builds
// a *similar* but not equivalent set of labels for the CSV/upload
// context echo: notably it ignores `filterDimension` entirely and always
// reports the App selection, even while the TypingTest dimension is
// active. That mismatch is why this is a fresh module rather than an
// import of the export context's logic — `sourceLabel` here is
// dimension-aware on purpose.
//
// Pure by design: run-id labels aren't resolvable without an IPC call
// (`RunSelect` fetches `typingTestResults` for the name), so callers
// resolve run ids to display names themselves and pass the resolved
// strings in via `runLabels`.

import type { TFunction } from 'i18next'
import {
  isAllScope,
  isHashScope,
  type DeviceScope,
  type FilterDimension,
} from '../../../shared/types/analyze-filters'
import type { TypingAnalyticsDeviceInfo } from '../../../shared/types/typing-analytics'
import type { RangeMs } from './analyze-types'
import { formatDeviceLabel } from './DeviceMultiSelect'
import { formatDateTime } from '../editors/store-modal-shared'

/** Placeholder for a label with nothing to show (no keyboard selected,
 * no keymap snapshot, ...). Matches the existing em-dash convention used
 * by `AnalyzePane`'s `exportCtx.conditions.keymap` fallback rather than
 * introducing a translated string for what is a formatting glyph, not
 * language content. */
const EMPTY_LABEL = '—'

/** Glyph joining a TypingTest source label to its run qualifier (e.g.
 * `words (english) · 2026-04-01, 2026-04-03`). Mirrors the middot the
 * mockup uses to join the summary chip's own segments
 * (`keyboard · device · source · period`) — a layout separator, not
 * translated text, so it doesn't need an i18n key. */
const SOURCE_RUN_SEPARATOR = ' · '

export interface FilterConditionLabelInputs {
  /** `null` when no keyboard is selected yet (e.g. an empty keyboards list). */
  keyboardName: string | null
  deviceScope: DeviceScope
  deviceInfos: {
    own: TypingAnalyticsDeviceInfo | null
    remotes: readonly TypingAnalyticsDeviceInfo[]
  }
  filterDimension: FilterDimension
  /** App-scope selection to summarize. Pass the raw (un-zeroed)
   * selection to describe what the user picked regardless of which
   * dimension is active, or the effective (zeroed) selection to
   * describe what's actually filtering — callers pick based on whether
   * they're rendering an editable control (raw) or a read-only summary
   * (effective). */
  appScopes: readonly string[]
  /** TypingTest-scope selection — see `appScopes` for raw-vs-effective. */
  typingTestScopes: readonly string[]
  /** Resolved (human-readable) run names for the currently-selected run
   * ids — already looked up by the caller (see module doc comment).
   * Empty = no run filter applied / not applicable. */
  runLabels: readonly string[]
  range: RangeMs
}

export interface FilterConditionLabels {
  keyboardLabel: string
  deviceLabel: string
  /** Dimension-aware: the App selection while `filterDimension === 'app'`,
   * the TypingTest selection (+ run qualifier) while `'typingTest'`. */
  sourceLabel: string
  periodLabel: string
}

/** `{{first}} +{{rest}}` summary shared by every Analyze multi-select
 * (App / TypingTest / Run) — the same rule `MultiSelectPopover`'s trigger
 * button already applies, reimplemented here since the modal/chip render
 * outside of any single `MultiSelectPopover` instance. */
function buildMultiSelectLabel(t: TFunction, i18nPrefix: string, labels: readonly string[]): string {
  if (labels.length === 0) return t(`${i18nPrefix}.none`)
  if (labels.length === 1) return labels[0]
  return t(`${i18nPrefix}.multi`, { first: labels[0], rest: labels.length - 1 })
}

/** Human-readable Device label for a scope. Exported so `AnalyzePane`'s
 * export context echoes the exact same string as the summary chip (the
 * two used to re-implement this and drifted on the missing-hash
 * fallback). */
export function buildDeviceLabel(
  t: TFunction,
  deviceScope: DeviceScope,
  deviceInfos: FilterConditionLabelInputs['deviceInfos'],
): string {
  if (isAllScope(deviceScope)) return t('analyze.filters.deviceOption.all')
  if (isHashScope(deviceScope)) {
    const remote = deviceInfos.remotes.find((r) => r.machineHash === deviceScope.machineHash)
    return remote ? formatDeviceLabel(remote) : t('analyze.filters.deviceOption.own')
  }
  return deviceInfos.own !== null ? formatDeviceLabel(deviceInfos.own) : t('analyze.filters.deviceOption.own')
}

/** `from - to` period string shared by the chip, the modal, and the
 * export context's range echo. */
export function buildPeriodLabel(range: RangeMs): string {
  return `${formatDateTime(range.fromMs)} - ${formatDateTime(range.toMs)}`
}

function buildSourceLabel(t: TFunction, inputs: FilterConditionLabelInputs): string {
  if (inputs.filterDimension !== 'typingTest') {
    return buildMultiSelectLabel(t, 'analyze.filters.appOption', inputs.appScopes)
  }
  const testLabel = buildMultiSelectLabel(t, 'analyze.filters.typingTestOption', inputs.typingTestScopes)
  // The run qualifier is a sub-filter of the TypingTest selection — it
  // only makes sense to show once a material is actually picked (mirrors
  // `useAnalyzeFilters`' own "runIdScopes only applies with a material
  // selected" rule).
  if (inputs.typingTestScopes.length === 0 || inputs.runLabels.length === 0) return testLabel
  const runLabel = buildMultiSelectLabel(t, 'analyze.filters.runOption', inputs.runLabels)
  return `${testLabel}${SOURCE_RUN_SEPARATOR}${runLabel}`
}

/** Build the four Analyze filter summary labels from filter state +
 * already-resolved names. See the module doc comment for why this is a
 * fresh implementation rather than a reuse of `exportCtx.conditions`. */
export function buildFilterConditionLabels(
  t: TFunction,
  inputs: FilterConditionLabelInputs,
): FilterConditionLabels {
  return {
    keyboardLabel: inputs.keyboardName ?? EMPTY_LABEL,
    deviceLabel: buildDeviceLabel(t, inputs.deviceScope, inputs.deviceInfos),
    sourceLabel: buildSourceLabel(t, inputs),
    periodLabel: buildPeriodLabel(inputs.range),
  }
}
