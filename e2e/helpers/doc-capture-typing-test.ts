// SPDX-License-Identifier: GPL-2.0-or-later

// Screenshot capture script for Typing Test documentation.
// Connects to the virtual "Virtual Keyboard" device (PIPETTE_VIRTUAL_DEVICE=only)
// and captures screenshots of each typing test mode and state. No real hardware
// required.
//
// Usage: pnpm build && npx tsx e2e/helpers/doc-capture-typing-test.ts

import type { Page } from '@playwright/test'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import {
  backupFile,
  backupVirtualDeviceSettings,
  clickThroughUnlock,
  connectToDevice,
  dismissNotificationModal,
  FileBackup,
  LastDeviceBackup,
  launchCaptureApp,
  nullifyLastDeviceConfig,
  resetToEditorMode,
  restoreFile,
  restoreLastDeviceConfig,
  restoreVirtualDeviceSettings,
  VIRTUAL_DEVICE_DISPLAY_NAME,
  VIRTUAL_DEVICE_UID,
  VirtualDeviceSettingsBackup,
  waitForTypingTestCountdown,
  waitForUnlockDialog,
} from './doc-capture-common'
import type { RunKeystrokeLog, RunLogIndex } from '../../src/shared/types/typing-run-log'
import { normalizeFileImportText } from '../../src/shared/types/typing-test-text-store'
import type { TypingTestTextEntryFile, TypingTestTextIndex, TypingTestTextMeta } from '../../src/shared/types/typing-test-text-store'

const PROJECT_ROOT = resolve(import.meta.dirname, '../..')
const SCREENSHOT_DIR = resolve(PROJECT_ROOT, 'docs/screenshots')
const DEVICE_NAME = VIRTUAL_DEVICE_DISPLAY_NAME

async function capture(page: Page, name: string): Promise<void> {
  const path = resolve(SCREENSHOT_DIR, `${name}.png`)
  await page.screenshot({ path, fullPage: true })
  console.log(`  [ok] ${name}.png`)
}

/** Resolves userData via a throwaway "primer" launch, nulls out any stale
 *  `lastDevice` on disk, then launches the REAL capture app fresh — see
 *  `nullifyLastDeviceConfig`'s doc comment (mirrors doc-capture.ts's own
 *  primer pattern) for why the order matters: `lastDevice` must be nulled
 *  BEFORE the capture app's renderer boots, since `restoreLastSession`'s
 *  auto-reconnect effect runs on mount and would otherwise race — or simply
 *  outrun — a write attempted after the real app has already launched,
 *  silently skipping the device-selection screen every capture below
 *  depends on. Returns the real app, its userData path, and the
 *  `lastDevice` backup to restore (via `restoreLastDeviceConfig`) once the
 *  real app has closed. */
async function launchCaptureAppWithFreshLastDevice(): Promise<{
  app: Awaited<ReturnType<typeof launchCaptureApp>>
  userDataPath: string
  lastDeviceBackup: LastDeviceBackup
}> {
  const primerApp = await launchCaptureApp()
  let userDataPath: string
  try {
    userDataPath = await primerApp.evaluate(async ({ app: a }) => a.getPath('userData'))
  } finally {
    await primerApp.close()
  }
  const lastDeviceBackup = nullifyLastDeviceConfig(userDataPath)
  const app = await launchCaptureApp()
  return { app, userDataPath, lastDeviceBackup }
}

// [daysAgo, wpm, accuracy, correctChars, incorrectChars] for each seeded run — all
// share the same `words` (30, english, no toggles) condition with rising accuracy.
const ACCURACY_TREND_SEED_RUNS: [number, number, number, number, number][] = [
  [6, 58, 88, 145, 20],
  [3, 64, 92, 148, 13],
  [1, 71, 96, 154, 6],
]

// Plausible substitution/omission/insertion rates for the seeded runs
// (share of errorTargetChars) — same constants as analyze-seed.ts's
// DUMMY_ERROR_*_RATE, so the two seed helpers agree, and close to but not
// exactly the population means (shared/typing-benchmarks.ts) so the
// History Error mix section shows real figures instead of its empty
// state.
const SEED_ERROR_SUBSTITUTION_RATE = 0.018
const SEED_ERROR_OMISSION_RATE = 0.009
const SEED_ERROR_INSERTION_RATE = 0.006

// The most recent Accuracy Trend seed run (see ACCURACY_TREND_SEED_RUNS'
// last entry, daysAgo: 1) doubles as the Keystroke Timeline seed run — its
// History row gets this `runId` so the seeded run log below
// (`seedRunKeystrokeLog`) actually has a matching History entry to open
// the timeline icon from.
const TIMELINE_SEED_RUN_ID = 'doc-capture-timeline-run'

/** Seeds the Accuracy Trend seed runs above into the virtual device's
 *  pipette_settings.json, so the Accuracy Trend chart (History → Data
 *  section) has a real trend line to screenshot, and — since every run
 *  now also carries the error-class group — so the Error mix section
 *  below it shows real figures instead of its empty state. Merged onto
 *  whatever the file already has — `settingsBackup` (the snapshot
 *  `backupVirtualDeviceSettings` took before this call) restores the
 *  pre-seed content (or removes the file) once the script is done,
 *  independent of this seed. */
function seedAccuracyTrendHistory(settingsBackup: VirtualDeviceSettingsBackup): void {
  mkdirSync(dirname(settingsBackup.path), { recursive: true })
  const existing = settingsBackup.content != null
    ? (JSON.parse(settingsBackup.content) as Record<string, unknown>)
    : {}
  // Required baseline fields the main-process settings validator expects
  // (see DEFAULT_PIPETTE_SETTINGS in shared/types/pipette-settings.ts).
  // On a brand-new virtual-device profile (no prior settings file at all —
  // `existing` starts as `{}`), writing ONLY `typingTestResults` produces a
  // file the validator treats as incomplete: it gets silently replaced with
  // defaults (typingTestResults: []) on first read, discarding this seed
  // entirely before Typing Test ever opens. Only filled in when missing so
  // a real prior file's own values survive (analyze-seed.ts's dummy
  // History rows already always set these, for the same reason).
  existing._rev ??= 1
  existing.keyboardLayout ??= 'qwerty'
  existing.autoAdvance ??= true
  existing.layerNames ??= []
  const now = Date.now()
  const DAY_MS = 24 * 60 * 60 * 1000
  existing.typingTestResults = ACCURACY_TREND_SEED_RUNS.map(([daysAgo, wpm, accuracy, correctChars, incorrectChars], i) => {
    // All-or-nothing error-class group (see TypingTestResult.errorSubstitutions
    // et al.) — errorTargetChars stands in for Σ target length the same way
    // analyze-seed.ts's dummy History rows do (correctChars + incorrectChars
    // is a plausible total, not a real Levenshtein alignment).
    const errorTargetChars = correctChars + incorrectChars
    const isLast = i === ACCURACY_TREND_SEED_RUNS.length - 1
    return {
      date: new Date(now - daysAgo * DAY_MS).toISOString(),
      runId: isLast ? TIMELINE_SEED_RUN_ID : undefined,
      wpm, accuracy, wordCount: 30, correctChars, incorrectChars, durationSeconds: 24,
      mode: 'words', mode2: 30, language: 'english', punctuation: false, numbers: false,
      errorSubstitutions: Math.round(errorTargetChars * SEED_ERROR_SUBSTITUTION_RATE),
      errorOmissions: Math.round(errorTargetChars * SEED_ERROR_OMISSION_RATE),
      errorInsertions: Math.round(errorTargetChars * SEED_ERROR_INSERTION_RATE),
      errorTargetChars,
    }
  })
  writeFileSync(settingsBackup.path, JSON.stringify(existing), 'utf-8')
}

