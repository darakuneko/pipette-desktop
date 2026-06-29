// SPDX-License-Identifier: GPL-2.0-or-later

import { useRef, useEffect, useLayoutEffect, useCallback, useMemo, useState } from 'react'
import type { CSSProperties } from 'react'
import { useTranslation } from 'react-i18next'
import { SquarePen, Pause, Play, CircleCheck } from 'lucide-react'
import { ICON_SM, ICON_LG } from '../constants/ui-tokens'
import type { TypingTestState } from './useTypingTest'
import type { TypingTestConfig } from './types'
import { DEFAULT_DISPLAY_LINES, DEFAULT_FONT_SIZE } from './types'
import { WordDisplay } from './WordDisplay'
import { ResultNameModal } from './ResultNameModal'


interface Props {
  state: TypingTestState
  wpm: number
  /** Keystrokes per minute — shown instead of WPM in custom mode. */
  kpm?: number
  accuracy: number
  elapsedSeconds: number
  remainingSeconds: number | null
  config: TypingTestConfig
  paused: boolean
  /** Max width for the reading window + stats row, matched to the keyboard
   *  below so the typing text lines up with the keymap (px). */
  readingMaxWidth?: number
  /** Hide the stats / results (WPM) row. Persisted per keyboard. */
  hideStatsRow?: boolean
  onCompositionStart?: () => void
  onCompositionUpdate?: (data: string) => void
  onCompositionEnd?: (data: string) => void
  /** Called when Space is input via IME (keydown swallowed by the IME layer). */
  onImeSpaceKey?: () => void
  /** Imported-text display: visible line count + font size (px). Ignored
   *  outside custom mode. */
  displayLines?: number
  fontSize?: number
  /** Name the just-finished result inline from the completion screen
   *  (imported custom text only). Keyed to the most recent saved result. */
  onNameResult?: (name: string) => void
  /** Quick-insert chips for the result-name modal (material label, timestamp,
   *  WPM / KPM / Accuracy of the just-finished result). */
  resultNameChips?: string[]
  /** Start a fresh run (Next Test / Restart — both restart the test). */
  onStart?: () => void
  /** Memory mode (imported custom text): pause the running run. */
  onPause?: () => void
  /** Memory mode: open the resume dialog for a paused / saved run. */
  onResume?: () => void
  /** A paused custom run is saved and can be resumed. */
  hasSavedMemory?: boolean
}

function formatTime(seconds: number): string {
  const m = Math.floor(seconds / 60)
  const s = seconds % 60
  return `${m}:${String(s).padStart(2, '0')}`
}

