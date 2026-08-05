// SPDX-License-Identifier: GPL-2.0-or-later
// @vitest-environment jsdom

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { I18nextProvider } from 'react-i18next'
import i18n from '../../i18n'
import { TypingTestHistory } from '../TypingTestHistory'
import type { TypingTestResult } from '../../../shared/types/pipette-settings'
import type { TypingTestTextMeta } from '../../../shared/types/typing-test-text-store'

function makeResult(overrides: Partial<TypingTestResult> = {}): TypingTestResult {
  return {
    date: new Date().toISOString(),
    wpm: 60,
    accuracy: 95,
    wordCount: 30,
    correctChars: 100,
    incorrectChars: 5,
    durationSeconds: 30,
    mode: 'words',
    mode2: 30,
    ...overrides,
  }
}

function renderWithI18n(ui: React.ReactElement) {
  return render(<I18nextProvider i18n={i18n}>{ui}</I18nextProvider>)
}

/** Same as renderWithI18n, but also switches the period filter to "All
 *  Time". The period filter defaults to "1 month" (see
 *  history-period-filter.ts), so any test using a fixture `date` more than
 *  a month before the real wall-clock "now" — most of the ones below, which
 *  pin specific ISO strings to assert sort order / CSV content rather than
 *  to exercise the period feature itself — needs this to keep its rows
 *  visible. Tests that specifically cover the period filter render with
 *  plain renderWithI18n instead, so its default stays exercised. */
function renderWithI18nAllTime(ui: React.ReactElement) {
  const result = renderWithI18n(ui)
  fireEvent.change(screen.getByTestId('history-filter-period'), { target: { value: 'all' } })
  return result
}

/** Minimal TypingTestTextMeta builder for source-tab classification tests —
 *  only `source` (aozora-provider detection) and `id` matter here. */
function textMeta(id: string, name: string, source?: { provider: string; workId: string }): TypingTestTextMeta {
  return { id, name, wordCount: 10, filename: `${id}.json`, savedAt: '', updatedAt: '', source }
}

beforeEach(() => {
  // TypingTestHistory now calls useTypingTestTexts() to classify fileImport
  // rows into Aozora vs File Import — default to no imported texts so
  // pre-existing tests (which don't care about the Aozora split) are
  // unaffected. Tests below override this per-case.
  window.vialAPI = {
    ...window.vialAPI,
    typingTestTextStoreList: vi.fn().mockResolvedValue({ success: true, data: [] }),
  } as typeof window.vialAPI
})