/** Seeds a plausible `RunKeystrokeLog` (index + payload file, mirroring
 *  `typing-run-log-store.ts`'s on-disk layout) for `TIMELINE_SEED_RUN_ID` —
 *  the History row seeded above with that runId — so the row's Keystroke
 *  Timeline link has real data to open for the `typing-test-timeline.png`
 *  capture. Three words across two lines (`lineBreaks: [1]` — see that
 *  field's own doc comment on `RunKeystrokeLog`): "the"/"quick" share line
 *  0 (with a mid-line pause and a short overlap on "quick"), "fox" alone
 *  is line 1 (crossed into after a pause past the line view's own 250ms
 *  threshold — see `LINE_BLANK_THRESHOLD_MS` — so it renders as a
 *  lead-in marker rather than an ordinary mid-line blank). `lineBreaks`
 *  being present at all is what selects the LINE-view renderer
 *  (`useTimelineModel`) over the legacy per-word one, so this seed's
 *  screenshot shows the current UI rather than the pre-#376 fallback.
 *  Returns both file backups for `restoreFile` in a `finally` block. */
function seedRunKeystrokeLog(userDataPath: string): { indexBackup: FileBackup; payloadBackup: FileBackup } {
  const runsDir = join(userDataPath, 'sync', 'keyboards', VIRTUAL_DEVICE_UID, 'runs')
  const indexPath = join(runsDir, 'index.json')
  const filename = `${TIMELINE_SEED_RUN_ID}.json`
  const payloadPath = join(runsDir, filename)
  const indexBackup = backupFile(indexPath)
  const payloadBackup = backupFile(payloadPath)
  mkdirSync(runsDir, { recursive: true })

  const log: RunKeystrokeLog = {
    runId: TIMELINE_SEED_RUN_ID,
    uid: VIRTUAL_DEVICE_UID,
    startedAt: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(),
    durationMs: 3200,
    mode: 'words',
    language: 'english',
    lineBreaks: [1],
    words: [
      {
        index: 0,
        display: 'the',
        typed: 'the',
        correct: true,
        keystrokes: [
          // Observed non-overlaps so the summary's pooled overlap rate reads
          // as a realistic fraction rather than 100% from a single verdict.
          { pressMs: 0, releaseMs: 90, keycode: 0, row: 0, col: 0, correct: true, overlapped: false, expectedChar: 't' },
          { pressMs: 120, releaseMs: 210, keycode: 0, row: 0, col: 1, correct: true, overlapped: false, expectedChar: 'h' },
          { pressMs: 240, releaseMs: 330, keycode: 0, row: 0, col: 2, correct: true, overlapped: false, expectedChar: 'e' },
        ],
      },
      {
        index: 1,
        display: 'quick',
        typed: 'qiuck',
        correct: false,
        keystrokes: [
          // Well past the line view's 250ms blank threshold but still on
          // the SAME line as "the" (lineBreaks: [1] keeps both on line 0)
          // — this is the mid-line pause the screenshot's blank marker
          // shows, not a cross-line lead-in.
          { pressMs: 1800, releaseMs: 1880, keycode: 0, row: 1, col: 0, correct: true, expectedChar: 'q' },
          { pressMs: 1900, releaseMs: 2010, keycode: 0, row: 1, col: 1, correct: false, expectedChar: 'u' },
          // Overlaps the previous key's own release — the duplicate-
          // keystroke case the legend's "Overlapped" swatch documents.
          { pressMs: 1990, releaseMs: 2080, keycode: 0, row: 1, col: 2, correct: false, overlapped: true, expectedChar: 'i' },
        ],
      },
      {
        index: 2,
        display: 'fox',
        typed: 'fox',
        correct: true,
        keystrokes: [
          // 420ms past "quick"'s last release (2080) — crosses the line
          // break (lineBreaks: [1] ends line 0 at word 1), so this reads
          // as a lead-in pause before line 1 rather than an ordinary
          // mid-line blank.
          { pressMs: 2500, releaseMs: 2580, keycode: 0, row: 2, col: 0, correct: true, overlapped: false, expectedChar: 'f' },
          { pressMs: 2610, releaseMs: 2690, keycode: 0, row: 2, col: 1, correct: true, overlapped: false, expectedChar: 'o' },
          { pressMs: 2720, releaseMs: 2800, keycode: 0, row: 2, col: 2, correct: true, overlapped: false, expectedChar: 'x' },
        ],
      },
    ],
  }

  const index: RunLogIndex = {
    uid: VIRTUAL_DEVICE_UID,
    entries: [{ id: TIMELINE_SEED_RUN_ID, startedAt: log.startedAt, filename, savedAt: new Date().toISOString() }],
  }

  writeFileSync(payloadPath, JSON.stringify(log), 'utf-8')
  writeFileSync(indexPath, JSON.stringify(index, null, 2), 'utf-8')
  return { indexBackup, payloadBackup }
}

// The romaji-engine test suite's canonical multi-pattern word (accepts
// dhi/deli/dexi for でぃ, plus the ー long-vowel passthrough) — reused here so
// the Romaji input screenshot demonstrates the same digraph the tests cover.
const ROMAJI_DEMO_WORD = 'でぃなーにいく'

/** Seeds `japanese_hiragana` as an already-downloaded MonkeyType pack (a
 *  single-word list built from `ROMAJI_DEMO_WORD`, so every word offered in
 *  the reading window is the digraph demo word — deterministic for the
 *  screenshot) so the Romaji input capture never depends on network access.
 *  `LANG_GET`/`LANG_LIST` (`src/main/language-store.ts`) read this file
 *  straight off disk with no fileSize/manifest cross-check, so a hand-written
 *  fixture is sufficient; the real MonkeyType download (`LANG_DOWNLOAD`)
 *  fetches from GitHub and is not exercised here. Call once userData is
 *  resolved, before the app enters Typing Test; pass the result to
 *  `restoreFile` in a `finally` block. */
function seedKanaLanguagePack(userDataPath: string): FileBackup {
  const path = join(userDataPath, 'local', 'downloads', 'languages', 'monkeytype', 'japanese_hiragana.json')
  const backup = backupFile(path)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify({ name: 'japanese_hiragana', words: [ROMAJI_DEMO_WORD] }), 'utf-8')
  return backup
}

