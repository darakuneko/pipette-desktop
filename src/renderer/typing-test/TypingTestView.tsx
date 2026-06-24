// SPDX-License-Identifier: GPL-2.0-or-later

import { useRef, useEffect, useLayoutEffect, useCallback, useMemo, useState } from 'react'
import type { CSSProperties } from 'react'
import { useTranslation } from 'react-i18next'
import { RotateCcw } from 'lucide-react'
import { ICON_XL } from '../constants/ui-tokens'
import type { TypingTestState } from './useTypingTest'
import type { TypingTestConfig, TypingTestMode, QuoteLength } from './types'
import { WORD_COUNT_OPTIONS, TIME_DURATION_OPTIONS, DEFAULT_DISPLAY_LINES, DEFAULT_FONT_SIZE } from './types'
import { WordDisplay } from './WordDisplay'
import { Tooltip } from '../components/ui/Tooltip'

const GAP_Y_PX = 4 // corresponds to Tailwind gap-y-1 (0.25rem at 16px base)
const MODES: TypingTestMode[] = ['words', 'time', 'quote']
const QUOTE_LENGTHS: QuoteLength[] = ['short', 'medium', 'long', 'all']

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
  onRestart: () => void
  onConfigChange: (config: TypingTestConfig) => void
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
}

function formatTime(seconds: number): string {
  const m = Math.floor(seconds / 60)
  const s = seconds % 60
  return `${m}:${String(s).padStart(2, '0')}`
}

