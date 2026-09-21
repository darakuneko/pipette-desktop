// SPDX-License-Identifier: GPL-2.0-or-later

// A single error message in a caller-styled container: the caller's
// classes decide color/size/spacing, this adds the auto-dismiss timer and
// the close button. One instance tracks exactly one error source, so
// several can be stacked without affecting each other's timers.

import { useEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { X } from 'lucide-react'
import { ICON_SM } from '../../constants/ui-tokens'

export const ERROR_DISMISS_MS = 10_000

interface DismissibleErrorProps {
  message: string | null
  onDismiss: () => void
  className: string
  testid?: string
}

export function DismissibleError({ message, onDismiss, className, testid }: DismissibleErrorProps) {
  const { t } = useTranslation()
  // Held in a ref so the timer effect depends on `message` alone —
  // depending on `onDismiss` would restart the timer whenever a caller
  // hands in a fresh function identity.
  const onDismissRef = useRef(onDismiss)
  onDismissRef.current = onDismiss

  useEffect(() => {
    if (!message) return
    const timer = setTimeout(() => onDismissRef.current(), ERROR_DISMISS_MS)
    return () => clearTimeout(timer)
  }, [message])

  if (!message) return null

  return (
    <div className={className} role="alert" data-testid={testid}>
      <div className="flex items-start justify-between gap-2">
        <span className="flex-1">{message}</span>
        <button
          type="button"
          onClick={onDismiss}
          className="shrink-0 rounded p-1 text-danger hover:text-danger/80"
          aria-label={t('common.close')}
        >
          <X size={ICON_SM} aria-hidden="true" />
        </button>
      </div>
    </div>
  )
}