/** Expands the typing-test Settings panel if a prior session left it
 *  collapsed, so the language-selector button (and the Mode row beneath it)
 *  is reachable. A no-op when the panel is already expanded. */
async function expandSettingsPanelIfCollapsed(page: Page): Promise<void> {
  const collapsedPanel = page.locator('[data-testid="typing-settings-panel-collapsed"]')
  if (await collapsedPanel.isVisible().catch(() => false)) {
    await page.locator('[data-testid="typing-settings-panel-toggle"]').click()
    await page.waitForTimeout(300)
  }
}

/** Picks `id` on the language-selector modal's MonkeyType (existing-packs)
 *  tab. Assumes the modal is already open; leaves it closed once the row
 *  click applies the selection. */
async function selectMonkeytypePack(page: Page, id: string): Promise<void> {
  await page.locator('[data-testid="language-tab-existing"]').click()
  await page.waitForTimeout(300)
  await page.locator(`[data-testid="language-row-${id}"]`).click()
  await page.waitForTimeout(500)
}

/** Selects the (seeded) hiragana pack, enables Romaji input, and types a
 *  partial spelling of `ROMAJI_DEMO_WORD` so the reading window shows both
 *  the per-kana progress coloring and the typed/remaining guide line mid-word.
 *  Leaves Romaji input in that partially-typed state; the caller switches the
 *  language back to reset it (dropping `romajiInput` — see
 *  `clearRomajiInputForLanguage` in `useTypingTest.ts`) before continuing
 *  with unrelated captures. */
async function captureRomajiInputScreenshot(page: Page): Promise<void> {
  await expandSettingsPanelIfCollapsed(page)

  const languageSelector = page.locator('[data-testid="language-selector"]:not([disabled])')
  await languageSelector.waitFor({ state: 'visible', timeout: 10_000 })
  await languageSelector.click()
  await page.waitForTimeout(500)
  await selectMonkeytypePack(page, 'japanese_hiragana')

  // The language switch preserves whatever pattern was active; force words
  // mode so the Romaji button (words/time only) is available.
  await page.locator('[data-testid="mode-words"]').click()
  await page.waitForTimeout(300)

  // The Japanese Input button opens the Japanese Input Settings modal
  // rather than toggling judging directly (see RomajiSettingsModal.tsx) —
  // open it, capture the modal itself, explicitly pick the Romaji method
  // on the unified 3-way Direct/Romaji/Kana selector (Romaji is already
  // the default for a freshly-loaded kana-capable pack, but selecting it
  // keeps the capture deterministic), then close the modal before typing.
  await page.locator('[data-testid="romaji-settings-toggle"]').click()
  await page.locator('[data-testid="romaji-settings-modal"]').waitFor({ state: 'visible', timeout: 5_000 })
  await page.locator('[data-testid="japanese-input-method-romaji"]').click()
  await page.waitForTimeout(300)
  await capture(page, 'typing-test-romaji-settings')
  await page.locator('[data-testid="romaji-settings-modal-close"]').click()
  await page.waitForTimeout(300)

  // "dhina-" commits でぃ + な + ー (the '-' key types the ー long-vowel mark
  // directly), leaving "にいく" as the canonical remaining guide.
  await page.keyboard.type('dhina-', { delay: 100 })
  await page.waitForTimeout(500)
  await capture(page, 'typing-test-romaji')
}

// Physical-key strokes for でぃな — a prefix of ROMAJI_DEMO_WORD
// (でぃなーにいく), reused here rather than seeding a separate kana-only
// word: re-seeding and reselecting the SAME already-downloaded
// `japanese_hiragana` pack id mid-script does not reliably force a fresh
// read (the renderer appears to keep its own per-id word-list state from
// the earlier Romaji capture), so the reliable path is to keep typing
// against whatever content is already loaded and just resolve which
// physical keys produce its first few kana under Kana mode's own
// KANA_LAYOUT (kana-input.ts): KeyW ('て') + BracketLeft (dakuten -> 'で'),
// Shift+KeyE ('ぃ'), KeyU ('な'). The word's own ー (long vowel mark) needs
// IntlYen, which — per the virtual GPK60-63R's own default keymap — has no
// mapped physical position, so this stops short of it; three kana is
// already enough to show real in-progress state in the stroke guide.
// kana-input.ts judges straight off DOM `KeyboardEvent.code`/`shiftKey` —
// never off matrix/HID data — so a synthetic Playwright keypress alone is
// sufficient here (unlike an analytics/run-log verification, no
// virtual-device matrix tap is needed for this screenshot).
interface KanaStroke { code: string; shift: boolean }
const KANA_STROKES_FOR_ROMAJI_DEMO_WORD: KanaStroke[] = [
  { code: 'KeyW', shift: false }, // て (base of で)
  { code: 'BracketLeft', shift: false }, // dakuten -> で
  { code: 'KeyE', shift: true }, // ぃ
  { code: 'KeyU', shift: false }, // な
]

async function typeKanaStroke(page: Page, stroke: KanaStroke): Promise<void> {
  if (stroke.shift) await page.keyboard.down('Shift')
  await page.keyboard.press(stroke.code)
  if (stroke.shift) await page.keyboard.up('Shift')
  await page.waitForTimeout(150)
}

/** Reselects the already-downloaded hiragana pack (still carrying
 *  ROMAJI_DEMO_WORD from the earlier Romaji capture), switches the
 *  Japanese Input method to Kana, and types the first few physical
 *  strokes of the loaded word so the kana stroke guide row renders real
 *  in-progress state — captures `typing-test-kana-input.png`. Leaves the
 *  language switched back to english/words once done, mirroring
 *  `captureRomajiInputScreenshot`'s own cleanup, so later captures (Mode
 *  Modal etc.) start from the same known state as before this function
 *  ran. */
async function captureKanaInputScreenshot(page: Page): Promise<void> {
  await expandSettingsPanelIfCollapsed(page)
  const languageSelector = page.locator('[data-testid="language-selector"]:not([disabled])')
  await languageSelector.waitFor({ state: 'visible', timeout: 10_000 })
  await languageSelector.click()
  await page.waitForTimeout(500)
  await selectMonkeytypePack(page, 'japanese_hiragana')
  await page.locator('[data-testid="mode-words"]').click()
  await page.waitForTimeout(300)

  await page.locator('[data-testid="romaji-settings-toggle"]').click()
  await page.locator('[data-testid="romaji-settings-modal"]').waitFor({ state: 'visible', timeout: 5_000 })
  await page.locator('[data-testid="japanese-input-method-kana"]').click()
  await page.waitForTimeout(300)
  await page.locator('[data-testid="romaji-settings-modal-close"]').click()
  await page.waitForTimeout(300)

  for (const stroke of KANA_STROKES_FOR_ROMAJI_DEMO_WORD) await typeKanaStroke(page, stroke)
  await page.locator('[data-testid="typing-test-kana-guide"]').waitFor({ state: 'visible', timeout: 5_000 })
  await page.waitForTimeout(300)
  await capture(page, 'typing-test-kana-input')

  await languageSelector.click()
  await page.waitForTimeout(400)
  await selectMonkeytypePack(page, 'english')
}

