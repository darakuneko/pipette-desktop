// SPDX-License-Identifier: GPL-2.0-or-later
// @vitest-environment jsdom
//
// DOM-order coverage for the non-finished controls row (Next Test / Pause
// / Resume / Restart), mirroring TypingTestView.test.tsx's own
// finished-state order tests ("renders the Unnamed / Next Test controls
// row AFTER the timeline panel..."). This row used to render inline
// inside TypingTestView, above the keyboard pane (which TypingTestPane
// renders separately); it now renders from TypingTestPane itself, BELOW
// the keyboard pane and its layer note, so the reading window sits
// directly above the keyboard the user is actually typing on. The
// finished-state row is unaffected — it stays inside TypingTestView, at
// the bottom of the completion screen, since the keyboard is hidden once
// finished (see TypingTestPane.finished.test.tsx).

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => {
      const map: Record<string, string> = {
        'editor.typingTest.layerNote': 'Only MO / LT / LM layer switches are tracked. Other layer keys and advanced features may not be reflected.',
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

function fakeTypingTest(status: 'waiting' | 'running' | 'finished') {
  return {
    state: createInitialState(DEFAULT_CONFIG, DEFAULT_LANGUAGE, status),
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
}

function renderPane(status: 'waiting' | 'running' | 'finished', overrides: Partial<TypingTestPaneProps> = {}) {
  const defaults: TypingTestPaneProps = {
    typingTest: fakeTypingTest(status),
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
  }
  return render(<TypingTestPane {...defaults} {...overrides} />)
}

describe('TypingTestPane — non-finished controls row placement', () => {
  it('renders the keyboard pane BEFORE the Next Test / controls row (running)', () => {
    renderPane('running')
    const keyboard = screen.getByTestId('keyboard-widget')
    const restartButton = screen.getByTestId('typing-test-restart')
    expect(keyboard.compareDocumentPosition(restartButton) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it('renders the keyboard pane BEFORE the Next Test button (waiting)', () => {
    renderPane('waiting')
    const keyboard = screen.getByTestId('keyboard-widget')
    const startButton = screen.getByTestId('typing-test-start')
    expect(keyboard.compareDocumentPosition(startButton) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it('renders the layer note BEFORE the controls row too (running)', () => {
    renderPane('running')
    const layerNote = screen.getByTestId('typing-test-layer-note')
    const restartButton = screen.getByTestId('typing-test-restart')
    expect(layerNote.compareDocumentPosition(restartButton) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it('never renders the non-finished controls row once the run finishes (the finished row takes over, at the bottom of the completion screen)', () => {
    renderPane('finished')
    // 'Next Test' shows in both the non-finished and finished rows under
    // the same testid, so this only checks there's exactly one — the
    // finished-state one, owned by TypingTestView (see
    // TypingTestPane.finished.test.tsx).
    expect(screen.getAllByTestId('typing-test-start')).toHaveLength(1)
  })

  it('hides the non-finished controls row when hideControls is set (the "operation" toggle)', () => {
    renderPane('running', { hideControls: true })
    expect(screen.queryByTestId('typing-test-restart')).not.toBeInTheDocument()
    expect(screen.queryByTestId('typing-test-start')).not.toBeInTheDocument()
  })

  it('never renders the controls row in view-only mode', () => {
    renderPane('running', { viewOnly: true })
    expect(screen.queryByTestId('typing-test-restart')).not.toBeInTheDocument()
  })
})
