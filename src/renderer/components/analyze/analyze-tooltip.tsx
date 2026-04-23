// SPDX-License-Identifier: GPL-2.0-or-later
// Shared tooltip renderer for Analyze bar charts. Formats a single
// numeric payload with the `analyze.unit.keys` suffix so Ergonomics,
// Layer, and any future bar-chart tab present counts identically
// (same styling, same i18n suffix). Accepts recharts' standard
// `active / label / payload` shape via a render-prop call site:
//
//   <Tooltip content={(p) => <KeystrokeCountTooltip {...p} />} />

import { useTranslation } from 'react-i18next'

interface Props {
  active?: boolean
  label?: unknown
  payload?: ReadonlyArray<{ value?: unknown }>
}

export function KeystrokeCountTooltip({ active, label, payload }: Props): JSX.Element | null {
  const { t } = useTranslation()
  if (!active || !payload?.length) return null
  const value = payload[0]?.value
  const formatted = typeof value === 'number' ? value.toLocaleString() : String(value ?? '')
  const displayLabel = typeof label === 'string' || typeof label === 'number' ? label : ''
  return (
    <div
      style={{
        backgroundColor: 'var(--color-surface)',
        border: '1px solid var(--color-edge)',
        color: 'var(--color-content)',
        fontSize: 12,
        padding: '4px 8px',
        borderRadius: 4,
      }}
    >
      {displayLabel}: {formatted} {t('analyze.unit.keys')}
    </div>
  )
}
