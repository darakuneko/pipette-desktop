// SPDX-License-Identifier: GPL-2.0-or-later
//
// Shared two-step-confirm row for the Data modal's reset/delete
// affordances: a label on the left and a single danger trigger button
// on the right that flips to Confirm-then-Cancel (in that order —
// mirrors KeyboardSavesContent's "Delete All" footer, the reference
// two-step-confirm pattern in this modal) once clicked. Used by
// Sync > Cloud Data's per-target reset rows and Local > Application's
// "Reset application settings" row.
//
// KeyboardSavesContent / TypingAnalyticsContent keep their own inline
// confirm rows for now — not yet ported to this component (future
// adopters of the same pattern).

import type { ReactNode } from 'react'
import { BTN_SECONDARY, BTN_DANGER_OUTLINE } from '../../constants/ui-tokens'

export interface ConfirmResetRowProps {
  rowClassName: string
  rowTestid: string
  labelClassName: string
  label: ReactNode
  triggerLabel: ReactNode
  confirmLabel: ReactNode
  cancelLabel: ReactNode
  /** Shown next to Confirm/Cancel while `confirming` — omit for a row
   *  with no separate warning copy (e.g. AppSettingsReset). */
  warning?: ReactNode
  confirming: boolean
  busy: boolean
  onTrigger: () => void
  onConfirm: () => void
  onCancel: () => void
  triggerTestid: string
  confirmTestid: string
  cancelTestid: string
}

export function ConfirmResetRow({
  rowClassName,
  rowTestid,
  labelClassName,
  label,
  triggerLabel,
  confirmLabel,
  cancelLabel,
  warning,
  confirming,
  busy,
  onTrigger,
  onConfirm,
  onCancel,
  triggerTestid,
  confirmTestid,
  cancelTestid,
}: ConfirmResetRowProps) {
  return (
    <div className={rowClassName} data-testid={rowTestid}>
      <span className={labelClassName}>{label}</span>
      {confirming ? (
        <div className="flex items-center gap-2">
          {warning && <span className="text-sm text-danger">{warning}</span>}
          <button
            type="button"
            className={BTN_DANGER_OUTLINE}
            onClick={onConfirm}
            disabled={busy}
            data-testid={confirmTestid}
          >
            {confirmLabel}
          </button>
          <button
            type="button"
            className={BTN_SECONDARY}
            onClick={onCancel}
            disabled={busy}
            data-testid={cancelTestid}
          >
            {cancelLabel}
          </button>
        </div>
      ) : (
        <button
          type="button"
          className={BTN_DANGER_OUTLINE}
          onClick={onTrigger}
          disabled={busy}
          data-testid={triggerTestid}
        >
          {triggerLabel}
        </button>
      )}
    </div>
  )
}
