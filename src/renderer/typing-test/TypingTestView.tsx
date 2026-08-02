// SPDX-License-Identifier: GPL-2.0-or-later

import { useRef, useEffect, useLayoutEffect, useCallback, useMemo, useState } from 'react'
import type { CSSProperties } from 'react'
import { useTranslation } from 'react-i18next'
import type { TypingTestState } from './useTypingTest'
import type { RomajiGuide, TypingTestConfig } from './types'
import type { ComparisonStats } from './comparison'
import { DEFAULT_DISPLAY_LINES, DEFAULT_FONT_SIZE } from './types'
import { WordDisplay } from './WordDisplay'
import { TypingTestControlsRow } from './TypingTestControlsRow'
import { TypingTestStatsRow } from './TypingTestStatsRow'


interface Props {
  state: TypingTestState
  wpm: number
  /** Keystrokes per minute — shown instead of WPM in fileImport mode. */
  kpm?: number
  accuracy: number
  /** Keystrokes per confirmed character (see `useTypingTest`'s `kspc`).
   *  `null`/`undefined` shows '-', same as before measuring starts. */
  kspc?: number | null
  elapsedSeconds: number
  remainingSeconds: number | null
  config: TypingTestConfig
  paused: boolean
  /** Hide the stats / results (WPM) row. Persisted per keyboard. */
  hideStatsRow?: boolean
  /** Hide the operation (Next Test button) controls row. Persisted per
   *  keyboard. Force-shown once a test finishes. */
  hideControls?: boolean
  /** Baseline metrics for the Measurement-row comparison delta, or null when
   *  comparison is off / no matching history. */
  comparison?: ComparisonStats | null
  onCompositionStart?: () => void
  onCompositionUpdate?: (data: string) => void
  onCompositionEnd?: (data: string) => void
  /** Current word's romaji-keystroke progress (romajiInput mode only), or
   *  null otherwise. Drives both the current word's kana coloring
   *  (forwarded to `WordDisplay`) and the typed/remaining romaji guide line
   *  shown below the reading window. */
  romajiGuide?: RomajiGuide | null
  /** Called when Space is input via IME (keydown swallowed by the IME layer). */
  onImeSpaceKey?: () => void
  /** Imported-text display: visible line count + font size (px). Ignored
   *  outside fileImport mode. */
  displayLines?: number
  fontSize?: number
  /** Name the just-finished result inline from the completion screen
   *  (imported fileImport text only). Keyed to the most recent saved result. */
  onNameResult?: (name: string) => void
  /** Quick-insert chips for the result-name modal (material label, timestamp,
   *  WPM / KPM / Accuracy of the just-finished result). */
  resultNameChips?: string[]
  /** Start a fresh run (Next Test / Restart — both restart the test). */
  onStart?: () => void
  /** Memory mode (imported fileImport text): pause the running run. */
  onPause?: () => void
  /** Memory mode: open the resume dialog for a paused / saved run. */
  onResume?: () => void
  /** A paused fileImport run is saved and can be resumed. */
  hasSavedMemory?: boolean
  /** Error-class raw counts (see `TypingTestResult.errorSubstitutions` et
   *  al.) from the just-finished result, or `null` when the result has
   *  none (romaji run, no finalized words, or a legacy pre-error-class
   *  result) — the completion screen's error-mix line is omitted
   *  entirely rather than showing a '-' placeholder, since (unlike WPM /
   *  KSPC) "the metric doesn't apply to this run" is common, not an
   *  in-progress state. */
  errorClasses?: { substitutions: number; omissions: number; insertions: number } | null
}

/** Group flat word indices into logical lines using the line-break set
 *  (imported fileImport text). Each entry is the global word indices of one
 *  line, in order. */
function groupIntoLines(words: string[], lineBreaks: Set<number>): number[][] {
  const lines: number[][] = []
  let current: number[] = []
  for (let i = 0; i < words.length; i++) {
    current.push(i)
    if (lineBreaks.has(i)) {
      lines.push(current)
      current = []
    }
  }
  if (current.length > 0) lines.push(current)
  return lines
}

