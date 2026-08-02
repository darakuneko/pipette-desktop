// SPDX-License-Identifier: GPL-2.0-or-later
// @vitest-environment jsdom

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
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

// Minimal stub of useTypingTest's return value — only the fields the
// view-only pane's rendering path actually reads.
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

function renderViewOnly(overrides: Partial<TypingTestPaneProps> = {}) {
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
    menuTab: 'window',
  }
  return render(<TypingTestPane {...defaults} {...overrides} />)
}

// The panel's click-to-toggle target has no data-testid — it's the
// viewOnly pane wrapper in TypingTestPane.tsx that flips
// viewOnlyControlsOpen on click. Selecting by its distinguishing class is
// the only handle available without adding test-only markup.
function clickPaneToToggleControls(container: HTMLElement): void {
  const target = container.querySelector('.cursor-pointer')
  if (!target) throw new Error('view-only pane click target not found')
  fireEvent.click(target)
}

describe('TypingTestPaneViewOnlyMenu — inert while closed', () => {
  it('marks the panel inert while the view-only controls are closed (mount default)', () => {
    renderViewOnly()
    const panel = screen.getByRole('menu')
    expect(panel).toHaveAttribute('inert')
  })

  it('removes inert once the controls are opened', () => {
    const { container } = renderViewOnly()
    const panel = screen.getByRole('menu')
    clickPaneToToggleControls(container)
    expect(panel).not.toHaveAttribute('inert')
  })

  it('does not warn about an empty-string boolean attribute', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    renderViewOnly()
    const inertWarning = spy.mock.calls.some((call) =>
      typeof call[0] === 'string' && call[0].includes('empty string for a boolean attribute'))
    expect(inertWarning).toBe(false)
    spy.mockRestore()
  })
})
