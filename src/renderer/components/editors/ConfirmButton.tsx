// SPDX-License-Identifier: GPL-2.0-or-later

import { useTranslation } from 'react-i18next'

interface Props {
  testId: string
  confirming: boolean
  onClick: () => void
  labelKey: string
  confirmLabelKey: string
  className?: string
}

const STYLE_NORMAL = 'border-edge hover:bg-surface-dim'
const STYLE_CONFIRMING = 'border-danger text-danger hover:bg-danger/10'

export function ConfirmButton({
  testId,
  confirming,
  onClick,
  labelKey,
  confirmLabelKey,
  className = 'rounded border px-4 py-2 text-sm',
}: Props) {
  const { t } = useTranslation()

  return (
    <button
      type="button"
      data-testid={testId}
      className={`${className} ${confirming ? STYLE_CONFIRMING : STYLE_NORMAL}`}
      onClick={onClick}
    >
      {confirming ? t(confirmLabelKey) : t(labelKey)}
    </button>
  )
}
