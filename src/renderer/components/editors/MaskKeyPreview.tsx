// SPDX-License-Identifier: GPL-2.0-or-later

import { useEffect } from 'react'
import { useTranslation } from 'react-i18next'

interface Props {
  onConfirm: () => void
}

/** Select button with Enter key handler for confirming keycode selection. */
export function MaskKeyPreview({ onConfirm }: Props) {
  const { t } = useTranslation()

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key !== 'Enter') return
      const tag = (e.target as HTMLElement)?.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA' || (e.target as HTMLElement)?.isContentEditable) return
      e.preventDefault()
      onConfirm()
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [onConfirm])

  return (
    <button
      type="button"
      data-testid="mask-confirm-btn"
      className="rounded bg-accent px-2 py-0.5 text-xs text-content-inverse hover:bg-accent-hover"
      onClick={onConfirm}
    >
      {t('common.select')}
    </button>
  )
}
