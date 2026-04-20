// SPDX-License-Identifier: GPL-2.0-or-later
// Shared state keys for the Analyze tab. Kept here so the chart
// components can import them without the whole view.

export type AnalysisTabKey = 'wpm' | 'interval' | 'heatmap'
export type PeriodKey = '7d' | '30d' | 'all'
export type DeviceScope = 'own' | 'all'
