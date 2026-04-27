// SPDX-License-Identifier: GPL-2.0-or-later
// @vitest-environment jsdom

import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { DeviceSelector } from '../DeviceSelector'
import type { DeviceInfo } from '../../../shared/types/protocol'

vi.mock('react-i18next', () => ({
  // Stub the bootstrap export so module-graph imports of `i18n/index.ts`
  // (pulled in by AnalyzePage → TypingAnalyticsView → useAppConfig) don't
  // crash when this test loads only the DeviceSelector subtree.
  initReactI18next: { type: '3rdParty', init: () => {} },
  useTranslation: () => ({
    t: (key: string, params?: Record<string, string>) => {
      const map: Record<string, string> = {
        'app.title': 'Pipette',
        'app.selectDevices': 'Select Devices',
        'app.connecting': 'Connecting{{dots}}',
        'app.deviceNotConnected': 'No keyboard connected',
        'app.loadDummy': 'Load from JSON file…',
        'app.keyboardTab': 'Device',
        'app.fileTab': 'File',
        'app.loadPipetteFile': 'Load .pipette file…',
        'app.loadPipetteFileDescription': 'Open a .pipette file for offline editing.',
        'app.selectKeyboard': 'Select Keyboard',
        'app.noSavedFiles': 'No saved files',
        'app.fileCount': '{{count}} saves',
        'common.back': 'Back',
      }
      let result = map[key] ?? key
      if (params) {
        for (const [k, v] of Object.entries(params)) {
          result = result.replace(`{{${k}}}`, v)
        }
      }
      return result
    },
  }),
}))

const mockDevice: DeviceInfo = {
  vendorId: 0x1234,
  productId: 0x5678,
  productName: 'Test Keyboard',
  serialNumber: 'SN001',
  type: 'vial',
}

const mockViaDevice: DeviceInfo = {
  vendorId: 0xabcd,
  productId: 0xef01,
  productName: 'VIA Board',
  serialNumber: 'SN002',
  type: 'via',
}

