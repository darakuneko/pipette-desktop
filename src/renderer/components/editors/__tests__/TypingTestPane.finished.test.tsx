// SPDX-License-Identifier: GPL-2.0-or-later
// @vitest-environment jsdom
//
// Plan-completion-timeline-view PR-B, codex-review point (c): once a run
// finishes, the keymap pane (and its layer-tracking note) give way to the
// completion screen's inline keystroke timeline (rendered by
// TypingTestView) — this only applies in the EDITOR view (`viewOnly`
// false/undefined); view-only's own keyboard display stays independent of
// both `hideKeymap` and the finished-state hide (see
// TypingTestPane.tsx's `hideKeyboardForFinish` doc comment).

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import type { RunKeystrokeLog } from '../../../../shared/types/typing-run-log'

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
    // Real (non-optional) fixture — TypingTestPaneSettingsPanel reads
    // `weakSpotGate.topWeakTokens` unconditionally once mounted (its status
    // line, rendered below the DATA-section button).
    weakSpotGate: { applicable: true, status: 'unavailable' },
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

describe('TypingTestPane — keyboard hidden on the finished completion screen', () => {
  it('shows the keymap pane and layer note while running (editor mode)', () => {
    renderPane('running')
    expect(screen.getByTestId('keyboard-widget')).toBeInTheDocument()
    expect(screen.getByTestId('typing-test-layer-note')).toBeInTheDocument()
  })

  it('hides the keymap pane and layer note once the run finishes (editor mode)', () => {
    renderPane('finished')
    expect(screen.queryByTestId('keyboard-widget')).not.toBeInTheDocument()
    expect(screen.queryByTestId('typing-test-layer-note')).not.toBeInTheDocument()
  })

  it('renders no Complete heading on the finished screen (removed)', () => {
    renderPane('finished')
    expect(screen.queryByTestId('typing-test-complete')).not.toBeInTheDocument()
  })

  it('keeps showing the keymap pane in view-only mode even once finished', () => {
    renderPane('finished', { viewOnly: true })
    expect(screen.getByTestId('keyboard-widget')).toBeInTheDocument()
  })
})

describe('TypingTestPane — completion screen flex-height chain (no fixed vh cap)', () => {
  it('the TypingTestView wrapper carries min-h-0 (alongside its pre-existing flex-1) — the link this component owns in the chain', () => {
    renderPane('finished')
    // TypingTestView's own root (testid="typing-test-view") is the next
    // link down; its wrapper here (the one this component renders it
    // inside) is the one this file is responsible for keeping correct.
    const view = screen.getByTestId('typing-test-view')
    const wrapper = view.parentElement!
    expect(wrapper.className).toContain('min-h-0')
    expect(wrapper.className).toContain('flex-1')
  })

  it('the chain reaches all the way down to the rows scrollport, still with no max-h-* cap anywhere', () => {
    // A log (with a matching runId) is required for the inline timeline
    // panel to actually render — otherwise TypingTestView falls back to
    // the (non-scrolling) stats row, and there is no scrollport to check.
    const typingTest = fakeTypingTest('finished')
    const log: RunKeystrokeLog = {
      runId: typingTest.state.runId,
      uid: 'uid-1',
      startedAt: '2026-01-01T00:00:00.000Z',
      durationMs: 5000,
      mode: 'words',
      language: 'english',
      words: [{ index: 0, display: 'hi', typed: 'hi', correct: true, keystrokes: [] }],
    }
    renderPane('finished', { typingTest, lastFinishedLog: log })
    const scrollport = screen.getByTestId('word-timeline-canvas').parentElement!
    expect(scrollport.className).toContain('flex-1')
    expect(scrollport.className).toContain('min-h-0')
    expect(scrollport.className).toContain('overflow-auto')
    expect(scrollport.className).not.toMatch(/\bmax-h-/)
  })
})
