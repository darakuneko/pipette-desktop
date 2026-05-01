// SPDX-License-Identifier: GPL-2.0-or-later

import { useTranslation } from 'react-i18next'
import { X } from 'lucide-react'

interface Props {
  testid: string
  onClick: () => void
}

export function ModalCloseButton({ testid, onClick }: Props) {
  const { t } = useTranslation()

  return (
    <button
      type="button"
      data-testid={testid}
      className="rounded p-1 text-content-muted hover:text-content"
      onClick={onClick}
      aria-label={t('common.close')}
    >
      <X size={20} aria-hidden="true" />
    </button>
  )
}
