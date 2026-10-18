// SPDX-License-Identifier: GPL-2.0-or-later
//
// The steps of the Typing Test capture (specs/typing-test.ts): the Settings
// panel and the Mode modal's packs, Romaji and Kana input, the Mode modal's
// tabs, the completion screen's Keystroke Timeline, and the Weak Spot
// Training captures, each of which starts from a relaunch with its own
// History.

import { VIRTUAL_DEVICE_NAME } from '../helpers/app'
import {
  captureNamed,
  clickThroughUnlock,
  connectToDevice,
  dismissNotificationModal,
  prepareCapture,
  relaunchApp,
  resetToEditorMode,
  waitForTypingTestCountdown,
  waitForUnlockDialog,
} from './common'
import type { Page } from './page'
import {
  COMPLETION_DEMO_TEXT_ID,
  restoreFile,
  seedCompletionDemoText,
  seedWeakSpotHistory,
  type FileBackup,
} from './typing-test-seed'

const DEVICE_NAME = VIRTUAL_DEVICE_NAME

/** Expands the typing-test Settings panel if a prior session left it
 *  collapsed, so the language-selector button (and the Mode row beneath it)
 *  is reachable. A no-op when the panel is already expanded. */
export async function expandSettingsPanelIfCollapsed(page: Page): Promise<void> {
  const collapsedPanel = page.locator('[data-testid="typing-settings-panel-collapsed"]')
  if (await collapsedPanel.isVisible().catch(() => false)) {
    await page.locator('[data-testid="typing-settings-panel-toggle"]').click()
    await page.waitForTimeout(300)
  }
}

/** Picks `id` on the language-selector modal's MonkeyType (existing-packs)
 *  tab. Assumes the modal is already open; leaves it closed once the row
 *  click applies the selection. */
