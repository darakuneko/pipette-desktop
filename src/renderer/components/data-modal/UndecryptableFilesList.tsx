// SPDX-License-Identifier: GPL-2.0-or-later
// Rows of Drive files that can't be decrypted, each with a two-step
// Delete. Shared by Data › Cloud Data (CloudDataContent.tsx) and the sync
// password change panel (PasswordChangeStatusPanel.tsx); each caller owns
// its delete handler and the confirming state.

import { useTranslation } from 'react-i18next'
import { ConfirmResetRow } from './ConfirmResetRow'

export interface UndecryptableFileRow {
  id: string
  label: string
}

/** data-testid prefixes; the file id is appended to each. */
export interface UndecryptableFilesTestids {
  row: string
  trigger: string
  confirm: string
  cancel: string
}

export interface UndecryptableFilesListProps {
  files: UndecryptableFileRow[]
  confirmingId: string | null
  busy: boolean
  onTrigger: (id: string) => void
  onConfirm: (id: string) => void
  onCancel: () => void
  testids: UndecryptableFilesTestids
}

export function UndecryptableFilesList({
  files,
  confirmingId,
  busy,
  onTrigger,
  onConfirm,
  onCancel,
  testids,
}: UndecryptableFilesListProps) {
  const { t } = useTranslation()
  return (
    <div className="space-y-1">
      {files.map((file) => (
        <ConfirmResetRow
          key={file.id}
          rowClassName="flex items-center justify-between gap-2 rounded border border-edge px-3 py-2"
          rowTestid={`${testids.row}${file.id}`}
          labelClassName="text-sm text-content truncate"
          label={file.label}
          triggerLabel={t('common.delete')}
          confirmLabel={t('common.confirmDelete')}
          cancelLabel={t('common.cancel')}
          confirming={confirmingId === file.id}
          busy={busy}
          onTrigger={() => onTrigger(file.id)}
          onConfirm={() => onConfirm(file.id)}
          onCancel={onCancel}
          triggerTestid={`${testids.trigger}${file.id}`}
          confirmTestid={`${testids.confirm}${file.id}`}
          cancelTestid={`${testids.cancel}${file.id}`}
        />
      ))}
    </div>
  )
}