/** Applies the shared dataset-update banner on whichever Mode-modal tab is
 *  currently open, if it is showing. A no-op when no update is available. */
async function applyDatasetUpdateIfShown(page: Page): Promise<void> {
  const banner = page.locator('[data-testid="typing-dataset-update-banner"]')
  if (!(await banner.isVisible().catch(() => false))) return
  await page.locator('[data-testid="typing-dataset-update-button"]').click()
  await banner.waitFor({ state: 'detached', timeout: 20_000 }).catch(() => {
    console.log('  [warn] dataset update banner did not clear in time')
  })
  await page.waitForTimeout(500)
}

/** Opens the typing-test Mode modal (MonkeyType / Tatoeba / Aozora Bunko /
 *  File Import) and captures one screenshot per tab, plus a running-state
 *  shot of a Tatoeba pack's per-sentence lines. Downloads the Tatoeba
 *  `japanese` pack on demand for the shots and removes it again afterward if
 *  this run was the one that downloaded it, leaving the app as it found it.
 *  Requires the typing-test editor (not Typing View) to already be active. */
async function captureModeModalScreenshots(page: Page): Promise<void> {
  const languageSelector = page.locator('[data-testid="language-selector"]:not([disabled])')

  // The Settings panel (containing the Mode row) can be collapsed from a
  // prior session; expand it so the language-selector button is reachable.
  await expandSettingsPanelIfCollapsed(page)

  await languageSelector.waitFor({ state: 'visible', timeout: 10_000 })
  await languageSelector.click()
  await page.waitForTimeout(500)

  // MonkeyType tab (the modal may already open here if words/time/quote mode
  // was active, but select it explicitly for a deterministic starting point).
  await page.locator('[data-testid="language-tab-existing"]').click()
  await page.waitForTimeout(300)
  await capture(page, 'typing-test-mode-monkeytype')

  // Tatoeba tab — apply the update banner (populates the pack list on a
  // fresh profile, since Tatoeba ships no bundled languages) and make sure
  // the `japanese` pack is downloaded for the running-state shot below.
  await page.locator('[data-testid="language-tab-tatoeba"]').click()
  await page.waitForTimeout(500)
  await applyDatasetUpdateIfShown(page)

  let downloadedTatoebaJapaneseForShot = false
  const tatoebaJapaneseDownload = page.locator('[data-testid="language-download-japanese"]')
  if (await tatoebaJapaneseDownload.isVisible().catch(() => false)) {
    await tatoebaJapaneseDownload.click()
    await page.locator('[data-testid="language-delete-japanese"]').waitFor({ state: 'visible', timeout: 20_000 }).catch(() => {
      console.log('  [warn] tatoeba japanese pack did not finish downloading in time')
    })
    downloadedTatoebaJapaneseForShot = true
    await page.waitForTimeout(300)
  } else {
    console.log('  [info] tatoeba japanese pack already downloaded (or not offered)')
  }
  // Clicking a mid-list download button auto-scrolls the pack list; snap it
  // back to the top so the Downloaded section leads the shot.
  await page.evaluate(() => {
    const list = document.querySelector('[role="dialog"] .overflow-y-auto')
    if (list) list.scrollTop = 0
  })
  await page.waitForTimeout(300)
  await capture(page, 'typing-test-mode-tatoeba')

  // Aozora Bunko tab — apply its own update banner (populates the ~10.5k
  // work catalog), then search so the kana filter row and results both
  // render in frame.
  await page.locator('[data-testid="language-tab-aozora"]').click()
  await page.waitForTimeout(500)
  await applyDatasetUpdateIfShown(page)
  await page.locator('[data-testid="aozora-search"]').fill('太宰')
  await page.waitForTimeout(800)
  await capture(page, 'typing-test-mode-aozora')

  // Select the (now-downloaded) Tatoeba japanese pack so the reading window
  // renders its per-sentence lines and ⏎ end-of-line markers. Picking a row
  // switches mode and closes the modal — no explicit close needed. Keeping
  // this to a plain pack selection (rather than importing an Aozora work)
  // per the capture plan.
  await page.locator('[data-testid="language-tab-tatoeba"]').click()
  await page.waitForTimeout(300)
  await page.locator('[data-testid="language-row-japanese"]').click()
  await page.waitForTimeout(800)
  await capture(page, 'typing-test-tatoeba-running')

  // Reopen the modal for the File Import tab shot.
  await languageSelector.waitFor({ state: 'visible', timeout: 10_000 })
  await languageSelector.click()
  await page.waitForTimeout(500)
  await page.locator('[data-testid="language-tab-import"]').click()
  await page.waitForTimeout(300)
  await capture(page, 'typing-test-mode-import')

  // Cleanup: restore MonkeyType / english (the pre-capture default mode).
  await selectMonkeytypePack(page, 'english')

  // Remove the tatoeba japanese pack again if this run was the one that
  // downloaded it, so the machine is left as it was found. The dataset
  // manifest updates applied above are left in place — they are a cache.
  if (downloadedTatoebaJapaneseForShot) {
    await languageSelector.waitFor({ state: 'visible', timeout: 10_000 })
    await languageSelector.click()
    await page.waitForTimeout(400)
    await page.locator('[data-testid="language-tab-tatoeba"]').click()
    await page.waitForTimeout(300)
    const deleteBtn = page.locator('[data-testid="language-delete-japanese"]')
    if (await deleteBtn.isVisible().catch(() => false)) {
      await deleteBtn.click()
      await page.waitForTimeout(300)
    }
    await page.locator('[data-testid="language-modal-close"]').click()
    await page.waitForTimeout(300)
  }
}

const COMPLETION_DEMO_TEXT_ID = 'doc-capture-completion-demo'
// Two short lines — enough to show the completion screen's per-line
// timeline, a "Lines" stat card, and (via the deliberate typos typed
// below) both Missed-bar colors: "teh" is typed then corrected with
// Backspace before submitting (gray), "dgos" is left wrong when the last
// word is submitted (red).
const COMPLETION_DEMO_RAW_TEXT = 'the quick fox\njumps over dogs'

/** Seeds a File Import text directly on disk (bypassing the file-picker
 *  dialog), mirroring `seedKanaLanguagePack`'s approach for MonkeyType
 *  packs — `typing-test-text-store.ts`'s `list`/`get` read straight off
 *  disk, so a hand-written index + entry file is sufficient. Returns both
 *  file backups for `restoreFile` in a `finally` block. */
