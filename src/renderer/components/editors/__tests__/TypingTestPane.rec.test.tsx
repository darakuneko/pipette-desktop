// SPDX-License-Identifier: GPL-2.0-or-later
// @vitest-environment jsdom

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => {
      const map: Record<string, string> = {
        'editor.typingTest.tab.window': 'Window',
        'editor.typingTest.tab.rec': 'REC',
        'editor.typingTest.recordStart': 'Start',
        'editor.typingTest.recordStop': 'Stop',
        'settings.trayResident': 'Stay in System Tray',
        'settings.startInTray': 'Start Hidden in Tray',
      }
      return map[key] ?? key
    },
  }),
}))

vi.mock('../../keyboard/KeyboardWidget', () => ({
  KeyboardWidget: () => <div data-testid="keyboard-widget">KeyboardWidget</div>,
}))

import { TypingTestPane, type TypingTestPaneProps } from '../TypingTestPane'
import { DEFAULT_CONFIG, DEFAULT_LANGUAGE } from '../../../typing-test/types'
import { createInitialState } from '../../../typing-test/run-state'

beforeEach(() => {
  window.vialAPI = {
    ...window.vialAPI,
    isAlwaysOnTopSupported: () => Promise.resolve(false),
    setWindowCompactMode: () => Promise.resolve(null),
    setWindowAspectRatio: () => Promise.resolve(),
    setWindowAlwaysOnTop: () => Promise.resolve(),
  } as typeof window.vialAPI
})

// Minimal stub of useTypingTest's return value — only the fields the REC
// tab's rendering path (viewOnly + menuTab='rec') actually reads.
const fakeTypingTest = {
  state: createInitialState(DEFAULT_CONFIG, DEFAULT_LANGUAGE),
  wpm: 0,
  kpm: 0,
  accuracy: 100,
  romajiGuide: null,
  elapsedSeconds: 0,
  remainingSeconds: null,
  config: DEFAULT_CONFIG,
  language: DEFAULT_LANGUAGE,
  isLanguageLoading: false,
  baseLayer: 0,
  effectiveLayer: 0,
  windowFocused: true,
  processMatrixFrame: vi.fn(),
  resetMatrixPressTracking: vi.fn(),
  processKeyEvent: vi.fn(),
  processCompositionStart: vi.fn(),
  processCompositionUpdate: vi.fn(),
  processCompositionEnd: vi.fn(),
  restart: vi.fn(),
  restartWithCountdown: vi.fn(),
  setConfig: vi.fn(),
  setLanguage: vi.fn(),
  setBaseLayer: vi.fn(),
  setWindowFocused: vi.fn(),
  captureMemory: vi.fn(),
  pause: vi.fn(),
  restoreState: vi.fn(),
} as unknown as TypingTestPaneProps['typingTest']

function renderRecTab(overrides: Partial<TypingTestPaneProps> = {}) {
  const defaults: TypingTestPaneProps = {
    typingTest: fakeTypingTest,
    onConfigChange: vi.fn(),
    onLanguageChange: vi.fn().mockResolvedValue(undefined),
    layers: 1,
    pressedKeys: new Set(),
    keycodes: new Map(),
    encoderKeycodes: new Map(),
    remappedKeys: new Set(),
    layoutOptions: new Map(),
    scale: 1,
    keys: [],
    layerLabel: '',
    viewOnly: true,
    menuTab: 'rec',
  }
  return render(<TypingTestPane {...defaults} {...overrides} />)
}

describe('TypingTestPane — REC tab tray toggles', () => {
  it('does not render the tray rows when their change handlers are not wired', () => {
    renderRecTab()
    expect(screen.queryByTestId('typing-tray-resident-toggle')).not.toBeInTheDocument()
    expect(screen.queryByTestId('typing-start-in-tray-toggle')).not.toBeInTheDocument()
  })

  it('renders both rows and reflects config values when off', () => {
    const onTrayResidentChange = vi.fn()
    const onStartInTrayChange = vi.fn()
    renderRecTab({ trayResident: false, onTrayResidentChange, startInTray: false, onStartInTrayChange })

    const trayRow = screen.getByTestId('typing-tray-resident-toggle')
    const startRow = screen.getByTestId('typing-start-in-tray-toggle')
    expect(trayRow).toHaveAttribute('aria-checked', 'false')
    expect(startRow).toHaveAttribute('aria-checked', 'false')
    expect(trayRow).toHaveTextContent('Stay in System Tray')
    expect(startRow).toHaveTextContent('Start Hidden in Tray')
  })

  it('reflects config values when on', () => {
    renderRecTab({
      trayResident: true,
      onTrayResidentChange: vi.fn(),
      startInTray: true,
      onStartInTrayChange: vi.fn(),
    })
    expect(screen.getByTestId('typing-tray-resident-toggle')).toHaveAttribute('aria-checked', 'true')
    expect(screen.getByTestId('typing-start-in-tray-toggle')).toHaveAttribute('aria-checked', 'true')
  })

  it('clicking the tray-resident row calls onTrayResidentChange', () => {
    const onTrayResidentChange = vi.fn()
    renderRecTab({ trayResident: false, onTrayResidentChange, startInTray: false, onStartInTrayChange: vi.fn() })

    fireEvent.click(screen.getByTestId('typing-tray-resident-toggle'))
    expect(onTrayResidentChange).toHaveBeenCalledWith(true)
  })

  it('disables the start-in-tray row while tray residency is off', () => {
    const onStartInTrayChange = vi.fn()
    renderRecTab({ trayResident: false, onTrayResidentChange: vi.fn(), startInTray: false, onStartInTrayChange })

    const startRow = screen.getByTestId('typing-start-in-tray-toggle')
    expect(startRow).toHaveAttribute('aria-disabled', 'true')
    fireEvent.click(startRow)
    expect(onStartInTrayChange).not.toHaveBeenCalled()
  })

  it('clicking the start-in-tray row calls onStartInTrayChange when tray residency is on', () => {
    const onStartInTrayChange = vi.fn()
    renderRecTab({ trayResident: true, onTrayResidentChange: vi.fn(), startInTray: false, onStartInTrayChange })

    const startRow = screen.getByTestId('typing-start-in-tray-toggle')
    expect(startRow).toHaveAttribute('aria-disabled', 'false')
    fireEvent.click(startRow)
    expect(onStartInTrayChange).toHaveBeenCalledWith(true)
  })

  it('turning tray residency off also clears start-in-tray when it was on', () => {
    const onTrayResidentChange = vi.fn()
    const onStartInTrayChange = vi.fn()
    renderRecTab({ trayResident: true, onTrayResidentChange, startInTray: true, onStartInTrayChange })

    fireEvent.click(screen.getByTestId('typing-tray-resident-toggle'))
    expect(onTrayResidentChange).toHaveBeenCalledWith(false)
    expect(onStartInTrayChange).toHaveBeenCalledWith(false)
  })

  it('turning tray residency off does not touch start-in-tray when it was already off', () => {
    const onTrayResidentChange = vi.fn()
    const onStartInTrayChange = vi.fn()
    renderRecTab({ trayResident: true, onTrayResidentChange, startInTray: false, onStartInTrayChange })

    fireEvent.click(screen.getByTestId('typing-tray-resident-toggle'))
    expect(onTrayResidentChange).toHaveBeenCalledWith(false)
    expect(onStartInTrayChange).not.toHaveBeenCalled()
  })
})
