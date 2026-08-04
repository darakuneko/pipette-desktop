// SPDX-License-Identifier: GPL-2.0-or-later
// @vitest-environment jsdom
//
// Unit coverage for the per-status button set, independent of WHERE this
// component is rendered — it used to be rendered inline by TypingTestView
// for every non-finished status; it now renders from TypingTestPane
// instead (below the keyboard pane — see TypingTestPane.controls-row-order
// .test.tsx for that placement), while TypingTestView keeps rendering it
// only for the finished state. Keeping this coverage at the component
// level (not through either parent) means it stays valid regardless of
// which parent owns the render site.

import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { I18nextProvider } from 'react-i18next'
import i18n from '../../i18n'
import { TypingTestControlsRow } from '../TypingTestControlsRow'
import type { TypingTestState } from '../useTypingTest'
import type { TypingTestConfig } from '../types'
import { DEFAULT_CONFIG } from '../types'

function makeState(overrides: Partial<TypingTestState> = {}): TypingTestState {
  return {
    status: 'waiting',
    runId: 'test-run',
    words: ['the', 'quick', 'brown'],
    currentWordIndex: 0,
    currentInput: '',
    compositionText: '',
    wordResults: [],
    startTime: null,
    endTime: null,
    correctChars: 0,
    incorrectChars: 0,
    totalKeystrokes: 0,
    confirmedChars: 0,
    kspcUncomputable: false,
    currentQuote: null,
    wpmHistory: [],
    lineBreaks: new Set(),
    lineIndents: [],
    romajiKeystrokes: '',
    romajiCapable: false,
    mistakes: {},
    romajiSegmentErred: false,
    missedPositions: [],
    ...overrides,
  }
}

function renderRow(props: Partial<Parameters<typeof TypingTestControlsRow>[0]> = {}) {
  const defaults = { state: makeState(), config: DEFAULT_CONFIG as TypingTestConfig }
  return render(
    <I18nextProvider i18n={i18n}>
      <TypingTestControlsRow {...defaults} {...props} />
    </I18nextProvider>,
  )
}

describe('TypingTestControlsRow (state-based)', () => {
  const fileImportConfig: TypingTestConfig = { mode: 'fileImport', textId: 'abc' }

  it('shows Next Test (not Restart) before a run starts', () => {
    renderRow({ config: fileImportConfig, state: makeState({ status: 'waiting' }) })
    expect(screen.getByTestId('typing-test-start')).toBeInTheDocument()
    expect(screen.queryByTestId('typing-test-restart')).toBeNull()
  })

  it('shows Pause + Restart while running (fileImport)', () => {
    renderRow({ config: fileImportConfig, state: makeState({ status: 'running' }) })
    expect(screen.getByTestId('typing-memory-pause')).toBeInTheDocument()
    expect(screen.getByTestId('typing-test-restart')).toBeInTheDocument()
  })

  it('shows Resume + Restart while paused (fileImport)', () => {
    renderRow({ config: fileImportConfig, state: makeState({ status: 'paused' }) })
    expect(screen.getByTestId('typing-memory-resume')).toBeInTheDocument()
    expect(screen.getByTestId('typing-test-restart')).toBeInTheDocument()
  })

  it('shows Resume in the waiting state when a fileImport run is saved', () => {
    renderRow({ config: fileImportConfig, state: makeState({ status: 'waiting' }), hasSavedMemory: true })
    expect(screen.getByTestId('typing-memory-resume')).toBeInTheDocument()
  })

  it('shows the result name field on finish for normal modes too', () => {
    const wordsConfig: TypingTestConfig = { mode: 'words', wordCount: 30, punctuation: false, numbers: false }
    renderRow({ config: wordsConfig, state: makeState({ status: 'finished' }) })
    expect(screen.getByTestId('typing-test-result-name')).toBeInTheDocument()
  })

  it('never shows Resume once finished, even with a saved memory', () => {
    renderRow({ config: fileImportConfig, state: makeState({ status: 'finished' }), hasSavedMemory: true })
    expect(screen.queryByTestId('typing-memory-resume')).toBeNull()
    expect(screen.getByTestId('typing-test-result-name')).toBeInTheDocument()
    expect(screen.getByTestId('typing-test-start')).toBeInTheDocument()
  })
})
