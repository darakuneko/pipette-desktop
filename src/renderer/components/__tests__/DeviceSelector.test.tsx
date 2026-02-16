// SPDX-License-Identifier: GPL-2.0-or-later
// @vitest-environment jsdom

import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { DeviceSelector } from '../DeviceSelector'
import type { DeviceInfo } from '../../../shared/types/protocol'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, params?: Record<string, string>) => {
      const map: Record<string, string> = {
        'app.title': 'Pipette',
        'app.selectDevice': 'Select a device to configure',
        'app.connectedDevices': 'Connected Devices',
        'app.connecting': 'Connecting{{dots}}',
        'app.deviceNotConnected': 'No keyboard connected',
        'app.loadDummy': 'Load from JSON file…',
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
  }

  it('renders title and subtitle', () => {
    render(<DeviceSelector {...defaultProps} />)
    expect(screen.getByText('Pipette')).toBeInTheDocument()
    expect(screen.getByText('Select a device to configure')).toBeInTheDocument()
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

  it('disables all buttons when connecting', () => {
    render(<DeviceSelector {...defaultProps} devices={[mockDevice]} connecting={true} onOpenSettings={vi.fn()} />)
    const buttons = screen.getAllByRole('button')
    for (const button of buttons) {
      expect(button).toBeDisabled()
    }
  })

  it('shows connecting indicator on device when connecting', () => {
    render(<DeviceSelector {...defaultProps} devices={[mockDevice]} connecting={true} />)
    expect(screen.getByText('Connecting...')).toBeInTheDocument()
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
})
