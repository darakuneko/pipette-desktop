// SPDX-License-Identifier: GPL-2.0-or-later

const TOGGLE_TRACK_BASE = 'relative inline-flex h-5 w-9 items-center rounded-full transition-colors'
const TOGGLE_KNOB_BASE = 'inline-block h-3.5 w-3.5 rounded-full bg-white transition-transform'

export function toggleTrackClass(on: boolean): string {
  if (on) return `${TOGGLE_TRACK_BASE} bg-accent`
  return `${TOGGLE_TRACK_BASE} bg-edge`
}

export function toggleKnobClass(on: boolean): string {
  if (on) return `${TOGGLE_KNOB_BASE} translate-x-4.5`
  return `${TOGGLE_KNOB_BASE} translate-x-0.5`
}

export const ROW_CLASS = 'flex items-center justify-between gap-4 rounded-lg border border-edge bg-surface/20 px-4 py-3'

// Full-width switch row: label on the left, a track/knob toggle on the right —
// reused across editor panels (View visibility toggles, Data "Save Unnamed",
// the Romaji Settings modal's master enable / font-linked rows, ...). The
// accessible name is the fixed label; `title` (optional) carries a
// state-dependent hover hint — the on/off state itself is read from
// `aria-checked`, so it must not be baked into the accessible name.
export function ToggleRow({ label, on, onToggle, title, testid }: {
  label: string
  on: boolean
  onToggle: () => void
  title?: string
  testid: string
}) {
  return (
    <div className={`${ROW_CLASS} w-full`} data-testid={`${testid}-row`}>
      <span className="min-w-0 truncate text-sm font-medium text-content">{label}</span>
      <button
        type="button"
        role="switch"
        aria-checked={on}
        aria-label={label}
        title={title}
        className={`${toggleTrackClass(on)} shrink-0`}
        onClick={onToggle}
        data-testid={testid}
      >
        <span className={toggleKnobClass(on)} />
      </button>
    </div>
  )
}

// Settings-modal switch row: label (single line, or label + description
// block when `description` is given) on the left, a track/knob toggle on
// the right. Row and toggle test ids are independent (unlike `ToggleRow`,
// which derives the row id from the toggle id) so this matches the
// pre-existing `settings-*-row` / `settings-*-toggle` naming used across
// SettingsToolsTab. `labelTone` mirrors the two label styles that were
// hand-rolled there: rows with a description use the secondary tone, plain
// rows use the default content tone.
export function SettingsToggleRow({
  rowTestId,
  toggleTestId,
  label,
  description,
  labelTone = 'secondary',
  on,
  onToggle,
  disabled,
}: {
  rowTestId: string
  toggleTestId: string
  label: string
  description?: string
  labelTone?: 'secondary' | 'content'
  on: boolean
  onToggle: () => void
  disabled?: boolean
}) {
  const trackClass = disabled === undefined
    ? toggleTrackClass(on)
    : `${toggleTrackClass(on)} disabled:cursor-not-allowed disabled:opacity-50`

  return (
    <div className={ROW_CLASS} data-testid={rowTestId}>
      {description === undefined ? (
        <span className={`text-sm font-medium ${labelTone === 'secondary' ? 'text-content-secondary' : 'text-content'}`}>
          {label}
        </span>
      ) : (
        <div className="flex flex-col gap-0.5">
          <span className={`text-sm font-medium ${labelTone === 'secondary' ? 'text-content-secondary' : 'text-content'}`}>
            {label}
          </span>
          <span className="text-xs text-content-muted">{description}</span>
        </div>
      )}
      <button
        type="button"
        role="switch"
        aria-checked={on}
        aria-label={label}
        className={trackClass}
        onClick={onToggle}
        disabled={disabled}
        data-testid={toggleTestId}
      >
        <span className={toggleKnobClass(on)} />
      </button>
    </div>
  )
}
