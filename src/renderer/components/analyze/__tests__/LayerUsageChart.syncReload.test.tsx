// @vitest-environment jsdom
// SPDX-License-Identifier: GPL-2.0-or-later
// Layer names follow a sync merge of the shown keyboard's settings without
// refetching the layer rows or showing the loading state.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { act, render, screen, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import type { PipetteSettings } from '../../../../shared/types/pipette-settings'
import { LayerUsageChart } from '../LayerUsageChart'
import { dispatchSyncUnitApplied } from '../../../hooks/use-sync-unit-applied'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))

vi.mock('recharts', () => ({
  ResponsiveContainer: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  BarChart: ({ data }: { data: { layer: number; label: string }[] }) => (
    <ul>{data.map((bar) => <li key={bar.layer}>{bar.label}</li>)}</ul>
  ),
  CartesianGrid: () => null,
  XAxis: () => null,
  YAxis: () => null,
  Tooltip: () => null,
  Bar: () => null,
  Cell: () => null,
}))

const listLayerUsage = vi.fn()
vi.mock('../analyze-fetch', () => ({
  listLayerUsageForScope: (...args: unknown[]) => listLayerUsage(...args),
  listMatrixCellsForScope: vi.fn(async () => []),
}))

const getSpy = vi.fn<(uid: string) => Promise<PipetteSettings | null>>()

function settings(layerNames: string[]): PipetteSettings {
  return { _rev: 1, keyboardLayout: 'qwerty', autoAdvance: true, layerNames }
}

beforeEach(() => {
  getSpy.mockReset()
  listLayerUsage.mockReset().mockResolvedValue([{ layer: 0, keystrokes: 5 }])
  Object.defineProperty(window, 'vialAPI', {
    value: { pipetteSettingsGet: (uid: string) => getSpy(uid) },
    writable: true,
    configurable: true,
  })
})

const RANGE = { fromMs: 0, toMs: 1000 }
const NO_SCOPES: string[] = []

function renderChart() {
  return render(
    <LayerUsageChart
      uid="selected"
      range={RANGE}
      deviceScopes={['own']}
      appScopes={NO_SCOPES}
      typingTestScopes={NO_SCOPES}
      runIdScopes={NO_SCOPES}
      snapshot={null}
      viewMode="keystrokes"
      baseLayer={0}
    />,
  )
}

describe('LayerUsageChart sync reload', () => {
  it('re-reads the shown keyboard\'s layer names only for its own settings unit', async () => {
    getSpy.mockResolvedValueOnce(settings(['Base']))
    renderChart()
    await waitFor(() => expect(screen.getByText('analyze.layer.layerLabel · Base')).toBeInTheDocument())

    act(() => { dispatchSyncUnitApplied('keyboards/connected/settings') })
    expect(getSpy).toHaveBeenCalledTimes(1)

    getSpy.mockResolvedValueOnce(settings(['Home']))
    act(() => { dispatchSyncUnitApplied('keyboards/selected/settings') })
    expect(screen.queryByTestId('analyze-layer-loading')).toBeNull()
    await waitFor(() => expect(screen.getByText('analyze.layer.layerLabel · Home')).toBeInTheDocument())
    expect(getSpy).toHaveBeenLastCalledWith('selected')
    expect(listLayerUsage).toHaveBeenCalledTimes(1)
  })
})
