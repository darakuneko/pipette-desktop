// SPDX-License-Identifier: GPL-2.0-or-later
// @vitest-environment jsdom

import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { AppDisconnectedView } from '../AppDisconnectedView'
import type { useDeviceConnection } from '../../hooks/useDeviceConnection'
import type { useDeviceLifecycle } from '../../hooks/useDeviceLifecycle'
import type { UseSyncReturn } from '../../hooks/useSync'
import type { useTheme } from '../../hooks/useTheme'
import type { UseDevicePrefsReturn } from '../../hooks/useDevicePrefs'
import type { useAppConfig } from '../../hooks/useAppConfig'
import type { useHubState } from '../../hooks/useHubState'
import type { useStartupNotification } from '../../hooks/useStartupNotification'

vi.mock('react-i18next', () => ({
  // Same stub as DeviceSelector.test.tsx — avoids the AnalyzePage ->
  // TypingAnalyticsView -> useAppConfig import chain crashing when only
  // this subtree loads.
  initReactI18next: { type: '3rdParty', init: () => {} },
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}))

vi.mock('../../hooks/useAppConfig', () => ({
  useAppConfig: () => ({ config: { oneShotNotice: null }, loading: false, set: () => {} }),
}))

function makeProps(overrides: { fileLoadError?: string | null; deviceError?: string | null; onClearFileLoadError?: () => void; onClearDeviceError?: () => void } = {}) {
  const device = {
    devices: [],
    connecting: false,
    error: overrides.deviceError ?? null,
    clearError: overrides.onClearDeviceError ?? vi.fn(),
  } as unknown as ReturnType<typeof useDeviceConnection>

  const lifecycle = {
    fileLoadError: overrides.fileLoadError ?? null,
    clearFileLoadError: overrides.onClearFileLoadError ?? vi.fn(),
    deviceLoadError: null,
    handleConnect: vi.fn(),
    handleLoadDummy: vi.fn(),
    handleLoadPipetteFile: vi.fn(),
    pipetteFileKeyboards: [],
    pipetteFileEntries: [],
    handleOpenPipetteFileEntry: vi.fn(),
    refreshPipetteFileEntries: vi.fn(),
    setShowSettings: vi.fn(),
    handleOpenDataModal: vi.fn(),
    showSettings: false,
    showDataModal: false,
    setShowDataModal: vi.fn(),
  } as unknown as ReturnType<typeof useDeviceLifecycle>

  const sync = {
    progress: undefined,
    syncStatus: 'none',
    authStatus: { authenticated: false },
  } as unknown as UseSyncReturn

  const themeCtx = { theme: 'light', setTheme: vi.fn() } as unknown as ReturnType<typeof useTheme>
  const devicePrefs = {} as unknown as UseDevicePrefsReturn
  const appConfig = { config: {}, set: vi.fn() } as unknown as ReturnType<typeof useAppConfig>
  const hub = {} as unknown as ReturnType<typeof useHubState>
  const startupNotification = { visible: false, notifications: [], dismiss: vi.fn() } as unknown as ReturnType<typeof useStartupNotification>

  return { deviceSyncing: false, device, sync, lifecycle, themeCtx, devicePrefs, appConfig, hub, startupNotification }
}

describe('AppDisconnectedView', () => {
  it('shows fileLoadError and deviceError as two independent boxes', () => {
    render(<AppDisconnectedView {...makeProps({ fileLoadError: 'File load failed', deviceError: 'Failed to open device' })} />)
    expect(screen.getByTestId('file-load-error')).toHaveTextContent('File load failed')
    expect(screen.getByTestId('device-error')).toHaveTextContent('Failed to open device')
  })

  it('close button on the device-error box calls device.clearError, not lifecycle.clearFileLoadError', () => {
    const onClearFileLoadError = vi.fn()
    const onClearDeviceError = vi.fn()
    render(<AppDisconnectedView {...makeProps({
      fileLoadError: 'File load failed',
      deviceError: 'Failed to open device',
      onClearFileLoadError,
      onClearDeviceError,
    })} />)

    fireEvent.click(screen.getByTestId('device-error').querySelector('button')!)
    expect(onClearDeviceError).toHaveBeenCalledOnce()
    expect(onClearFileLoadError).not.toHaveBeenCalled()
  })
})
