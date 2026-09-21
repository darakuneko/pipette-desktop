// SPDX-License-Identifier: GPL-2.0-or-later

// A single error message inside a container the caller styles (the
// container's classes decide the color/size/spacing — this component only
// adds the auto-dismiss timer and the close button). Each instance tracks
// exactly one error source, so several can be stacked independently
// without one source's dismissal or restart affecting another's.

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
  // Keep the latest callback in a ref so the timer effect below can depend
  // on `message` alone — depending on `onDismiss` directly would restart
  // the timer on every render that hands in a fresh function identity.
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
