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

export const ROW_CLASS = 'flex items-center justify-between rounded-lg border border-edge bg-surface/20 px-4 py-3'