function seedCompletionDemoText(userDataPath: string): { indexBackup: FileBackup; entryBackup: FileBackup } {
  const dir = join(userDataPath, 'sync', 'typing-test-texts')
  const indexPath = join(dir, 'index.json')
  const filename = `${COMPLETION_DEMO_TEXT_ID}.json`
  const entryPath = join(dir, filename)
  const indexBackup = backupFile(indexPath)
  const entryBackup = backupFile(entryPath)
  mkdirSync(dir, { recursive: true })

  const { text, wordCount, lineCount } = normalizeFileImportText(COMPLETION_DEMO_RAW_TEXT)
  const now = new Date().toISOString()
  const meta: TypingTestTextMeta = {
    id: COMPLETION_DEMO_TEXT_ID,
    name: 'Completion Demo',
    wordCount,
    lineCount,
    filename,
    savedAt: now,
    updatedAt: now,
  }
  const existingIndex: TypingTestTextIndex = indexBackup.content
    ? (JSON.parse(indexBackup.content) as TypingTestTextIndex)
    : { entries: [] }
  const newIndex: TypingTestTextIndex = {
    entries: [...existingIndex.entries.filter((e) => e.id !== COMPLETION_DEMO_TEXT_ID), meta],
  }
  writeFileSync(indexPath, JSON.stringify(newIndex, null, 2), 'utf-8')
  const entryData: TypingTestTextEntryFile = { name: meta.name, text }
  writeFileSync(entryPath, JSON.stringify(entryData), 'utf-8')
  return { indexBackup, entryBackup }
}

/** Types the seeded two-line File Import demo through to completion, with
 *  one corrected mistake ("teh" -> Backspace x3 -> "the", gray in the
 *  Missed bar) and one left uncorrected ("dgos" for "dogs", red in the
 *  Missed bar), so the completion screen's inline Keystroke Timeline has
 *  real Missed-table data to show. Waits for the timeline panel itself
 *  (not just the generic finished wrapper) since that's the signal that a
 *  keystroke log actually matched this run (recording consent must
 *  already be accepted — see `main`'s consent flow below). */
async function runCompletionDemoToFinish(page: Page): Promise<void> {
  await page.keyboard.type('teh', { delay: 60 })
  await page.waitForTimeout(200)
  await page.keyboard.press('Backspace')
  await page.keyboard.press('Backspace')
  await page.keyboard.press('Backspace')
  await page.waitForTimeout(200)
  await page.keyboard.type('the quick ', { delay: 60 })
  await page.keyboard.type('fox', { delay: 60 })
  await page.keyboard.press('Enter') // line-end word — Enter, not Space
  await page.waitForTimeout(300)
  await page.keyboard.type('jumps over ', { delay: 60 })
  await page.keyboard.type('dgos', { delay: 60 }) // deliberate typo, left uncorrected
  await page.keyboard.press(' ')

  const timelinePanel = page.locator('[data-testid="typing-test-timeline-panel"]')
  const finishedWrapper = page.locator('[data-testid="typing-test-finished-wrapper"]')
  await finishedWrapper.waitFor({ state: 'visible', timeout: 10_000 })
  if (!(await timelinePanel.isVisible().catch(() => false))) {
    // Fallback: some builds may require Enter to submit the final word too.
    await page.keyboard.press('Enter')
    await timelinePanel.waitFor({ state: 'visible', timeout: 5_000 })
  }
}

/** Captures the completion screen's inline Keystroke Timeline
 *  (Task-completion-timeline-view) — the finished-test view now used in
 *  place of the old compact stats row whenever a keystroke log was saved
 *  for the run. Requires recording consent already accepted (see
 *  `main`'s footer-record-modal step, which accepts it via the real
 *  Enable button before calling this). */
async function captureCompletionTimelineScreenshot(page: Page, userDataPath: string): Promise<void> {
  const { indexBackup, entryBackup } = seedCompletionDemoText(userDataPath)
  try {
    await expandSettingsPanelIfCollapsed(page)
    const languageSelector = page.locator('[data-testid="language-selector"]:not([disabled])')
    await languageSelector.waitFor({ state: 'visible', timeout: 10_000 })
    await languageSelector.click()
    await page.waitForTimeout(500)
    await page.locator('[data-testid="language-tab-import"]').click()
    await page.waitForTimeout(300)
    await page.locator(`[data-testid="typing-text-row-${COMPLETION_DEMO_TEXT_ID}"]`).click()
    await page.waitForTimeout(500)
    // Selecting a row may not auto-close the modal (unlike the MonkeyType/
    // Tatoeba tabs) — close it defensively if it's still open.
    const closeBtn = page.locator('[data-testid="language-modal-close"]')
    if (await closeBtn.isVisible().catch(() => false)) {
      await closeBtn.click()
      await page.waitForTimeout(300)
    }

    await runCompletionDemoToFinish(page)
    await page.waitForTimeout(500)
    await capture(page, 'typing-test-completion-timeline')

    // Reset back to english/words for anything after this in the script —
    // switching language away is sufficient (mirrors captureRomajiInputScreenshot
    // and captureKanaInputScreenshot's own cleanup), no explicit Next Test
    // click needed first.
    await expandSettingsPanelIfCollapsed(page)
    await languageSelector.waitFor({ state: 'visible', timeout: 10_000 })
    await languageSelector.click()
    await page.waitForTimeout(400)
    await selectMonkeytypePack(page, 'english')
  } finally {
    restoreFile(indexBackup)
    restoreFile(entryBackup)
  }
}

/** Seeds a fresh `typingTestResults` array (overwriting whatever the
 *  virtual device profile already has) for the Weak Spot Training
 *  captures below. Unlike `seedAccuracyTrendHistory`, these always run on
 *  their OWN freshly-launched app instance rather than reusing `main()`'s
 *  shared one — History is only read once at device-connect time, so
 *  swapping between a mistake-free ("no weak spots") seed and a
 *  mistake-heavy ("active") seed mid-session would need a live re-fetch
 *  the app doesn't do on a raw file rewrite. */
function seedWeakSpotHistory(settingsBackup: VirtualDeviceSettingsBackup, results: Record<string, unknown>[]): void {
  mkdirSync(dirname(settingsBackup.path), { recursive: true })
  const existing = settingsBackup.content != null
    ? (JSON.parse(settingsBackup.content) as Record<string, unknown>)
    : {}
  // Same required-baseline-fields caveat as seedAccuracyTrendHistory above.
  existing._rev ??= 1
  existing.keyboardLayout ??= 'qwerty'
  existing.autoAdvance ??= true
  existing.layerNames ??= []
  existing.typingTestResults = results
  writeFileSync(settingsBackup.path, JSON.stringify(existing), 'utf-8')
}

/** Connects to the virtual device and enters Typing Test / words mode —
 *  the same connect/unlock/enter sequence `main()` runs on its own shared
 *  app instance, factored out here since each Weak Spot Training capture
 *  below needs it on its own fresh instance (see `seedWeakSpotHistory`'s
 *  doc comment for why). */
