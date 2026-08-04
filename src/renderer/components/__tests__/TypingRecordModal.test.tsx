// SPDX-License-Identifier: GPL-2.0-or-later
// @vitest-environment jsdom

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'

const TRANSLATIONS: Record<string, string> = {
  'editor.typingTest.recordModalTitle': 'Recording Settings',
  'editor.typingTest.recordStart': 'Start',
  'editor.typingTest.recordStop': 'Stop',
  'editor.typingTest.monitorApp.label': 'Monitor App',
  'editor.typingTest.heatmapWindow': 'Heatmap window (minutes)',
  'settings.trayResident': 'Stay in System Tray',
  'settings.startInTray': 'Start Hidden in Tray',
  'editor.typingTest.consent.title': 'Enable typing analytics recording?',
  'editor.typingTest.consent.accept': 'Enable',
  'common.cancel': 'Cancel',
  'common.close': 'Close',
}

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) => {
      if (key === 'editor.typingTest.heatmapWindowOption' && opts?.minutes !== undefined) {
        return `${opts.minutes} min`
      }
      return TRANSLATIONS[key] ?? key
    },
  }),
}))

interface MockAppConfig {
  trayResident?: boolean
  startInTray?: boolean
  typingMonitorAppEnabled?: boolean
  typingHeatmapWindowMin?: number
  typingRecordingConsentAccepted?: boolean
}

let mockConfig: MockAppConfig = {}
const setFn = vi.fn()

vi.mock('../../hooks/useAppConfig', () => ({
  useAppConfig: () => ({
    config: mockConfig,
    loading: false,
    set: setFn,
  }),
}))

import { TypingRecordModal } from '../TypingRecordModal'

beforeEach(() => {
  mockConfig = {}
  setFn.mockClear()
})

function renderModal(overrides: { typingRecordEnabled?: boolean; onTypingRecordEnabledChange?: (enabled: boolean) => void; onClose?: () => void } = {}) {
  return render(
    <TypingRecordModal
      onClose={overrides.onClose ?? vi.fn()}
      typingRecordEnabled={overrides.typingRecordEnabled ?? false}
      onTypingRecordEnabledChange={overrides.onTypingRecordEnabledChange ?? vi.fn()}
    />,
  )
}

describe('TypingRecordModal — tray toggles', () => {
  it('reflects config values when off', () => {
    mockConfig = { trayResident: false, startInTray: false }
    renderModal()
    expect(screen.getByTestId('typing-tray-resident-toggle')).toHaveAttribute('aria-checked', 'false')
    expect(screen.getByTestId('typing-start-in-tray-toggle')).toHaveAttribute('aria-checked', 'false')
    expect(screen.getByTestId('typing-tray-resident-toggle')).toHaveTextContent('Stay in System Tray')
    expect(screen.getByTestId('typing-start-in-tray-toggle')).toHaveTextContent('Start Hidden in Tray')
  })

  it('reflects config values when on', () => {
    mockConfig = { trayResident: true, startInTray: true }
    renderModal()
    expect(screen.getByTestId('typing-tray-resident-toggle')).toHaveAttribute('aria-checked', 'true')
    expect(screen.getByTestId('typing-start-in-tray-toggle')).toHaveAttribute('aria-checked', 'true')
  })

  it('clicking the tray-resident row saves the toggled value', () => {
    mockConfig = { trayResident: false, startInTray: false }
    renderModal()
    fireEvent.click(screen.getByTestId('typing-tray-resident-toggle'))
    expect(setFn).toHaveBeenCalledWith('trayResident', true)
  })

  it('disables the start-in-tray row while tray residency is off, and clicking it is a no-op', () => {
    mockConfig = { trayResident: false, startInTray: false }
    renderModal()
    const startRow = screen.getByTestId('typing-start-in-tray-toggle')
    expect(startRow).toHaveAttribute('aria-disabled', 'true')
    fireEvent.click(startRow)
    expect(setFn).not.toHaveBeenCalledWith('startInTray', expect.anything())
  })

  it('clicking the start-in-tray row saves the toggled value when tray residency is on', () => {
    mockConfig = { trayResident: true, startInTray: false }
    renderModal()
    const startRow = screen.getByTestId('typing-start-in-tray-toggle')
    expect(startRow).toHaveAttribute('aria-disabled', 'false')
    fireEvent.click(startRow)
    expect(setFn).toHaveBeenCalledWith('startInTray', true)
  })

  it('turning tray residency off also clears start-in-tray when it was on', () => {
    mockConfig = { trayResident: true, startInTray: true }
    renderModal()
    fireEvent.click(screen.getByTestId('typing-tray-resident-toggle'))
    expect(setFn).toHaveBeenCalledWith('trayResident', false)
    expect(setFn).toHaveBeenCalledWith('startInTray', false)
  })

  it('turning tray residency off does not touch start-in-tray when it was already off', () => {
    mockConfig = { trayResident: true, startInTray: false }
    renderModal()
    fireEvent.click(screen.getByTestId('typing-tray-resident-toggle'))
    expect(setFn).toHaveBeenCalledWith('trayResident', false)
    expect(setFn).not.toHaveBeenCalledWith('startInTray', expect.anything())
  })
})

