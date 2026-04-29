// SPDX-License-Identifier: GPL-2.0-or-later
// Covers `resolveAnalyzeLoadingPhase` priority order so the View can
// rely on a single ordered predicate without re-asserting it inline.

import { describe, it, expect } from 'vitest'
import {
  resolveAnalyzeLoadingPhase,
  type AnalyzeLoadingState,
} from '../analyze-loading-phase'

const READY: AnalyzeLoadingState = {
  keyboardsLoading: false,
  filtersReady: true,
  syncing: false,
  snapshotLoading: false,
  summariesLoading: false,
  fingersLoading: false,
  remoteHashesLoading: false,
}

describe('resolveAnalyzeLoadingPhase', () => {
  it('returns null when nothing is in flight', () => {
    expect(resolveAnalyzeLoadingPhase(READY)).toBeNull()
  })

  it('keyboards beats every other phase', () => {
    expect(resolveAnalyzeLoadingPhase({
      ...READY,
      keyboardsLoading: true,
      filtersReady: false,
      syncing: true,
      snapshotLoading: true,
      summariesLoading: true,
      fingersLoading: true,
      remoteHashesLoading: true,
    })).toBe('keyboards')
  })

  it('settings beats syncing / snapshot / preparing', () => {
    expect(resolveAnalyzeLoadingPhase({
      ...READY,
      filtersReady: false,
      syncing: true,
      snapshotLoading: true,
      summariesLoading: true,
    })).toBe('settings')
  })

  it('syncing beats snapshot and preparing', () => {
    expect(resolveAnalyzeLoadingPhase({
      ...READY,
      syncing: true,
      snapshotLoading: true,
      remoteHashesLoading: true,
    })).toBe('syncing')
  })

  it('snapshot beats preparing', () => {
    expect(resolveAnalyzeLoadingPhase({
      ...READY,
      snapshotLoading: true,
      summariesLoading: true,
    })).toBe('snapshot')
  })

  it.each([
    ['summaries only', { summariesLoading: true }],
    ['fingers only', { fingersLoading: true }],
    ['remoteHashes only', { remoteHashesLoading: true }],
  ])('folds %s into preparing', (_name, partial) => {
    expect(resolveAnalyzeLoadingPhase({ ...READY, ...partial })).toBe('preparing')
  })
})
