// SPDX-License-Identifier: GPL-2.0-or-later

import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useEscapeClose } from '../../hooks/useEscapeClose'
import { ModalCloseButton } from './ModalCloseButton'
import { BTN_PRIMARY, BTN_SECONDARY } from '../../constants/ui-tokens'

/** Clamps free-typed number input to a non-negative integer, falling back
 *  to the previous value when the raw input isn't a finite parseable
 *  number (e.g. a cleared field mid-edit). */
function clampNonNegativeInt(raw: string, fallback: number): number {
  const n = Math.trunc(Number(raw))
  return Number.isFinite(n) && n >= 0 ? n : fallback
}

export interface ViewMatrixModalProps {
  /** Physical Vial matrix position of the key being edited — read-only. */
  physRow: number
  physCol: number
  /** Effective (override ?? physical) position, prefilled into the inputs. */
  effectiveRow: number
  effectiveCol: number
  onSave: (row: number, col: number) => void
  onClose: () => void
}

/** Small centered modal for editing one key's View Matrix override — the
 *  logical (row, col) the keymap editor's Auto Move walk should sort it by
 *  instead of its physical Vial matrix position. No vial-gui reference —
 *  this is a Pipette-original feature, see issue #257. */
export function ViewMatrixModal({ physRow, physCol, effectiveRow, effectiveCol, onSave, onClose }: ViewMatrixModalProps) {
  const { t } = useTranslation()
  const [row, setRow] = useState(effectiveRow)
  const [col, setCol] = useState(effectiveCol)
  useEscapeClose(onClose)

  function handleSave(): void {
    onSave(row, col)
    onClose()
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
      data-testid="view-matrix-modal-backdrop"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="view-matrix-modal-title"
        className="w-modal-sm max-w-modal-vw flex flex-col rounded-2xl bg-surface-alt border border-edge shadow-xl overflow-hidden"
        onClick={(e) => e.stopPropagation()}
        data-testid="view-matrix-modal"
      >
        <div className="flex items-center justify-between px-5 pt-4 pb-3 border-b border-edge shrink-0">
          <h2 id="view-matrix-modal-title" className="text-lg font-bold text-content">
            {t('editor.viewMatrix.modalTitle')}
          </h2>
          <ModalCloseButton testid="view-matrix-modal-close" onClick={onClose} />
        </div>

        <div className="flex flex-col gap-3 px-5 py-4">
          <p className="text-xs text-content-muted" data-testid="view-matrix-physical-label">
            {t('editor.viewMatrix.physicalLabel')}: {physRow}, {physCol}
          </p>
          <div className="flex items-center gap-3">
            <label className="flex flex-1 flex-col gap-1 text-sm text-content">
              {t('editor.viewMatrix.rowLabel')}
              <input
                type="number"
                min={0}
                step={1}
                value={row}
                onChange={(e) => setRow(clampNonNegativeInt(e.target.value, row))}
                className="rounded border border-edge bg-surface px-2.5 py-1 text-sm text-content focus:border-accent focus:outline-none"
                data-testid="view-matrix-row-input"
              />
            </label>
            <label className="flex flex-1 flex-col gap-1 text-sm text-content">
              {t('editor.viewMatrix.colLabel')}
              <input
                type="number"
                min={0}
                step={1}
                value={col}
                onChange={(e) => setCol(clampNonNegativeInt(e.target.value, col))}
                className="rounded border border-edge bg-surface px-2.5 py-1 text-sm text-content focus:border-accent focus:outline-none"
                data-testid="view-matrix-col-input"
              />
            </label>
          </div>
        </div>

        <div className="flex items-center justify-end gap-2 px-5 pb-4">
          <button type="button" className={BTN_SECONDARY} onClick={onClose} data-testid="view-matrix-cancel-button">
            {t('common.cancel')}
          </button>
          <button type="button" className={BTN_PRIMARY} onClick={handleSave} data-testid="view-matrix-save-button">
            {t('common.save')}
          </button>
        </div>
      </div>
    </div>
  )
}