/** Group flat word indices into logical lines using the line-break set
 *  (imported custom text). Each entry is the global word indices of one
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
  elapsedSeconds,
  remainingSeconds,
  config,
  paused,
  readingMaxWidth,
  hideStatsRow,
  onCompositionStart,
  onCompositionUpdate,
  onCompositionEnd,
  onImeSpaceKey,
  displayLines = DEFAULT_DISPLAY_LINES,
  fontSize = DEFAULT_FONT_SIZE,
  onNameResult,
  resultNameChips = [],
  onStart,
  onPause,
  onResume,
  hasSavedMemory,
}: Props) {
  const { t } = useTranslation()
  const showStats = state.status === 'running' || state.status === 'finished' || state.status === 'paused'
  const wordsRef = useRef<HTMLDivElement>(null)
  const imeInputRef = useRef<HTMLTextAreaElement>(null)
  const isComposingRef = useRef(false)
  // Guard: prevent duplicate space submission when both keydown and input fire
  const lastSpaceTimeRef = useRef(0)

  // Imported custom text (line breaks present) renders as explicit line
  // rows; every other mode keeps the flat word-flow layout. `null` = flat.
  const lines = useMemo(
    () => (state.lineBreaks.size > 0 ? groupIntoLines(state.words, state.lineBreaks) : null),
    [state.words, state.lineBreaks],
  )
  // Reading window: font size + line count drive the CSS calc in
  // .typing-multiline-window. Applied to every mode (normal word-flow and
  // imported custom text share the same Font/Line settings). Memoized so the
  // style object is stable.
  const multilineStyle = useMemo(
    () => ({ '--tt-font': fontSize, '--tt-lines': displayLines } as CSSProperties),
    [fontSize, displayLines],
  )

  // Imported custom text counts progress by character (spaces included): each
  // word-gap is one separator char, so total = Σ word lengths + (words - 1).
  // Gated on the mode (not `lines`) so single-line imports count chars too.
  const isCustom = config.mode === 'custom'
  const totalChars = useMemo(
    () => (isCustom ? state.words.reduce((sum, w) => sum + w.length, 0) + Math.max(0, state.words.length - 1) : 0),
    [isCustom, state.words],
  )
  const typedChars = useMemo(() => {
    if (!isCustom) return 0
    let sum = state.currentInput.length
    for (let i = 0; i < state.currentWordIndex && i < state.words.length; i++) sum += state.words[i].length
    sum += Math.min(state.currentWordIndex, Math.max(0, state.words.length - 1)) // separators passed
    return Math.min(sum, totalChars)
  }, [isCustom, state.words, state.currentWordIndex, state.currentInput, totalChars])

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

    // Imported custom text: align to real line-row elements (never clipped).
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

  const displayTime = config.mode === 'time' && remainingSeconds !== null
    ? formatTime(remainingSeconds)
    : formatTime(elapsedSeconds)

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
    />
  )

  return (
    <div data-testid="typing-test-view" className="flex flex-col items-center gap-4 px-4 py-4">
      {/* Word display — fixed window with scroll. Word-flow modes show a
          3-line window; imported custom text shows 4 lines (line-row layout). */}
      <div
        data-testid="typing-test-words"
        className="relative w-full max-w-4xl font-mono leading-normal typing-multiline-window"
        style={{ ...multilineStyle, maxWidth: readingMaxWidth }}
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
              // Imported custom text: one row per logical line, ⏎ marks the
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

      {/* State-based controls row, below the reading window:
          - not started (waiting / countdown): Next Test (+ Resume if a run is
            saved for imported custom text)
          - in progress (running / paused): Pause or Resume (custom) + Restart
          - finished: result name (custom) + Next Test
          Next Test and Restart share the same action; only the label differs. */}
      {state.status === 'finished' && (
        <p data-testid="typing-test-complete" className="flex items-center gap-1.5 text-lg font-semibold text-accent">
          <CircleCheck size={ICON_LG} aria-hidden="true" />
          {t('editor.typingTest.complete')}
        </p>
      )}
      <div className="flex items-center gap-2">
        {config.mode === 'custom' && (
          state.status === 'running' ? (
            <button
              type="button"
              data-testid="typing-memory-pause"
              className="flex h-8 items-center gap-1.5 rounded-md border border-edge px-2.5 text-sm text-content-secondary transition-colors hover:text-content"
              onClick={onPause}
            >
              <Pause size={ICON_SM} aria-hidden="true" />
              <span>{t('editor.typingTest.memory.pause')}</span>
            </button>
          ) : (state.status === 'paused' || ((state.status === 'waiting' || state.status === 'countdown') && hasSavedMemory)) ? (
            <button
              type="button"
              data-testid="typing-memory-resume"
              className="flex h-8 items-center gap-1.5 rounded-md border border-edge px-2.5 text-sm text-accent transition-colors hover:text-accent/80"
              onClick={onResume}
            >
              <Play size={ICON_SM} aria-hidden="true" />
              <span>{t('editor.typingTest.memory.resumeButton')}</span>
            </button>
          ) : null
        )}
        {state.status === 'finished' && config.mode === 'custom' && (
          <ResultNameField key={state.startTime ?? 'none'} onName={onNameResult} chips={resultNameChips} />
        )}
        <button
          type="button"
          data-testid={state.status === 'running' || state.status === 'paused' ? 'typing-test-restart' : 'typing-test-start'}
          className="flex h-8 items-center rounded-md border border-edge px-2.5 text-sm text-content-secondary transition-colors hover:text-content"
          onClick={onStart}
        >
          {t(state.status === 'running' || state.status === 'paused' ? 'editor.typingTest.restart' : 'editor.typingTest.nextTest')}
        </button>
      </div>

      {/* Measurement / results row — below the reading window and the
          Unnamed / Next Test row. Live metrics during a run; before measuring
          (waiting / countdown) every value reads "-". The "measurement" toggle
          hides the LIVE metrics during a run — once finished, the results
          always show. */}
      {(!hideStatsRow || state.status === 'finished') && (
      <div
        data-testid="typing-test-results"
        className="flex w-full max-w-4xl flex-col items-center gap-2"
        style={{ maxWidth: readingMaxWidth }}
      >
        <div className="flex flex-wrap items-center justify-center gap-8 text-sm">
          <div className="flex items-center gap-1.5">
            <span className="text-content-muted">{t('editor.typingTest.wpm')}:</span>
            <span data-testid="typing-test-wpm" className="font-mono text-lg font-semibold text-accent">
              {showStats ? wpm : '-'}
            </span>
          </div>
          <div className="flex items-center gap-1.5">
            <span className="text-content-muted">{t('editor.typingTest.kpm')}:</span>
            <span data-testid="typing-test-kpm" className="font-mono text-lg font-semibold text-accent">
              {showStats ? kpm : '-'}
            </span>
          </div>
          <div className="flex items-center gap-1.5">
            <span className="text-content-muted">{t('editor.typingTest.accuracy')}:</span>
            <span data-testid="typing-test-accuracy" className="font-mono text-lg font-semibold">
              {showStats ? `${accuracy}%` : '-'}
            </span>
          </div>
          <div className="flex items-center gap-1.5">
            <span className="text-content-muted">{t('editor.typingTest.time')}:</span>
            <span data-testid="typing-test-time" className="font-mono text-lg font-semibold">
              {showStats ? displayTime : '-'}
            </span>
          </div>
          <div className="flex items-center gap-1.5">
            {/* Imported custom text tracks character progress (spaces included);
                everything else tracks words. */}
            <span className="text-content-muted">{t(isCustom ? 'editor.typingTest.chars' : 'editor.typingTest.words')}:</span>
            <span data-testid="typing-test-word-count" className="font-mono text-lg font-semibold">
              {!showStats
                ? '-'
                : isCustom
                ? t('editor.typingTest.wordCount', { current: typedChars, total: totalChars })
                : t('editor.typingTest.wordCount', {
                    current: state.currentWordIndex,
                    total: state.words.length,
                  })}
            </span>
          </div>
          {state.status === 'finished' && config.mode === 'quote' && state.currentQuote && (
            <span data-testid="typing-test-quote-source" className="text-content-muted italic">
              {t('editor.typingTest.quoteSource', { source: state.currentQuote.source })}
            </span>
          )}
        </div>
      </div>
      )}

    </div>
  )
}