function optionButtonClass(active: boolean, px: 'px-2.5' | 'px-3' = 'px-3'): string {
  const base = `rounded-md border ${px} py-1 text-sm transition-colors`
  return active
    ? `${base} border-accent bg-accent/10 font-semibold text-accent`
    : `${base} border-edge text-content-secondary hover:text-content`
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
  onRestart,
  onConfigChange,
  onCompositionStart,
  onCompositionUpdate,
  onCompositionEnd,
  onImeSpaceKey,
  displayLines = DEFAULT_DISPLAY_LINES,
  fontSize = DEFAULT_FONT_SIZE,
  onNameResult,
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
  // Imported-text window: font size + line count drive the CSS calc in
  // .typing-multiline-window. Memoized so the style object is stable.
  const multilineStyle = useMemo(
    () => (lines ? ({ '--tt-font': fontSize, '--tt-lines': displayLines } as CSSProperties) : undefined),
    [lines, fontSize, displayLines],
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

    // Imported custom text: snap so the previous line sits at the top, so
    // the four visible lines read [previous, current, next, next-next].
    // Aligning to a real line element's top means lines are never clipped.
    if (lines) {
      const currentLine = lineIndexOf(state.currentWordIndex, state.lineBreaks)
      if (currentLine <= 0) {
        container.scrollTop = 0
        return
      }
      const prevRow = container.querySelectorAll<HTMLElement>('[data-line-row]')[currentLine - 1]
      if (!prevRow) return
      container.scrollTop += prevRow.getBoundingClientRect().top - container.getBoundingClientRect().top
      return
    }

    const activeWord = container.querySelector<HTMLElement>(
      `[data-testid="word-${state.currentWordIndex}"]`,
    )
    if (!activeWord) return

    const lineHeight = activeWord.offsetHeight + GAP_Y_PX
    const relativeTop =
      activeWord.getBoundingClientRect().top - container.getBoundingClientRect().top
    const visibleLine = Math.floor(relativeTop / lineHeight)

    if (visibleLine >= 2) {
      container.scrollTop += (visibleLine - 1) * lineHeight
    }
  }, [state.currentWordIndex, state.lineBreaks, lines])

  // Remember toggle state so it persists through quote/custom modes (which have no toggles)
  const togglesRef = useRef({ punctuation: false, numbers: false })
  if (config.mode === 'words' || config.mode === 'time') {
    togglesRef.current = { punctuation: config.punctuation, numbers: config.numbers }
  }

  const handleModeChange = useCallback((mode: TypingTestMode) => {
    const { punctuation, numbers } = togglesRef.current

    switch (mode) {
      case 'words':
        onConfigChange({
          mode: 'words',
          wordCount: config.mode === 'words' ? config.wordCount : 30,
          punctuation,
          numbers,
        })
        break
      case 'time':
        onConfigChange({
          mode: 'time',
          duration: config.mode === 'time' ? config.duration : 30,
          punctuation,
          numbers,
        })
        break
      case 'quote':
        onConfigChange({
          mode: 'quote',
          quoteLength: config.mode === 'quote' ? config.quoteLength : 'medium',
        })
        break
    }
  }, [config, onConfigChange])

  const hasPunctuationNumbers = config.mode === 'words' || config.mode === 'time'

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
    <div data-testid="typing-test-view" className="flex flex-col items-center gap-6 px-6 py-8">
      {/* Settings bar — hidden for imported custom text: its words/time/quote
          tabs don't apply, so dropping it frees space for the reading area. */}
      {config.mode !== 'custom' && (
      <div className="flex flex-wrap items-center justify-center gap-4">
        {/* Mode tabs */}
        <div className="flex items-center gap-1 rounded-lg bg-surface-alt/50 px-1 py-0.5">
          {MODES.map((mode) => (
            <button
              key={mode}
              type="button"
              data-testid={`mode-${mode}`}
              className={optionButtonClass(config.mode === mode)}
              onClick={() => handleModeChange(mode)}
            >
              {t(`editor.typingTest.mode.${mode}`)}
            </button>
          ))}
        </div>

        {/* Separator */}
        <span className="text-content-muted/40">|</span>

        {/* Count/duration/quote-length options */}
        {config.mode === 'words' && (
          <div className="flex items-center gap-1">
            {WORD_COUNT_OPTIONS.map((count) => (
              <button
                key={count}
                type="button"
                data-testid={`word-count-${count}`}
                className={optionButtonClass(config.wordCount === count)}
                onClick={() => onConfigChange({ ...config, wordCount: count })}
              >
                {count}
              </button>
            ))}
          </div>
        )}

        {config.mode === 'time' && (
          <div className="flex items-center gap-1">
            {TIME_DURATION_OPTIONS.map((dur) => (
              <button
                key={dur}
                type="button"
                data-testid={`duration-${dur}`}
                className={optionButtonClass(config.duration === dur)}
                onClick={() => onConfigChange({ ...config, duration: dur })}
              >
                {dur}
              </button>
            ))}
          </div>
        )}

        {config.mode === 'quote' && (
          <div className="flex items-center gap-1">
            {QUOTE_LENGTHS.map((len) => (
              <button
                key={len}
                type="button"
                data-testid={`quote-${len}`}
                className={optionButtonClass(config.quoteLength === len)}
                onClick={() => onConfigChange({ ...config, quoteLength: len })}
              >
                {t(`editor.typingTest.quoteLength.${len}`)}
              </button>
            ))}
          </div>
        )}

        {/* Punctuation/Numbers toggles */}
        {hasPunctuationNumbers && (
          <>
            <span className="text-content-muted/40">|</span>
            <div className="flex items-center gap-1">
              <button
                type="button"
                data-testid="toggle-punctuation"
                className={optionButtonClass(config.punctuation, 'px-2.5')}
                onClick={() => onConfigChange({ ...config, punctuation: !config.punctuation })}
              >
                {t('editor.typingTest.punctuation')}
              </button>
              <button
                type="button"
                data-testid="toggle-numbers"
                className={optionButtonClass(config.numbers, 'px-2.5')}
                onClick={() => onConfigChange({ ...config, numbers: !config.numbers })}
              >
                {t('editor.typingTest.numbers')}
              </button>
            </div>
          </>
        )}
      </div>
      )}

      {/* Stats bar — always rendered to reserve height and prevent layout shift */}
      <div className={`flex items-center gap-8 text-sm ${showStats ? '' : 'invisible'}`}>
        <div className="flex items-center gap-1.5">
          <span className="text-content-muted">{t('editor.typingTest.wpm')}:</span>
          <span data-testid="typing-test-wpm" className="font-mono text-lg font-semibold text-accent">
            {wpm}
          </span>
        </div>
        <div className="flex items-center gap-1.5">
          <span className="text-content-muted">{t('editor.typingTest.kpm')}:</span>
          <span data-testid="typing-test-kpm" className="font-mono text-lg font-semibold text-accent">
            {kpm}
          </span>
        </div>
        <div className="flex items-center gap-1.5">
          <span className="text-content-muted">{t('editor.typingTest.accuracy')}:</span>
          <span data-testid="typing-test-accuracy" className="font-mono text-lg font-semibold">
            {accuracy}%
          </span>
        </div>
        <div className="flex items-center gap-1.5">
          <span className="text-content-muted">{t('editor.typingTest.time')}:</span>
          <span data-testid="typing-test-time" className="font-mono text-lg font-semibold">
            {displayTime}
          </span>
        </div>
        <div className="flex items-center gap-1.5">
          {/* Imported custom text tracks character progress (spaces included);
              everything else tracks words. */}
          <span className="text-content-muted">{t(isCustom ? 'editor.typingTest.chars' : 'editor.typingTest.words')}:</span>
          <span data-testid="typing-test-word-count" className="font-mono text-lg font-semibold">
            {isCustom
              ? t('editor.typingTest.wordCount', { current: typedChars, total: totalChars })
              : t('editor.typingTest.wordCount', {
                  current: state.currentWordIndex,
                  total: state.words.length,
                })}
          </span>
        </div>
      </div>

      {/* Word display — fixed window with scroll. Word-flow modes show a
          3-line window; imported custom text shows 4 lines (line-row layout). */}
      <div
        data-testid="typing-test-words"
        className={`relative w-full max-w-4xl font-mono leading-normal ${lines ? 'typing-multiline-window' : 'text-2xl h-typing-display'}`}
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
              <div className="flex flex-wrap gap-x-3 gap-y-1">
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

      {/* Restart button */}
      <div className="-my-2">
        <Tooltip content={t('editor.typingTest.restart')}>
          <button
            type="button"
            data-testid={state.status === 'finished' ? 'typing-test-restart' : 'typing-test-restart-running'}
            className="rounded-md border border-edge p-1.5 text-content-secondary transition-colors hover:text-content"
            onClick={onRestart}
            aria-label={t('editor.typingTest.restart')}
          >
            <RotateCcw size={ICON_XL} aria-hidden="true" />
          </button>
        </Tooltip>
      </div>

      {/* Finished results */}
      {state.status === 'finished' && (
        <div data-testid="typing-test-results" className="flex flex-col items-center gap-2 border-t border-edge pt-4 text-lg">
          {/* Imported custom text: name the result on its own centered row. */}
          {config.mode === 'custom' && (
            <ResultNameField key={state.startTime ?? 'none'} onName={onNameResult} />
          )}
          <div className="flex flex-wrap items-center justify-center gap-6">
            <span className="font-semibold">{t('editor.typingTest.finished')}</span>
            <span className="text-content-muted">
              {t('editor.typingTest.wpm')}: <span className="font-semibold text-accent">{wpm}</span>
            </span>
            <span className="text-content-muted">
              {t('editor.typingTest.kpm')}: <span className="font-semibold text-accent">{kpm}</span>
            </span>
            <span className="text-content-muted">
              {t('editor.typingTest.accuracy')}: <span className="font-semibold">{accuracy}%</span>
            </span>
            {config.mode === 'quote' && state.currentQuote && (
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

/** Inline-editable name for the just-finished result, shown on the completion
 *  screen for imported custom text. Empty renders the "Unnamed" placeholder;
 *  a dotted underline hints the text is editable. Commit on Enter / blur,
 *  cancel on Escape. Mounted with a per-test `key`, so the draft always
 *  starts empty for a fresh result. */
function ResultNameField({ onName }: { onName?: (name: string) => void }) {
  const { t } = useTranslation()
  const [editing, setEditing] = useState(false)
  const [value, setValue] = useState('')
  // Snapshot of the value when editing began, restored on Escape.
  const editStartValueRef = useRef('')

  const commit = (): void => {
    setEditing(false)
    onName?.(value)
  }

  if (editing) {
    return (
      <input
        autoFocus
        data-tt-passthrough=""
        value={value}
        aria-label={t('editor.typingTest.nameResult')}
        onChange={(e) => setValue(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') commit()
          else if (e.key === 'Escape') { setValue(editStartValueRef.current); setEditing(false) }
        }}
        className="rounded border border-edge bg-surface px-1.5 py-0.5 text-base text-content focus:border-accent focus:outline-none"
        data-testid="typing-test-result-name-input"
      />
    )
  }

  return (
    <button
      type="button"
      onClick={() => { editStartValueRef.current = value; setEditing(true) }}
      title={t('editor.typingTest.nameResult')}
      aria-label={t('editor.typingTest.nameResult')}
      className={`cursor-text italic underline decoration-dotted underline-offset-4 transition-colors hover:text-content ${value ? 'text-content-secondary' : 'text-content-muted'}`}
      data-testid="typing-test-result-name"
    >
      {value || t('editor.typingTest.history.unnamed')}
    </button>
  )
}