/** Which logical line the word index sits on (= breaks before it). */
function lineIndexOf(wordIndex: number, lineBreaks: Set<number>): number {
  let line = 0
  for (const b of lineBreaks) {
    if (b < wordIndex) line++
  }
  return line
}

export function TypingTestView({
  state,
  wpm,
  kpm = 0,
  accuracy,
  kspc = null,
  elapsedSeconds,
  remainingSeconds,
  config,
  paused,
  hideStatsRow,
  hideControls,
  comparison,
  onCompositionStart,
  onCompositionUpdate,
  onCompositionEnd,
  romajiGuide = null,
  onImeSpaceKey,
  displayLines = DEFAULT_DISPLAY_LINES,
  fontSize = DEFAULT_FONT_SIZE,
  onNameResult,
  resultNameChips = [],
  onStart,
  onPause,
  onResume,
  hasSavedMemory,
  errorClasses = null,
}: Props) {
  const { t } = useTranslation()
  const wordsRef = useRef<HTMLDivElement>(null)
  const imeInputRef = useRef<HTMLTextAreaElement>(null)
  const isComposingRef = useRef(false)
  // Guard: prevent duplicate space submission when both keydown and input fire
  const lastSpaceTimeRef = useRef(0)
  // Romaji mode is direct-keystroke only, so an active OS IME composition
  // means input silently isn't landing — surfaced as a one-line hint once
  // detected. Sticky for the run (not per-keystroke) so it doesn't flicker;
  // cleared on the next run via the runId-keyed effect below.
  const [imeDetected, setImeDetected] = useState(false)
  useEffect(() => {
    setImeDetected(false)
  }, [state.runId])

  // Sources with line breaks render as explicit line rows; every other mode
  // keeps the flat word-flow layout. `null` = flat.
  const lines = useMemo(
    () => (state.lineBreaks.size > 0 ? groupIntoLines(state.words, state.lineBreaks) : null),
    [state.words, state.lineBreaks],
  )
  // Reading window: font size + line count drive the CSS calc in
  // .typing-multiline-window. Applied to every mode (normal word-flow and
  // imported fileImport text share the same Font/Line settings). Memoized so the
  // style object is stable.
  const multilineStyle = useMemo(
    () => ({ '--tt-font': fontSize, '--tt-lines': displayLines } as CSSProperties),
    [fontSize, displayLines],
  )
  function clearImeInput(): void {
    if (imeInputRef.current) imeInputRef.current.value = ''
  }

  // Focus the hidden IME textarea when waiting or running, and restore on window refocus
  const focusImeInput = useCallback(() => {
    if (state.status === 'waiting' || state.status === 'running') {
      imeInputRef.current?.focus()
    }
  }, [state.status])

  useEffect(() => {
    focusImeInput()
    window.addEventListener('focus', focusImeInput)
    document.addEventListener('visibilitychange', focusImeInput)
    return () => {
      window.removeEventListener('focus', focusImeInput)
      document.removeEventListener('visibilitychange', focusImeInput)
    }
  }, [focusImeInput])

  useLayoutEffect(() => {
    if (wordsRef.current) {
      wordsRef.current.scrollTop = 0
    }
  }, [state.words])

  useLayoutEffect(() => {
    const container = wordsRef.current
    if (!container) return

    // Imported fileImport text: align to real line-row elements (never clipped).
    // Prefer the previous line at the top for context — but if a wrapped line
    // (one logical line spanning several visual rows) would push the current
    // line out of view, snap the current line to the top so what's being typed
    // is always visible (e.g. Lines=2 with wrapping).
    if (lines) {
      const currentLine = lineIndexOf(state.currentWordIndex, state.lineBreaks)
      const rows = container.querySelectorAll<HTMLElement>('[data-line-row]')
      const currentRow = rows[currentLine]
      if (!currentRow) {
        container.scrollTop = 0
        return
      }
      const containerRect = container.getBoundingClientRect()
      const prevRow = currentLine > 0 ? rows[currentLine - 1] : null
      container.scrollTop += (prevRow ?? currentRow).getBoundingClientRect().top - containerRect.top
      if (currentRow.getBoundingClientRect().bottom > containerRect.bottom) {
        container.scrollTop += currentRow.getBoundingClientRect().top - containerRect.top
      }
      return
    }

    const activeWord = container.querySelector<HTMLElement>(
      `[data-testid="word-${state.currentWordIndex}"]`,
    )
    if (!activeWord) return

    // Lines are spaced by line-height only (no extra row gap), so the window
    // height (font × 1.5 × lines) matches the content exactly — one word's
    // box height is one visible line.
    const lineHeight = activeWord.offsetHeight
    const relativeTop =
      activeWord.getBoundingClientRect().top - container.getBoundingClientRect().top
    const visibleLine = Math.floor(relativeTop / lineHeight)

    if (visibleLine >= 2) {
      container.scrollTop += (visibleLine - 1) * lineHeight
    }
    // Font/line changes resize the window, so re-snap the scroll position.
  }, [state.currentWordIndex, state.lineBreaks, lines, fontSize, displayLines])

  // Shared by the line-row and flat layouts so the word props stay in one place.
  const renderWord = (wordIdx: number) => (
    <WordDisplay
      key={wordIdx}
      word={state.words[wordIdx]}
      wordIndex={wordIdx}
      currentWordIndex={state.currentWordIndex}
      currentInput={state.currentInput}
      wordResults={state.wordResults}
      cursorBlink={state.status === 'waiting'}
      compositionText={wordIdx === state.currentWordIndex ? state.compositionText : ''}
      romajiGuide={wordIdx === state.currentWordIndex ? romajiGuide : null}
    />
  )

  return (
    <div data-testid="typing-test-view" className="flex w-full min-w-0 flex-col items-center gap-4 px-4 py-4">
      {/* Word display — fixed window with scroll. Word-flow modes show a
          3-line window; imported fileImport text shows 4 lines (line-row layout). */}
      <div
        data-testid="typing-test-words"
        className="relative w-full max-w-4xl font-mono leading-normal typing-multiline-window"
        style={multilineStyle}
        onClick={() => imeInputRef.current?.focus()}
      >
        {/* Hidden textarea for IME composition input */}
        <textarea
          ref={imeInputRef}
          className="absolute opacity-0 w-px h-px overflow-hidden"
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="off"
          spellCheck={false}
          tabIndex={-1}
          aria-label="IME input"
          onCompositionStart={() => {
            isComposingRef.current = true
            // An IME composition starting during romaji mode means the OS
            // IME is on — direct keystrokes won't reach processKeyEvent
            // (see isRomajiInputActive's composition-blocking in
            // useTypingTest). Surface the hint once detected.
            if (romajiGuide) setImeDetected(true)
            onCompositionStart?.()
          }}
          onCompositionUpdate={(e) => onCompositionUpdate?.(e.data)}
          onCompositionEnd={(e) => {
            isComposingRef.current = false
            onCompositionEnd?.(e.data)
            clearImeInput()
          }}
          onInput={() => {
            // Only clear when not composing — clearing during IME resets the composition
            if (!isComposingRef.current) {
              // Japanese IME swallows Space keydown entirely; detect it here via textarea input.
              // Guard: if the capture-phase keydown already handled Space (via preventDefault),
              // no input event fires. But some IMEs may fire both — skip if too recent.
              const val = imeInputRef.current?.value ?? ''
              if (val === ' ' || val === '\u3000') {
                const now = Date.now()
                if (now - lastSpaceTimeRef.current > 50) {
                  lastSpaceTimeRef.current = now
                  onImeSpaceKey?.()
                }
              }
              clearImeInput()
            }
          }}
        />
        {state.status === 'countdown' && (
          <div className="flex h-full items-center justify-center">
            <p data-testid="typing-test-countdown" className="animate-pulse text-content-muted">
              {t('editor.typingTest.loading')}
            </p>
          </div>
        )}
        {state.status !== 'countdown' && state.words.length > 0 && (
          <div ref={wordsRef} className="h-full overflow-hidden">
            {lines ? (
              // Imported fileImport text: one row per logical line, ⏎ marks the
              // line ends where Enter (not Space) advances.
              lines.map((lineWordIdxs, lineIdx) => (
                <div key={lineIdx} data-line-row={lineIdx} className="flex flex-wrap gap-x-3">
                  {state.lineIndents[lineIdx] && (
                    // Code indentation, display only — not typed (Space submits
                    // a word, so leading spaces can't be keyed).
                    <span data-testid={`line-indent-${lineIdx}`} className="-mr-3 select-none whitespace-pre text-content-muted/40" aria-hidden="true">{state.lineIndents[lineIdx]}</span>
                  )}
                  {lineWordIdxs.map(renderWord)}
                  {lineIdx < lines.length - 1 && (
                    <span className="select-none text-content-muted/40" aria-hidden="true">⏎</span>
                  )}
                </div>
              ))
            ) : (
              <div className="flex flex-wrap gap-x-3">
                {state.words.map((_, wordIdx) => renderWord(wordIdx))}
              </div>
            )}
          </div>
        )}
        {paused && state.status === 'running' && (
          <div
            data-testid="typing-test-paused"
            className="absolute inset-0 flex items-center justify-center rounded-lg bg-surface/80"
          >
            <p className="text-base text-content-muted">{t('editor.typingTest.paused')}</p>
          </div>
        )}
      </div>

      {/* Romaji guide — the current word's confirmed/remaining romaji
          spelling, a fainter look-ahead preview of the upcoming words' full
          spelling, plus an IME-on hint once a composition event proves
          direct keystrokes aren't reaching the matcher. Rendered as its own
          row below the reading window rather than inline per-word: the
          words row is a single flex-wrap flow (word-flow modes have no
          per-line rows to anchor an inline guide under), so a fixed row
          here avoids overlapping whatever wraps below the current word.
          The spelling row is gated on `showRow` (guideWordCount === 0 hides
          it), but the IME hint always shows once detected — it's a warning
          about input not landing, which stays relevant even with the guide
          row hidden. The typed/remaining/lookahead line tracks the Font
          setting via the same --tt-font var as the reading window; the IME
          hint stays a fixed small size since it's a hint, not reading
          content. */}
      {romajiGuide && (romajiGuide.showRow || imeDetected) && (
        <div data-testid="typing-test-romaji-guide" className="flex w-full max-w-4xl flex-col items-start gap-1 font-mono" style={multilineStyle}>
          {romajiGuide.showRow && (
            <p className="typing-romaji-guide-text break-all">
              <span className="text-success">{romajiGuide.typed}</span>
              <span className="text-content-muted">{romajiGuide.remaining}</span>
              {romajiGuide.lookahead.map((word, i) => (
                <span key={i} data-testid="typing-test-romaji-lookahead" className="text-content-muted/40">{' ' + word}</span>
              ))}
            </p>
          )}
          {imeDetected && (
            <p data-testid="typing-test-romaji-ime-hint" className="text-xs text-warning">
              {t('editor.typingTest.romaji.imeHint')}
            </p>
          )}
        </div>
      )}

      {/* State-based controls row, below the reading window:
          - not started (waiting / countdown): Next Test (+ Resume if a run is
            saved for imported fileImport text)
          - in progress (running / paused): Pause or Resume (fileImport) + Restart
          - finished: result name (fileImport) + Next Test
          Next Test and Restart share the same action; only the label differs.
          The "operation" toggle hides this controls row (and the Complete
          message above it), but a finished test always shows it so the
          result can be named and the next test started. */}
      {(!hideControls || state.status === 'finished') && (
        <TypingTestControlsRow
          state={state}
          config={config}
          onNameResult={onNameResult}
          resultNameChips={resultNameChips}
          onStart={onStart}
          onPause={onPause}
          onResume={onResume}
          hasSavedMemory={hasSavedMemory}
        />
      )}

      {/* Measurement / results row — below the reading window and the
          Unnamed / Next Test row. Live metrics during a run; before measuring
          (waiting / countdown) every value reads "-". The "measurement" toggle
          hides the LIVE metrics during a run — once finished, the results
          always show. */}
      {(!hideStatsRow || state.status === 'finished') && (
        <TypingTestStatsRow
          state={state}
          wpm={wpm}
          kpm={kpm}
          accuracy={accuracy}
          kspc={kspc}
          elapsedSeconds={elapsedSeconds}
          remainingSeconds={remainingSeconds}
          config={config}
          comparison={comparison}
          errorClasses={errorClasses}
        />
      )}

    </div>
  )
}