/** Name for the just-finished result (imported custom text). A button showing
 *  the current name (or the "Unnamed" placeholder) with an edit icon; clicking
 *  opens the naming modal with quick-insert chips. Mounted with a per-test
 *  `key`, so the draft starts empty for a fresh result. */
function ResultNameField({ onName, chips }: { onName?: (name: string) => void; chips: string[] }) {
  const { t } = useTranslation()
  const [name, setName] = useState('')
  const [modalOpen, setModalOpen] = useState(false)

  const commit = (newName: string): void => {
    setName(newName)
    onName?.(newName)
  }

  return (
    <>
      <button
        type="button"
        onClick={() => setModalOpen(true)}
        title={t('editor.typingTest.nameResult')}
        aria-label={t('editor.typingTest.nameResult')}
        className={`flex h-8 items-center gap-1.5 rounded-md border border-edge px-2.5 text-sm transition-colors hover:text-content ${name ? 'text-content-secondary' : 'text-content-muted'}`}
        data-testid="typing-test-result-name"
      >
        <SquarePen size={ICON_SM} aria-hidden="true" />
        <span>{name || t('editor.typingTest.history.unnamed')}</span>
      </button>
      {modalOpen && (
        <ResultNameModal
          initialName={name}
          chips={chips}
          onSave={commit}
          onClose={() => setModalOpen(false)}
        />
      )}
    </>
  )
}

