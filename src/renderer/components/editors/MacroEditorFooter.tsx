// SPDX-License-Identifier: GPL-2.0-or-later

import { useTranslation } from 'react-i18next'
import { BTN_PRIMARY } from '../../constants/ui-tokens'
import { useConfirmAction } from '../../hooks/useConfirmAction'
import { ConfirmButton } from './ConfirmButton'

interface Props {
  isEditing: boolean
  isExistingEdit: boolean
  isRecording: boolean
  hasPendingEdit: boolean
  dirty: boolean
  hasInvalidText: boolean
  clearAction: ReturnType<typeof useConfirmAction>
  revertAction: ReturnType<typeof useConfirmAction>
  editRevertAction: ReturnType<typeof useConfirmAction>
  commitAndDeselect: () => void
  handleSave: () => Promise<void>
}

// Fixed footer: Clear / Revert (list mode only) / Save (always visible)
export function MacroEditorFooter({
  isEditing,
  isExistingEdit,
  isRecording,
  hasPendingEdit,
  dirty,
  hasInvalidText,
  clearAction,
  revertAction,
  editRevertAction,
  commitAndDeselect,
  handleSave,
}: Props) {
  const { t } = useTranslation()

  return (
    <div data-macro-footer="true" className="shrink-0 px-6 py-3">
      <div className="flex justify-end gap-2">
        {!isEditing && (
          <>
            <ConfirmButton
              testId="macro-clear"
              confirming={clearAction.confirming}
              onClick={() => { revertAction.reset(); clearAction.trigger() }}
              labelKey="common.clear"
              confirmLabelKey="common.confirmClear"
              disabled={isRecording}
            />
            <ConfirmButton
              testId="macro-revert"
              confirming={revertAction.confirming}
              onClick={() => { clearAction.reset(); revertAction.trigger() }}
              labelKey="common.revert"
              confirmLabelKey="common.confirmRevert"
              disabled={isRecording}
            />
          </>
        )}
        {isEditing && isExistingEdit && (
          <ConfirmButton
            testId="macro-edit-revert"
            confirming={editRevertAction.confirming}
            onClick={editRevertAction.trigger}
            labelKey="common.revert"
            confirmLabelKey="common.confirmRevert"
            disabled={isRecording || !hasPendingEdit}
          />
        )}
        <button
          type="button"
          data-testid="macro-save"
          className={BTN_PRIMARY}
          onClick={isEditing ? commitAndDeselect : handleSave}
          disabled={isEditing
            ? (isRecording || !hasPendingEdit)
            : (!dirty || hasInvalidText || isRecording)}
        >
          {t('common.save')}
        </button>
      </div>
    </div>
  )
}
