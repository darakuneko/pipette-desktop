// @vitest-environment jsdom
// SPDX-License-Identifier: GPL-2.0-or-later
// Covers `buildFilterConditionLabels`'s dimension-aware source label plus
// the device/keyboard/period labels it shares with the (future) summary
// chip + filter modal.

import { describe, it, expect } from 'vitest'
import type { TFunction } from 'i18next'
import { buildFilterConditionLabels, type FilterConditionLabelInputs } from '../filter-labels'
import { formatDateTime } from '../../editors/store-modal-shared'

// Passthrough translator — same convention as the other Analyze test
// suites (TypingAnalyticsView.test.tsx, MultiSelectPopover.test.tsx):
// keys resolve to themselves, interpolated calls append the JSON opts so
// assertions can check both the key and the interpolated values.
const t = ((key: string, opts?: Record<string, unknown>) =>
  opts ? `${key}:${JSON.stringify(opts)}` : key) as TFunction

const RANGE = { fromMs: Date.UTC(2026, 3, 1, 9, 0), toMs: Date.UTC(2026, 3, 3, 18, 30) }

const BASE: FilterConditionLabelInputs = {
  keyboardName: 'GPK60-63R',
  deviceScope: 'own',
  deviceInfos: { own: null, remotes: [] },
  filterDimension: 'app',
  appScopes: [],
  typingTestScopes: [],
  runLabels: [],
  range: RANGE,
}

describe('buildFilterConditionLabels', () => {
  it('reports the keyboard name as-is, and the em-dash placeholder when absent', () => {
    expect(buildFilterConditionLabels(t, BASE).keyboardLabel).toBe('GPK60-63R')
    expect(buildFilterConditionLabels(t, { ...BASE, keyboardName: null }).keyboardLabel).toBe('—')
  })

  it('formats the period label from the range using formatDateTime', () => {
    const { periodLabel } = buildFilterConditionLabels(t, BASE)
    expect(periodLabel).toBe(`${formatDateTime(RANGE.fromMs)} - ${formatDateTime(RANGE.toMs)}`)
  })

  describe('deviceLabel', () => {
    it('labels the own scope from deviceInfos.own when resolved', () => {
      const { deviceLabel } = buildFilterConditionLabels(t, {
        ...BASE,
        deviceScope: 'own',
        deviceInfos: { own: { machineHash: 'ownhash00000000', osPlatform: 'linux', osRelease: '6.8' }, remotes: [] },
      })
      expect(deviceLabel).toBe('linux - 6.8 (ownhash0)')
    })

    it('falls back to the own-device i18n key when deviceInfos.own has not resolved yet', () => {
      const { deviceLabel } = buildFilterConditionLabels(t, BASE)
      expect(deviceLabel).toBe('analyze.filters.deviceOption.own')
    })

    it('labels the all scope via the all-devices i18n key', () => {
      const { deviceLabel } = buildFilterConditionLabels(t, { ...BASE, deviceScope: 'all' })
      expect(deviceLabel).toBe('analyze.filters.deviceOption.all')
    })

    it('labels a hash scope from the matching remote entry', () => {
      const { deviceLabel } = buildFilterConditionLabels(t, {
        ...BASE,
        deviceScope: { kind: 'hash', machineHash: 'remotehash12345678' },
        deviceInfos: {
          own: null,
          remotes: [{ machineHash: 'remotehash12345678', osPlatform: 'darwin', osRelease: '23.6' }],
        },
      })
      expect(deviceLabel).toBe('darwin - 23.6 (remoteha)')
    })

    it('falls back to the own-device key for a hash scope with no matching remote', () => {
      const { deviceLabel } = buildFilterConditionLabels(t, {
        ...BASE,
        deviceScope: { kind: 'hash', machineHash: 'stalehash' },
        deviceInfos: { own: null, remotes: [] },
      })
      expect(deviceLabel).toBe('analyze.filters.deviceOption.own')
    })
  })

  describe('sourceLabel — app dimension', () => {
    it('reports the none-selected key when appScopes is empty', () => {
      const { sourceLabel } = buildFilterConditionLabels(t, { ...BASE, filterDimension: 'app', appScopes: [] })
      expect(sourceLabel).toBe('analyze.filters.appOption.none')
    })

    it('reports the app name directly for a single selection', () => {
      const { sourceLabel } = buildFilterConditionLabels(t, {
        ...BASE,
        filterDimension: 'app',
        appScopes: ['vscode'],
      })
      expect(sourceLabel).toBe('vscode')
    })

    it('reports the multi-select summary for more than one app', () => {
      const { sourceLabel } = buildFilterConditionLabels(t, {
        ...BASE,
        filterDimension: 'app',
        appScopes: ['vscode', 'chrome', 'slack'],
      })
      expect(sourceLabel).toBe('analyze.filters.appOption.multi:{"first":"vscode","rest":2}')
    })

    it('ignores typingTestScopes / runLabels while the app dimension is active', () => {
      const { sourceLabel } = buildFilterConditionLabels(t, {
        ...BASE,
        filterDimension: 'app',
        appScopes: ['vscode'],
        typingTestScopes: ['words (english)'],
        runLabels: ['Run A'],
      })
      expect(sourceLabel).toBe('vscode')
    })
  })

  describe('sourceLabel — typingTest dimension', () => {
    it('reports the none-selected key when typingTestScopes is empty', () => {
      const { sourceLabel } = buildFilterConditionLabels(t, {
        ...BASE,
        filterDimension: 'typingTest',
        typingTestScopes: [],
      })
      expect(sourceLabel).toBe('analyze.filters.typingTestOption.none')
    })

    it('reports the test name with no run qualifier when no run is selected', () => {
      const { sourceLabel } = buildFilterConditionLabels(t, {
        ...BASE,
        filterDimension: 'typingTest',
        typingTestScopes: ['words (english)'],
        runLabels: [],
      })
      expect(sourceLabel).toBe('words (english)')
    })

    it('appends a run qualifier once a run is selected', () => {
      const { sourceLabel } = buildFilterConditionLabels(t, {
        ...BASE,
        filterDimension: 'typingTest',
        typingTestScopes: ['words (english)'],
        runLabels: ['2026-04-01 09:00'],
      })
      expect(sourceLabel).toBe('words (english) · 2026-04-01 09:00')
    })

    it('multi-selects both the test and run segments independently', () => {
      const { sourceLabel } = buildFilterConditionLabels(t, {
        ...BASE,
        filterDimension: 'typingTest',
        typingTestScopes: ['words (english)', 'quote (english)'],
        runLabels: ['Run A', 'Run B'],
      })
      expect(sourceLabel).toBe(
        'analyze.filters.typingTestOption.multi:{"first":"words (english)","rest":1}'
        + ' · '
        + 'analyze.filters.runOption.multi:{"first":"Run A","rest":1}',
      )
    })

    it('drops a stale run qualifier when the material selection is cleared', () => {
      // Mirrors useAnalyzeFilters' own rule: runIdScopes only applies while
      // a material is selected.
      const { sourceLabel } = buildFilterConditionLabels(t, {
        ...BASE,
        filterDimension: 'typingTest',
        typingTestScopes: [],
        runLabels: ['Run A'],
      })
      expect(sourceLabel).toBe('analyze.filters.typingTestOption.none')
    })
  })
})