describe('TypingTestHistory', () => {
  it('shows no results message when empty', () => {
    renderWithI18n(<TypingTestHistory results={[]} />)
    expect(screen.getByText(/no results/i)).toBeTruthy()
  })

  it('shows stats summary with results', () => {
    const results = [
      makeResult({ wpm: 80 }),
      makeResult({ wpm: 60 }),
    ]
    renderWithI18n(<TypingTestHistory results={results} />)
    // Best WPM should be 80 (appears in stats and possibly in table)
    expect(screen.getAllByText('80').length).toBeGreaterThan(0)
  })

  it('shows results table', () => {
    const results = [
      makeResult({ wpm: 80, isPb: true }),
      makeResult({ wpm: 60 }),
    ]
    renderWithI18n(<TypingTestHistory results={results} />)
    const history = screen.getByTestId('typing-test-history')
    expect(history.querySelector('table')).toBeTruthy()
    // Header shows PB text, cell shows trophy icon
    expect(screen.getAllByText('PB').length).toBeGreaterThanOrEqual(1) // header
    const svgs = history.querySelectorAll('svg[aria-label="PB"]')
    expect(svgs.length).toBe(1) // cell trophy icon
  })

  it('filters by mode via the dropdown', () => {
    const results = [
      makeResult({ wpm: 80, mode: 'words', mode2: 30 }),
      makeResult({ wpm: 90, mode: 'time', mode2: 60 }),
      makeResult({ wpm: 70, mode: 'quote', mode2: 'short' }),
    ]
    renderWithI18n(<TypingTestHistory results={results} />)
    const select = screen.getByTestId('history-filter-mode')

    // Default is 'all', all three should show
    expect(screen.getAllByText('80').length).toBeGreaterThan(0)
    expect(screen.getAllByText('90').length).toBeGreaterThan(0)
    expect(screen.getAllByText('70').length).toBeGreaterThan(0)

    // Select 'words'
    fireEvent.change(select, { target: { value: 'words' } })
    expect(screen.getAllByText('80').length).toBeGreaterThan(0)
    expect(screen.queryByText('90')).toBeNull()
    expect(screen.queryByText('70')).toBeNull()

    // Select 'time'
    fireEvent.change(select, { target: { value: 'time' } })
    expect(screen.queryByText('80')).toBeNull()
    expect(screen.getAllByText('90').length).toBeGreaterThan(0)

    // Back to 'all'
    fireEvent.change(select, { target: { value: 'all' } })
    expect(screen.getAllByText('80').length).toBeGreaterThan(0)
    expect(screen.getAllByText('90').length).toBeGreaterThan(0)
    expect(screen.getAllByText('70').length).toBeGreaterThan(0)
  })

  it('filters the Text tab by imported text via the dropdown', () => {
    const results = [
      makeResult({ wpm: 80, mode: 'fileImport', mode2: 't1', fileImportTextName: 'Alpha' }),
      makeResult({ wpm: 65, mode: 'fileImport', mode2: 't2', fileImportTextName: 'Beta' }),
    ]
    renderWithI18n(<TypingTestHistory results={results} />)

    // Switch to the Text tab
    fireEvent.change(screen.getByTestId('history-filter-source'), { target: { value: 'text' } })
    expect(screen.getAllByText('80').length).toBeGreaterThan(0)
    expect(screen.getAllByText('65').length).toBeGreaterThan(0)

    // Filter to a single text → the other text's row drops out
    fireEvent.change(screen.getByTestId('history-filter-text'), { target: { value: 't1' } })
    expect(screen.getAllByText('80').length).toBeGreaterThan(0)
    expect(screen.queryByText('65')).toBeNull()
  })

  it('shows the Text-tab filter dropdown even with a single imported text', () => {
    const results = [
      makeResult({ wpm: 80, mode: 'fileImport', mode2: 't1', fileImportTextName: 'Alpha' }),
    ]
    renderWithI18n(<TypingTestHistory results={results} />)

    // The Monkeytype tab never renders the text filter…
    expect(screen.queryByTestId('history-filter-text')).toBeNull()

    // …but the Text tab shows it as soon as one imported text exists, matching
    // the always-present Normal mode filter.
    fireEvent.change(screen.getByTestId('history-filter-source'), { target: { value: 'text' } })
    expect(screen.getByTestId('history-filter-text')).toBeTruthy()
  })

  it('sorts by WPM when clicking header', () => {
    const results = [
      makeResult({ wpm: 60, date: '2025-01-03T00:00:00Z' }),
      makeResult({ wpm: 90, date: '2025-01-02T00:00:00Z' }),
      makeResult({ wpm: 75, date: '2025-01-01T00:00:00Z' }),
    ]
    renderWithI18nAllTime(<TypingTestHistory results={results} />)

    const rows = () => {
      const history = screen.getByTestId('typing-test-history')
      const trs = history.querySelectorAll('tbody tr')
      return Array.from(trs).map((tr) => {
        const cells = tr.querySelectorAll('td')
        // Columns: Name, Date, WPM, Accuracy, Mode, Duration, PB
        return Number(cells[2].textContent)
      })
    }

    // Default sort is date desc (most recent first) → 60, 90, 75
    expect(rows()).toEqual([60, 90, 75])

    // Click WPM header button → sort by WPM desc
    const wpmButton = screen.getByRole('button', { name: /WPM/i })
    fireEvent.click(wpmButton)
    expect(rows()).toEqual([90, 75, 60])

    // Click again → sort by WPM asc
    fireEvent.click(wpmButton)
    expect(rows()).toEqual([60, 75, 90])
  })

  it('renders and sorts the Avg Hold column, formatted "N ms", with a legacy (no raw fields) row sorting to the low end', () => {
    const results = [
      makeResult({ wpm: 60, date: '2025-01-03T00:00:00Z', holdSumMs: 300, holdSamples: 3 }), // 100 ms
      makeResult({ wpm: 90, date: '2025-01-02T00:00:00Z', holdSumMs: 800, holdSamples: 5 }), // 160 ms
      makeResult({ wpm: 75, date: '2025-01-01T00:00:00Z' }), // legacy, no raw fields
    ]
    renderWithI18nAllTime(<TypingTestHistory results={results} />)

    const cellsFor = (idx: number) => {
      const history = screen.getByTestId('typing-test-history')
      const trs = history.querySelectorAll('tbody tr')
      return Array.from(trs).map((tr) => tr.querySelectorAll('td')[idx].textContent)
    }

    // Column order: Name, Date, WPM, KPM, Accuracy, Avg Hold, Mode, Duration, PB.
    // Default sort is date desc → 100ms, 160ms, legacy(—).
    expect(cellsFor(5)).toEqual(['100 ms', '160 ms', '—'])

    // Header shows the abbreviated "AKH" label (see the dedicated header
    // test below for the full-label tooltip); the accessible name comes
    // from the button's own rendered text, not the portaled tooltip bubble.
    const avgHoldButton = screen.getByRole('button', { name: /AKH/i })
    fireEvent.click(avgHoldButton) // desc
    expect(cellsFor(5)).toEqual(['160 ms', '100 ms', '—'])

    fireEvent.click(avgHoldButton) // asc — the legacy row (treated as lowest) sorts first
    expect(cellsFor(5)).toEqual(['—', '100 ms', '160 ms'])
  })

  // Header polish: the Avg Key Hold column header abbreviates to "AKH" (the
  // full column gained width pressure once KPM/Accuracy/Avg Hold all landed
  // side by side), with the full label available via hover tooltip so the
  // abbreviation isn't a dead end. Sorting must keep working off the same
  // button.
  it('abbreviates the Avg Hold header to "AKH" with a tooltip showing the full label, sorting still works', () => {
    const results = [
      makeResult({ wpm: 60, date: '2025-01-03T00:00:00Z', holdSumMs: 300, holdSamples: 3 }), // 100 ms
      makeResult({ wpm: 90, date: '2025-01-02T00:00:00Z', holdSumMs: 800, holdSamples: 5 }), // 160 ms
    ]
    renderWithI18nAllTime(<TypingTestHistory results={results} />)

    const avgHoldButton = screen.getByRole('button', { name: 'AKH' })
    expect(avgHoldButton.textContent).toContain('AKH')
    expect(avgHoldButton.textContent).not.toContain('Avg Key Hold')

    // The full label surfaces via the tooltip bubble (portaled, always in
    // the DOM per the Tooltip component — see NameCell's "kept" test for
    // the same assertion shape).
    const tooltipBubble = screen.getByText('Avg Key Hold')
    expect(tooltipBubble.getAttribute('role')).toBe('tooltip')

    // Tooltip wraps the button itself (not an inner span) — aria-describedby
    // must land on the focusable, sortable button so assistive tech and
    // keyboard focus both reach the full-label description.
    expect(avgHoldButton.getAttribute('aria-describedby')).toBe(tooltipBubble.id)

    // Sorting is unaffected by the label swap.
    const cellsFor = (idx: number) => {
      const history = screen.getByTestId('typing-test-history')
      const trs = history.querySelectorAll('tbody tr')
      return Array.from(trs).map((tr) => tr.querySelectorAll('td')[idx].textContent)
    }
    expect(cellsFor(5)).toEqual(['100 ms', '160 ms'])
    fireEvent.click(avgHoldButton)
    expect(cellsFor(5)).toEqual(['160 ms', '100 ms'])
  })

  // Mode column carries variable-width strings (e.g. Tatoeba's composite
  // "Tatoeba 10 Lines (japanese_hiragana)" label) that must ellipsis-
  // truncate instead of wrapping/stretching the table, with the full text
  // reachable via hover tooltip — same treatment as the Name column.
  it('truncates a long Mode cell and exposes the full text via tooltip', () => {
    const results = [
      makeResult({
        mode: 'tatoeba',
        mode2: 'japanese_hiragana|lines|10',
        language: 'japanese_hiragana',
        date: '2025-01-01T00:00:00Z',
      }),
    ]
    renderWithI18nAllTime(<TypingTestHistory results={results} />)
    fireEvent.change(screen.getByTestId('history-filter-source'), { target: { value: 'tatoeba' } })

    const fullText = 'Tatoeba 10 Lines (japanese_hiragana)'
    const history = screen.getByTestId('typing-test-history')
    const modeCell = Array.from(history.querySelectorAll('tbody td')).find((td) => td.textContent === fullText)
    expect(modeCell).toBeTruthy()
    expect(modeCell!.className).toContain('max-w-')
    const truncatedSpan = modeCell!.querySelector('span')
    expect(truncatedSpan).toBeTruthy()
    expect(truncatedSpan!.className).toContain('truncate')

    // Full text is duplicated into the (always-mounted) tooltip bubble.
    expect(screen.getAllByText(fullText).length).toBeGreaterThan(1)
  })

  it('sets aria-sort on active sort column', () => {
    const results = [makeResult({ wpm: 60 })]
    renderWithI18n(<TypingTestHistory results={results} />)

    const history = screen.getByTestId('typing-test-history')
    const headers = history.querySelectorAll('th[aria-sort]')

    // Date header should be 'descending' by default
    const dateHeader = Array.from(headers).find((h) => h.getAttribute('aria-sort') === 'descending')
    expect(dateHeader).toBeTruthy()

    // Other sortable headers should be 'none'
    const noneHeaders = Array.from(headers).filter((h) => h.getAttribute('aria-sort') === 'none')
    expect(noneHeaders.length).toBe(6) // wpm, kpm, accuracy, avgHold, mode, duration
  })

  it('computes stats from filtered data', () => {
    const results = [
      makeResult({ wpm: 100, mode: 'words' }),
      makeResult({ wpm: 50, mode: 'time' }),
    ]
    renderWithI18n(<TypingTestHistory results={results} />)

    // Filter to words only
    fireEvent.change(screen.getByTestId('history-filter-mode'), { target: { value: 'words' } })

    // Stats should reflect only words results (best=100, tests=1)
    expect(screen.getAllByText('100').length).toBeGreaterThan(0)
    // totalTests = 1 (only one words result after filtering)
    expect(screen.getAllByText('1').length).toBeGreaterThan(0)
  })

  it('shows export button and calls onExportCsv with CSV data', () => {
    const onExportCsv = vi.fn()
    const results = [
      makeResult({ wpm: 80, date: '2025-01-01T00:00:00Z', mode: 'words', mode2: 30 }),
    ]
    renderWithI18nAllTime(<TypingTestHistory results={results} onExportCsv={onExportCsv} />)

    const exportBtn = screen.getByTestId('history-export-csv')
    expect(exportBtn).toBeTruthy()

    fireEvent.click(exportBtn)
    expect(onExportCsv).toHaveBeenCalledTimes(1)

    const csv = onExportCsv.mock.calls[0][0] as string
    expect(csv).toContain('date,name,wpm,kpm,accuracy')
    expect(csv).toContain('2025-01-01T00:00:00Z')
    expect(csv).toContain('80')
    // Default (MonkeyType tab, All) → 'monkeytype' slug
    expect(onExportCsv.mock.calls[0][1]).toBe('monkeytype')
  })

  it('includes a kspc CSV column, formatted to 2 decimal places, for a result carrying the raw fields', () => {
    const onExportCsv = vi.fn()
    const results = [
      makeResult({ wpm: 80, date: '2025-01-01T00:00:00Z', kspcKeystrokes: 6, kspcChars: 4 }),
    ]
    renderWithI18nAllTime(<TypingTestHistory results={results} onExportCsv={onExportCsv} />)

    fireEvent.click(screen.getByTestId('history-export-csv'))
    const csv = onExportCsv.mock.calls[0][0] as string
    expect(csv).toContain('date,name,wpm,kpm,accuracy,kspc,')
    expect(csv).toContain('1.50')
  })

  it('leaves the kspc CSV cell empty for a legacy result with no raw fields', () => {
    const onExportCsv = vi.fn()
    const results = [
      makeResult({ wpm: 80, date: '2025-01-01T00:00:00Z' }), // no kspcKeystrokes/kspcChars
    ]
    renderWithI18nAllTime(<TypingTestHistory results={results} onExportCsv={onExportCsv} />)

    fireEvent.click(screen.getByTestId('history-export-csv'))
    const csv = onExportCsv.mock.calls[0][0] as string
    const [, dataLine] = csv.split('\n')
    const headers = csv.split('\n')[0].split(',')
    const kspcIndex = headers.indexOf('kspc')
    expect(dataLine.split(',')[kspcIndex]).toBe('')
  })

  it('includes an avgHoldMs CSV column, rounded to the nearest ms, for a result carrying the raw fields', () => {
    const onExportCsv = vi.fn()
    const results = [
      makeResult({ wpm: 80, date: '2025-01-01T00:00:00Z', holdSumMs: 241, holdSamples: 3 }), // 80.33... -> 80
    ]
    renderWithI18nAllTime(<TypingTestHistory results={results} onExportCsv={onExportCsv} />)

    fireEvent.click(screen.getByTestId('history-export-csv'))
    const csv = onExportCsv.mock.calls[0][0] as string
    const [headerLine, dataLine] = csv.split('\n')
    const headers = headerLine.split(',')
    expect(headers).toContain('avgHoldMs')
    expect(dataLine.split(',')[headers.indexOf('avgHoldMs')]).toBe('80')
  })

  it('leaves the avgHoldMs CSV cell empty for a legacy result with no raw fields', () => {
    const onExportCsv = vi.fn()
    const results = [
      makeResult({ wpm: 80, date: '2025-01-01T00:00:00Z' }), // no holdSumMs/holdSamples
    ]
    renderWithI18nAllTime(<TypingTestHistory results={results} onExportCsv={onExportCsv} />)

    fireEvent.click(screen.getByTestId('history-export-csv'))
    const csv = onExportCsv.mock.calls[0][0] as string
    const [headerLine, dataLine] = csv.split('\n')
    const headers = headerLine.split(',')
    expect(dataLine.split(',')[headers.indexOf('avgHoldMs')]).toBe('')
  })

  it('includes raw error-class CSV columns for a result carrying the 4-field group', () => {
    const onExportCsv = vi.fn()
    const results = [
      makeResult({
        wpm: 80, date: '2025-01-01T00:00:00Z',
        errorSubstitutions: 2, errorOmissions: 1, errorInsertions: 0, errorTargetChars: 40,
      }),
    ]
    renderWithI18nAllTime(<TypingTestHistory results={results} onExportCsv={onExportCsv} />)

    fireEvent.click(screen.getByTestId('history-export-csv'))
    const csv = onExportCsv.mock.calls[0][0] as string
    const [headerLine, dataLine] = csv.split('\n')
    const headers = headerLine.split(',')
    expect(headers).toContain('errorSubstitutions')
    expect(headers).toContain('errorOmissions')
    expect(headers).toContain('errorInsertions')
    expect(headers).toContain('errorTargetChars')
    const cells = dataLine.split(',')
    expect(cells[headers.indexOf('errorSubstitutions')]).toBe('2')
    expect(cells[headers.indexOf('errorOmissions')]).toBe('1')
    expect(cells[headers.indexOf('errorInsertions')]).toBe('0')
    expect(cells[headers.indexOf('errorTargetChars')]).toBe('40')
  })

  it('leaves error-class CSV cells empty for a legacy result with no raw fields', () => {
    const onExportCsv = vi.fn()
    const results = [
      makeResult({ wpm: 80, date: '2025-01-01T00:00:00Z' }),
    ]
    renderWithI18nAllTime(<TypingTestHistory results={results} onExportCsv={onExportCsv} />)

    fireEvent.click(screen.getByTestId('history-export-csv'))
    const csv = onExportCsv.mock.calls[0][0] as string
    const [headerLine, dataLine] = csv.split('\n')
    const headers = headerLine.split(',')
    const cells = dataLine.split(',')
    expect(cells[headers.indexOf('errorSubstitutions')]).toBe('')
    expect(cells[headers.indexOf('errorTargetChars')]).toBe('')
  })

  it('passes a filename slug reflecting the active filter selection', () => {
    const onExportCsv = vi.fn()
    const results = [
      makeResult({ wpm: 80, mode: 'words', mode2: 30 }),
      makeResult({ wpm: 70, mode: 'fileImport', mode2: 't1', fileImportTextName: 'Alpha' }),
    ]
    renderWithI18n(<TypingTestHistory results={results} onExportCsv={onExportCsv} />)

    // MonkeyType tab, filter to words → 'monkeytype-words'
    fireEvent.change(screen.getByTestId('history-filter-mode'), { target: { value: 'words' } })
    fireEvent.click(screen.getByTestId('history-export-csv'))
    expect(onExportCsv.mock.calls.at(-1)?.[1]).toBe('monkeytype-words')

    // Text tab, all → 'text'
    fireEvent.change(screen.getByTestId('history-filter-source'), { target: { value: 'text' } })
    fireEvent.click(screen.getByTestId('history-export-csv'))
    expect(onExportCsv.mock.calls.at(-1)?.[1]).toBe('text')
  })

  it('does not show export button when onExportCsv is not provided', () => {
    renderWithI18n(<TypingTestHistory results={[makeResult()]} />)
    expect(screen.queryByTestId('history-export-csv')).toBeNull()
  })

  it('renames a result via the naming modal and calls onRename', () => {
    const date = '2025-02-02T03:04:05.000Z'
    const onRename = vi.fn()
    renderWithI18nAllTime(<TypingTestHistory results={[makeResult({ date })]} onRename={onRename} />)
    // The name cell opens the naming modal; type and Save commits.
    fireEvent.click(screen.getByTestId(`history-name-${date}`))
    const input = screen.getByTestId('result-name-modal-input')
    fireEvent.change(input, { target: { value: 'QWERTY baseline' } })
    fireEvent.click(screen.getByTestId('result-name-modal-save'))
    expect(onRename).toHaveBeenCalledWith(date, 'QWERTY baseline')
  })

  it('shows the imported-text name (not the textId) for fileImport-mode rows under the Text tab', () => {
    const results = [makeResult({
      mode: 'fileImport',
      mode2: 'b286fff1-78d1-40d5-8ea0-6dd57561badf',
      fileImportTextName: 'my-novel.txt',
    })]
    renderWithI18n(<TypingTestHistory results={results} />)
    // FileImport rows live under the Text tab, not Monkeytype (the default).
    fireEvent.change(screen.getByTestId('history-filter-source'), { target: { value: 'text' } })
    // The name shows in the table row (the dropdown also lists it as an
    // option) — the Mode/Text cell truncates via a nested span, so the text
    // itself lives there rather than directly on the td.
    expect(screen.getByText('my-novel.txt', { selector: 'span' })).toBeTruthy()
    expect(screen.queryByText(/b286fff1/)).toBeNull()
  })

  it('shows a KPM column derived from chars and duration', () => {
    // correctChars 100 over 30s → 100 * 60 / 30 = 200 KPM.
    renderWithI18n(<TypingTestHistory results={[makeResult({ correctChars: 100, durationSeconds: 30 })]} />)
    expect(screen.getAllByText('200').length).toBeGreaterThan(0)
  })

  it('separates Monkeytype and Text results via the source select', () => {
    const results = [
      makeResult({ wpm: 81, mode: 'words', mode2: 30 }),
      makeResult({ wpm: 82, mode: 'fileImport', mode2: 'id-1', fileImportTextName: 'novel.txt' }),
    ]
    renderWithI18n(<TypingTestHistory results={results} />)
    // Monkeytype (default source): words result shown, fileImport hidden.
    expect(screen.getAllByText('81').length).toBeGreaterThan(0)
    expect(screen.queryByText('novel.txt')).toBeNull()
    // Switch the source select to File Import: fileImport result shown, words hidden.
    fireEvent.change(screen.getByTestId('history-filter-source'), { target: { value: 'text' } })
    // The name shows in the table row (the dropdown also lists it as an
    // option) — the Mode/Text cell truncates via a nested span, so the text
    // itself lives there rather than directly on the td.
    expect(screen.getByText('novel.txt', { selector: 'span' })).toBeTruthy()
    expect(screen.queryByText('81')).toBeNull()
  })

  it('deletes a result only after confirmation', () => {
    const date = '2025-03-03T01:02:03.000Z'
    const onDelete = vi.fn()
    renderWithI18nAllTime(<TypingTestHistory results={[makeResult({ date })]} onDelete={onDelete} />)
    // First click asks for confirmation, does not delete yet.
    fireEvent.click(screen.getByTestId(`history-delete-${date}`))
    expect(onDelete).not.toHaveBeenCalled()
    fireEvent.click(screen.getByTestId(`history-delete-confirm-${date}`))
    expect(onDelete).toHaveBeenCalledWith(date)
  })

  it('cancels deletion when cancel is clicked', () => {
    const date = '2025-04-04T01:02:03.000Z'
    const onDelete = vi.fn()
    renderWithI18nAllTime(<TypingTestHistory results={[makeResult({ date })]} onDelete={onDelete} />)
    fireEvent.click(screen.getByTestId(`history-delete-${date}`))
    fireEvent.click(screen.getByTestId(`history-delete-cancel-${date}`))
    expect(onDelete).not.toHaveBeenCalled()
    // Delete button is back.
    expect(screen.getByTestId(`history-delete-${date}`)).toBeTruthy()
  })

  it('shows no delete button when no onDelete handler', () => {
    renderWithI18n(<TypingTestHistory results={[makeResult({ date: 'd1' })]} />)
    expect(screen.queryByTestId('history-delete-d1')).toBeNull()
  })

  // Regression guard: pins sparkline-then-stats order, matching the Analyze
  // chart-above-stats convention (RolloverSection's order-lock test is the
  // original of this pattern).
  it('renders the sparkline above the stats row', () => {
    const results = [
      makeResult({ wpm: 80 }),
      makeResult({ wpm: 60 }),
    ]
    renderWithI18n(<TypingTestHistory results={results} />)
    const sparkline = screen.getByTestId('history-sparkline')
    const stats = screen.getByTestId('history-stats')
    // DOCUMENT_POSITION_FOLLOWING (4) set on `sparkline` relative to
    // `stats` means the sparkline comes first in document order.
    expect(sparkline.compareDocumentPosition(stats) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  // WPM sparkline -> titled recharts chart with hover tooltips (parity with
  // the Accuracy Trend chart): the Results view now shows an uppercase
  // "WPM Trend" heading above a chart carrying the same tooltip machinery,
  // instead of a bare unlabeled SVG polyline.
  it('shows the WPM Trend heading and a tooltip-bearing chart once 2+ results exist', () => {
    const results = [
      makeResult({ wpm: 80 }),
      makeResult({ wpm: 60 }),
    ]
    renderWithI18n(<TypingTestHistory results={results} />)
    const sparkline = screen.getByTestId('history-sparkline')
    expect(sparkline.textContent).toContain('WPM Trend')
    const chart = screen.getByTestId('wpm-trend-chart')
    expect(sparkline.contains(chart)).toBe(true)
  })

  it('renders the name read-only (no edit) when no onRename handler', () => {
    // date: 'x' here is a non-date identifier (drives the `history-name-x`
    // testid below), not a real timestamp — renderWithI18nAllTime is
    // required so the period filter's "unparseable date" drop (see
    // history-period-filter.ts) doesn't exclude this row under the default
    // 1-month window.
    renderWithI18nAllTime(<TypingTestHistory results={[makeResult({ date: 'x', name: 'kept' })]} />)
    expect(screen.queryByTestId('history-name-x')).toBeNull()
    // The name shows in the cell (and again in its hover tooltip bubble).
    expect(screen.getAllByText('kept').length).toBeGreaterThan(0)
  })

  // Regression guard for the History modal overflow fix: the sections
  // between the tabs and the results table (accuracy-trend/mistake-ranking/
  // error-mix) must live inside their own scroll container, separate from
  // the tabs above and the results table below, so a tall stack of sections
  // can't push the table past the modal's bottom edge.
  //
  // Updated for the Results/Analysis secondary-tab split: the three lower
  // sections now render only under the Analysis view tab (the sparkline/
  // stats moved into the Results view alongside the table), so this test
  // checks the Results-view table floor first, then switches to Analysis to
  // check the scroll wrapper.
  it('wraps the Analysis sections in their own scroll container, and gives the Results table a min-height floor', () => {
    const results = [
      makeResult({ wpm: 60, accuracy: 90, mistakes: { a: 3, b: 2 } }),
      makeResult({ wpm: 65, accuracy: 92, mistakes: { a: 1 } }),
    ]
    renderWithI18n(<TypingTestHistory results={results} />)

    // Root: min-h-0 flex-1 (NOT h-full) — it's a flex child of
    // HistoryToggle's `flex h-modal-80vh flex-col` modal box, sitting
    // below the title row. h-full resolves to 100% of the modal's own
    // content-box height, ignoring the title row's share, which pushed
    // this div (and everything below it) a constant ~20px past the
    // modal's bottom edge regardless of content or window size. flex-1
    // makes it consume exactly the space left over after the title row.
    const root = screen.getByTestId('typing-test-history')
    expect(root.className).toContain('min-h-0')
    expect(root.className).toContain('flex-1')
    expect(root.className).not.toContain('h-full')

    // Results view (default): the results-table wrapper carries a min-h-48
    // floor so it never collapses to zero height.
    const table = root.querySelector('table')
    expect(table).toBeTruthy()
    const tableWrapper = table!.parentElement as HTMLElement
    expect(tableWrapper.className).toContain('min-h-48')
    expect(tableWrapper.className).toContain('flex-1')
    expect(tableWrapper.className).toContain('overflow-y-auto')

    // Analysis view: the three lower sections live in their own scroll wrapper.
    fireEvent.click(screen.getByTestId('history-view-tab-analysis'))
    const sections = screen.getByTestId('history-sections')
    expect(sections.className).toContain('min-h-0')
    expect(sections.className).toContain('shrink')
    expect(sections.className).toContain('overflow-y-auto')

    // Contains the three lower sections (heading + chart/list content).
    expect(sections.querySelector('[data-testid="typing-test-mistake-ranking"]')).toBeTruthy()
    expect(sections.querySelector('[data-testid="typing-test-error-mix"]')).toBeTruthy()

    // The condition select itself now lives in the header's right-end
    // group (sibling of the Results/Analysis tabs), not inside this scroll
    // wrapper — only the "ACCURACY TREND" heading + chart stay here.
    expect(sections.querySelector('[data-testid="history-condition-filter"]')).toBeNull()
    expect(screen.getByTestId('history-condition-filter')).toBeTruthy()

    // Does NOT contain the source select or the results table — the source
    // select lives in the header (always visible, outside this wrapper);
    // the table is a different view, unmounted while Analysis is active.
    expect(sections.querySelector('[data-testid="history-filter-source"]')).toBeNull()
    expect(sections.querySelector('table')).toBeNull()
  })

  describe('Accuracy Trend condition selector', () => {
    // The three lower sections (Accuracy Trend / Mistake Ranking / Error Mix)
    // now live under the secondary "Analysis" view tab (see the "secondary
    // view tabs" describe block below), so every test here switches to it
    // before touching `history-condition-filter` / `accuracy-trend-chart`.
    it('defaults to the latest run\'s condition and hides the chart below 2 same-condition runs', () => {
      // Newest-first, mirroring the real prop order (useDevicePrefs prepends
      // new runs) that the condition grouping relies on.
      const results = [
        makeResult({ wpm: 80, accuracy: 96, mode: 'time', mode2: 30, language: 'english', date: '2026-01-03T00:00:00.000Z' }),
        makeResult({ wpm: 65, accuracy: 92, mode: 'words', mode2: 30, language: 'english', date: '2026-01-02T00:00:00.000Z' }),
        makeResult({ wpm: 60, accuracy: 90, mode: 'words', mode2: 30, language: 'english', date: '2026-01-01T00:00:00.000Z' }),
      ]
      renderWithI18nAllTime(<TypingTestHistory results={results} />)
      fireEvent.click(screen.getByTestId('history-view-tab-analysis'))
      const select = screen.getByTestId('history-condition-filter') as HTMLSelectElement
      expect(select.options.length).toBe(2)
      // The latest run (2026-01-03) is 'time', so it's the default selection.
      expect(select.value).toContain('time')
      // Its condition only has 1 run, so the chart doesn't render yet.
      expect(screen.queryByTestId('accuracy-trend-chart')).toBeNull()
    })

    it('renders the trend chart once the selected condition has 2+ runs', () => {
      const results = [
        makeResult({ wpm: 60, accuracy: 90, mode: 'words', mode2: 30, language: 'english', date: '2026-01-01T00:00:00.000Z' }),
        makeResult({ wpm: 65, accuracy: 92, mode: 'words', mode2: 30, language: 'english', date: '2026-01-02T00:00:00.000Z' }),
      ]
      renderWithI18nAllTime(<TypingTestHistory results={results} />)
      fireEvent.click(screen.getByTestId('history-view-tab-analysis'))
      expect(screen.getByTestId('accuracy-trend-chart')).toBeTruthy()
    })

    it('switches the trend chart series when a different condition is selected', () => {
      // Newest-first, mirroring the real prop order (useDevicePrefs prepends
      // new runs) that the condition grouping relies on.
      const results = [
        makeResult({ wpm: 70, accuracy: 88, mode: 'time', mode2: 60, language: 'english', date: '2026-01-04T00:00:00.000Z' }),
        makeResult({ wpm: 65, accuracy: 92, mode: 'words', mode2: 30, language: 'english', date: '2026-01-02T00:00:00.000Z' }),
        makeResult({ wpm: 60, accuracy: 90, mode: 'words', mode2: 30, language: 'english', date: '2026-01-01T00:00:00.000Z' }),
      ]
      renderWithI18nAllTime(<TypingTestHistory results={results} />)
      fireEvent.click(screen.getByTestId('history-view-tab-analysis'))
      // Default (latest = time|60) has only 1 run → no chart yet.
      expect(screen.queryByTestId('accuracy-trend-chart')).toBeNull()

      const select = screen.getByTestId('history-condition-filter')
      const wordsOption = Array.from((select as HTMLSelectElement).options).find((o) => o.value.startsWith('words|'))
      expect(wordsOption).toBeTruthy()
      fireEvent.change(select, { target: { value: wordsOption!.value } })
      expect(screen.getByTestId('accuracy-trend-chart')).toBeTruthy()
    })

    it('is independent of the mode filter dropdown (coarse filter above it)', () => {
      const results = [
        makeResult({ wpm: 60, accuracy: 90, mode: 'words', mode2: 30, language: 'english', date: '2026-01-01T00:00:00.000Z' }),
        makeResult({ wpm: 65, accuracy: 92, mode: 'words', mode2: 30, language: 'english', date: '2026-01-02T00:00:00.000Z' }),
      ]
      renderWithI18nAllTime(<TypingTestHistory results={results} />)
      fireEvent.click(screen.getByTestId('history-view-tab-analysis'))
      expect(screen.getByTestId('accuracy-trend-chart')).toBeTruthy()
      // The mode filter dropdown lives in the Results view — switch there to
      // reach it, change it, then switch back to Analysis. The condition
      // selector/chart must be unaffected either way, since it's scoped to
      // the whole tab's results (tabResults), not the mode-filtered table.
      fireEvent.click(screen.getByTestId('history-view-tab-results'))
      fireEvent.change(screen.getByTestId('history-filter-mode'), { target: { value: 'time' } })
      fireEvent.click(screen.getByTestId('history-view-tab-analysis'))
      expect(screen.getByTestId('accuracy-trend-chart')).toBeTruthy()
    })

    it('is not shown when the active tab has no results', () => {
      renderWithI18n(<TypingTestHistory results={[]} />)
      fireEvent.click(screen.getByTestId('history-view-tab-analysis'))
      expect(screen.queryByTestId('history-condition-filter')).toBeNull()
    })
  })

  describe('secondary view tabs (Results / Analysis)', () => {
    it('defaults to the Results view: table + sparkline/stats visible, analysis sections absent', () => {
      const results = [
        makeResult({ wpm: 80 }),
        makeResult({ wpm: 60 }),
      ]
      renderWithI18n(<TypingTestHistory results={results} />)
      const history = screen.getByTestId('typing-test-history')
      expect(history.querySelector('table')).toBeTruthy()
      expect(screen.getByTestId('history-sparkline')).toBeTruthy()
      expect(screen.getByTestId('history-stats')).toBeTruthy()
      expect(screen.queryByTestId('history-sections')).toBeNull()
      expect(screen.queryByTestId('typing-test-mistake-ranking')).toBeNull()
      expect(screen.queryByTestId('typing-test-error-mix')).toBeNull()
    })

    it('switching to Analysis shows the three sections and hides the table/filter/sparkline/stats, then switching back restores Results', () => {
      const results = [
        makeResult({ wpm: 60, accuracy: 90, mistakes: { a: 3, b: 2 } }),
        makeResult({ wpm: 65, accuracy: 92, mistakes: { a: 1 } }),
      ]
      renderWithI18n(<TypingTestHistory results={results} />)

      fireEvent.click(screen.getByTestId('history-view-tab-analysis'))
      expect(screen.getByTestId('history-sections')).toBeTruthy()
      expect(screen.getByTestId('typing-test-mistake-ranking')).toBeTruthy()
      expect(screen.getByTestId('typing-test-error-mix')).toBeTruthy()
      expect(screen.getByTestId('typing-test-history').querySelector('table')).toBeNull()
      expect(screen.queryByTestId('history-filter-mode')).toBeNull()
      expect(screen.queryByTestId('history-sparkline')).toBeNull()
      expect(screen.queryByTestId('history-stats')).toBeNull()

      fireEvent.click(screen.getByTestId('history-view-tab-results'))
      expect(screen.getByTestId('typing-test-history').querySelector('table')).toBeTruthy()
      expect(screen.getByTestId('history-filter-mode')).toBeTruthy()
      expect(screen.getByTestId('history-sparkline')).toBeTruthy()
      expect(screen.getByTestId('history-stats')).toBeTruthy()
      expect(screen.queryByTestId('history-sections')).toBeNull()
    })

    it('keeps the secondary view selection when switching the source select (MonkeyType/Text)', () => {
      const results = [
        makeResult({ wpm: 81, mode: 'words', mode2: 30 }),
        makeResult({ wpm: 82, mode: 'fileImport', mode2: 'id-1', fileImportTextName: 'novel.txt' }),
      ]
      renderWithI18n(<TypingTestHistory results={results} />)
      fireEvent.click(screen.getByTestId('history-view-tab-analysis'))
      expect(screen.getByTestId('history-sections')).toBeTruthy()

      fireEvent.change(screen.getByTestId('history-filter-source'), { target: { value: 'text' } })
      // Secondary view tab selection persists across the source-select switch.
      expect(screen.getByTestId('history-sections')).toBeTruthy()
      expect(screen.getByTestId('typing-test-history').querySelector('table')).toBeNull()
    })

    it('wires the secondary view tabs with a full ARIA tab pattern', () => {
      renderWithI18n(<TypingTestHistory results={[makeResult()]} />)

      const tablist = screen.getByRole('tablist', { name: 'History view' })
      expect(tablist).toBeTruthy()

      const resultsTab = screen.getByTestId('history-view-tab-results')
      const analysisTab = screen.getByTestId('history-view-tab-analysis')
      expect(resultsTab.getAttribute('role')).toBe('tab')
      expect(analysisTab.getAttribute('role')).toBe('tab')
      expect(resultsTab.getAttribute('aria-selected')).toBe('true')
      expect(analysisTab.getAttribute('aria-selected')).toBe('false')

      const resultsPanelId = resultsTab.getAttribute('aria-controls')
      expect(resultsPanelId).toBeTruthy()
      const resultsPanel = document.getElementById(resultsPanelId!)
      expect(resultsPanel?.getAttribute('role')).toBe('tabpanel')
      expect(resultsPanel?.getAttribute('aria-labelledby')).toBe(resultsTab.id)

      fireEvent.click(analysisTab)
      expect(analysisTab.getAttribute('aria-selected')).toBe('true')
      expect(resultsTab.getAttribute('aria-selected')).toBe('false')

      const analysisPanelId = analysisTab.getAttribute('aria-controls')
      expect(analysisPanelId).toBeTruthy()
      const analysisPanel = document.getElementById(analysisPanelId!)
      expect(analysisPanel?.getAttribute('role')).toBe('tabpanel')
      expect(analysisPanel?.getAttribute('aria-labelledby')).toBe(analysisTab.id)
    })

    // Regression guard: an earlier version of this split wrapped each panel
    // component in its own plain `<div role="tabpanel" ...>` in
    // TypingTestHistory, with the panel component's real content nested one
    // level inside it. That extra div's default `display: block` broke the
    // flex min-h-0/shrink chain HistorySections relies on for its
    // overflow-y-auto scroll region to actually engage, silently
    // reintroducing the #377 modal-overflow bug (caught via screenshot, not
    // by DOM presence/absence assertions — hence this structural check).
    // The fix makes each panel component apply role=tabpanel/id/
    // aria-labelledby directly to its OWN existing root div, so the
    // tabpanel element IS the flex/scroll container, not a wrapper around it.
    it('keeps each view tabpanel as part of the flex sizing chain (no unconstrained wrapper div)', () => {
      const results = [
        makeResult({ wpm: 60, accuracy: 90, mistakes: { a: 3, b: 2 } }),
        makeResult({ wpm: 65, accuracy: 92, mistakes: { a: 1 } }),
      ]
      renderWithI18n(<TypingTestHistory results={results} />)

      // Panel ids are React-useId-derived (not the static strings this test
      // used before), so look them up via the tab's aria-controls rather
      // than a hardcoded id.
      const resultsTab = screen.getByTestId('history-view-tab-results')
      const analysisTab = screen.getByTestId('history-view-tab-analysis')

      // Results view: the tabpanel IS HistoryResultsPanel's own root div —
      // continuing the parent's `flex flex-col` chain (flex + min-h-0 +
      // flex-1), not a bare block div wrapping it.
      const resultsPanel = document.getElementById(resultsTab.getAttribute('aria-controls')!)
      expect(resultsPanel).toBeTruthy()
      expect(resultsPanel!.className).toContain('flex')
      expect(resultsPanel!.className).toContain('min-h-0')
      expect(resultsPanel!.className).toContain('flex-1')

      fireEvent.click(analysisTab)

      // Analysis view: the tabpanel IS HistorySections' own scroll wrapper
      // (same element as the `history-sections` testid) — its min-h-0/
      // shrink/overflow-y-auto classes are what actually contain the tall
      // section stack, so they must land on the tabpanel element itself.
      const analysisPanel = document.getElementById(analysisTab.getAttribute('aria-controls')!)
      expect(analysisPanel).toBeTruthy()
      expect(analysisPanel).toBe(screen.getByTestId('history-sections'))
      expect(analysisPanel!.className).toContain('flex')
      expect(analysisPanel!.className).toContain('min-h-0')
      expect(analysisPanel!.className).toContain('shrink')
      expect(analysisPanel!.className).toContain('overflow-y-auto')
    })

    // P2-1 (codex review): sort state used to live inside HistoryResultsPanel,
    // which unmounts whenever the Analysis view is active (conditional
    // render) — so a chosen sort silently reset on every round trip through
    // Analysis. The fix lifts sortColumn/sortDirection into TypingTestHistory
    // itself, which never unmounts.
    it('preserves the results-table sort selection across a Results→Analysis→Results round trip', () => {
      const results = [
        makeResult({ wpm: 60, date: '2025-01-03T00:00:00Z' }),
        makeResult({ wpm: 90, date: '2025-01-02T00:00:00Z' }),
        makeResult({ wpm: 75, date: '2025-01-01T00:00:00Z' }),
      ]
      renderWithI18nAllTime(<TypingTestHistory results={results} />)

      const rows = () => {
        const history = screen.getByTestId('typing-test-history')
        const trs = history.querySelectorAll('tbody tr')
        return Array.from(trs).map((tr) => Number(tr.querySelectorAll('td')[2].textContent))
      }

      // Default sort is date desc (most recent first) → 60, 90, 75
      expect(rows()).toEqual([60, 90, 75])

      // Sort by WPM desc
      const wpmButton = screen.getByRole('button', { name: /WPM/i })
      fireEvent.click(wpmButton)
      expect(rows()).toEqual([90, 75, 60])

      // Round-trip through Analysis and back to Results — the sort
      // selection must survive since HistoryResultsPanel fully unmounts
      // while Analysis is active.
      fireEvent.click(screen.getByTestId('history-view-tab-analysis'))
      fireEvent.click(screen.getByTestId('history-view-tab-results'))
      expect(rows()).toEqual([90, 75, 60])

      // aria-sort on the WPM header should also reflect the preserved
      // column/direction, not reset back to the date-desc default.
      const activeHeader = screen.getByTestId('typing-test-history').querySelector('th[aria-sort="descending"]')
      expect(activeHeader?.textContent).toContain('WPM')
    })

    // P2-2 (codex review): APG tabs pattern — arrow keys move focus AND
    // selection between the two view tabs, roving tabIndex keeps the
    // tablist a single Tab stop. Scoped to the NEW view tabs only; the
    // source select (MonkeyType/Tatoeba/Aozora/File Import) is a plain
    // `<select>`, not a tablist, and is untouched by this pattern.
    it('supports APG roving-tabindex arrow-key navigation between the view tabs', () => {
      renderWithI18n(<TypingTestHistory results={[makeResult()]} />)
      const resultsTab = screen.getByTestId('history-view-tab-results') as HTMLButtonElement
      const analysisTab = screen.getByTestId('history-view-tab-analysis') as HTMLButtonElement

      // Roving tabIndex: only the active tab is in the page's Tab order.
      expect(resultsTab.tabIndex).toBe(0)
      expect(analysisTab.tabIndex).toBe(-1)

      resultsTab.focus()
      fireEvent.keyDown(resultsTab, { key: 'ArrowRight' })
      // Automatic activation: the arrow key moves both focus AND selection.
      expect(document.activeElement).toBe(analysisTab)
      expect(analysisTab.getAttribute('aria-selected')).toBe('true')
      expect(resultsTab.getAttribute('aria-selected')).toBe('false')
      expect(analysisTab.tabIndex).toBe(0)
      expect(resultsTab.tabIndex).toBe(-1)
      expect(screen.getByTestId('history-sections')).toBeTruthy()

      fireEvent.keyDown(analysisTab, { key: 'ArrowLeft' })
      expect(document.activeElement).toBe(resultsTab)
      expect(resultsTab.getAttribute('aria-selected')).toBe('true')
      expect(resultsTab.tabIndex).toBe(0)
      expect(analysisTab.tabIndex).toBe(-1)

      // Home/End jump to the first/last tab regardless of current position.
      fireEvent.keyDown(resultsTab, { key: 'End' })
      expect(document.activeElement).toBe(analysisTab)
      expect(analysisTab.getAttribute('aria-selected')).toBe('true')

      fireEvent.keyDown(analysisTab, { key: 'Home' })
      expect(document.activeElement).toBe(resultsTab)
      expect(resultsTab.getAttribute('aria-selected')).toBe('true')
    })
  })

  describe('source select: Tatoeba and Aozora classified separately from MonkeyType/File Import', () => {
    it('classifies mode "tatoeba" rows into their own source-select value, out of MonkeyType', () => {
      const results = [
        makeResult({ wpm: 81, mode: 'words', mode2: 30 }),
        makeResult({ wpm: 77, mode: 'tatoeba', mode2: 'english|lines|5', language: 'english' }),
      ]
      renderWithI18n(<TypingTestHistory results={results} />)

      // MonkeyType tab (default): only the words row.
      expect(screen.getAllByText('81').length).toBeGreaterThan(0)
      expect(screen.queryByText('77')).toBeNull()

      // Tatoeba tab: only the tatoeba row.
      fireEvent.change(screen.getByTestId('history-filter-source'), { target: { value: 'tatoeba' } })
      expect(screen.getAllByText('77').length).toBeGreaterThan(0)
      expect(screen.queryByText('81')).toBeNull()
    })

    it('classifies a fileImport row whose text meta has source.provider "aozora" into the Aozora tab, not File Import', async () => {
      window.vialAPI.typingTestTextStoreList = vi.fn().mockResolvedValue({
        success: true,
        data: [textMeta('aozora-1', 'Kokoro', { provider: 'aozora', workId: 'works/42' })],
      })
      const results = [
        makeResult({ wpm: 55, mode: 'fileImport', mode2: 'aozora-1', fileImportTextName: 'Kokoro' }),
        makeResult({ wpm: 66, mode: 'fileImport', mode2: 'plain-1', fileImportTextName: 'my-notes.txt' }),
      ]
      renderWithI18n(<TypingTestHistory results={results} />)
      await waitFor(() => expect(window.vialAPI.typingTestTextStoreList).toHaveBeenCalled())

      // Aozora tab: only the aozora-provider row.
      fireEvent.change(screen.getByTestId('history-filter-source'), { target: { value: 'aozora' } })
      await waitFor(() => expect(screen.getAllByText('55').length).toBeGreaterThan(0))
      expect(screen.queryByText('66')).toBeNull()

      // File Import tab: only the plain (non-aozora) row.
      fireEvent.change(screen.getByTestId('history-filter-source'), { target: { value: 'text' } })
      expect(screen.getAllByText('66').length).toBeGreaterThan(0)
      expect(screen.queryByText('55')).toBeNull()
    })

    it('classifies a fileImport row with no resolvable text meta, and a legacy mode "custom" row, into File Import', async () => {
      window.vialAPI.typingTestTextStoreList = vi.fn().mockResolvedValue({ success: true, data: [] })
      const results = [
        // fileImport row whose textId isn't in the text store (e.g. deleted text).
        makeResult({ wpm: 71, mode: 'fileImport', mode2: 'gone-1', fileImportTextName: 'deleted.txt' }),
        // Pre-rename legacy row — mode 'custom' predates the fileImport rename
        // and must not fall through to MonkeyType.
        makeResult({ wpm: 72, mode: 'custom' as TypingTestResult['mode'], mode2: 'legacy-1' }),
      ]
      renderWithI18n(<TypingTestHistory results={results} />)
      await waitFor(() => expect(window.vialAPI.typingTestTextStoreList).toHaveBeenCalled())

      // Neither row shows under MonkeyType.
      expect(screen.queryByText('71')).toBeNull()
      expect(screen.queryByText('72')).toBeNull()

      // Both show under File Import.
      fireEvent.change(screen.getByTestId('history-filter-source'), { target: { value: 'text' } })
      expect(screen.getAllByText('71').length).toBeGreaterThan(0)
      expect(screen.getAllByText('72').length).toBeGreaterThan(0)

      // Neither shows under Aozora.
      fireEvent.change(screen.getByTestId('history-filter-source'), { target: { value: 'aozora' } })
      expect(screen.queryByText('71')).toBeNull()
      expect(screen.queryByText('72')).toBeNull()
    })

    it('hides the sub-filter dropdown entirely on the Tatoeba tab', () => {
      const results = [
        makeResult({ mode: 'tatoeba', mode2: 'english|lines|5', language: 'english' }),
      ]
      renderWithI18n(<TypingTestHistory results={results} />)
      fireEvent.change(screen.getByTestId('history-filter-source'), { target: { value: 'tatoeba' } })
      expect(screen.queryByTestId('history-filter-mode')).toBeNull()
      expect(screen.queryByTestId('history-filter-text')).toBeNull()
    })

    it('scopes the Aozora and File Import text dropdowns to only their own tab\'s texts', async () => {
      window.vialAPI.typingTestTextStoreList = vi.fn().mockResolvedValue({
        success: true,
        data: [textMeta('aozora-1', 'Kokoro', { provider: 'aozora', workId: 'works/42' })],
      })
      const results = [
        makeResult({ wpm: 55, mode: 'fileImport', mode2: 'aozora-1', fileImportTextName: 'Kokoro' }),
        makeResult({ wpm: 66, mode: 'fileImport', mode2: 'plain-1', fileImportTextName: 'my-notes.txt' }),
      ]
      renderWithI18n(<TypingTestHistory results={results} />)
      await waitFor(() => expect(window.vialAPI.typingTestTextStoreList).toHaveBeenCalled())

      fireEvent.change(screen.getByTestId('history-filter-source'), { target: { value: 'aozora' } })
      await waitFor(() => expect(screen.getByTestId('history-filter-text')).toBeTruthy())
      let options = Array.from((screen.getByTestId('history-filter-text') as HTMLSelectElement).options).map((o) => o.value)
      expect(options).toEqual(['all', 'aozora-1'])

      fireEvent.change(screen.getByTestId('history-filter-source'), { target: { value: 'text' } })
      options = Array.from((screen.getByTestId('history-filter-text') as HTMLSelectElement).options).map((o) => o.value)
      expect(options).toEqual(['all', 'plain-1'])
    })

    it('feeds the Analysis view from the active source tab\'s results (Tatoeba)', () => {
      const results = [
        makeResult({ wpm: 81, mode: 'words', mode2: 30, accuracy: 90, mistakes: { a: 3 } }),
        makeResult({ wpm: 77, mode: 'tatoeba', mode2: 'english|lines|5', language: 'english', accuracy: 88, mistakes: { b: 2 } }),
      ]
      renderWithI18n(<TypingTestHistory results={results} />)
      fireEvent.change(screen.getByTestId('history-filter-source'), { target: { value: 'tatoeba' } })
      fireEvent.click(screen.getByTestId('history-view-tab-analysis'))
      expect(screen.getByTestId('history-sections')).toBeTruthy()
      // The condition selector only has the tatoeba row's condition available
      // when Tatoeba is the active source tab.
      const select = screen.getByTestId('history-condition-filter') as HTMLSelectElement
      expect(Array.from(select.options).every((o) => o.value.startsWith('tatoeba|'))).toBe(true)
    })

    it('extends the export filename slug for the new tabs (tatoeba, aozora / aozora-<textId>)', async () => {
      window.vialAPI.typingTestTextStoreList = vi.fn().mockResolvedValue({
        success: true,
        data: [textMeta('aozora-1', 'Kokoro', { provider: 'aozora', workId: 'works/42' })],
      })
      const onExportCsv = vi.fn()
      const results = [
        makeResult({ wpm: 77, mode: 'tatoeba', mode2: 'english|lines|5', language: 'english' }),
        makeResult({ wpm: 55, mode: 'fileImport', mode2: 'aozora-1', fileImportTextName: 'Kokoro' }),
      ]
      renderWithI18n(<TypingTestHistory results={results} onExportCsv={onExportCsv} />)
      await waitFor(() => expect(window.vialAPI.typingTestTextStoreList).toHaveBeenCalled())

      fireEvent.change(screen.getByTestId('history-filter-source'), { target: { value: 'tatoeba' } })
      fireEvent.click(screen.getByTestId('history-export-csv'))
      expect(onExportCsv.mock.calls.at(-1)?.[1]).toBe('tatoeba')

      fireEvent.change(screen.getByTestId('history-filter-source'), { target: { value: 'aozora' } })
      await waitFor(() => expect(screen.getByTestId('history-export-csv')).toBeTruthy())
      fireEvent.click(screen.getByTestId('history-export-csv'))
      expect(onExportCsv.mock.calls.at(-1)?.[1]).toBe('aozora')

      fireEvent.change(screen.getByTestId('history-filter-text'), { target: { value: 'aozora-1' } })
      fireEvent.click(screen.getByTestId('history-export-csv'))
      expect(onExportCsv.mock.calls.at(-1)?.[1]).toBe('aozora-Kokoro')
    })
  })

  // Header redesign: the source tabs (MonkeyType/Tatoeba/Aozora/File Import)
  // that used to be their own row are gone entirely — source selection is
  // now a `<select>` at the right end of the single Results/Analysis tab
  // row, and (Analysis only) the Accuracy Trend condition select joins it
  // as a second select in the same right-end group.
  describe('single header row: Results/Analysis tabs + right-end selects', () => {
    it('never renders a source-tab button anywhere in the document', () => {
      renderWithI18n(<TypingTestHistory results={[makeResult()]} />)
      expect(document.querySelector('[data-testid^="history-tab-"]')).toBeNull()
    })

    it('renders the source select with exactly 4 options, in tab order, and it switches the visible results', () => {
      const results = [
        makeResult({ wpm: 81, mode: 'words', mode2: 30 }),
        makeResult({ wpm: 77, mode: 'tatoeba', mode2: 'english|lines|5', language: 'english' }),
      ]
      renderWithI18n(<TypingTestHistory results={results} />)
      const select = screen.getByTestId('history-filter-source') as HTMLSelectElement
      const values = Array.from(select.options).map((o) => o.value)
      expect(values).toEqual(['monkeytype', 'tatoeba', 'aozora', 'text'])

      // Default (monkeytype): only the words row.
      expect(screen.getAllByText('81').length).toBeGreaterThan(0)
      expect(screen.queryByText('77')).toBeNull()

      // Switching the select's value re-classifies which rows show, exactly
      // like the old tab-click behavior did.
      fireEvent.change(select, { target: { value: 'tatoeba' } })
      expect(screen.getAllByText('77').length).toBeGreaterThan(0)
      expect(screen.queryByText('81')).toBeNull()
    })

    it('shows only the source select at the right end in the Results view — no condition select', () => {
      const results = [
        makeResult({ wpm: 60, accuracy: 90, mode: 'words', mode2: 30, language: 'english' }),
        makeResult({ wpm: 65, accuracy: 92, mode: 'words', mode2: 30, language: 'english' }),
      ]
      renderWithI18n(<TypingTestHistory results={results} />)
      expect(screen.getByTestId('history-filter-source')).toBeTruthy()
      expect(screen.queryByTestId('history-condition-filter')).toBeNull()
    })

    it('shows the source select AND the condition select together in the Analysis view, source first', () => {
      const results = [
        makeResult({ wpm: 60, accuracy: 90, mode: 'words', mode2: 30, language: 'english' }),
        makeResult({ wpm: 65, accuracy: 92, mode: 'words', mode2: 30, language: 'english' }),
      ]
      renderWithI18n(<TypingTestHistory results={results} />)
      fireEvent.click(screen.getByTestId('history-view-tab-analysis'))

      const sourceSelect = screen.getByTestId('history-filter-source')
      const conditionSelect = screen.getByTestId('history-condition-filter')

      // Order per the approved redesign sketch: source select first, then
      // the condition select. DOCUMENT_POSITION_FOLLOWING (4) set on
      // `conditionSelect` relative to `sourceSelect` means the source select
      // comes first in document order.
      expect(sourceSelect.compareDocumentPosition(conditionSelect) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    })

    it('changing the condition select changes the accuracy-trend chart while staying in Analysis', () => {
      const results = [
        makeResult({ wpm: 70, accuracy: 88, mode: 'time', mode2: 60, language: 'english', date: '2026-01-04T00:00:00.000Z' }),
        makeResult({ wpm: 65, accuracy: 92, mode: 'words', mode2: 30, language: 'english', date: '2026-01-02T00:00:00.000Z' }),
        makeResult({ wpm: 60, accuracy: 90, mode: 'words', mode2: 30, language: 'english', date: '2026-01-01T00:00:00.000Z' }),
      ]
      renderWithI18nAllTime(<TypingTestHistory results={results} />)
      fireEvent.click(screen.getByTestId('history-view-tab-analysis'))

      // Default (latest = time|60) has only 1 run → no chart yet.
      expect(screen.queryByTestId('accuracy-trend-chart')).toBeNull()

      const select = screen.getByTestId('history-condition-filter') as HTMLSelectElement
      const wordsOption = Array.from(select.options).find((o) => o.value.startsWith('words|'))
      expect(wordsOption).toBeTruthy()
      fireEvent.change(select, { target: { value: wordsOption!.value } })
      expect(screen.getByTestId('accuracy-trend-chart')).toBeTruthy()
    })

    it('gives the condition select no visible text label — only the ACCURACY TREND heading is visible above the chart', () => {
      const results = [
        makeResult({ wpm: 60, accuracy: 90, mode: 'words', mode2: 30, language: 'english' }),
        makeResult({ wpm: 65, accuracy: 92, mode: 'words', mode2: 30, language: 'english' }),
      ]
      renderWithI18n(<TypingTestHistory results={results} />)
      fireEvent.click(screen.getByTestId('history-view-tab-analysis'))

      const select = screen.getByTestId('history-condition-filter')
      // aria-label only — no rendered label text, and the select's own
      // accessible name comes purely from that attribute.
      expect(select.getAttribute('aria-label')).toBeTruthy()
      expect(select.previousElementSibling?.tagName).not.toBe('LABEL')
      expect(document.querySelector('label[for]')).toBeNull()

      // The heading stays put, above the chart, inside the Analysis section
      // (not the header) — unaffected by the select's relocation.
      const heading = screen.getByText('Accuracy Trend')
      const chart = screen.getByTestId('accuracy-trend-chart')
      expect(heading.compareDocumentPosition(chart) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
      // The heading lives inside the Analysis tabpanel (history-sections),
      // not in the always-visible header row alongside the selects.
      expect(screen.getByTestId('history-sections').contains(heading)).toBe(true)
    })
  })

  describe('period filter', () => {
    const DAY_MS = 24 * 60 * 60 * 1000

    it('renders the period select as the rightmost item in the header, with 5 options in order, defaulting to 1 Month', () => {
      renderWithI18n(<TypingTestHistory results={[makeResult()]} />)
      const select = screen.getByTestId('history-filter-period') as HTMLSelectElement
      expect(Array.from(select.options).map((o) => o.value)).toEqual(['1w', '1m', '3m', '1y', 'all'])
      expect(select.value).toBe('1m')

      // Rightmost: it comes after the source select in document order, in
      // both the Results view (no condition select) and the Analysis view
      // (source, condition, period).
      const sourceSelect = screen.getByTestId('history-filter-source')
      expect(sourceSelect.compareDocumentPosition(select) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()

      fireEvent.click(screen.getByTestId('history-view-tab-analysis'))
      const conditionSelect = screen.getByTestId('history-condition-filter')
      const periodSelectInAnalysis = screen.getByTestId('history-filter-period')
      expect(conditionSelect.compareDocumentPosition(periodSelectInAnalysis) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    })

    it('excludes a result older than the default 1-month window from the table and stats, while a recent one stays', () => {
      const results = [
        makeResult({ wpm: 80, date: new Date(Date.now() - 2 * DAY_MS).toISOString() }), // 2 days ago — inside 1m
        makeResult({ wpm: 55, date: new Date(Date.now() - 40 * DAY_MS).toISOString() }), // 40 days ago — outside 1m
      ]
      renderWithI18n(<TypingTestHistory results={results} />)

      // Default period (1 Month, no interaction needed): only the recent row shows.
      expect(screen.getAllByText('80').length).toBeGreaterThan(0)
      expect(screen.queryByText('55')).toBeNull()
      const stats = screen.getByTestId('history-stats')
      expect(stats.textContent).toContain('Tests:1')
    })

    it('shows every result, regardless of age, once "All Time" is selected', () => {
      const results = [
        makeResult({ wpm: 80, date: new Date(Date.now() - 2 * DAY_MS).toISOString() }),
        makeResult({ wpm: 55, date: new Date(Date.now() - 400 * DAY_MS).toISOString() }), // well past 1y too
      ]
      renderWithI18n(<TypingTestHistory results={results} />)
      expect(screen.queryByText('55')).toBeNull()

      fireEvent.change(screen.getByTestId('history-filter-period'), { target: { value: 'all' } })
      expect(screen.getAllByText('80').length).toBeGreaterThan(0)
      expect(screen.getAllByText('55').length).toBeGreaterThan(0)
      const stats = screen.getByTestId('history-stats')
      expect(stats.textContent).toContain('Tests:2')
    })

    it('excludes a result from the WPM Trend chart once it falls outside the selected period', () => {
      const results = [
        makeResult({ wpm: 80, date: new Date(Date.now() - 1 * DAY_MS).toISOString() }),
        makeResult({ wpm: 82, date: new Date(Date.now() - 2 * DAY_MS).toISOString() }),
        makeResult({ wpm: 55, date: new Date(Date.now() - 40 * DAY_MS).toISOString() }), // outside 1m
      ]
      renderWithI18n(<TypingTestHistory results={results} />)
      // 2 in-window results → the chart renders (needs >= 2 points).
      expect(screen.getByTestId('wpm-trend-chart')).toBeTruthy()

      // Narrow to 1 Week: still 2 in-window results (1 and 2 days ago), so
      // the chart keeps rendering — this only pins that the chart re-derives
      // from the filtered set, not a specific point count.
      fireEvent.change(screen.getByTestId('history-filter-period'), { target: { value: '1w' } })
      expect(screen.getByTestId('wpm-trend-chart')).toBeTruthy()
    })

    it('feeds the Analysis tab from period-filtered results only — a condition outside the window drops out of the condition select', () => {
      const results = [
        makeResult({ wpm: 60, accuracy: 90, mode: 'words', mode2: 30, language: 'english', date: new Date(Date.now() - 1 * DAY_MS).toISOString() }),
        // Only 'quote' result, dated outside the default 1-month window.
        makeResult({ wpm: 50, accuracy: 85, mode: 'quote', mode2: 'short', language: 'english', date: new Date(Date.now() - 40 * DAY_MS).toISOString() }),
      ]
      renderWithI18n(<TypingTestHistory results={results} />)
      fireEvent.click(screen.getByTestId('history-view-tab-analysis'))

      const select = screen.getByTestId('history-condition-filter') as HTMLSelectElement
      const values = Array.from(select.options).map((o) => o.value)
      expect(values.some((v) => v.startsWith('words|'))).toBe(true)
      expect(values.some((v) => v.startsWith('quote|'))).toBe(false)

      // Switching to All Time brings the older condition back into view.
      fireEvent.click(screen.getByTestId('history-view-tab-results'))
      fireEvent.change(screen.getByTestId('history-filter-period'), { target: { value: 'all' } })
      fireEvent.click(screen.getByTestId('history-view-tab-analysis'))
      const valuesAllTime = Array.from((screen.getByTestId('history-condition-filter') as HTMLSelectElement).options).map((o) => o.value)
      expect(valuesAllTime.some((v) => v.startsWith('quote|'))).toBe(true)
    })

    it('exports only the results within the selected period as CSV', () => {
      const onExportCsv = vi.fn()
      const recentDate = new Date(Date.now() - 1 * DAY_MS).toISOString()
      const oldDate = new Date(Date.now() - 40 * DAY_MS).toISOString()
      const results = [
        makeResult({ wpm: 80, date: recentDate }),
        makeResult({ wpm: 55, date: oldDate }),
      ]
      renderWithI18n(<TypingTestHistory results={results} onExportCsv={onExportCsv} />)

      fireEvent.click(screen.getByTestId('history-export-csv'))
      const csv = onExportCsv.mock.calls[0][0] as string
      expect(csv).toContain(recentDate)
      expect(csv).not.toContain(oldDate)

      // Widening to All Time brings the older row into the export too.
      fireEvent.change(screen.getByTestId('history-filter-period'), { target: { value: 'all' } })
      fireEvent.click(screen.getByTestId('history-export-csv'))
      const csvAllTime = onExportCsv.mock.calls[1][0] as string
      expect(csvAllTime).toContain(recentDate)
      expect(csvAllTime).toContain(oldDate)
    })
  })
})
