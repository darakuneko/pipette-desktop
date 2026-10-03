// SPDX-License-Identifier: GPL-2.0-or-later
// @vitest-environment jsdom

import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { AppBanners } from '../AppBanners'
import type { useDeviceConnection } from '../../hooks/useDeviceConnection'
import type { useKeyboard } from '../../hooks/useKeyboard'
import type { useDeviceLifecycle } from '../../hooks/useDeviceLifecycle'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))

function renderBanners({ loading = false, syncUpdateVisible = false } = {}) {
  const device = { isDummy: false, isPipetteFile: false } as unknown as ReturnType<typeof useDeviceConnection>
  const keyboard = { loading, uid: '0x1', viaProtocol: 9, connectionWarning: null, activityCount: 0 } as unknown as ReturnType<typeof useKeyboard>
  const lifecycle = { pipetteFileSavedActivityRef: { current: 0 } } as unknown as ReturnType<typeof useDeviceLifecycle>
  render(<AppBanners device={device} keyboard={keyboard} lifecycle={lifecycle} syncUpdate={{ visible: syncUpdateVisible, dismiss: vi.fn() }} />)
}

describe('AppBanners', () => {
  it('shows the sync update banner when Drive needs a newer app', () => {
    renderBanners({ syncUpdateVisible: true })
    expect(screen.getByTestId('sync-update-banner')).toBeInTheDocument()
  })

  it('shows the sync update banner while the keyboard is still loading', () => {
    renderBanners({ loading: true, syncUpdateVisible: true })
    expect(screen.getByTestId('sync-update-banner')).toBeInTheDocument()
  })

  it('hides the sync update banner otherwise', () => {
    renderBanners()
    expect(screen.queryByTestId('sync-update-banner')).toBeNull()
  })
})
