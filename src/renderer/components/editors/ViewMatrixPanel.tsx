// SPDX-License-Identifier: GPL-2.0-or-later

import { useState } from 'react'
import { useTranslation } from 'react-i18next'
// Second consumer of the settings-modal 2-step confirm (fully prop-driven,
// so the domain name is the only oddity). If a third consumer appears,
// extract it to a generically named shared component instead.
import { DisconnectConfirmButton } from '../settings-modal/DisconnectConfirmButton'

const SELECT_CLASS = 'rounded border border-edge bg-surface px-2 py-1 text-sm text-content focus:border-accent focus:outline-none disabled:opacity-50'

type ViewMatrixAxis = 'row' | 'col'

interface AxisSelectProps {
  label: string
  axis: ViewMatrixAxis
  /** Effective value of the single selected key — ignored (blank
   *  placeholder shown) unless `showValue` is true. */
  value: number
  /** Number of options: `0 .. optionCount - 1`, from the keyboard
   *  definition's Vial matrix dimension for this axis. */
  optionCount: number
  disabled: boolean
  showValue: boolean
  blankLabel: string
  onChange: (axis: ViewMatrixAxis, value: number) => void
}

/** One Row/Col dropdown — the two axes render identically apart from the
 *  label, value, option range, and which axis the change reports. */
function AxisSelect({ label, axis, value, optionCount, disabled, showValue, blankLabel, onChange }: AxisSelectProps) {
  return (
    <label className="flex flex-col gap-1 text-xs text-content-secondary">
      {label}
      <select
        value={showValue ? value : ''}
        onChange={(e) => onChange(axis, Number(e.target.value))}
        disabled={disabled}
        className={SELECT_CLASS}
        data-testid={`view-matrix-${axis}-select`}
      >
        {!showValue && <option value="">{blankLabel}</option>}
        {Array.from({ length: optionCount }, (_, i) => (
          <option key={i} value={i}>{i}</option>
        ))}
      </select>
    </label>
  )
}

export interface ViewMatrixPanelProps {
  onReset: () => void
  /** Exits View Matrix mode. The keycode picker (and with it the overlay
   *  panel's own Edit/Done button) is hidden for the duration of the mode,
   *  so this panel's toggle — rendered permanently in its ON ("Done")
   *  state while mounted — is the only way back to normal editing. */
  onToggle: () => void
  /** Number of keys currently selected for editing (0, 1, or many). */
  selectionCount: number
  /** Effective (override ?? physical) position of the single selected key.
   *  Only meaningful when `selectionCount === 1` — with 0 or 2+ keys
   *  selected, the selects fall back to a blank placeholder instead. */
  effectiveRow: number
  effectiveCol: number
  /** Row/Col select option ranges, from the keyboard definition's Vial
   *  matrix dimensions (`0 .. count - 1`). */
  matrixRows: number
  matrixCols: number
  /** Saves the picked value on one axis for the whole selection —
   *  immediately, there is no separate Save step. */
  onAxisChange: (axis: ViewMatrixAxis, value: number) => void
  /** Count of keys whose effective view position collides with another
   *  key's — 0 hides the warning. Computed by `KeymapEditor`'s duplicate
   *  detection pass, which also drives the matching key fill on the
   *  keymap itself (see `view-matrix.ts`'s `effectiveViewPos`). */
  duplicateCount: number
}

/**
 * Replaces the layer selector panel while View Matrix mode is active — layer
 * switching is disabled for the duration of the mode (see
 * `useViewMatrixMode`), and the keycode picker area is hidden entirely, so
 * this panel becomes the mode's whole left pane: the mode label, the Edit
 * toggle that exits the mode, Row/Col selects that edit the current
 * selection's view position immediately (no Save step), an optional
 * duplicate-position warning, and — at the bottom — a 2-step confirm
 * (mirrors `DisconnectConfirmButton`'s existing pattern) to clear the saved
 * position overrides and fall back to the physical Vial matrix.
 */
export function ViewMatrixPanel({
  onReset, onToggle, selectionCount, effectiveRow, effectiveCol,
  matrixRows, matrixCols, onAxisChange, duplicateCount,
}: ViewMatrixPanelProps) {
  const { t } = useTranslation()
  const [confirming, setConfirming] = useState(false)

  const hasSelection = selectionCount > 0
  // A single selected key shows its own value; 0 or 2+ selected keys show
  // the blank placeholder (2+ may not share the same effective position).
  const showValue = selectionCount === 1
  const blankLabel = t('editor.viewMatrix.blankOption')

  return (
    <div
      className="flex w-44 shrink-0 self-stretch flex-col gap-2 rounded-xl border border-edge bg-picker-bg p-3"
      data-testid="view-matrix-reset-panel"
    >
      <div className="flex items-center justify-between gap-2">
        <p className="text-xs text-content-secondary">{t('editor.viewMatrix.label')}</p>
        <button
          type="button"
          aria-pressed={true}
          className="rounded border border-edge px-2 py-1 text-xs text-content-secondary hover:bg-surface-dim"
          onClick={onToggle}
          data-testid="view-matrix-mode-toggle"
        >
          {t('editor.viewMatrix.done')}
        </button>
      </div>

      <AxisSelect
        label={t('editor.viewMatrix.rowLabel')} axis="row" value={effectiveRow} optionCount={matrixRows}
        disabled={!hasSelection} showValue={showValue} blankLabel={blankLabel} onChange={onAxisChange}
      />
      <AxisSelect
        label={t('editor.viewMatrix.colLabel')} axis="col" value={effectiveCol} optionCount={matrixCols}
        disabled={!hasSelection} showValue={showValue} blankLabel={blankLabel} onChange={onAxisChange}
      />

      {duplicateCount > 0 && (
        <p className="text-xs text-warning" data-testid="view-matrix-duplicate-warning">
          {t('editor.viewMatrix.duplicateWarning', { count: duplicateCount })}
        </p>
      )}

      {/* Separated from the Row/Col controls above — pinned to the panel's
          bottom edge (mt-auto on the self-stretch column) so Reset reads as
          a distinct, deliberate action rather than sitting in the same
          cluster as the everyday selects. */}
      <div className="mt-auto">
        <DisconnectConfirmButton
          confirming={confirming}
          onRequestConfirm={() => setConfirming(true)}
          onCancelConfirm={() => setConfirming(false)}
          onConfirm={() => { setConfirming(false); onReset() }}
          disconnectLabelKey="editor.viewMatrix.reset"
          confirmLabelKey="common.confirmReset"
          disconnectTestId="view-matrix-reset-button"
          confirmTestId="view-matrix-reset-confirm-button"
          cancelTestId="view-matrix-reset-cancel-button"
        />
      </div>
    </div>
  )
}