async function enterTypingTestOnFreshApp(page: Page, app: Awaited<ReturnType<typeof launchCaptureApp>>): Promise<void> {
  await dismissNotificationModal(page, { waitForAppearMs: 3000 })
  console.log(`Looking for ${DEVICE_NAME}...`)
  const connected = await connectToDevice(page, DEVICE_NAME)
  if (!connected) throw new Error(`Device "${DEVICE_NAME}" not found`)
  await dismissNotificationModal(page)
  await waitForUnlockDialog(app, page)
  await dismissNotificationModal(page)
  await resetToEditorMode(page)

  const typingTestBtn = page.locator('[data-testid="typing-test-button"]')
  await typingTestBtn.waitFor({ state: 'visible', timeout: 10_000 })
  await clickThroughUnlock(app, page, typingTestBtn)
  await page.waitForTimeout(1000)
  await dismissNotificationModal(page)

  const typingTestView = page.locator('[data-testid="typing-test-view"]')
  await typingTestView.waitFor({ state: 'visible', timeout: 10_000 })
  await waitForTypingTestCountdown(page)
  await page.locator('[data-testid="mode-words"]').click()
  await page.waitForTimeout(500)
}

/** Weak Spot Training — "toggle ON, biased words visible" capture
 *  (`typing-test-weak-spot-toggle.png`, referenced from the Weak Spot
 *  Training subsection under MonkeyType in both OPERATION-GUIDE files).
 *  Seeds 3 same-condition `words` runs whose combined mistakes push the
 *  letter 'k' well past MIN_MISS_COUNT (see weak-spot-scoring.ts), so the
 *  miss-only signal alone is enough to put the gate into 'active' without
 *  needing a saved keystroke log. Switches to word count 120 first so the
 *  biased sampling reads clearly across more displayed words. */
async function captureWeakSpotToggleScreenshot(): Promise<void> {
  console.log('\n--- Weak Spot Training: toggle + biased sampling ---')
  const { app, userDataPath, lastDeviceBackup } = await launchCaptureAppWithFreshLastDevice()
  const settingsBackup = backupVirtualDeviceSettings(userDataPath)
  seedWeakSpotHistory(settingsBackup, [
    {
      date: new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString(),
      wpm: 50, accuracy: 88, wordCount: 20, correctChars: 90, incorrectChars: 10,
      durationSeconds: 20, mode: 'words', mode2: 20, language: 'english',
      punctuation: false, numbers: false, mistakes: { k: 25 },
    },
    {
      date: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
      wpm: 52, accuracy: 87, wordCount: 20, correctChars: 90, incorrectChars: 10,
      durationSeconds: 20, mode: 'words', mode2: 20, language: 'english',
      punctuation: false, numbers: false, mistakes: { k: 22 },
    },
    {
      date: new Date(Date.now() - 1 * 60 * 60 * 1000).toISOString(),
      wpm: 54, accuracy: 89, wordCount: 20, correctChars: 90, incorrectChars: 10,
      durationSeconds: 20, mode: 'words', mode2: 20, language: 'english',
      punctuation: false, numbers: false, mistakes: { k: 18 },
    },
  ])
  const page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  await page.setViewportSize({ width: 1440, height: 1024 })
  await page.waitForTimeout(2000)
  try {
    await enterTypingTestOnFreshApp(page, app)
    await expandSettingsPanelIfCollapsed(page)

    const wc120 = page.locator('[data-testid="word-count-120"]')
    if (await wc120.isVisible().catch(() => false)) {
      await wc120.click()
      await page.waitForTimeout(500)
    }

    const toggle = page.locator('[data-testid="toggle-weak-spot-training"]')
    await toggle.waitFor({ state: 'visible', timeout: 5000 })
    // The toggle's enabled-ness depends on the async History load reaching
    // gate status 'active' — if seedWeakSpotHistory's miss-count threshold
    // is never crossed, Playwright's actionability wait on the click below
    // would otherwise stall for the full 30s default timeout with no hint
    // as to why. Poll for enabled state and fail fast with an explanatory
    // error instead.
    const enabledDeadline = Date.now() + 5000
    let becameEnabled = false
    while (Date.now() < enabledDeadline) {
      if (await toggle.isEnabled().catch(() => false)) {
        becameEnabled = true
        break
      }
      await page.waitForTimeout(200)
    }
    if (!becameEnabled) {
      throw new Error("toggle-weak-spot-training stayed disabled — seedWeakSpotHistory's 3 same-condition mistake runs should push 'k' past MIN_MISS_COUNT and bring the gate to 'active'")
    }
    await toggle.click()
    await page.waitForTimeout(600)
    // The active hint (detected tokens, e.g. "Weak spots: k") renders from
    // the same gate that just enabled the toggle above, so it should
    // already be present — wait explicitly anyway so the capture never
    // races a slow re-render.
    await page.locator('[data-testid="weak-spot-hint-active"]').waitFor({ state: 'visible', timeout: 5000 })
    // Move the cursor off the settings area so the info icon's 300ms-delay tooltip doesn't bake into the screenshot.
    await page.mouse.move(0, 0)
    await page.waitForTimeout(200)
    await capture(page, 'typing-test-weak-spot-toggle')
  } finally {
    await app.close().catch((err: unknown) => console.error('  [cleanup] app.close failed:', err))
    try {
      restoreVirtualDeviceSettings(settingsBackup)
    } catch (err) {
      console.error('  [cleanup] restore virtual device settings failed:', err)
    }
    try {
      restoreLastDeviceConfig(lastDeviceBackup)
    } catch (err) {
      console.error('  [cleanup] restore lastDevice config failed:', err)
    }
  }
}

/** Weak Spot Training — "no weak spots detected" hint capture
 *  (`typing-test-weak-spot-hint.png`). Seeds a single mistake-free `words`
 *  run so History is loaded (ruling out the silent 'unavailable' state)
 *  but no token crosses any weakness threshold (gate 'no-weak-spots'). The
 *  toggle stays disabled at this gate status — no click needed — so the
 *  capture shows the disabled toggle alongside the info icon and hint. */