export async function selectMonkeytypePack(page: Page, id: string): Promise<void> {
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
export async function captureRomajiInputScreenshot(page: Page): Promise<void> {
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
  await captureNamed(page, 'typing-test-romaji-settings')
  await page.locator('[data-testid="romaji-settings-modal-close"]').click()
  await page.waitForTimeout(300)

  // "dhina-" commits でぃ + な + ー (the '-' key types the ー long-vowel mark
  // directly), leaving "にいく" as the canonical remaining guide.
  await page.keyboard.type('dhina-', { delay: 100 })
  await page.waitForTimeout(500)
  await captureNamed(page, 'typing-test-romaji')
}

// Physical-key strokes for でぃな — a prefix of ROMAJI_DEMO_WORD
// (でぃなーにいく), reused here rather than seeding a separate kana-only
// word: re-seeding and reselecting the SAME already-downloaded
// `japanese_hiragana` pack id mid-run does not reliably force a fresh
// read (the renderer keeps its own per-id word-list state from the earlier
// Romaji capture), so the reliable path is to keep typing against whatever
// content is already loaded and just resolve which physical keys produce
// its first few kana under Kana mode's own KANA_LAYOUT (kana-input.ts):
// KeyW ('て') + BracketLeft (dakuten -> 'で'), Shift+KeyE ('ぃ'), KeyU ('な').
// The word's own ー (long vowel mark) needs IntlYen, which — per the
// virtual keyboard's default keymap — has no mapped physical position, so
// this stops short of it; three kana is already enough to show real
// in-progress state in the stroke guide. kana-input.ts judges straight off
// DOM `KeyboardEvent.code`/`shiftKey` — never off matrix/HID data — so a
// WebDriver keypress alone is sufficient here.
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
export async function captureKanaInputScreenshot(page: Page): Promise<void> {
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
  await captureNamed(page, 'typing-test-kana-input')

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
 *  this run was the one that downloaded it. The dataset answers must be
 *  recorded first (`respondTypingDatasets`). Requires the typing-test
 *  editor (not Typing View) to already be active. */
export async function captureModeModalScreenshots(page: Page): Promise<void> {
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
  await captureNamed(page, 'typing-test-mode-monkeytype')

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
  await captureNamed(page, 'typing-test-mode-tatoeba')

  // Aozora Bunko tab — apply its own update banner (populates the work
  // catalog), then search so the kana filter row and results both render
  // in frame.
  await page.locator('[data-testid="language-tab-aozora"]').click()
  await page.waitForTimeout(500)
  await applyDatasetUpdateIfShown(page)
  await page.locator('[data-testid="aozora-search"]').fill('太宰')
  await page.waitForTimeout(800)
  await captureNamed(page, 'typing-test-mode-aozora')

  // Select the (now-downloaded) Tatoeba japanese pack so the reading window
  // renders its per-sentence lines and ⏎ end-of-line markers. Picking a row
  // switches mode and closes the modal — no explicit close needed.
  await page.locator('[data-testid="language-tab-tatoeba"]').click()
  await page.waitForTimeout(300)
  await page.locator('[data-testid="language-row-japanese"]').click()
  await page.waitForTimeout(800)
  await captureNamed(page, 'typing-test-tatoeba-running')

  // Reopen the modal for the File Import tab shot.
  await languageSelector.waitFor({ state: 'visible', timeout: 10_000 })
  await languageSelector.click()
  await page.waitForTimeout(500)
  await page.locator('[data-testid="language-tab-import"]').click()
  await page.waitForTimeout(300)
  await captureNamed(page, 'typing-test-mode-import')

  // Cleanup: restore MonkeyType / english (the pre-capture default mode).
  await selectMonkeytypePack(page, 'english')

  // Remove the tatoeba japanese pack again if this run was the one that
  // downloaded it. The dataset updates applied above are left in place —
  // they are a cache.
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

/** Types the seeded two-line File Import demo through to completion, with
 *  one corrected mistake ("teh" -> Backspace x3 -> "the", gray in the
 *  Missed bar) and one left uncorrected ("dgos" for "dogs", red in the
 *  Missed bar), so the completion screen's inline Keystroke Timeline has
 *  real Missed-table data to show. Waits for the timeline panel itself
 *  (not just the generic finished wrapper) since that's the signal that a
 *  keystroke log actually matched this run (recording consent must
 *  already be accepted). */
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
    // Fallback: the final word may need Enter to submit too.
    await page.keyboard.press('Enter')
    await timelinePanel.waitFor({ state: 'visible', timeout: 5_000 })
  }
}

/** Captures the completion screen's inline Keystroke Timeline — the
 *  finished-test view used in place of the compact stats row whenever a
 *  keystroke log was saved for the run. Requires recording consent
 *  already accepted. */
export async function captureCompletionTimelineScreenshot(page: Page): Promise<void> {
  const { indexBackup, entryBackup } = seedCompletionDemoText()
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
    await captureNamed(page, 'typing-test-completion-timeline')

    // Reset back to english/words for anything after this — switching
    // language away is sufficient, no explicit Next Test click needed first.
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

/** Connects to the virtual device and enters Typing Test / words mode —
 *  the connect/unlock/enter sequence each Weak Spot Training capture runs
 *  after its own relaunch. */
async function enterTypingTestOnFreshApp(page: Page): Promise<void> {
  await dismissNotificationModal(page)
  console.log(`Looking for ${DEVICE_NAME}...`)
  const connected = await connectToDevice(page, DEVICE_NAME)
  if (!connected) throw new Error(`Device "${DEVICE_NAME}" not found`)
  await dismissNotificationModal(page)
  await waitForUnlockDialog(page)
  await dismissNotificationModal(page)
  await resetToEditorMode(page)

  const typingTestBtn = page.locator('[data-testid="typing-test-button"]')
  await typingTestBtn.waitFor({ state: 'visible', timeout: 10_000 })
  await clickThroughUnlock(page, typingTestBtn)
  await page.waitForTimeout(1000)
  await dismissNotificationModal(page)

  const typingTestView = page.locator('[data-testid="typing-test-view"]')
  await typingTestView.waitFor({ state: 'visible', timeout: 10_000 })
  await waitForTypingTestCountdown(page)
  await page.locator('[data-testid="mode-words"]').click()
  await page.waitForTimeout(500)
}

/** Starts the app again with the files the capture changed put back as
 *  they were before it (`backups`) and the virtual keyboard's History set
 *  to `results`, and leaves it on the device-selection screen. History is
 *  read when the keyboard connects, so swapping between two seeds needs a
 *  launch of its own. */
async function relaunchWithHistory(page: Page, settingsBackup: FileBackup, backups: FileBackup[], results: Record<string, unknown>[]): Promise<void> {
  await relaunchApp(() => {
    for (const backup of backups) restoreFile(backup)
    seedWeakSpotHistory(settingsBackup, results)
  })
  await prepareCapture(page)
}

/** Weak Spot Training — "DATA-section button ON" + "settings modal, active
 *  state" captures (`typing-test-weak-spot-toggle.png` /
 *  `typing-test-weak-spot-modal.png`). Seeds 3 same-condition `words` runs
 *  whose combined mistakes push the letter 'k' well past the default miss
 *  threshold (see weak-spot-scoring.ts's DEFAULT_MIN_MISS_COUNT), so the
 *  miss-only signal alone is enough to bring detection to 'active' without
 *  needing a saved keystroke log. Opens the modal, enables the setting
 *  there (only possible once detection is active), captures the modal
 *  itself in that active state, then closes it and captures the
 *  DATA-section button on its own now that it carries the accent (ON)
 *  styling. */
export async function captureWeakSpotToggleScreenshot(page: Page, settingsBackup: FileBackup, backups: FileBackup[]): Promise<void> {
  console.log('\n--- Weak Spot Training: DATA button + settings modal (active) ---')
  await relaunchWithHistory(page, settingsBackup, backups, [
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
  await enterTypingTestOnFreshApp(page)
  await expandSettingsPanelIfCollapsed(page)

  const dataButton = page.locator('[data-testid="weak-spot-settings-toggle"]')
  await dataButton.waitFor({ state: 'visible', timeout: 5000 })
  await dataButton.click()
  await page.waitForTimeout(400)

  const modal = page.locator('[data-testid="weak-spot-settings-modal"]')
  await modal.waitFor({ state: 'visible', timeout: 5000 })

  const enableToggle = page.locator('[data-testid="weak-spot-enable-toggle"]')
  // The toggle's enabled-ness depends on the async History load reaching
  // detection status 'active'. Poll for enabled state and fail fast with an
  // explanatory error instead of waiting out a click timeout.
  const enabledDeadline = Date.now() + 5000
  let becameEnabled = false
  while (Date.now() < enabledDeadline) {
    if (await enableToggle.isEnabled().catch(() => false)) {
      becameEnabled = true
      break
    }
    await page.waitForTimeout(200)
  }
  if (!becameEnabled) {
    throw new Error("weak-spot-enable-toggle stayed disabled — the 3 same-condition mistake runs should push 'k' past the default miss threshold and bring detection to 'active'")
  }
  await enableToggle.click()
  await page.waitForTimeout(400)
  // Wait on the Reset button, the modal's own last-rendered element, as
  // the render-complete signal.
  await page.locator('[data-testid="weak-spot-settings-reset"]').waitFor({ state: 'visible', timeout: 5000 })
  // Move the cursor off the modal so no incidental hover state bakes into the screenshot.
  await page.mouse.move(0, 0)
  await page.waitForTimeout(200)
  await captureNamed(page, 'typing-test-weak-spot-modal')

  await page.locator('[data-testid="weak-spot-settings-modal-close"]').click()
  await modal.waitFor({ state: 'hidden', timeout: 5000 })
  await page.waitForTimeout(200)
  await captureNamed(page, 'typing-test-weak-spot-toggle')
}

/** Weak Spot Training — "status hint below the DATA button, no weak spots"
 *  capture (`typing-test-weak-spot-hint.png`). The status line renders
 *  directly under the DATA section's button in TypingTestPaneSettingsPanel,
 *  so this capture reads it there without opening the modal at all. Seeds
 *  a single mistake-free `words` run so History is loaded (ruling out the
 *  silent 'unavailable' status, which renders nothing) but no token crosses
 *  any weakness threshold (status 'no-weak-spots'). */
export async function captureWeakSpotHintScreenshot(page: Page, settingsBackup: FileBackup, backups: FileBackup[]): Promise<void> {
  console.log('\n--- Weak Spot Training: status hint below the DATA button (no weak spots) ---')
  await relaunchWithHistory(page, settingsBackup, backups, [{
    date: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
    wpm: 68, accuracy: 100, wordCount: 20, correctChars: 100, incorrectChars: 0,
    durationSeconds: 20, mode: 'words', mode2: 20, language: 'english',
    punctuation: false, numbers: false,
  }])
  await enterTypingTestOnFreshApp(page)
  await expandSettingsPanelIfCollapsed(page)

  const dataButton = page.locator('[data-testid="weak-spot-settings-toggle"]')
  await dataButton.waitFor({ state: 'visible', timeout: 5000 })

  const status = page.locator('[data-testid="weak-spot-status"]')
  await status.waitFor({ state: 'visible', timeout: 5000 })
  const statusText = await status.textContent()
  if (!statusText || !statusText.includes('No weak spots')) {
    throw new Error("weak-spot-status did not read 'no weak spots' — the seed is a mistake-free scoped run, so status should read 'no-weak-spots'")
  }
  await page.waitForTimeout(200)
  await captureNamed(page, 'typing-test-weak-spot-hint')
}
