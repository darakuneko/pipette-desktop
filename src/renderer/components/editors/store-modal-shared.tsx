// SPDX-License-Identifier: GPL-2.0-or-later

// Form element base classes — use these for input/select elements.
export const INPUT_BASE =
  'rounded border border-edge bg-surface px-2.5 py-1 text-sm text-content ' +
  'focus:border-accent focus:outline-none disabled:opacity-50 disabled:cursor-not-allowed'
export const SELECT_BASE =
  'rounded border border-edge bg-surface px-2 py-1 text-sm text-content ' +
  'focus:border-accent focus:outline-none disabled:opacity-50 disabled:cursor-not-allowed'
export const INPUT_COMPACT =
  'rounded border border-edge bg-transparent px-1.5 py-0.5 text-xs text-content ' +
  'focus:border-accent focus:outline-none'

// Modal width tiers — use these instead of inline w-[*px] values.
export const MODAL_SM  = 'w-[440px]  max-w-[90vw]'
export const MODAL_MD  = 'w-[600px]  max-w-[90vw]'
export const MODAL_LG  = 'w-[760px]  max-w-[90vw]'
export const MODAL_XL  = 'w-[960px]  max-w-[95vw]'
export const MODAL_2XL = 'w-[1200px] max-w-[95vw]'

export const ACTION_BTN =
  'text-xs font-medium text-content hover:text-content cursor-pointer bg-transparent border-none px-2 py-1 rounded'
export const DELETE_BTN =
  'text-xs font-medium text-danger hover:text-danger cursor-pointer bg-transparent border-none px-2 py-1 rounded'
export const CONFIRM_DELETE_BTN =
  'text-xs font-medium text-danger hover:bg-danger/10 px-2 py-1 rounded cursor-pointer bg-transparent border-none'

function pad2(n: number): string {
  return String(n).padStart(2, '0')
}

export function formatDateShort(value: string | number): string {
  const d = new Date(value)
  if (isNaN(d.getTime())) return String(value)
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`
}

export function formatDate(value: string | number): string {
  const d = new Date(value)
  if (isNaN(d.getTime())) return String(value)
  return `${formatDateShort(value)} ${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`
}

/** Same as {@link formatDate} but drops the seconds digit. Use when
 * the timestamp is informational (e.g. peak-record context) rather
 * than audit-log precise — the narrower form fits the compact card
 * layouts the Analyze view uses. */
export function formatDateTime(value: string | number): string {
  const d = new Date(value)
  if (isNaN(d.getTime())) return String(value)
  return `${formatDateShort(value)} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`
}

interface SectionHeaderProps {
  label: string
  count?: number
}

export function SectionHeader({ label, count }: SectionHeaderProps) {
  return (
    <div className="mb-2.5 flex items-center gap-2">
      <span className="text-2xs font-bold uppercase tracking-widest text-content-muted">
        {label}
      </span>
      {count !== undefined && (
        <span className="text-2xs font-semibold text-content-muted bg-surface-dim px-1.5 py-px rounded-full">
          {count}
        </span>
      )}
      <div className="flex-1 h-px bg-edge" />
    </div>
  )
}