describe('TypingRecordModal — Monitor App toggle', () => {
  it('is disabled while REC is off, and clicking it is a no-op', () => {
    renderModal({ typingRecordEnabled: false })
    const row = screen.getByTestId('monitor-app-toggle')
    expect(row).toHaveAttribute('aria-disabled', 'true')
    fireEvent.click(row)
    expect(setFn).not.toHaveBeenCalledWith('typingMonitorAppEnabled', expect.anything())
  })

  it('toggles when REC is on', () => {
    mockConfig = { typingMonitorAppEnabled: false }
    renderModal({ typingRecordEnabled: true })
    const row = screen.getByTestId('monitor-app-toggle')
    expect(row).toHaveAttribute('aria-disabled', 'false')
    fireEvent.click(row)
    expect(setFn).toHaveBeenCalledWith('typingMonitorAppEnabled', true)
  })
})

describe('TypingRecordModal — record toggle + consent flow', () => {
  it('starting REC without consent opens the consent modal instead of enabling directly', () => {
    mockConfig = { typingRecordingConsentAccepted: false }
    const onTypingRecordEnabledChange = vi.fn()
    renderModal({ typingRecordEnabled: false, onTypingRecordEnabledChange })
    fireEvent.click(screen.getByTestId('typing-record-toggle'))
    expect(screen.getByTestId('typing-consent-modal')).toBeInTheDocument()
    expect(onTypingRecordEnabledChange).not.toHaveBeenCalled()
  })

  it('accepting consent persists the flag and enables REC', () => {
    mockConfig = { typingRecordingConsentAccepted: false }
    const onTypingRecordEnabledChange = vi.fn()
    renderModal({ typingRecordEnabled: false, onTypingRecordEnabledChange })
    fireEvent.click(screen.getByTestId('typing-record-toggle'))
    fireEvent.click(screen.getByTestId('typing-consent-accept'))
    expect(setFn).toHaveBeenCalledWith('typingRecordingConsentAccepted', true)
    expect(onTypingRecordEnabledChange).toHaveBeenCalledWith(true)
    expect(screen.queryByTestId('typing-consent-modal')).not.toBeInTheDocument()
  })

  it('cancelling consent does not enable REC and leaves the Record modal open', () => {
    mockConfig = { typingRecordingConsentAccepted: false }
    const onTypingRecordEnabledChange = vi.fn()
    renderModal({ typingRecordEnabled: false, onTypingRecordEnabledChange })
    fireEvent.click(screen.getByTestId('typing-record-toggle'))
    fireEvent.click(screen.getByTestId('typing-consent-cancel'))
    expect(onTypingRecordEnabledChange).not.toHaveBeenCalled()
    expect(screen.queryByTestId('typing-consent-modal')).not.toBeInTheDocument()
    expect(screen.getByTestId('typing-record-modal')).toBeInTheDocument()
  })

  it('starting REC when consent was already accepted enables directly, no consent modal', () => {
    mockConfig = { typingRecordingConsentAccepted: true }
    const onTypingRecordEnabledChange = vi.fn()
    renderModal({ typingRecordEnabled: false, onTypingRecordEnabledChange })
    fireEvent.click(screen.getByTestId('typing-record-toggle'))
    expect(onTypingRecordEnabledChange).toHaveBeenCalledWith(true)
    expect(screen.queryByTestId('typing-consent-modal')).not.toBeInTheDocument()
  })

  it('stopping REC never shows the consent modal', () => {
    const onTypingRecordEnabledChange = vi.fn()
    renderModal({ typingRecordEnabled: true, onTypingRecordEnabledChange })
    fireEvent.click(screen.getByTestId('typing-record-toggle'))
    expect(onTypingRecordEnabledChange).toHaveBeenCalledWith(false)
    expect(screen.queryByTestId('typing-consent-modal')).not.toBeInTheDocument()
  })
})

describe('TypingRecordModal — HeatMap window select', () => {
  it('reads the current AppConfig value and saves a new one on change', () => {
    mockConfig = { typingHeatmapWindowMin: 5 }
    renderModal()
    const select = screen.getByTestId('heatmap-window-select') as HTMLSelectElement
    expect(select.value).toBe('5')
    fireEvent.change(select, { target: { value: '15' } })
    expect(setFn).toHaveBeenCalledWith('typingHeatmapWindowMin', 15)
  })
})

describe('TypingRecordModal — close', () => {
  it('calls onClose when the close button is clicked', () => {
    const onClose = vi.fn()
    renderModal({ onClose })
    fireEvent.click(screen.getByTestId('typing-record-close'))
    expect(onClose).toHaveBeenCalledOnce()
  })
})
