// SPDX-License-Identifier: GPL-2.0-or-later

export interface PackTabButtonProps {
  label: string
  active: boolean
  onClick: () => void
  testid: string
}

/** Shared Installed / Find-on-Hub tab button, identical across all three pack modals. */
export function PackTabButton({ label, active, onClick, testid }: PackTabButtonProps): JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex-1 px-4 py-2 text-sm font-medium transition-colors ${
        active ? 'border-b-2 border-accent text-accent' : 'text-content-secondary hover:text-content'
      }`}
      data-testid={testid}
      aria-pressed={active}
    >
      {label}
    </button>
  )
}
