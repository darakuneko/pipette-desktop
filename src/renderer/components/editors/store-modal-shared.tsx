// SPDX-License-Identifier: GPL-2.0-or-later

export const ACTION_BTN =
  'text-xs font-medium text-content-muted hover:text-content cursor-pointer bg-transparent border-none px-2 py-1 rounded'
export const DELETE_BTN =
  'text-xs font-medium text-danger hover:text-danger cursor-pointer bg-transparent border-none px-2 py-1 rounded'
export const CONFIRM_DELETE_BTN =
  'text-xs font-medium text-danger hover:bg-danger/10 px-2 py-1 rounded cursor-pointer bg-transparent border-none'

export function formatDate(iso: string): string {
  const d = new Date(iso)
  if (isNaN(d.getTime())) return iso
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

interface SectionHeaderProps {
  label: string
  count?: number
}

export function SectionHeader({ label, count }: SectionHeaderProps) {
  return (
    <div className="mb-2.5 flex items-center gap-2">
      <span className="text-[10px] font-bold uppercase tracking-widest text-content-muted">
        {label}
      </span>
      {count !== undefined && (
        <span className="text-[10px] font-semibold text-content-muted bg-surface-dim px-1.5 py-px rounded-full">
          {count}
        </span>
      )}
      <div className="flex-1 h-px bg-edge" />
    </div>
  )
}