async function captureWeakSpotHintScreenshot(): Promise<void> {
  console.log('\n--- Weak Spot Training: no-weak-spots hint ---')
  const { app, userDataPath, lastDeviceBackup } = await launchCaptureAppWithFreshLastDevice()
  const settingsBackup = backupVirtualDeviceSettings(userDataPath)
  seedWeakSpotHistory(settingsBackup, [{
    date: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
    wpm: 68, accuracy: 100, wordCount: 20, correctChars: 100, incorrectChars: 0,
    durationSeconds: 20, mode: 'words', mode2: 20, language: 'english',
    punctuation: false, numbers: false,
  }])
  const page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  await page.setViewportSize({ width: 1440, height: 1024 })
  await page.waitForTimeout(2000)
  try {
    await enterTypingTestOnFreshApp(page, app)
    await expandSettingsPanelIfCollapsed(page)

    const toggle = page.locator('[data-testid="toggle-weak-spot-training"]')
    await toggle.waitFor({ state: 'visible', timeout: 5000 })
    const hint = page.locator('[data-testid="weak-spot-hint"]')
    if (!(await hint.isVisible().catch(() => false))) {
      throw new Error("weak-spot-hint did not appear — seedWeakSpotHistory guarantees a mistake-free scoped run, so the gate should read 'no-weak-spots'")
    }
    await page.waitForTimeout(300)
    // Move the cursor off the settings area so the info icon's 300ms-delay tooltip doesn't bake into the screenshot.
    await page.mouse.move(0, 0)
    await page.waitForTimeout(200)
    await capture(page, 'typing-test-weak-spot-hint')
  } finally {
    await app.close().catch((err: unknown) => console.error('  [cleanup] app.close failed:', err))
    try {
      restoreVirtualDeviceSettings(settingsBackup)
    } catch (err) {
      console.error('  [cleanup] restore virtual device settings failed:', err)
    }
    try {
      restoreLastDeviceConfig(lastDeviceBackup)
    } catch (err) {
      console.error('  [cleanup] restore lastDevice config failed:', err)
    }
  }
}

