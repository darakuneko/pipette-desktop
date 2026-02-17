// SPDX-License-Identifier: GPL-2.0-or-later

import { useState, useEffect } from 'react'
import { useTranslation } from 'react-i18next'

interface Props {
  deviceName: string
  deviceId: string
  loadingProgress?: string
}

export function ConnectingOverlay({ deviceName, deviceId, loadingProgress }: Props) {
  const { t } = useTranslation()
  const [dots, setDots] = useState(0)

  useEffect(() => {
    const id = setInterval(() => setDots((d) => (d + 1) % 4), 500)
    return () => clearInterval(id)
  }, [])

  return (
    <div className="absolute inset-0 z-40 flex items-center justify-center bg-surface">
      <div className="flex flex-col items-center gap-7">
        <div className="relative flex h-14 w-14 items-center justify-center" aria-hidden="true">
          <div className="animate-pulse-ring absolute h-14 w-14 rounded-full border border-accent/15" />
          <svg width="56" height="56" viewBox="0 0 56 56" className="animate-spin-slow">
            <circle cx="28" cy="28" r="24" fill="none" stroke="currentColor" strokeWidth="2.5" className="text-edge-subtle" />
            <path d="M28 4 a24 24 0 0 1 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" className="text-accent/50" />
          </svg>
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" className="absolute text-content-muted opacity-50">
            <rect x="2" y="6" width="20" height="12" rx="2" stroke="currentColor" strokeWidth="1.5" />
            <line x1="6" y1="10" x2="6" y2="10.01" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
            <line x1="10" y1="10" x2="10" y2="10.01" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
            <line x1="14" y1="10" x2="14" y2="10.01" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
            <line x1="18" y1="10" x2="18" y2="10.01" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
            <line x1="8" y1="14" x2="16" y2="14" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
          </svg>
        </div>

        <div className="flex max-w-xs flex-col items-center gap-2">
          <p className="text-sm text-content-secondary">
            {t('app.connecting', { dots: '.'.repeat(dots) })}
            <span className="invisible">{'.'.repeat(3 - dots)}</span>
          </p>
          {loadingProgress && (
            <p className="text-xs text-content-muted">
              {t(loadingProgress)}
            </p>
          )}
          <p className="max-w-full truncate font-mono text-sm font-semibold text-content">
            {deviceName}
          </p>
          <p className="font-mono text-[11px] tracking-wide text-content-muted">
            {deviceId}
          </p>
        </div>
      </div>
    </div>
  )
}
