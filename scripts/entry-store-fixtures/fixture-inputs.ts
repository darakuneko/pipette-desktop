// SPDX-License-Identifier: GPL-2.0-or-later
// Inputs shared by the pipette-entry-store fixture generators.

import type { EntryStore } from '../../src/main/sync/entry-clocks'

export const STORES: EntryStore[] = [
  'favorites', 'snapshots', 'analyzeFilters', 'keyLabels', 'typingTestTexts', 'i18nPacks', 'themePacks', 'runLogs',
]

/** 2026-01-01T00:00:00.000Z plus `s` seconds, in ms. */
export const ms = (s: number): number => Date.UTC(2026, 0, 1) + s * 1000
/** `ms(s)` as an ISO string. */
export const T = (s: number): string => new Date(ms(s)).toISOString()

/** The last time a Date can hold, and one just before it. */
export const MAX_ISO = '+275760-09-13T00:00:00.000Z'
export const NEAR_MAX_ISO = '+275760-09-12T23:59:59.999Z'

export const LONE = '\uD800'
export const UUID = '0b9f6f1e-3c1a-4e0e-9d7a-2f1d5f6b8a90'
export const TS = '2026-03-15T14-35-29.037Z'

/** Writes `parts` as one JSON object text, keeping the given order. */
export function objectText(parts: Record<string, unknown>): string {
  return JSON.stringify(parts)
}