async function main(): Promise<void> {
  mkdirSync(SCREENSHOT_DIR, { recursive: true })

  console.log('Launching Electron app (virtual device)...')
  const { app, userDataPath, lastDeviceBackup } = await launchCaptureAppWithFreshLastDevice()

  // Snapshot the virtual device's PipetteSettings before this script enters
  // Typing Test / Typing View — those modes persist `viewMode` into the same
  // userData tree e2e/virtual-device.test.ts reads on connect, and this
  // helper's viewMode is not the state a later test run should inherit.
  const settingsBackup = backupVirtualDeviceSettings(userDataPath)
  seedAccuracyTrendHistory(settingsBackup)
  const kanaPackBackup = seedKanaLanguagePack(userDataPath)
  const runLogBackup = seedRunKeystrokeLog(userDataPath)
  // Snapshot config.json (recording consent flag) so the real Enable click
  // in the footer-record-modal step below — needed to drive a genuinely
  // live, judged run for the completion-timeline capture — doesn't leave
  // this machine's dev profile with consent permanently accepted.
  const configPath = join(userDataPath, 'config.json')
  const configBackup: FileBackup = backupFile(configPath)

  const page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  await page.setViewportSize({ width: 1440, height: 1024 })
  await page.waitForTimeout(3000)

  try {
    await dismissNotificationModal(page, { waitForAppearMs: 3000 })

    // Connect to device — a prior run's "Restore Last Session" state can
    // leave this userData profile already on the editor (auto-reconnected
    // to the virtual device before this script ever gets to the device
    // selection screen), so check for that first rather than waiting out
    // connectToDevice's full timeout only to fail on a device that's
    // already connected.
    const alreadyConnected = await page.locator('[data-testid="editor-content"]').isVisible().catch(() => false)
    if (alreadyConnected) {
      console.log(`Already connected (auto-connect, sole enumerated device).`)
    } else {
      console.log(`Looking for ${DEVICE_NAME}...`)
      const connected = await connectToDevice(page, DEVICE_NAME)
      if (!connected) throw new Error(`Device "${DEVICE_NAME}" not found`)
      console.log(`Connected to ${DEVICE_NAME}`)
    }

    await dismissNotificationModal(page)
    // The virtual device resets to locked on every launch, so a viewMode
    // persisted from a prior helper run (e.g. this script's own Typing View
    // ending state) can surface the Unlock dialog via the auto-restore
    // effect before we ever click anything ourselves.
    await waitForUnlockDialog(app, page)
    await dismissNotificationModal(page)
    await resetToEditorMode(page)

    console.log('\n--- Typing Test Screenshots ---')

    // resetToEditorMode above guarantees we start from the editor, so enter
    // Typing Test unconditionally.
    const typingTestView = page.locator('[data-testid="typing-test-view"]')
    const typingTestBtn = page.locator('[data-testid="typing-test-button"]')
    await typingTestBtn.waitFor({ state: 'visible', timeout: 10_000 })
    await clickThroughUnlock(app, page, typingTestBtn)
    await page.waitForTimeout(1000)
    await dismissNotificationModal(page)

    // 1. Words mode — waiting state (explicitly select to avoid persisted config)
    await typingTestView.waitFor({ state: 'visible', timeout: 10_000 })
    // Entering Typing Test starts with a 3s countdown placeholder before the
    // word list renders; wait it out so mode clicks below land on real controls.
    await waitForTypingTestCountdown(page)
    await page.locator('[data-testid="mode-words"]').click()
    await page.waitForTimeout(500)
    await capture(page, 'typing-test-words-waiting')

    // 1b. History modal — opens on the Results tab (default), populated by
    // seedAccuracyTrendHistory above (3 same-condition `words` runs) plus
    // the seeded timeline run — so the WPM Trend chart, stats row, and
    // table (with its Timeline link column) all have real data.
    await expandSettingsPanelIfCollapsed(page)
    await page.locator('[data-testid="typing-test-history-toggle"]').click()
    await page.locator('[data-testid="history-modal"]').waitFor({ state: 'visible', timeout: 5_000 })
    await page.waitForTimeout(300)
    await capture(page, 'typing-test-history-results')

    // 1c. Keystroke Timeline — opened from the seeded run's row (see
    // seedRunKeystrokeLog); its History row is the most recent Accuracy
    // Trend seed run above, tagged with TIMELINE_SEED_RUN_ID. The seeded
    // log now carries `lineBreaks`, so this opens in the current per-LINE
    // view rather than the legacy per-word fallback.
    const timelineOpenBtn = page.locator('[data-testid^="history-timeline-open-"]').first()
    if (!(await timelineOpenBtn.isVisible().catch(() => false))) {
      throw new Error('history-timeline-open button not found — seedRunKeystrokeLog guarantees this row, so silently skipping the capture would ship a stale/missing doc screenshot')
    }
    await timelineOpenBtn.click()
    await page.locator('[data-testid="word-timeline-modal"]').waitFor({ state: 'visible', timeout: 5_000 })
    await page.waitForTimeout(400)
    await capture(page, 'typing-test-timeline')
    await page.locator('[data-testid="word-timeline-close"]').click()
    await page.waitForTimeout(300)

    // 1d. History modal — Analysis tab (Accuracy Trend / Most missed /
    // Error mix), same seeded data as the Results tab above.
    await page.locator('[data-testid="history-view-tab-analysis"]').click()
    await page.waitForTimeout(300)
    await capture(page, 'typing-test-history-analysis')

    await page.locator('[data-testid="history-modal-close"]').click()
    await page.waitForTimeout(300)

    // 2. Time mode
    await page.locator('[data-testid="mode-time"]').click()
    await page.waitForTimeout(500)
    await capture(page, 'typing-test-time-mode')

    // 3. Quote mode
    await page.locator('[data-testid="mode-quote"]').click()
    await page.waitForTimeout(500)
    await capture(page, 'typing-test-quote-mode')

    // 4. Words mode with options (punctuation + numbers enabled)
    await page.locator('[data-testid="mode-words"]').click()
    await page.waitForTimeout(300)
    await page.locator('[data-testid="toggle-punctuation"]').click()
    await page.waitForTimeout(200)
    await page.locator('[data-testid="toggle-numbers"]').click()
    await page.waitForTimeout(500)
    await capture(page, 'typing-test-words-options')

    // Reset options back
    await page.locator('[data-testid="toggle-punctuation"]').click()
    await page.locator('[data-testid="toggle-numbers"]').click()
    await page.waitForTimeout(300)

    // 5. Running state — type a few characters to start the test
    // Focus is managed by the component via hidden textarea
    await page.keyboard.type('the ', { delay: 80 })
    await page.waitForTimeout(500)
    await capture(page, 'typing-test-running')

    // 5b. Romaji input — hiragana pack, Romaji toggle on, mid-word guide line
    console.log('\n--- Typing Test Romaji Input ---')
    await captureRomajiInputScreenshot(page)

    // Reset back to english/words so the language switch also drops the
    // seeded run's romajiInput flag (see clearRomajiInputForLanguage) before
    // the Mode Modal captures below reuse the same language selector.
    await page.locator('[data-testid="language-selector"]:not([disabled])').click()
    await page.waitForTimeout(400)
    await selectMonkeytypePack(page, 'english')

    // 5c. Kana input — hiragana pack, Kana method, physical-key stroke guide
    console.log('\n--- Typing Test Kana Input ---')
    await captureKanaInputScreenshot(page)

    // 6. Mode modal — MonkeyType / Tatoeba / Aozora Bunko / File Import tabs
    console.log('\n--- Typing Test Mode Modal ---')
    await captureModeModalScreenshots(page)

    // 7. Footer Record modal + Recording Consent modal (Task-typing-record-
    // footer: REC moved out of the Typing View popover's REC tab into the
    // keymap-editor footer, so this no longer needs to enter Typing View —
    // the Record button lives in the plain editor's footer instead).
    console.log('\n--- Typing Record Modal ---')

    // Exit typing test back to the editor so the footer (hidden in
    // Typing Test / Typing View) is visible again.
    if (await typingTestBtn.isVisible().catch(() => false)) {
      await typingTestBtn.click()
      await page.waitForTimeout(500)
    }

    let consentAccepted = false
    const recordBtn = page.locator('[data-testid="typing-record-button"]')
    if (await recordBtn.isVisible().catch(() => false)) {
      await recordBtn.click()
      await page.waitForTimeout(400)
      await capture(page, 'typing-test-rec-tab')

      // Toggle Start to surface the consent modal. Accept it (real Enable
      // click, not Cancel) — the completion-timeline capture below (step 8)
      // needs recording consent genuinely accepted so an ordinary Typing
      // Test run saves a keystroke log. Accepting also flips Record on
      // (see TypingRecordModal.handleConsentAccept), so it's toggled back
      // off right after, leaving consent accepted but Record itself off —
      // same end state the rest of the script otherwise expects.
      const recordToggle = page.locator('[data-testid="typing-record-toggle"]')
      if (await recordToggle.isVisible().catch(() => false)) {
        await recordToggle.click()
        const consentModal = page.locator('[data-testid="typing-consent-modal"]')
        if (await consentModal.isVisible().catch(() => false)) {
          const consentPath = resolve(SCREENSHOT_DIR, 'typing-test-rec-consent.png')
          await consentModal.screenshot({ path: consentPath })
          console.log('  [ok] typing-test-rec-consent.png')

          const acceptBtn = page.locator('[data-testid="typing-consent-accept"]')
          if (await acceptBtn.isVisible().catch(() => false)) {
            await acceptBtn.click()
            await page.waitForTimeout(300)
            consentAccepted = true
            // Consent-accept also turned Record on — toggle it back off.
            if (await recordToggle.isVisible().catch(() => false)) {
              await recordToggle.click()
              await page.waitForTimeout(200)
            }
          }
        } else {
          console.log('  [info] typing-consent-modal did not appear (consent already accepted)')
          consentAccepted = true
        }
      } else {
        console.log('  [warn] typing-record-toggle not found')
      }

      const closeBtn = page.locator('[data-testid="typing-record-close"]')
      if (await closeBtn.isVisible().catch(() => false)) {
        await closeBtn.click()
        await page.waitForTimeout(200)
      }
    } else {
      console.log('  [skip] typing-record-button not found — Record modal capture skipped')
    }

    // 8. Completion screen — inline Keystroke Timeline, once a run finishes
    // with a saved keystroke log (requires the consent accepted just above).
    console.log('\n--- Typing Test Completion Timeline ---')
    if (consentAccepted) {
      await clickThroughUnlock(app, page, typingTestBtn)
      await page.waitForTimeout(1000)
      await dismissNotificationModal(page)
      await typingTestView.waitFor({ state: 'visible', timeout: 10_000 })
      await waitForTypingTestCountdown(page)
      await captureCompletionTimelineScreenshot(page, userDataPath)
    } else {
      console.log('  [skip] recording consent was not accepted — completion-timeline capture skipped')
    }

    console.log(`\nScreenshots saved to: ${SCREENSHOT_DIR}`)
  } finally {
    // Close the app first so no further debounced save can race with (and
    // undo) the settings restore below.
    await app.close().catch((err: unknown) => console.error('  [cleanup] app.close failed:', err))
    try {
      restoreVirtualDeviceSettings(settingsBackup)
    } catch (err) {
      console.error('  [cleanup] restore virtual device settings failed:', err)
    }
    try {
      restoreFile(kanaPackBackup)
    } catch (err) {
      console.error('  [cleanup] restore kana language pack failed:', err)
    }
    try {
      restoreFile(runLogBackup.indexBackup)
      restoreFile(runLogBackup.payloadBackup)
    } catch (err) {
      console.error('  [cleanup] restore seeded run log failed:', err)
    }
    try {
      restoreFile(configBackup)
    } catch (err) {
      console.error('  [cleanup] restore recording consent flag failed:', err)
    }
    try {
      restoreLastDeviceConfig(lastDeviceBackup)
    } catch (err) {
      console.error('  [cleanup] restore lastDevice config failed:', err)
    }
  }

  // Weak Spot Training — each capture launches and cleans up its own app
  // instance (see captureWeakSpotToggleScreenshot's doc comment for why),
  // so these run after the shared instance above has fully closed.
  console.log('\n--- Weak Spot Training Screenshots ---')
  await captureWeakSpotToggleScreenshot()
  await captureWeakSpotHintScreenshot()
}

main().catch((err: unknown) => {
  console.error('Script failed:', err)
  process.exit(1)
})
