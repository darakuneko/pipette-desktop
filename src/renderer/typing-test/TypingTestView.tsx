// SPDX-License-Identifier: GPL-2.0-or-later

import { useRef, useEffect, useLayoutEffect, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { RotateCcw } from 'lucide-react'
import type { TypingTestState, WordResult } from './useTypingTest'
import type { TypingTestConfig, TypingTestMode, QuoteLength } from './types'
import { WORD_COUNT_OPTIONS, TIME_DURATION_OPTIONS } from './types'

const GAP_Y_PX = 4 // corresponds to Tailwind gap-y-1 (0.25rem at 16px base)
const COMPOSITION_CHAR_CLASS = 'text-accent/60 underline decoration-accent/30'
const MODES: TypingTestMode[] = ['words', 'time', 'quote']
const QUOTE_LENGTHS: QuoteLength[] = ['short', 'medium', 'long', 'all']

interface Props {
  state: TypingTestState
  wpm: number
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

export function TypingTestView({
  state,
  wpm,
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
}: Props) {
  const { t } = useTranslation()
  const showStats = state.status === 'running' || state.status === 'finished'
  const wordsRef = useRef<HTMLDivElement>(null)
  const imeInputRef = useRef<HTMLTextAreaElement>(null)
  const isComposingRef = useRef(false)
  // Guard: prevent duplicate space submission when both keydown and input fire
  const lastSpaceTimeRef = useRef(0)

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
  }, [state.currentWordIndex])

  // Remember toggle state so it persists through quote mode (which has no toggles)
  const togglesRef = useRef({ punctuation: false, numbers: false })
  if (config.mode !== 'quote') {
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

  return (
    <div data-testid="typing-test-view" className="flex flex-col items-center gap-6 px-6 py-8">
      {/* Settings bar */}
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

      {/* Stats bar — always rendered to reserve height and prevent layout shift */}
      <div className={`flex items-center gap-8 text-sm ${showStats ? '' : 'invisible'}`}>
        <div className="flex items-center gap-1.5">
          <span className="text-content-muted">{t('editor.typingTest.wpm')}:</span>
          <span data-testid="typing-test-wpm" className="font-mono text-lg font-semibold text-accent">
            {wpm}
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
          <span className="text-content-muted">{t('editor.typingTest.words')}:</span>
          <span data-testid="typing-test-word-count" className="font-mono text-lg font-semibold">
            {t('editor.typingTest.wordCount', {
              current: state.currentWordIndex,
              total: state.words.length,
            })}
          </span>
        </div>
      </div>

      {/* Word display — fixed 3-line window with scroll */}
      <div
        data-testid="typing-test-words"
        className="relative h-[7.25rem] w-full max-w-4xl font-mono text-2xl leading-normal"
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
            <div className="flex flex-wrap gap-x-3 gap-y-1">
              {state.words.map((word, wordIdx) => (
                <WordDisplay
                  key={wordIdx}
                  word={word}
                  wordIndex={wordIdx}
                  currentWordIndex={state.currentWordIndex}
                  currentInput={state.currentInput}
                  wordResults={state.wordResults}
                  cursorBlink={state.status === 'waiting'}
                  compositionText={wordIdx === state.currentWordIndex ? state.compositionText : ''}
                />
              ))}
            </div>
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
        <button
          type="button"
          data-testid={state.status === 'finished' ? 'typing-test-restart' : 'typing-test-restart-running'}
          className="rounded-md border border-edge p-1.5 text-content-secondary transition-colors hover:text-content"
          onClick={onRestart}
          aria-label={t('editor.typingTest.restart')}
          title={t('editor.typingTest.restart')}
        >
          <RotateCcw size={18} aria-hidden="true" />
        </button>
      </div>

      {/* Finished results */}
      {state.status === 'finished' && (
        <div data-testid="typing-test-results" className="flex flex-wrap items-center gap-6 border-t border-edge pt-4 text-lg">
          <span className="font-semibold">{t('editor.typingTest.finished')}</span>
          <span className="text-content-muted">
            {t('editor.typingTest.wpm')}: <span className="font-semibold text-accent">{wpm}</span>
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
      )}

    </div>
  )
}

interface WordDisplayProps {
  word: string
  wordIndex: number
  currentWordIndex: number
  currentInput: string
  wordResults: WordResult[]
  cursorBlink: boolean
  compositionText?: string
}

function WordDisplay({ word, wordIndex, currentWordIndex, currentInput, wordResults, cursorBlink, compositionText = '' }: WordDisplayProps) {
  const testId = `word-${wordIndex}`

  // Completed word — per-character coloring
  if (wordIndex < currentWordIndex) {
    const result = wordResults[wordIndex]
    if (!result) return null
    if (result.correct) {
      return (
        <span data-testid={testId} className="text-success">
          {word}
        </span>
      )
    }
    return (
      <span data-testid={testId}>
        {word.split('').map((char, charIdx) => (
          <span key={charIdx} className={charClassName(char, charIdx, result.typed)}>
            {displayChar(char, charIdx, result.typed)}
          </span>
        ))}
      </span>
    )
  }

  // Current word -- per-character coloring with cursor and composition text
  if (wordIndex === currentWordIndex) {
    const typedLength = currentInput.length
    const compositionChars = Array.from(compositionText)
    const compositionLength = compositionChars.length
    const isComposing = compositionLength > 0
    const cursorBlinks = !isComposing && cursorBlink
    return (
      <span data-testid={testId}>
        {word.split('').map((char, charIdx) => {
          // Already typed characters
          if (charIdx < typedLength) {
            return (
              <span key={charIdx} className={charClassName(char, charIdx, currentInput)}>
                {displayChar(char, charIdx, currentInput)}
              </span>
            )
          }
          // Cursor at the typed/composition boundary
          if (charIdx === typedLength) {
            if (isComposing) {
              // Composition text overlay
              return (
                <span key={charIdx} className="relative">
                  <Cursor blink={false} />
                  <span className={COMPOSITION_CHAR_CLASS}>
                    {compositionChars[charIdx - typedLength]}
                  </span>
                </span>
              )
            }
            // First untyped character with cursor
            return (
              <span key={charIdx} className="relative">
                <Cursor blink={cursorBlinks} />
                <span className={charClassName(char, charIdx, currentInput)}>
                  {displayChar(char, charIdx, currentInput)}
                </span>
              </span>
            )
          }
          // Remaining composition characters (after the first)
          if (charIdx < typedLength + compositionLength) {
            return (
              <span key={charIdx} className={COMPOSITION_CHAR_CLASS}>
                {compositionChars[charIdx - typedLength]}
              </span>
            )
          }
          // Remaining untyped characters
          return (
            <span key={charIdx} className={charClassName(char, charIdx, currentInput)}>
              {displayChar(char, charIdx, currentInput)}
            </span>
          )
        })}
        {/* Extra composition chars beyond word length */}
        {typedLength + compositionLength > word.length &&
          compositionChars
            .slice(Math.max(0, word.length - typedLength))
            .map((char, i) => (
              <span key={`comp-extra-${i}`} className={COMPOSITION_CHAR_CLASS}>
                {char}
              </span>
            ))}
        {/* Extra typed chars beyond word length */}
        {typedLength > word.length &&
          currentInput
            .slice(word.length)
            .split('')
            .map((char, i) => (
              <span key={`extra-${i}`} className="text-danger underline decoration-danger/50 decoration-2 underline-offset-[3px]">
                {char}
              </span>
            ))}
        {/* Cursor after the word when typed/composed past the end */}
        {typedLength >= word.length && (
          <span className="relative">
            <Cursor blink={cursorBlinks} />
          </span>
        )}
      </span>
    )
  }

  // Future word
  return (
    <span data-testid={testId} className="text-content-muted">
      {word}
    </span>
  )
}

function charClassName(expected: string, index: number, input: string): string {
  if (index >= input.length) return 'text-content-muted'
  if (input[index] === expected) return 'text-success'
  return 'text-danger underline decoration-danger/50 decoration-2 underline-offset-[3px]'
}

function displayChar(expected: string, index: number, input: string): string {
  if (index < input.length && input[index] !== expected) return input[index]
  return expected
}

function Cursor({ blink }: { blink: boolean }) {
  return (
    <span
      className={`absolute left-0 bottom-[0.12em] h-[1.1em] w-0.5 rounded-full bg-accent${blink ? ' animate-blink' : ''}`}
      aria-hidden="true"
    />
  )
}
