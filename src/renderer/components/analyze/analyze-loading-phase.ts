// SPDX-License-Identifier: GPL-2.0-or-later

/** Discriminator for the ConnectingOverlay shown over the Analyze
 * panel. Ordered by priority: `keyboards → settings → syncing →
 * snapshot → preparing`. `null` means "ready, render the regular UI". */
export type AnalyzeLoadingPhase =
  | 'keyboards'
  | 'settings'
  | 'syncing'
  | 'snapshot'
  | 'preparing'
  | null

export interface AnalyzeLoadingState {
  keyboardsLoading: boolean
  filtersReady: boolean
  syncing: boolean
  snapshotLoading: boolean
  summariesLoading: boolean
  fingersLoading: boolean
  remoteHashesLoading: boolean
}

export function resolveAnalyzeLoadingPhase(state: AnalyzeLoadingState): AnalyzeLoadingPhase {
  if (state.keyboardsLoading) return 'keyboards'
  if (!state.filtersReady) return 'settings'
  if (state.syncing) return 'syncing'
  if (state.snapshotLoading) return 'snapshot'
  if (state.summariesLoading || state.fingersLoading || state.remoteHashesLoading) return 'preparing'
  return null
}