describe('DeviceSelector', () => {
  const defaultProps = {
    devices: [] as DeviceInfo[],
    connecting: false,
    error: null,
    onConnect: vi.fn(),
    onLoadDummy: vi.fn(),
    onLoadPipetteFile: vi.fn(),
  }

  it('renders title and section label', () => {
    render(<DeviceSelector {...defaultProps} />)
    expect(screen.getByText('Pipette')).toBeInTheDocument()
    expect(screen.getByText('Select Devices')).toBeInTheDocument()
  })

  it('shows empty state message when no devices', () => {
    render(<DeviceSelector {...defaultProps} />)
    expect(screen.getByTestId('no-device-message')).toBeInTheDocument()
  })

  it('lists devices with name and hex vendor/product ID', () => {
    render(<DeviceSelector {...defaultProps} devices={[mockDevice]} />)
    expect(screen.getByText('Test Keyboard')).toBeInTheDocument()
    expect(screen.getByText(/1234:5678/)).toBeInTheDocument()
  })

  it('shows device type label for non-vial devices', () => {
    render(<DeviceSelector {...defaultProps} devices={[mockViaDevice]} />)
    expect(screen.getByText(/\(via\)/)).toBeInTheDocument()
  })

  it('does not show type label for vial devices', () => {
    render(<DeviceSelector {...defaultProps} devices={[mockDevice]} />)
    expect(screen.queryByText(/\(vial\)/)).not.toBeInTheDocument()
  })

  it('calls onConnect when device button clicked', () => {
    const onConnect = vi.fn()
    render(<DeviceSelector {...defaultProps} devices={[mockDevice]} onConnect={onConnect} />)
    fireEvent.click(screen.getByText('Test Keyboard'))
    expect(onConnect).toHaveBeenCalledWith(mockDevice)
  })

  it('disables action buttons when connecting (tabs remain enabled)', () => {
    render(<DeviceSelector {...defaultProps} devices={[mockDevice]} connecting={true} onOpenSettings={vi.fn()} />)
    // Action buttons should be disabled
    expect(screen.getByTestId('device-button')).toBeDisabled()
    expect(screen.getByTestId('dummy-button')).toBeDisabled()
    expect(screen.getByTestId('settings-button')).toBeDisabled()
    // Tab buttons are navigation-only and remain enabled
    expect(screen.getByTestId('tab-keyboard')).not.toBeDisabled()
    expect(screen.getByTestId('tab-file')).not.toBeDisabled()
  })

  it('shows chevron instead of connecting text when connecting', () => {
    render(<DeviceSelector {...defaultProps} devices={[mockDevice]} connecting={true} />)
    // connecting text removed — chevron always shown, loading overlay handles transition
    expect(screen.queryByText('Connecting...')).not.toBeInTheDocument()
  })

  it('displays error message when error is present', () => {
    render(<DeviceSelector {...defaultProps} error="Connection failed" />)
    expect(screen.getByText('Connection failed')).toBeInTheDocument()
  })

  it('does not display error when error is null', () => {
    const { container } = render(<DeviceSelector {...defaultProps} error={null} />)
    expect(container.querySelector('.text-danger')).not.toBeInTheDocument()
  })

  it('displays multiple devices', () => {
    render(<DeviceSelector {...defaultProps} devices={[mockDevice, mockViaDevice]} />)
    expect(screen.getByText('Test Keyboard')).toBeInTheDocument()
    expect(screen.getByText('VIA Board')).toBeInTheDocument()
  })

  it('shows "Unknown Device" for device with empty productName', () => {
    const noNameDevice: DeviceInfo = { ...mockDevice, productName: '' }
    render(<DeviceSelector {...defaultProps} devices={[noNameDevice]} />)
    expect(screen.getByText('Unknown Device')).toBeInTheDocument()
  })

  it('renders dummy button in device list style', () => {
    render(<DeviceSelector {...defaultProps} />)
    const btn = screen.getByTestId('dummy-button')
    expect(btn).toBeInTheDocument()
    expect(btn).toHaveTextContent('Load from JSON file…')
  })

  it('calls onLoadDummy when dummy button clicked', () => {
    const onLoadDummy = vi.fn()
    render(<DeviceSelector {...defaultProps} onLoadDummy={onLoadDummy} />)
    fireEvent.click(screen.getByTestId('dummy-button'))
    expect(onLoadDummy).toHaveBeenCalledOnce()
  })

  it('renders settings button when onOpenSettings is provided', () => {
    const onOpenSettings = vi.fn()
    render(<DeviceSelector {...defaultProps} onOpenSettings={onOpenSettings} />)
    const btn = screen.getByTestId('settings-button')
    expect(btn).toBeInTheDocument()
    fireEvent.click(btn)
    expect(onOpenSettings).toHaveBeenCalledOnce()
  })

  it('does not render settings button when onOpenSettings is not provided', () => {
    render(<DeviceSelector {...defaultProps} />)
    expect(screen.queryByTestId('settings-button')).not.toBeInTheDocument()
  })

  it('renders data button when onOpenData is provided', () => {
    const onOpenData = vi.fn()
    render(<DeviceSelector {...defaultProps} onOpenData={onOpenData} />)
    const btn = screen.getByTestId('data-button')
    expect(btn).toBeInTheDocument()
    fireEvent.click(btn)
    expect(onOpenData).toHaveBeenCalledOnce()
  })

  it('does not render data button when onOpenData is not provided', () => {
    render(<DeviceSelector {...defaultProps} />)
    expect(screen.queryByTestId('data-button')).not.toBeInTheDocument()
  })

  it('disables data button when connecting', () => {
    render(<DeviceSelector {...defaultProps} devices={[mockDevice]} connecting={true} onOpenData={vi.fn()} onOpenSettings={vi.fn()} />)
    expect(screen.getByTestId('data-button')).toBeDisabled()
    expect(screen.getByTestId('settings-button')).toBeDisabled()
  })

  it('renders keyboard and file tabs', () => {
    render(<DeviceSelector {...defaultProps} />)
    expect(screen.getByTestId('tab-keyboard')).toBeInTheDocument()
    expect(screen.getByTestId('tab-file')).toBeInTheDocument()
  })

  it('shows keyboard tab content by default', () => {
    render(<DeviceSelector {...defaultProps} />)
    expect(screen.getByTestId('device-list')).toBeInTheDocument()
    expect(screen.getByTestId('dummy-button')).toBeInTheDocument()
    expect(screen.queryByTestId('file-tab-content')).not.toBeInTheDocument()
  })

  it('switches to file tab and shows pipette file button', () => {
    render(<DeviceSelector {...defaultProps} />)
    fireEvent.click(screen.getByTestId('tab-file'))
    expect(screen.getByTestId('file-tab-content')).toBeInTheDocument()
    expect(screen.getByTestId('pipette-file-button')).toBeInTheDocument()
    expect(screen.queryByTestId('device-list')).not.toBeInTheDocument()
  })

  it('calls onLoadPipetteFile when pipette file button clicked', () => {
    const onLoadPipetteFile = vi.fn()
    render(<DeviceSelector {...defaultProps} onLoadPipetteFile={onLoadPipetteFile} />)
    fireEvent.click(screen.getByTestId('tab-file'))
    fireEvent.click(screen.getByTestId('pipette-file-button'))
    expect(onLoadPipetteFile).toHaveBeenCalledOnce()
  })

  it('renders keyboard list in file tab', () => {
    const keyboards = [
      { uid: 'uid1', name: 'Bento', entryCount: 2 },
      { uid: 'uid2', name: 'Zoom65', entryCount: 1 },
    ]
    render(<DeviceSelector {...defaultProps} pipetteFileKeyboards={keyboards} />)
    fireEvent.click(screen.getByTestId('tab-file'))
    const kbButtons = screen.getAllByTestId('pipette-keyboard-entry')
    expect(kbButtons).toHaveLength(2)
    expect(kbButtons[0]).toHaveTextContent('Bento')
    expect(kbButtons[1]).toHaveTextContent('Zoom65')
  })

  it('navigates to entries when keyboard clicked, then back', () => {
    const keyboards = [{ uid: 'uid1', name: 'Bento', entryCount: 1 }]
    const entries = [
      { uid: 'uid1', entryId: 'e1', label: 'My Layout', keyboardName: 'Bento', savedAt: '2026-03-15T10:00:00Z' },
    ]
    render(<DeviceSelector {...defaultProps} pipetteFileKeyboards={keyboards} pipetteFileEntries={entries} />)
    fireEvent.click(screen.getByTestId('tab-file'))
    fireEvent.click(screen.getByTestId('pipette-keyboard-entry'))
    expect(screen.getByTestId('pipette-file-list')).toBeInTheDocument()
    expect(screen.getByTestId('pipette-file-entry')).toHaveTextContent('My Layout')
    // Back button
    fireEvent.click(screen.getByTestId('file-back-button'))
    expect(screen.getByTestId('pipette-keyboard-list')).toBeInTheDocument()
  })

  it('calls onOpenPipetteFileEntry when entry clicked', () => {
    const onOpen = vi.fn()
    const keyboards = [{ uid: 'uid1', name: 'Bento', entryCount: 1 }]
    const entry = { uid: 'uid1', entryId: 'e1', label: 'My Layout', keyboardName: 'Bento', savedAt: '2026-03-15T10:00:00Z' }
    render(<DeviceSelector {...defaultProps} pipetteFileKeyboards={keyboards} pipetteFileEntries={[entry]} onOpenPipetteFileEntry={onOpen} />)
    fireEvent.click(screen.getByTestId('tab-file'))
    fireEvent.click(screen.getByTestId('pipette-keyboard-entry'))
    fireEvent.click(screen.getByTestId('pipette-file-entry'))
    expect(onOpen).toHaveBeenCalledWith(entry)
  })

  it('hides keyboards that match connected device names', () => {
    const keyboards = [
      { uid: 'uid1', name: 'Bento', entryCount: 2 },
      { uid: 'uid2', name: 'Zoom65', entryCount: 1 },
    ]
    render(<DeviceSelector {...defaultProps} pipetteFileKeyboards={keyboards} connectedDeviceNames={['Bento']} />)
    fireEvent.click(screen.getByTestId('tab-file'))
    const kbButtons = screen.getAllByTestId('pipette-keyboard-entry')
    expect(kbButtons).toHaveLength(1)
    expect(kbButtons[0]).toHaveTextContent('Zoom65')
  })
})
