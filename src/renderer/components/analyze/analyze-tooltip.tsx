// SPDX-License-Identifier: GPL-2.0-or-later
// Shared tooltip primitives for Analyze charts. Default recharts
// `<Tooltip contentStyle=…>` paths are out of scope — those keep
// recharts' built-in item/swatch rendering, which the shell can't
// replicate.

import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'

const SHELL_STYLE = {
  backgroundColor: 'var(--color-surface)',
  border: '1px solid var(--color-edge)',
  color: 'var(--color-content)',
  fontSize: 12,
  padding: '4px 8px',
  borderRadius: 4,
} as const

const HEADER_STYLE = { color: 'var(--color-content-secondary)' } as const

const FOOTER_STYLE = { color: 'var(--color-content-secondary)', marginTop: 4 } as const

/** Use this when a chart wants recharts' built-in item/swatch
 * rendering; reach for `TooltipShell` instead when supplying a custom
 * `content` renderer. */
export const ANALYZE_TOOLTIP_DEFAULTS = {
  contentStyle: { backgroundColor: 'var(--color-surface)', border: '1px solid var(--color-edge)', fontSize: 12 },
  labelStyle: { color: 'var(--color-content-secondary)' },
  itemStyle: { color: 'var(--color-content)' },
} as const

interface TooltipShellProps {
  /** Optional first line in `var(--color-content-secondary)`. Skip for
   * single-line tooltips that don't need a separate header row. */
  header?: ReactNode
  /** Optional trailing line in `var(--color-content-secondary)` with a
   * 4px top gap, for context like sample-size caveats. */
  footer?: ReactNode
  children: ReactNode
}

export function TooltipShell({ header, footer, children }: TooltipShellProps): JSX.Element {
  return (
    <div style={SHELL_STYLE}>
      {header ? <div style={HEADER_STYLE}>{header}</div> : null}
      {children}
      {footer ? <div style={FOOTER_STYLE}>{footer}</div> : null}
    </div>
  )
}

interface Props {
  active?: boolean
  label?: unknown
  payload?: ReadonlyArray<{ value?: unknown }>
  /** i18n key for the unit suffix. Defaults to `analyze.unit.keys`. */
  unitKey?: string
}

export function KeystrokeCountTooltip({ active, label, payload, unitKey = 'analyze.unit.keys' }: Props): JSX.Element | null {
  const { t } = useTranslation()
  if (!active || !payload?.length) return null
  const value = payload[0]?.value
  const formatted = typeof value === 'number' ? value.toLocaleString() : String(value ?? '')
  const displayLabel = typeof label === 'string' || typeof label === 'number' ? label : ''
  return (
    <TooltipShell>
      {displayLabel}: {formatted} {t(unitKey)}
    </TooltipShell>
  )
}
